#!/usr/bin/env node
/**
 * build.mjs — emit Author B's 60 scenario files.
 *
 *   node evals/bench/authority/build.mjs           write
 *   node evals/bench/authority/build.mjs --check   verify disk matches the specs
 *
 * `--check` is the trap §6.7 guard at this author's scope: a scenario edited by
 * hand no longer matches its declaration and the check fails loudly. It is also
 * the trap §6.8 guard — it verifies each file from the filesystem rather than
 * from a report that it was written.
 *
 * NO FREEZE MANIFEST IS WRITTEN HERE, DELIBERATELY. An earlier revision of this
 * file emitted `FREEZE.json` with a `scenario_count` key and a repo-relative
 * hash map — which turned out to be the FOURTH incompatible freeze format among
 * four authors. A shared runner reading one convention would have verified
 * nothing for the other three and reported success, which is this bench's own
 * subject occurring in its plumbing. The lead is normalising the format
 * centrally; this file's obligation is only that the 60 scenarios on disk are
 * final and match their specs, which `--check` proves.
 */
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

await import('./pairs-T4.mjs');
await import('./pairs-A1.mjs');
await import('./pairs-A2.mjs');
await import('./pairs-A3.mjs');
await import('./pairs-A4.mjs');
const { EMITTED } = await import('./build-pairs.mjs');

const check = process.argv.includes('--check');
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** Printed, not written to a manifest — see the header. The lead owns the format. */
const digests = {};
let mismatches = 0;

for (const { path, obj } of EMITTED) {
  const abs = join(HERE, path);
  const text = JSON.stringify(obj, null, 2) + '\n';
  digests[path] = sha(text);
  if (check) {
    if (!existsSync(abs)) { console.error(`MISSING   ${path}`); mismatches++; continue; }
    if (readFileSync(abs, 'utf8') !== text) { console.error(`CHANGED   ${path}`); mismatches++; }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

if (process.argv.includes('--digests')) {
  // sha256 per scenario, on stdout, for the lead's central manifest in whatever
  // format it settles on. Deliberately not written to a file here: four authors
  // produced four freeze conventions, and a runner that reads one and silently
  // verifies nothing for the others is this bench's own subject, in its plumbing.
  process.stdout.write(JSON.stringify(digests, null, 2) + '\n');
}

if (check) {
  console.error(mismatches
    ? `\n${mismatches} file(s) out of date — run build.mjs`
    : `ok — ${EMITTED.length} scenarios match their specs`);
  process.exit(mismatches ? 1 : 0);
}

const byAngle = {};
for (const { obj } of EMITTED) byAngle[obj.angle] = (byAngle[obj.angle] ?? 0) + 1;
console.log(`wrote ${EMITTED.length} scenarios:`, byAngle);
