#!/usr/bin/env node
/**
 * oh-my-evor PostCompact hook — re-inject <evor-restore> after compaction
 *
 * Reads the latest precompact checkpoint written by pre-compact.mjs and
 * re-injects <evor-restore> into the fresh post-compact context via
 * systemMessage. This is the CORRECT re-hydration point: PreCompact's
 * systemMessage gets summarized INTO the compact; PostCompact injects into
 * the fresh context AFTER compaction so nothing is lost.
 *
 * Kill switches (checked FIRST):
 *   DISABLE_EVOR=1                → exit 0 immediately
 *   EVOR_SKIP_HOOKS=post-compact  → exit 0 immediately
 *
 * Graceful degradation: missing/corrupt checkpoint → exit 0 silently.
 * Fail-open: any error → exit 0. Never crash post-compaction.
 *
 * Output format:
 *   { systemMessage: "<evor-restore>…</evor-restore>\n\nNext: …" }
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolveEvorRoot } from './lib/active-run.mjs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('post-compact')) process.exit(0);

// ── Resolve active run ────────────────────────────────────────────────────────
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
// 1.3: the evor root comes from the shared resolver, never re-derived here.
// Eleven hooks each computed `EVOR_ROOT ?? join(CLAUDE_PLUGIN_ROOT ?? cwd, '.evor')`
// for themselves, so fixing Q-01 in `resolveEvorRoot` alone would have reached
// none of them — the plugin's own `.evor/` would still have won in every one.
const evorRoot = resolveEvorRoot();

let activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
let missionId = process.env.EVOR_MISSION_ID ?? '';

if (!activeRunId) {
  const activeRunFile = join(evorRoot, 'active-run.json');
  if (!existsSync(activeRunFile)) process.exit(0);
  try {
    const ar = JSON.parse(readFileSync(activeRunFile, 'utf8'));
    activeRunId = ar?.run_id ?? '';
    missionId = missionId || (ar?.mission_id ?? '');
  } catch {
    process.exit(0); // corrupt — fail-open
  }
}

if (!activeRunId) process.exit(0);

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, activeRunId)
  : join(evorRoot, 'runs', activeRunId);

// ── Find the latest precompact checkpoint ─────────────────────────────────────
try {
  const checkpointsDir = join(runDir, 'checkpoints');
  if (!existsSync(checkpointsDir)) process.exit(0);

  let files;
  try {
    files = readdirSync(checkpointsDir)
      .filter(f => f.startsWith('precompact-') && f.endsWith('.json'))
      .sort(); // ISO timestamp sort = chronological
  } catch {
    process.exit(0);
  }

  if (files.length === 0) process.exit(0);

  const latest = files[files.length - 1];
  const cpPath = join(checkpointsDir, latest);

  let cp;
  try {
    cp = JSON.parse(readFileSync(cpPath, 'utf8'));
  } catch {
    process.exit(0); // corrupt checkpoint — fail-open
  }

  // ── Build <evor-restore> from checkpoint ─────────────────────────────────
  const objText = (cp.mission_objective ?? '').slice(0, 100);
  const tick    = cp.current_tick  ?? 0;
  const step    = cp.current_step  ?? 0;
  const score   = cp.best_score    !== null && cp.best_score !== undefined
    ? String(cp.best_score).slice(0, 8)
    : 'unknown';
  // Use mission name/objective as header — never raw run_id or mission_id
  const missionName = (cp.mission_name ?? cp.mission_title ?? '').slice(0, 60);
  const header = missionName || (objText ? objText.slice(0, 60) : 'Active mission');
  // Pending: show count only (checkpoint stores ids, not names)
  const pendingIds = Array.isArray(cp.pending_node_ids) ? cp.pending_node_ids : [];
  const pending = pendingIds.length > 0
    ? `${pendingIds.length} pending node(s)`
    : null;

  const restoreLines = [
    `Mission: ${header}`,
    ...(objText && objText !== header ? [`Objective: ${objText}`] : []),
    `Tick ${tick} step ${step} | Best: ${score}`,
    ...(pending ? [pending] : []),
    `Call evor_state_read to check position.`,
  ];

  const restoreBlock = `<evor-restore>\n${restoreLines.join('\n')}\n</evor-restore>`;

  // ── Build next-action hint ────────────────────────────────────────────────
  let nextHint = '';
  try {
    // Read current tick-state for a precise resume hint
    const tsPath = join(runDir, 'tick-state.json');
    const rs = existsSync(tsPath) ? JSON.parse(readFileSync(tsPath, 'utf8')) : {};
    const curStep = rs?.current_step ?? step;
    const curTick = rs?.tick ?? tick;

    if (curStep === 0 || curStep >= 9) {
      nextHint = `Resume at tick ${curTick + (curStep >= 9 ? 1 : 0)} — start a new tick: spawn evor-mutagen with evor_read_artifact(sage) + evor_tree_read.`;
    } else if (curStep < 3) {
      nextHint = `Resume tick ${curTick} at step ${curStep} — Sage/Mutagen phase in progress; check evor_read_artifact for their output.`;
    } else if (curStep < 6) {
      nextHint = `Resume tick ${curTick} at step ${curStep} — Selector/Forge phase; call evor_read_artifact(mutagen) → spawn evor-selector if verdict missing.`;
    } else {
      nextHint = `Resume tick ${curTick} at step ${curStep} — evaluation phase; call evor_record_eval → evor_integrity_check → evor_state_write.`;
    }
  } catch {
    nextHint = `Resume tick ${tick} — call evor_state_read to check current position.`;
  }

  const systemMessage = `${restoreBlock}\n\n[NEXT] ${nextHint}`;

  process.stdout.write(JSON.stringify({ systemMessage }) + '\n');
} catch {
  // Fail-open — post-compact must never crash the session
}

process.exit(0);
