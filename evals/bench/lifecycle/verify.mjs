#!/usr/bin/env node
/**
 * evals/bench/lifecycle/verify.mjs — the group-L freeze gate.
 *
 *   node evals/bench/lifecycle/verify.mjs           # verify, then write FREEZE.json
 *   node evals/bench/lifecycle/verify.mjs --check    # verify against the existing FREEZE.json
 *
 * Trap 6.7 says pairs are frozen before any live run and every post-hoc edit is
 * logged with its reason. Trap 6.8 says the whole thing is verified FROM THE
 * FILESYSTEM and not from an agent's report — because eight lanes of this repo's
 * own root-cause pass each reported having written a long report, no such file
 * existed, and several re-asserted it was present when told otherwise. That is
 * I-01/OVERCLAIM, the one category lane I found zero instances of in the run under
 * study: the instrumentation performed worse than the system it measured.
 *
 * So this file does not trust anything upstream of it. It re-derives the fixtures,
 * re-derives the scenarios, re-runs the detector floors, re-reads every grounded
 * rule out of its agent file, and hashes what is actually on disk.
 *
 * Exit 0 here is the only evidence that group L is shippable. Nothing in
 * AUTHORING-NOTE-D.md should be believed over this.
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CHECK = process.argv.includes('--check');
const sha = (s) => createHash('sha256').update(s).digest('hex');

const problems = [];
function step(label, fn) {
  try { const out = fn(); process.stderr.write(`  ok   ${label}\n`); return out; }
  catch (e) { process.stderr.write(`  FAIL ${label}\n`); problems.push(`${label}: ${String(e.stdout ?? e.message).trim()}`); return null; }
}

const node = (script, ...args) => execFileSync(process.execPath, [join(HERE, script), ...args], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

step('fixtures reproduce byte-for-byte and every pair differs only in its declared delta', () => node('seed-fixtures.mjs', '--check'));
step('scenarios reproduce byte-for-byte and every sibling differs only in the allowed keys', () => node('build-scenarios.mjs', '--check'));
step('detector floors (§4.5 nothing-can-pass, anything-passes, §4.5b inertia)', () => node('detectors/check-detectors.mjs', '--check'));

// ── independent re-read of every grounded rule, not via the generator ─────────
const scenarios = [];
for (const angle of ['L1', 'L2', 'L3', 'L4', 'L5']) {
  const dir = join(HERE, angle);
  if (!existsSync(dir)) { problems.push(`${angle}/ is missing`); continue; }
  for (const f of readdirSync(dir).sort()) if (f.endsWith('.json')) scenarios.push([join(dir, f), JSON.parse(readFileSync(join(dir, f), 'utf8'))]);
}
step(`grounded_rule quotes present verbatim at the recorded sha in all ${scenarios.length} scenarios`, () => {
  for (const [p, s] of scenarios) {
    const body = readFileSync(join(REPO, s.grounded_rule.file), 'utf8');
    if (sha(body) !== s.grounded_rule.sha256_at_authoring) throw new Error(`${s.id}: ${s.grounded_rule.file} has changed since authoring`);
    if (!body.includes(s.grounded_rule.quote)) throw new Error(`${s.id}: quote not present in ${s.grounded_rule.file}`);
  }
});

// ── every referenced path actually exists ────────────────────────────────────
step('every cwd_fixture, derivable_from pointer and guarded_path resolves on disk', () => {
  for (const [, s] of scenarios) {
    const fx = join(REPO, s.setup.cwd_fixture);
    if (!existsSync(fx)) throw new Error(`${s.id}: cwd_fixture missing: ${s.setup.cwd_fixture}`);
    for (const ptr of s.condition.derivable_from) {
      const rel = ptr.replace(/^\/setup\/cwd_fixture\//, '').split('#')[0];
      if (!existsSync(join(fx, rel))) throw new Error(`${s.id}: derivable_from dangling: ${rel}`);
    }
    for (const g of s.setup.guarded_paths) {
      if (!existsSync(join(REPO, g.path))) throw new Error(`${s.id}: guarded_path missing: ${g.path}`);
      if (sha(readFileSync(join(REPO, g.path), 'utf8')) !== g.sha256) throw new Error(`${s.id}: guarded_path sha drifted: ${g.path}`);
    }
    if (!existsSync(join(REPO, s.setup.mcp_config))) throw new Error(`${s.id}: mcp_config missing: ${s.setup.mcp_config}`);
  }
});

// ── schema conformance the taxonomy states as hard requirements ──────────────
step('schema conformance: frame matches the angle row, seed present, declaration non-null, pair complete', () => {
  const MATRIX = new Set(['L1', 'L2', 'L3', 'L4', 'L5']);
  const seen = new Set();
  for (const [, s] of scenarios) {
    if (!MATRIX.has(s.angle)) throw new Error(`${s.id}: unknown angle ${s.angle}`);
    // §2.0 / §6.13: all five group-L angles are matrix. bench-lint rejects a
    // scenario whose frame disagrees with its angle's row; this is that check.
    if (s.frame !== 'matrix') throw new Error(`${s.id}: frame ${s.frame} disagrees with the angle table (L1-L5 are all matrix)`);
    if (typeof s.seed !== 'number') throw new Error(`${s.id}: seed is mandatory (§6.11) — an unseeded run does not start`);
    if (seen.has(s.seed)) throw new Error(`${s.id}: seed ${s.seed} is not unique across scenarios`);
    seen.add(s.seed);
    // §4.5b(a): mandatory for every abstention signal. All fifteen positives are
    // abstentions, so this is unconditional here.
    if (s.signal.declaration == null) throw new Error(`${s.id}: signal.declaration is null`);
    if (s.condition.holds !== (s.pair.half === 'positive')) throw new Error(`${s.id}: condition.holds disagrees with pair.half`);
    if (s.expect.signal_expected !== s.condition.holds) throw new Error(`${s.id}: expect.signal_expected disagrees with condition.holds`);
    if (s.expect.class !== s.pair.half) throw new Error(`${s.id}: expect.class disagrees with pair.half`);
    if (!s.satisfiability.signal_producible || !s.satisfiability.no_signal_producible) {
      throw new Error(`${s.id}: the §4.4 satisfiability gate requires BOTH producible from the setup alone`);
    }
    if (!Array.isArray(s.grounding) || s.grounding.length < 1) throw new Error(`${s.id}: grounding needs >=1 entry`);
    // §4.3 detector precedence: a signal with a structural form must not be
    // detected by text. Group L uses no text detector at all; this asserts it.
    for (const d of [s.signal.detect, s.signal.declaration]) {
      if (d.kind === 'text') throw new Error(`${s.id}: a text detector reached group L — see AUTHORING-NOTE-D §4 before adding one`);
    }
  }
  // every scenario has exactly one sibling
  const pairs = {};
  for (const [, s] of scenarios) (pairs[s.pair.pair_id] ??= []).push(s.pair.half);
  for (const [id, halves] of Object.entries(pairs)) {
    if (halves.length !== 2 || !halves.includes('positive') || !halves.includes('negative')) {
      throw new Error(`${id}: a scenario without a sibling is not shippable (§1)`);
    }
  }
});

if (problems.length) {
  console.error('\n' + problems.map((p) => `FAIL ${p}`).join('\n\n'));
  process.exit(1);
}

// ── freeze ───────────────────────────────────────────────────────────────────
const files = {};
for (const [p] of scenarios) files[p.slice(REPO.length + 1)] = sha(readFileSync(p, 'utf8'));
for (const rel of ['evals/bench/lifecycle/seed-fixtures.mjs', 'evals/bench/lifecycle/build-scenarios.mjs',
  'evals/bench/lifecycle/detectors/check-detectors.mjs', 'evals/bench/lifecycle/detectors/group-L.fixtures.json',
  'evals/bench/lifecycle/fixtures/MANIFEST.sha256.json']) files[rel] = sha(readFileSync(join(REPO, rel), 'utf8'));

const freeze = {
  $comment: [
    'Trap 6.7. These hashes are the frozen state of group L before any live run.',
    'Any scenario edited after a scored run must be re-frozen here and re-run from',
    'zero, with the reason logged in AUTHORING-NOTE-D.md. An edit that is not in',
    'that log is a bench fitted to the model, which measures the author.',
  ],
  frozen_at: '2026-09-02',
  scenarios: scenarios.length,
  pairs: scenarios.length / 2,
  agent_files: Object.fromEntries([...new Set(scenarios.map(([, s]) => s.grounded_rule.file))]
    .map((f) => [f, sha(readFileSync(join(REPO, f), 'utf8'))])),
  files,
};
const fpath = join(HERE, 'FREEZE.json');
const body = JSON.stringify(freeze, null, 2) + '\n';
if (CHECK) {
  if (!existsSync(fpath)) { console.error('FAIL FREEZE.json missing'); process.exit(1); }
  const onDisk = JSON.parse(readFileSync(fpath, 'utf8'));
  const drift = Object.entries(freeze.files).filter(([k, v]) => onDisk.files?.[k] !== v).map(([k]) => k);
  if (drift.length) { console.error(`FAIL frozen files have drifted:\n  ${drift.join('\n  ')}`); process.exit(1); }
  console.log(`\nfrozen state matches: ${scenarios.length} scenarios / ${scenarios.length / 2} pairs`);
} else {
  writeFileSync(fpath, body);
  console.log(`\nfroze ${scenarios.length} scenarios / ${scenarios.length / 2} pairs -> evals/bench/lifecycle/FREEZE.json`);
}
