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

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
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

/**
 * Cheap, bounded workspace classification for brownfield ML detection.
 * Honors the contract IGNORE list; caps entries per directory and depth.
 * Never throws — returns greenfield on any error.
 *
 * @param {string} rootDir  Workspace root to scan (typically dirname(evorRoot))
 * @returns {{ class: "greenfield"|"brownfield"|"possibly-training", counts: {models:number,datasets:number,configs:number,logs:number} }}
 */
function classifyWorkspace(rootDir) {
  const IGNORE      = new Set(['.git', '.evor', 'node_modules', '.venv', 'venv', '__pycache__', 'refs', 'dist', 'build', '.omc', 'site-packages']);
  const MODEL_STRONG = new Set(['.pt', '.pth', '.ckpt', '.safetensors', '.onnx', '.h5']);
  const DATASET_DIRS = new Set(['data', 'datasets', 'dataset']);
  const DATASET_EXTS = new Set(['.csv', '.parquet', '.tfrecord']);
  const CONFIG_DIRS  = new Set(['conf', 'config', 'configs']);
  const LOG_DIRS     = new Set(['wandb', 'mlruns', 'lightning_logs', 'runs', 'tb_logs', 'outputs']);
  const MAX_PER_DIR  = 150;
  const MAX_DEPTH    = 3;
  const RECENT_SECS  = 600;
  const now          = Date.now() / 1000;

  const counts = { models: 0, datasets: 0, configs: 0, logs: 0 };
  let latestMtime = 0;

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i).toLowerCase() : '';
  }

  function mtimeOf(p) {
    try { return statSync(p).mtimeMs / 1000; } catch { return 0; }
  }

  function scanDir(dir, depth, inConfigDir) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    let n = 0;
    let dirHasStrongModel = false;
    const pklPaths = [];

    for (const ent of entries) {
      if (++n > MAX_PER_DIR) break;
      const name  = ent.name;
      const lname = name.toLowerCase();
      if (IGNORE.has(lname)) continue;

      if (ent.isDirectory()) {
        if (DATASET_DIRS.has(lname)) counts.datasets++;
        if (LOG_DIRS.has(lname)) {
          counts.logs++;
          const mt = mtimeOf(join(dir, name));
          if (mt > latestMtime) latestMtime = mt;
        }
        scanDir(join(dir, name), depth + 1, CONFIG_DIRS.has(lname));
      } else if (ent.isFile()) {
        const ext = extOf(name);
        if (MODEL_STRONG.has(ext)) {
          counts.models++;
          dirHasStrongModel = true;
          const mt = mtimeOf(join(dir, name));
          if (mt > latestMtime) latestMtime = mt;
        } else if (ext === '.pkl') {
          pklPaths.push(join(dir, name));
        } else if (DATASET_EXTS.has(ext)) {
          counts.datasets++;
        } else if ((ext === '.yaml' || ext === '.yml') && (inConfigDir || lname === 'params.yaml')) {
          counts.configs++;
        }
      }
    }

    // .pkl counts only when a sibling strong-model file exists in the same dir
    if (pklPaths.length > 0 && dirHasStrongModel) {
      counts.models += pklPaths.length;
      for (const p of pklPaths) {
        const mt = mtimeOf(p);
        if (mt > latestMtime) latestMtime = mt;
      }
    }
  }

  try {
    scanDir(rootDir, 1, false);
  } catch {
    return { class: 'greenfield', counts: { models: 0, datasets: 0, configs: 0, logs: 0 } };
  }

  const isBrownfield = counts.models > 0 || counts.datasets > 0 || counts.configs > 0 || counts.logs > 0;
  if (!isBrownfield) return { class: 'greenfield', counts };

  const isPossiblyTraining = latestMtime > 0 && (now - latestMtime) <= RECENT_SECS;
  return { class: isPossiblyTraining ? 'possibly-training' : 'brownfield', counts };
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
// Also do a cheap workspace classification to nudge users with existing ML repos.
if (!existsSync(activeRunFile)) {
  // Workspace root is the parent of the EVOR state dir (cwd's .evor sibling).
  const workspaceRoot  = dirname(evorRoot);
  const wsClassCache   = join(evorRoot, '.workspace-class');
  let wsClass;

  try {
    const cached = JSON.parse(readFileSync(wsClassCache, 'utf8'));
    if (cached?.class) wsClass = cached;
  } catch { /* cache miss — will scan below */ }

  if (!wsClass) {
    wsClass = classifyWorkspace(workspaceRoot);
    try { writeFileSync(wsClassCache, JSON.stringify(wsClass)); } catch { /* read-only evorRoot — fine, re-scan next session */ }
  }

  let nudge = '';
  const wc = wsClass.class;
  if (wc === 'brownfield' || wc === 'possibly-training') {
    const { models, configs, datasets } = wsClass.counts;
    nudge = `[oh-my-evor] This looks like an existing ML project (${models} checkpoints, ${configs} configs, ${datasets} datasets). Run /oh-my-evor:evor-distill to import it as a starting point, then /oh-my-evor:evor-setup. (Nothing has been changed.)`;
    if (wc === 'possibly-training') {
      nudge += ` A checkpoint/log was modified in the last 10 min — a run may be active; EVOR will not touch it.`;
    }
  }

  const parts = [depWarning, nudge].filter(Boolean);
  process.stdout.write(JSON.stringify({
    env: { EVOR_PLUGIN_ROOT: pluginRoot },
    ...(parts.length ? { message: parts.join('\n\n') } : {}),
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
