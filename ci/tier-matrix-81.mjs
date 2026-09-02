/**
 * ci/tier-matrix-81.mjs — plan item 8.1, the paired tier matrix.
 *
 * One `ci/role-eval.mjs` process per spec, all specs concurrent. Each process
 * runs BOTH arms over the SAME cases against ONE agent file it read once, so
 * the pairing is structural rather than assembled afterwards from two runs that
 * may not have seen the same bytes.
 *
 *   node ci/tier-matrix-81.mjs [--repeats 5] [--out ci/out/matrix-81]
 *
 * This does not score anything. `ci/analyze-81.mjs` does, and it clusters on
 * cases — see the note there about why repeats are not observations.
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const repeats = Number(arg('repeats', 5));
const outDir = resolve(REPO_ROOT, arg('out', 'ci/out/matrix-81'));

const specs = readdirSync(join(REPO_ROOT, 'evals'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(REPO_ROOT, 'evals', d.name, 'spec.json')))
  .map((d) => d.name)
  .sort();

mkdirSync(outDir, { recursive: true });
const started = new Date().toISOString();
console.log(`8.1 — ${specs.length} specs, repeats=${repeats}, both arms per spec, ${arg('concurrency', 4)} at a time`);
console.log(`out: ${outDir}\n`);

const run = (dir) =>
  new Promise((done) => {
    const out = join(outDir, `${dir}-report.json`);
    const log = join(outDir, `${dir}.log`);
    const fd = openSync(log, 'w');
    const child = spawn('node', ['ci/role-eval.mjs', `evals/${dir}/spec.json`], {
      cwd: REPO_ROOT,
      env: { ...process.env, ROLE_EVAL_REPEATS: String(repeats), ROLE_EVAL_OUT: out },
      stdio: ['ignore', fd, fd],
    });
    const t0 = Date.now();
    child.on('exit', (code) => {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      // A spec that dies takes its arm pair with it. Say so loudly: a matrix
      // quietly missing a role reads as a matrix, not as a partial one.
      console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${dir.padEnd(16)} ${mins}m  exit=${code}  ${out}`);
      done({ dir, code, out, minutes: Number(mins) });
    });
  });

// CONCURRENCY IS CAPPED ON PURPOSE. Nine `claude` processes plus whatever else
// is running compete for the same rate limit, and a rate-limited call is scored
// `cli_error` — which, if it were counted as a wrong answer, would charge the
// model for the queue. The analyzer excludes those and shouts above 2%, but the
// cheaper fix is not to manufacture them.
const LIMIT = Number(arg('concurrency', 4));
const queue = [...specs];
const results = [];
await Promise.all(
  Array.from({ length: Math.min(LIMIT, queue.length) }, async () => {
    while (queue.length) results.push(await run(queue.shift()));
  }),
);
const failed = results.filter((r) => r.code !== 0);
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ started, finished: new Date().toISOString(), repeats, specs: results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} specs completed`);
if (failed.length) console.log(`INCOMPLETE — ${failed.map((f) => f.dir).join(', ')} produced no usable arm pair`);
