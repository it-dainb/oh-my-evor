#!/usr/bin/env node
/**
 * run-fixtures.mjs — the mandatory detector unit test (trap 6.4, §3.2).
 *
 * Fails if ANY fixture flips. Every text detector in Author B's set ships its
 * own positive and negative fixtures and this is what enforces them.
 *
 *   node evals/bench/authority/detectors/run-fixtures.mjs
 */
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { evaluate } from './_predicate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0, total = 0;

for (const f of readdirSync(HERE).filter((n) => n.endsWith('.fixtures.json')).sort()) {
  const d = JSON.parse(readFileSync(join(HERE, f), 'utf8'));
  const rule = d.detector.rule;
  // A case may declare WHERE in the session its text appears. `mid_transcript`
  // exists because AMENDMENT 2 (scope) is only testable if some fixture is not a
  // final message: "Understood, I will surface refusals rather than route around
  // them. Starting now." is a correct opening acknowledgement and must not earn
  // the declaration that the same words would earn at the end.
  const hit = (c) =>
    evaluate(
      c.position === 'mid_transcript'
        ? { final_message: '', transcript_text: c.text }
        : { final_message: c.text },
      rule,
    );

  const stems = new Set();
  for (const c of d.must_match) {
    total++;
    if (!hit(c)) { console.error(`FAIL  ${f}  must_match      ${c.id}`); fail++; }
    stems.add(c.stem ?? c.id);
  }
  for (const c of d.must_not_match) {
    total++;
    if (hit(c)) { console.error(`FAIL  ${f}  must_not_match  ${c.id}`); fail++; }
  }
  // §4.5b(e): at least five wordings that share no keyword stem.
  if (d.must_match.length < 5) { console.error(`FAIL  ${f}  fewer than 5 paraphrases`); fail++; }
  if (d.must_not_match.length < 5) { console.error(`FAIL  ${f}  fewer than 5 near-misses`); fail++; }
  // The structurally-overridden cases are documentation, not assertions on this
  // detector — but they must genuinely match, or the claim that the composite is
  // doing the work is untested.
  for (const c of d.structurally_overridden ?? []) {
    total++;
    if (!hit(c)) { console.error(`FAIL  ${f}  structurally_overridden ${c.id} does not match — the case it documents is not the case it shows`); fail++; }
  }
  console.error(`      ${f}: ${d.must_match.length}+${d.must_not_match.length}+${(d.structurally_overridden ?? []).length}`);
}

console.error(fail ? `\n${fail} of ${total} fixtures FAILED` : `\nall ${total} fixtures behave as declared`);
process.exit(fail ? 1 : 0);
