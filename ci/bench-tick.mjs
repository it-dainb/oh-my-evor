#!/usr/bin/env node
/**
 * ci/bench-tick.mjs — Phase 2 measurement, run INSIDE the container.
 *
 *   node ci/bench-tick.mjs            (invoked by ci/bench-tick.sh)
 *
 * Seeds a CPU-only mission, drives exactly one tick of the real agent loop with a
 * real Claude, then measures it. Emits telemetry to ci/out/.
 *
 * Why in a container rather than on the host: the tick runs under
 * `--permission-mode bypassPermissions`, because that is the mode the failed run
 * used and the mode the governor's `deny` has to survive. Under it, only the
 * governor and the .evor write-guard stand between an agent and the filesystem —
 * and `evor-forge-junior` is *supposed* to author code. Pointing that at a working
 * repo makes source files collateral. Here the mission lives in /bench (throwaway),
 * the working directory IS /bench, and /plugin is the image's own copy, so nothing
 * the run does can reach the developer's checkout.
 *
 * Wall-clock note: the evaluator trains from the Python standard library in ~0.5s,
 * so training cannot dominate this tick. Whatever wall-clock this run shows is
 * agent and review overhead — which is precisely the AC9 "<60%" branch, and the
 * branch under which Phase 3b's extra hop has to be re-costed.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, copyFileSync } from 'fs';
import { join } from 'path';

const PLUGIN = '/plugin';
// Overridable because the container runs as the HOST uid (see ci/bench-tick.sh):
// an arbitrary uid owns no directory at /, so the mission scratch lives under
// /tmp, which is world-writable.
const BENCH = process.env.BENCH_DIR ?? '/tmp/bench';
const TICKS = Number(process.env.BENCH_TICKS ?? 1);
const OUT = join(PLUGIN, 'ci', 'out');
const EVOR_ROOT = join(BENCH, '.evor');

const log = (m) => console.log(m);
const fail = (m) => { console.error(`\nBENCH FAILED: ${m}`); process.exit(1); };

mkdirSync(BENCH, { recursive: true });
mkdirSync(OUT, { recursive: true });

// The runtime limits are read from the working directory's settings, and the
// working directory is /bench — so they have to travel with it or the run
// silently inherits defaults, which is the exact thing Phase 6 forbids.
mkdirSync(join(BENCH, '.claude'), { recursive: true });
copyFileSync(join(PLUGIN, '.claude', 'settings.json'), join(BENCH, '.claude', 'settings.json'));

// ── 1. Seed ──────────────────────────────────────────────────────────────────
log('▶ seeding CPU mission …');
const seed = spawnSync('node', [join(PLUGIN, 'scripts', 'bench-seed-mission.mjs'), BENCH], {
  cwd: PLUGIN, encoding: 'utf8', timeout: 600_000,
});
process.stdout.write(seed.stdout ?? '');
if (seed.status !== 0) fail(`seed failed:\n${seed.stderr}`);

const activeRun = JSON.parse(readFileSync(join(EVOR_ROOT, 'active-run.json'), 'utf8'));
const runDir = join(EVOR_ROOT, 'runs', activeRun.mission_id, activeRun.run_id);
log(`  run_id = ${activeRun.run_id}`);

// ── 2. One tick, real agents ─────────────────────────────────────────────────
const sessionsRoot = join(process.env.HOME ?? '/root', '.claude', 'projects');
const before = new Set();
const walk = (d) => {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) before.add(p);
  }
};
walk(sessionsRoot);

const PROMPT = [
  'Read the file skills/evor-run/SKILL.md inside the oh-my-evor plugin and follow it exactly.',
  'The mission is already set up, locked and validated: EVOR_ROOT is set and',
  '.evor/active-run.json names the active run (mission bench-cpu-tabular).',
  'Do NOT run setup and do NOT ask any questions.',
  `Resume the existing run and execute exactly ${TICKS} tick(s) of the evolution loop end to end,`,
  'then stop. This is a CPU-only mission: never request or assume a GPU.',
].join(' ');

log(`▶ running ${TICKS} tick(s) with a real Claude (bypassPermissions) …`);
const t0 = Date.now();
const tick = spawnSync('claude', [
  '--plugin-dir', PLUGIN,
  '--permission-mode', 'bypassPermissions',
  '--max-turns', String(process.env.BENCH_MAX_TURNS ?? 150),
  '--output-format', 'json',
  '-p', PROMPT,
], {
  cwd: BENCH,                       // agent writes land here, never in the checkout
  encoding: 'utf8',
  timeout: Number(process.env.BENCH_TIMEOUT_MS ?? 3_600_000),
  maxBuffer: 64 * 1024 * 1024,
  input: '',
  env: { ...process.env, EVOR_ROOT, EVOR_MISSION_ID: activeRun.mission_id },
});
const wallMs = Date.now() - t0;

const rawOut = `${tick.stdout ?? ''}`;
const rawErr = `${tick.stderr ?? ''}`;
writeFileSync(join(OUT, 'bench-tick-raw.json'), rawOut);
if (rawErr.trim()) writeFileSync(join(OUT, 'bench-tick-stderr.txt'), rawErr);

// Fail loud. The first attempt printed "wall-clock 0.4s / exit 0" for a CLI that
// refused to start at all (bypassPermissions is rejected under root), because
// stderr was discarded and a missing result envelope was treated as a soft miss.
// A benchmark that reports success when it measured nothing is worse than no
// benchmark.
if (tick.error) fail(`could not launch claude: ${tick.error.message}`);
if (!rawOut.trim()) {
  fail(`claude produced no output (exit ${tick.status}).\nstderr: ${rawErr.slice(0, 800) || '(empty)'}`);
}

let result = null;
try {
  result = JSON.parse(rawOut.slice(rawOut.indexOf('{')));
} catch {
  fail(`unparseable CLI result envelope; raw output in ci/out/bench-tick-raw.json\n${rawOut.slice(0, 500)}`);
}
if (result?.is_error) {
  log(`  ! CLI reported an error: ${result.subtype} — ${String(result.result ?? '').slice(0, 300)}`);
}

log(`  wall-clock ${(wallMs / 1000).toFixed(1)}s · turns ${result?.num_turns ?? '?'} · ` +
    `cost $${(result?.total_cost_usd ?? 0).toFixed(4)} · ${result?.subtype ?? 'unknown'}`);

// ── 3. Measure ───────────────────────────────────────────────────────────────
const after = [];
walk2(sessionsRoot);
function walk2(d) {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk2(p);
    else if (e.name.endsWith('.jsonl') && !before.has(p)) after.push(p);
  }
}
after.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

let telemetry = null;
if (after.length === 0) {
  log('  ! no new session transcript found — token/turn telemetry unavailable');
} else {
  log(`▶ analysing ${after.length} new session transcript(s) …`);
  const an = spawnSync('node', [join(PLUGIN, 'scripts', 'session-analyze.mjs'), ...after], {
    encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (an.status === 0) {
    telemetry = JSON.parse(an.stdout);
  } else {
    log(`  ! analyzer failed: ${an.stderr?.slice(0, 300)}`);
  }
}

// ── 4. What the tick actually produced ───────────────────────────────────────
const artifacts = [];
const collect = (d, rel = '') => {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) collect(join(d, e.name), r);
    else artifacts.push({ path: r, bytes: statSync(join(d, e.name)).size });
  }
};
collect(join(runDir, 'ticks'));

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const tree = readJson(join(runDir, 'tree.json'));
const nodeCount = tree?.nodes ? Object.keys(tree.nodes).length : 0;

const report = {
  run_id: activeRun.run_id,
  mission_id: activeRun.mission_id,
  cli_result: result && {
    subtype: result.subtype, is_error: result.is_error,
    num_turns: result.num_turns, total_cost_usd: result.total_cost_usd,
    duration_ms: result.duration_ms,
    permission_denials: (result.permission_denials ?? []).length,
  },
  wall_clock_seconds: Math.round(wallMs / 1000),
  telemetry,
  tick_artifacts: artifacts,
  tree_nodes: nodeCount,
  mission_state: readJson(join(runDir, 'mission-state.json')),
  // AC2 is orchestrator leaf calls = 0; AC1 is hooks firing at all.
  acceptance: telemetry && {
    ac1_hook_fires: telemetry.hooks.total_fires,
    ac2_orchestrator_leaf_calls: telemetry.ac2.orchestrator_leaf_tool_calls,
    spawns_total: telemetry.spawns.total,
    spawns_named: telemetry.spawns.named,
  },
};

writeFileSync(join(OUT, 'bench-tick-report.json'), JSON.stringify(report, null, 2));

log('\n── Phase 2 measurement ──────────────────────────────────────────');
if (report.acceptance) {
  log(`  AC1 hook fires              ${report.acceptance.ac1_hook_fires}      (was 0)`);
  log(`  AC2 orchestrator leaf calls ${report.acceptance.ac2_orchestrator_leaf_calls}      (was 152, target 0)`);
  log(`  spawns (named / total)      ${report.acceptance.spawns_named} / ${report.acceptance.spawns_total}   (was 7/7 named)`);
}
if (telemetry) {
  log(`  turns                       ${telemetry.totals.turns}      (was 287)`);
  log(`  cache-read tokens           ${(telemetry.totals.cache_read_input_tokens / 1e6).toFixed(2)}M   (was 82.4M)`);
  log(`  modelled cost               $${telemetry.cost.total.toFixed(2)}   (was $52.13)`);
}
log(`  wall-clock                  ${report.wall_clock_seconds}s   (was 13319s)`);
log(`  tree nodes / tick artifacts ${nodeCount} / ${artifacts.length}`);
log('  report: ci/out/bench-tick-report.json\n');
