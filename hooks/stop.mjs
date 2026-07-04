#!/usr/bin/env node
/**
 * oh-my-evor Stop hook — full implementation (M7a) — Continuation Guard
 *
 * Blocks Claude session completion when an active evor run has nodes that
 * were registered in pending_node_ids but not yet fully recorded in the
 * tree DB (i.e., evor_record_node was not called for them).
 *
 * Behaviour matrix:
 *   EVOR_ACTIVE_RUN_ID unset      → exit 0  (guard inert; non-evor session)
 *   run-state.json missing        → exit 0  (run not yet initialised; safe)
 *   run-state.json corrupt        → exit 0  (fail-open; log to stderr)
 *   pending_node_ids empty / null → exit 0  (run is consistent; allow stop)
 *   pending_node_ids non-empty    → exit 2  (block with system-reminder)
 *
 * Exit code 2 causes Claude Code to surface the stdout message as a
 * system-reminder and prevent the session from stopping, mirroring the
 * _no_tool_incomplete_plan_prompt() pattern from ml-intern agent_loop.py.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
if (!activeRunId) process.exit(0); // Guard inert when no active run

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
const missionId = process.env.EVOR_MISSION_ID ?? '';

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, activeRunId)
  : join(evorRoot, 'runs', activeRunId);

const runStatePath = join(runDir, 'run-state.json');

// Run not initialised on disk yet — nothing pending
if (!existsSync(runStatePath)) {
  process.exit(0);
}

let runState;
try {
  runState = JSON.parse(readFileSync(runStatePath, 'utf8'));
} catch (err) {
  // Corrupt run-state.json — fail-open; log and allow stop
  process.stderr.write(`[evor:stop] corrupt run-state.json: ${err.message}\n`);
  process.exit(0);
}

const pendingIds = Array.isArray(runState?.pending_node_ids) ? runState.pending_node_ids : [];

if (pendingIds.length === 0) {
  process.exit(0); // Run is consistent — allow stop
}

// Pending nodes exist — block completion and surface a system-reminder
const tick = runState?.tick_count ?? '?';
process.stdout.write(
  `[EVOR CONTINUATION GUARD] Tick ${tick} started but tree DB not updated.\n` +
    `Call evor_record_node for nodes: ${pendingIds.join(', ')}.\n` +
    `Do not finish until the tree is updated.\n`
);
process.exit(2);
