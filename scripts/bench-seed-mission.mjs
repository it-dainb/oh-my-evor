#!/usr/bin/env node
/**
 * scripts/bench-seed-mission.mjs — seed a CPU-only evor mission for the Phase 2
 * measurement gate.
 *
 *   node scripts/bench-seed-mission.mjs <bench-root>
 *
 * Phase 2 needs ONE clean tick, measured. The blocker was never the tick itself —
 * it was getting to it: run 29d17abc spent 2h03m and 30 AskUserQuestion rounds in
 * setup before tick 1, inside a charter that declares zero human-in-the-loop.
 * Seeding the mission directly removes the interview from the measurement, so what
 * gets measured is the tick loop rather than the setup conversation.
 *
 * The mission is created by calling the same evor_* MCP tools the agents call, over
 * the same stdio transport. Writing the run layout by hand would measure a shape the
 * agents never produce.
 *
 * CPU-only by construction: synthetic tabular classification, sklearn-class models,
 * no GPU anywhere in the contract or the evaluator.
 */

import { spawn, spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH_ROOT = resolve(process.argv[2] ?? join(REPO, '.evor-bench'));
const EVOR_ROOT = join(BENCH_ROOT, '.evor');

const MISSION_ID = 'bench-cpu-tabular';
// Phase 3a.2 measures whether main's per-tick context residue stays FLAT across
// ticks. That is only observable across several ticks in ONE session, so the tick
// count is a parameter rather than a hardcoded 1.
const TICKS = Number(process.env.BENCH_TICKS ?? 1);

/** Mirrors resolveRunPaths(): runs nest under the mission when one is known. */
const runPaths = (runId) => ({ runDir: join(EVOR_ROOT, 'runs', MISSION_ID, runId) });
const EVAL_VERSION = 'v1';
// freeze_splits hashes real files, so the dataset must exist on disk. It is
// generated from the evaluator's OWN generator (below) — regenerating it
// independently could freeze samples the evaluator never scores, producing a
// split that guards nothing.
const DATASET_DIR = join(BENCH_ROOT, 'dataset');
const DATASET_REF = DATASET_DIR;

// ── MCP client over stdio ────────────────────────────────────────────────────

function makeClient() {
  const child = spawn('node', [join(REPO, 'mcp', 'dist', 'index.cjs')], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, EVOR_ROOT },
  });
  child.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) process.stderr.write(`[mcp] ${s}\n`);
  });

  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });

  let nextId = 1;
  const send = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pending.delete(id)) rej(new Error(`${method} timed out`)); }, 120_000);
    });

  return {
    async init() {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'evor-bench-seed', version: '0' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    /** Call a tool; throws on transport error or on an `ok: false` payload. */
    async call(name, args) {
      const msg = await send('tools/call', { name, arguments: args });
      if (msg.error) throw new Error(`${name}: ${JSON.stringify(msg.error)}`);
      const text = msg.result?.content?.map((c) => c.text).join('') ?? '';
      let payload;
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      // The server signals failure two ways: `{ ok: false, ... }` from validate-style
      // tools and a bare `{ error: "..." }` from err(). Checking only the first
      // silently passed a failed evor_seal_eval_script as success on the first run
      // of this script — the same "absence of a failure flag is not success" trap
      // the plan flags for artifact reads (P4.3).
      if (payload?.ok === false || payload?.error) {
        throw new Error(`${name} failed: ${text.slice(0, 400)}`);
      }
      return payload;
    },
    close() { try { child.kill(); } catch { /* already gone */ } },
  };
}

// ── The mission ──────────────────────────────────────────────────────────────

const goalContract = {
  mission_id: MISSION_ID,
  mode: 'from-scratch',
  mission_type: 'fixed',
  task_description:
    'Binary tabular classification on a deterministic synthetic churn dataset ' +
    '(800 samples x 10 features, seed=42; train 0-479, val 480-639, test 640-799). ' +
    'The target is deliberately non-linear (XOR-like), so a depth-limited tree can ' +
    'beat a linear model. CPU only: the evaluator trains from the Python standard ' +
    'library alone — no GPU, no torch, no sklearn.',
  dataset_ref: DATASET_REF,
  metric_specs: [
    {
      metric_name: 'accuracy',
      direction: 'higher',
      domain_applicability: 'all',
      aggregation_rule: 'macro_avg',
      role: 'primary_fitness',
    },
  ],
  fitness_mode: 'aggregate',
  eval_version: EVAL_VERSION,
  // Measured majority-class rate on the frozen test split (test positive rate is
  // 0.450, so always-predict-negative scores 0.550). Beating it is a real if low
  // bar; this run exists to measure the loop, not to find a strong model.
  baseline_value: 0.55,
  target_value: 0.85,
  stop_condition: { type: 'evolve-n', n: TICKS },
  wildness: 0.3,
  budget: {
    max_iterations: TICKS,
    plateau_window: 3,
    circuit_breaker: 5,
    max_cost_usd: 25,
    max_wall_clock_hours: 2,
  },
  framework: 'python-stdlib',
  allowed_licenses: ['MIT', 'BSD-3-Clause', 'Apache-2.0'],
};

async function main() {
  if (!existsSync(join(REPO, 'mcp', 'dist', 'index.cjs'))) {
    throw new Error('mcp/dist/index.cjs missing — run `npm run build` first');
  }
  mkdirSync(EVOR_ROOT, { recursive: true });

  // Materialise the dataset from the evaluator's generator before anything else.
  if (!existsSync(DATASET_DIR)) {
    mkdirSync(DATASET_DIR, { recursive: true });
    const gen = spawnSync('python3', ['-c', `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("ev", ${JSON.stringify(join(REPO, 'benchmarks', 'tabular-churn', 'evaluate.py'))})
ev = importlib.util.module_from_spec(spec); spec.loader.exec_module(ev)
X, y = ev._make_dataset()
out = Path(${JSON.stringify(DATASET_DIR)})
for i in range(len(X)):
    (out / f"{i}.json").write_text(json.dumps({"x": X[i], "y": y[i]}, sort_keys=True))
print(len(X))
`], { encoding: 'utf8' });
    if (gen.status !== 0) throw new Error(`dataset generation failed: ${gen.stderr}`);
    console.log(`  \u2713 dataset materialised (${gen.stdout.trim()} samples)`);
  }

  const mcp = makeClient();
  await mcp.init();
  const steps = [];
  const step = async (label, fn) => {
    const r = await fn();
    steps.push({ label, ok: true });
    console.log(`  ✓ ${label}`);
    return r;
  };

  try {
    const init = await step('init_run', () =>
      mcp.call('evor_init_run', { answers: goalContract, mission_id: MISSION_ID }));
    const runId = init.run_id ?? init.runId ?? init.data?.run_id;
    if (!runId) throw new Error(`no run_id in init_run response: ${JSON.stringify(init).slice(0, 300)}`);
    console.log(`    run_id = ${runId}`);

    await step('init_eval_suite', () =>
      mcp.call('evor_init_eval_suite', {
        mission_id: MISSION_ID,
        eval_version: EVAL_VERSION,
        task_description: goalContract.task_description,
        run_id: runId,
      }));

    await step('freeze_splits', () =>
      mcp.call('evor_freeze_splits', {
        dataset_ref: DATASET_REF,
        eval_version: EVAL_VERSION,
        run_id: runId,
        mission_id: MISSION_ID,
      }));

    // A from-scratch mission has no evaluator until the run authors one, so
    // evor_seal_eval_script fails closed until the script exists. For a benchmark
    // the evaluator is not what is under test — the tick loop is — so the repo's
    // real CPU-only tabular evaluator is installed as the canonical script.
    // Zero third-party deps: it trains genuine models from the stdlib, so no GPU
    // and no torch/sklearn anywhere in the measured path.
    await step('install canonical CPU evaluator', async () => {
      const { runDir } = runPaths(runId);
      const dest = join(runDir, 'eval-suites', `${EVAL_VERSION}.py`);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(REPO, 'benchmarks', 'tabular-churn', 'evaluate.py'), dest);
      return { dest };
    });

    await step('seal_eval_script', () =>
      mcp.call('evor_seal_eval_script', {
        run_id: runId,
        eval_version: EVAL_VERSION,
        mission_id: MISSION_ID,
      }));

    await step('lock_mission', () =>
      mcp.call('evor_lock_mission', { run_id: runId, mission_id: MISSION_ID }));

    const validate = await step('validate', () => mcp.call('evor_validate', { run_id: runId }));

    // Preflight is ADVISORY here, not a gate. evor_validate and evor_lock_mission
    // are the real gates and both passed above.
    //
    // Finding: evor_preflight hard-requires PyTorch ("Preflight smoke-test requires
    // PyTorch") regardless of what the mission declares. This contract declares
    // framework: python-stdlib and its evaluator imports nothing outside the
    // standard library, so on a CPU image with no torch the smoke test blocks a
    // mission it has no bearing on. Treated as advisory rather than worked around
    // silently — the limitation is real and belongs in the report.
    let preflight;
    try {
      preflight = await step('preflight', () =>
        mcp.call('evor_preflight', { run_id: runId, no_gpu_check: true }));
    } catch (e) {
      preflight = { skipped: true, reason: e.message };
      console.log(`  ~ preflight skipped (advisory): ${e.message.slice(0, 160)}`);
    }

    // active-run.json is what every hook resolves through (Phase 0.1) and what
    // /evor-run reads to resume.
    writeFileSync(
      join(EVOR_ROOT, 'active-run.json'),
      JSON.stringify({ run_id: runId, mission_id: MISSION_ID }, null, 2),
    );

    console.log('\nseeded:');
    console.log(JSON.stringify({ run_id: runId, mission_id: MISSION_ID, evor_root: EVOR_ROOT,
      validate: validate?.ok ?? validate, preflight: preflight?.ok ?? preflight }, null, 2));
  } finally {
    mcp.close();
  }
}

main().catch((e) => {
  console.error(`\nSEED FAILED: ${e.message}`);
  process.exit(1);
});
