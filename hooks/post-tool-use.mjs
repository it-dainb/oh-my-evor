#!/usr/bin/env node
/**
 * oh-my-evor PostToolUse hook — full implementation (M7a) + Phase-2 kill switches
 *
 * Kill switches (checked FIRST, before any other logic):
 *   DISABLE_EVOR=1             → exit 0 immediately
 *   EVOR_SKIP_HOOKS=post-tool-use → exit 0 immediately
 *
 * Validates that recording tool calls left the expected artifacts on disk.
 * Emits [EVOR WARNING] lines to stdout (non-blocking, exit 0) when files are
 * missing or empty so the model is informed without halting the session.
 *
 * evor_record_eval:
 *   - Checks nodes/<node_id>/results.json exists
 *   - Checks nodes/<node_id>/telemetry.jsonl exists AND has > 0 bytes
 *     NOTE: TelemetryCallback writes telemetry.jsonl directly during training;
 *     Forge calls evor_telemetry_ingest explicitly after training completes.
 *     This hook does NOT re-ingest from stdout (R11: stdout-scan path removed).
 *
 * evor_record_node:
 *   - Checks tree.json exists and was written within the last 30 seconds.
 *
 * Guard is inert (immediate exit 0) when EVOR_ACTIVE_RUN_ID is unset.
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('post-tool-use')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
const activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
if (!activeRunId) process.exit(0); // No active evor run — nothing to validate

let input;
try {
  input = JSON.parse(process.env.CLAUDE_HOOK_INPUT ?? '{}');
} catch {
  // Malformed hook input — do not block; exit safely
  process.exit(0);
}

const toolName = input?.tool_name ?? '';
const toolInput = input?.tool_input ?? {};

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
const missionId = process.env.EVOR_MISSION_ID ?? '';

/** Derive the run's directory from a run ID. */
function runDir(runId) {
  return missionId
    ? join(evorRoot, 'runs', missionId, runId)
    : join(evorRoot, 'runs', runId);
}

const warnings = [];

// ── evor_record_eval — verify results.json and telemetry.jsonl ───────────────
if (toolName === 'evor_record_eval') {
  const runId = toolInput.run_id ?? activeRunId;
  const nodeId = toolInput.node_id ?? '';

  if (nodeId) {
    const nodeDir = join(runDir(runId), 'nodes', nodeId);
    const resultsPath = join(nodeDir, 'results.json');
    const telemetryPath = join(nodeDir, 'telemetry.jsonl');

    if (!existsSync(resultsPath)) {
      warnings.push(
        `results.json missing for node ${nodeId} — evor_record_eval may not have written it`
      );
    }

    if (!existsSync(telemetryPath) || statSync(telemetryPath).size === 0) {
      warnings.push(
        `telemetry.jsonl missing or empty for node ${nodeId} — ` +
          'ensure Forge called evor_telemetry_ingest after training completed'
      );
    }
  }
}

// ── evor_record_node — verify tree.json was recently written ─────────────────
if (toolName === 'evor_record_node') {
  const runId = toolInput.run_id ?? activeRunId;
  const treePath = join(runDir(runId), 'tree.json');
  const RECENT_MS = 30_000; // 30 seconds

  if (!existsSync(treePath)) {
    warnings.push(
      `tree.json not found for run ${runId} — evor_record_node may not have written it`
    );
  } else {
    const age = Date.now() - statSync(treePath).mtimeMs;
    if (age > RECENT_MS) {
      warnings.push(
        `tree.json for run ${runId} was last written ${Math.round(age / 1000)}s ago ` +
          '(expected within 30s) — evor_record_node may not have updated the tree'
      );
    }
  }
}

if (warnings.length > 0) {
  process.stdout.write(warnings.map((w) => `[EVOR WARNING] ${w}`).join('\n') + '\n');
}

process.exit(0);
