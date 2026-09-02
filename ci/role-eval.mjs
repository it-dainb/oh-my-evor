/**
 * ci/role-eval.mjs — one runner for every role, driven by a spec file.
 *
 * `node ci/role-eval.mjs evals/probe/spec.json`
 *
 * The spec supplies the agent file, the output contract and the cases; this
 * file supplies only the live CLI plumbing that `ci/agent-eval.mjs` and
 * `ci/forge-gate-eval.mjs` had each copied for themselves. Scoring logic lives
 * in ci/eval-core.mjs and is unit-tested there — nothing in this file is
 * reachable from the test suite, by design.
 *
 * Env:
 *   ROLE_EVAL_TIERS    "sonnet:medium,opus:medium"  (default: the spec's arms)
 *   ROLE_EVAL_REPEATS  repeats per (tier, case)     (default 3)
 *   ROLE_EVAL_MAX_TURNS, ROLE_EVAL_TIMEOUT_MS, ROLE_EVAL_OUT
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  costReconciliation,
  checkTierMatch,
  extractAgentPromptBlock,
  parseTiers,
  buildReport,
  renderTable,
} from './agent-eval.mjs';

import { buildRolePrompt, parseContractOutput, scoreByContract } from './eval-core.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_CONFIG_PATH = join(REPO_ROOT, 'ci', 'eval-mcp-config.json');
const tierName = (t) => `${t.model}-${t.effort}`;

function runOneCall({ agentPromptBlock, contract, caseObj, tier, maxTurns, timeoutMs }) {
  const withTools = process.env.EVOR_EVAL_TOOLS !== '0';
  const prompt = buildRolePrompt(agentPromptBlock, contract, caseObj, { withTools });
  // ── Item 7.1, the FIRST correct state: ATTACH THE TOOLS ────────────────────
  //
  // v1.2.0's entire tier claim rests on a corpus with zero tool_use blocks, in a
  // system where every role's job is to call tools. RC7: the numbers were right
  // about a narrower thing than they were quoted for — judgement quality on a
  // prompt, cited as role capability.
  //
  // The RED test names two correct states: neutralise the mandate, or attach the
  // server and grade the call. Only the first shipped. This is the second, and
  // Phase 8 needs it: a re-measurement without tools would reproduce the exact
  // confound it exists to remove.
  const args = [
    '-p', prompt,
    '--model', tier.model,
    '--effort', tier.effort,
    '--output-format', 'json',
    '--max-turns', String(maxTurns),
    ...(withTools ? ['--mcp-config', MCP_CONFIG_PATH] : []),
  ];
  const t0 = Date.now();
  let raw;
  try {
    raw = execFileSync('claude', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    raw = e.stdout ?? '';
    if (!raw) return { status: 'cli_error', wall_ms: Date.now() - t0, error: `claude exited abnormally: ${e.message}` };
  }
  const wall_ms = Date.now() - t0;

  let envelope;
  try {
    envelope = JSON.parse(raw.slice(raw.indexOf('{')));
  } catch {
    return { status: 'cli_error', wall_ms, error: `unparseable CLI envelope: ${raw.slice(0, 300)}` };
  }
  if (envelope.is_error) {
    return { status: 'cli_error', wall_ms, error: `CLI reported an error: ${String(envelope.result ?? '').slice(0, 300)}` };
  }

  const tierCheck = checkTierMatch(tier.model, envelope.modelUsage);
  // FAIL LOUDLY. A wrong tier silently measuring the baseline twice is worse
  // than not measuring at all — this is exactly how a "no regression" result
  // gets manufactured.
  if (!tierCheck.ok) throw new Error(tierCheck.error);

  const recon = costReconciliation(envelope);
  // Tool use is observable from `num_turns`: a text-only answer is 1 turn, and
  // every tool call adds one. Verified against a live no-tool call, which
  // returned exactly 1.
  const turns = typeof envelope.num_turns === 'number' ? envelope.num_turns : 1;
  const toolCallsObserved = Math.max(0, turns - 1);

  const text = String(envelope.result ?? '');
  const scored = scoreByContract(contract, caseObj, parseContractOutput(text, contract));

  return {
    mcp_tools_attached: withTools,
    tool_calls_observed: toolCallsObserved,
    status: scored.status,
    wall_ms,
    cost_usd: recon.modeled_usd,
    cli_cost_usd: recon.billed_usd,
    model: tierCheck.model,
    result: scored,
    raw_text: text.slice(0, 4000),
  };
}

async function main() {
  const specPath = resolve(REPO_ROOT, process.argv[2] ?? '');
  if (!existsSync(specPath)) {
    console.error(`usage: node ci/role-eval.mjs <spec.json>   (no such file: ${specPath})`);
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const agentFile = resolve(REPO_ROOT, spec.agent_file);
  const agentPromptBlock = extractAgentPromptBlock(readFileSync(agentFile, 'utf8'));

  const tiers = process.env.ROLE_EVAL_TIERS
    ? parseTiers(process.env.ROLE_EVAL_TIERS)
    : spec.arms.map((a) => ({ model: a.model, effort: a.effort }));
  const repeats = Number(process.env.ROLE_EVAL_REPEATS ?? 3);
  const maxTurns = Number(process.env.ROLE_EVAL_MAX_TURNS ?? 6);
  const timeoutMs = Number(process.env.ROLE_EVAL_TIMEOUT_MS ?? 600000);
  const outPath = resolve(REPO_ROOT, process.env.ROLE_EVAL_OUT ?? `ci/out/${spec.role}-report.json`);

  const records = [];
  for (const tier of tiers) {
    for (const caseObj of spec.cases) {
      for (let rep = 0; rep < repeats; rep++) {
        process.stdout.write(`  ${tierName(tier)} ${caseObj.id} #${rep + 1} ... `);
        const r = runOneCall({ agentPromptBlock, contract: spec.contract, caseObj, tier, maxTurns, timeoutMs });
        process.stdout.write(`${r.status} (${(r.wall_ms / 1000).toFixed(1)}s, $${(r.cost_usd ?? 0).toFixed(4)})\n`);
        records.push({
          tier: tierName(tier),
          case_id: caseObj.id,
          primary_gate: caseObj.gate ?? 'baseline',
          repeat: rep,
          ...r,
        });
      }
    }
  }

  // Two reports may be pooled only if they measured the same thing. Recording
  // what was measured is the cheap half of that check; ci/compare-arms.py does
  // the other half and refuses a merge across a changed prompt or case set.
  const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
  const report = buildReport({ role: spec.role, tiers, records });
  report.fingerprint = {
    agent_file: spec.agent_file,
    agent_sha256: sha(readFileSync(agentFile, 'utf8')),
    spec_sha256: sha(readFileSync(specPath, 'utf8')),
    repeats,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ...report, records }, null, 2));
  console.log(renderTable(report));
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(1);
});
