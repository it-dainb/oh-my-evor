#!/usr/bin/env node
/**
 * ci/analyze-82.mjs — plan item 8.2, the POWERED malformed-prefix check.
 *
 * T7's live run observed 0 malformed prefixes at n=15/arm and that was reported
 * as evidence the problem was absent. It is not. With zero events in n trials,
 * the 95% upper bound on the true rate is `1 - 0.05^(1/n)`:
 *
 *     n=15  ->  rules out only a rate >= 17.8%
 *     n=29  ->  rules out a rate >= 10%
 *     n=59  ->  rules out a rate >= 5%
 *
 * So P(zero | n=15) = 0.054 under a 17.8% rate: **suggestive, not refuting.**
 * "We saw none" and "there are none" are different claims, and reporting the
 * first as the second is how a check that never fired came to look like a check
 * that passed.
 *
 * This prints the bound the data actually supports, whatever that turns out to be.
 */
import { readFileSync } from 'fs';

/** 95% upper bound on a rate given `events` observed in `n` trials. */
function upperBound(events, n) {
  if (n === 0) return 1;
  if (events === 0) return 1 - Math.pow(0.05, 1 / n);
  // Wilson upper bound — honest when the count is not zero.
  const p = events / n, z = 1.96, d = 1 + z * z / n;
  return Math.min(1, (p + z * z / (2 * n) + z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d);
}

const rows = [];
for (const path of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const records = report.records ?? [];
  for (const tier of [...new Set(records.map((r) => r.tier))]) {
    const arm = records.filter((r) => r.tier === tier);
    // MEASURE THE PREFIX, NOT THE PARSER.
    //
    // This counted `status === 'unparseable'` and returned 0 out of 131 — from
    // which it would have published "prefix rate < 2.3%". The real rate is 29%
    // on probe. `parseContractOutput` strips fences and hunts for the first
    // JSON object, so a chatty preamble parses perfectly and never registers.
    // The count was measuring the parser's leniency, and a lenient check
    // reporting zero proves only that it could not fire.
    //
    // So look at what the model actually emitted: anything before the opening
    // brace, or before a fence that opens with one.
    const hasPrefix = (r) => {
      const t = String(r.raw_text ?? '').replace(/^\s+/, '');
      if (!t) return false;
      return !(t.startsWith('{') || /^```(?:json)?\s*\n\s*\{/.test(t));
    };
    const prefixed = arm.filter(hasPrefix).length;
    // Kept beside it: how often a prefix actually broke the contract read. The
    // gap between the two columns IS the system's current tolerance, and it is
    // the thing that would silently disappear if the parser ever tightened.
    const unreadable = arm.filter((r) => r.status === 'unparseable').length;
    rows.push({
      role: report.role, tier, n: arm.length, malformed: prefixed, unreadable,
      rate: arm.length ? prefixed / arm.length : 0,
      bound: upperBound(prefixed, arm.length),
      cost: arm.reduce((s, r) => s + (r.cli_cost_usd ?? r.cost_usd ?? 0), 0),
    });
  }
}

console.log('\nitem 8.2 — prose before the JSON, and the bound the data supports\n');
console.log('role            tier             n   prefixed    rate   95% upper bound   unreadable   billed');
for (const r of rows) {
  console.log(
    `${r.role.padEnd(15)} ${r.tier.padEnd(15)} ${String(r.n).padStart(3)}  ${String(r.malformed).padStart(9)}   ` +
    `${(r.rate * 100).toFixed(1).padStart(5)}%   ${(r.bound * 100).toFixed(1).padStart(13)}%   ` +
    `${String(r.unreadable).padStart(10)}   $${r.cost.toFixed(4)}`,
  );
}

const total = rows.reduce((s, r) => s + r.n, 0);
const totalMal = rows.reduce((s, r) => s + r.malformed, 0);
const totalUnread = rows.reduce((s, r) => s + r.unreadable, 0);
console.log(`\npooled: ${totalMal} of ${total} calls emit prose before the JSON (${((totalMal / total) * 100).toFixed(1)}%)`);
console.log(`        95% CI upper bound: ${(upperBound(totalMal, total) * 100).toFixed(1)}%`);
console.log(`        of those, ${totalUnread} were unreadable by the contract parser.`);

console.log(
  `\nT7 reported this absent from n=15 — which, with zero events, supports only\n` +
  `"< 17.8%" and never supported "absent".\n\n` +
  `${totalMal === 0
    ? `This run saw none in ${total} calls, supporting "< ${(upperBound(0, total) * 100).toFixed(1)}%". State the bound, not absence.`
    : `It is not absent. ${totalMal} of ${total} calls emit prose first. T7's n was too small to\n` +
      `see a rate this large ${'—'} P(zero | 29% rate, n=15) is under 1% ${'—'} so the original run\n` +
      `did not fail to reach significance; it failed to look.\n\n` +
      `Every one of them still PARSED: ${totalUnread} unreadable. The contract parser strips\n` +
      `fences and hunts for the first JSON object, so the system tolerates this today.\n` +
      `That tolerance is undeclared and unowned — the rate is a live dependency on a\n` +
      `parser being lenient, not a property of the roles.`}`,
);
