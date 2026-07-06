#!/usr/bin/env node
/**
 * oh-my-evor SessionStart hook — Phase-2 kill switches + active-run env setup
 *
 * Kill switches (checked FIRST, before any other logic):
 *   DISABLE_EVOR=1                 → exit 0 immediately
 *   EVOR_SKIP_HOOKS=session-start  → exit 0 immediately
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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * Build an <evor-restore> summary from on-disk state files.
 * Returns null if there is no meaningful state yet.
 * Any individual read failure is swallowed — always safe to call.
 *
 * @param {string} rDir      Absolute path to .evor/runs/<m>/<r>/
 * @param {string} rId       run_id
 * @param {string} mId       mission_id (may be '')
 * @returns {string|null}
 */
function buildEvorRestore(rDir, rId, mId) {
  function safeRead(p) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
  }
  const missionState = safeRead(join(rDir, 'mission-state.json'));
  const tickState    = safeRead(join(rDir, 'tick-state.json'));
  const runState     = safeRead(join(rDir, 'run-state.json'));

  const objective   = (missionState?.objective ?? missionState?.goal ?? '').slice(0, 100);
  const currentTick = tickState?.tick ?? runState?.tick_count ?? 0;
  const currentStep = tickState?.current_step ?? 0;
  const bestScore   = runState?.best_score ?? missionState?.best_score ?? null;
  const bestNodeId  = runState?.best_node_id ?? missionState?.best_node_id ?? null;

  if (!objective && currentTick === 0 && bestScore === null) return null;

  const scoreStr = bestScore !== null ? String(bestScore).slice(0, 8) : 'unknown';
  const nodeStr  = bestNodeId ? bestNodeId.slice(0, 16) : 'none';
  const runPath  = mId ? `runs/${mId}/${rId}` : `runs/${rId}`;

  const lines = [
    `Run: ${rId.slice(0, 20)}${mId ? ` | Mission: ${mId.slice(0, 20)}` : ''}`,
  ];
  if (objective) lines.push(`Objective: ${objective}`);
  lines.push(`Tick ${currentTick} step ${currentStep} | Best: ${scoreStr} (${nodeStr})`);
  lines.push(`Resume from .evor/${runPath}/; prioritise the user's newest request.`);

  return `<evor-restore>\n${lines.join('\n')}\n</evor-restore>`;
}

/**
 * One-time check that the Python harness + its deps are importable. After a
 * bare `/plugin install` the plugin files land but pip deps (pydantic, pyyaml)
 * and `evor` on the path are NOT guaranteed — the MCP tools that shell out to
 * Python would fail cryptically. This surfaces a clear one-line fix instead.
 *
 * Non-intrusive: never installs anything, never throws, caches success so a
 * healthy install spawns Python at most once. Returns a warning string, or ''.
 *
 * @param {string} pRoot  CLAUDE_PLUGIN_ROOT
 * @param {string} eRoot  resolved .evor root (writable at runtime)
 * @returns {string}
 */
function checkHarnessDeps(pRoot, eRoot) {
  try {
    const harness = process.env.EVOR_HARNESS_DIR ?? join(pRoot, 'harness');
    if (!existsSync(harness)) return '';            // not our layout — say nothing
    const sentinel = join(eRoot, '.deps-ok');
    if (existsSync(sentinel)) return '';            // already verified this install
    const py = process.env.EVOR_PYTHON ?? 'python3';
    const env = {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH ? `${harness}${delimiter}${process.env.PYTHONPATH}` : harness,
    };
    // evor.contracts imports pydantic; also probe pyyaml — covers path + both deps.
    const res = spawnSync(py, ['-c', 'import evor.contracts, yaml'], { encoding: 'utf8', timeout: 3000, env });
    if (res.status === 0) {
      try { mkdirSync(dirname(sentinel), { recursive: true }); writeFileSync(sentinel, new Date().toISOString()); } catch { /* read-only .evor — fine, we just re-check next time */ }
      return '';
    }
    const missing = (res.stderr ?? '').split('\n').find(l => l.includes('ModuleNotFoundError')) ?? '';
    return [
      `[oh-my-evor] Python harness is not importable${missing ? ` (${missing.trim()})` : ''} — the MCP tools that call Python will fail until deps are installed once:`,
      `  pip install -e "${harness}"      # or run the plugin's ./install.sh`,
      `(Python: ${py}. Override with EVOR_PYTHON / EVOR_HARNESS_DIR.)`,
    ].join('\n');
  } catch {
    return '';                                       // never break session start
  }
}

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('session-start')) process.exit(0);

// ── Active run discovery ──────────────────────────────────────────────────────
// This hook lives at <pluginRoot>/hooks/session-start.mjs, so the plugin root is
// two levels up from the script itself — a deterministic anchor that never depends
// on the current working directory. Prefer Claude Code's own CLAUDE_PLUGIN_ROOT
// when present, else derive it from our own location.
const pluginRoot =
  process.env.CLAUDE_PLUGIN_ROOT
  ?? dirname(dirname(fileURLToPath(import.meta.url)));
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
const activeRunFile = join(evorRoot, 'active-run.json');

// One-time harness/deps health check (surfaces a clear fix on incomplete installs).
const depWarning = checkHarnessDeps(pluginRoot, evorRoot);

/** Emit clear-env JSON and exit 0 gracefully. */
function clearEnvAndExit(reason) {
  if (reason) process.stderr.write(`[evor:session-start] ${reason}\n`);
  process.stdout.write(
    JSON.stringify({
      env: { EVOR_PLUGIN_ROOT: pluginRoot, EVOR_ACTIVE_RUN_ID: '', EVOR_MISSION_ID: '', EVOR_RUN_DIR: '' },
      ...(depWarning ? { message: depWarning } : {}),
    }) + '\n'
  );
  process.exit(0);
}

// No active run — normal state when no mission is in flight. Still export the
// plugin root so slash commands can resolve their SKILL.md without searching.
if (!existsSync(activeRunFile)) {
  process.stdout.write(JSON.stringify({
    env: { EVOR_PLUGIN_ROOT: pluginRoot },
    ...(depWarning ? { message: depWarning } : {}),
  }) + '\n');
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
    EVOR_PLUGIN_ROOT: pluginRoot,
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

// Inject <evor-restore> block so a fresh/compacted session re-hydrates from disk.
// Advisory: rebuilds objective + tick/step + best-so-far for context continuity.
const restoreBlock = buildEvorRestore(runDir, runId, missionId);
if (restoreBlock) {
  output.message += `\n\n${restoreBlock}`;
}

// Surface any harness/deps warning first so an incomplete install is obvious.
if (depWarning) output.message = `${depWarning}\n\n${output.message}`;

process.stdout.write(JSON.stringify(output) + '\n');
process.exit(0);
