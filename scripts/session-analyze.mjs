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

/** message.id values already charged, per scope — usage is repeated per block. */
const chargedGlobal = new Set();
const chargedScope = new Set();
const chargedModel = new Set();
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

    // ── Turns and tokens: once per message ───────────────────────────────────
    if (!chargedGlobal.has(msgId)) {
      chargedGlobal.add(msgId);
      totals.turns++;
      const u = rec.message.usage ?? {};
      totals.input_tokens += u.input_tokens ?? 0;
      totals.output_tokens += u.output_tokens ?? 0;
      totals.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
      totals.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    }
    if (!chargedScope.has(scopeKey)) {
      chargedScope.add(scopeKey);
      scope.turns++;
      const u = rec.message.usage ?? {};
      scope.input_tokens += u.input_tokens ?? 0;
      scope.output_tokens += u.output_tokens ?? 0;
      scope.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
      scope.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    }
    if (!chargedModel.has(modelKey)) {
      chargedModel.add(modelKey);
      const u = rec.message.usage ?? {};
      const m = (byModel[model] ??= { turns: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 });
      m.turns++;
      m.input += u.input_tokens ?? 0;
      m.output += u.output_tokens ?? 0;
      m.cache_read += u.cache_read_input_tokens ?? 0;
      m.cache_write += u.cache_creation_input_tokens ?? 0;
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
const priceFor = (model) =>
  PRICING[model] ?? PRICING[String(model).replace(/-\d{8}$/, '')];

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
      m.cache_write * p.input * CACHE_WRITE_MULT +
      m.output * p.output) /
    1_000_000;
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
