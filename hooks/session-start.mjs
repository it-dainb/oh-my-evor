#!/usr/bin/env node
/**
 * oh-my-evor SessionStart hook — full implementation (M7a)
 *
 * Reads .evor/active-run.json; emits JSON to stdout so Claude Code can set
 * session env vars (EVOR_ACTIVE_RUN_ID, EVOR_MISSION_ID, EVOR_RUN_DIR) for
 * subsequent hooks in the same session.
 *
 * Graceful degradation:
 *   - Missing active-run.json  → exit 0 (no active run; normal state)
 *   - Corrupt active-run.json  → log to stderr, clear env, exit 0
 *   - Missing run_id field      → log to stderr, clear env, exit 0
 *   - Python wiki unavailable   → skip priming, still emit env JSON
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
const activeRunFile = join(evorRoot, 'active-run.json');

/** Emit clear-env JSON and exit 0 gracefully. */
function clearEnvAndExit(reason) {
  if (reason) process.stderr.write(`[evor:session-start] ${reason}\n`);
  process.stdout.write(
    JSON.stringify({
      env: { EVOR_ACTIVE_RUN_ID: '', EVOR_MISSION_ID: '', EVOR_RUN_DIR: '' },
    }) + '\n'
  );
  process.exit(0);
}

// No active run — normal state when no mission is in flight
if (!existsSync(activeRunFile)) {
  process.exit(0);
}

let activeRun;
try {
  activeRun = JSON.parse(readFileSync(activeRunFile, 'utf8'));
} catch (err) {
  clearEnvAndExit(`corrupt active-run.json: ${err.message}`);
}

const runId = activeRun?.run_id ?? '';
const missionId = activeRun?.mission_id ?? '';

if (!runId) {
  clearEnvAndExit('active-run.json missing run_id — clearing session env');
}

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, runId)
  : join(evorRoot, 'runs', runId);

const output = {
  env: {
    EVOR_ACTIVE_RUN_ID: runId,
    EVOR_MISSION_ID: missionId,
    EVOR_RUN_DIR: runDir,
  },
  message: `[EVOR CONTEXT] Active run: ${runId}${missionId ? ` (mission: ${missionId})` : ''}`,
};

// Prime session with recent wiki lessons (graceful — skip if evor.wiki not installed yet)
if (missionId) {
  const wiki = spawnSync(
    process.env.EVOR_PYTHON ?? 'python3',
    ['-m', 'evor.wiki', 'context', '--mission-id', missionId, '--limit', '5', '--evor-root', evorRoot],
    { encoding: 'utf8', timeout: 4000 }
  );
  if (wiki.status === 0 && wiki.stdout?.trim()) {
    output.message += `\n\nRecent wiki lessons:\n${wiki.stdout.trim()}`;
  }
}

process.stdout.write(JSON.stringify(output) + '\n');
process.exit(0);
