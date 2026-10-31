#!/usr/bin/env node
/**
 * oh-my-evor PostCompact hook — show <evor-restore> to the user after compaction
 *
 * Reads the latest precompact checkpoint written by pre-compact.mjs and shows
 * <evor-restore> plus the next step to the USER via systemMessage. The CLI
 * displays systemMessage and never puts it in the model's context, so this is
 * not the re-hydration point: SessionStart fires with source "compact" right
 * after compaction, and session-start.mjs injects the model-visible restore
 * there (hookSpecificOutput.additionalContext). Keeping this user-only is what
 * stops the restore from reaching the model twice.
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
import { nextStep } from './lib/next-step.mjs';

let hookPayload = {};
try { hookPayload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no payload */ }

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

// ── Next-action hint ──────────────────────────────────────────────────────────
// The same next step SessionStart(source=compact) gives the model; see
// lib/next-step.mjs. This copy is for the user's display only.
const nextHint = () =>
  nextStep(runDir, hookPayload?.session_id, String(hookPayload?.transcript_path ?? ''));

/** The restore block (if a checkpoint exists) plus the next step, then exit. */
function emit(restoreBlock, tick) {
  const hint = nextHint() || (restoreBlock ? 'No tick is running: call evor_state_read to check the position.' : '');
  if (!restoreBlock && !hint) process.exit(0);
  const parts = [restoreBlock, hint && `[NEXT] ${hint}`].filter(Boolean);
  process.stdout.write(JSON.stringify({ systemMessage: parts.join('\n\n') }) + '\n');
  process.exit(0);
}

// ── Find the latest precompact checkpoint ─────────────────────────────────────
try {
  const checkpointsDir = join(runDir, 'checkpoints');
  if (!existsSync(checkpointsDir)) emit('', undefined);

  let files;
  try {
    files = readdirSync(checkpointsDir)
      .filter(f => f.startsWith('precompact-') && f.endsWith('.json'))
      .sort(); // ISO timestamp sort = chronological
  } catch {
    emit('', undefined);
  }

  if (files.length === 0) emit('', undefined);

  const latest = files[files.length - 1];
  const cpPath = join(checkpointsDir, latest);

  let cp;
  try {
    cp = JSON.parse(readFileSync(cpPath, 'utf8'));
  } catch {
    emit('', undefined); // corrupt checkpoint — fail-open
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
  ];

  const restoreBlock = `<evor-restore>\n${restoreLines.join('\n')}\n</evor-restore>`;

  emit(restoreBlock, tick);
} catch {
  // Fail-open — post-compact must never crash the session
}

process.exit(0);
