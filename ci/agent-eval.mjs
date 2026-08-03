#!/usr/bin/env node
/**
 * ci/agent-eval.mjs — per-agent MODEL-TIER eval harness.
 *
 * WHY: whole-mission A/B cannot answer "can haiku/high replace sonnet/medium for
 * role X" — two 3-tick runs cost ~$40 and differ by a single test sample of
 * noise, and 36 other agents vary at the same time. This harness isolates ONE
 * role, on cases with a DERIVABLE correct answer (evals/<role>/cases.json), run
 * cheaply and repeatably enough to actually separate tiers from noise.
 *
 * Two ways to invoke it:
 *
 *   node ci/agent-eval.mjs                     — the expensive path: runs the
 *     full tier x case x repeat matrix against a real `claude` CLI on PATH,
 *     writes ci/out/agent-eval-<role>.json, prints a readable table. Meant to
 *     run inside the bench container (see ci/agent-eval.sh), same pattern as
 *     ci/bench-tick.sh / ci/bench-tick.mjs.
 *
 *   node ci/agent-eval.mjs <subcommand> ...    — pure, offline subcommands used
 *     by the test suite (mcp/tests/agent-eval.test.ts) so scoring/cost/tier-
 *     guard logic can be exercised WITHOUT calling the API. See runSubcommand()
 *     below for the list. The same functions are also exported for direct
 *     import from tests.
 *
 * Config (env, all optional):
 *   AGENT_EVAL_ROLE         default "evor-selector"
 *   AGENT_EVAL_CASES        default "evals/selector/cases.json"
 *   AGENT_EVAL_AGENT_FILE   default "agents/evor-selector.md"
 *   AGENT_EVAL_TIERS        JSON array of {model,effort}, OR comma list like
 *                            "sonnet:medium,haiku:high,haiku:medium,sonnet:low"
 *                            default: the four tiers named in the plan (see
 *                            DEFAULT_TIERS below).
 *   AGENT_EVAL_REPEATS      default 3
 *   AGENT_EVAL_MAX_TURNS    default 4 (cases need no tool calls; this is a
 *                            safety cap, not a budget)
 *   AGENT_EVAL_TIMEOUT_MS   default 300000 per call
 *   EVOR_PRICING_DATE       forwarded to the mirrored pricing table, same
 *                            semantics as scripts/session-analyze.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────────
// Pricing — MIRRORED from scripts/session-analyze.mjs. Keep these two tables in
// sync; a test (mcp/tests/agent-eval.test.ts) asserts they agree for the same
// token counts by spawning session-analyze.mjs on a synthetic transcript and
// comparing it to computeCostFromModelUsage() here.
// ─────────────────────────────────────────────────────────────────────────────

const SONNET_INTRO_ENDS = Date.parse('2026-09-01T00:00:00Z');
const pricingAt = Date.parse(process.env.EVOR_PRICING_DATE ?? new Date().toISOString());
const sonnetIntro = pricingAt < SONNET_INTRO_ENDS;

const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': sonnetIntro ? { input: 2, output: 10 } : { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const PRICING_NOTE = sonnetIntro
  ? 'sonnet-5 $2/$10 introductory (ends 2026-08-31)'
  : 'sonnet-5 $3/$15 list';
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

const priceFor = (model) => PRICING[model] ?? PRICING[String(model).replace(/-\d{8}$/, '')];

/**
 * modelUsage: the `modelUsage` object from a `claude -p --output-format json`
 * result envelope, e.g. { "claude-haiku-4-5": { inputTokens, outputTokens,
 * cacheReadInputTokens, cacheCreationInputTokens, ... } }. Also accepts the
 * snake_case field names session-analyze.mjs uses internally, so the same
 * function can be exercised from either shape in tests.
 */
export function computeCostFromModelUsage(modelUsage) {
  const byModel = {};
  let total = 0;
  let unpriced = 0;
  for (const [model, m] of Object.entries(modelUsage ?? {})) {
    const input = m.inputTokens ?? m.input_tokens ?? 0;
    const output = m.outputTokens ?? m.output_tokens ?? 0;
    const cacheRead = m.cacheReadInputTokens ?? m.cache_read_input_tokens ?? 0;
    const cacheWrite = m.cacheCreationInputTokens ?? m.cache_creation_input_tokens ?? 0;
    const p = priceFor(model);
    if (!p) {
      byModel[model] = null; // genuinely unknown tier — report rather than guess
      unpriced++;
      continue;
    }
    const c =
      (input * p.input +
        cacheRead * p.input * CACHE_READ_MULT +
        cacheWrite * p.input * CACHE_WRITE_MULT +
        output * p.output) /
      1_000_000;
    byModel[model] = c;
    total += c;
  }
  return {
    by_model: byModel,
    total,
    unpriced_models: unpriced,
    note: `cache_read=0.1x input, cache_write=1.25x input; ${PRICING_NOTE}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier-mismatch guard — FAILS LOUDLY. A harness that silently measures the
// baseline four times (because the CLI ignored --model, or an alias resolved
// somewhere unexpected) is worse than no harness.
// ─────────────────────────────────────────────────────────────────────────────

const ALIAS_MODEL_PREFIX = {
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-5',
};

export function checkTierMatch(requestedModelAlias, modelUsage) {
  const expectedPrefix = ALIAS_MODEL_PREFIX[requestedModelAlias] ?? requestedModelAlias;
  const keys = Object.keys(modelUsage ?? {});
  const matched = keys.find((k) => k === expectedPrefix || k.startsWith(expectedPrefix));
  if (!matched) {
    return {
      ok: false,
      error:
        `tier mismatch: requested model "${requestedModelAlias}" (expected modelUsage key ` +
        `matching "${expectedPrefix}") but the CLI result envelope reported modelUsage for ` +
        `[${keys.join(', ') || 'none'}]`,
    };
  }
  return { ok: true, model: matched };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict parsing — tolerate prose, a ```json fence, or a raw object. Mirrors
// ci/agentic-quality/score_dreamer.py's parse_proposals_json.
// ─────────────────────────────────────────────────────────────────────────────

export function parseVerdictText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring — the 7 gates named deterministically in agents/evor-selector.md.
// ─────────────────────────────────────────────────────────────────────────────

/** critic_review field name for each short gate name used in evals/selector/cases.json. */
export const SHORT_TO_GATE_KEY = {
  h001: 'h001_one_hypothesis',
  h002: 'h002_family_streak',
  h003: 'h003_intra_tick_diversity',
  h004: 'h004_parent_diversity',
  integrity: 'integrity_risk',
  instrumentation: 'instrumentation_check',
  schema: 'schema_valid',
  acquisition: 'acquisition_contamination',
  gotcha: 'gotcha_avoidance',
};

/** The gate this case is designed to exercise, or null for a clean baseline. */
export function primaryGateForCase(caseObj) {
  if (caseObj.expect_any_rejected_for) return caseObj.expect_any_rejected_for;
  if (Array.isArray(caseObj.expect)) {
    const neg = caseObj.expect.find((e) => e.approved === false && e.failing_gate);
    if (neg) return neg.failing_gate;
  }
  return null;
}

/**
 * Score one case's parsed verdict against its expectation.
 *
 * Returns { status: 'correct' | 'incorrect' | 'unparseable', ... }.
 * A response that cannot be parsed into a verdict object with a `reviews`
 * array is `unparseable` — never silently scored as wrong.
 */
export function scoreCase(caseObj, parsed) {
  if (!parsed || !Array.isArray(parsed.reviews)) {
    return { status: 'unparseable', reason: 'missing or non-array `reviews` field' };
  }

  const byId = new Map(parsed.reviews.filter((r) => r && r.proposal_id).map((r) => [r.proposal_id, r]));

  // ── Set-level cases (H003, H004): scored on whether the gate was identified
  // at all, not on which specific proposal was rejected — see cases.json's
  // expect_note for each of these.
  if (caseObj.expect_any_rejected_for) {
    const gate = caseObj.expect_any_rejected_for;
    const gateKey = SHORT_TO_GATE_KEY[gate];
    if (!gateKey) return { status: 'unparseable', reason: `unknown gate short name "${gate}"` };
    const hit = parsed.reviews.find((r) => {
      const cr = r?.critic_review;
      return !!cr && cr.verdict === 'rejected' && cr[gateKey] === 'fail';
    });
    return {
      status: hit ? 'correct' : 'incorrect',
      set_level_gate: gate,
      named_gate: hit ? gate : null,
      note: hit ? `${hit.proposal_id} rejected on ${gate}` : `no review rejected with ${gateKey}=fail`,
    };
  }

  // ── Per-proposal cases.
  if (!Array.isArray(caseObj.expect)) {
    return { status: 'unparseable', reason: 'case has neither `expect` nor `expect_any_rejected_for`' };
  }

  const perProposal = caseObj.expect.map((exp) => {
    const review = byId.get(exp.proposal_id);
    if (!review || !review.critic_review) {
      return { proposal_id: exp.proposal_id, correct: false, expected: exp, reason: 'no matching review returned' };
    }
    const cr = review.critic_review;
    const actualApproved = cr.verdict === 'approved';
    const failedGates = Object.entries(SHORT_TO_GATE_KEY)
      .filter(([, key]) => cr[key] === 'fail')
      .map(([short]) => short);
    const namedGate = failedGates[0] ?? null;

    let correct = actualApproved === exp.approved;
    if (!exp.approved && exp.failing_gate) {
      correct = correct && failedGates.includes(exp.failing_gate);
    }

    return {
      proposal_id: exp.proposal_id,
      correct,
      expected: exp,
      actual_approved: actualApproved,
      named_gate: namedGate,
      failed_gates: failedGates,
    };
  });

  const allCorrect = perProposal.every((p) => p.correct);
  return { status: allCorrect ? 'correct' : 'incorrect', per_proposal: perProposal };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction — extract <Agent_Prompt> from the agent file (do not
// hand-copy it: the agent file's own text is the source of truth), append the
// case's proposal set as the payload.
// ─────────────────────────────────────────────────────────────────────────────

export function extractAgentPromptBlock(agentMarkdown) {
  const match = agentMarkdown.match(/<Agent_Prompt>[\s\S]*?<\/Agent_Prompt>/);
  if (!match) throw new Error('could not find <Agent_Prompt>...</Agent_Prompt> block in agent file');
  return match[0];
}

export function buildCasePrompt(agentPromptBlock, caseObj) {
  const payload = [
    `You are evaluating tick ${caseObj.tick} of the Evor evolution loop. This is an OFFLINE`,
    'MEASUREMENT HARNESS, not a live mission: no MCP tools (evor_validate_proposals,',
    'evor_state_read, evor_gotcha_query, evor_signal_query, evor_write_artifact, ...) are',
    'available here, and none should be called — answer from the payload below only.',
    '',
    'Gates H002 (family streak) and Gotcha Avoidance require live state/tool access that this',
    'harness does not provide. Score both "pass" unconditionally and do not let them affect the',
    'verdict; grading here is on H001, H003, H004, Schema, Instrumentation, and Integrity Risk,',
    'which are fully determined by the payload.',
    '',
    'This is the COMPLETE set of proposals submitted for the tick (needed for H003 and H004):',
    '',
    '```json',
    JSON.stringify(caseObj.proposals, null, 2),
    '```',
    '',
    'Respond with ONLY the verdict.json artifact contents — the exact SelectorVerdict shape',
    'from your Output_Format section — as a single JSON object. No prose, no MCP calls.',
  ].join('\n');

  return `${agentPromptBlock}\n\n---\n\n${payload}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier matrix
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIERS = [
  { model: 'sonnet', effort: 'medium' }, // current baseline
  { model: 'haiku', effort: 'high' }, // the hypothesis
  { model: 'haiku', effort: 'medium' },
  { model: 'sonnet', effort: 'low' },
];

export function parseTiers(spec) {
  if (!spec) return DEFAULT_TIERS;
  const trimmed = spec.trim();
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split(',').map((entry) => {
    const [model, effort] = entry.split(':').map((s) => s.trim());
    if (!model || !effort) throw new Error(`bad AGENT_EVAL_TIERS entry "${entry}", expected "model:effort"`);
    return { model, effort };
  });
}

const tierName = (t) => `${t.model}-${t.effort}`;

// ─────────────────────────────────────────────────────────────────────────────
// Stats helpers
// ─────────────────────────────────────────────────────────────────────────────

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

/**
 * "Insufficient evidence" check: two-proportion z-approximation on accuracy.
 * With small repeat counts this is necessarily rough — the point is to refuse
 * to declare a winner from noise, not to produce a rigorous p-value.
 */
function compareTiers(a, b) {
  const na = a.n, nb = b.n;
  const pa = a.accuracy, pb = b.accuracy;
  if (na === 0 || nb === 0) return { verdict: 'insufficient evidence', reason: 'no scored samples' };
  const pooled = (a.correct + b.correct) / (na + nb);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  const z = se > 0 ? Math.abs(pa - pb) / se : 0;
  if (se === 0 || z < 1.0) {
    return {
      verdict: 'insufficient evidence',
      reason: `accuracy delta ${(Math.abs(pa - pb) * 100).toFixed(1)}pp is within noise (z=${z.toFixed(2)}, n=${na}/${nb})`,
    };
  }
  return {
    verdict: pa >= pb ? `${a.tier} ahead` : `${b.tier} ahead`,
    reason: `accuracy delta ${(Math.abs(pa - pb) * 100).toFixed(1)}pp, z=${z.toFixed(2)} (n=${na}/${nb})`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report assembly (pure — takes raw per-call records, no I/O)
// ─────────────────────────────────────────────────────────────────────────────

export function buildReport({ role, tiers, records }) {
  const tierReports = tiers.map((tier) => {
    const tn = tierName(tier);
    const tierRecords = records.filter((r) => r.tier === tn);

    const byCase = {};
    for (const r of tierRecords) {
      (byCase[r.case_id] ??= []).push(r);
    }

    const cases = Object.entries(byCase).map(([caseId, recs]) => {
      const counts = { correct: 0, incorrect: 0, unparseable: 0, cli_error: 0 };
      const namedGates = {};
      for (const r of recs) {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
        const g = r.result?.named_gate ?? r.result?.set_level_gate ?? null;
        if (g) namedGates[g] = (namedGates[g] ?? 0) + 1;
      }
      return { case_id: caseId, n: recs.length, counts, named_gates: namedGates };
    });

    const scored = tierRecords.filter((r) => r.status === 'correct' || r.status === 'incorrect');
    const correctN = scored.filter((r) => r.status === 'correct').length;
    const costs = tierRecords.map((r) => r.cost_usd).filter((c) => typeof c === 'number');
    const walls = tierRecords.map((r) => r.wall_ms).filter((w) => typeof w === 'number');

    // Gate-level accuracy: "haiku catches schema but misses instrumentation" is
    // the actionable finding, not a single percentage.
    const gateAccuracy = {};
    for (const r of tierRecords) {
      const gate = r.primary_gate ?? 'baseline';
      const g = (gateAccuracy[gate] ??= { correct: 0, incorrect: 0, unparseable: 0, cli_error: 0 });
      g[r.status] = (g[r.status] ?? 0) + 1;
    }

    return {
      tier: tn,
      model: tier.model,
      effort: tier.effort,
      n_calls: tierRecords.length,
      n_scored: scored.length,
      accuracy: scored.length ? correctN / scored.length : null,
      correct: correctN,
      unparseable: tierRecords.filter((r) => r.status === 'unparseable').length,
      cli_errors: tierRecords.filter((r) => r.status === 'cli_error').length,
      mean_cost_usd: mean(costs),
      cost_spread_usd: stdev(costs),
      mean_wall_ms: mean(walls),
      wall_spread_ms: stdev(walls),
      gate_accuracy: gateAccuracy,
      cases,
    };
  });

  const baseline = tierReports.find((t) => t.model === 'sonnet' && t.effort === 'medium') ?? tierReports[0];
  const comparisons = tierReports
    .filter((t) => t !== baseline)
    .map((t) => ({
      tier: t.tier,
      vs: baseline.tier,
      ...compareTiers(
        { tier: t.tier, n: t.n_scored, correct: t.correct, accuracy: t.accuracy ?? 0 },
        { tier: baseline.tier, n: baseline.n_scored, correct: baseline.correct, accuracy: baseline.accuracy ?? 0 },
      ),
    }));

  return {
    role,
    generated_at: new Date().toISOString(),
    pricing_basis: PRICING_NOTE,
    tiers: tierReports,
    baseline: baseline?.tier ?? null,
    comparisons,
  };
}

export function renderTable(report) {
  const lines = [];
  lines.push(`agent-eval — role=${report.role} (${report.pricing_basis})`);
  lines.push('');
  const header = ['tier', 'n', 'accuracy', 'unparseable', 'mean_cost', 'cost_sd', 'mean_wall_ms', 'wall_sd'];
  lines.push(header.join('\t'));
  for (const t of report.tiers) {
    lines.push(
      [
        t.tier,
        t.n_calls,
        t.accuracy === null ? 'n/a' : `${(t.accuracy * 100).toFixed(1)}%`,
        t.unparseable,
        `$${t.mean_cost_usd.toFixed(4)}`,
        `$${t.cost_spread_usd.toFixed(4)}`,
        Math.round(t.mean_wall_ms),
        Math.round(t.wall_spread_ms),
      ].join('\t'),
    );
  }
  lines.push('');
  lines.push('per-gate accuracy:');
  for (const t of report.tiers) {
    lines.push(`  ${t.tier}:`);
    for (const [gate, g] of Object.entries(t.gate_accuracy)) {
      const n = g.correct + g.incorrect + (g.unparseable ?? 0) + (g.cli_error ?? 0);
      const acc = n ? (g.correct / n) * 100 : 0;
      lines.push(`    ${gate}: ${acc.toFixed(0)}% (${g.correct}/${n})`);
    }
  }
  lines.push('');
  lines.push('comparisons vs baseline:');
  for (const c of report.comparisons) {
    lines.push(`  ${c.tier} vs ${c.vs}: ${c.verdict} — ${c.reason}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Live run — calls the real `claude` CLI. Never imported by tests.
// ─────────────────────────────────────────────────────────────────────────────

function runOneCall({ agentPromptBlock, caseObj, tier, maxTurns, timeoutMs }) {
  const prompt = buildCasePrompt(agentPromptBlock, caseObj);
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
    // execFileSync throws on non-zero exit; stdout may still carry a result envelope.
    raw = e.stdout ?? '';
    if (!raw) {
      return { status: 'cli_error', wall_ms: Date.now() - t0, error: `claude exited abnormally: ${e.message}` };
    }
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
  if (!tierCheck.ok) {
    // FAIL LOUDLY — see module docstring. A wrong tier silently measuring the
    // baseline four times is worse than not measuring at all.
    throw new Error(tierCheck.error);
  }

  const cost = computeCostFromModelUsage(envelope.modelUsage);
  const parsed = parseVerdictText(envelope.result ?? '');
  const scored = scoreCase(caseObj, parsed);

  return {
    status: scored.status,
    wall_ms,
    cost_usd: cost.total,
    model: tierCheck.model,
    result: scored,
  };
}

async function runMatrix() {
  const role = process.env.AGENT_EVAL_ROLE ?? 'evor-selector';
  const casesPath = resolve(REPO_ROOT, process.env.AGENT_EVAL_CASES ?? 'evals/selector/cases.json');
  const agentFilePath = resolve(REPO_ROOT, process.env.AGENT_EVAL_AGENT_FILE ?? 'agents/evor-selector.md');
  const tiers = parseTiers(process.env.AGENT_EVAL_TIERS);
  const repeats = Number(process.env.AGENT_EVAL_REPEATS ?? 3);
  const maxTurns = Number(process.env.AGENT_EVAL_MAX_TURNS ?? 4);
  const timeoutMs = Number(process.env.AGENT_EVAL_TIMEOUT_MS ?? 300_000);

  const casesFile = JSON.parse(readFileSync(casesPath, 'utf8'));
  const agentPromptBlock = extractAgentPromptBlock(readFileSync(agentFilePath, 'utf8'));

  console.log(`▶ agent-eval role=${role} tiers=${tiers.map(tierName).join(',')} repeats=${repeats} cases=${casesFile.cases.length}`);

  const records = [];
  for (const tier of tiers) {
    for (const caseObj of casesFile.cases) {
      for (let rep = 0; rep < repeats; rep++) {
        process.stdout.write(`  ${tierName(tier)} / ${caseObj.id} / rep ${rep + 1}/${repeats} ... `);
        const r = runOneCall({ agentPromptBlock, caseObj, tier, maxTurns, timeoutMs });
        console.log(r.status + (r.error ? ` (${r.error.slice(0, 120)})` : ''));
        records.push({
          tier: tierName(tier),
          case_id: caseObj.id,
          primary_gate: primaryGateForCase(caseObj) ?? 'baseline',
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
// Offline subcommands (no API calls) — used by mcp/tests/agent-eval.test.ts via
// subprocess, mirroring the precedent in mcp/tests/session-analyze.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

function runSubcommand(argv) {
  const [cmd, ...rest] = argv;
  const getFlag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };

  if (cmd === 'score-case') {
    const caseObj = JSON.parse(readFileSync(getFlag('case'), 'utf8'));
    const resultText = readFileSync(getFlag('result'), 'utf8');
    const parsed = parseVerdictText(resultText);
    console.log(JSON.stringify(scoreCase(caseObj, parsed)));
    return;
  }

  if (cmd === 'cost') {
    const usage = JSON.parse(readFileSync(getFlag('usage'), 'utf8'));
    console.log(JSON.stringify(computeCostFromModelUsage(usage)));
    return;
  }

  if (cmd === 'tiercheck') {
    const requested = getFlag('requested');
    const usage = JSON.parse(readFileSync(getFlag('model-usage'), 'utf8'));
    const result = checkTierMatch(requested, usage);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.error(`unknown subcommand "${cmd}". Known: score-case, cost, tiercheck (or no args to run the live matrix).`);
  process.exitCode = 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    runMatrix().catch((e) => {
      console.error(`\nagent-eval FAILED: ${e.message}`);
      process.exit(1);
    });
  } else {
    runSubcommand(argv);
  }
}
