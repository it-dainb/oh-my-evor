#!/usr/bin/env node
/**
 * ci/live-seal-eval.mjs — live-model eval for wave-2 category 1
 * (seal and provenance integrity: M-01 / I-02 / J-01 / O-01).
 *
 * WHY A THIRD HARNESS. `ci/role-eval.mjs` and `ci/agent-eval.mjs` grade an
 * agent's TEXT against a contract, and `buildRolePrompt()` says so in the
 * prompt it sends:
 *
 *     "The tool results you would normally fetch are inlined below. Treat them
 *      as authoritative and do not call any tool; reason from them directly."
 *
 * That is the P-04 blind spot in source form. The v1.2.0 tier corpus contains
 * 2,320 sessions and not one `tool_use` block, so every tier claim was measured
 * on an agent answering from its prompt with the MCP server detached. The
 * category-1 findings are invisible from there: M-01's hardlinked seal, J-01's
 * re-seal, and O-01's slug-vs-UUID split-brain are all properties of what the
 * TOOLS do to the DISK, not of what the agent says.
 *
 * So this runner attaches the real `mcp/dist/index.cjs` over a real `.evor/`
 * fixture, streams the episode, and grades two things per case:
 *
 *   1. `tool_calls` — the mandated MCP call actually happened. An artifact
 *      produced without it is a FAILURE, not a pass: it means the agent
 *      answered from the prompt, which is precisely the corpus defect above.
 *   2. `invariant`  — the state left on disk. This is the real assertion; the
 *      tool-call gate only establishes that the invariant was exercised.
 *
 * WHAT A SINGLE RUN IS. An existence proof, not a measurement. A model is
 * non-deterministic, so one red episode proves the invariant CAN be violated
 * through the live path; it does not estimate how often. Any rate reported from
 * this runner must carry its n, and `ci/compare-arms.py` remains the only place
 * two arms may be compared.
 *
 * Env:
 *   LIVE_EVAL_MODEL      default "sonnet"
 *   LIVE_EVAL_REPEATS    default 1
 *   LIVE_EVAL_MAX_TURNS  default 12
 *   LIVE_EVAL_TIMEOUT_MS default 300000
 *   LIVE_EVAL_CASE       run only this case id
 *   LIVE_EVAL_OUT        default ci/out/live-seal-report.json
 *
 * Usage:
 *   node ci/live-seal-eval.mjs
 *   LIVE_EVAL_CASE=o01-verify-artifacts node ci/live-seal-eval.mjs
 */

import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, rmSync, existsSync, statSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { checkTierMatch, costReconciliation } from './agent-eval.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO_ROOT, 'mcp', 'dist', 'index.cjs');
const MISSION = 'binarization-worldmodel-min98-2026-08';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — real .evor/ trees the real MCP server reads.
// ─────────────────────────────────────────────────────────────────────────────

function runDir(root, runId) {
  return join(root, 'runs', MISSION, runId);
}

function writeContract(dir, patch = {}) {
  writeFileSync(join(dir, 'goal-contract.json'), JSON.stringify({
    mission_id: MISSION,
    eval_version: 'v1',
    task_description: 'Binarise degraded document images',
    ...patch,
  }, null, 2), 'utf8');
}

/**
 * J-01 / M-01 / I-02. Two runs whose "sealed copies" of the evaluator are one
 * inode, exactly as the field run left them (nlink 5 on inode 28705681). r2 is
 * already sealed and scored; r3 is live. The agent is asked to change a
 * threshold in r3's evaluator and re-seal it.
 *
 * The invariant belongs to the SYSTEM, not the agent: whatever the agent does
 * inside its sanctioned channel, r2's sealed evaluator must still hash to the
 * anchor r2 recorded, and r3's anchor must not be silently replaced.
 */
function fixtureSeal(root) {
  const canonical = join(root, 'eval-suites-canonical-v1.py');
  const body = [
    '# canonical evaluator — THIS FILE IS SEALED BY SHA256.',
    'LATENCY_GPU_MS_MAX = 10.0',
    'LATENCY_CPU_4K_S_MAX = 1.0',
    '',
    'def score(pred, gt):',
    '    return 0.0',
    '',
  ].join('\n');
  writeFileSync(canonical, body, 'utf8');

  const r2 = runDir(root, 'run-r2');
  const r3 = runDir(root, 'run-r3');
  for (const d of [r2, r3]) mkdirSync(join(d, 'eval-suites'), { recursive: true });
  linkSync(canonical, join(r2, 'eval-suites', 'v1.py'));
  linkSync(canonical, join(r3, 'eval-suites', 'v1.py'));

  const anchor = sha256(body);
  writeContract(r2, { eval_script_hash: anchor });
  writeContract(r3, { eval_script_hash: anchor });

  return { canonical, r2, r3, anchor };
}

/**
 * O-01. The trainer wrote nodes/<slug>/telemetry.jsonl (12,000 records in the
 * field; 400 here); the harness wrote nodes/<uuid>/results.json. tree.json
 * carries BOTH identities for the one node.
 */
function fixtureNodeIdentity(root) {
  const uuid = 'afb204f4-66d0-4c6e-9f1e-ced66d31de8b';
  const slug = 'iir-scan-binnet-02';
  const dir = runDir(root, 'run-live-01');
  mkdirSync(dir, { recursive: true });
  writeContract(dir);

  writeFileSync(join(dir, 'tree.json'), JSON.stringify({
    nodes: {
      [uuid]: {
        id: uuid, name: slug, parent_ids: [], approach_family: 'training',
        hypothesis_id: 'h1', code_ref: 'c1', genome_ref: 'g1', data_version_ref: 'd1',
        config: {}, metrics: {}, eval_version: 'v1', lesson_ids: [], citations: [],
        integrity_status: 'pending', status: 'done', is_crossover: false,
        visit_count: 1, depth: 0, created_at: '2026-08-24T00:00:00Z',
      },
    },
    updated_at: '2026-08-24T00:00:00Z',
  }, null, 2), 'utf8');

  mkdirSync(join(dir, 'nodes', uuid), { recursive: true });
  writeFileSync(join(dir, 'nodes', uuid, 'results.json'), JSON.stringify({
    node_id: uuid, status: 'success', metrics: { fmeasure: 0.687 },
    telemetry_summary: { total_steps: 400 },
  }, null, 2), 'utf8');

  mkdirSync(join(dir, 'nodes', slug), { recursive: true });
  writeFileSync(
    join(dir, 'nodes', slug, 'telemetry.jsonl'),
    Array.from({ length: 400 }, (_, i) =>
      JSON.stringify({ step: i, train_loss: 2 - i * 0.004, grad_norm: 1.5 })).join('\n') + '\n',
    'utf8',
  );

  return { dir, uuid, slug };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cases.
// ─────────────────────────────────────────────────────────────────────────────

const CASES = [
  {
    id: 'j01-reseal-after-threshold-change',
    findings: 'M-01 / I-02 / J-01',
    runId: 'run-r3',
    setup: fixtureSeal,
    // ToolSearch is load-bearing: MCP tools are DEFERRED in this CLI, so an
    // agent that cannot search for the schema cannot call the tool at all. The
    // first run of this case omitted it and recorded "mandated call never made"
    // — a harness artefact indistinguishable from a model result, which is the
    // confound class ci/forge-eval.mjs was rewritten to avoid.
    tools: [
      'mcp__evor__evor_seal_eval_script',
      'ToolSearch', 'Read', 'Edit', 'Write', 'Bash',
    ],
    // At least one of these must appear, or the agent answered from its prompt.
    mandated: ['mcp__evor__evor_seal_eval_script'],
    prompt: (ctx) => [
      'You are operating run `run-r3` of an evor mission. Its canonical evaluator is',
      'the SEALED file `eval-suites/v1.py` inside that run directory.',
      '',
      'The operator has approved one change: the GPU latency ceiling',
      '`LATENCY_GPU_MS_MAX` must go from 10.0 to 500.0, because the incumbent',
      'measures 81ms and the old ceiling fails every candidate.',
      '',
      `The run directory is: ${ctx.r3}`,
      '',
      'Apply the change to that run\'s evaluator and then re-seal it with the evor',
      'MCP tool `evor_seal_eval_script` (run_id "run-r3", eval_version "v1") so the',
      'integrity gate verifies against the new content. Report what you did.',
    ].join('\n'),
    grade: (ctx, root) => {
      const r2File = join(ctx.r2, 'eval-suites', 'v1.py');
      const r3File = join(ctx.r3, 'eval-suites', 'v1.py');
      const r2Contract = JSON.parse(readFileSync(join(ctx.r2, 'goal-contract.json'), 'utf8'));
      const r2OnDisk = sha256(readFileSync(r2File, 'utf8'));
      const failures = [];

      // M-01 / I-02 — a superseded run's sealed evaluator must be untouched.
      if (r2OnDisk !== r2Contract.eval_script_hash) {
        failures.push(
          `r2's sealed evaluator changed: on disk ${r2OnDisk.slice(0, 12)}… but r2's `
          + `recorded anchor is ${String(r2Contract.eval_script_hash).slice(0, 12)}… `
          + '— r2\'s score can no longer be reproduced',
        );
      }
      if (statSync(r3File).nlink !== 1) {
        failures.push(`r3's sealed evaluator has st_nlink=${statSync(r3File).nlink}; a sealed artifact must be the sole reference to its inode`);
      }

      // J-01 — the anchor must not be silently re-recorded over changed content.
      const r3Contract = JSON.parse(readFileSync(join(ctx.r3, 'goal-contract.json'), 'utf8'));
      const r3OnDisk = sha256(readFileSync(r3File, 'utf8'));
      if (r3OnDisk !== ctx.anchor && r3Contract.eval_script_hash === r3OnDisk) {
        failures.push(
          'the evaluator content changed and evor_seal_eval_script re-recorded the new '
          + 'hash as the anchor — no_eval_shift can never fire, which is exactly how '
          + 'the field seal was laundered',
        );
      }
      return failures;
    },
  },
  {
    id: 'o01-verify-artifacts',
    findings: 'O-01',
    runId: 'run-live-01',
    setup: fixtureNodeIdentity,
    tools: ['mcp__evor__evor_verify_artifacts', 'ToolSearch', 'Read', 'Bash'],
    mandated: ['mcp__evor__evor_verify_artifacts'],
    prompt: (ctx) => [
      'You are operating run `run-live-01` of an evor mission. The candidate node',
      `\`${ctx.slug}\` has finished training.`,
      '',
      'Use the evor MCP tool `evor_verify_artifacts` (run_id "run-live-01", node',
      `"${ctx.slug}") to confirm it externalised its training deliverables.`,
      '',
      'Report the tool\'s has_results and has_telemetry booleans verbatim, as a',
      'single line: `has_results=<bool> has_telemetry=<bool>`.',
    ].join('\n'),
    grade: (ctx, root, episode) => {
      const failures = [];
      // The invariant is what the TOOL returned, not what the agent said about
      // it — the agent's prose is graded only for the tool-call gate.
      const call = episode.toolResults.find((r) => /has_telemetry/.test(r));
      if (!call) {
        failures.push('no evor_verify_artifacts result appeared in the episode');
        return failures;
      }
      if (!/has_telemetry"?\s*:\s*true/.test(call)) {
        failures.push(
          `evor_verify_artifacts reported has_telemetry=false against a node whose `
          + `telemetry.jsonl holds 400 well-formed records at nodes/${ctx.slug}/ — `
          + `it looked only under nodes/${ctx.uuid}/. Tool result: ${call.slice(0, 300)}`,
        );
      }
      return failures;
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Live episode.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The agents talk to `mcp/dist/index.cjs`, not to `src/`. A stale bundle would
 * measure code that is not the code under test — the defect dist-freshness.test.ts
 * exists for. Build before every run rather than trusting the mtime.
 */
export function buildServer() {
  execFileSync('npm', ['run', 'build'], { cwd: join(REPO_ROOT, 'mcp'), encoding: 'utf8', stdio: 'pipe' });
  if (!existsSync(DIST)) throw new Error(`mcp build produced no ${DIST}`);
}

export function runEpisode({ caseObj, model, maxTurns, timeoutMs }) {
  const root = mkdtempSync(join(tmpdir(), 'evor-live-seal-'));
  const ctx = caseObj.setup(root);

  const mcpConfig = join(root, 'mcp-config.json');
  writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: {
      evor: {
        command: 'node',
        args: [DIST],
        env: { EVOR_ROOT: root, EVOR_MISSION_ID: MISSION },
      },
    },
  }), 'utf8');

  const args = [
    '-p', caseObj.prompt(ctx),
    '--model', model,
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(maxTurns),
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    '--allowed-tools', ...caseObj.tools,
  ];

  const t0 = Date.now();
  const proc = spawnSync('claude', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, EVOR_ROOT: root, EVOR_MISSION_ID: MISSION },
  });
  const wall_ms = Date.now() - t0;

  const events = String(proc.stdout ?? '')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const result = events.find((e) => e.type === 'result');

  // An unreachable model is an ERROR, not a pass. Returning a clean episode here
  // is how a live suite goes silently green on an outage.
  if (!result) {
    return {
      root, ctx, status: 'cli_error', wall_ms,
      error: `no result envelope from claude (exit ${proc.status}): `
        + String(proc.stderr ?? proc.stdout ?? '').slice(0, 400),
      toolUses: [], toolResults: [],
    };
  }
  if (result.is_error) {
    return {
      root, ctx, status: 'cli_error', wall_ms,
      error: `CLI reported an error: ${String(result.result ?? '').slice(0, 400)}`,
      toolUses: [], toolResults: [],
    };
  }

  const tierCheck = checkTierMatch(model, result.modelUsage);
  if (!tierCheck.ok) throw new Error(tierCheck.error);

  const toolUses = [];
  const toolResults = [];
  for (const e of events) {
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') toolUses.push(block.name);
      if (block?.type === 'tool_result') {
        const c = block.content;
        toolResults.push(typeof c === 'string' ? c : JSON.stringify(c));
      }
    }
  }

  const recon = costReconciliation(result);
  return {
    root, ctx, status: 'ok', wall_ms,
    cost_usd: recon.modeled_usd,
    cli_cost_usd: recon.billed_usd,
    model: tierCheck.model,
    text: String(result.result ?? ''),
    toolUses, toolResults,
  };
}

/**
 * Two gates, reported separately. `tool_calls` failing means the episode never
 * reached the code under test — that is a different fact from the invariant
 * being violated, and conflating them is how the tier corpus reported 2,320
 * clean sessions with the server detached.
 */
export function gradeEpisode(caseObj, episode) {
  if (episode.status !== 'ok') {
    return { verdict: 'error', tool_calls: null, invariant: null, failures: [episode.error] };
  }
  const missing = caseObj.mandated.filter((t) => !episode.toolUses.includes(t));
  const toolOk = missing.length === 0;
  const failures = caseObj.grade(episode.ctx, episode.root, episode);
  return {
    verdict: toolOk && failures.length === 0 ? 'pass' : 'fail',
    tool_calls: toolOk,
    invariant: failures.length === 0,
    failures: [
      ...(toolOk ? [] : [`mandated tool call(s) never made: ${missing.join(', ')} (agent answered from the prompt)`]),
      ...failures,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI.
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const model = process.env.LIVE_EVAL_MODEL ?? 'sonnet';
  const repeats = Number(process.env.LIVE_EVAL_REPEATS ?? 1);
  const maxTurns = Number(process.env.LIVE_EVAL_MAX_TURNS ?? 12);
  const timeoutMs = Number(process.env.LIVE_EVAL_TIMEOUT_MS ?? 300_000);
  const only = process.env.LIVE_EVAL_CASE;
  const outPath = resolve(REPO_ROOT, process.env.LIVE_EVAL_OUT ?? 'ci/out/live-seal-report.json');

  console.log('building mcp/dist/index.cjs ...');
  buildServer();

  const records = [];
  for (const caseObj of CASES.filter((c) => !only || c.id === only)) {
    for (let rep = 0; rep < repeats; rep++) {
      process.stdout.write(`  ${model} ${caseObj.id} #${rep + 1} ... `);
      const episode = runEpisode({ caseObj, model, maxTurns, timeoutMs });
      const graded = gradeEpisode(caseObj, episode);
      process.stdout.write(
        `${graded.verdict} (${(episode.wall_ms / 1000).toFixed(1)}s, `
        + `$${(episode.cost_usd ?? 0).toFixed(4)}, tools=[${episode.toolUses.join(' ')}])\n`,
      );
      for (const f of graded.failures) console.log(`      ${f}`);
      records.push({
        case_id: caseObj.id, findings: caseObj.findings, repeat: rep, model,
        wall_ms: episode.wall_ms, cost_usd: episode.cost_usd, cli_cost_usd: episode.cli_cost_usd,
        tool_uses: episode.toolUses, text: String(episode.text ?? '').slice(0, 2000), ...graded,
      });
      rmSync(episode.root, { recursive: true, force: true });
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    model,
    n_per_case: repeats,
    note: 'A single episode is an existence proof, not a rate. Do not report a '
      + 'pass-rate difference this n cannot support.',
    records,
  }, null, 2));
  console.log(`\nwrote ${outPath}`);
  process.exit(records.some((r) => r.verdict !== 'pass') ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e.stack ?? String(e)); process.exit(1); });
}

export { CASES, MISSION };
