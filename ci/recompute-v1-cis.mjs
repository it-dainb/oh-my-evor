/**
 * ci/recompute-v1-cis.mjs — plan item 8.3's arithmetic.
 *
 *   node ci/recompute-v1-cis.mjs
 *
 * §3 of docs/v1-cost-and-verification.md carries a Newcombe difference CI per
 * adopted row, and every one of them says "non-inferior" at a 10pp margin.
 * The denominators are CALLS: `36/36` is twelve cases run three times, and
 * `116/120` is ten cases run twelve times.
 *
 * Repeats of one case are not independent observations of the role. Counting
 * them as n asks the same question twelve times and reports the confidence of
 * having asked twelve different ones. This file recomputes each row with the
 * same rates and n = CASES, and prints both so the gap is visible.
 *
 * Neither column is the final answer. The published one is too narrow — that
 * much is certain, because its n is not the design's n. The n=cases column is
 * the conservative bound, since repeats do reduce measurement noise WITHIN a
 * case even though they add nothing between cases. The true interval lies
 * between them, and item 8.1's cluster bootstrap estimates it directly rather
 * than bounding it.
 *
 * The method is pinned by reproduction: run against the published call counts,
 * this file returns the published intervals to the decimal.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';

const wilson = (k, n, z = 1.96) => {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
};
const newcombe = (k1, n1, k2, n2) => {
  const [l1, u1] = wilson(k1, n1), [l2, u2] = wilson(k2, n2);
  const p1 = k1 / n1, p2 = k2 / n2;
  return [
    (p1 - p2 - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)) * 100,
    (p1 - p2 + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)) * 100,
  ];
};

// As published in §3, verbatim: [role, haiku_k, haiku_n, sonnet_k, sonnet_n].
const PUBLISHED = [
  ['acquirer', 36, 36, 36, 36], ['sage', 75, 78, 77, 78], ['sage-junior', 31, 33, 29, 33],
  ['probe', 66, 66, 66, 66], ['mutagen', 116, 120, 116, 120], ['forge-critic', 29, 30, 27, 30],
  ['forge-analyst', 101, 108, 103, 108],
];

const cases = {};
for (const d of readdirSync('evals')) {
  const p = resolve('evals', d, 'spec.json');
  if (existsSync(p)) cases[JSON.parse(readFileSync(p, 'utf8')).role.replace(/^evor-/, '')] = JSON.parse(readFileSync(p, 'utf8')).cases.length;
}

const f = (x) => x.toFixed(1).padStart(6);
console.log(`\n${'role'.padEnd(14)} ${'cases'.padStart(5)} ${'reps'.padStart(4)}  ${'published (n = calls)'.padStart(22)}  ${'n = CASES'.padStart(20)}  10pp gate`);
let failed = 0;
for (const [role, k1, n1, k2, n2] of PUBLISHED) {
  const nc = cases[role];
  if (!nc) { console.log(`${role.padEnd(14)} no spec — cannot recompute`); continue; }
  const [lo, hi] = newcombe(k1, n1, k2, n2);
  const [lo2, hi2] = newcombe(Math.round((k1 / n1) * nc), nc, Math.round((k2 / n2) * nc), nc);
  const clears = lo2 > -10;
  if (!clears) failed++;
  console.log(
    `${role.padEnd(14)} ${String(nc).padStart(5)} ${String(n1 / nc).padStart(4)}  [${f(lo)}, ${f(hi)}]  [${f(lo2)}, ${f(hi2)}]  ${clears ? 'clears' : 'FAILS'}`,
  );
}
console.log(
  `\n${failed} of ${PUBLISHED.length} adopted rows fail the 10pp non-inferiority gate once the\n` +
  `sampling unit is the case. Every one of them is currently published as\n` +
  `"non-inferior", and every one of those tiers shipped.`,
);
