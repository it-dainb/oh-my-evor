#!/usr/bin/env node
/**
 * lint.mjs — the offline gates for Author B's scenarios.
 *
 * §7 step 1 says `mcp/tests/bench-scenarios.test.ts` — a suite-wide gate — lands
 * BEFORE authoring, "gates before authoring, authoring cases first and gating
 * them afterwards is how v1.2.1 acquired four defective specs". It does not
 * exist yet. Rather than author against no gate at all, this runs the checks
 * §4.4/§4.5 specify, scoped to this author's 60 files. It is a STAND-IN: when
 * the shared gate lands, these checks should move into it and this file should
 * be deleted rather than kept in parallel.
 *
 *   node evals/bench/authority/lint.mjs
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const FRAME = { T4: 'matrix', A1: 'tier', A2: 'matrix', A3: 'matrix', A4: 'matrix' };

const errors = [];
const warns = [];
const fail = (id, msg) => errors.push(`${id}: ${msg}`);
const warn = (id, msg) => warns.push(`${id}: ${msg}`);

const scenarios = [];
for (const angle of Object.keys(FRAME)) {
  for (const f of readdirSync(join(HERE, angle)).filter((n) => n.endsWith('.json')).sort()) {
    scenarios.push(JSON.parse(readFileSync(join(HERE, angle, f), 'utf8')));
  }
}

const jsonText = (o) => JSON.stringify(o);

for (const s of scenarios) {
  const id = s.id;

  // ── §2.0 / trap 6.13 — frame conformance ────────────────────────────────
  if (s.frame !== FRAME[s.angle]) fail(id, `frame "${s.frame}" disagrees with the angle table (${s.angle} is ${FRAME[s.angle]})`);

  // ── §3.1 — the key set the declared frame needs ─────────────────────────
  if (s.frame === 'matrix') {
    if (!s.condition || !s.signal) fail(id, 'matrix frame without condition/signal');
    if (s.condition.holds !== (s.pair.half === 'positive')) fail(id, 'condition.holds != (half == positive)');
    if (s.expect.signal_expected !== s.condition.holds) fail(id, 'expect.signal_expected != condition.holds');
    if (!Array.isArray(s.condition.derivable_from) || !s.condition.derivable_from.length)
      fail(id, 'condition.derivable_from is empty — the agent cannot establish C without guessing');
    // §4.5b(a): mandatory declaration on any abstention signal.
    const isAbstention = /none_of|unchanged/.test(jsonText(s.signal.detect));
    if (isAbstention && !s.signal.declaration)
      fail(id, 'abstention signal with declaration:null — bench-lint rejects this (§4.5b)');
  } else {
    if (!s.expected_behaviour || !s.tiers) fail(id, 'tier frame without expected_behaviour/tiers');
    if (!s.tiers.partial) warn(id, 'tiers.partial is null — §3.1 warns unless the angle has no middle state');
    if (!s.tiers.fail_kind_map || !Object.keys(s.tiers.fail_kind_map).length) fail(id, 'empty fail_kind_map');
    if (s.condition || s.signal) fail(id, 'tier frame carrying condition/signal keys');
  }

  // ── §4.4 — grounded_rule verbatim at the recorded sha ───────────────────
  const gr = s.grounded_rule;
  const abs = join(REPO, gr.file);
  if (!existsSync(abs)) fail(id, `grounded_rule.file missing: ${gr.file}`);
  else {
    const buf = readFileSync(abs);
    const now = createHash('sha256').update(buf).digest('hex');
    const lines = buf.toString('utf8').split('\n');
    if (!lines.some((l) => l.trim() === gr.quote.trim()))
      fail(id, `grounded_rule.quote is not a verbatim line of ${gr.file}`);
    if (now !== gr.sha256_at_authoring)
      fail(id, `${gr.file} has changed since authoring (sha ${now.slice(0, 12)} vs recorded ${gr.sha256_at_authoring.slice(0, 12)}) — re-verify the quote and re-freeze`);
  }
  if (!Array.isArray(s.grounding) || !s.grounding.length) fail(id, 'grounding is empty (>=1 required)');

  // ── §4.4 — satisfiability gate ──────────────────────────────────────────
  if (s.satisfiability.signal_producible !== true) fail(id, 'satisfiability.signal_producible is not true');
  if (s.satisfiability.no_signal_producible !== true) fail(id, 'satisfiability.no_signal_producible is not true');
  if (!s.satisfiability.note || s.satisfiability.note.length < 40) fail(id, 'satisfiability.note does not say how');

  // ── §4.4 — forbidden entries carry a reason ─────────────────────────────
  for (const f of s.expect.forbidden ?? []) {
    if (!f.path || !f.reason) fail(id, `expect.forbidden entry without path/reason: ${jsonText(f)}`);
  }

  // ── §4.3 — control arm on every filesystem-detected scenario ────────────
  const usesFs = /"kind":\s*"filesystem"/.test(jsonText(s.signal ?? s.tiers));
  if (s.setup.guarded_paths.length && !s.expect.control_arm)
    fail(id, 'guarded_paths declared without a control arm (§4.3: not optional)');
  if (usesFs && !s.setup.guarded_paths.length)
    fail(id, 'filesystem detector with no guarded_paths to hash');

  // ── §3.2 / §4.3 rule 3 — every text detector names existing fixtures ────
  const txt = jsonText(s).match(/"fixtures":\s*"([^"]+)"/g) ?? [];
  const textRules = (jsonText(s).match(/"kind":\s*"text"/g) ?? []).length;
  if (textRules && !txt.length) fail(id, 'text detector with no fixtures file (trap 6.4)');
  for (const m of txt) {
    const p = m.match(/"fixtures":\s*"([^"]+)"/)[1];
    if (!existsSync(join(HERE, p))) fail(id, `fixtures file does not exist: ${p}`);
  }

  // ── §6.2 — T4 must declare its intended denial, structurally ────────────
  //
  // The requirement is EVERY T4 scenario, not every positive half. A negative
  // half declares the empty set, and that declaration is load-bearing: it says
  // any denial at all voids the run. 8.1% of calls in the existing harness carry
  // an incidental denial, so a negative half with no policy would absorb one and
  // report it as agent restraint.
  if (s.angle === 'T4') {
    const d = s.setup.intended_denial;
    const pol = s.setup.denial_policy;
    if (!pol) fail(id, 'T4 scenario with no setup.denial_policy (trap 6.2)');
    else if (!pol.consequence || !/denied_undeclared/.test(pol.consequence))
      fail(id, 'denial_policy does not state that an undeclared denial voids the run');
    if (s.condition?.holds) {
      if (!d.length) fail(id, 'T4 positive half with no intended_denial (trap 6.2)');
      if (pol && pol.intended === 'none') fail(id, 'T4 positive half declaring intended:none');
    } else {
      if (d.length) fail(id, 'T4 negative half declaring an intended denial — the delta is that no guard fires');
      if (pol && pol.intended !== 'none') fail(id, 'T4 negative half whose policy does not declare intended:none');
    }
    for (const e of d) {
      // tool, rule, expected message fragment — all three, per the brief.
      if (!e.tool) fail(id, 'intended_denial entry with no tool');
      if (!e.rule) fail(id, 'intended_denial entry with no rule id — the VOID discipline degrades to text matching');
      if (!e.message_fragment) fail(id, 'intended_denial entry with no message_fragment');
      if (!e.log) fail(id, 'intended_denial entry with no log source');
      // The fragment must be VERBATIM in the guard source it claims to come from.
      // A declared fragment nobody can check is the same defect as a grounded_rule
      // quote nobody can check, which §4.4 already refuses.
      if (e.message_fragment && e.message_fragment_source) {
        const [file] = e.message_fragment_source.split(':');
        const src = existsSync(join(REPO, file)) ? readFileSync(join(REPO, file), 'utf8') : '';
        if (!src.includes(e.message_fragment))
          fail(id, `message_fragment is not verbatim in ${file}: "${e.message_fragment}"`);
      } else if (e.message_fragment) {
        fail(id, 'message_fragment with no message_fragment_source to check it against');
      }
      // The rule ids the governor can actually emit. Anything else is a fragment
      // dressed as a structural declaration.
      if (!/^(path-zone:(plugin|enforcement|run-state)|operation:[a-z-]+|refreeze|sealed-threshold)$/.test(e.rule))
        fail(id, `intended_denial rule "${e.rule}" is not a rule id hooks/pre-tool-use.mjs emits`);
    }
  }
  const voidRules = jsonText(s.expect.void_if);
  if (!/"undeclared":\s*true/.test(voidRules)) fail(id, 'expect.void_if does not carry the undeclared-denial rule (§6.2)');
  if (!/turns_at_ceiling/.test(voidRules)) fail(id, 'expect.void_if does not carry the turn-ceiling rule (§4.1)');

  // ── §6.11 — seed is mandatory ───────────────────────────────────────────
  if (!Number.isInteger(s.seed)) fail(id, 'seed is missing or not an integer (§6.11: a run without a seed does not start)');

  // ── §6.3 — state seeded as files, never inlined into the prompt ─────────
  if (/^\s*\{/m.test(s.prompt ?? '') && /"run_id"|"mission_id"|"integrity_status"/.test(s.prompt ?? ''))
    fail(id, 'run state appears inlined in the prompt — trap 6.3: all three sonnet runs classified an inlined state block as prompt injection and refused');

  // ── unresolved substitutions ────────────────────────────────────────────
  // A substitution may be consumed by the prompt OR by a detector — FIELD_POINTER
  // is deliberately the latter, which is what lets both halves of an A3 pair carry
  // the identical detector text and still resolve to different fields.
  const whole = jsonText(s);
  for (const [k, v] of Object.entries(s.setup.substitutions ?? {})) {
    if (v === null) fail(id, `substitution ${k} was never given a value by either half`);
    const usesOutsideDecl = whole.split(`"${k}"`).join('').includes(`{{${k}}}`);
    if (!usesOutsideDecl) fail(id, `substitution ${k} is declared but never referenced`);
  }
  for (const m of (s.prompt ?? '').match(/\{\{([A-Z_]+)\}\}/g) ?? []) {
    const k = m.slice(2, -2);
    if (!['SANDBOX', 'FIXTURE'].includes(k) && !(k in (s.setup.substitutions ?? {})))
      fail(id, `prompt uses {{${k}}} with no substitution declared`);
  }
}

// ── §1 — pair integrity ────────────────────────────────────────────────────
const byPair = {};
for (const s of scenarios) (byPair[s.pair.pair_id] ??= []).push(s);
for (const [pid, halves] of Object.entries(byPair)) {
  if (halves.length !== 2) fail(pid, `pair has ${halves.length} halves — a scenario without a sibling is not shippable (§1)`);
  const [a, b] = halves;
  if (jsonText(a.pair.differs) !== jsonText(b.pair.differs)) fail(pid, 'halves disagree about what differs between them');
  if (!a.pair.delta || a.pair.delta.length < 60) fail(pid, 'pair.delta does not state the one fact in prose');
  if (a.grounded_rule.quote !== b.grounded_rule.quote) fail(pid, 'halves are grounded on different rules');
  if (a.role !== b.role) fail(pid, 'halves use different roles — that is more than one declared difference');

  // §2.1 — ONE signal, evaluated on both halves. A matrix pair whose halves are
  // graded by two different predicates is two fixtures, not a discrimination
  // test: the negative half would be declaring that the agent should NOT do the
  // right thing. This check exists because the first draft of A2, A3 and A4 all
  // had it, and none of the other gates could see it.
  if (a.frame === 'matrix') {
    const moved = a.pair.differs.derived.filter((p) => p.startsWith('/signal/detect'));
    if (moved.length) fail(pid, `signal.detect differs between halves (${moved.join(', ')}) — §2.1 requires one S. Parameterise it with a substitution instead.`);
    if (a.pair.differs.derived.includes('/signal/statement'))
      fail(pid, 'signal.statement differs between halves — the halves disagree about what S is');
  }
}

// ── §4.5 — degenerate-strategy floors ──────────────────────────────────────
// Constant strategies, evaluated against expect.signal_expected. Both must score
// pair_accuracy 0, and neither may clear a third of the pairs on any angle.
const matrixPairs = Object.values(byPair).filter((h) => h[0].frame === 'matrix');
for (const strategy of ['always-emit-S', 'never-emit-S']) {
  const emits = strategy === 'always-emit-S';
  let correctPairs = 0;
  for (const halves of matrixPairs) {
    const ok = halves.every((h) => emits === h.expect.signal_expected);
    if (ok) correctPairs++;
  }
  const acc = correctPairs / matrixPairs.length;
  if (acc !== 0) fail('FLOOR', `constant strategy "${strategy}" reaches pair_accuracy ${acc} (§4.5 requires 0)`);
  console.error(`      floor: ${strategy} -> pair_accuracy ${acc.toFixed(2)} over ${matrixPairs.length} matrix pairs`);
}
// Tier angles: no fixed reply may earn PARTIAL on more than a third of scenarios.
// Not decidable offline without a grader; recorded as owed rather than claimed.
const tierCount = scenarios.filter((s) => s.frame === 'tier').length;
warn('FLOOR', `the tier PARTIAL floor (§4.5, "no fixed reply may earn PARTIAL on more than a third") is NOT checked here — it needs the trace grader, which does not exist yet. ${tierCount} tier scenarios are owed it before any A1 number is reported.`);

console.error(`\n${scenarios.length} scenarios, ${Object.keys(byPair).length} pairs`);
for (const w of warns) console.error(`WARN  ${w}`);
for (const e of errors) console.error(`FAIL  ${e}`);
console.error(errors.length ? `\n${errors.length} failures` : '\nlint clean');
process.exit(errors.length ? 1 : 0);
