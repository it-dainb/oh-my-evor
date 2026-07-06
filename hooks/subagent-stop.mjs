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

import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('subagent-stop')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
const activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
if (!activeRunId) process.exit(0);

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
const missionId = process.env.EVOR_MISSION_ID ?? '';

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
    const raw = readFileSync(0, 'utf8');
    const payload = JSON.parse(raw || '{}');
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

// ── Artifact presence check ───────────────────────────────────────────────────
const MIN_ARTIFACT_BYTES = 10;

try {
  if (!existsSync(artifactPath)) {
    process.stdout.write(
      `[EVOR SUBAGENT WARNING] ${agentRole} stopped but artifact not found: ${relPath}\n` +
        `  Expected: ${artifactPath}\n` +
        `  Agent may not have externalized its work. Orchestrator should verify.\n`
    );
    process.exit(0);
  }

  const size = statSync(artifactPath).size;
  if (size < MIN_ARTIFACT_BYTES) {
    process.stdout.write(
      `[EVOR SUBAGENT WARNING] ${agentRole} artifact is trivially small (${size} bytes): ${relPath}\n` +
        `  Expected: ${artifactPath}\n` +
        `  Agent may have written a stub rather than a full deliverable.\n`
    );
  }
} catch (err) {
  // Fail-open: stat errors are non-fatal
  process.stderr.write(`[evor:subagent-stop] artifact check failed (non-fatal): ${err.message}\n`);
}

process.exit(0);
