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
import { resolveActiveRun } from './lib/active-run.mjs';

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
const TICK_OUTCOMES = ['scored', 'rejected', 'skipped', 'failed'];
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
  const violation = checkTickReturn(msg);
  // stop_hook_active is the platform's own loop guard; our counter bounds the
  // case where it is not set. Either one alone must be able to end the loop.
  if (violation && !payload.stop_hook_active && bumpRetries(payload.agent_id) <= MAX_RETRIES) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        `Your return violates the tick contract: ${violation}\n` +
        `Re-emit your entire response as ONE JSON object, nothing else:\n` +
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
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
// missionId comes from resolveActiveRun() above.

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, activeRunId)
  : join(evorRoot, 'runs', activeRunId);

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
