#!/usr/bin/env node
/**
 * oh-my-evor PostToolUseFailure hook — corrective diagnostics for evor tool failures
 *
 * Fires when an evor_* MCP tool call fails. Emits per-tool corrective guidance
 * and, on evor_run_start failure, writes an infrastructure-failure signal to the
 * signals-inbox so the orchestrator is alerted.
 *
 * Kill switches (checked FIRST):
 *   DISABLE_EVOR=1                          → exit 0 immediately
 *   EVOR_SKIP_HOOKS=post-tool-use-failure   → exit 0 immediately
 *
 * Active-run gated: inert when EVOR_ACTIVE_RUN_ID is unset.
 * Fail-open: any error → exit 0. Never crash the session.
 *
 * §17D: signal write uses direct file append (command hook), NOT mcp_tool hook.
 * §19: NO `python -m evor` in any agent-facing string.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { resolveActiveRun, resolveEvorRoot } from './lib/active-run.mjs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('post-tool-use-failure')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
const { runId: activeRunId, missionId: activeMissionId } = resolveActiveRun();
if (!activeRunId) process.exit(0);

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
// 1.3: the evor root comes from the shared resolver, never re-derived here.
// Eleven hooks each computed `EVOR_ROOT ?? join(CLAUDE_PLUGIN_ROOT ?? cwd, '.evor')`
// for themselves, so fixing Q-01 in `resolveEvorRoot` alone would have reached
// none of them — the plugin's own `.evor/` would still have won in every one.
const evorRoot = resolveEvorRoot();

// env -> active-run.json is exactly what resolveActiveRun() does; the runs/ scan
// below is the extra step it does not cover.
let missionId = activeMissionId;
if (!missionId) {
  try {
    for (const entry of readdirSync(join(evorRoot, 'runs'), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(evorRoot, 'runs', entry.name, activeRunId))) {
        missionId = entry.name;
        break;
      }
    }
  } catch { /* runs/ dir absent */ }
}

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, activeRunId)
  : join(evorRoot, 'runs', activeRunId);

// ── Parse STDIN payload ───────────────────────────────────────────────────────
let input;
try {
  const raw = readFileSync(0, 'utf8');
  input = JSON.parse(raw || '{}');
} catch {
  process.exit(0); // fail-open
}

// ── Tool name + error extraction ──────────────────────────────────────────────
const toolName = String(input?.tool_name ?? '');
const toolInput = input?.tool_input ?? {};
const errorText = String(
  input?.tool_response?.error ??
  input?.tool_response?.message ??
  input?.error_message ??
  input?.error ??
  'unknown error'
).slice(0, 300);

// ── Per-tool corrective guidance ──────────────────────────────────────────────
// Strip the mcp__plugin_oh-my-evor_evor__ prefix for the switch
const bareToolName = toolName.replace(/^mcp__plugin_oh-my-evor_evor__/, '');

const GUIDANCE = {
  run_start:
    'evor_run_start failed (infrastructure failure). Check that the run directory exists ' +
    'and that the worktree path is accessible. ' +
    'Verify the node was recorded first with evor_record_node. ' +
    'If the error is transient, retry evor_run_start; on repeated failure, call evor_signal_emit ' +
    'with kind="infrastructure-failure" to record the blocker.',

  run_status:
    'evor_run_status failed — the job may not have been started yet, or the job_id is stale. ' +
    'Confirm the job_id from the evor_run_start response. ' +
    'If the job process crashed, call evor_signal_emit with kind="runtime-failure".',

  record_node:
    'evor_record_node failed — the candidate code or patch may be missing from the worktree. ' +
    'Verify that forge-junior completed its code, then retry. ' +
    'Do not call evor_run_start until evor_record_node succeeds.',

  record_eval:
    'evor_record_eval failed. Confirm results.json exists in the node directory. ' +
    'If the run never produced results (OOM/crash), call evor_signal_emit with the failure kind ' +
    'rather than forcing an empty eval.',

  integrity_check:
    'evor_integrity_check failed to execute (not a verdict of "failed"). ' +
    'This is an infrastructure error — check that the node and evaluation files are accessible.',

  write_artifact:
    'evor_write_artifact failed — payload may not match the agent-kind schema, ' +
    'or the run directory is not writable. Validate your payload structure and retry.',

  read_artifact:
    'evor_read_artifact returned an error. If error is "not found", the upstream agent ' +
    'has not produced this artifact yet — do not fabricate; surface the dependency gap.',

  init_run:
    'evor_init_run failed. Check mission-state.json for existing data and that goal fields are complete. ' +
    'Use evor_validate to diagnose.',

  validate:
    'evor_validate returned errors. Read the validation report and resolve each issue before proceeding.',

  state_write:
    'evor_state_write failed. The state file may be locked or the directory inaccessible. ' +
    'Check evor_state_read first to confirm current state before retrying.',

  wiki_add:
    'evor_wiki_add failed. The lesson will not be persisted. ' +
    'Retry with a shorter, well-formed entry.',
};

const guidance = GUIDANCE[bareToolName] ??
  `evor tool "${bareToolName}" failed: ${errorText}. ` +
  'Check the tool inputs and run directory, then retry or call evor_signal_emit to record the blocker.';

// ── Deterministic signal for run_start failure (§14 / §17D) ──────────────────
// Write directly to signals-inbox (command hook path — no mcp_tool with $ENV).
if (bareToolName === 'run_start') {
  try {
    const nodeId = String(toolInput?.node_id ?? toolInput?.run_id ?? 'unknown');
    const kind = 'infrastructure-failure';
    const desc = `evor_run_start failed for node ${nodeId}: ${errorText.slice(0, 200)}`;

    // Dedup signature (mirrors post-tool-use.mjs signalSignature)
    const sig = kind + ':' + createHash('sha256').update(desc, 'utf8').digest('hex').slice(0, 16);

    const sigEntry = {
      kind,
      signature: sig,
      shapes: ['failure'],
      axes: ['compute'],
      severity: 'high',
      evidence: { description: desc },
      source: `hook:post-tool-use-failure:${bareToolName}`,
      created_at: new Date().toISOString(),
    };

    if (existsSync(runDir) || (() => { try { mkdirSync(runDir, { recursive: true }); return true; } catch { return false; } })()) {
      appendFileSync(
        join(runDir, 'signals-inbox.jsonl'),
        JSON.stringify(sigEntry) + '\n',
        'utf8'
      );
    }
  } catch {
    // Fail-open — signal write is best-effort
  }
}

// ── Emit corrective guidance ──────────────────────────────────────────────────
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: `[EVOR TOOL FAILURE] ${guidance}`,
    },
  }) + '\n'
);

process.exit(0);
