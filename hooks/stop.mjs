#!/usr/bin/env node
/**
 * oh-my-evor Stop hook — Phase-2 enforcement layer (drift-guard + kill switches)
 *
 * Kill switches (checked FIRST, before any other logic):
 *   DISABLE_EVOR=1       → exit 0 immediately; entire evor hook layer inert.
 *   EVOR_SKIP_HOOKS=stop → exit 0 immediately; this hook skipped.
 *   (comma-separated list; e.g. EVOR_SKIP_HOOKS=stop,session-start)
 *
 * Guard 1 — Continuation guard (existing, M7a):
 *   Blocks stop when pending_node_ids is non-empty in run-state.json.
 *
 * Guard 2 — Evolution drift-guard (Phase 2):
 *   Blocks stop when the active run has behavioral debt:
 *     a) A node recorded in tree.json whose integrity verdict is missing
 *        (no evaluations/<id>.json) — integrity not verified.
 *     b) An evaluated node (evaluations/<id>.json present) whose telemetry
 *        is missing (nodes/<id>/telemetry.jsonl absent or empty).
 *     c) tick-state.json shows current_step < 9 while loop is marked "running"
 *        in mission-state.json — tick interrupted mid-flight.
 *
 * Behaviour matrix:
 *   EVOR_ACTIVE_RUN_ID unset      → exit 0  (guard inert; non-evor session)
 *   run-state.json missing        → exit 0  (run not yet initialised; safe)
 *   run-state.json corrupt        → exit 0  (fail-open; log to stderr)
 *   pending_node_ids non-empty    → exit 2  (continuation guard)
 *   behavioral debt detected      → exit 2  (drift-guard; lists offending nodes)
 *   any hook internal error       → exit 0  (FAIL-OPEN — never crash-block)
 *
 * Exit code 2 causes Claude Code to surface stdout as a system-reminder and
 * prevent the session from stopping.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// ── Kill switches ─────────────────────────────────────────────────────────────
// DISABLE_EVOR: truthy value disables the entire evor hook layer.
if (process.env.DISABLE_EVOR) process.exit(0);

// EVOR_SKIP_HOOKS: comma-separated list of hook names to skip individually.
const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('stop')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
const activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
if (!activeRunId) process.exit(0);

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
const missionId = process.env.EVOR_MISSION_ID ?? '';

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, activeRunId)
  : join(evorRoot, 'runs', activeRunId);

const runStatePath = join(runDir, 'run-state.json');

if (!existsSync(runStatePath)) process.exit(0);

// ── Parse run-state.json (fail-open on corrupt) ───────────────────────────────
let runState;
try {
  runState = JSON.parse(readFileSync(runStatePath, 'utf8'));
} catch (err) {
  process.stderr.write(`[evor:stop] corrupt run-state.json: ${err.message}\n`);
  process.exit(0);
}

// ── Guard 1: continuation guard (existing M7a) ────────────────────────────────
const pendingIds = Array.isArray(runState?.pending_node_ids) ? runState.pending_node_ids : [];
if (pendingIds.length > 0) {
  const tick = runState?.tick_count ?? '?';
  process.stdout.write(
    `[EVOR CONTINUATION GUARD] Tick ${tick} started but tree DB not updated.\n` +
      `Call evor_record_node for nodes: ${pendingIds.join(', ')}.\n` +
      `Do not finish until the tree is updated.\n`
  );
  process.exit(2);
}

// ── Guard 2: evolution drift-guard (Phase 2) ──────────────────────────────────
// Deterministic — no LLM calls.  FAIL-OPEN on any infrastructure error.
try {
  const debtReasons = [];

  // (a+b) Check tree.json nodes for missing integrity verdicts or missing telemetry
  const treePath = join(runDir, 'tree.json');
  if (existsSync(treePath)) {
    let treeData = null;
    try {
      treeData = JSON.parse(readFileSync(treePath, 'utf8'));
    } catch (_) { /* corrupt tree — fail-open */ }

    if (treeData) {
      const nodesRaw = treeData.nodes ?? {};
      // Support both DICT {id: node} and legacy LIST [{id, ...}]
      const nodes = Array.isArray(nodesRaw) ? nodesRaw : Object.values(nodesRaw);

      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const nodeId = node.id;
        const status = node.status;

        // Only "done" nodes are subject to the drift-guard
        if (status !== 'done') continue;

        const evalPath = join(runDir, 'evaluations', `${nodeId}.json`);

        // (a) Missing integrity verdict
        if (!existsSync(evalPath)) {
          debtReasons.push(
            `node ${nodeId} (status=done) has no evaluations/${nodeId}.json — integrity verdict missing`
          );
          continue; // skip telemetry check; integrity is the primary debt
        }

        // (b) Evaluated node missing telemetry
        const telemetryPath = join(runDir, 'nodes', nodeId, 'telemetry.jsonl');
        let telemetryMissing = false;
        if (!existsSync(telemetryPath)) {
          telemetryMissing = true;
        } else {
          try {
            if (statSync(telemetryPath).size === 0) telemetryMissing = true;
          } catch (_) {
            telemetryMissing = true;
          }
        }
        if (telemetryMissing) {
          debtReasons.push(
            `node ${nodeId} has evaluations/${nodeId}.json but telemetry.jsonl is missing or empty`
          );
        }
      }
    }
  }

  // (c) tick-state shows current_step < 9 while mission status is "running"
  const tickStatePath = join(runDir, 'tick-state.json');
  const missionStatePath = join(runDir, 'mission-state.json');
  if (existsSync(tickStatePath) && existsSync(missionStatePath)) {
    try {
      const tickState = JSON.parse(readFileSync(tickStatePath, 'utf8'));
      const missionState = JSON.parse(readFileSync(missionStatePath, 'utf8'));
      const currentStep = typeof tickState?.current_step === 'number' ? tickState.current_step : 9;
      const missionRunning = missionState?.status === 'running';
      if (missionRunning && currentStep < 9) {
        debtReasons.push(
          `tick-state.json shows current_step=${currentStep} (< 9) while mission status is "running" ` +
            `— tick ${tickState?.tick ?? '?'} appears mid-flight`
        );
      }
    } catch (_) { /* fail-open on parse errors */ }
  }

  if (debtReasons.length > 0) {
    const tick = runState?.tick_count ?? '?';
    process.stdout.write(
      `[EVOR DRIFT GUARD] Active run has behavioral debt after tick ${tick}.\n` +
        `Resolve the following before stopping:\n` +
        debtReasons.map((r, i) => `  ${i + 1}. ${r}`).join('\n') + '\n' +
        `\nDo not finish until drift is resolved.\n`
    );
    process.exit(2);
  }
} catch (err) {
  // FAIL-OPEN: unexpected error in drift-guard must never crash-block the session
  process.stderr.write(`[evor:stop] drift-guard internal error (fail-open): ${err.message}\n`);
}

process.exit(0);
