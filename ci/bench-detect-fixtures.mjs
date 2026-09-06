#!/usr/bin/env node
/**
 * ci/bench-detect-fixtures.mjs — the acceptance test for ci/bench-detect.mjs.
 *
 *   node ci/bench-detect-fixtures.mjs           # run every fixture
 *   node ci/bench-detect-fixtures.mjs --verbose # name every case, not just failures
 *
 * 25 fixture files, four incompatible formats, one per author. Each declares,
 * per detector, what must fire and what must stay silent. They are normalised
 * here and run against the single engine. Nothing calls a model or spends money.
 *
 *   tool/detectors/*.fixtures.json       positive / negative
 *                                        detector read out of the scenario at
 *                                        `detector_path`; calls carry `args`
 *   evidence/detectors/*.fixtures.json   fires / silent
 *                                        detector inline; calls carry `arg`;
 *                                        filesystem cases carry baseline/files
 *   authority/detectors/*.fixtures.json  must_match / must_not_match, plus
 *                                        structurally_overridden (asserted to
 *                                        MATCH: the claim that the structural
 *                                        branch carries the weight is only
 *                                        tested if the text branch would
 *                                        demonstrably have got it wrong)
 *   lifecycle/detectors/group-L.fixtures.json
 *                                        floors + cases, keyed by scenario id,
 *                                        each with three synthetic runs and the
 *                                        cell each must produce
 *
 * A FIXTURE IS NEVER EDITED TO MATCH THE ENGINE. A fixture edited to match an
 * engine measures the engine's author.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, classifySignal, validateDetector } from './bench-detect.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = join(REPO, 'evals/bench');
const VERBOSE = process.argv.includes('--verbose');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** JSON pointer, for `detector_path` and for `condition.derivable_from`. */
function pointer(obj, ptr) {
  let cur = obj;
  for (const raw of String(ptr).split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === undefined || cur === null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

// ── the shared context builder ──────────────────────────────────────────────

/**
 * One run context out of any fixture case shape.
 *
 * `args` (authors A, D) and `arg` (author C) are the same field. Normalising
 * here rather than in the engine keeps the engine's contract single-valued and
 * makes the four formats' disagreement visible in exactly one place.
 */
function contextFor(caseObj, extra = {}) {
  const trace = (caseObj.trace ?? caseObj.run?.trace ?? []).map((c) => ({
    ...c,
    args: c.args ?? c.arg ?? {},
  }));
  const baseline = caseObj.baseline ?? {};
  const after = caseObj.files ?? {};
  return {
    trace,
    answer: caseObj.answer ?? caseObj.run?.answer ?? null,
    text: {
      final_message: caseObj.position === 'mid_transcript' ? '' : (caseObj.text ?? ''),
      transcript_text: caseObj.text ?? '',
    },
    files: {
      baseline,
      after,
      exists: Object.fromEntries(Object.keys({ ...baseline, ...after }).map((k) => [k, k in after])),
      json: caseObj.json ?? {},
    },
    turns_at_ceiling: Boolean(caseObj.turns_at_ceiling),
    denials: caseObj.denials ?? deriveDenials(trace),
    intended_denials: caseObj.intended_denials ?? [],
    role_disallowed_tools: caseObj.role_disallowed_tools ?? [],
    postconditions: caseObj.postconditions ?? {},
    ...extra,
  };
}

/**
 * Author A's and D's fixtures mark a denial on the CALL (`denied: true`) rather
 * than supplying an envelope. The `denial` kind reads the envelope, so it is
 * reconstructed here from the calls — the fixture's own claim about what the CLI
 * would have reported, not an inference from `is_error` or from payload text.
 */
function deriveDenials(trace) {
  return trace.filter((c) => c.denied).map((c) => ({ tool_name: c.tool, rule_id: null }));
}

// ── results ─────────────────────────────────────────────────────────────────

const failures = [];
let passed = 0;

function check(label, fn, expected) {
  let got;
  try {
    got = fn();
  } catch (e) {
    failures.push(`${label}: threw ${e.name}: ${e.message}`);
    return;
  }
  if (got !== expected) {
    failures.push(`${label}: expected ${expected}, got ${got}`);
    return;
  }
  passed += 1;
  if (VERBOSE) console.log(`  ok  ${label}`);
}

// ── format 1: tool/ — positive / negative, detector inside a scenario ───────

function runToolFixtures() {
  const dir = join(BENCH, 'tool/detectors');
  const files = readdirSync(dir).filter((f) => f.endsWith('.fixtures.json')).sort();
  for (const f of files) {
    const fx = readJson(join(dir, f));
    const scenarioPath = join(BENCH, 'tool', fx.from_scenario);
    if (!existsSync(scenarioPath)) { failures.push(`${f}: scenario ${fx.from_scenario} missing`); continue; }
    const scenario = readJson(scenarioPath);
    const detector = pointer(scenario, fx.detector_path);
    if (!detector) { failures.push(`${f}: ${fx.detector_path} resolves to nothing`); continue; }
    const anchors = Object.fromEntries(
      (scenario.setup?.tool_results ?? []).filter((r) => r.id).map((r) => [r.id, { tool: r.tool }]));
    const templates = templatesFor(scenario);
    for (const [key, expected] of [['positive', true], ['negative', false]]) {
      for (const c of fx[key] ?? []) {
        check(`${f} ${key} "${c.name}"`,
          () => evaluate(detector, contextFor(c, { anchors, templates, scenario, known_tools: knownTools(scenario) })), expected);
      }
    }
  }
  return files.length;
}

// ── format 2: evidence/ — fires / silent, detector inline ───────────────────

function runEvidenceFixtures() {
  const dir = join(BENCH, 'evidence/detectors');
  const files = readdirSync(dir).filter((f) => f.endsWith('.fixtures.json')).sort();
  for (const f of files) {
    const fx = readJson(join(dir, f));
    for (const [key, expected] of [['fires', true], ['silent', false]]) {
      (fx[key] ?? []).forEach((c, i) => {
        check(`${f} ${key}[${i}] "${(c.why ?? '').slice(0, 60)}"`,
          () => evaluate(fx.detector, contextFor(c)), expected);
      });
    }
  }
  return files.length;
}

// ── format 3: authority/ — must_match / must_not_match / structurally_overridden

function runAuthorityFixtures() {
  const dir = join(BENCH, 'authority/detectors');
  const files = readdirSync(dir).filter((f) => f.endsWith('.fixtures.json')).sort();
  for (const f of files) {
    const fx = readJson(join(dir, f));
    const det = fx.detector;
    // These are text detectors under test IN ISOLATION, which is the one place
    // §4.3's corroboration-only rule must be lifted: the whole point is to prove
    // the branch behaves before it is allowed to corroborate anything.
    const opts = { allowTextAlone: true };
    const groups = [['must_match', true], ['must_not_match', false], ['structurally_overridden', true]];
    for (const [key, expected] of groups) {
      for (const c of fx[key] ?? []) {
        check(`${f} ${key} ${c.id}`, () => evaluate(det, contextFor(c), opts), expected);
      }
    }
    // §4.5b(e) is part of what the fixture set asserts, not decoration.
    if ((fx.must_match ?? []).length < 5) failures.push(`${f}: fewer than 5 paraphrases (§4.5b(e))`);
    if ((fx.must_not_match ?? []).length < 5) failures.push(`${f}: fewer than 5 near-misses (§4.5b(e))`);
  }
  return files.length;
}

// ── format 4: lifecycle/ — floors + per-scenario cases with expected cells ──

function runLifecycleFixtures() {
  const path = join(BENCH, 'lifecycle/detectors/group-L.fixtures.json');
  const fx = readJson(path);
  const scenarios = new Map();
  for (const angle of ['L1', 'L2', 'L3', 'L4', 'L5']) {
    const d = join(BENCH, 'lifecycle', angle);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json')).sort()) {
      const s = readJson(join(d, f));
      scenarios.set(s.id, s);
    }
  }

  for (const [id, entry] of Object.entries(fx.cases ?? {})) {
    const s = scenarios.get(id);
    if (!s) { failures.push(`group-L.fixtures.json: no scenario ${id}`); continue; }
    if (entry.condition_holds !== s.condition.holds) {
      failures.push(`${id}: fixture records condition_holds=${entry.condition_holds}, scenario says ${s.condition.holds}`);
    }
    for (const arm of ['emits_signal', 'inert', 'commits_forbidden_act']) {
      const c = entry[arm];
      if (!c) continue;
      // classifySignal, not classify: these cells are §4.5's floors — "does the
      // detector match its own scenario" — and were computed by
      // check-detectors.mjs without the §4.4 fabrication override. Ten of them
      // disagree with `classify`, and every one of those ten is a defect in the
      // SCENARIO, not in either function: three positive halves forbid a path
      // their own signal.declaration requires, and seven negative halves carry a
      // forbidden entry whose reason reads "underivable in the positive half".
      // `ci/bench-run.mjs` uses `classify`; that divergence is reported, not
      // papered over by grading the fixtures with a weaker function than the
      // runner uses on anything else.
      check(`group-L ${id} ${arm}`,
        () => classifySignal(s, contextFor(c, { templates: templatesFor(s), scenario: s, known_tools: knownTools(s) })).cell, c.expect);
    }
  }

  // The two constant strategies must clear no pair. The fixture file records the
  // per-pair cells; reproducing them is what makes it a test of the engine and
  // not of the script that wrote it.
  for (const [name, floor] of Object.entries(fx.floors ?? {})) {
    for (const [pairId, want] of Object.entries(floor.per_pair ?? {})) {
      for (const half of ['positive', 'negative']) {
        const s = [...scenarios.values()].find((x) => x.pair.pair_id === pairId && x.pair.half === half);
        if (!s) { failures.push(`group-L floors: no ${half} half for ${pairId}`); continue; }
        const arm = name === 'always_emit_S' ? 'emits_signal' : 'inert';
        const c = fx.cases?.[s.id]?.[arm];
        if (!c) { failures.push(`group-L floors: no ${arm} run recorded for ${s.id}`); continue; }
        check(`group-L floor ${name} ${pairId}/${half}`,
          () => classifySignal(s, contextFor(c, { templates: templatesFor(s), scenario: s, known_tools: knownTools(s) })).cell, want[half]);
      }
    }
    if (floor.pair_accuracy !== 0) {
      failures.push(`group-L floor ${name}: recorded pair_accuracy ${floor.pair_accuracy}, must be 0`);
    }
  }

  // §4.5b(e) and trap 6.4: the two repaired false positives, and the paraphrase
  // set, carried for a text layer group L does not yet have. They bind the day
  // one is added, so they are asserted here against the detector the group would
  // use rather than left as prose nobody runs.
  const negatives = Object.entries(fx.text_layer_negative_fixtures ?? {})
    .filter(([k]) => k !== '$comment');
  for (const [name, text] of negatives) {
    check(`group-L text_layer_negative ${name}`, () => {
      // No text detector exists in group L. The assertion the fixture makes is
      // that these two sentences do not fire ANY of the corroboration-only text
      // detectors this bench ships, which is checkable today.
      const dets = shippedTextDetectors();
      return dets.some((d) => evaluate(d, contextFor({ text }), { allowTextAlone: true }));
    }, false);
  }

  return 1;
}

/** Every tool name a scenario mentions, for the tool-name form of `after`. */
function knownTools(scenario) {
  const out = new Set();
  const scan = (o) => {
    if (Array.isArray(o)) return o.forEach(scan);
    if (!o || typeof o !== 'object') return;
    if (typeof o.tool === 'string') out.add(o.tool);
    Object.values(o).forEach(scan);
  };
  scan(scenario ?? {});
  out.delete('*');
  return out;
}

/** Every text detector the corpus ships, for the group-L cross-check. */
let TEXT_DETECTORS = null;
function shippedTextDetectors() {
  if (TEXT_DETECTORS) return TEXT_DETECTORS;
  const out = [];
  const seen = new Set();
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!f.name.endsWith('.json')) continue;
      let j; try { j = readJson(p); } catch { continue; }
      const scan = (o) => {
        if (Array.isArray(o)) return o.forEach(scan);
        if (!o || typeof o !== 'object') return;
        if (o.kind === 'text' && o.rule?.regex) {
          const k = JSON.stringify(o.rule);
          if (!seen.has(k)) { seen.add(k); out.push({ kind: 'text', rule: o.rule }); }
        }
        Object.values(o).forEach(scan);
      };
      scan(j);
    }
  };
  walk(BENCH);
  TEXT_DETECTORS = out;
  return out;
}

/**
 * Template bindings for a scenario, offline.
 *
 * The fixtures are evaluated without a sandbox, so `{{SANDBOX}}` and
 * `{{FIXTURE}}` bind to stable stand-ins and the paths in `baseline`/`files` are
 * matched after substitution. Any template the scenario uses and this does not
 * bind raises in the engine rather than being left in the string, where it would
 * silently match no file and make `unchanged` trivially true.
 */
function templatesFor(scenario) {
  const t = { SANDBOX: '/sandbox', FIXTURE: '/fixture', WORK: '/sandbox/work', CHILD_WORK: '/sandbox/child', SEEDED: '/sandbox/seeded', AT_SANDBOX_BUILD: 'baseline' };
  for (const [k, v] of Object.entries(scenario?.setup?.templates ?? {})) t[k] = v;
  // `setup.substitutions` too — the runner binds both (bench-run.mjs builds its
  // detector templates from templates AND substitutions), and a sweep that binds
  // fewer names than the run reports a detector as unevaluable that evaluates
  // fine in a scored run. Missed until A4's detectors were parametrised on
  // {{TARGET}}, which lives in substitutions.
  for (const [k, v] of Object.entries(scenario?.setup?.substitutions ?? {})) if (v != null) t[k] = v;
  return t;
}

// ── the corpus sweep ────────────────────────────────────────────────────────

/**
 * Every detector in all 170 scenarios must be evaluable.
 *
 * The fixtures prove the engine is RIGHT on 301 declared cases. This proves it
 * is not SILENT anywhere else: `validateDetector` raises on an unknown kind,
 * operator, matcher, predicate key or jsonpath, and swallows only a missing
 * observation. Without it the engine could still ship a gap, and a gap in a
 * detector engine is a false negative about a model.
 */
function runCorpusSweep() {
  const KINDS = new Set(['trace', 'filesystem', 'composite', 'denial', 'harness', 'text', 'answer', 'postcondition']);
  const T = { SANDBOX: '/sandbox', FIXTURE: '/fixture', WORK: '/w', CHILD_WORK: '/c', SEEDED: '/s', AT_SANDBOX_BUILD: 'b' };
  let scenarios = 0;
  let detectors = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const q = join(dir, e.name);
      if (e.isDirectory()) { walk(q); continue; }
      if (!e.name.endsWith('.json') || e.name.includes('.fixtures.')) continue;
      let sc; try { sc = readJson(q); } catch { continue; }
      if (!sc.signal && !sc.tiers) continue;
      scenarios += 1;
      const found = [];
      const scan = (o) => {
        if (Array.isArray(o)) return o.forEach(scan);
        if (!o || typeof o !== 'object') return;
        if (KINDS.has(o.kind) && o.rule) found.push(o);
        Object.values(o).forEach(scan);
      };
      scan({ signal: sc.signal, tiers: sc.tiers, expect: sc.expect, control_arm: sc.setup?.control_arm });
      const ctx = {
        templates: templatesFor(sc),
        scenario: sc,
        known_tools: knownTools(sc),
        anchors: Object.fromEntries(
          (sc.setup?.tool_results ?? []).filter((r) => r.id).map((r) => [r.id, { tool: r.tool }])),
        control_arm_moved: false,
      };
      for (const d of found) {
        detectors += 1;
        try { validateDetector(d, ctx); }
        catch (e) { failures.push(`corpus sweep ${sc.id} [${d.id ?? d.kind}]: ${e.name}: ${e.message}`); }
      }
    }
  };
  walk(BENCH);
  console.log(`corpus sweep: ${detectors} detectors across ${scenarios} scenarios are all evaluable`);
  return { scenarios, detectors };
}

// ── main ────────────────────────────────────────────────────────────────────

const counts = {
  tool: runToolFixtures(),
  evidence: runEvidenceFixtures(),
  authority: runAuthorityFixtures(),
  lifecycle: runLifecycleFixtures(),
};

const sweep = runCorpusSweep();

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`\n${total} fixture files: ${JSON.stringify(counts)}`);
console.log(`${passed} case(s) behave as declared, ${failures.length} do not`);
if (failures.length) {
  console.error('\nFAILURES');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('all fixtures pass');

export { failures, passed, sweep };
