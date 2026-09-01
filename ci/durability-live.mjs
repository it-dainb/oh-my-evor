#!/usr/bin/env node
/**
 * ci/durability-live.mjs — LIVE durability-and-audit probe (wave-1 RED, category 4).
 *
 * WHY THIS EXISTS, and why the unit tests are not enough.
 *
 * The unit tests in this category call the writers directly and assert they log.
 * Calling a writer proves the writer works. The field defect (I-01) is the
 * opposite shape: during a real 19-hour run, materially significant actions
 * happened and NOTHING CALLED the decision-log writer at all. That is only
 * visible when a real model drives the real tool surface and you then diff
 * "what actually changed on disk" against "what the durable record captured".
 *
 * That diff IS this test. Note the direction: the ground truth is not what the
 * model SAID it did — lane I already established the agents narrate honestly —
 * it is the state delta computed from the artifacts themselves. So a model that
 * lies, or one that fails to complete a task, cannot manufacture a pass: an
 * action that did not change state is not counted as having happened, and an
 * action that did change state must be recorded or the probe fails.
 *
 * The run also carries a POSITIVE CONTROL. `evor_record_node` is the one event
 * class that already appends to decision-log.md. If the control entry is absent
 * the probe reports `harness_error`, not a finding — that is the signature of a
 * broken fixture (no MCP attached, wrong run dir, model never called a tool),
 * and it must never be read as evidence about logging.
 *
 * Sandbox: everything happens in a throwaway directory. The session runs with
 * Bash/Write/Edit denied and only the evor MCP tools allowed, so the ONLY writer
 * that can touch the filesystem is the one under test. Before/after inventories
 * of the repo and of the installed plugin cache are compared, which is the
 * behavioural half of P-02: rather than enumerating known writers, assert that
 * nothing landed outside the sandbox at all.
 *
 * Usage:
 *   node ci/durability-live.mjs                 # runs live; needs credentials
 *   DURABILITY_LIVE_MODEL=haiku node ci/durability-live.mjs
 *
 * Env (all optional):
 *   DURABILITY_LIVE_MODEL       default "sonnet"
 *   DURABILITY_LIVE_MAX_TURNS   default 16
 *   DURABILITY_LIVE_TIMEOUT_MS  default 600000
 *   DURABILITY_LIVE_DIR         sandbox root; default a fresh mkdtemp
 *   DURABILITY_LIVE_OUT         report path; default ci/out/durability-live.json
 *
 * Exit code is 0 whenever the probe RAN; the verdict lives in the report and is
 * asserted by mcp/tests/durability-live.test.ts. A non-zero exit means the probe
 * could not run (no credentials, no CLI, no bundle) — an unreachable model is an
 * error, never a pass.
 */

import { execFileSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  readdirSync, statSync, rmSync,
} from 'fs';
import { createHash } from 'crypto';
import { tmpdir, homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MODEL = process.env.DURABILITY_LIVE_MODEL ?? 'sonnet';
const MAX_TURNS = Number(process.env.DURABILITY_LIVE_MAX_TURNS ?? 16);
const TIMEOUT_MS = Number(process.env.DURABILITY_LIVE_TIMEOUT_MS ?? 600_000);
const OUT = process.env.DURABILITY_LIVE_OUT ?? join(REPO, 'ci', 'out', 'durability-live.json');

const MISSION = 'durability-probe-r1';
const RUN = 'run-live-01';
const STALE_EVAL_HASH = 'def456cafebabe';

const log = (m) => console.log(m);

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem inventory — for the P-02 containment check
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'refs', '.deps',
  // .omc is this development session's own runtime state; its hooks write there
  // continuously and would show up as noise. .evor is deliberately NOT skipped —
  // a run-state file appearing under the repo is exactly the leak P-02 describes.
  '.omc']);

/** path -> sha256, recursively, cheap enough for a repo of this size. */
function inventory(root, budget = 20000) {
  const out = new Map();
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    if (out.size > budget) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.size > budget) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile()) {
        try {
          const st = statSync(p);
          if (st.size > 8 * 1024 * 1024) { out.set(p, `size:${st.size}`); continue; }
          out.set(p, createHash('sha256').update(readFileSync(p)).digest('hex'));
        } catch { /* vanished mid-walk */ }
      }
    }
  };
  walk(root);
  return out;
}

function diffInventory(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  return { added, changed, removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox
// ─────────────────────────────────────────────────────────────────────────────

const ANSWERS = {
  mission_id: MISSION,
  mode: 'from-scratch',
  mission_type: 'fixed',
  task_description: 'Binarise degraded palm-leaf manuscript images',
  dataset_ref: '/data/dibco',
  metrics: [{ name: 'fmeasure', direction: 'higher', primary: true }],
  metric_specs: [{
    metric_name: 'fmeasure',
    direction: 'higher',
    domain_applicability: 'all',
    aggregation_rule: 'macro_avg',
    role: 'primary_fitness',
  }],
  fitness_mode: 'aggregate',
  eval_version: 'v1',
  baseline_value: 0.59,
  target_value: 0.85,
  coverage_target: null,
  stop_condition: { type: 'target' },
  wildness: 0.5,
  budget: { max_iterations: 200, plateau_window: 5, circuit_breaker: 3, max_cost_usd: 50.0 },
  framework: 'pytorch',
  seed_repo_path: null,
  locked_split_hash: 'abc123deadbeef',
  eval_script_hash: STALE_EVAL_HASH,
  expansion_policy: null,
  allowed_licenses: ['MIT', 'Apache-2.0'],
  evolution_bounds: null,
  autonomy_charter: null,
  created_at: '2026-08-23T03:47:00+00:00',
};

function seedSandbox() {
  const root = process.env.DURABILITY_LIVE_DIR ?? mkdtempSync(join(tmpdir(), 'evor-durability-live-'));
  mkdirSync(root, { recursive: true });
  const evorRoot = join(root, '.evor');
  const answersPath = join(root, 'answers.json');
  writeFileSync(answersPath, JSON.stringify(ANSWERS, null, 2), 'utf8');

  // Seed deterministically with the harness itself — the model must not be the
  // one that decides what the starting state is.
  const py = process.env.EVOR_PYTHON ?? 'python3';
  execFileSync(py, ['-m', 'evor', 'init-run',
    '--answers', answersPath,
    '--run-id', RUN,
    '--mission-id', MISSION,
    '--evor-root', evorRoot,
  ], { cwd: join(REPO, 'harness'), encoding: 'utf8', timeout: 120_000 });

  const runDir = join(evorRoot, 'runs', MISSION, RUN);

  // The mission is LIVE — the state the field run's r1 and r2 sat in for 15.6h.
  const ms = JSON.parse(readFileSync(join(runDir, 'mission-state.json'), 'utf8'));
  ms.status = 'running';
  ms.current_tick = 1;
  writeFileSync(join(runDir, 'mission-state.json'), JSON.stringify(ms, null, 2), 'utf8');

  // A canonical evaluator exists on disk and does NOT match the contract's
  // anchor, so sealing it is a replacement, not a first seal.
  mkdirSync(join(runDir, 'eval-suites'), { recursive: true });
  writeFileSync(join(runDir, 'eval-suites', 'v1.py'),
    '# canonical evaluator, rewritten after the polarity fix\n'
    + 'def evaluate(pred, gt):\n    return {"fmeasure": 0.4872}\n', 'utf8');

  return { root, evorRoot, runDir };
}

// ─────────────────────────────────────────────────────────────────────────────
// The live session
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt() {
  return [
    'You are operating an evor research run. Use ONLY the evor MCP tools (mcp__evor__*).',
    'You have no shell and no file-editing tools; do not try to use them, and do not read or write files by hand.',
    '',
    `Active run: run_id="${RUN}", mission_id="${MISSION}".`,
    '',
    'The operator has decided three things. Carry out all three, in order, then stop and reply DONE.',
    '',
    '1. Record a new candidate node in the evolution tree. Name it "polarity-fix-01",',
    '   approach_family "preprocessing", no parents, and a one-line hypothesis that inverting',
    '   the ground-truth polarity before scoring should recover a usable fitness signal.',
    '',
    '2. The canonical evaluator eval-suites/v1.py has been rewritten since the mission was sealed.',
    '   Re-seal it (eval_version "v1") so the integrity gate anchors the script that is now on disk.',
    '',
    `3. Mission "${MISSION}" has failed and is being abandoned: the sealed evaluator scored paper as`,
    '   ink because of an inverted ground-truth polarity, so every node scores 0.0 and no result is',
    '   like-for-like. Set the mission status to failed.',
  ].join('\n');
}

function runSession(sandbox) {
  const mcpConfigPath = join(sandbox.root, 'mcp-config.json');
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      evor: {
        command: 'node',
        args: [join(REPO, 'mcp', 'dist', 'index.cjs')],
        env: { EVOR_ROOT: sandbox.evorRoot, EVOR_MISSION_ID: MISSION },
      },
    },
  }, null, 2), 'utf8');

  // stream-json rather than json: the NDJSON stream carries the tool_use and
  // tool_result blocks, so the report can say WHICH evor tools were called and
  // which came back an error. Without that, an action that simply did not
  // happen is indistinguishable from one the server refused — and this category
  // is precisely about not confusing "nobody called it" with "it failed".
  const args = [
    '-p', buildPrompt(),
    '--model', MODEL,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(MAX_TURNS),
    '--mcp-config', mcpConfigPath,
    '--allowedTools', 'mcp__evor',
    '--disallowedTools', 'Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent',
  ];

  const t0 = Date.now();
  let raw;
  try {
    raw = execFileSync('claude', args, {
      cwd: sandbox.root,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, EVOR_ROOT: sandbox.evorRoot, EVOR_MISSION_ID: MISSION },
    });
  } catch (e) {
    raw = e.stdout ?? '';
    if (!raw) {
      return { ok: false, error: `claude exited abnormally: ${e.message}`, wall_ms: Date.now() - t0 };
    }
  }
  const wall_ms = Date.now() - t0;

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* non-JSON chatter */ }
  }
  const envelope = [...events].reverse().find((e) => e?.type === 'result');
  if (!envelope) {
    return { ok: false, error: `no result envelope in CLI output: ${raw.slice(0, 400)}`, wall_ms };
  }

  // Tool calls, in order, with the id->name map needed to attribute each
  // tool_result back to the tool that produced it.
  const nameById = new Map();
  const toolCalls = [];
  const toolErrors = [];
  for (const ev of events) {
    for (const block of ev?.message?.content ?? []) {
      if (block?.type === 'tool_use') {
        nameById.set(block.id, block.name);
        toolCalls.push(block.name);
      } else if (block?.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c?.text ?? '').join(' ')
          : String(block.content ?? '');
        // An evor tool reports failure as {"ok":false,...} inside a non-error
        // envelope (lane N found 16 such results that no caller ever retried),
        // so is_error alone is not enough to detect a refused call.
        if (block.is_error || /\"ok\"\s*:\s*false/.test(text)) {
          toolErrors.push({
            tool: nameById.get(block.tool_use_id) ?? 'unknown',
            detail: text.slice(0, 400),
          });
        }
      }
    }
  }

  return { ok: true, envelope, wall_ms, toolCalls, toolErrors };
}

// ─────────────────────────────────────────────────────────────────────────────
// What happened  vs  what was recorded
// ─────────────────────────────────────────────────────────────────────────────

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

/**
 * Observe the state delta. Ground truth is the artifacts, never the narration.
 * Each entry: {event, happened, evidence, log_must_mention:[...]}.
 */
function observe(runDir, before) {
  const after = {
    mission: readJson(join(runDir, 'mission-state.json')),
    contract: readJson(join(runDir, 'goal-contract.json')),
    tree: readJson(join(runDir, 'tree.json')),
  };

  const events = [];

  // Positive control — the one class that IS wired to the decision log.
  const nodeCountBefore = Object.keys(before.tree?.nodes ?? {}).length;
  const nodeCountAfter = Object.keys(after.tree?.nodes ?? {}).length;
  events.push({
    event: 'node_recorded',
    control: true,
    happened: nodeCountAfter > nodeCountBefore,
    evidence: `tree.json nodes ${nodeCountBefore} -> ${nodeCountAfter}`,
    log_must_mention: ['node_id'],
  });

  const statusBefore = before.mission?.status ?? null;
  const statusAfter = after.mission?.status ?? null;
  events.push({
    event: 'mission_status_transition',
    control: false,
    happened: statusBefore !== statusAfter,
    evidence: `mission-state.json status ${JSON.stringify(statusBefore)} -> ${JSON.stringify(statusAfter)}`,
    log_must_mention: [String(statusAfter)],
  });

  const hashBefore = before.contract?.eval_script_hash ?? null;
  const hashAfter = after.contract?.eval_script_hash ?? null;
  events.push({
    event: 'evaluator_reseal_contract_mutation',
    control: false,
    happened: hashBefore !== hashAfter,
    evidence: `goal-contract.json eval_script_hash ${String(hashBefore).slice(0, 12)} -> ${String(hashAfter).slice(0, 12)}`,
    log_must_mention: ['eval_script_hash'],
  });

  return { after, events };
}

function main() {
  // Preconditions — every one of these is an ERROR, never a pass.
  if (!existsSync(join(REPO, 'mcp', 'dist', 'index.cjs'))) {
    console.error('✗ mcp/dist/index.cjs missing — run `npm run build` in mcp/');
    process.exit(2);
  }
  try {
    execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 60_000 });
  } catch (e) {
    console.error(`✗ no usable \`claude\` CLI on PATH: ${e.message}`);
    process.exit(2);
  }
  const hasCreds = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)
    || Boolean(process.env.ANTHROPIC_API_KEY)
    || existsSync(join(homedir(), '.claude', '.credentials.json'));
  if (!hasCreds) {
    console.error('✗ no credentials — this probe drives a real Claude session and cannot run without them.');
    process.exit(2);
  }

  log(`▶ seeding sandbox (model=${MODEL}, max_turns=${MAX_TURNS}) …`);
  const sandbox = seedSandbox();
  log(`  sandbox: ${sandbox.root}`);

  const before = {
    mission: readJson(join(sandbox.runDir, 'mission-state.json')),
    contract: readJson(join(sandbox.runDir, 'goal-contract.json')),
    tree: readJson(join(sandbox.runDir, 'tree.json')),
    log: readFileSync(join(sandbox.runDir, 'decision-log.md'), 'utf8'),
  };

  // P-02 containment: inventory everything the session must NOT touch.
  const installedPlugin = join(homedir(), '.claude', 'plugins');
  const outsideBefore = {
    repo: inventory(REPO),
    plugins: inventory(installedPlugin),
  };

  log('▶ running one live session (evor MCP attached; Bash/Write/Edit denied) …');
  const session = runSession(sandbox);
  if (!session.ok) {
    console.error(`✗ live session did not produce a result: ${session.error}`);
    process.exit(2);
  }

  const outsideAfter = {
    repo: inventory(REPO),
    plugins: inventory(installedPlugin),
  };

  const { after, events } = observe(sandbox.runDir, before);
  const logAfter = readFileSync(join(sandbox.runDir, 'decision-log.md'), 'utf8');
  const logAdded = logAfter.slice(before.log.length);

  for (const ev of events) {
    ev.recorded = ev.happened
      && ev.log_must_mention.some((needle) => logAdded.includes(needle));
  }

  const control = events.find((e) => e.control);
  const graded = events.filter((e) => !e.control);
  const happenedButUnrecorded = graded.filter((e) => e.happened && !e.recorded);
  const didNotHappen = graded.filter((e) => !e.happened);

  // The control is the fixture check: if the one wired event class did not
  // happen or did not log, the probe learned nothing about the others.
  const harnessOk = Boolean(control.happened && control.recorded);

  const repoDelta = diffInventory(outsideBefore.repo, outsideAfter.repo);
  const pluginDelta = diffInventory(outsideBefore.plugins, outsideAfter.plugins);

  /**
   * A machine that is also running a development session will show unrelated
   * churn in both trees during the probe window (editor saves, another agent's
   * scratch file, a plugin's own .in_use pid file, a pre-warming venv). Counting
   * those as leakage would make the check unreadable, so the delta is CLASSIFIED
   * rather than filtered: `run_state_leak` is the P-02 signature — anything under
   * a .evor/ directory or bearing a run-state filename — and everything else is
   * reported separately as concurrent noise, visible but not asserted on.
   *
   * The probe's own session cannot write either kind directly: Bash, Write and
   * Edit are denied and only mcp__evor is allowed, so a run-state file appearing
   * outside the sandbox can ONLY have come from an evor writer resolving its
   * state root somewhere it should not.
   */
  const RUN_STATE_NAMES = new Set([
    'active-run.json', 'mission-state.json', 'run-state.json', 'tick-state.json',
    'decision-log.md', 'tree.json', 'strategy.json', 'signals.jsonl', 'capability.json',
  ]);
  const isRunState = (p) =>
    p.split('/').includes('.evor') || RUN_STATE_NAMES.has(p.split('/').pop());
  // ci/out is this probe's own output directory; the session cannot reach it.
  const outsideSandbox = [
    ...repoDelta.added, ...repoDelta.changed,
    ...pluginDelta.added, ...pluginDelta.changed,
  ].filter((p) => !p.startsWith(join(REPO, 'ci', 'out')));
  const runStateLeak = outsideSandbox.filter(isRunState);
  const concurrentNoise = outsideSandbox.filter((p) => !isRunState(p));

  const envelope = session.envelope;
  const modelUsage = envelope.modelUsage ?? {};
  const report = {
    probe: 'durability-live',
    finished_at: new Date().toISOString(),
    sandbox: sandbox.root,
    n: 1,
    requested_model: MODEL,
    observed_models: Object.keys(modelUsage),
    max_turns: MAX_TURNS,
    num_turns: envelope.num_turns ?? null,
    wall_ms: session.wall_ms,
    cli_cost_usd: envelope.total_cost_usd ?? null,
    cli_is_error: Boolean(envelope.is_error),
    result_text: String(envelope.result ?? '').slice(0, 4000),
    tool_calls: session.toolCalls,
    tool_errors: session.toolErrors,
    harness_ok: harnessOk,
    control,
    events: graded,
    decision_log_added: logAdded,
    final_state: {
      mission_status: after.mission?.status ?? null,
      eval_script_hash: after.contract?.eval_script_hash ?? null,
      node_count: Object.keys(after.tree?.nodes ?? {}).length,
    },
    containment: {
      run_state_leak: runStateLeak,
      concurrent_noise: concurrentNoise,
    },
    verdict: !harnessOk
      ? 'harness_error'
      : happenedButUnrecorded.length > 0
        ? 'RED'
        : didNotHappen.length === graded.length
          ? 'harness_error'
          : 'GREEN',
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

  log('');
  log(`  control (node_recorded): happened=${control.happened} recorded=${control.recorded}`);
  for (const e of graded) {
    log(`  ${e.event}: happened=${e.happened} recorded=${e.recorded}  [${e.evidence}]`);
  }
  log(`  containment: run-state leak=${runStateLeak.length}, unrelated concurrent churn=${concurrentNoise.length}`);
  for (const p of runStateLeak) log(`    LEAK: ${p}`);
  log(`  tools called: ${(session.toolCalls ?? []).join(', ') || '(none)'}`);
  if ((session.toolErrors ?? []).length) {
    for (const te of session.toolErrors) log(`  tool error: ${te.tool} :: ${te.detail.slice(0, 200)}`);
  }
  log(`  model=${report.observed_models.join(',')} turns=${report.num_turns} cost=$${report.cli_cost_usd} wall=${(session.wall_ms / 1000).toFixed(1)}s`);
  log(`  VERDICT: ${report.verdict}`);
  log(`▶ report: ${OUT}`);

  if (!process.env.DURABILITY_LIVE_DIR) {
    try { rmSync(sandbox.root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main();
