#!/usr/bin/env node
/**
 * ci/analyze-calibration.mjs — read a bench run as a CALIBRATION, not a result.
 *
 *   node ci/analyze-calibration.mjs ci/out/lite
 *
 * §4.1's order, and it is not negotiable: VOID accounting comes first, and no
 * cell is reported until the harness-caused void rate is known. The pilot
 * published a 6.5% TPR from runs where the stub had served six unscripted calls
 * and zero scripted ones; the number was arithmetic over an outage.
 *
 * Every VOID is printed with its cause, because a void is a work item — a
 * scenario whose `tool_results` needs entries, or a guard that fired when the
 * scenario said none would — and an unattributed void rate is just a smaller
 * version of the same mistake.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const dir = resolve(process.argv[2] ?? 'ci/out/lite');
if (!existsSync(dir)) { console.error(`no ${dir}`); process.exit(2); }

const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
const scenarios = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const records = scenarios.flatMap((s) => (s.records ?? []).map((r) => ({ ...r, sc: s })));

const n = records.length;
if (!n) { console.error('no records — the run produced nothing to read'); process.exit(2); }

// ── 1. VOID FIRST ────────────────────────────────────────────────────────────
const voids = records.filter((r) => r.status === 'VOID');
const harness = voids.filter((r) => r.failure_kind === 'harness_error' || r.failure_kind === 'evaluator_error');
const rate = (voids.length / n) * 100;
const hrate = (harness.length / n) * 100;

console.log(`# calibration: ${scenarios.length} scenarios, ${n} runs\n`);
console.log(`VOID          ${voids.length}/${n}  (${rate.toFixed(1)}%)`);
console.log(`  harness     ${harness.length}/${n}  (${hrate.toFixed(1)}%)   <- §4.1 saturation warning fires above 2%`);
console.log(`  declared    ${voids.length - harness.length}/${n}`);

if (voids.length) {
  console.log('\n## every void, with its cause — each one is a work item');
  const byKind = {};
  for (const r of voids) (byKind[r.failure_kind ?? 'unattributed'] ??= []).push(r);
  for (const [kind, rs] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n### ${kind} — ${rs.length}`);
    for (const r of rs) console.log(`  ${r.sc.scenario.padEnd(40)} ${String(r.note ?? '').slice(0, 130)}`);
  }
}

// ── 2. STUB HEALTH — the pilot's largest single distortion ───────────────────
const stubbed = records.filter((r) => Array.isArray(r.stub_calls) && r.stub_calls.length);
if (stubbed.length) {
  const k = {};
  for (const r of stubbed) for (const c of r.stub_calls) k[c.kind] = (k[c.kind] ?? 0) + 1;
  const un = k.unscripted ?? 0;
  const tot = Object.values(k).reduce((a, b) => a + b, 0);
  console.log(`\n## stub health — ${stubbed.length} stub-backed runs, ${tot} calls served`);
  console.log(`   ${JSON.stringify(k)}`);
  console.log(`   unscripted ${((un / tot) * 100).toFixed(1)}% of calls${un ? ' — each is a missing setup.tool_results entry' : ''}`);
  if (un) {
    const need = {};
    for (const r of stubbed) for (const c of r.stub_calls) if (c.kind === 'unscripted') (need[r.sc.scenario] ??= new Set()).add(c.tool);
    for (const [s, tools] of Object.entries(need)) console.log(`     ${s.padEnd(40)} ${[...tools].join(', ')}`);
  }
}

// ── 3. ONLY NOW, THE CELLS ───────────────────────────────────────────────────
const scored = records.filter((r) => r.status === 'SCORED');
console.log(`\n## scored: ${scored.length}/${n}`);
if (hrate > 2) {
  console.log('\n!! harness-caused VOID is above the 2% saturation threshold.');
  console.log('!! The cells below describe a partly-broken instrument. Fix the voids, rerun, then read them.');
}
const byAngle = {};
for (const r of scored) {
  const a = (byAngle[r.sc.angle] ??= { TP: 0, FP: 0, TN: 0, FN: 0, PASS: 0, PARTIAL: 0, FAIL: 0, frame: r.sc.frame });
  if (r.class && a[r.class] !== undefined) a[r.class] += 1;
  if (r.tier && a[r.tier] !== undefined) a[r.tier] += 1;
}
console.log('\n| angle | frame | TP | FP | TN | FN | PASS | PARTIAL | FAIL |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [a, c] of Object.entries(byAngle).sort()) {
  console.log(`| ${a} | ${c.frame} | ${c.TP} | ${c.FP} | ${c.TN} | ${c.FN} | ${c.PASS} | ${c.PARTIAL} | ${c.FAIL} |`);
}

// ── 4. FAILURE KINDS — the thing 46 scenarios could not report ───────────────
const kinds = {};
for (const r of scored) if (r.failure_kind) kinds[r.failure_kind] = (kinds[r.failure_kind] ?? 0) + 1;
const nullKind = scored.filter((r) => (r.class === 'FN' || r.tier === 'FAIL') && !r.failure_kind).length;
console.log(`\n## failure kinds: ${JSON.stringify(kinds)}`);
console.log(`   FAIL/FN with no attributable kind: ${nullKind}  <- was every one of them before this run`);

const cost = records.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
console.log(`\ncost $${cost.toFixed(2)} over ${n} runs ($${(cost / n).toFixed(3)}/run)`);
