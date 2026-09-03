#!/usr/bin/env node
/**
 * ci/stub-gaps.mjs — turn a run's unscripted stub calls into an authoring list.
 *
 *   node ci/stub-gaps.mjs ci/out/lite
 *
 * The stub is loud on an unserved call by design: a plausible empty result
 * would teach the agent its call succeeded, and every downstream judgement
 * would be about a world the fixture never described. That design is right, and
 * it means an unserved call is a SCENARIO defect — `setup.tool_results` did not
 * say what the agent sees.
 *
 * 46 scenarios are stub-backed and none scripts more than three distinct tools,
 * so this is not a handful of oversights: the corpus scripts the tool under
 * test and leaves the orientation reads that every role makes first unanswered.
 * This prints exactly which calls were refused, with the arguments the agent
 * used, so the entries can be authored against what roles actually do rather
 * than against a guess.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const dir = resolve(process.argv[2] ?? 'ci/out/lite');
if (!existsSync(dir)) { console.error(`no ${dir}`); process.exit(2); }

const out = new Map();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'index.json')) {
  const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const r of s.records ?? []) {
    for (const c of r.stub_calls ?? []) {
      if (c.kind !== 'unscripted') continue;
      const m = out.get(s.scenario) ?? { role: s.role, calls: new Map() };
      const key = c.tool;
      const seen = m.calls.get(key) ?? [];
      seen.push(c.args ?? c.arguments ?? {});
      m.calls.set(key, seen);
      out.set(s.scenario, m);
    }
  }
}

if (!out.size) { console.log('no unscripted stub calls — every stub-backed run was fully served'); process.exit(0); }

console.log(`# stub authoring gaps: ${out.size} scenario(s)\n`);
let total = 0;
for (const [id, m] of [...out].sort()) {
  console.log(`## ${id}  (${m.role})`);
  for (const [tool, argsets] of [...m.calls].sort()) {
    total += argsets.length;
    const shapes = [...new Set(argsets.map((a) => JSON.stringify(a)))];
    console.log(`  ${tool}  x${argsets.length}`);
    for (const sh of shapes.slice(0, 3)) console.log(`      ${sh.slice(0, 150)}`);
  }
  console.log();
}
console.log(`${total} refused call(s) across ${out.size} scenario(s).`);
console.log('Each needs a setup.tool_results entry, or the run measures the outage instead of the agent.');
