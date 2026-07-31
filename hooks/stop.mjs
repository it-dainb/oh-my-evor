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

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { resolveActiveRun } from './lib/active-run.mjs';

// ── Kill switches ─────────────────────────────────────────────────────────────
// DISABLE_EVOR: truthy value disables the entire evor hook layer.
if (process.env.DISABLE_EVOR) process.exit(0);

// EVOR_SKIP_HOOKS: comma-separated list of hook names to skip individually.
const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('stop')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
const { runId: activeRunId, missionId } = resolveActiveRun();
if (!activeRunId) process.exit(0);

// ── §17D: Read stop_hook_active from STDIN payload (NOT from env) ─────────────
// stop_hook_active=true means the model is trying to stop again while we already
// blocked it. Track block count; release after ≥2 blocks (don't fight the user).
let stopHookActive = false;
try {
  const rawStdin = readFileSync(0, 'utf8');
  const stopPayload = JSON.parse(rawStdin || '{}');
  stopHookActive = !!stopPayload?.stop_hook_active;
} catch { /* fail-open — missing STDIN is normal in tests */ }

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
// missionId comes from resolveActiveRun() above.

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, activeRunId)
  : join(evorRoot, 'runs', activeRunId);

const runStatePath = join(runDir, 'run-state.json');

// ── §15E: Gate silent when mission is in a terminal/paused state ──────────────
// If the orchestrator already completed, failed, or paused the run, the stop
// hook must not interfere — the user is free to end the session.
try {
  const missionStatePath = join(runDir, 'mission-state.json');
  if (existsSync(missionStatePath)) {
    const ms = JSON.parse(readFileSync(missionStatePath, 'utf8'));
    const st = String(ms?.status ?? '').toLowerCase();
    if (st === 'paused' || st === 'completed' || st === 'failed') {
      process.exit(0); // terminal/paused — allow stop
    }
  }
} catch { /* fail-open — a corrupt mission-state must not block the user */ }

// ── §17D / §15E: Block-count escalation guard ────────────────────────────────
// Per-session file tracks how many times this hook has blocked. Once the model
// is already in a blocked stop (stop_hook_active=true) and we've blocked ≥2×,
// we release to avoid an infinite fight. Each exit-2 message includes the
// kill-switch guidance so the user can always override: EVOR_SKIP_HOOKS=stop.
const sessionId = (process.env.CLAUDE_SESSION_ID ?? 'nosession').slice(0, 24);
const blockCountPath = join(runDir, `stop-blocks-${sessionId}.json`);

let blockCount = 0;
try {
  const bcData = JSON.parse(readFileSync(blockCountPath, 'utf8'));
  blockCount = typeof bcData?.count === 'number' ? bcData.count : 0;
} catch { /* no file yet — first block */ }

if (stopHookActive) {
  // Model is already stopped and trying again — increment and potentially release.
  // For drift-only debt: release after 8 consecutive blocks (match [Attempt X/8] message).
  // For pending_node_ids violations: NEVER release — broken tree state is a structural
  // invariant that cannot be overridden by repeated stopping.
  blockCount++;
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(blockCountPath, JSON.stringify({ count: blockCount, updated_at: new Date().toISOString() }));
  } catch { /* state write failure is non-fatal */ }

  // Check pending_node_ids before releasing — if non-empty, never release
  if (blockCount >= 8) {
    // Only release if there are no pending nodes (structural invariant takes priority)
    let hasPendingNodes = false;
    try {
      if (existsSync(runStatePath)) {
        const rs = JSON.parse(readFileSync(runStatePath, 'utf8'));
        const pids = Array.isArray(rs?.pending_node_ids) ? rs.pending_node_ids : [];
        hasPendingNodes = pids.length > 0;
      }
    } catch { /* fail-open — treat as no pending nodes */ }

    if (!hasPendingNodes) {
      process.exit(0); // drift-only debt: release after 8 consecutive blocks
    }
    // else: pending nodes present — fall through and let continuation guard block
  }
}

// Helper: wrap any exit-2 message with escalation info
function blockStop(message) {
  const attempt = blockCount + 1;
  const suffix = `\n\n[Attempt ${attempt}/8] To force-stop regardless, set EVOR_SKIP_HOOKS=stop.`;
  process.stdout.write(message + suffix);
  // Record this block
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(blockCountPath, JSON.stringify({ count: attempt, updated_at: new Date().toISOString() }));
  } catch { /* non-fatal */ }
  process.exit(2);
}

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

  // Best-effort: resolve node names from tree.json so the message uses readable names
  // rather than raw ids. On any failure, fall back to showing the count only.
  let pendingLabel = `${pendingIds.length} pending node(s)`;
  try {
    const treePath = join(runDir, 'tree.json');
    if (existsSync(treePath)) {
      const treeData = JSON.parse(readFileSync(treePath, 'utf8'));
      const nodesRaw = treeData.nodes ?? {};
      const names = pendingIds.map(id => {
        const n = Object.values(nodesRaw).find(nd => nd?.id === id);
        return n?.name ?? null;
      }).filter(Boolean);
      if (names.length > 0) pendingLabel = names.join(', ');
    }
  } catch { /* fail-open — use count-only label */ }

  blockStop(
    `[EVOR CONTINUATION GUARD] Tick ${tick} started but tree DB not updated.\n` +
      `Call evor_record_node for: ${pendingLabel}.\n` +
      `Do not finish until the tree is updated.\n`
  );
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
      const nodes = Object.values(nodesRaw);

      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const nodeId = node.id;
        const status = node.status;

        // Only "done" nodes are subject to the drift-guard
        if (status !== 'done') continue;

        const evalPath = join(runDir, 'evaluations', `${nodeId}.json`);

        // (a) Missing integrity verdict — use node name if available, else omit identifier
        const nodeLabelA = node.name ?? null;
        if (!existsSync(evalPath)) {
          debtReasons.push(
            nodeLabelA
              ? `node '${nodeLabelA}' (status=done) — integrity verdict missing`
              : `a done node has no integrity verdict recorded`
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
          const nodeLabelB = node.name ?? null;
          debtReasons.push(
            nodeLabelB
              ? `node '${nodeLabelB}' — telemetry missing`
              : `an evaluated node is missing telemetry`
          );
        }
      }
    }
  }

  // (c) tick-state shows current_step < 9 while the run is "running".
  // M-2 fix: read status from run-state.json (already loaded as runState) — not
  // mission-state.json.  The run sets status:"running" in run-state.json;
  // mission-state.json stays "locked" throughout active runs.
  const tickStatePath = join(runDir, 'tick-state.json');
  if (existsSync(tickStatePath)) {
    try {
      const tickState = JSON.parse(readFileSync(tickStatePath, 'utf8'));
      const currentStep = typeof tickState?.current_step === 'number' ? tickState.current_step : 9;
      const missionRunning = runState?.status === 'running';
      if (missionRunning && currentStep < 9) {
        debtReasons.push(
          `tick-state.json shows current_step=${currentStep} (< 9) while run status is "running" ` +
            `— tick ${tickState?.tick ?? '?'} appears mid-flight`
        );
      }
    } catch (_) { /* fail-open on parse errors */ }
  }

  // (d) Inline-shortcut guard — catches the orchestrator role-playing the roster
  // inline instead of spawning Task sub-agents + persisting state. Fires when a tick
  // is claimed (tick-state present, tick >= 1) but its sub-agent artifacts and/or
  // tree nodes are absent. This is the enforcement teeth behind the SKILL's
  // Orchestrator_Contract: a tick that leaves no proposals/verdict/node on disk was
  // done inline and must be redone via real Task spawns.
  if (runState?.status === 'running') {
    let curTick = null;
    const tsPath = join(runDir, 'tick-state.json');
    if (existsSync(tsPath)) {
      try { curTick = JSON.parse(readFileSync(tsPath, 'utf8'))?.tick ?? null; } catch (_) { /* ignore */ }
    }

    let nodeCount = 0;
    if (existsSync(treePath)) {
      try {
        const td = JSON.parse(readFileSync(treePath, 'utf8'));
        const nr = td.nodes ?? {};
        nodeCount = Array.isArray(nr) ? nr.length : Object.keys(nr).length;
      } catch (_) { /* ignore */ }
    }

    if (typeof curTick === 'number' && curTick >= 1) {
      const tickDir = join(runDir, 'ticks', String(curTick));
      const proposalsPath = join(tickDir, 'mutagen', 'proposals.json');
      const verdictPath = join(tickDir, 'selector', 'verdict.json');

      if (!existsSync(proposalsPath)) {
        debtReasons.push(
          `[EVOR DRIFT GUARD] Tick ${curTick}: evor-mutagen output not found. Spawn evor-mutagen via Task — do not role-play the roster inline.`
        );
      } else if (!existsSync(verdictPath)) {
        debtReasons.push(
          `[EVOR DRIFT GUARD] Tick ${curTick}: evor-selector output not found. Spawn evor-selector via Task.`
        );
      }

      // Forge produced a report (a candidate WAS implemented) but nothing reached the
      // tree. This is the "trained inline, recorded nothing" shortcut. (An all-rejected
      // tick has no forge-report and legitimately adds 0 nodes — not flagged.)
      const forgeReport = join(tickDir, 'forge', 'forge-report.json');
      if (existsSync(forgeReport) && nodeCount === 0) {
        debtReasons.push(
          `[EVOR DRIFT GUARD] Tick ${curTick}: Forge produced output but no tree node recorded. Call evor_record_node and evor_record_eval.`
        );
      }
    }
  }

  // (e) Sub-agent tasks still running within this tick — forward-compatible check.
  // If the orchestrator writes pending_subagent_ids[] to tick-state.json when spawning
  // Task sub-agents, the stop hook blocks until they complete.
  // If the field is absent (old tick-state format) this guard is a no-op (fail-open).
  if (runState?.status === 'running') {
    try {
      const tsPathE = join(runDir, 'tick-state.json');
      if (existsSync(tsPathE)) {
        const tickStateE = JSON.parse(readFileSync(tsPathE, 'utf8'));
        const pendingSubagentIds = Array.isArray(tickStateE?.pending_subagent_ids)
          ? tickStateE.pending_subagent_ids
          : [];
        if (pendingSubagentIds.length > 0) {
          const shown = pendingSubagentIds.slice(0, 3).join(', ');
          const ellipsis = pendingSubagentIds.length > 3 ? '...' : '';
          debtReasons.push(
            `tick ${tickStateE?.tick ?? '?'} has ${pendingSubagentIds.length} sub-agent task(s) still pending: ` +
              `${shown}${ellipsis}. Wait for sub-agents to complete before stopping.`
          );
        }
      }
    } catch (_) { /* fail-open — tick-state absent or corrupt */ }
  }

  if (debtReasons.length > 0) {
    const tick = runState?.tick_count ?? '?';
    blockStop(
      `[EVOR DRIFT GUARD] Active run has behavioral debt after tick ${tick}.\n` +
        `Resolve the following before stopping:\n` +
        debtReasons.map((r, i) => `  ${i + 1}. ${r}`).join('\n') + '\n' +
        `\nDo not finish until drift is resolved.\n`
    );
  }
} catch (err) {
  // FAIL-OPEN: unexpected error in drift-guard must never crash-block the session
  process.stderr.write(`[evor:stop] drift-guard internal error (fail-open): ${err.message}\n`);
}

process.exit(0);
