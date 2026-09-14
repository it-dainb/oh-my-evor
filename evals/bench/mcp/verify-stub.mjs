#!/usr/bin/env node
/**
 * evals/bench/mcp/verify-stub.mjs — prove the four properties the stub claims.
 *
 *   node evals/bench/mcp/verify-stub.mjs
 *
 * The claims are cheap to state and, on this repo's record, expensive to
 * believe without a check: a stub whose determinism is asserted in a comment is
 * the same artefact as tool-eval-bench's `--error-rate`, which fails silently
 * and open. Every property here is asserted against the REAL corpus files, over
 * the transport where it matters, so a scenario that stops matching is a red.
 *
 *   1. determinism        same seed + same call sequence -> byte-identical bytes
 *   2. seed separation    two repeats of one scenario differ
 *   3. loud failure       an unscripted call and an unknown tool both fail, and
 *                         both arrive as tool errors, never as denials
 *   4. corpus coverage    every scenario pointing at a stub config resolves, and
 *                         every tool it scripts exists on that config's surface
 */
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { SURFACES, derivedSeed, serve, entryMatches, addNoise } from './stub-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SERVER = join(HERE, 'stub-server.mjs');

let failures = 0;
const ok = (name) => console.log(`  ok    ${name}`);
const bad = (name, detail) => { failures++; console.log(`  FAIL  ${name}\n        ${detail}`); };
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

// ── a scenario as bench-run.mjs materialises it ──────────────────────────────
const scriptFor = (sc, repeat) => ({
  scenario_id: sc.id,
  repeat,
  seed: sc.seed,
  derived_seed: derivedSeed(sc.id, sc.seed, repeat),
  tool_results: sc.setup?.tool_results ?? [],
});

const load = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. determinism — same seed, same call sequence');
{
  const sc = load('evals/bench/evidence/E1/E1-iam-attribution-pos.json');
  const seq = [
    ['search_papers', { query: 'IAM handwriting CER' }],
    ['search_snippets', { query: 'IAM test split' }],
    ['search_papers', { query: 'IAM handwriting CER' }],
    ['evor_write_artifact', { agent: 'sage-junior', tick: 1, payload: { findings: [] } }],
  ];
  const run = () => {
    const st = { calls: 0, perEntry: {} };
    return seq.map(([t, a]) => JSON.stringify(serve(t, a, scriptFor(sc, 0), st)));
  };
  const a = run(), b = run();
  check('two runs of one (scenario, repeat) are byte-identical', JSON.stringify(a) === JSON.stringify(b));
  check('noise actually varies across calls to the same entry',
    a[0] !== a[2],
    'call 0 and call 2 hit the same fixture entry and produced identical bytes — the response shape is memorisable');
  const semantic = (s) => { const o = JSON.parse(JSON.parse(s).body ? '{}' : '{}'); return o; };
  const p0 = serve('search_papers', { query: 'IAM' }, scriptFor(sc, 0), { calls: 0, perEntry: {} }).body;
  check('noise never touches the values the condition is derived from',
    p0.papers[0].arxiv_id === '1507.05717' && p0.papers[0].reported_metrics[0].value === 81.2,
    JSON.stringify(p0).slice(0, 200));
  void semantic;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. seed separation — §6.11');
{
  const sc = load('evals/bench/evidence/E1/E1-iam-attribution-pos.json');
  const one = (rep) => JSON.stringify(serve('search_papers', { query: 'IAM' }, scriptFor(sc, rep), { calls: 0, perEntry: {} }));
  check('repeat 0 and repeat 1 differ', one(0) !== one(1));
  check('repeat 0 reproduces itself', one(0) === one(0));
  const other = load('evals/bench/evidence/E1/E1-abstract-vs-body-pos.json');
  check('two scenarios with the same repeat index do not share a seed',
    derivedSeed(sc.id, sc.seed, 0) !== derivedSeed(other.id, other.seed, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. error injection and loud failure');
{
  const sc = load('evals/bench/tool/T3/T3-hard-error-retry-pos.json');
  const st = { calls: 0, perEntry: {} };
  const first = serve('evor_signal_emit', { signature: 'x', kind: 'y' }, scriptFor(sc, 0), st);
  const second = serve('evor_signal_emit', { signature: 'x', kind: 'y' }, scriptFor(sc, 0), st);
  check('the declared injection fires on its declared call index', first.kind === 'injected' && first.isError === true, JSON.stringify(first));
  check('a later call to the same entry is served normally', second.kind === 'scripted' && second.isError === false, JSON.stringify(second));

  const neg = load('evals/bench/tool/T3/T3-hard-error-retry-neg.json');
  const negFirst = serve('evor_signal_emit', { signature: 'x' }, scriptFor(neg, 0), { calls: 0, perEntry: {} });
  check('the matched half with no injection never errors', negFirst.isError === false && negFirst.kind === 'scripted');

  const merge = serve('evor_read_artifact', { agent: 'mutagen' }, {
    scenario_id: 'synthetic', derived_seed: 1,
    tool_results: [{ tool: 'evor_read_artifact', match: { agent: 'mutagen' }, content: { ok: true, payload: { a: 1 } }, inject_error: { on_call_index: 0, payload: { ok: false, error: 'gate rejected' }, is_error_envelope: false } }],
  }, { calls: 0, perEntry: {} });
  check('is_error_envelope:false merges the payload into a SUCCESS envelope',
    merge.isError === false && merge.body.ok === false && merge.body.payload.a === 1,
    JSON.stringify(merge));

  const e3 = load('evals/bench/evidence/E3/E3-grad-norm-absent-pos.json');
  const unscripted = serve('evor_run_status', { run_id: 'run-live-01' }, scriptFor(e3, 0), { calls: 0, perEntry: {} });
  check('an unscripted call on a declared tool is a loud tool error',
    unscripted.isError === true && unscripted.kind === 'unscripted' && /failed/.test(unscripted.body.error),
    JSON.stringify(unscripted));
  check('the error names the tool and refuses the "there is none" reading',
    unscripted.body.tool === 'evor_run_status' && /not an empty result/.test(unscripted.body.detail));
  check('the wire never tells the agent it is inside a bench fixture',
    !/bench|stub|scenario|fixture/i.test(JSON.stringify(unscripted.body)),
    JSON.stringify(unscripted.body));
  check('the scenario id and the patterns tried go to the audit trace instead',
    unscripted.audit.scenario === e3.id && Array.isArray(unscripted.audit.candidates_tried));

  const mismatched = serve('evor_read_handoff', { from_agent: 'mutagen' }, scriptFor(e3, 0), { calls: 0, perEntry: {} });
  check('a scripted tool called with non-matching arguments also fails loudly',
    mismatched.isError === true && mismatched.audit.candidates_tried.length === 1,
    JSON.stringify(mismatched));

  const sink = serve('evor_write_artifact', { agent: 'probe', tick: 3, payload: {} }, scriptFor(e3, 0), { calls: 0, perEntry: {} });
  check('the write-side tools the role reports through are accepted, not errored',
    sink.isError === false && sink.kind === 'sink' && sink.body.ok === true);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. corpus coverage');
{
  const groups = readdirSync(join(REPO, 'evals/bench'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'mcp');
  const scenarios = [];
  for (const g of groups) {
    const gd = join(REPO, 'evals/bench', g.name);
    for (const a of readdirSync(gd, { withFileTypes: true })) {
      if (!a.isDirectory() || !/^[A-Z]\d$/.test(a.name)) continue;
      for (const f of readdirSync(join(gd, a.name))) {
        if (f.endsWith('.json')) scenarios.push(join(gd, a.name, f));
      }
    }
  }
  const stubbed = scenarios.map((p) => JSON.parse(readFileSync(p, 'utf8')))
    .filter((sc) => /stub-/.test(sc.setup?.mcp_config ?? ''));
  check(`every stub-backed scenario is accounted for (${stubbed.length})`, stubbed.length === 46, `found ${stubbed.length}, expected 46`);

  const surfaceOf = {};
  for (const rel of ['evals/bench/mcp/stub-evor.json', 'evals/bench/mcp/stub-research.json']) {
    const p = join(REPO, rel);
    check(`${rel} exists`, existsSync(p));
    if (!existsSync(p)) continue;
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    const server = cfg.mcpServers?.evor;
    check(`${rel} registers its server as \`evor\``, !!server, 'any other name is denied by bench-run\'s allowedTools and every run VOIDs');
    const i = server.args.indexOf('--surface');
    surfaceOf[rel] = server.args[i + 1];
    check(`${rel} points at a server file that exists`, existsSync(server.args[0]), server.args[0]);
  }

  let missing = [];
  for (const sc of stubbed) {
    const surface = SURFACES[surfaceOf[sc.setup.mcp_config]];
    if (!surface) { missing.push(`${sc.id}: unknown config ${sc.setup.mcp_config}`); continue; }
    for (const tr of sc.setup.tool_results ?? []) {
      if (!Object.prototype.hasOwnProperty.call(surface, tr.tool)) missing.push(`${sc.id}: ${tr.tool}`);
    }
  }
  check('every scripted tool exists on its scenario\'s surface', missing.length === 0, missing.join('\n        '));

  // Every scripted entry must be reachable by the arguments the role would send.
  let unreachable = [];
  for (const sc of stubbed) {
    for (const tr of sc.setup.tool_results ?? []) {
      const args = {};
      for (const [path, want] of Object.entries(tr.match ?? {})) {
        const key = String(path).replace(/^\$\./, '');
        args[key] = want === '*' ? 'anything' : String(want).replace(/\*/g, '');
      }
      if (!entryMatches(tr, args)) unreachable.push(`${sc.id}: ${tr.tool} ${JSON.stringify(tr.match)}`);
    }
  }
  check('every scripted entry is reachable by its own match pattern', unreachable.length === 0, unreachable.join('\n        '));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. over the transport');
await (async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stub-verify-'));
  const sc = load('evals/bench/evidence/E1/E1-iam-attribution-pos.json');
  const scriptPath = join(dir, 'script.json');
  writeFileSync(scriptPath, JSON.stringify({ ...scriptFor(sc, 0), trace_path: join(dir, 'calls.jsonl') }));

  const rpc = (proc, msg) => proc.stdin.write(JSON.stringify(msg) + '\n');
  const proc = spawn('node', [SERVER, '--surface', 'research'], {
    env: { ...process.env, EVOR_BENCH_STUB_SCRIPT: scriptPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const seen = [];
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { seen.push(JSON.parse(line)); } catch { /* noise */ } }
    }
  });
  const waitFor = (id, ms = 8000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = seen.find((s) => s.id === id);
      if (m) { clearInterval(iv); res(m); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout waiting for ${id}`)); }
    }, 20);
  });

  rpc(proc, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } });
  await waitFor(1);
  rpc(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });
  rpc(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitFor(2);
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  check('tools/list serves the research surface', names.join(',') === Object.keys(SURFACES.research).sort().join(','), names.join(','));

  rpc(proc, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_papers', arguments: { query: 'IAM handwriting' } } });
  const called = await waitFor(3);
  const body = JSON.parse(called.result.content[0].text);
  check('a scripted call comes back over the wire', body.papers?.[0]?.arxiv_id === '1507.05717', JSON.stringify(body).slice(0, 160));
  check('the scripted call is not flagged as an error', called.result.isError !== true);

  rpc(proc, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'evor_read_result', arguments: {} } });
  const unknown = await waitFor(4);
  check('a tool outside the surface is a protocol error, not a result',
    !!unknown.error && /no such tool/.test(unknown.error.message), JSON.stringify(unknown).slice(0, 220));
  check('the unknown-tool error does not announce the bench either',
    !!unknown.error && !/bench|stub|fixture/i.test(unknown.error.message), JSON.stringify(unknown).slice(0, 220));

  rpc(proc, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'resolve_doi', arguments: { doi: '10.0/nope' } } });
  const loud = await waitFor(5);
  check('an unscripted call on the wire returns isError, not an empty result',
    loud.result?.isError === true && /no result available/.test(loud.result.content[0].text), JSON.stringify(loud).slice(0, 220));

  proc.kill('SIGINT');
  const trace = existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n') : [];
  check('the stub logs what it served', trace.length === 3, `${trace.length} rows`);
  rmSync(dir, { recursive: true, force: true });
})();

void addNoise;
console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
