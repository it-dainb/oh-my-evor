/**
 * ci/digest-81.mjs — freeze an 8.1 run into committable evidence.
 *
 *   node ci/digest-81.mjs ci/out/matrix-81 docs/evidence/matrix-81.json
 *
 * `ci/out/` is ignored, so a table that can only be reproduced from it cannot be
 * reproduced by anyone else — the claim "run the analyser to check this" would
 * rest on 7.6MB of files that exist on one machine. This keeps the three fields
 * the analysis actually reads (tier, case_id, status) plus each run's
 * fingerprint, and drops the raw text that makes the reports large.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const src = resolve(process.argv[2] ?? 'ci/out/matrix-81');
const dst = resolve(process.argv[3] ?? 'docs/evidence/matrix-81.json');

const runs = [];
for (const f of readdirSync(src).filter((x) => x.endsWith('-report.json')).sort()) {
  const rep = JSON.parse(readFileSync(join(src, f), 'utf8'));
  runs.push({
    role: rep.role,
    fingerprint: rep.fingerprint,
    records: (rep.records ?? []).map((r) => ({
      tier: r.tier,
      case_id: r.case_id,
      status: r.status,
      cli_cost_usd: Number((r.cli_cost_usd ?? r.cost_usd ?? 0).toFixed(4)),
    })),
  });
}
mkdirSync(dirname(dst), { recursive: true });
writeFileSync(dst, JSON.stringify({ item: '8.1', runs }, null, 1));
const n = runs.reduce((s, r) => s + r.records.length, 0);
console.log(`wrote ${dst}: ${runs.length} roles, ${n} calls`);
