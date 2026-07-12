#!/usr/bin/env node
/**
 * oh-my-evor FileChanged hook — job status watcher (asyncRewake: true)
 *
 * Fires when a registered status.json file changes (the active job's status
 * file written by jobs/<job_id>/status.json). Wakes the agent with the
 * right next action based on job state.
 *
 * Kill switches (checked FIRST):
 *   DISABLE_EVOR=1                      → exit 0 immediately
 *   EVOR_SKIP_HOOKS=job-status-watcher  → exit 0 immediately
 *
 * Active-run gated: inert when EVOR_ACTIVE_RUN_ID is unset.
 * Fail-open: any error → exit 0.
 *
 * §17D: FileChanged matcher is a literal filename watch-list. The path must
 * be registered via watchPaths in session-start.mjs (and run_start command hook)
 * when a job is active. This handler fires on any registered status.json.
 *
 * §19: NO `python -m evor` in any agent-facing string.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('job-status-watcher')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
const activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
if (!activeRunId) process.exit(0);

// ── Parse STDIN payload ───────────────────────────────────────────────────────
// FileChanged payload: { file_path: "<abs path to changed file>" }
let changedFile = '';
try {
  const raw = readFileSync(0, 'utf8');
  const payload = JSON.parse(raw || '{}');
  changedFile = String(payload?.file_path ?? payload?.path ?? '');
} catch {
  process.exit(0); // fail-open
}

if (!changedFile) process.exit(0);

// ── Read the status.json that changed ────────────────────────────────────────
let status;
try {
  if (!existsSync(changedFile)) process.exit(0);
  status = JSON.parse(readFileSync(changedFile, 'utf8'));
} catch {
  process.exit(0); // unreadable or not JSON — fail-open
}

const state = String(status?.state ?? status?.status ?? '').toLowerCase();
const jobId = String(status?.job_id ?? '');
const nodeId = String(status?.node_id ?? '');

// ── P2-3: Dedup terminal notifications by (node_id, job_id, state) ────────────
// Prevents re-firing when status.json is touched after the node is finalized.
// Only terminal states are deduped; 'running' is informational and repeatable.
const TERMINAL_STATES = new Set(['succeeded', 'success', 'completed', 'failed', 'error', 'crashed']);
if (TERMINAL_STATES.has(state)) {
  const dedupBase = process.env.EVOR_DEDUP_DIR
    ? join(process.env.EVOR_DEDUP_DIR, activeRunId)
    : join(tmpdir(), 'evor-job-dedup', activeRunId);
  const rawKey = `${nodeId}|${jobId}|${state}`;
  // Sanitize key into a safe filename (keep alphanum, dash, underscore, pipe→_)
  const safeKey = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) + '.lock';
  const dedupFile = join(dedupBase, safeKey);
  try {
    if (existsSync(dedupFile)) {
      process.exit(0); // Already notified for this (node_id, job_id, state) — suppress
    }
    mkdirSync(dedupBase, { recursive: true });
    const tmp = dedupFile + '.tmp.' + randomBytes(4).toString('hex');
    writeFileSync(tmp, JSON.stringify({
      node_id: nodeId, job_id: jobId, state,
      created_at: new Date().toISOString(),
    }), 'utf8');
    renameSync(tmp, dedupFile);
  } catch {
    // Fail-open — a dedup write failure must never suppress a legitimate notification
  }
}

// ── Build wake message based on job state ─────────────────────────────────────
let additionalContext = '';

if (state === 'succeeded' || state === 'success' || state === 'completed') {
  const score = status?.metrics?.val_score ?? status?.metrics?.score ?? null;
  const scoreHint = score !== null ? ` (score: ${String(score).slice(0, 8)})` : '';
  additionalContext =
    `[EVOR JOB COMPLETE] Job${jobId ? ` ${jobId}` : ''} succeeded${scoreHint}. ` +
    `Call evor_record_eval(run_id="${activeRunId}"${nodeId ? `, node_id="${nodeId}"` : ''}) ` +
    `then evor_integrity_check to verify before propagating the score. ` +
    `If best_score improved, call PushNotification to alert the user of the breakthrough.`;

} else if (state === 'failed' || state === 'error' || state === 'crashed') {
  const errorReason = String(
    status?.error ?? status?.reason ?? status?.exit_reason ?? 'unknown'
  ).slice(0, 200);
  const isOom = /oom|out.of.mem|killed|sigkill/i.test(errorReason);
  const signalKind = isOom ? 'oom' : 'runtime-failure';
  additionalContext =
    `[EVOR JOB FAILED] Job${jobId ? ` ${jobId}` : ''} failed: ${errorReason}. ` +
    `Call evor_signal_emit(kind="${signalKind}", severity="high") with the error details. ` +
    `Then call PushNotification to alert the user that the run failed and the mission is blocked.`;

} else if (state === 'running') {
  // Don't spam — only emit if this is the first status.json read (no previous state)
  // By the time we fire, the job is still running — tell the agent to keep monitoring
  additionalContext =
    `[EVOR JOB RUNNING] Job${jobId ? ` ${jobId}` : ''} is still running. ` +
    `Do not poll in a tight loop — this watcher will fire again when state changes.`;
} else {
  process.exit(0); // unknown state — stay silent
}

if (additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'FileChanged',
        additionalContext,
      },
    }) + '\n'
  );
}

process.exit(0);
