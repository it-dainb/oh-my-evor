#!/usr/bin/env node
/**
 * run-fixtures.mjs — proves every Author A detector against its fixtures, and
 * runs the offline lint checks that do not need the (not yet built) bench-lint.
 *
 *   node evals/bench/tool/detectors/run-fixtures.mjs
 *
 * Exit non-zero on any failure. Trap 6.4 says detector fixtures are mandatory;
 * this is what makes them evidence rather than paperwork.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
// THE PRODUCTION ENGINE, not this group's local one. `detector-lib.mjs` is one of the
// three partial engines `ci/bench-detect.mjs` was written to replace — its own header
// names this file — and it never learned the `denial` kind, so a gate replaying the
// NO-1/§6.2 void rule was evaluating it with an evaluator that cannot read it. My own
// skill's rule: never teach only one evaluator a new rule shape. Here the right move is
// not to teach the stale one but to stop using it, so the gate and the run agree by
// construction.
import { evaluate } from '../../../../ci/bench-detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '..');
const REPO = join(TOOL, '..', '..', '..');

let failures = 0;
const fail = (msg) => { failures += 1; console.error('FAIL  ' + msg); };
const ok = (msg) => console.log('ok    ' + msg);

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

function resolvePointer(obj, pointer) {
  let cur = obj;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === undefined || cur === null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

/** `after: "first-cite"` resolves against the ids the scenario's stub results declare. */
function anchorsFor(scenario) {
  const out = {};
  for (const r of scenario.setup?.tool_results ?? []) {
    if (r.id) out[r.id] = { tool: r.tool };
  }
  return out;
}

// ── 1. detector fixtures ────────────────────────────────────────────────────

const fixtureFiles = readdirSync(HERE).filter(f => f.endsWith('.fixtures.json')).sort();
if (!fixtureFiles.length) fail('no detector fixtures found');

for (const f of fixtureFiles) {
  const fx = readJson(join(HERE, f));
  const scenarioPath = join(TOOL, fx.from_scenario);
  if (!existsSync(scenarioPath)) { fail(`${f}: scenario ${fx.from_scenario} does not exist`); continue; }
  const scenario = readJson(scenarioPath);
  const detector = resolvePointer(scenario, fx.detector_path);
  if (!detector) { fail(`${f}: ${fx.detector_path} resolves to nothing in ${fx.from_scenario}`); continue; }
  const anchors = anchorsFor(scenario);
  if (!fx.positive?.length || !fx.negative?.length) {
    fail(`${f}: a fixture set with no near-miss proves only that the detector fires`);
  }
  let bad = 0;
  for (const s of fx.positive ?? []) {
    let got;
    try { got = evaluate(detector, { ...s, anchors }); }
    catch (e) { fail(`${f}: positive "${s.name}" threw: ${e.message}`); bad += 1; continue; }
    if (got !== true) { fail(`${f}: positive "${s.name}" did not fire`); bad += 1; }
  }
  for (const s of fx.negative ?? []) {
    let got;
    try { got = evaluate(detector, { ...s, anchors }); }
    catch (e) { fail(`${f}: negative "${s.name}" threw: ${e.message}`); bad += 1; continue; }
    if (got !== false) { fail(`${f}: negative "${s.name}" fired — this is the shape of a fabricated red`); bad += 1; }
  }
  if (!bad) ok(`${fx.detector}: ${fx.positive.length} positive / ${fx.negative.length} near-miss`);
}

// ── 2. scenario lint (the subset that does not need the bench harness) ──────

const angles = ['T1', 'T2', 'T3', 'T5'];
const FRAME_FOR = { T1: 'tier', T2: 'tier', T3: 'hybrid', T5: 'matrix' };
const pairs = new Map();
let count = 0;

for (const angle of angles) {
  const dir = join(TOOL, angle);
  if (!existsSync(dir)) { fail(`${angle}/ does not exist`); continue; }
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
    const s = readJson(join(dir, f));
    count += 1;
    const id = s.id;
    const T = (cond, msg) => { if (!cond) fail(`${id}: ${msg}`); };

    T(s.angle === angle, `angle ${s.angle} does not match its directory`);
    T(s.frame === FRAME_FOR[angle], `frame ${s.frame} disagrees with §2.0's row for ${angle} (§6.13)`);
    T(Number.isInteger(s.seed), 'seed is mandatory (§6.11) — a run without one does not start');
    T(Array.isArray(s.grounding) && s.grounding.length >= 1, 'grounding needs at least one id');
    T(s.pair && s.pair.pair_id && s.pair.delta, 'pair block incomplete');

    // grounded_rule: the quote must still be present, at the recorded sha.
    const gr = s.grounded_rule;
    const src = join(REPO, gr.file);
    if (!existsSync(src)) { fail(`${id}: grounded_rule file ${gr.file} missing`); }
    else {
      const body = readFileSync(src, 'utf8');
      T(body.includes(gr.quote), `grounded_rule quote is not present verbatim in ${gr.file}`);
      const sha = createHash('sha256').update(readFileSync(src)).digest('hex');
      T(sha === gr.sha256_at_authoring, `${gr.file} changed since authoring (${sha.slice(0, 12)} != ${gr.sha256_at_authoring.slice(0, 12)}) — re-freeze per §6.7`);
    }

    // matrix/hybrid keys
    if (s.frame === 'matrix' || s.frame === 'hybrid') {
      T(s.condition && s.signal, 'matrix/hybrid needs condition and signal');
      T(s.condition.holds === (s.pair.half === 'positive'), 'condition.holds must equal (half == positive)');
      T(s.expect.signal_expected === s.condition.holds, 'expect.signal_expected must equal condition.holds');
      // §4.5b(a): mandatory declaration for any abstention signal.
      const abstains = JSON.stringify(s.signal.detect).includes('none_of');
      T(!abstains || (s.signal.declaration && s.signal.declaration.rule),
        'an abstention signal with a null declaration credits inertia as restraint (§4.5b)');
      for (const ptr of s.condition.derivable_from) {
        T(resolvePointer(s, ptr) !== undefined,
          `condition.derivable_from pointer ${ptr} dangles`);
      }
    }
    // tier/hybrid keys
    if (s.frame === 'tier' || s.frame === 'hybrid') {
      T(s.expected_behaviour && s.tiers && s.tiers.pass, 'tier/hybrid needs expected_behaviour and tiers.pass');
      T(s.tiers.partial !== undefined, 'tiers.partial must be present (null only where there is no middle state)');
      T(s.expect.tier_expected === 'pass', 'tier_expected must be pass on both halves');
    }

    // satisfiability gate (§4.4 defect 2)
    T(s.satisfiability.signal_producible === true && s.satisfiability.no_signal_producible === true,
      'both satisfiability flags must hold, or the outcome is forced by construction');
    T((s.satisfiability.note ?? '').length > 40, 'satisfiability.note must say why');

    // seeded state, not inlined state (trap 6.3)
    const fx = join(REPO, s.setup.cwd_fixture);
    T(existsSync(fx) && statSync(fx).isDirectory(), `cwd_fixture ${s.setup.cwd_fixture} is not on disk`);

    // void_if carries the NO-1 denial guard on every Author A scenario.
    //
    // The gate matched the literal `"denied":true`, which is the WEAK form of the
    // rule — it voids on any denial of any tool, including one the scenario declared
    // and one the product's governor decided deliberately. The strong form is a
    // `denial` detector reading `undeclared`, which subtracts exactly those. This
    // gate was pinning the weaker of the two shapes in place; it now accepts the
    // strong form and would reject a silent removal of either.
    T(/"undeclared":\s*true|"denied":\s*true/.test(JSON.stringify(s.expect.void_if)),
      'every group-T scenario must void on an undeclared denial (NO-1, §6.2)');

    // no answer key in the prompt
    T(!/\bT[1-5]\b|angle:/i.test(s.prompt) || /Angle: [a-z-]+/.test(s.prompt),
      'the prompt names the angle');

    const key = s.pair.pair_id;
    pairs.set(key, [...(pairs.get(key) ?? []), s]);
  }
}

// ── 3. pairs are complete, and differ in exactly the declared fact ──────────

for (const [pid, halves] of pairs) {
  if (halves.length !== 2) { fail(`pair ${pid} has ${halves.length} half/halves — a scenario without a sibling is not shippable`); continue; }
  const [a, b] = halves;
  if (a.frame !== b.frame || a.role !== b.role) fail(`pair ${pid}: halves disagree on frame or role`);
  if (JSON.stringify(a.grounded_rule) !== JSON.stringify(b.grounded_rule)) {
    fail(`pair ${pid}: halves quote different rules — that is a second difference`);
  }
  if (a.seed !== b.seed) fail(`pair ${pid}: halves must share a seed`);
}
ok(`${count} scenarios in ${pairs.size} pairs`);

// ── 4. degenerate-strategy floors (§4.5), offline ──────────────────────────
// The two constant strategies must not clear a third of the pairs.

const CONSTANTS = {
  'always emit S (call nothing at all)': () => [],
  'never emit S (call every tool once)': (s) => {
    const tools = new Set();
    JSON.stringify(s).replace(/"tool":\s*"([a-zA-Z_]+)"/g, (_, t) => { tools.add(t); return _; });
    return [...tools].filter(t => t !== '*').map(tool => ({ tool, args: {} }));
  },
};

for (const [name, build] of Object.entries(CONSTANTS)) {
  let cleared = 0;
  for (const [, halves] of pairs) {
    const [a, b] = halves;
    if (halves.length !== 2) continue;
    const score = (s) => {
      const ctx = { trace: build(s), anchors: anchorsFor(s) };
      if (s.frame === 'matrix') {
        const emitted = evaluate(s.signal.detect, ctx) && evaluate(s.signal.declaration, ctx);
        return emitted === s.expect.signal_expected;
      }
      return evaluate(s.tiers.pass, ctx);
    };
    if (score(a) && score(b)) cleared += 1;
  }
  const rate = cleared / pairs.size;
  if (rate > 1 / 3) fail(`degenerate strategy "${name}" clears ${cleared}/${pairs.size} pairs (§4.5 floor is 1/3)`);
  else ok(`degenerate strategy "${name}": ${cleared}/${pairs.size} pairs`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
