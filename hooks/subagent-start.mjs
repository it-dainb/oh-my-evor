#!/usr/bin/env node
/**
 * oh-my-evor SubagentStart hook — per-role injection at spawn time
 *
 * Injects the EVOR LAW + READ-FIRST discipline + per-role protocol addendum
 * into every evor specialist sub-agent the moment it spawns. This is the
 * primary §13 handoff enforcement mechanism: agents receive their protocol
 * BEFORE their first action, stronger than a PostToolUse nudge after the fact.
 *
 * Kill switches (checked FIRST):
 *   DISABLE_EVOR=1                  → exit 0 immediately
 *   EVOR_SKIP_HOOKS=subagent-start  → exit 0 immediately
 *
 * Payload: STDIN JSON with field `agent_type` (e.g. "oh-my-evor:evor-forge").
 * Strips "oh-my-evor:evor-" prefix → bare role; emits common header + addendum.
 * Unknown role → common header only (fail-open).
 *
 * Output format:
 *   { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "…" } }
 *
 * §19: NO `python -m evor` in any agent-facing string. Timeless voice.
 */

import { readFileSync } from 'fs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('subagent-start')) process.exit(0);

// ── Common header — injected to every evor agent ──────────────────────────────
const COMMON_HEADER = `\
[EVOR LAW] To change or read evor state, call the evor_* MCP tools. Do not author .evor files by hand.
[READ-FIRST] Before acting, call evor_read_artifact for the upstream artifact you depend on. If it returns {error:"not found"}, that step has not produced output — stop and surface the gap; do not fabricate.
[TOOLS] Full catalog + schemas: the evor-mcp skill. Hot-path: evor_record_node, evor_record_eval, evor_state_read, evor_tree_read. Signals: evor_signal_emit / evor_signal_query.`;

// ── Per-role addenda (bare role → text) ───────────────────────────────────────
const ROLE_ADDENDA = {
  'sage':
    '1. evor_read_artifact(agent="sage-junior", kind=*) for every junior angle. ' +
    '2. ToolSearch to discover research MCPs (semantic-scholar, arxiv, hf-mcp). ' +
    '3. WaitForMcpServers before fan-out. ' +
    '4. evor_cite each citation. ' +
    '5. evor_write_artifact(agent="sage"). ' +
    '6. evor_wiki_add for durable lessons.',

  'sage-junior':
    'Research ONE angle. evor_write_artifact(agent="sage-junior", kind=<angle-slug>). ' +
    'evor_cite every citation. Do not aggregate — that is Sage\'s job.',

  'mutagen':
    '1. FIRST evor_read_artifact(agent="sage") — ground proposals in citations, not memory. ' +
    '2. evor_wiki_query + evor_tree_read(frontier). ' +
    '3. evor_write_artifact(agent="mutagen"). ' +
    'You do NOT research; emit investigation_queries[] for Sage if new evidence is needed. ' +
    '[GOVERNOR] research/search tools are blocked for you.',

  'selector':
    '1. FIRST evor_read_artifact(agent="mutagen") — do not work from memory. ' +
    '2. evor_tree_read + evor_state_read(strategy). ' +
    '3. evor_write_artifact(agent="selector"). ' +
    'Never self-approve; reject all if proposals are weak.',

  'probe':
    '1. evor_run_status for telemetry. ' +
    '2. Analyze anomalies (OOM, convergence failure, drift). ' +
    '3. evor_write_artifact(agent="probe"). ' +
    '4. evor_signal_emit for each anomaly.',

  'forge':
    '1. FIRST evor_read_artifact(agent="selector") + evor_read_artifact(agent="mutagen") for the winning proposal. ' +
    '2. Team sequence: forge-junior writes code → lsp_diagnostics pre-flight → PARALLEL {forge-critic, forge-analyst, forge-architect} → all pass → evor_record_node → evor_run_start. ' +
    '3. Watch the launched run with the native Monitor tool. ' +
    '4. evor_write_artifact(agent="forge"). ' +
    '[GATE] Do not call evor_run_start until all three reviewers pass; any rejection routes back to forge-junior.',

  'forge-junior':
    'Write candidate code in .evor/worktrees/<node_id>/. ' +
    'Before reporting done, run lsp_diagnostics on the candidate file to catch type/syntax errors that would waste a run; fix diagnostics-level errors before handing back.',

  'forge-architect':
    'Review architectural soundness: design coherence, interface correctness, fidelity to the cited technique. ' +
    'evor_write_artifact(agent="forge-architect"). Pass or reject with specific reasons.',

  'forge-critic':
    'Review correctness/edge-cases/failure-modes: off-by-one, wrong tensor shapes, instability. ' +
    'evor_write_artifact(agent="forge-critic"). Cite exact lines/patterns.',

  'forge-analyst':
    'Analyze compute cost, memory footprint, resource usage: param delta, activation memory, OOM risk. ' +
    'evor_write_artifact(agent="forge-analyst").',

  'acquirer':
    'Acquire data/model artifacts per spec with full provenance: evor_write_artifact(agent="acquirer", kind=<source-slug>). ' +
    'Flag license ambiguity or consent gaps: evor_signal_emit(kind="license-gate", severity="high") before proceeding.',
};

// ── Parse STDIN payload ───────────────────────────────────────────────────────
let agentType = '';
try {
  const raw = readFileSync(0, 'utf8');
  const payload = JSON.parse(raw || '{}');
  agentType = String(payload?.agent_type ?? '');
} catch {
  // fail-open: malformed STDIN → emit common header only
}

// Strip plugin prefix to get bare role (e.g. "oh-my-evor:evor-forge" → "forge")
const bareRole = agentType
  .replace(/^oh-my-evor:evor-/, '')
  .replace(/^evor-/, '');

// Only fire for evor agents (matcher ensures this but double-check)
if (!agentType.startsWith('oh-my-evor:evor-') && bareRole === agentType) {
  process.exit(0);
}

const addendum = ROLE_ADDENDA[bareRole] ?? null;
const additionalContext = addendum
  ? `${COMMON_HEADER}\n[ROLE: ${bareRole.toUpperCase()}] ${addendum}`
  : COMMON_HEADER;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SubagentStart',
      additionalContext,
    },
  }) + '\n'
);

process.exit(0);
