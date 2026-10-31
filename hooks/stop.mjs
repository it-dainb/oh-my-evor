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
 *   pending_node_ids non-empty    → block   (continuation guard)
 *   behavioral debt detected      → block   (drift-guard; lists offending nodes)
 *   blocked HARD_CEILING times    → exit 0  (livelock release; debt stays on disk)
 *   any hook internal error       → exit 0  (FAIL-OPEN — never crash-block)
 *
 * A block is `{"decision":"block","reason":...}` on stdout with exit 0 — the JSON
 * hook protocol. Exit 2 would make Claude Code read the reason from stderr, which
 * is how this hook spent 497 turns blocking with an empty message.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { hasForgeReport } from './lib/forge-reports.mjs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { resolveActiveRun, resolveEvorRoot } from './lib/active-run.mjs';
import { isMissionLive, isTickFinished } from './lib/run-status.mjs';
import { isYieldingStop, recordedWait, liveSubagents } from './lib/waiting.mjs';
import { resolveNodeArtifact } from './lib/node-identity.mjs';
import { tickRoute, HEARTBEAT_CALL } from './lib/next-step.mjs';

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
/** Kept for the incomplete-tick guard at the end of the file. */
let payloadForContinuation = {};
try {
  const rawStdin = readFileSync(0, 'utf8');
  const stopPayload = JSON.parse(rawStdin || '{}');
  payloadForContinuation = stopPayload;
  stopHookActive = !!stopPayload?.stop_hook_active;
} catch { /* fail-open — missing STDIN is normal in tests */ }

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

const runStatePath = join(runDir, 'run-state.json');

/** A sub-agent's stop (it carries agent_type/agent_id); main's carries neither. */
const isSubagentStop = Boolean(payloadForContinuation?.agent_type ?? payloadForContinuation?.agent_id);
/**
 * How main hands a debt to the tick: resume its agent, or spawn evor-tick when
 * the tick has none. Main does not record nodes or run the roster itself, so a
 * guard that names those calls to main asks for what the governor refuses.
 */
const routeToTick = (capital = true) => {
  const r = tickRoute(runDir, payloadForContinuation?.session_id, payloadForContinuation?.transcript_path);
  return capital ? r.charAt(0).toUpperCase() + r.slice(1) : r;
};

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

// ── Yield gate: a stop with live children is not an end ──────────────────────
// Claude Code re-activates an agent when a background agent it spawned reports
// back — the CLI shows "Waiting for N background agents to finish". An agent
// that ends its turn there has YIELDED, not finished, and every guard below is
// asking it for work that is in flight somewhere else.
//
// Both field failures were this. In the second, the drift guard demanded tick
// 1's Mutagen artifact 16 seconds into tick 1, from the orchestrator — which is
// forbidden to produce it (the tick boundary owns that spawn). The orchestrator
// could not comply without committing the exact violation the guard exists to
// detect, so it burned attempts until the operator disabled the hook outright
// with EVOR_SKIP_HOOKS=stop, which disarms every legitimate guard here too.
//
// So this runs BEFORE the block counter: a yield must not consume attempts.
/** True while an evor_wait heartbeat runs for this run (its marker is live). */
function heartbeatArmed(dir) {
  try {
    const hb = JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf8'));
    if (!(Number(hb.until) > Date.now() - 60_000)) return false;
    if (hb.pid) { try { process.kill(hb.pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; } }
    return true;
  } catch { return false; }
}

/** Set when the stop would leave a recorded job wait with nobody to wake on it. */
let deadEndJobWait = null;
try {
  let tickStateForYield = null;
  try {
    const tsp = join(runDir, 'tick-state.json');
    if (existsSync(tsp)) tickStateForYield = JSON.parse(readFileSync(tsp, 'utf8'));
  } catch { /* unreadable tick-state falls through to the subagent scan */ }

  // A JOB wait is not a yield. No host task tracks an evor_run_start job, so no
  // notice will ever come back for it: stopping here leaves the mission parked
  // until a human types. That is how the 2026-10-30 binarization mission ended
  // up: tick 2 yielded on job 91898813, main was denied Monitor, stopped, and the
  // job finished minutes later with nobody to see it. Handled after the block
  // counter below, so the ceiling still bounds it.
  const jobWait = recordedWait(tickStateForYield);
  const tickLive = liveSubagents(payloadForContinuation?.session_id, payloadForContinuation?.transcript_path)
    .some((a) => /evor-tick$/.test(String(a.agentType)));
  // A LIVE tick that recorded a job wait is still waiting on it (e.g. inside
  // evor_wait); main's stop is then an ordinary yield on the tick.
  if (jobWait && /^job:/.test(jobWait.on) && !isTickFinished(tickStateForYield) && !tickLive) {
    deadEndJobWait = jobWait.on.slice('job:'.length);
  } else if (isYieldingStop(payloadForContinuation, tickStateForYield)) {
    // A completion notice can be lost, and then nothing wakes this session.
    // A yield is only safe with a heartbeat wait armed to wake it.
    if (!stopHookActive && !heartbeatArmed(runDir)) {
      process.stderr.write(
        `[evor:stop] Before ending your turn on a yield, arm the heartbeat: call ` +
          `evor_wait({ heartbeat: true }), then end your turn. It wakes this ` +
          `session if a completion notice never arrives.\n`
      );
      process.exit(2);
    }
    const wait = recordedWait(tickStateForYield);
    const live = liveSubagents(payloadForContinuation?.session_id, payloadForContinuation?.transcript_path);
    process.stderr.write(
      `[evor:stop] yielding, not ending — ` +
        (wait ? `waiting on ${wait.on}` : `${live.length} live sub-agent(s)`) +
        `. Guards not evaluated.\n`
    );
    process.exit(0);
  }
} catch (err) {
  // FAIL-OPEN in the permissive direction on purpose: misreading a yield as an
  // end is what produced 497 blocked stops, and the debt survives on disk for
  // the next stop either way.
  process.stderr.write(`[evor:stop] yield check failed (allowing stop): ${err.message}\n`);
  process.exit(0);
}

// ── §17D / §15E: Block-count escalation guard ────────────────────────────────
// Per-session file tracks how many times this hook has blocked, so a guard that
// the model cannot satisfy still terminates. Two ceilings, both absolute:
//   SOFT_CEILING — drift-only debt releases here.
//   HARD_CEILING — EVERYTHING releases here, pending_node_ids included.
// The previous code had no hard ceiling: pending_node_ids was declared a
// structural invariant that "can never be overridden by repeated stopping", so
// its branch fell through to block again, forever. Measured in the
// binarization-worldmodel-recall-2026-09 run: count reached 497 against a single
// pending node the model had no way to record, and every one of those turns was
// spent re-reading the same blocked stop. A guard the agent cannot discharge is
// a livelock, not an invariant — the debt survives in run-state.json either way,
// and the next session's guard re-raises it. Blocking 497 times does not record
// the node; it only burns the context that might have.
const SOFT_CEILING = 8;
const HARD_CEILING = 25;
// session_id arrives on the STDIN payload; CLAUDE_SESSION_ID is not set for Stop
// hooks in this build, which collapsed every session onto one 'nosession' file.
const sessionId = String(
  payloadForContinuation?.session_id ?? process.env.CLAUDE_SESSION_ID ?? 'nosession'
).slice(0, 24);
const blockCountPath = join(runDir, `stop-blocks-${sessionId}.json`);

let blockCount = 0;
try {
  const bcData = JSON.parse(readFileSync(blockCountPath, 'utf8'));
  blockCount = typeof bcData?.count === 'number' ? bcData.count : 0;
} catch { /* no file yet — first block */ }

/**
 * Pending entries that still owe work. An entry whose node, by id or name, has
 * already finished (evaluated, failed, rejected) is stale and owes nothing, so it
 * must not hold the stop.
 */
function unrecordedPending(rs) {
  const ids = Array.isArray(rs?.pending_node_ids) ? rs.pending_node_ids : [];
  if (!ids.length) return ids;
  try {
    const tree = JSON.parse(readFileSync(join(runDir, 'tree.json'), 'utf8'));
    const settled = new Set();
    for (const n of Object.values(tree?.nodes ?? {})) {
      if (!n || ['pending', 'running', undefined].includes(n.status)) continue;
      if (n.id) settled.add(n.id);
      if (n.name) settled.add(n.name);
    }
    return ids.filter((id) => !settled.has(id));
  } catch {
    return ids; // no readable tree: every entry still counts
  }
}

/** Read pending_node_ids without assuming run-state.json is loadable yet. */
function hasPendingNodes() {
  try {
    if (!existsSync(runStatePath)) return false;
    return unrecordedPending(JSON.parse(readFileSync(runStatePath, 'utf8'))).length > 0;
  } catch {
    return false; // fail-open
  }
}

// Ceiling check runs unconditionally, not only when stop_hook_active is set.
// stop_hook_active is the platform's signal and it is not guaranteed; the
// persisted count is ours and always is.
if (blockCount >= HARD_CEILING) {
  process.stderr.write(
    `[evor:stop] released after ${blockCount} blocked stops (hard ceiling ${HARD_CEILING}). ` +
      `Outstanding debt remains recorded in run-state.json.\n`
  );
  process.exit(0);
}
if (blockCount >= SOFT_CEILING && !hasPendingNodes()) {
  process.exit(0); // drift-only debt: release at the soft ceiling
}

/**
 * Block the stop.
 *
 * Emits the JSON hook protocol on stdout and exits 0 — NOT exit 2. Exit 2 makes
 * Claude Code read the reason from STDERR, and this hook has always written its
 * message to stdout, so every block surfaced to the model as:
 *
 *     Stop hook error: [node "$CLAUDE_PLUGIN_ROOT"/hooks/stop.mjs]: No stderr output
 *
 * — a block with no stated reason. The model could not act on what it could not
 * read, so it emitted a filler line and stopped again, and the loop above did
 * the rest. `subagent-stop.mjs` and `pre-tool-use.mjs` already use the JSON
 * protocol; this was the one hook left on the exit-code path.
 */
function blockStop(message) {
  const attempt = blockCount + 1;
  const reason =
    message + `\n\n[Attempt ${attempt}/${HARD_CEILING}]`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  // Mirrored to stderr so the reason is in the session log even if the JSON
  // protocol is not honoured by the host.
  process.stderr.write(reason + '\n');
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(blockCountPath, JSON.stringify({ count: attempt, updated_at: new Date().toISOString() }));
  } catch { /* non-fatal */ }
  process.exit(0);
}

if (deadEndJobWait) {
  let state = 'unknown';
  try {
    state = String(JSON.parse(readFileSync(join(runDir, 'jobs', deadEndJobWait, 'status.json'), 'utf8'))?.state ?? 'unknown');
  } catch { /* no status file: say so below rather than guess */ }
  blockStop(
    `[evor:stop] The tick is waiting on job ${deadEndJobWait} (state: ${state}), and nothing ` +
      `will wake you when it finishes: a job is not a task the host tracks. ` +
      (state === 'running'
        ? `Call evor_wait({ job_id: "${deadEndJobWait}" }) to hold your turn until it ends. `
        : `It is no longer running. `) +
      (isSubagentStop
        ? `Then finish the tick: continue from step 6.`
        : `Then hand it back to the tick: ${routeToTick(false)}, and tell it the job's state.`)
  );
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

// ── 1.9c: mission state, for the three debt gates below ──────────────────────
// They used to ask `run-state.status === 'running'`. AF3 §4.1 retires that field
// (it duplicated the mission's and was wrong in all three field runs), so
// liveness is asked of the mission — which `evor_run_start` now drives into
// `running` server-side rather than asking an agent to.
//
// A corrupt or absent mission-state leaves this undefined, and `isMissionLive`
// falls back to the run file. Failing to READ the mission must not be the same
// as the mission being dead: that would disarm three governance checks silently,
// in the permissive direction, which is exactly the shape this release exists to
// remove.
let missionState;
try {
  const msPath = join(runDir, 'mission-state.json');
  if (existsSync(msPath)) missionState = JSON.parse(readFileSync(msPath, 'utf8'));
} catch (err) {
  process.stderr.write(`[evor:stop] unreadable mission-state.json: ${err.message}\n`);
}

// ── Guard 1: continuation guard (existing M7a) ────────────────────────────────
const pendingIds = unrecordedPending(runState);
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
    isSubagentStop
      ? `[EVOR CONTINUATION GUARD] Tick ${tick} started but tree DB not updated.\n` +
          `Call evor_record_node for: ${pendingLabel}.\n` +
          `Do not finish until the tree is updated.\n`
      : `[EVOR CONTINUATION GUARD] Tick ${tick} started but tree DB not updated: no node is ` +
          `recorded for ${pendingLabel}. The tick records nodes with evor_record_node, not you. ` +
          `${routeToTick()}, ` +
          `and tell it which nodes are pending.\n`
  );
}

// ── Guard 2: evolution drift-guard (Phase 2) ──────────────────────────────────
// Deterministic — no LLM calls.  FAIL-OPEN on any infrastructure error.
//
// SCOPED TO THE ORCHESTRATOR (item 1.9c). Its whole subject is main role-playing
// the roster inline instead of spawning Task sub-agents — "a tick that leaves no
// proposals/verdict/node on disk was done inline". A sub-agent ending its own
// turn is not that, and blocking it is nonsense: the artifacts it is being asked
// for are the ones it was spawned to produce.
//
// This guard was never scoped, and only LOOKED scoped because its gates keyed on
// `run-state.status === "running"` — a field two whole test suites' fixtures did
// not set, so the guard was inert and its unscoped-ness never showed. Re-homing
// the gates onto mission liveness armed them and surfaced it immediately.
// `stop-incomplete-tick.test.ts`'s "the guard is scoped to the orchestrator"
// cases have asserted this all along; they were passing for the wrong reason.
try {
  if (isSubagentStop) process.exit(0);

  /** Debts only the tick can discharge: main hands them to it. */
  const debtReasons = [];
  /** Debts main discharges itself in this turn. */
  const ownDebts = [];

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

        // (b) Evaluated node missing telemetry.
        //
        // Resolved across BOTH identities (O-01). This built `nodes/<uuid>/`
        // only, which is the same guess that once failed a node holding 12,000
        // well-formed telemetry records — the trainer had filed them under the
        // slug. A guard that reports a trained node as missing telemetry fails
        // in the direction of "the candidate is bad", which is the worst
        // direction a silent path miss can fail in.
        const telemetryPath = resolveNodeArtifact(
          join(runDir, 'nodes', nodeId, 'telemetry.jsonl'),
          node,
        );
        let telemetryMissing = false;
        if (!telemetryPath) {
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
      // (c) REMOVED (item 1.2). This reported "tick N appears mid-flight" — the
      // same fact as Guard 3's continuation check, one guard earlier and with a
      // strictly worse message: Guard 3 tells the agent HOW to wait (TaskOutput
      // with block:true, or Monitor the artifact it owes), this only told it
      // something was wrong. Two predicates over one condition, and the vaguer
      // one won by ordering.
      //
      // It was invisible while the gate keyed on `run-state.status`, which the
      // fixtures did not set. Arming the gates made the duplication fire, which
      // is the same collapse §1.2 makes for `finished`: five re-derivations of
      // one predicate reduced to a single owner. Guard 3 is that owner.
      void tickStatePath;
    } catch (_) { /* fail-open on parse errors */ }
  }

  // (d) Inline-shortcut guard — catches the orchestrator role-playing the roster
  // inline instead of spawning Task sub-agents + persisting state. Fires when a tick
  // is claimed (tick-state present, tick >= 1) but its sub-agent artifacts and/or
  // tree nodes are absent. This is the enforcement teeth behind the SKILL's
  // Orchestrator_Contract: a tick that leaves no proposals/verdict/node on disk was
  // done inline and must be redone via real Task spawns.
  // Scoped to a FINISHED tick. These predicates ask whether the roster's output
  // reached disk; mid-tick the answer is legitimately "not yet", and asking it
  // early is how the guard demanded a Mutagen artifact 16 seconds into tick 1.
  // "Did you skip the roster?" is only answerable once the tick is over.
  let tickStateForDrift = null;
  try {
    const tsp = join(runDir, 'tick-state.json');
    if (existsSync(tsp)) tickStateForDrift = JSON.parse(readFileSync(tsp, 'utf8'));
  } catch (_) { /* ignore */ }
  const tickOver = tickStateForDrift === null || isTickFinished(tickStateForDrift);

  if (isMissionLive(missionState, runState) && tickOver) {
    const curTick = tickStateForDrift?.tick ?? null;

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
          `tick ${curTick}: evor-mutagen output not found — the tick has not run Mutagen.`
        );
      } else if (!existsSync(verdictPath)) {
        debtReasons.push(
          `tick ${curTick}: evor-selector output not found — the tick has not run Selector.`
        );
      }

      // Forge produced a report (a candidate WAS implemented) but nothing reached the
      // tree. This is the "trained inline, recorded nothing" shortcut. (An all-rejected
      // tick has no forge-report and legitimately adds 0 nodes — not flagged.)
      if (hasForgeReport(tickDir) && nodeCount === 0) {
        debtReasons.push(
          `tick ${curTick}: Forge produced output but no tree node is recorded (evor_record_node, evor_record_eval).`
        );
      }
    }
  }

  // (f) A completed tick with no tick_record.
  //
  // The circuit breaker (consecutive FAILED ticks) and the plateau window (ticks
  // with no improvement) read `run_state.tick_records` and nothing else. Before
  // `evor_state_write({tick_record})` existed nothing wrote per-tick history at
  // all — the plateau checks read an always-empty list — so an unrecorded tick is
  // invisible to both limits. This is debt the orchestrator can discharge in the
  // same turn, with one call, which is the only kind a Stop guard may demand.
  //
  // Counted against max(tick_count, the finished tick in tick-state) so a missed
  // record is still caught after main has moved on to the next tick.
  //
  if (isMissionLive(missionState, runState)) {
    const completed = Math.max(
      Number.isInteger(runState?.tick_count) ? runState.tick_count : 0,
      tickStateForDrift && isTickFinished(tickStateForDrift) && Number.isInteger(tickStateForDrift.tick)
        ? tickStateForDrift.tick : 0,
    );
    const recorded = new Set(
      (Array.isArray(runState?.tick_records) ? runState.tick_records : [])
        .map(r => r?.tick).filter(Number.isInteger),
    );
    // Count from the FIRST recorded tick — or, for a run that has never recorded
    // one, from the latest completed tick only. Every run in flight when records
    // were introduced has none, and demanding ticks 1..N from it would ask main
    // for outcomes it cannot honestly reconstruct; the only truthful answer
    // would be a guess. One tick of debt starts the series, and every gap after
    // that is caught.
    const start = recorded.size > 0 ? Math.min(...recorded) : completed;
    const unrecorded = [];
    for (let t = Math.max(1, start); t <= completed; t++) if (!recorded.has(t)) unrecorded.push(t);
    if (unrecorded.length > 0) {
      const shown = unrecorded.slice(0, 5).join(', ') + (unrecorded.length > 5 ? ', ...' : '');
      ownDebts.push(
        `tick(s) ${shown} finished with no tick_record. Call ` +
          `evor_state_write({tick_record:{tick, outcome, score?}}) for each — the circuit ` +
          `breaker and plateau window read these records and nothing else.`
      );
    }
  }

  // (e) Sub-agent tasks still running within this tick — forward-compatible check.
  // If the orchestrator writes pending_subagent_ids[] to tick-state.json when spawning
  // Task sub-agents, the stop hook blocks until they complete.
  // If the field is absent (old tick-state format) this guard is a no-op (fail-open).
  if (isMissionLive(missionState, runState)) {
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
              `${shown}${ellipsis}.`
          );
        }
      }
    } catch (_) { /* fail-open — tick-state absent or corrupt */ }
  }

  if (debtReasons.length > 0 || ownDebts.length > 0) {
    const tick = runState?.tick_count ?? '?';
    const list = (xs) => xs.map((r, i) => `  ${i + 1}. ${r}`).join('\n') + '\n';
    blockStop(
      `[EVOR DRIFT GUARD] Active run has behavioral debt after tick ${tick}.\n` +
        (ownDebts.length ? `Resolve these yourself before stopping:\n${list(ownDebts)}` : '') +
        (debtReasons.length
          ? `The tick owes these, not you: ${routeToTick(false)}, and tell it what is missing:\n` +
            list(debtReasons)
          : '')
    );
  }
} catch (err) {
  // FAIL-OPEN: unexpected error in drift-guard must never crash-block the session
  process.stderr.write(`[evor:stop] drift-guard internal error (fail-open): ${err.message}\n`);
}

// ── Incomplete-tick guard ─────────────────────────────────────────────────────
// The orchestrator's failure mode is not doing too much, it is stopping too early.
// Measured twice: main spawns evor-tick, the tick reports failure, main resumes it
// in the BACKGROUND and then ends its turn — which ends the whole `-p` session with
// zero tree nodes. The existing continuation guard cannot catch this, because it
// keys on pending_node_ids and a tick that dies before recording a node leaves that
// list empty.
//
// Prose does not fix this. Main was told "spawn evor-tick, record the outcome,
// decide continue/stop" and did precisely that; nothing in the sentence says the
// waiting is its job. So the invariant is enforced here instead: a tick that has
// started and not reached step 9 means the loop is still owed work.
//
// Subagents are exempt — only the orchestrator owns tick completion.
try {
  // stopPayload/tickStatePath above are block-scoped; re-derive rather than reuse.
  if (!isSubagentStop) {
    const tsPathC = join(runDir, 'tick-state.json');
    const ts = existsSync(tsPathC) ? JSON.parse(readFileSync(tsPathC, 'utf8')) : null;
    const started = typeof ts?.tick === 'number' && ts.tick > 0;
    const step = typeof ts?.current_step === 'number' ? ts.current_step : 0;
    // 1.2: one owner for this predicate. The rule that used to live here —
    // `step >= 9` alone — was correct about the false-stop hazard and wrong about
    // step 9 itself: r3's final tick sat at step 9 with `step_status: "running"`
    // and a failed integrity verdict, and this called it complete. `isTickFinished`
    // keeps the absent-field permissiveness that motivated the original form and
    // stops treating an EXPLICIT "still running" as done. See its docstring for
    // why the two absences are read in opposite directions.
    const finished = isTickFinished(ts);

    const stalledOn = recordedWait(ts)?.on;
    if (started && !finished && stalledOn && !/^job:/.test(stalledOn)) {
      blockStop(
        `[EVOR CONTINUATION] Tick ${ts.tick} is waiting on ${stalledOn}, and no agent is running ` +
          `that will deliver it: the agent that owes it ended its turn and is not woken again by ` +
          `itself. ${routeToTick()}, and tell it what it is waiting on; it resumes the agent ` +
          `that owes the artifact.\n`
      );
    } else if (started && !finished) {
      blockStop(
        `[EVOR CONTINUATION] Tick ${ts.tick} is at step ${step} (${ts?.step_status ?? 'unknown'}) — not complete, ` +
          `and nothing of it is running. Ending your turn now ends the mission with this tick ` +
          `unfinished.\n\n` +
          `${routeToTick()}. While it works, call ${HEARTBEAT_CALL}, then end your turn: its ` +
          `completion notice wakes you. The tick is not done until it reports an outcome.\n`
      );
    }
  }
} catch (err) {
  // FAIL-OPEN — a missing or corrupt tick-state must never trap the session.
  process.stderr.write(`[evor:stop] continuation guard internal error (fail-open): ${err.message}\n`);
}

process.exit(0);
