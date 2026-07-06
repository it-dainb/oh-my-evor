#!/usr/bin/env node
/**
 * oh-my-evor PreCompact hook — compaction-survival flush + context injection
 *
 * Kill switches (checked FIRST, before any other logic):
 *   DISABLE_EVOR=1                  → exit 0 immediately
 *   EVOR_SKIP_HOOKS=pre-compact     → exit 0 immediately
 *
 * Behavior:
 * 1. Reads the active run (EVOR_ACTIVE_RUN_ID or .evor/active-run.json).
 *    If none → exit 0.
 * 2. Flushes a compaction checkpoint (atomic write) to:
 *    .evor/runs/<mission>/<run-id>/checkpoints/precompact-<iso>.json
 *    Captures: {mission_objective, current_tick, current_step, best_score,
 *    best_node_id, pending_node_ids, last_decision, trigger, flushed_at}.
 * 3. Emits stdout JSON:
 *    { continue: true, systemMessage: "<evor-restore>...</evor-restore>" }
 *    The systemMessage is ≤500 chars and is injected into the compacted context
 *    so a resumed Evor session can reconstruct working state from disk.
 *
 * Trigger type:
 *   Reads CLAUDE_HOOK_INPUT for { trigger: "auto" | "manual" }.
 *   Same flush behavior for both; trigger is recorded in checkpoint only.
 *
 * Fail-open: any error → log to stderr, exit 0. Never crash compaction.
 * Atomic writes: write to .tmp file then rename.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('pre-compact')) process.exit(0);

// ── Parse hook input ──────────────────────────────────────────────────────────
let trigger = 'auto';
try {
  // Claude Code delivers the hook payload on STDIN (fd 0), not via env var.
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  const hookInput = JSON.parse(raw || process.env.CLAUDE_HOOK_INPUT || '{}');
  trigger = hookInput?.trigger ?? 'auto';
} catch {
  // malformed input — default to auto, proceed
}

// ── Resolve active run ────────────────────────────────────────────────────────
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');

let activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
let missionId = process.env.EVOR_MISSION_ID ?? '';

// Fallback to active-run.json if env not set
if (!activeRunId) {
  const activeRunFile = join(evorRoot, 'active-run.json');
  if (!existsSync(activeRunFile)) process.exit(0); // no active run — nothing to flush
  try {
    const activeRun = JSON.parse(readFileSync(activeRunFile, 'utf8'));
    activeRunId = activeRun?.run_id ?? '';
    missionId = missionId || (activeRun?.mission_id ?? '');
  } catch {
    process.exit(0); // corrupt — fail-open
  }
}

if (!activeRunId) process.exit(0); // still nothing — safe exit

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, activeRunId)
  : join(evorRoot, 'runs', activeRunId);

// ── Read state files (best-effort) ───────────────────────────────────────────
/** Safe JSON reader — returns {} on any failure. */
function safeRead(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

const missionState = safeRead(join(runDir, 'mission-state.json'));
const tickState = safeRead(join(runDir, 'tick-state.json'));
const runState = safeRead(join(runDir, 'run-state.json'));

// ── Build checkpoint payload ──────────────────────────────────────────────────
const objective = (missionState?.objective ?? missionState?.goal ?? '').slice(0, 200);
const currentTick = tickState?.tick ?? runState?.tick_count ?? 0;
const currentStep = tickState?.current_step ?? 0;
const bestScore = runState?.best_score ?? missionState?.best_score ?? null;
const bestNodeId = runState?.best_node_id ?? missionState?.best_node_id ?? null;
const pendingNodeIds = Array.isArray(runState?.pending_node_ids) ? runState.pending_node_ids : [];

// Extract last decision from decision-log.md (last non-empty line) — best-effort
let lastDecision = '';
try {
  const decisionLog = readFileSync(join(runDir, 'decision-log.md'), 'utf8');
  const lines = decisionLog.split('\n').filter(l => l.trim());
  lastDecision = lines[lines.length - 1]?.slice(0, 120) ?? '';
} catch {
  lastDecision = missionState?.last_decision ?? '';
}

const checkpoint = {
  mission_objective: objective,
  current_tick: currentTick,
  current_step: currentStep,
  best_score: bestScore,
  best_node_id: bestNodeId,
  pending_node_ids: pendingNodeIds,
  last_decision: lastDecision,
  trigger,
  flushed_at: new Date().toISOString(),
  run_id: activeRunId,
  mission_id: missionId || null,
};

// ── Atomic write to checkpoints/ ─────────────────────────────────────────────
try {
  const checkpointsDir = join(runDir, 'checkpoints');
  mkdirSync(checkpointsDir, { recursive: true });

  const isoTag = new Date().toISOString().replace(/[:.]/g, '-').replace('T', 'T').slice(0, 23) + 'Z';
  const checkpointFile = join(checkpointsDir, `precompact-${isoTag}.json`);
  const tmpFile = checkpointFile + '.tmp.' + randomBytes(4).toString('hex');

  writeFileSync(tmpFile, JSON.stringify(checkpoint, null, 2), 'utf8');
  renameSync(tmpFile, checkpointFile);
} catch (err) {
  // Checkpoint write failure is non-fatal — still emit restore summary
  process.stderr.write(`[evor:pre-compact] checkpoint write failed (non-fatal): ${err.message}\n`);
}

// ── Build <evor-restore> summary (≤500 chars) ────────────────────────────────
const runPath = missionId ? `runs/${missionId}/${activeRunId}` : `runs/${activeRunId}`;
const scoreStr = bestScore !== null ? String(bestScore).slice(0, 8) : 'unknown';
const nodeStr = bestNodeId ? bestNodeId.slice(0, 16) : 'none';
const objSnippet = objective ? objective.slice(0, 100) : '(no objective on disk)';
const decisionSnippet = lastDecision ? lastDecision.slice(0, 80) : '(no decision log)';

const restoreBody = [
  `Run: ${activeRunId.slice(0, 20)}${missionId ? ` | Mission: ${missionId.slice(0, 20)}` : ''}`,
  `Objective: ${objSnippet}`,
  `Tick ${currentTick} step ${currentStep} | Best: ${scoreStr} (${nodeStr})`,
  `Last: ${decisionSnippet}`,
  `Recover: read .evor/${runPath}/ for full state.`,
].join('\n');

const systemMessage = `<evor-restore>\n${restoreBody}\n</evor-restore>`;

// Enforce ≤500 chars for the inner body (tags add ~30 chars)
const RESTORE_LIMIT = 500;
const finalMessage = systemMessage.length > RESTORE_LIMIT
  ? systemMessage.slice(0, RESTORE_LIMIT - 20) + '...\n</evor-restore>'
  : systemMessage;

// ── Emit hook response ────────────────────────────────────────────────────────
process.stdout.write(JSON.stringify({ continue: true, systemMessage: finalMessage }) + '\n');
process.exit(0);
