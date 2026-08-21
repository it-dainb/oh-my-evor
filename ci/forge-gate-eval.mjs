#!/usr/bin/env node
/**
 * ci/forge-gate-eval.mjs — offline MODEL-TIER eval for evor-forge's CAPABILITY
 * GATE (agents/evor-forge.md, <Check_Capability_And_Gotchas>).
 *
 * WHY A SECOND HARNESS. ci/agent-eval.mjs already runs the tier x case x repeat
 * matrix, but two of its pieces are selector-shaped and cannot be reused:
 * buildCasePrompt inlines a proposal SET and demands verdict.json, and scoreCase
 * requires a `reviews` array. Everything role-agnostic — pricing, the tier guard,
 * report assembly, the table — is imported from there rather than copied.
 *
 * WHAT IT CAN AND CANNOT MEASURE. Most of forge's job (spawn a review team,
 * materialise a genome across five seams, store a delta, start a run) needs live
 * MCP state and a git worktree; that path is covered by ci/bench-tick.sh at
 * whole-tick cost. The capability gate is the one part with a DERIVABLE answer:
 * three HARD RULES, evaluated against a capability record and a gotcha list that
 * both fit in a prompt. So that is what this grades, and the report should be
 * read as "forge's gate at tier X", never as "forge at tier X".
 *
 * WHAT IT GRADES. Only the three HARD RULES, and only fields the prompt states
 * outright (GATE_OUTPUT_CONTRACT below is pasted into the prompt verbatim). The
 * agent file mandates the decisions; it does not mandate a serialisation, so the
 * harness supplies one — telling the agent about it is what keeps this from
 * grading a contract that was never stated.
 *
 * Config (env, all optional):
 *   FORGE_GATE_CASES       default "evals/forge/cases.json"
 *   FORGE_GATE_AGENT_FILE  default "agents/evor-forge.md"
 *   FORGE_GATE_TIERS       same syntax as AGENT_EVAL_TIERS ("sonnet:low,...")
 *                          default: sonnet at low/medium/high — the question is
 *                          effort, since bench-tick already runs forge on sonnet
 *   FORGE_GATE_REPEATS     default 3
 *   FORGE_GATE_MAX_TURNS   default 4 (no tool calls are needed; a safety cap)
 *   FORGE_GATE_TIMEOUT_MS  default 300000 per call
 *   EVOR_PRICING_DATE      forwarded to the shared pricing table
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  computeCostFromModelUsage,
  checkTierMatch,
  extractAgentPromptBlock,
  parseTiers,
  buildReport,
  renderTable,
} from './agent-eval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// The output contract. Pasted into the prompt verbatim AND read by the scorer,
// so the two cannot drift: a field the scorer wants but the prompt never named
// would be "never stated, yet graded".
// ─────────────────────────────────────────────────────────────────────────────

export const GATE_OUTPUT_CONTRACT = [
  '## Capability Gate',
  '- decision: abort | proceed',
  '- reason: <one line, why>',
  '- constraints_to_junior: <comma-separated tokens, or "none">',
  '- batch_size: <the integer to pass to forge-junior, or "unchanged">',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

const FIELDS = ['decision', 'reason', 'constraints_to_junior', 'batch_size'];

/**
 * Pull the Capability Gate section out of whatever the agent returned.
 *
 * Section-bounded on purpose: the forge-report template has a "Team Execution"
 * section whose lines also start with "- ", and one of them is an
 * "Architect verdict: approved | ... | abort" line. A document-wide grep for
 * "decision" or "abort" would read the wrong section on a report that is
 * otherwise perfect.
 *
 * Returns null (→ scored `unparseable`, not `incorrect`) when there is no
 * section, or when the section states no decision.
 */
export function parseGateSection(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const heading = text.match(/^[ \t]*#{1,6}[ \t]*\**[ \t]*Capability Gate\b.*$/im);
  if (!heading) return null;

  const after = text.slice(heading.index + heading[0].length);
  const nextHeading = after.search(/^[ \t]*#{1,6}[ \t]+\S/m);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);

  const out = {};
  for (const name of FIELDS) {
    // Leading "- "/"* " and **bold**/`code` decoration around either the key or
    // the value are formatting, not answers.
    const m = section.match(new RegExp(`^[ \\t]*[-*]?[ \\t]*[\`*_]*${name}[\`*_]*[ \\t]*:[ \\t]*(.+)$`, 'im'));
    out[name] = m ? m[1].trim().replace(/^[\`*_]+/, '').replace(/[\`*_]+$/, '').trim() : null;
  }
  if (!out.decision) return null;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring — one check per HARD RULE the case exercises
// ─────────────────────────────────────────────────────────────────────────────

const normDecision = (raw) => {
  const s = String(raw ?? '').toLowerCase();
  if (/\babort\b/.test(s)) return 'abort';
  if (/\bproceed\b/.test(s)) return 'proceed';
  return s;
};

/** The token the cpu_only rule is graded on, spelled the way the prompt asks. */
const CPU_ONLY_RE = /cpu[_\s-]?only|no[_\s-]?cuda/i;

export function scoreGateCase(caseObj, parsed) {
  if (!parsed) {
    return { status: 'unparseable', checks: [], reason: 'no parseable Capability Gate section' };
  }

  const exp = caseObj.expect;
  const checks = [];

  const decision = normDecision(parsed.decision);
  checks.push({
    name: 'decision',
    expected: exp.decision,
    actual: decision,
    correct: decision === exp.decision,
  });

  // On an abort there is no forge-junior to configure, so constraints_to_junior
  // and batch_size describe a spawn that will not happen. Grading them would
  // punish an agent for how it filled in fields its own decision made moot.
  if (exp.decision === 'proceed') {
    const wantsCpuOnly = (exp.constraints ?? []).includes('cpu_only');
    const saysCpuOnly = CPU_ONLY_RE.test(String(parsed.constraints_to_junior ?? ''));
    checks.push({
      name: 'constraints_to_junior',
      expected: wantsCpuOnly ? 'cpu_only' : 'none',
      actual: parsed.constraints_to_junior,
      correct: wantsCpuOnly === saysCpuOnly,
    });

    const raw = String(parsed.batch_size ?? '').trim();
    const asInt = /^-?\d+$/.test(raw) ? Number(raw) : null;
    let correct;
    if (exp.batch_size === 'unchanged') {
      // "unchanged" and re-stating the proposal's own value are the same answer
      // spelled two ways; both mean nothing was substituted.
      correct = /^unchanged$/i.test(raw) || asInt === caseObj.proposal.batch_size;
    } else {
      correct = asInt === exp.batch_size;
    }
    checks.push({
      name: 'batch_size',
      expected: exp.batch_size,
      actual: raw || null,
      correct,
    });
  }

  const failed = checks.filter((c) => !c.correct);
  return {
    status: failed.length === 0 ? 'correct' : 'incorrect',
    checks,
    reason: failed.length
      ? failed.map((c) => `${c.name}: expected ${c.expected}, got ${c.actual}`).join('; ')
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The agent file's own <Agent_Prompt> block plus this case's payload. The block
 * is extracted, never paraphrased — a paraphrase would measure the paraphrase.
 *
 * `note` and `expect` are deliberately not inlined: the note explains which
 * HARD RULE the case exercises, which is exactly the reasoning under test.
 */
export function buildGatePrompt(agentPromptBlock, caseObj) {
  const payload = [
    `You are at tick ${caseObj.tick} of the Evor evolution loop, at the point in your`,
    'Check_Capability_And_Gotchas step where you decide whether forge-junior can be spawned.',
    '',
    'This is an OFFLINE MEASUREMENT HARNESS, not a live mission. No MCP tools are available',
    'here and none should be called — evor_capability, evor_gotcha_query, evor_signal_query,',
    'evor_write_artifact and the rest will not respond. Their results for this tick are',
    'inlined below; answer from that payload alone. There is no worktree, no team to spawn,',
    'and no artifact to write.',
    '',
    'evor_capability() returned:',
    '```json',
    JSON.stringify(caseObj.capability, null, 2),
    '```',
    '',
    'evor_gotcha_query() returned, across both kinds ("runtime-failure" at min_confidence 0.7',
    'and "hardware-constraint" at min_confidence 0.8):',
    '```json',
    JSON.stringify(caseObj.gotchas ?? [], null, 2),
    '```',
    '',
    'evor_signal_query() returned:',
    '```json',
    JSON.stringify(caseObj.signals ?? [], null, 2),
    '```',
    '',
    'The proposal you were handed:',
    '```json',
    JSON.stringify(caseObj.proposal, null, 2),
    '```',
    '',
    'Apply your Check_Capability_And_Gotchas HARD RULES to this payload and respond with ONLY',
    'the "Capability Gate" section of your forge-report, in exactly this shape:',
    '',
    '```',
    GATE_OUTPUT_CONTRACT,
    '```',
    '',
    'Field rules: `decision` is `abort` only when the hardware cannot run this proposal.',
    'Put the literal token `cpu_only` in `constraints_to_junior` if and only if that',
    'constraint must be passed down; otherwise write `none`. Write `unchanged` for',
    '`batch_size` unless a known-safe value must be substituted, in which case write that',
    'integer. No prose outside the section, no other report sections, no tool calls.',
  ].join('\n');

  return `${agentPromptBlock}\n\n---\n\n${payload}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live run — calls the real `claude` CLI. Never imported by tests.
// ─────────────────────────────────────────────────────────────────────────────

const tierName = (t) => `${t.model}-${t.effort}`;

const DEFAULT_TIERS = [
  { model: 'sonnet', effort: 'low' },
  { model: 'sonnet', effort: 'medium' },
  { model: 'sonnet', effort: 'high' },
];

function runOneCall({ agentPromptBlock, caseObj, tier, maxTurns, timeoutMs }) {
  const prompt = buildGatePrompt(agentPromptBlock, caseObj);
  const args = [
    '-p', prompt,
    '--model', tier.model,
    '--effort', tier.effort,
    '--output-format', 'json',
    '--max-turns', String(maxTurns),
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
  // FAIL LOUDLY, same as agent-eval: a wrong tier silently measuring the
  // baseline three times is worse than not measuring at all.
  if (!tierCheck.ok) throw new Error(tierCheck.error);

  const cost = computeCostFromModelUsage(envelope.modelUsage);
  const text = String(envelope.result ?? '');
  const scored = scoreGateCase(caseObj, parseGateSection(text));

  return {
    status: scored.status,
    wall_ms,
    cost_usd: cost.total,
    model: tierCheck.model,
    result: scored,
    // Kept for every status, not just failures: an `unparseable` verdict is a
    // claim about the agent's output, and it should be possible to check it.
    raw_text: text.slice(0, 4000),
  };
}

async function runMatrix() {
  const role = 'evor-forge-gate';
  const casesPath = resolve(REPO_ROOT, process.env.FORGE_GATE_CASES ?? 'evals/forge/cases.json');
  const agentFilePath = resolve(REPO_ROOT, process.env.FORGE_GATE_AGENT_FILE ?? 'agents/evor-forge.md');
  const tiers = process.env.FORGE_GATE_TIERS ? parseTiers(process.env.FORGE_GATE_TIERS) : DEFAULT_TIERS;
  const repeats = Number(process.env.FORGE_GATE_REPEATS ?? 3);
  const maxTurns = Number(process.env.FORGE_GATE_MAX_TURNS ?? 4);
  const timeoutMs = Number(process.env.FORGE_GATE_TIMEOUT_MS ?? 300_000);

  const casesFile = JSON.parse(readFileSync(casesPath, 'utf8'));
  const agentPromptBlock = extractAgentPromptBlock(readFileSync(agentFilePath, 'utf8'));

  console.log(`▶ forge-gate-eval tiers=${tiers.map(tierName).join(',')} repeats=${repeats} cases=${casesFile.cases.length}`);

  const records = [];
  for (const tier of tiers) {
    for (const caseObj of casesFile.cases) {
      for (let rep = 0; rep < repeats; rep++) {
        process.stdout.write(`  ${tierName(tier)} / ${caseObj.id} / rep ${rep + 1}/${repeats} ... `);
        const r = runOneCall({ agentPromptBlock, caseObj, tier, maxTurns, timeoutMs });
        console.log(r.status + (r.result?.reason ? ` (${r.result.reason.slice(0, 120)})` : '') + (r.error ? ` (${r.error.slice(0, 120)})` : ''));
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

  const report = buildReport({ role, tiers, records });
  report.raw_records = records;

  const outDir = resolve(REPO_ROOT, 'ci', 'out');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `agent-eval-${role}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(renderTable(report));
  console.log('');
  console.log(`▶ report: ${outPath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline subcommands (no API calls), mirroring ci/agent-eval.mjs
// ─────────────────────────────────────────────────────────────────────────────

function runSubcommand(argv) {
  const [cmd, ...rest] = argv;
  const getFlag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };

  if (cmd === 'score-case') {
    const caseObj = JSON.parse(readFileSync(getFlag('case'), 'utf8'));
    const text = readFileSync(getFlag('result'), 'utf8');
    console.log(JSON.stringify(scoreGateCase(caseObj, parseGateSection(text))));
    return;
  }

  if (cmd === 'show-prompt') {
    const casesFile = JSON.parse(readFileSync(resolve(REPO_ROOT, process.env.FORGE_GATE_CASES ?? 'evals/forge/cases.json'), 'utf8'));
    const caseObj = casesFile.cases.find((c) => c.id === getFlag('id')) ?? casesFile.cases[0];
    const agentFilePath = resolve(REPO_ROOT, process.env.FORGE_GATE_AGENT_FILE ?? 'agents/evor-forge.md');
    console.log(buildGatePrompt(extractAgentPromptBlock(readFileSync(agentFilePath, 'utf8')), caseObj));
    return;
  }

  console.error(`unknown subcommand "${cmd}". Known: score-case, show-prompt (or no args to run the live matrix).`);
  process.exitCode = 2;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    runMatrix().catch((e) => {
      console.error(`\nforge-gate-eval FAILED: ${e.message}`);
      process.exit(1);
    });
  } else {
    runSubcommand(argv);
  }
}
