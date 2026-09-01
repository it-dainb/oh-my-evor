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
import { resolveEvorRoot } from './lib/active-run.mjs';

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
  const missionName = (missionState?.name ?? missionState?.title ?? '').slice(0, 60);
  const currentTick = tickState?.tick ?? runState?.tick_count ?? 0;
  const currentStep = tickState?.current_step ?? 0;
  const bestScore   = runState?.best_score ?? missionState?.best_score ?? null;
  // Prefer human-readable node name over raw node id
  const bestNodeName = (runState?.best_node_name ?? runState?.name ?? null);

  if (!objective && currentTick === 0 && bestScore === null) return null;

  const scoreStr = bestScore !== null ? String(bestScore).slice(0, 8) : 'unknown';
  const nodeStr  = bestNodeName ? String(bestNodeName).slice(0, 40) : null;

  // Use mission name/objective as the header — never raw run_id or mission_id
  const header = missionName || (objective ? objective.slice(0, 60) : 'Active mission');

  const lines = [`Mission: ${header}`];
  if (objective && objective !== header) lines.push(`Objective: ${objective}`);
  const bestStr = scoreStr + (nodeStr ? ` (${nodeStr})` : '');
  lines.push(`Tick ${currentTick} step ${currentStep} | Best: ${bestStr}`);
  lines.push(`Spawn evor-tick to resume the loop; prioritise the user's newest request.`);

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
    return `[oh-my-evor] Python harness dependencies are not installed — run the plugin install script to set up dependencies before using evor tools.`;
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
// 1.3: the evor root comes from the shared resolver, never re-derived here.
// Eleven hooks each computed `EVOR_ROOT ?? join(CLAUDE_PLUGIN_ROOT ?? cwd, '.evor')`
// for themselves, so fixing Q-01 in `resolveEvorRoot` alone would have reached
// none of them — the plugin's own `.evor/` would still have won in every one.
const evorRoot = resolveEvorRoot();
const activeRunFile = join(evorRoot, 'active-run.json');

// Bundled-harness env — exported so `python -m evor …` anywhere in this session
// resolves the plugin's harness WITHOUT any pip install (deps still come from the
// active Python). Skills also set PYTHONPATH per-invocation as a belt-and-suspenders.
const harnessDir = join(pluginRoot, 'harness');
const evorEnv = existsSync(harnessDir)
  ? {
      EVOR_PLUGIN_ROOT: pluginRoot,
      EVOR_HARNESS_DIR: harnessDir,
      PYTHONPATH: process.env.PYTHONPATH ? `${harnessDir}${delimiter}${process.env.PYTHONPATH}` : harnessDir,
    }
  : { EVOR_PLUGIN_ROOT: pluginRoot };

// One-time harness/deps health check (surfaces a clear fix on incomplete installs).
const depWarning = checkHarnessDeps(pluginRoot, evorRoot);

/** Emit clear-env JSON and exit 0 gracefully. */
function clearEnvAndExit(reason) {
  if (reason) process.stderr.write(`[evor:session-start] ${reason}\n`);
  process.stdout.write(
    JSON.stringify({
      env: { ...evorEnv, EVOR_ACTIVE_RUN_ID: '', EVOR_MISSION_ID: '', EVOR_RUN_DIR: '' },
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
    env: evorEnv,
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

// ── §0.7: the `paused → prior` recovery edge ─────────────────────────────────
// session-end writes `status: "paused"` when a session ends with an active run.
// Nothing wrote it back. `stop.mjs` exits 0 on `paused`, so a single session
// ending disabled the drift guard permanently — the mission stayed technically
// alive and completely ungoverned. The state machine had an edge in and no edge
// out, which is why this is a live bug rather than a redesign item.
//
// Restored only when THIS pair of hooks made the transition (`paused_by ===
// 'session-end-hook'`) and only to the state recorded in `paused_from`. An
// operator pause is a decision; a hook must not reverse it. A pause written
// before `paused_from` existed carries no origin, so it is left alone rather
// than guessed at.
function resumeIfHookPaused(dir) {
  try {
    const msPath = join(dir, 'mission-state.json');
    if (!existsSync(msPath)) return;
    const ms = JSON.parse(readFileSync(msPath, 'utf8'));
    if (String(ms?.status ?? '') !== 'paused') return;
    if (ms?.paused_by !== 'session-end-hook') return;
    const from = String(ms?.paused_from ?? '');
    if (!['locked', 'running'].includes(from)) return;
    const updated = {
      ...ms,
      status: from,
      resumed_at: new Date().toISOString(),
      resumed_by: 'session-start-hook',
      resumed_from_pause_at: ms?.paused_at ?? null,
    };
    delete updated.paused_from;
    writeFileSync(msPath, JSON.stringify(updated, null, 2), 'utf8');
    process.stderr.write(`[EVOR] mission resumed: paused -> ${from}\n`);
  } catch (err) {
    // Fail-open — a session must start even if the edge cannot be drawn.
    try { process.stderr.write(`[EVOR] session-start resume failed: ${err}\n`); } catch { /* stderr gone */ }
  }
}

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, runId)
  : join(evorRoot, 'runs', runId);

const output = {
  env: {
    ...evorEnv,
    EVOR_ACTIVE_RUN_ID: runId,
    EVOR_MISSION_ID: missionId,
    EVOR_RUN_DIR: runDir,
  },
  message: `[EVOR CONTEXT] Active mission in progress — spawn evor-tick to resume the loop.`,
};

// Prime session with recent wiki lessons (graceful — skip if evor.wiki not installed yet)
if (missionId) {
  const wiki = spawnSync(
    process.env.EVOR_PYTHON ?? 'python3',
    ['-m', 'evor.wiki', 'context', '--mission-id', missionId, '--limit', '5', '--evor-root', evorRoot],
    { encoding: 'utf8', timeout: 4000 }
  );
  if (wiki.status === 0 && wiki.stdout?.trim()) {
    // Budgeted, like pre-compact.mjs's RESTORE_LIMIT. `--limit 5` bounds the
    // NUMBER of lessons, never their size, so five long lessons injected
    // arbitrarily much — and a 100-200 tick mission accumulates lessons, so the
    // injection grew with mission age. That is the same compounding shape as the
    // tree-read leak, arriving through a different door.
    //
    // Truncation is announced rather than silent: a quietly cut list is
    // indistinguishable from "there were no more lessons", which hides the budget
    // from the reader (P5, fail loud).
    const WIKI_INJECT_LIMIT = 2000;
    const body = wiki.stdout.trim();
    const injected =
      body.length > WIKI_INJECT_LIMIT
        ? `${body.slice(0, WIKI_INJECT_LIMIT)}\n… [truncated at ${WIKI_INJECT_LIMIT} chars — call evor_wiki_query for the full set]`
        : body;
    output.message += `\n\nRecent wiki lessons:\n${injected}`;
  }
}

// Inject <evor-restore> block so a fresh session re-hydrates from disk.
// (PostCompact handles the re-inject after context compaction — this covers new sessions only.)
resumeIfHookPaused(runDir);

const restoreBlock = buildEvorRestore(runDir, runId, missionId);
if (restoreBlock) {
  output.message += `\n\n${restoreBlock}`;
}

// ── Compact Law primer (≤4 lines) — every session with an active run ─────────
// Keeps the core contract visible without repeating the full SubagentStart block.
// Main-facing only. This used to restate subagent-start's COMMON_HEADER in
// different words — including a DIFFERENT hot-path tool list, so an agent's
// guidance depended on which hook fired. Worse, it recommended evor_state_read,
// which §3b.0 now denies to main: the primer was pointing the orchestrator at
// forbidden tools, costing a denial round-trip every session and teaching the
// behaviour the boundary exists to remove.
//
// The subagent protocol (READ-FIRST, artifact reads) is correct for subagents and
// stays in subagent-start.mjs, which is the one place it belongs. Main gets its
// own, genuinely different, job.
const LAW_PRIMER =
  `[EVOR LAW] Use evor_* MCP tools to change evor state — never write .evor/ directly.\n` +
  `[ROLE] You orchestrate the mission: spawn evor-tick for each tick, record the outcome, ` +
  `decide continue/stop. The tick's detail — artifacts, tree, run state — lives inside the ` +
  `boundary and returns to you as a status line plus pointers.\n` +
  `[WAIT] A tick is not done when you have spawned it — it is done when it reports an ` +
  `outcome. If you resume or spawn anything in the background, block on TaskOutput or ` +
  `Monitor until it returns. Ending your turn while a tick is in flight ends the mission.\n` +
  `[TOOLS] Hot-path: evor-tick spawn, evor_check_stop, evor_check_plateau, evor_write_handoff.`;
output.message += `\n\n${LAW_PRIMER}`;

// ── Next-action hint: resume at the right step ────────────────────────────────
try {
  const tsPath = join(runDir, 'tick-state.json');
  const rsPath = join(runDir, 'run-state.json');

  const ts = existsSync(tsPath) ? JSON.parse(readFileSync(tsPath, 'utf8')) : {};
  const rs = existsSync(rsPath) ? JSON.parse(readFileSync(rsPath, 'utf8')) : {};

  const tick = ts?.tick ?? rs?.tick_count ?? 0;
  const step = ts?.current_step ?? 0;

  // Main's next action is always the same shape, because main only ever does one
  // thing: run the next tick through the boundary. Naming the step tells it where
  // the tick resumes; it does NOT license main to read the artifacts behind that
  // step — those reads are denied for main and belong inside evor-tick.
  const nextTick = step >= 9 || step === 0 ? tick + (step >= 9 ? 1 : 0) : tick;
  const resume = step > 0 && step < 9 ? ` (resumes at step ${step})` : '';
  const nextAction =
    `Tick ${nextTick}${resume}: spawn evor-tick. When it returns, record the outcome, ` +
    `then evor_check_stop / evor_check_plateau to decide continue or stop.`;

  if (nextAction) {
    output.message += `\n\n[NEXT] ${nextAction}`;
  }
} catch { /* next-action hint is advisory — never block session start */ }

// ── watchPaths: register active job's status.json for FileChanged watcher ─────
// §17D: FileChanged matcher is a literal watch-list. We register the path here
// so the job-status-watcher.mjs hook fires when the job completes/fails.
try {
  // Find the active job's status.json (check common job directories)
  const watchPaths = [];

  // Look in jobs/ directory for a running job's status.json
  const jobsDir = join(runDir, 'jobs');
  if (existsSync(jobsDir)) {
    const jobDirs = readdirSync(jobsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(jobsDir, e.name, 'status.json'))
      .filter(p => existsSync(p));
    watchPaths.push(...jobDirs);
  }

  // active-run.json may have a job_id; resolve status.json via the run dir (already known)
  try {
    const arData = JSON.parse(readFileSync(join(evorRoot, 'active-run.json'), 'utf8'));
    if (arData?.job_id) {
      const statusPath = join(runDir, 'jobs', String(arData.job_id), 'status.json');
      if (!watchPaths.includes(statusPath)) watchPaths.push(statusPath);
    }
  } catch { /* no active-run.json job info — fine */ }

  if (watchPaths.length > 0) {
    output.watchPaths = watchPaths;
  }
} catch { /* watchPaths registration is advisory */ }

// Surface any harness/deps warning first so an incomplete install is obvious.
const prefixWarnings = [depWarning].filter(Boolean).join('\n\n');
if (prefixWarnings) output.message = `${prefixWarnings}\n\n${output.message}`;

process.stdout.write(JSON.stringify(output) + '\n');
process.exit(0);
