#!/usr/bin/env node
/**
 * oh-my-evor SessionEnd hook — mark active run paused on session exit
 *
 * When a session ends with an active evor run, writes mission_status="paused"
 * to mission-state.json so the orchestrator knows to resume cleanly next session.
 *
 * Kill switches (checked FIRST):
 *   DISABLE_EVOR=1                → exit 0 immediately
 *   EVOR_SKIP_HOOKS=session-end   → exit 0 immediately
 *
 * §17D: This is a COMMAND hook (not mcp_tool) because it reads EVOR_ACTIVE_RUN_ID
 * from env — mcp_tool hooks only support ${field} substitution from the hook
 * payload, not arbitrary $ENV_VAR.
 *
 * Fail-open: any error → exit 0. Session end must never be delayed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { resolveActiveRun, resolveEvorRoot } from './lib/active-run.mjs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('session-end')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
const { runId: activeRunId, missionId } = resolveActiveRun();
if (!activeRunId) process.exit(0);

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
// 1.3: the evor root comes from the shared resolver, never re-derived here.
// Eleven hooks each computed `EVOR_ROOT ?? join(CLAUDE_PLUGIN_ROOT ?? cwd, '.evor')`
// for themselves, so fixing Q-01 in `resolveEvorRoot` alone would have reached
// none of them — the plugin's own `.evor/` would still have won in every one.
const evorRoot = resolveEvorRoot();
// missionId comes from resolveActiveRun() above.

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, activeRunId)
  : join(evorRoot, 'runs', activeRunId);

// ── Read current mission-state (to avoid overwriting a terminal status) ───────
const missionStatePath = join(runDir, 'mission-state.json');

try {
  let missionState = {};
  try {
    missionState = JSON.parse(readFileSync(missionStatePath, 'utf8'));
  } catch { /* missing or corrupt — start fresh */ }

  // Do not overwrite a terminal or already-paused status
  const currentStatus = String(missionState?.status ?? '');
  if (['completed', 'failed', 'paused'].includes(currentStatus)) {
    process.exit(0);
  }

  // Atomic write: update status to "paused"
  //
  // `paused_from` is what makes this edge reversible (plan item 0.7). Without it
  // the transition is one-way: session-start has no way to know whether a paused
  // mission was `locked` or `running` before, so it cannot restore it — and
  // `stop.mjs` exits 0 on `paused`, which means one session ending silences the
  // entire drift guard for the rest of the mission's life. That was performed in
  // this repo and never reversed.
  //
  // `paused_by` is equally load-bearing on the way back: only a pause this hook
  // wrote is resumed automatically. An operator who pauses a mission deliberately
  // has made a decision, and a hook must not undo it on the next session.
  const updated = {
    ...missionState,
    status: 'paused',
    paused_from: currentStatus || 'locked',
    paused_at: new Date().toISOString(),
    paused_by: 'session-end-hook',
  };

  mkdirSync(runDir, { recursive: true });
  const tmp = missionStatePath + '.tmp.' + randomBytes(4).toString('hex');
  writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
  renameSync(tmp, missionStatePath);

  // ── C-01: close the RUN RECORD too, not only the mission ──────────────────
  //
  // The field run's `active-run.json` still read `status: "running"` days after
  // the operator killed the session. Every reader that asks "is a run active?"
  // starts there, so a run record nobody closes makes the system permanently
  // wrong about its own liveness — and, because nothing recorded WHEN it was
  // closed, staleness was not even computable after the fact.
  //
  // `ended_at` is what makes 3.3's `is_stale` work on this file: the predicate
  // is arithmetic over a timestamp, and without one there is nothing to subtract.
  try {
    const arPath = join(evorRoot, 'active-run.json');
    if (existsSync(arPath)) {
      const ar = JSON.parse(readFileSync(arPath, 'utf8'));
      if (String(ar?.status ?? '') !== 'paused') {
        const closed = {
          ...ar,
          status: 'paused',
          ended_at: updated.paused_at,
          ended_by: 'session-end-hook',
        };
        const arTmp = arPath + '.tmp.' + randomBytes(4).toString('hex');
        writeFileSync(arTmp, JSON.stringify(closed, null, 2), 'utf8');
        renameSync(arTmp, arPath);
      }
    }
  } catch (err) {
    try { process.stderr.write(`[EVOR] session-end: active-run close failed: ${err}\n`); } catch { /* stderr gone */ }
  }
} catch (err) {
  // Fail-open — session end must never be delayed by a failed hook
  try { process.stderr.write(`[EVOR] session-end: ${err}\n`); } catch { /* stderr gone */ }
}

process.exit(0);
