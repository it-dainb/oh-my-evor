#!/usr/bin/env node
/**
 * oh-my-evor SessionStart hook — Phase-2 kill switches + active-run env setup
 *
 * Kill switches (checked FIRST, before any other logic):
 *   DISABLE_EVOR=1                 → exit 0 immediately
 *   EVOR_SKIP_HOOKS=session-start  → exit 0 immediately
 *
 * Reads .evor/active-run.json. Session env vars (EVOR_ACTIVE_RUN_ID,
 * EVOR_MISSION_ID, EVOR_RUN_DIR, the harness paths) reach the session's shell
 * through the `export` lines appended to $CLAUDE_ENV_FILE (persistEnv).
 *
 * Model-visible text goes in hookSpecificOutput.additionalContext — the only
 * SessionStart field the CLI puts in the model's context. Top-level `env`,
 * `message` and `watchPaths` are not part of the hook output schema and were
 * dropped by the CLI, so nothing this hook said ever reached the model.
 *
 * The payload's `source` picks the text. On `compact` (the re-hydration point
 * after compaction) and `resume` with a live mission it is only the restore
 * block plus main's next step (lib/next-step.mjs, shared with post-compact);
 * on `startup`/`clear` it is the full orientation for a fresh context.
 *
 * Graceful degradation:
 *   - Missing active-run.json  → exit 0 (no active run; normal state)
 *   - Corrupt active-run.json  → log to stderr, clear env, exit 0
 *   - Missing run_id field      → log to stderr, clear env, exit 0
 *   - Python wiki unavailable   → skip priming, still emit env JSON
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname, delimiter } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveEvorRoot } from './lib/active-run.mjs';
import { isMissionLive } from './lib/run-status.mjs';
import { nextStep, HEARTBEAT_CALL } from './lib/next-step.mjs';

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
    const py = process.env.EVOR_PYTHON ?? 'python3';

    // ── Item 6.2 (R-07): a sentinel that RECORDS WHAT IT VERIFIED ──────────
    //
    // `.deps-ok` was a bare 24-byte ISO timestamp, and its mere existence
    // short-circuited the check. That records nothing falsifiable: it cannot say
    // WHICH interpreter was verified or WHICH packages were present, so an
    // environment that changed underneath it — a different conda env, a package
    // uninstalled — was indistinguishable from one that had not. A sentinel that
    // cannot fail is not a check, which is `integrity.py:404` in another file.
    //
    // It now attests the interpreter and the package set, and is revalidated
    // whenever either no longer matches.
    let attested = null;
    if (existsSync(sentinel)) {
      try { attested = JSON.parse(readFileSync(sentinel, 'utf8')); } catch { attested = null; }
    }
    const shapeValid =
      attested &&
      typeof attested === 'object' &&
      attested.python === py &&
      attested.packages &&
      Object.keys(attested.packages).length > 0;

    // A sentinel that names packages must be checked AGAINST them. Matching the
    // interpreter alone would still accept an attestation listing a package that
    // has since been uninstalled — which is the same "cannot fail" defect one
    // level in, and exactly what R-07's third case pins.
    let stillValid = false;
    if (shapeValid) {
      const names = Object.keys(attested.packages);
      const verify = [
        'import sys',
        'from importlib.metadata import version, PackageNotFoundError',
        `names = ${JSON.stringify(names)}`,
        'missing = []',
        'for n in names:',
        '    try: version(n)',
        '    except PackageNotFoundError: missing.append(n)',
        'sys.exit(1 if missing else 0)',
      ].join('\n');
      const check = spawnSync(py, ['-c', verify], { encoding: 'utf8', timeout: 5000 });
      stillValid = check.status === 0;
    }
    if (stillValid) return '';

    const env = {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH ? `${harness}${delimiter}${process.env.PYTHONPATH}` : harness,
    };
    // Report the versions actually imported, so the sentinel attests a fact
    // about this environment rather than the fact that a check once ran.
    const probe = [
      'import json, sys',
      'import evor.contracts, yaml, pydantic',
      'print(json.dumps({"python": sys.executable,',
      '  "packages": {"pydantic": pydantic.VERSION, "pyyaml": yaml.__version__}}))',
    ].join('\n');
    const res = spawnSync(py, ['-c', probe], { encoding: 'utf8', timeout: 5000, env });

    if (res.status === 0) {
      let reported = {};
      try { reported = JSON.parse((res.stdout ?? '').trim().split('\n').pop() ?? '{}'); } catch { /* fall through */ }
      try {
        mkdirSync(dirname(sentinel), { recursive: true });
        writeFileSync(sentinel, JSON.stringify({
          // The interpreter AS INVOKED, so the next session compares like with
          // like — `sys.executable` resolves symlinks and would never match.
          python: py,
          interpreter_path: reported.python ?? null,
          packages: reported.packages ?? {},
          verified_at: new Date().toISOString(),
        }, null, 2));
      } catch { /* read-only .evor — fine, we re-check next time */ }
      return '';
    }

    // Revalidation failed. Remove a stale sentinel rather than leaving one that
    // attests an environment that no longer exists.
    if (attested) { try { unlinkSync(sentinel); } catch { /* best effort */ } }
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

/**
 * Make the variables visible to the session's shell commands. Claude Code reads
 * `export` lines a SessionStart hook appends to $CLAUDE_ENV_FILE; the `env` field
 * of the JSON output alone does not reach Bash, so `python -m evor.watch` found
 * no `evor` package on the candidate's interpreter.
 */
function persistEnv(vars) {
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file) return;
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  try {
    appendFileSync(file, Object.entries(vars).map(([k, v]) => `export ${k}=${q(v)}`).join('\n') + '\n');
  } catch (err) {
    process.stderr.write(`[evor:session-start] could not write CLAUDE_ENV_FILE: ${err.message}\n`);
  }
}

// One-time harness/deps health check (surfaces a clear fix on incomplete installs).
const depWarning = checkHarnessDeps(pluginRoot, evorRoot);

let hookPayload = {};
try { hookPayload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no payload */ }

/** Print the hook output — model context, when there is any — and exit 0. */
function emit(context) {
  const out = context
    ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }
    : {};
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
}

/** Clear the active-run env and exit 0 gracefully. */
function clearEnvAndExit(reason) {
  if (reason) process.stderr.write(`[evor:session-start] ${reason}\n`);
  persistEnv({ ...evorEnv, EVOR_ACTIVE_RUN_ID: '', EVOR_MISSION_ID: '', EVOR_RUN_DIR: '' });
  emit(depWarning);
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

  persistEnv(evorEnv);
  emit([depWarning, nudge].filter(Boolean).join('\n\n'));
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

persistEnv({
  ...evorEnv,
  EVOR_ACTIVE_RUN_ID: runId,
  EVOR_MISSION_ID: missionId,
  EVOR_RUN_DIR: runDir,
});

// A sub-agent's context is not main's: the mission orientation below is main's.
if (hookPayload?.agent_type) emit(depWarning);

resumeIfHookPaused(runDir);

function readState(name) {
  try { return JSON.parse(readFileSync(join(runDir, name), 'utf8')); } catch { return {}; }
}
const missionStateNow = readState('mission-state.json');
const live = isMissionLive(missionStateNow, readState('run-state.json'));
const restoreBlock = buildEvorRestore(runDir, runId, missionId);
const next = live
  ? nextStep(runDir, hookPayload?.session_id, String(hookPayload?.transcript_path ?? ''))
  : '';
const source = String(hookPayload?.source ?? 'startup');

// ── compact / resume: restore + next step only ───────────────────────────────
// After a compaction the summary keeps the conversation; what it cannot keep is
// where the tick stands and which agent runs it. A resumed session has its own
// transcript back. Both get exactly that, and nothing that grows with the run.
if (live && (source === 'compact' || source === 'resume')) {
  emit([depWarning, restoreBlock, next && `[NEXT] ${next}`].filter(Boolean).join('\n\n'));
}

// ── startup / clear: full orientation for a fresh context ────────────────────
// Main-facing only. The subagent protocol (READ-FIRST, artifact reads) belongs
// in subagent-start.mjs. Main orchestrates: it reads no per-tick detail, which
// §3b.0 denies it, so nothing here may point it at evor_state_read and friends.
// Recent wiki lessons are not injected: they are tick material (evor-tick reads
// them), and their text grows with the mission.
const LAW_PRIMER =
  `[EVOR LAW] Use evor_* MCP tools to change evor state — never write .evor/ directly.\n` +
  `[ROLE] You orchestrate the mission: run each tick through one evor-tick agent, record the ` +
  `outcome, decide continue/stop. While a tick is unfinished, talk to its agent with ` +
  `SendMessage; never spawn a second one for it. The tick's detail lives inside the boundary ` +
  `and returns to you as a status line plus pointers.\n` +
  `[WAIT] A tick is done when it reports an outcome. While it runs, call ${HEARTBEAT_CALL} and ` +
  `end your turn: its completion notice wakes you. Do not poll it or emit "still waiting" turns.\n` +
  `[TOOLS] Hot-path: evor-tick spawn, SendMessage to the tick agent, evor_check_stop, ` +
  `evor_check_plateau, evor_write_handoff.`;

const status = String(missionStateNow?.status ?? '');
const parts = [
  depWarning,
  live
    ? `[EVOR CONTEXT] An evor mission is running in this workspace.`
    : `[EVOR CONTEXT] An evor mission exists in this workspace and is not running` +
      (status ? ` (status: ${status})` : '') + `.`,
  restoreBlock,
  live ? LAW_PRIMER : '',
  live
    ? next && `[NEXT] ${next} Prioritise the user's newest request.`
    : `[NEXT] /oh-my-evor:evor-run starts the tick loop; /oh-my-evor:evor-resume continues a paused mission.`,
];
emit(parts.filter(Boolean).join('\n\n'));
