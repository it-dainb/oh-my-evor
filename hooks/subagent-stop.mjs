#!/usr/bin/env node
/**
 * oh-my-evor SubagentStop hook — write-as-you-go deliverables check (advisory)
 *
 * Kill switches (checked FIRST, before any other logic):
 *   DISABLE_EVOR=1                    → exit 0 immediately
 *   EVOR_SKIP_HOOKS=subagent-stop     → exit 0 immediately
 *
 * When a sub-agent (Sage, Mutagen, Probe, Forge, Selector) stops, this hook
 * checks whether the agent's expected final artifact is present on disk.
 * If the artifact is absent or trivially small (< MIN_ARTIFACT_BYTES), it
 * emits a NON-BLOCKING warning so the orchestrator knows the agent may not
 * have externalized its work.
 *
 * Role detection:
 *   EVOR_AGENT_ROLE env var (e.g. "sage", "mutagen", "probe", "forge", "selector")
 *   EVOR_CURRENT_TICK env var (tick number, for ticks/<tick>/<role>/ paths)
 *   If EVOR_AGENT_ROLE is unset, reads tick-state.json to infer current tick.
 *   If role cannot be determined, exits 0 silently.
 *
 * Artifact paths (all under .evor/runs/<mission>/<run-id>/):
 *   sage     → ticks/<tick>/sage/findings.json
 *   mutagen  → ticks/<tick>/mutagen/proposals.json
 *   probe    → ticks/<tick>/probe/findings.json
 *   forge    → ticks/<tick>/forge/forge-report.json
 *   selector → ticks/<tick>/selector/verdict.json
 *
 * Behavior:
 *   Artifact present + non-trivial → exit 0 silently.
 *   Artifact missing or too small  → emit [EVOR SUBAGENT WARNING] to stdout,
 *                                    exit 0 (advisory only — does NOT block).
 *
 * Fail-open: any error → exit 0. Never crash or block.
 */

import { existsSync, statSync, readFileSync, appendFileSync, renameSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { resolveActiveRun, resolveEvorRoot } from './lib/active-run.mjs';
import { isTickFinished } from './lib/run-status.mjs';
import { isYieldingStop } from './lib/waiting.mjs';
import { owed, describeOwed } from './lib/tick-completeness.mjs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('subagent-stop')) process.exit(0);

// ── STDIN payload (read once — stdin is not re-readable) ──────────────────────
let payload = {};
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* fail-open */ }

// ── evor-tick return contract ─────────────────────────────────────────────────
// evor-tick's return is the ONLY thing that crosses the context boundary into
// the mission orchestrator, so its size and shape are the whole reason the agent
// exists. Rewriting a return is impossible (PostToolUse.updatedToolOutput is
// documented but inert in CLI 2.1.220); blocking the stop is not — the subagent
// resumes and re-emits. So: reject and let it correct itself, at most twice.
// `yielding` exists because its absence broke the loop. A tick spans hours and
// ~10 async agent boundaries, and a sub-agent's only way to wait across one is to
// end its turn and be re-activated — which the platform does reliably: in the
// field evor-sage yielded SEVEN times with five live juniors and resumed every
// time. evor-tick yielded eight times and died on the eighth, and the only
// difference between them is that this check matches evor-tick.
//
// With no in-progress value, a yielding tick had to pick a TERMINAL outcome, and
// `failed` is the only one that can carry an explanation. So it emitted
//   {"tick":1,"outcome":"failed","error":"Blocked mid-tick at Step 5 ... No
//    blocking primitive available to hold turn across this compute-bound async
//    boundary. Steps 1-4 complete."}
// three separate times. Main read a dead tick and recovered the only way it
// could: by spawning a fresh tick agent, losing the first one's whole context.
// The contract could not express what was happening, so the agent lied in the
// only vocabulary it was given.
const TICK_OUTCOMES = ['scored', 'rejected', 'skipped', 'failed', 'yielding'];
/** Outcomes that mean the tick is OVER. `yielding` deliberately is not one. */
const TERMINAL_OUTCOMES = ['scored', 'rejected', 'skipped', 'failed'];
const MAX_RETURN_CHARS = 1500;   // ~400 tokens, per the agent's own budget
const MAX_RETRIES = 2;

// Every OTHER agent gets a size bound only — no schema. evor-tick's four returns
// totalled 2,304 chars while one generic Explore spawn returned 9,306, four times
// all of them combined and the single largest thing the orchestrator ingested.
// Bounding one doorway and leaving the others open does not bound context.
const MAX_GENERIC_RETURN_CHARS = 2000;

const agentType = String(payload.agent_type ?? '').toLowerCase();
const isTick = agentType.endsWith('evor-tick');

if (isTick) {
  const msg = String(payload.last_assistant_message ?? '');

  // A turn end that is a YIELD is not a return, so it has no return contract to
  // violate. Enforcing one here is what converted every yield into a
  // termination: the block says "Re-emit your entire response as ONE JSON
  // object", the tick complies, and that object becomes the value main consumes.
  //
  // `evor-sage` is the control. It is not matched by this check, its yields
  // carried ordinary prose, nothing coerced them, and it was re-activated all
  // seven times. Letting a yielding tick emit whatever it likes restores that.
  const tickStateNow = readTickState();
  if (isYieldingStop(payload, tickStateNow)) {
    process.exit(0);
  }

  // ── Completeness: a tick may not finish owing a selected candidate ────────
  //
  // Reached only when the tick is NOT yielding — it is claiming a terminal
  // outcome. Every proposal the selector selected owes a trained, evaluated,
  // integrity-checked node; the winner is the primary among them, not the only
  // one. In the field the selector selected h001 and h003, only h001 was
  // forged, and h003 went into a `carry_forward` key defined nowhere and read by
  // nothing. The tick reported step 9 done with an approved hypothesis dropped.
  //
  // Deliberately NOT checked mid-tick: there the answer is legitimately
  // "everything", and blocking on it would forbid the only way a tick can wait
  // across a multi-hour training.
  const terminal = (() => {
    try {
      const t = JSON.parse(msg.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      return TERMINAL_OUTCOMES.includes(t?.outcome) ? t : null;
    } catch { return null; }
  })();
  if (terminal && terminal.outcome === 'scored' && !payload.stop_hook_active) {
    const debt = owedForThisTick(terminal.tick);
    if (debt.length && bumpRetries(payload.agent_id) <= MAX_RETRIES) {
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason:
          `Tick ${terminal.tick} reports "scored" but still owes a selected candidate: ` +
          `${describeOwed(debt)}.\n` +
          `Every proposal the selector marked selected owes a trained AND evaluated node — ` +
          `the winner is the primary, not the only one. Forge the remaining candidate(s), or ` +
          `if one genuinely cannot be run, emit a signal naming it and return "failed" with ` +
          `that reason. Do not park it in a carry_forward key: nothing reads one.`,
      }) + '\n');
      process.exit(0);
    }
  }

  const violation = checkTickReturn(msg);
  // stop_hook_active is the platform's own loop guard; our counter bounds the
  // case where it is not set. Either one alone must be able to end the loop.
  if (violation && !payload.stop_hook_active && bumpRetries(payload.agent_id) <= MAX_RETRIES) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        `Your return violates the tick contract: ${violation}\n` +
        `Re-emit your entire response as ONE JSON object, nothing else:\n` +
        `If you are WAITING on an agent or artifact rather than finishing, say so — ` +
        `outcome:"yielding" with "waiting_on":"<artifact or task>". That is not a ` +
        `failure and does not end the tick; do not report "failed" for it.\n` +
        `{"tick":<number>,"outcome":"${TICK_OUTCOMES.join('|')}",` +
        `"node_id":"<id, if a node was produced>","score":<number, if evaluated>,` +
        `"pointers":[{"run_id":"...","tick":<n>,"agent":"..."}],"error":"<only when outcome=failed>"}\n` +
        `Under ${MAX_RETURN_CHARS} characters. Content that lives in an artifact goes in pointers, not here.`,
    }) + '\n');
    process.exit(0);
  }
} else {
  const msg = String(payload.last_assistant_message ?? '');
  if (
    msg.length > MAX_GENERIC_RETURN_CHARS &&
    !payload.stop_hook_active &&
    bumpRetries(payload.agent_id) <= MAX_RETRIES
  ) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        `Your return is ${msg.length} characters, over the ${MAX_GENERIC_RETURN_CHARS}-character ` +
        `budget. Whoever spawned you carries every byte of it for the rest of the mission.\n` +
        `Re-emit the conclusion only. Anything already written to an artifact or a file should be ` +
        `a pointer to it (run_id / tick / agent, or a path), not its contents.`,
    }) + '\n');
    process.exit(0);
  }
}

// ── Near-cap warning (PM1 detector) ───────────────────────────────────────────
// Raising the turn caps in §S3 removed the truncate-then-resume cycle, but a cap
// is still a runaway backstop. An agent that lands within a few turns of its cap
// is the signal that the cap is wrong — or that the agent is looping. Advisory,
// never blocking: this reports, it does not correct.
try {
  const declaredCap = capFor(agentType);
  if (declaredCap) {
    const turns = countTurns(payload.agent_transcript_path);
    if (turns && declaredCap - turns <= 3) {
      process.stderr.write(
        `[EVOR CAP] ${agentType} stopped at ${turns}/${declaredCap} turns. ` +
          `At the cap the agent is truncated mid-task and resuming it re-primes its whole ` +
          `context as cache_creation — raise the cap or narrow the role.\n`
      );
    }
  }
} catch { /* advisory only */ }

/** Declared maxTurns for an agent type, read from its definition file. */
function capFor(type) {
  const bare = type.replace(/^oh-my-evor:/, '');
  if (!/^evor-[a-z-]+$/.test(bare)) return 0; // not one of ours; no declaration to read
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
  try {
    const src = readFileSync(join(root, 'agents', `${bare}.md`), 'utf8');
    const m = src.match(/^maxTurns:\s*(\d+)\s*$/m);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

/** Assistant turns in an agent transcript, deduped by message id. */
function countTurns(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  const ids = new Set();
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const m = JSON.parse(line)?.message;
      // usage is stamped on every content block of a message, so the id is what
      // makes this a turn count rather than a block count.
      if (m?.usage && m?.id) ids.add(m.id);
    } catch { /* skip malformed line */ }
  }
  return ids.size;
}

/** null if the return conforms, else a one-line description of the violation. */
function checkTickReturn(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (text.length > MAX_RETURN_CHARS) {
    return `${text.length} characters, over the ${MAX_RETURN_CHARS}-character budget`;
  }
  let obj;
  try { obj = JSON.parse(text); } catch { return 'not parseable as JSON'; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'not a JSON object';
  if (typeof obj.tick !== 'number') return '"tick" is missing or not a number';
  if (!TICK_OUTCOMES.includes(obj.outcome)) return `"outcome" must be one of ${TICK_OUTCOMES.join(', ')}`;
  if (obj.pointers !== undefined && !Array.isArray(obj.pointers)) return '"pointers" must be an array';
  return null;
}

/**
 * The active run's tick-state, or null.
 *
 * The return-contract check runs before `runDir` is derived further down, so
 * this resolves the run itself rather than reordering the file — the yield
 * question has to be answered before any shape is enforced, or the enforcement
 * is what destroys the yield.
 */
function readTickState() {
  try {
    const { runId, missionId } = resolveActiveRun();
    if (!runId) return null;
    const root = resolveEvorRoot();
    const dir = missionId ? join(root, 'runs', missionId, runId) : join(root, 'runs', runId);
    const p = join(dir, 'tick-state.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null; // fail-open: unknown state must not make a yield enforceable
  }
}

/** Selected-but-undischarged proposals for a tick, or [] on any failure. */
function owedForThisTick(tick) {
  try {
    const { runId, missionId } = resolveActiveRun();
    if (!runId || typeof tick !== 'number') return [];
    const root = resolveEvorRoot();
    const dir = missionId ? join(root, 'runs', missionId, runId) : join(root, 'runs', runId);
    return owed(dir, tick);
  } catch {
    return []; // fail-open — an unreadable run must not trap a finished tick
  }
}

/** Attempt number for this agent. Keyed by agent_id so ticks stay independent. */
function bumpRetries(agentId) {
  const path = join(process.env.EVOR_STATE_DIR || tmpdir(), 'evor-tick-retries.json');
  let counts = {};
  try { counts = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first attempt */ }
  const n = (counts[agentId ?? 'unknown'] ?? 0) + 1;
  counts[agentId ?? 'unknown'] = n;
  try { writeFileSync(path, JSON.stringify(counts)); } catch { return MAX_RETRIES + 1; }
  return n;
}

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

// ── evor-tick mid-flight guard ────────────────────────────────────────────────
// The Stop hook's incomplete-tick guard is deliberately scoped to the
// orchestrator: "only main owns tick completion". That was true when main ran
// the 9 steps. It stopped being true when evor-tick became the boundary that
// runs them, and the enforcement did not follow the ownership.
//
// Measured in binarization-worldmodel-recall-2026-09: evor-tick spawned Forge,
// ended its own turn while Forge was still writing the candidate, and reported
// "mid-flight" as if that were an outcome. Three times in one session. Nothing
// blocked it, because a subagent ending its turn is exempt from every guard, so
// the whole cost landed on the orchestrator — which could only re-spawn or nudge.
//
// `SKILL.md` already tells the tick how to wait (`evor_await_artifact`, then
// `TaskOutput(task_id, block:true)` or `Monitor` the artifact). Prose was not
// enough; this is the same instruction delivered where the agent cannot skip it.
//
// Bounded by the shared retry counter — at most MAX_RETRIES nudges per agent_id,
// so a tick that genuinely cannot finish costs two turns and then goes through.
try {
  const tickType = String(payload.agent_type ?? '').toLowerCase();
  if (tickType.endsWith('evor-tick') && !payload.stop_hook_active) {
    const ts = existsSync(join(runDir, 'tick-state.json'))
      ? JSON.parse(readFileSync(join(runDir, 'tick-state.json'), 'utf8'))
      : null;
    const started = typeof ts?.tick === 'number' && ts.tick > 0;
    // A tick that yields to wait for Forge is doing the RIGHT thing — the CLI
    // wakes it when Forge reports. Only a tick that goes quiet with nothing
    // live and no recorded wait has actually abandoned the tick. Blocking the
    // yield case was this guard's own defect in v1.2.3: in the field the tick
    // had already written blocked:{on:"artifact:sage@tick1"} and was parked
    // exactly as instructed, and this fired at it anyway.
    const yielding = isYieldingStop(payload, ts);
    if (started && !isTickFinished(ts) && !yielding && bumpRetries(payload.agent_id) <= MAX_RETRIES) {
      const step = typeof ts?.current_step === 'number' ? ts.current_step : 0;
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason:
          `Tick ${ts.tick} is at step ${step} (${ts?.step_status ?? 'unknown'}) — you are ` +
          `returning mid-flight with NOTHING live and no recorded wait, so nothing will wake ` +
          `you. The orchestrator can only re-spawn you, and re-spawning re-primes your whole ` +
          `context.\n` +
          `Yielding to wait IS allowed and is not this: if you had spawned an agent that is ` +
          `still running, or called evor_await_artifact to record what you are blocked on, ` +
          `this would not have fired.\n` +
          `If you spawned an agent, WAIT for it: call evor_await_artifact to record WHAT you ` +
          `are waiting for, then TaskOutput(task_id, block:true) on that agent, or Monitor the ` +
          `artifact path it owes. Do not poll, and do not emit a "waiting..." turn.\n` +
          `Return only once the tick reaches step 9 with a recorded outcome — or, if it truly ` +
          `cannot, with outcome:"failed" and an "error" that says what blocked it.`,
      }) + '\n');
      process.exit(0);
    }
  }
} catch { /* fail-open — a missing or corrupt tick-state must never trap an agent */ }

// ── Role + tick resolution ────────────────────────────────────────────────────
// Primary: EVOR_AGENT_ROLE env var set explicitly by the spawning orchestrator.
// Fallback: parse agent_type from the SubagentStop STDIN payload that Claude Code
// delivers (e.g. {"agent_type":"oh-my-evor:evor-sage","session_id":...}).
// Only the five lead roles have tracked artifacts; sub-sub-agents (forge-junior,
// sage-junior, etc.) are silently ignored if their stripped name is unrecognised.
let agentRole = (process.env.EVOR_AGENT_ROLE ?? '').toLowerCase().trim();

if (!agentRole) {
  try {
    const agentType = (payload?.agent_type ?? '').toLowerCase();
    // Strip "oh-my-evor:evor-" prefix → bare role name (e.g. "sage", "forge").
    const stripped = agentType.replace(/^oh-my-evor:evor-/, '').replace(/^evor-/, '');
    const KNOWN_ROLES = new Set(['sage', 'mutagen', 'probe', 'forge', 'selector']);
    if (KNOWN_ROLES.has(stripped)) agentRole = stripped;
  } catch { /* fail-open — malformed or absent STDIN never blocks */ }
}

if (!agentRole) process.exit(0); // no role hint — cannot check specific artifact

let currentTick = process.env.EVOR_CURRENT_TICK
  ? parseInt(process.env.EVOR_CURRENT_TICK, 10)
  : NaN;

if (isNaN(currentTick)) {
  // Try to read from tick-state.json
  try {
    const tickState = JSON.parse(readFileSync(join(runDir, 'tick-state.json'), 'utf8'));
    currentTick = typeof tickState?.tick === 'number' ? tickState.tick : NaN;
  } catch {
    // tick-state unreadable — cannot resolve tick; exit safely
    process.exit(0);
  }
}

if (isNaN(currentTick)) process.exit(0);

// ── Artifact path map ─────────────────────────────────────────────────────────
const ARTIFACT_PATHS = {
  sage:     `ticks/${currentTick}/sage/findings.json`,
  mutagen:  `ticks/${currentTick}/mutagen/proposals.json`,
  probe:    `ticks/${currentTick}/probe/findings.json`,
  forge:    `ticks/${currentTick}/forge/forge-report.json`,
  selector: `ticks/${currentTick}/selector/verdict.json`,
};

const relPath = ARTIFACT_PATHS[agentRole];
if (!relPath) process.exit(0); // unrecognised role — exit silently

const artifactPath = join(runDir, relPath);

// ── §17D: Drain signals-inbox (command hook — reads env, calls Python harness) ─
// Best-effort: call `python3 -m evor.signals drain --run-id <id> --run-dir <dir>`
// to flush signals-inbox.jsonl into the SignalBus so the orchestrator can query
// them. Fail-open: if Python/harness unavailable, leave the inbox in place —
// the orchestrator will drain it on its next evor_signal_query call.
if (['sage', 'mutagen', 'probe', 'forge', 'selector', 'acquirer'].includes(agentRole)) {
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
    const harnessDir = process.env.EVOR_HARNESS_DIR ?? join(pluginRoot, 'harness');
    const py = process.env.EVOR_PYTHON ?? 'python3';
    const { delimiter } = await import('path');
    const pythonEnv = {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH
        ? `${harnessDir}${delimiter}${process.env.PYTHONPATH}`
        : harnessDir,
    };

    const inboxPath = join(runDir, 'signals-inbox.jsonl');
    if (existsSync(inboxPath)) {
      // Call the harness drain — purely best-effort side effect; stdio fully
      // suppressed so no subprocess output leaks onto our stdout/stderr.
      spawnSync(
        py,
        ['-m', 'evor.signals', 'drain',
         '--run-id', activeRunId,
         '--run-dir', runDir],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 3000, env: pythonEnv }
      );
    }
  } catch {
    // Drain failure is non-fatal — the orchestrator handles inbox draining
  }
}

// ── Artifact presence check (silent on success, warn on failure) ──────────────
// Contract: emit NOTHING on stdout when artifact is present and non-trivial.
// Only warn (non-blocking) when artifact is absent or too small.
const MIN_ARTIFACT_BYTES = 10;

try {
  if (!existsSync(artifactPath)) {
    process.stdout.write(
      `[EVOR SUBAGENT WARNING] ${agentRole} stopped but artifact not confirmed for this tick.\n` +
        `  Agent may not have externalized its work. Orchestrator should verify via evor_read_artifact.\n`
    );
    process.exit(0);
  }

  const size = statSync(artifactPath).size;
  if (size < MIN_ARTIFACT_BYTES) {
    process.stdout.write(
      `[EVOR SUBAGENT WARNING] ${agentRole} artifact is trivially small (${size} bytes) for this tick.\n` +
        `  Agent may have written a stub rather than a full deliverable.\n`
    );
    process.exit(0);
  }

  // Artifact present and non-trivial — exit silently (success path).
} catch (err) {
  // Fail-open: stat errors are non-fatal
  process.stderr.write(`[evor:subagent-stop] artifact check failed (non-fatal): ${err.message}\n`);
}

process.exit(0);
