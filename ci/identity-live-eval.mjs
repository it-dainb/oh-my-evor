#!/usr/bin/env node
/**
 * ci/identity-live-eval.mjs — LIVE probes for field-trace category 3
 * (identity & state coupling: Q-01, O-02).
 *
 * WHY THE UNIT TESTS ARE NOT ENOUGH, and why that is the whole point here.
 *
 * `harness/tests/test_compaction_survival.py` passes with 16 hook invocations,
 * every one of which sets `EVOR_ROOT` explicitly. Q-01 is invisible to it for
 * exactly that reason. A unit test that constructs a controlled environment
 * reproduces the same blind spot at a smaller scale: it can only prove that the
 * resolver, called directly, returns the wrong string. It cannot prove that a
 * REAL session, launched the way the plugin loader launches one — hooks
 * registered, `CLAUDE_PLUGIN_ROOT` exported by the loader, `EVOR_ROOT` never set
 * by anyone — reads and WRITES another project's mission state. That second
 * claim is the field's actual damage (this repo's own git status still shows
 * `M .evor/runs/frontier-1ms/run-live-01/mission-state.json`), and only a live
 * session produces it.
 *
 * Two probes:
 *
 *   hook-root-resolution (Q-01)
 *     A real headless session in a project that has its own `.evor/`, with
 *     `CLAUDE_PLUGIN_ROOT` pointed at a decoy plugin that ALSO has one, and
 *     `EVOR_ROOT` deliberately removed from the environment. Two assertions:
 *     the run dir the SessionStart hook announces must be the project's, and the
 *     decoy's `.evor/` must be byte-identical afterwards. The second is the
 *     durability half — `hooks/session-end.mjs` stamps `paused_by` into whatever
 *     mission-state it resolved, which is the mechanism by which a binarization
 *     session mutated the plugin repo.
 *
 *   signal-concurrency (O-02)
 *     Two arms, reported separately and never blended:
 *       mcp-only  N real agents emitting concurrently through `evor_signal_emit`.
 *                 The TS path takes `withRunLock` (mcp/src/lock.ts), so this arm
 *                 measures whether that lock actually holds under real agents.
 *       mixed     the same agents, plus the PYTHON writer that
 *                 `hooks/subagent-stop.mjs` invokes (`evor.signals` drain →
 *                 `SignalBus.emit`) against the same `signals.jsonl`. Python
 *                 never takes `.tree.lock`, so the two writers do not serialise
 *                 against each other. This arm is the cross-language hazard the
 *                 lane-O write-path table describes, in its real form.
 *
 * FLAKINESS. Agent behaviour and thread scheduling both vary. The report records
 * `n`, per-repeat outcomes and observed loss counts; it never states a rate it
 * did not measure. The deterministic primary evidence for O-02 lives in
 * `harness/tests/test_wave1_identity_state.py`; this probe is corroboration.
 *
 * GATE. `EVOR_LIVE_EVAL=1` is required — these spend money and call the network.
 * Gate off = nothing runs. Gate on = every abnormal condition is an ERROR: an
 * unreachable CLI, an unparseable envelope, a session in which no hook fired.
 * An unreachable model is never a pass.
 *
 * SECRETS. Everything happens under one mkdtemp. Only the evor MCP server is
 * attached (`--strict-mcp-config`); no keyed server, no network beyond the model
 * call. No credential is read, printed or written here (R-01 is an open blocker).
 *
 * Usage:
 *   EVOR_LIVE_EVAL=1 node ci/identity-live-eval.mjs --probe all
 *   EVOR_LIVE_EVAL=1 node ci/identity-live-eval.mjs --probe hook-root-resolution
 *   EVOR_LIVE_EVAL=1 node ci/identity-live-eval.mjs --probe signal-concurrency --repeats 2
 *
 * Env: IDENTITY_LIVE_MODEL (default "sonnet"), IDENTITY_LIVE_TIMEOUT_MS,
 *      IDENTITY_LIVE_OUT (default ci/out/identity-live.json).
 */

import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MODEL = process.env.IDENTITY_LIVE_MODEL ?? 'sonnet';
const TIMEOUT_MS = Number(process.env.IDENTITY_LIVE_TIMEOUT_MS ?? 600_000);

/** The decoy's identity, taken verbatim from the field: a CIFAR-10 self-test. */
export const DECOY_MISSION = 'frontier-1ms';
export const DECOY_RUN = 'run-live-01';
export const DECOY_OBJECTIVE = 'Beat the CIFAR-10 accuracy/latency frontier';
/** The live project's identity. */
export const PROJECT_MISSION = 'binarization-worldmodel-min98-2026-08';
export const PROJECT_RUN = 'run-project-live-01';
export const PROJECT_OBJECTIVE = 'Binarize degraded document images to F-measure 98';

export function requireGate() {
  if (process.env.EVOR_LIVE_EVAL !== '1') {
    console.error(
      'refusing to run: live probes spend money and call the network.\n' +
        'Set EVOR_LIVE_EVAL=1 to run them.',
    );
    process.exit(3);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem inventory — the durability half of the Q-01 assertion
// ─────────────────────────────────────────────────────────────────────────────

/** path -> sha256 for every file under `root`. */
export function inventory(root) {
  const out = new Map();
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          out.set(p, createHash('sha256').update(readFileSync(p)).digest('hex'));
        } catch { /* vanished mid-walk */ }
      }
    }
  };
  walk(root);
  return out;
}

/** added / changed / removed between two inventories. */
export function diffInventory(before, after) {
  return {
    added: [...after.keys()].filter((k) => !before.has(k)),
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
    removed: [...before.keys()].filter((k) => !after.has(k)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox — the field configuration, materialised
// ─────────────────────────────────────────────────────────────────────────────

/**
 * <tmp>/plugin/    decoy plugin root: the repo's real hooks + a leftover .evor/
 *                  holding the `frontier-1ms` self-test, mission-state RUNNING
 *                  and its sage artifact PRESENT.
 * <tmp>/project/   the session's cwd: .evor/ with the live run, mission-state
 *                  RUNNING and its sage artifact ABSENT.
 *
 * The artifact asymmetry is the non-vacuity guard, exactly as in the unit suite:
 * a hook that resolves to the decoy finds a healthy run and says nothing.
 */
export function buildSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'evor-identity-live-'));
  const plugin = join(root, 'plugin');
  const project = join(root, 'project');

  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  cpSync(join(REPO, 'hooks'), join(plugin, 'hooks'), { recursive: true });
  writeFileSync(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'oh-my-evor',
      displayName: 'oh-my-evor (identity probe sandbox)',
      version: '1.2.0',
      description: 'throwaway copy — hooks only',
      author: { name: 'identity-live-eval' },
    }, null, 2) + '\n',
  );

  const decoyEvor = join(plugin, '.evor');
  const decoyRun = join(decoyEvor, 'runs', DECOY_MISSION, DECOY_RUN);
  mkdirSync(join(decoyRun, 'ticks', '1', 'sage'), { recursive: true });
  writeFileSync(join(decoyEvor, 'active-run.json'),
    JSON.stringify({ run_id: DECOY_RUN, mission_id: DECOY_MISSION, status: 'running' }, null, 2));
  writeFileSync(join(decoyRun, 'mission-state.json'),
    JSON.stringify({ mission_id: DECOY_MISSION, run_id: DECOY_RUN, objective: DECOY_OBJECTIVE, status: 'running', current_tick: 1 }, null, 2));
  writeFileSync(join(decoyRun, 'tick-state.json'),
    JSON.stringify({ tick: 1, current_step: 2, step_status: 'running' }, null, 2));
  writeFileSync(join(decoyRun, 'run-state.json'),
    JSON.stringify({ run_id: DECOY_RUN, status: 'running', tick_count: 1, best_score: 0.61, frontier_ids: [], pending_node_ids: [] }, null, 2));
  writeFileSync(join(decoyRun, 'tree.json'), JSON.stringify({ nodes: {}, updated_at: '2026-08-23T03:47:00Z' }, null, 2));
  writeFileSync(join(decoyRun, 'ticks', '1', 'sage', 'findings.json'),
    JSON.stringify({ findings: ['leftover self-test artifact, unrelated to this project'] }, null, 2));

  const projectEvor = join(project, '.evor');
  const projectRun = join(projectEvor, 'runs', PROJECT_MISSION, PROJECT_RUN);
  mkdirSync(join(projectRun, 'ticks', '1'), { recursive: true });
  writeFileSync(join(projectEvor, 'active-run.json'),
    JSON.stringify({ run_id: PROJECT_RUN, mission_id: PROJECT_MISSION, status: 'running' }, null, 2));
  writeFileSync(join(projectRun, 'mission-state.json'),
    JSON.stringify({ mission_id: PROJECT_MISSION, run_id: PROJECT_RUN, objective: PROJECT_OBJECTIVE, status: 'running', current_tick: 1 }, null, 2));
  writeFileSync(join(projectRun, 'tick-state.json'),
    JSON.stringify({ tick: 1, current_step: 4, step_status: 'running' }, null, 2));
  writeFileSync(join(projectRun, 'run-state.json'),
    JSON.stringify({ run_id: PROJECT_RUN, status: 'running', tick_count: 1, best_score: 0.93, frontier_ids: [], pending_node_ids: [] }, null, 2));
  writeFileSync(join(projectRun, 'tree.json'), JSON.stringify({ nodes: {}, updated_at: '2026-08-24T00:05:00Z' }, null, 2));
  writeFileSync(join(project, 'NOTES.md'), '# scratch\n');

  return { root, plugin, project, decoyEvor, decoyRun, projectEvor, projectRun };
}

/** Marker appended to each hook command so its own exit code is recoverable. */
export const HOOK_MARK = 'EVOR_IDENTITY_HOOK';

/**
 * Hooks are wired through `--settings`, not `--plugin-dir`: a `--plugin-dir`
 * plugin's `hooks/hooks.json` does not register in this CLI version (measured by
 * ci/autonomy-live.mjs), while a settings hook block does. A `matcher` key makes
 * the settings file fail validation silently, so there is none. The binaries are
 * the repo's own hooks either way.
 */
export function writeLiveSettings(path, pluginRoot) {
  const cmd = (name) =>
    `node ${join(pluginRoot, 'hooks', `${name}.mjs`)}; echo ${HOOK_MARK}=${name}:$? >&2`;
  const block = (name) => [{ hooks: [{ type: 'command', command: cmd(name), timeout: 15 }] }];
  writeFileSync(path, JSON.stringify({
    hooks: {
      SessionStart: block('session-start'),
      SessionEnd: block('session-end'),
      Stop: block('stop'),
      SubagentStop: block('subagent-stop'),
    },
  }, null, 2));
  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One headless session. Throws on anything that is not a real answer.
 *
 * `stripEnv` removes variables from the child's environment — Q-01 requires
 * `EVOR_ROOT` to be genuinely ABSENT, and inheriting one from the developer's
 * shell would silently repair the defect under test.
 */
export function runSession({ prompt, cwd, settingsPath, mcpConfigPath, allowedTools, env = {}, stripEnv = [], maxTurns = 6 }) {
  const args = [
    '--permission-mode', 'bypassPermissions',
    '--model', MODEL,
    '--output-format', 'json',
    '--max-turns', String(maxTurns),
  ];
  if (settingsPath) args.push('--settings', settingsPath);
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));
  args.push('-p', prompt);

  const childEnv = { ...process.env, ...env };
  for (const k of stripEnv) delete childEnv[k];

  const t0 = Date.now();
  let raw;
  try {
    raw = execFileSync('claude', args, {
      cwd, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
      input: '', env: childEnv,
    });
  } catch (e) {
    raw = e.stdout ?? '';
    if (!raw) throw new Error(`claude CLI exited abnormally and produced no output: ${e.message}`);
  }
  const wall_ms = Date.now() - t0;

  const brace = raw.indexOf('{');
  if (brace < 0) throw new Error(`no JSON envelope in CLI output: ${raw.slice(0, 300)}`);
  const envelope = JSON.parse(raw.slice(brace));
  if (envelope.is_error) {
    throw new Error(`CLI reported an error: ${String(envelope.result ?? '').slice(0, 300)}`);
  }

  return {
    session_id: envelope.session_id,
    text: String(envelope.result ?? ''),
    turns: Number(envelope.num_turns ?? 0),
    cost_usd: Number(envelope.total_cost_usd ?? 0),
    model_id: Object.keys(envelope.modelUsage ?? {})[0] ?? null,
    wall_ms,
  };
}

/** The session transcript, located by session id under ~/.claude/projects. */
export function transcriptPath(sessionId) {
  const stack = [join(homedir(), '.claude', 'projects')];
  while (stack.length) {
    const d = stack.pop();
    if (!existsSync(d)) continue;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === `${sessionId}.jsonl`) return p;
    }
  }
  throw new Error(`no transcript found for session ${sessionId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream / transcript analysis (pure — unit-tested with the gate OFF)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every hook record this rig planted, with the hook's OWN exit code recovered
 * from the `; echo MARK=<name>:$?` tail. The transcript records the exit code of
 * the whole command line, so the marker is the only honest source.
 */
export function evorHookRecords(transcriptLines) {
  const out = [];
  for (const line of transcriptLines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const a = rec.attachment ?? {};
    if (!a.hookEvent) continue;
    const stderr = String(a.stderr ?? '');
    const m = stderr.match(new RegExp(`${HOOK_MARK}=([a-z-]+):(\\d+)`));
    if (!m) continue;
    out.push({
      event: a.hookEvent,
      hook: m[1],
      exitCode: Number(m[2]),
      stdout: String(a.stdout ?? ''),
      stderr,
    });
  }
  return out;
}

/**
 * Which `.evor` root the hooks actually resolved, read off their own output.
 *
 * `hooks/session-start.mjs` emits the resolved run dir in its payload as
 * `env.EVOR_RUN_DIR`, so this is a direct observation of the resolution, not an
 * inference from side effects. Any `.evor/runs/...` path in hook output counts,
 * which keeps the reading honest if a hook renames the field.
 *
 * @returns {{runDirs: string[], underDecoy: string[], underProject: string[]}}
 */
export function classifyResolvedRunDirs(records, decoyEvor, projectEvor) {
  const runDirs = [];
  for (const r of records) {
    const text = `${r.stdout}\n${r.stderr}`;
    for (const m of text.matchAll(/"(?:EVOR_RUN_DIR|runDir)"\s*:\s*"([^"]+)"/g)) runDirs.push(m[1]);
    for (const m of text.matchAll(/(\/[^\s"']*\/\.evor\/runs\/[^\s"',]+)/g)) runDirs.push(m[1]);
  }
  const uniq = [...new Set(runDirs)];
  return {
    runDirs: uniq,
    underDecoy: uniq.filter((p) => p.startsWith(decoyEvor)),
    underProject: uniq.filter((p) => p.startsWith(projectEvor)),
  };
}

/** Signatures the run was supposed to persist but did not. */
export function missingSignatures(signalsPath, expected) {
  const present = new Set();
  if (existsSync(signalsPath)) {
    for (const line of readFileSync(signalsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { present.add(JSON.parse(line).signature); } catch { /* skip */ }
    }
  }
  return expected.filter((s) => !present.has(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe 1 — Q-01, hook root resolution in a real session
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_PROMPT = [
  'You are resuming work on the active evor run in this directory.',
  'Reply with one sentence naming what the mission is about. Do not use any tools.',
].join(' ');

export function probeHookRootResolution() {
  const sb = buildSandbox();
  const settingsPath = writeLiveSettings(join(sb.root, 'live-settings.json'), sb.plugin);

  const decoyBefore = inventory(sb.decoyEvor);
  const projectBefore = inventory(sb.projectEvor);

  const session = runSession({
    prompt: IDENTITY_PROMPT,
    cwd: sb.project,
    settingsPath,
    // The field environment exactly: the loader exports CLAUDE_PLUGIN_ROOT and
    // nothing exports EVOR_ROOT.
    env: { CLAUDE_PLUGIN_ROOT: sb.plugin },
    stripEnv: ['EVOR_ROOT', 'EVOR_ACTIVE_RUN_ID', 'EVOR_MISSION_ID'],
    maxTurns: 4,
  });

  const decoyDiff = diffInventory(decoyBefore, inventory(sb.decoyEvor));
  const projectDiff = diffInventory(projectBefore, inventory(sb.projectEvor));

  const records = evorHookRecords(readFileSync(transcriptPath(session.session_id), 'utf8').split('\n'));
  // A session in which no hook fired measured nothing. That is a harness error,
  // never a red and never a pass.
  if (records.length === 0) {
    throw new Error(
      `session ${session.session_id} recorded no evor hook invocation — the rig did not ` +
        'measure the hooks (check the --settings wiring against this CLI version)',
    );
  }

  const resolved = classifyResolvedRunDirs(records, sb.decoyEvor, sb.projectEvor);
  const restoreText = records.map((r) => r.stdout).join('\n');

  const result = {
    probe: 'hook-root-resolution',
    session_id: session.session_id,
    model_id: session.model_id,
    turns: session.turns,
    cost_usd: session.cost_usd,
    wall_ms: session.wall_ms,
    hook_invocations: records.length,
    hooks_fired: [...new Set(records.map((r) => r.hook))],
    resolved_run_dirs: resolved.runDirs,
    resolved_under_decoy: resolved.underDecoy.length,
    resolved_under_project: resolved.underProject.length,
    decoy_changed: decoyDiff.changed.concat(decoyDiff.added).map((p) => p.slice(sb.root.length)),
    project_changed: projectDiff.changed.concat(projectDiff.added).map((p) => p.slice(sb.root.length)),
    restore_names_decoy: restoreText.includes(DECOY_OBJECTIVE.slice(0, 40)),
    restore_names_project: restoreText.includes(PROJECT_OBJECTIVE.slice(0, 40)),
    sandbox: sb.root,
  };
  // Non-fatal: an MCP server child may still be exiting and holding the dir.
  try { rmSync(sb.root, { recursive: true, force: true }); } catch { /* leaves a tmp dir behind */ }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe 2 — O-02, concurrent signal writers
// ─────────────────────────────────────────────────────────────────────────────

export function seedSignalRun(root) {
  const evorRoot = join(root, '.evor');
  const runDir = join(evorRoot, 'runs', PROJECT_MISSION, PROJECT_RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(evorRoot, 'active-run.json'),
    JSON.stringify({ run_id: PROJECT_RUN, mission_id: PROJECT_MISSION, status: 'running' }, null, 2));
  writeFileSync(join(runDir, 'tree.json'), JSON.stringify({ nodes: {}, updated_at: new Date().toISOString() }, null, 2));
  return { evorRoot, runDir, signalsPath: join(runDir, 'signals.jsonl') };
}

export function writeMcpConfig(path, env) {
  const server = join(REPO, 'mcp', 'dist', 'index.cjs');
  if (!existsSync(server)) {
    throw new Error(
      'mcp/dist/index.cjs is missing — run `npm --prefix mcp run build` first. ' +
        'A live eval against an absent build measures nothing.',
    );
  }
  writeFileSync(path, JSON.stringify({
    mcpServers: { evor: { command: 'node', args: [server], env } },
  }, null, 2));
  return path;
}

function emitTask(agentId, count) {
  const sigs = Array.from({ length: count }, (_, i) => `${agentId}-s${i}`);
  return [
    'Use the attached evor MCP server. Call `evor_signal_emit` exactly',
    `${count} times, once for each of these signatures, in order:`,
    '',
    ...sigs.map((s) => `  - ${s}`),
    '',
    'For every call use: kind "concurrency-probe", shapes ["limit"], axes ["compute"],',
    `severity "medium", evidence {"agent": "${agentId}"}, source "${agentId}".`,
    'Make the calls back to back with no commentary in between.',
    `When all ${count} calls are done, reply with the single word: done.`,
  ].join('\n');
}

/** Spawn one emitting agent as a detached child; resolves when it exits. */
function spawnEmitter({ agentId, count, cwd, mcpConfigPath, env }) {
  const args = [
    '--permission-mode', 'bypassPermissions',
    '--model', MODEL,
    '--output-format', 'json',
    '--max-turns', String(count + 6),
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__evor__evor_signal_emit',
    '-p', emitTask(agentId, count),
  ];
  return new Promise((res) => {
    const t0 = Date.now();
    let out = '';
    const child = spawn('claude', args, {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      let envelope = null;
      const brace = out.indexOf('{');
      if (brace >= 0) { try { envelope = JSON.parse(out.slice(brace)); } catch { /* partial */ } }
      res({
        agentId, exit_code: code, wall_ms: Date.now() - t0,
        cost_usd: Number(envelope?.total_cost_usd ?? 0),
        model_id: Object.keys(envelope?.modelUsage ?? {})[0] ?? null,
        is_error: Boolean(envelope?.is_error),
        raw_head: out.slice(0, 200),
      });
    });
  });
}

/**
 * The PYTHON half of the mixed arm — the writer `hooks/subagent-stop.mjs`
 * actually invokes (`python3 -m evor.signals drain` → `SignalBus.emit`). It
 * takes no `.tree.lock`, so it does not serialise against the MCP writers.
 *
 * It emits CONTINUOUSLY until a stop-file appears, rather than a fixed count.
 * The first version of this probe used a fixed count with a 50 ms sleep: both
 * Python writers finished in ~250 ms while the agents' first `evor_signal_emit`
 * landed roughly ten seconds later, so the write windows never met and the arm
 * reported a vacuous "0 lost". Overlap is now measured, not assumed — see
 * `overlapWindow` and the `inconclusive` verdict.
 *
 * Each emit is journalled to a manifest BEFORE bus.emit returns, so the expected
 * set is what Python actually attempted, not what the harness planned.
 */
function spawnPythonEmitter({ runDir, prefix, stopFile, manifestPath }) {
  const code = [
    'import json, os, sys, time',
    'from datetime import datetime, timezone',
    'from pathlib import Path',
    'from evor.signals import SignalBus, make_signal',
    'run_dir, prefix, stop_file, manifest = sys.argv[1:5]',
    'bus = SignalBus(Path(run_dir))',
    'i = 0',
    'while not os.path.exists(stop_file):',
    '    sig = f"{prefix}-s{i}"',
    '    with open(manifest, "a") as fh:',
    '        fh.write(json.dumps({"sig": sig, "ts": datetime.now(timezone.utc).isoformat()}) + "\\n")',
    '    bus.emit(make_signal("concurrency-probe", sig, ["limit"], ["compute"],',
    '                         "medium", {"writer": prefix}, prefix))',
    '    i += 1',
    '    time.sleep(0.02)',
  ].join('\n');
  return new Promise((res) => {
    const child = spawn('python3', ['-c', code, runDir, prefix, stopFile, manifestPath], {
      env: { ...process.env, PYTHONPATH: join(REPO, 'harness') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => res({ prefix, exit_code: code, stderr: err.slice(0, 400) }));
  });
}

/** Signatures a Python writer journalled, with the time it attempted each. */
function readManifest(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * The intersection of two [start, end] ISO windows, in milliseconds.
 *
 * This is the arm's own validity check. Two writers that never wrote at the same
 * time cannot demonstrate anything about a race, and an arm that reports "0 lost"
 * without overlap is measuring scheduling luck — which is precisely the mistake
 * lane O warns about ("the clean bill of health is exactly what a lost update
 * would also look like").
 */
export function overlapWindow(a, b) {
  if (!a.length || !b.length) return 0;
  const span = (xs) => {
    const ts = xs.map((t) => Date.parse(t)).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
    return ts.length ? [ts[0], ts[ts.length - 1]] : null;
  };
  const A = span(a); const B = span(b);
  if (!A || !B) return 0;
  return Math.max(0, Math.min(A[1], B[1]) - Math.max(A[0], B[0]));
}

/** `first_seen` of every signature in signals.jsonl matching a prefix test. */
export function emitTimes(signalsPath, keep) {
  if (!existsSync(signalsPath)) return [];
  const out = [];
  for (const line of readFileSync(signalsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      if (keep(s.signature)) out.push(s.first_seen);
    } catch { /* skip */ }
  }
  return out;
}

/**
 * @param arm 'mcp-only' — N live agents only; the TS `withRunLock` path.
 *            'mixed'    — the same agents plus the unlocked Python writer.
 */
export async function probeSignalConcurrency({ arm, agents = 3, perAgent = 3, pyWriters = 2 }) {
  const root = mkdtempSync(join(tmpdir(), `evor-signal-${arm}-`));
  const seed = seedSignalRun(root);
  const env = {
    EVOR_ROOT: seed.evorRoot,
    EVOR_MISSION_ID: PROJECT_MISSION,
    EVOR_ACTIVE_RUN_ID: PROJECT_RUN,
  };
  const cfg = writeMcpConfig(join(root, 'mcp.json'), env);

  const agentIds = Array.from({ length: agents }, (_, i) => `a${i}`);
  const agentExpected = agentIds.flatMap((a) =>
    Array.from({ length: perAgent }, (_, i) => `${a}-s${i}`));

  const stopFile = join(root, 'STOP');
  const pyIds = arm === 'mixed'
    ? Array.from({ length: pyWriters }, (_, i) => `py${i}`)
    : [];
  const manifestOf = (p) => join(root, `py-manifest-${p}.jsonl`);

  const pyJobs = pyIds.map((prefix) =>
    spawnPythonEmitter({ runDir: seed.runDir, prefix, stopFile, manifestPath: manifestOf(prefix) }));

  const agentResults = await Promise.all(agentIds.map((agentId) =>
    spawnEmitter({ agentId, count: perAgent, cwd: root, mcpConfigPath: cfg, env })));

  // Python stops only once every agent has finished, so its window spans theirs.
  if (pyIds.length) writeFileSync(stopFile, 'stop');
  const pyResults = await Promise.all(pyJobs);

  const pyAttempts = pyIds.flatMap((p) => readManifest(manifestOf(p)));
  const expected = [...agentExpected, ...pyAttempts.map((r) => r.sig)];
  const missing = missingSignatures(seed.signalsPath, expected);

  const agentTimes = emitTimes(seed.signalsPath, (s) => /^a\d+-s/.test(String(s)));
  const overlap_ms = arm === 'mixed'
    ? overlapWindow(agentTimes, pyAttempts.map((r) => r.ts))
    : null;

  const result = {
    probe: 'signal-concurrency',
    arm,
    model_id: agentResults.find((r) => r.model_id)?.model_id ?? null,
    agents: agentResults,
    python_writers: pyResults,
    python_attempts: pyAttempts.length,
    agent_emits_landed: agentTimes.length,
    overlap_ms,
    expected_count: expected.length,
    missing_count: missing.length,
    missing: missing.slice(0, 20),
    // An arm whose writers never overlapped proves nothing either way.
    verdict: arm === 'mixed' && !(overlap_ms > 0)
      ? 'inconclusive-no-overlap'
      : (missing.length === 0 ? 'no-loss' : 'loss'),
    cost_usd: agentResults.reduce((s, r) => s + r.cost_usd, 0),
    sandbox: root,
  };
  try { rmSync(root, { recursive: true, force: true }); } catch { /* see above */ }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  requireGate();
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const which = arg('probe', 'all');
  const repeats = Number(arg('repeats', 1));

  const report = { model: MODEL, started_at: new Date().toISOString(), runs: [] };

  for (let r = 0; r < repeats; r++) {
    if (which === 'all' || which === 'hook-root-resolution') {
      report.runs.push(probeHookRootResolution());
    }
    if (which === 'all' || which === 'signal-concurrency') {
      report.runs.push(await probeSignalConcurrency({ arm: 'mcp-only' }));
      report.runs.push(await probeSignalConcurrency({ arm: 'mixed' }));
    }
  }

  report.n = repeats;
  report.total_cost_usd = report.runs.reduce((s, x) => s + (x.cost_usd ?? 0), 0);

  const out = process.env.IDENTITY_LIVE_OUT ?? join(REPO, 'ci', 'out', 'identity-live.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nreport → ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
