#!/usr/bin/env node
/**
 * scripts/session-analyze.mjs — session telemetry for the Phase 2 gate.
 *
 *   node scripts/session-analyze.mjs <session.jsonl> [more.jsonl ...]
 *
 * Emits one JSON object: turns, tool calls, token totals, modeled cost,
 * wall-clock, hook fires, and the two regression counters the plan's acceptance
 * criteria are written against (AC2 orchestrator leaf calls, named spawns).
 *
 * THE ACCOUNTING RULE THAT MATTERS: a line in a Claude Code session JSONL is one
 * CONTENT BLOCK, not one turn, and `message.usage` is stamped on every block of
 * the same message. Turns and tokens must therefore be deduplicated by
 * `message.id`; tool calls must NOT be, since several genuinely share one
 * message. In the reference run that is 553 blocks across 287 messages — a 1.93x
 * error if conflated, which is more than the 29% opus->sonnet break-even.
 */

import { readFileSync } from 'fs';

/**
 * $/Mtok, Anthropic first-party.
 *
 * Sonnet 5 is the only rate that moves: $2/$10 introductory through 2026-08-31,
 * $3/$15 list after. The previous table listed BOTH but looked up the list entry,
 * so every run measured while intro pricing was in effect was reported ~50% too
 * expensive on its largest line item — Sonnet is most of the agent mix.
 *
 * Resolved by date rather than by picking one, because both are correct at
 * different times and a long mission can straddle the boundary. Override with
 * EVOR_PRICING_DATE to model a run on the other side of it.
 */
/**
 * $/Mtok, first-party, RECONCILED AGAINST WHAT THE CLI ACTUALLY CHARGED.
 *
 * Sonnet 5 was priced here at "$2/$10 introductory through 2026-08-31", on the
 * documented introductory rate. The bench tick of 2026-08-21 — inside that
 * window — was charged $12.486398 for sonnet by the CLI's own per-model
 * accounting (ci/out/bench-tick-raw.json). $3/$15 reproduces that to six
 * decimals; $2/$10 gives $8.324265. So the introductory rate is documented but
 * is not what this account pays, and assuming it understated the largest line
 * item of every measurement by a third. Opus and haiku both reconciled exactly
 * at their list rates, which is what makes the sonnet discrepancy a rate error
 * rather than a units error.
 *
 * EVOR_PRICING_DATE no longer selects a rate — there is nothing left to select.
 * Reinstate a date branch only against a bill that shows one.
 */
const PRICING = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const PRICING_NOTE = 'sonnet-5 $3/$15 list (reconciled to CLI costUSD 2026-08-21)';
const CACHE_READ_MULT = 0.1;

/**
 * Cache writes are billed by TTL: 1.25x input at the 5-minute default, 2x at
 * 1 hour. A single flat 1.25x undercharged the opus main session — which wrote
 * all 77,140 of its cache tokens at 1h — by $0.289275, the exact gap between
 * the modelled $1.481971 and the billed $1.771245.
 */
const CACHE_WRITE_MULT_5M = 1.25;
const CACHE_WRITE_MULT_1H = 2.0;

/** $/request for the server-side web search tool. Modelled as free until now. */
const WEB_SEARCH_USD = 0.01;

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: session-analyze.mjs <session.jsonl> [...]\n');
  process.exit(2);
}

const emptyScope = () => ({
  turns: 0,
  tool_calls: 0,
  tools: {},
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

const main = emptyScope();
const subagents = emptyScope();
const totals = emptyScope();
const byModel = {};

let malformed = 0;
let hookFires = 0;
let messagesWithHooks = 0;
let firstTs = null;
let lastTs = null;

const spawns = { total: 0, named: 0, named_examples: [] };
let orchestratorLeafCalls = 0;

/**
 * message.id -> the largest usage already charged for it, per scope. A Map, not
 * a Set: `usage` is repeated across the blocks of one message but is not always
 * IDENTICAL across them, so the running maximum has to be remembered in order
 * to charge only the increment. See the accounting note at the accumulator.
 */
const chargedGlobal = new Map();
const chargedScope = new Map();
const chargedModel = new Map();
const hookCharged = new Set();

const LEAF_TOOLS = new Set(['Bash', 'Write', 'Edit']);

/** Prefixes the evor hooks inject. Anchored so ordinary prose mentioning a hook
 *  by name is not miscounted as a fire. */
const EVOR_INJECTION_RE = /\[EVOR (LAW|GOVERNOR|GUARD|CONTEXT|SUBAGENT WARNING|CONTINUATION GUARD|JOB [A-Z]+|FORGE GATE|BLOCKED)\]/;

for (const file of files) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${e.message}\n`);
    process.exit(2);
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }

    if (rec.timestamp) {
      const t = Date.parse(rec.timestamp);
      if (!Number.isNaN(t)) {
        if (firstTs === null || t < firstTs) firstTs = t;
        if (lastTs === null || t > lastTs) lastTs = t;
      }
    }

    // ── Hook fires ────────────────────────────────────────────────────────
    // Hook-injected text lands on `attachment` and `user` records, which carry NO
    // hook* field. Counting `hookCount` on `assistant` records therefore reported
    // 0 fires for a run with 42 injection records across 17 transcripts — the
    // metric was pointed at the wrong record type, and read as "the enforcement
    // layer is inert" when it was firing everywhere.
    if (rec.type === 'attachment' || rec.type === 'user') {
      if (EVOR_INJECTION_RE.test(JSON.stringify(rec))) {
        hookFires++;
        messagesWithHooks++;
      }
    }

    if (rec.type !== 'assistant' || !rec.message) continue;

    const msgId = rec.message.id ?? `anon-${malformed}-${Math.random()}`;
    const model = rec.message.model ?? 'unknown';
    const scope = rec.isSidechain ? subagents : main;
    const scopeKey = `${rec.isSidechain ? 'sub' : 'main'}:${msgId}`;
    const modelKey = `${model}:${msgId}`;

    // ── Turns and tokens: once per message, at its LARGEST reported usage ─────
    //
    // The original rule charged the first block of a message and skipped the
    // rest, on the documented premise that `usage` is stamped identically on
    // every block. That premise holds for the cache fields — they reconciled to
    // the token against the CLI's own numbers — and fails for output_tokens,
    // which grows block by block within one message. First-block-wins recorded
    // 19,720 sonnet output tokens where the CLI billed 142,226.
    //
    // Max is exact everywhere first-wins was exact, so this is a strict
    // improvement, not a different guess. It is still not complete: max
    // recovers 135,697 of those 142,226 (95.4%) and 57,032 of haiku's 60,540
    // (94.2%), and haiku's input_tokens are short by more than that (2,489 vs
    // 13,692). Some usage is evidently never written to the transcripts. Treat
    // transcript-derived cost as a LOWER BOUND and prefer a recorded
    // total_cost_usd when one exists.
    const u = rec.message.usage ?? {};
    const cc = u.cache_creation ?? {};
    const usageFields = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_write_1h: cc.ephemeral_1h_input_tokens ?? 0,
      // A write with no TTL breakdown is charged at the 5-minute rate — the
      // API default, and the cheaper of the two, so an unknown never inflates.
      cache_write_5m:
        cc.ephemeral_5m_input_tokens ??
        (cc.ephemeral_1h_input_tokens === undefined ? u.cache_creation_input_tokens ?? 0 : 0),
      web_search_requests: u.server_tool_use?.web_search_requests ?? 0,
    };

    const applyMax = (acc, seen, key, fields) => {
      const prev = seen.get(key);
      if (prev === undefined) {
        seen.set(key, { ...fields });
        for (const [k, v] of Object.entries(fields)) acc[k] = (acc[k] ?? 0) + v;
        return true;
      }
      for (const [k, v] of Object.entries(fields)) {
        if (v > prev[k]) {
          acc[k] = (acc[k] ?? 0) + (v - prev[k]);
          prev[k] = v;
        }
      }
      return false;
    };

    if (applyMax(totals, chargedGlobal, msgId, usageFields)) totals.turns++;
    if (applyMax(scope, chargedScope, scopeKey, usageFields)) scope.turns++;
    const m = (byModel[model] ??= {
      turns: 0, input: 0, output: 0, cache_read: 0, cache_write: 0,
      cache_write_1h: 0, cache_write_5m: 0, web_search_requests: 0,
    });
    if (
      applyMax(m, chargedModel, modelKey, {
        input: usageFields.input_tokens,
        output: usageFields.output_tokens,
        cache_read: usageFields.cache_read_input_tokens,
        cache_write: usageFields.cache_creation_input_tokens,
        cache_write_1h: usageFields.cache_write_1h,
        cache_write_5m: usageFields.cache_write_5m,
        web_search_requests: usageFields.web_search_requests,
      })
    ) {
      m.turns++;
    }

    // ── Hook fires: a per-message property, so dedup it too ──────────────────
    if (typeof rec.hookCount === 'number' && rec.hookCount > 0 && !hookCharged.has(msgId)) {
      hookCharged.add(msgId);
      hookFires += rec.hookCount;
      messagesWithHooks++;
    }

    // ── Tool calls: per block, NOT deduped — one message may hold several ────
    for (const b of rec.message.content ?? []) {
      if (b?.type !== 'tool_use') continue;
      const name = b.name ?? 'unknown';
      totals.tool_calls++;
      totals.tools[name] = (totals.tools[name] ?? 0) + 1;
      scope.tool_calls++;
      scope.tools[name] = (scope.tools[name] ?? 0) + 1;

      if (!rec.isSidechain && LEAF_TOOLS.has(name)) orchestratorLeafCalls++;

      if (name === 'Task' || name === 'Agent') {
        const subType = String(b.input?.subagent_type ?? '');
        if (!subType) continue;
        spawns.total++;
        if (String(b.input?.name ?? '')) {
          spawns.named++;
          if (!spawns.named_examples.includes(subType)) spawns.named_examples.push(subType);
        }
      }
    }
  }
}

// ── Cost ─────────────────────────────────────────────────────────────────────
const costByModel = {};
let costTotal = 0;
/**
 * Transcripts carry DATED model ids (`claude-haiku-4-5-20251001`) while the table
 * keys on the alias (`claude-haiku-4-5`). The exact-match lookup missed, cost was
 * recorded as null, and null was skipped when summing — so every haiku agent in
 * every run cost $0 in our accounting. Silent, and precisely backwards for a
 * project evaluating whether to move work ONTO haiku.
 */
/**
 * Resolve a pricing entry from a model key as the CLI reports it.
 *
 * Two suffixes have to come off. `-20251001` is a dated snapshot. `[1m]` is the
 * 1M-context variant, and the opus main session of every bench tick is reported
 * as `claude-opus-5[1m]` — which matched nothing, so it was counted as an
 * UNPRICED model and cost $0. That is the same silent-zero failure the haiku
 * note below describes, on the most expensive model in the mix.
 */
const stripModelSuffixes = (model) =>
  String(model).replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
const priceFor = (model) => PRICING[model] ?? PRICING[stripModelSuffixes(model)];

let unpriced = 0;
for (const [model, m] of Object.entries(byModel)) {
  const p = priceFor(model);
  if (!p) {
    costByModel[model] = null; // genuinely unknown tier — report rather than guess
    unpriced++;
    continue;
  }
  const c =
    (m.input * p.input +
      m.cache_read * p.input * CACHE_READ_MULT +
      (m.cache_write_1h ?? 0) * p.input * CACHE_WRITE_MULT_1H +
      (m.cache_write_5m ?? m.cache_write) * p.input * CACHE_WRITE_MULT_5M +
      m.output * p.output) /
      1_000_000 +
    (m.web_search_requests ?? 0) * WEB_SEARCH_USD;
  costByModel[model] = c;
  costTotal += c;
}

const seconds = firstTs !== null && lastTs !== null ? Math.round((lastTs - firstTs) / 1000) : 0;

process.stdout.write(
  JSON.stringify(
    {
      files,
      malformed_lines: malformed,
      totals,
      main,
      subagents,
      by_model: byModel,
      cost: {
        by_model: costByModel,
        total: costTotal,
        note: `cache_read=0.1x input, cache_write=1.25x input; ${PRICING_NOTE}`,
        pricing_basis: PRICING_NOTE,
        // Non-zero means the total UNDERSTATES real spend — a model ran that we
        // could not price. Never read `total` without checking this.
        unpriced_models: unpriced,
      },
      wall_clock: { seconds, human: `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m` },
      hooks: { total_fires: hookFires, messages_with_hooks: messagesWithHooks },
      ac2: { orchestrator_leaf_tool_calls: orchestratorLeafCalls },
      spawns,
      blocks_per_message: totals.turns ? Number((totals.tool_calls / totals.turns).toFixed(3)) : 0,
    },
    null,
    2,
  ) + '\n',
);
