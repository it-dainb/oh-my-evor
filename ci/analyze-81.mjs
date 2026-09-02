/**
 * ci/analyze-81.mjs — plan item 8.1's scoring pass.
 *
 *   node ci/analyze-81.mjs ci/out/matrix-81
 *
 * WHY THIS DOES NOT DIVIDE BY THE NUMBER OF CALLS.
 *
 * Running one case five times gives five readings OF THAT CASE, not five
 * independent facts about the role. Treating 93 cases x 5 repeats as n=465
 * counts the same question five times and reports a confidence interval built
 * on a sample size the design never had — RC7's error exactly: a number right
 * about something narrower than what it is quoted for.
 *
 * Cases are the sampling unit. Repeats shrink the noise WITHIN a case and buy
 * nothing about the population of cases, so precision saturates at the
 * between-case variance no matter how much budget is spent on repeats. That
 * ceiling is reported below as `repeat_saturation`: if within-case variance is
 * already small next to between-case variance, more repeats cannot help and the
 * honest way to a tighter interval is more CASES.
 *
 * So: per case, each arm's success RATE over its repeats; the paired
 * difference; then a cluster bootstrap resampling CASES (not calls).
 */
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const dir = resolve(process.argv[2] ?? 'ci/out/matrix-81');
const files = readdirSync(dir).filter((f) => f.endsWith('-report.json'));
if (!files.length) { console.error(`no *-report.json under ${dir}`); process.exit(2); }

// Deterministic PRNG — a bootstrap that cannot be re-run to the same numbers is
// not evidence anyone else can check.
let seed = 0x2f6e2b1;
const rnd = () => (((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000));

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const pp = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;

function bootstrapCI(perCaseDiffs, iters = 20000) {
  const n = perCaseDiffs.length;
  if (!n) return { lo: NaN, hi: NaN };
  const means = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += perCaseDiffs[(rnd() * n) | 0];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(iters * 0.025)], hi: means[Math.floor(iters * 0.975)] };
}

const allDiffs = [];
const rows = [];

for (const f of files.sort()) {
  const rep = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const records = rep.records ?? [];
  const arms = [...new Set(records.map((r) => r.tier))];
  const spec = JSON.parse(readFileSync(resolve(`evals/${f.replace('-report.json', '')}/spec.json`), 'utf8'));
  const currentArm = spec.arms.find((a) => /current/i.test(a.label ?? ''));
  const current = `${currentArm.model}-${currentArm.effort}`;
  const candidate = arms.find((a) => a !== current);
  if (!candidate) { console.log(`${f}: only one arm present — no comparison`); continue; }

  const byCase = new Map();
  let cliErrors = 0;
  for (const r of records) {
    const k = r.case_id ?? r.case;
    if (!byCase.has(k)) byCase.set(k, { [current]: [], [candidate]: [] });
    const bucket = byCase.get(k)[r.tier];
    if (!bucket) continue;
    // `unparseable` is the ARM's failure — it emitted text the contract cannot
    // read, which is the boundary not holding. It scores 0.
    //
    // `cli_error` is NOT: a timeout, a rate limit or an abnormal exit is the
    // harness failing, and scoring it 0 charges the model for the scheduler.
    // That is precisely how the first forge-junior tier matrix produced numbers
    // about queueing and reported them as capability. Excluded from the rate,
    // counted separately, and loud if it is common enough to bias the result.
    if (r.status === 'cli_error') { cliErrors++; continue; }
    bucket.push(r.status === 'correct' ? 1 : 0);
  }

  const diffs = [];
  let curN = 0, canN = 0, curHit = 0, canHit = 0;
  let withinVar = 0, wCount = 0;
  for (const [, v] of byCase) {
    const a = v[current], b = v[candidate];
    if (!a.length || !b.length) continue;
    const ra = a.reduce((x, y) => x + y, 0) / a.length;
    const rb = b.reduce((x, y) => x + y, 0) / b.length;
    diffs.push(ra - rb);
    curN += a.length; canN += b.length;
    curHit += a.reduce((x, y) => x + y, 0); canHit += b.reduce((x, y) => x + y, 0);
    // Bernoulli within-case variance of the per-case mean, both arms pooled.
    if (a.length > 1) { withinVar += (ra * (1 - ra)) / a.length; wCount++; }
    if (b.length > 1) { withinVar += (rb * (1 - rb)) / b.length; wCount++; }
  }
  const mean = diffs.reduce((x, y) => x + y, 0) / (diffs.length || 1);
  const between = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, diffs.length - 1);
  const ci = bootstrapCI(diffs);
  allDiffs.push(...diffs);
  rows.push({
    role: rep.role, cases: diffs.length, current, candidate,
    curRate: curHit / curN, canRate: canHit / canN,
    mean, ci, within: wCount ? withinVar / wCount : NaN, between,
    cliErrors, cliErrorRate: cliErrors / Math.max(1, records.length),
  });
}

console.log(`\n8.1 — paired tier matrix, clustered on cases (n = CASES, not calls)\n`);
console.log(
  `${'role'.padEnd(22)} ${'cases'.padStart(5)} ${'current'.padStart(8)} ${'candidate'.padStart(9)}  ${'current-candidate'.padStart(17)}  95% CI (cluster bootstrap)`,
);
for (const r of rows) {
  console.log(
    `${r.role.padEnd(22)} ${String(r.cases).padStart(5)} ${pct(r.curRate).padStart(8)} ${pct(r.canRate).padStart(9)}  ${pp(r.mean).padStart(17)}  [${pp(r.ci.lo)}, ${pp(r.ci.hi)}]`,
  );
}

const badRows = rows.filter((r) => r.cliErrorRate > 0.02);
if (badRows.length) {
  console.log(
    `\nHARNESS ERRORS ABOVE 2% — ${badRows.map((r) => `${r.role} ${(r.cliErrorRate * 100).toFixed(1)}%`).join(', ')}.\n` +
    `These calls never reached the model. At this rate the comparison is between\n` +
    `two arms that were not given the same chance to answer; re-run before quoting it.`,
  );
}

const mean = allDiffs.reduce((x, y) => x + y, 0) / (allDiffs.length || 1);
const ci = bootstrapCI(allDiffs);
console.log(`\npooled over ${allDiffs.length} cases: ${pp(mean)}  95% CI [${pp(ci.lo)}, ${pp(ci.hi)}]`);
console.log(
  `\nNON-INFERIORITY at a 10pp margin: the candidate is non-inferior only if the\n` +
  `UPPER bound of (current - candidate) is below +10.0pp. Upper bound = ${pp(ci.hi)} — ` +
  `${ci.hi < 0.10 ? 'SUPPORTED' : 'NOT SUPPORTED'}.`,
);

const w = rows.reduce((s, r) => s + (isFinite(r.within) ? r.within : 0), 0) / rows.length;
const b = rows.reduce((s, r) => s + r.between, 0) / rows.length;
console.log(
  `\nrepeat_saturation: mean within-case variance ${w.toExponential(2)} vs between-case ${b.toExponential(2)}.\n` +
  `${w < b / 4
    ? 'Within-case noise is already small next to between-case spread: more repeats\nwill not tighten this interval. Only more CASES will.'
    : 'Within-case noise is still material; additional repeats would tighten this.'}`,
);
