#!/usr/bin/env node
// Deterministic (no-API) auto-test harness for the oh-my-evor plugin, plus an
// optional agentic layer (headless Claude) gated on ANTHROPIC_API_KEY.
//
// Emits a machine-checkable report to ci/out/report.json and a human summary to
// stdout. Exit code is non-zero if any REQUIRED (non-agentic) check fails, so it
// gates CI directly. Run from the plugin root:
//   node ci/run-checks.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const results = [];
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 180_000, ...opts });

function record(name, ok, detail, { required = true } = {}) {
  results.push({ name, ok: !!ok, required, detail: String(detail).slice(0, 600) });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : (required ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mSKIP\x1b[0m');
  console.log(`  [${tag}] ${name} — ${String(detail).split('\n')[0].slice(0, 90)}`);
}

// ── 1. Manifest validation ────────────────────────────────────────────────
function checkValidate() {
  const r = sh('claude', ['plugin', 'validate', '.', '--strict']);
  const out = (r.stdout || '') + (r.stderr || '');
  record('manifest_validate', /Validation passed/i.test(out) && r.status === 0, out.trim() || 'no output');
}

// ── 2. MCP server: initialize + tools/list (expect 12 tools) ──────────────
function checkMcp() {
  return new Promise((resolve) => {
    const child = spawn('node', ['mcp/dist/index.cjs'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let done = false;
    const finish = (ok, detail) => { if (done) return; done = true; try { child.kill(); } catch {} record('mcp_tools_list', ok, detail); resolve(); };
    const timer = setTimeout(() => finish(false, 'timeout waiting for tools/list response'), 12_000);
    child.on('error', (e) => { clearTimeout(timer); finish(false, 'spawn error: ' + e.message); });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let msg; try { msg = JSON.parse(t); } catch { continue; }
        if (msg.id === 2 && msg.result) {
          clearTimeout(timer);
          const tools = (msg.result.tools || []).map((x) => x.name);
          // The hardcoded ==12 here predated the current tool surface (50) and so
          // this gate had been failing on a stale number rather than on a defect.
          // Assert the tools the run loop cannot proceed without, and that the
          // list is non-trivial — a count alone tracks growth, not correctness.
          const REQUIRED = [
            'evor_init_run', 'evor_record_node', 'evor_record_eval',
            'evor_write_artifact', 'evor_read_artifact', 'evor_run_start',
          ];
          const missing = REQUIRED.filter((t) => !tools.includes(t));
          finish(
            missing.length === 0 && tools.length >= REQUIRED.length,
            missing.length ? `${tools.length} tools, MISSING: ${missing.join(', ')}` : `${tools.length} tools, all required present`,
          );
        }
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'evor-ci', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 400);
  });
}

// ── 3. Hook smoke: continuation-guard fires (exit 2) on pending nodes ──────
function checkHooks() {
  // 3a. post-tool-use is inert/graceful when no active run
  const a = sh('node', ['hooks/post-tool-use.mjs'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }) });
  record('hook_posttooluse_graceful', a.status === 0, `exit ${a.status}`);

  // 3b. stop.mjs is inert (exit 0) when EVOR_ACTIVE_RUN_ID unset
  const b = sh('node', ['hooks/stop.mjs'], { input: '{}', env: { ...process.env, EVOR_ACTIVE_RUN_ID: '' } });
  record('hook_stop_inert_when_unset', b.status === 0, `exit ${b.status}`);

  // 3c. stop.mjs BLOCKS (exit 2) when a run has pending_node_ids
  // EVOR_ROOT must BE the .evor directory — the hooks join `runs/<id>` onto it
  // directly. This fixture used to pass the parent while writing state into
  // `<parent>/.evor`, so the guard never found run-state.json and the check
  // recorded a permanent non-required SKIP. A gate that cannot fail is not a
  // gate; it is now wired correctly and required.
  const dir = mkdtempSync(join(tmpdir(), 'evor-hook-'));
  const evorRoot = join(dir, '.evor');
  const runDir = join(evorRoot, 'runs', 'run-ci');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(evorRoot, 'active-run.json'), JSON.stringify({ run_id: 'run-ci' }));
  writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({ pending_node_ids: ['node-x'], tick: 1 }));
  const c = sh('node', ['hooks/stop.mjs'], {
    input: '{}',
    env: { ...process.env, EVOR_ROOT: evorRoot, EVOR_ACTIVE_RUN_ID: 'run-ci' },
  });
  const fired = c.status === 2 || /pending|continuation|guard/i.test((c.stdout || '') + (c.stderr || ''));
  record('hook_continuation_guard_fires', fired, `exit ${c.status} :: ${((c.stdout || '') + (c.stderr || '')).trim().slice(0, 120)}`);

  // 3d. The Phase 0.1 property, end to end: with the env var absent the guard
  // must still fire, resolving the run from active-run.json alone. This is the
  // exact condition that held for all of run 29d17abc.
  const e = sh('node', ['hooks/stop.mjs'], {
    input: '{}',
    env: { ...process.env, EVOR_ROOT: evorRoot, EVOR_ACTIVE_RUN_ID: '', EVOR_MISSION_ID: '' },
  });
  const firedFromFile = e.status === 2 || /pending|continuation|guard/i.test((e.stdout || '') + (e.stderr || ''));
  record('hook_runid_resolves_without_env', firedFromFile, `exit ${e.status} :: ${((e.stdout || '') + (e.stderr || '')).trim().slice(0, 120)}`);
}

// ── 4. Python harness suite ───────────────────────────────────────────────
function checkPytest() {
  const r = sh('python', ['-m', 'pytest', 'harness/tests', '-q'], { cwd: ROOT });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+) passed/);
  const failed = /(\d+) failed/.test(out);
  record('pytest_harness', !!m && !failed && r.status === 0, m ? `${m[1]} passed` : out.trim().split('\n').pop());
}

// ── 5. TS suite (contracts + MCP tools + hooks) ───────────────────────────
function checkVitest() {
  const r = sh('npx', ['vitest', 'run'], { cwd: join(ROOT, 'mcp') });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/Tests\s+(\d+) passed/);
  const failed = /(\d+) failed/.test(out);
  record('vitest_mcp', !!m && !failed && r.status === 0, m ? `${m[1]} passed` : out.trim().split('\n').slice(-1)[0]);
}

// ── 6. L3 REAL end-to-end evolution (CPU, zero-dep) ───────────────────────
function checkL3() {
  const r = sh('bash', ['scripts/l3-e2e.sh']);
  const out = (r.stdout || '') + (r.stderr || '');
  const winner = out.match(/winner:\s*(\S+)/i);
  const cheatRejected = /cheat rejected:\s*yes/i.test(out) || /\[REJECTED\]|REJECTED/i.test(out);
  const acc = out.match(/accuracy[:=]\s*(0?\.\d+)/i);
  // Real evolution proof: script exits 0, a winner exists, the cheat was rejected.
  const ok = r.status === 0 && !!winner && cheatRejected;
  record('l3_real_evolution', ok, `winner=${winner ? winner[1] : '?'} acc=${acc ? acc[1] : '?'} cheat_rejected=${cheatRejected}`);
}

// ── 7. AGENTIC (optional): headless Claude discovers the plugin's skills ──
function checkAgentic() {
  const credsFile = `${process.env.HOME || '/root'}/.claude/.credentials.json`;
  const hasAuth = !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || existsSync(credsFile));
  if (!hasAuth) {
    record('agentic_skill_discovery', true,
      'SKIPPED — mount ~/.claude/.credentials.json (subscription) or pass CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY to enable the real-Claude layer',
      { required: false });
    return;
  }
  const r = sh('claude', ['--plugin-dir', '.', '-p', 'List the slash commands/skills provided by the oh-my-evor plugin. Answer with their names only.',
    '--output-format', 'json', '--max-turns', '2'], { timeout: 180_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const mentions = /evor-setup|evor-run|evor-dashboard|oh-my-evor/i.test(out);
  record('agentic_skill_discovery', r.status === 0 && mentions, mentions ? 'headless Claude saw evor skills' : out.trim().slice(0, 160), { required: false });
}

// ── 8. GOVERNOR REGRESSION: replay recorded sessions through the live hook ──
// Run 29d17abc issued 152 orchestrator leaf calls (120 Bash / 18 Write / 14 Edit)
// and named every one of its evor spawns, which is what silenced the enforcement
// layer. Those exact calls are replayed here; any that the current governor would
// still allow is the same mistake surviving into this build.
//
// This bounds regression, not quality. It cannot show what a model would do once
// denied — only a live tick shows that (Phase 2).
function checkGovernorRegression() {
  const logs = existsSync(join(ROOT, 'logs'))
    ? readdirSync(join(ROOT, 'logs')).filter((f) => f.endsWith('.jsonl')).map((f) => join('logs', f))
    : [];
  if (logs.length === 0) {
    record('governor_replay', true, 'SKIPPED — no recorded sessions in logs/', { required: false });
    return;
  }

  const analysis = sh('node', ['scripts/session-analyze.mjs', ...logs], { timeout: 300_000 });
  const replay = sh('node', ['scripts/replay-governor.mjs', ...logs], { timeout: 600_000 });
  if (analysis.status !== 0 || replay.status !== 0) {
    record('governor_replay', false, `tooling failed: ${(analysis.stderr || replay.stderr || '').slice(0, 200)}`);
    return;
  }

  let a, d;
  try {
    a = JSON.parse(analysis.stdout);
    d = JSON.parse(replay.stdout);
  } catch (e) {
    record('governor_replay', false, `unparseable output: ${e.message}`);
    return;
  }

  // Assert on WHICH orchestrator leaf calls survive, not on a count. The only
  // acceptable survivor is the skill-dispatch exemption (`cat <plugin>/skills/
  // <name>/SKILL.md`), which every file in commands/ depends on. Counting alone
  // would let a genuine hole hide behind an expected total.
  const SKILL_DISPATCH_RE =
    /^\s*cat\s+"?\$\{?(?:EVOR_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)[^"]*\/skills\/[\w-]+\/SKILL\.md"?\s*$/;
  const survivors = d.allowed_orchestrator_leaf ?? [];
  const unexpected = survivors.filter((c) => !SKILL_DISPATCH_RE.test(c));
  const namedEvorDenied = d.denied_by_tool.Agent ?? 0;

  const ok = unexpected.length === 0 && namedEvorDenied > 0;
  record(
    'governor_replay',
    ok,
    ok
      ? `${d.tally.denied}/${d.tally.replayed} recorded calls denied — all ${a.ac2.orchestrator_leaf_tool_calls} ` +
        `orchestrator leaf calls blocked except ${survivors.length} skill-dispatch reads; ` +
        `${namedEvorDenied} named evor spawns blocked`
      : `orchestrator leaf calls still allowed: ${unexpected.slice(0, 3).join(' | ')}` +
        (namedEvorDenied === 0 ? ' (and no named spawn was blocked)' : ''),
  );

  mkdirSync(join(ROOT, 'ci', 'out'), { recursive: true });
  writeFileSync(join(ROOT, 'ci', 'out', 'session-baseline.json'), JSON.stringify(a, null, 2));
  // Commit the per-tool histogram as its own artifact. session-analyze already
  // computes it, but it was never persisted — so the "never-called tools" list
  // driving any pruning decision was not re-derivable from repo state.
  writeFileSync(
    join(ROOT, 'ci', 'out', 'tool-histogram.json'),
    JSON.stringify({ source: logs, called: a.totals.tools, distinct_tools: Object.keys(a.totals.tools).length }, null, 2),
  );
  writeFileSync(join(ROOT, 'ci', 'out', 'governor-replay.json'), JSON.stringify(d, null, 2));
}

// ── 9. COST BASELINE: publish the numbers Phase 2 will be measured against ──
// Advisory by design. The reference run is a single incomplete tick with the
// enforcement layer disconnected, so it is a ceiling to beat, not a target — and
// a build cannot be failed against it without a comparable live tick.
function checkCostBaseline() {
  const baseline = join(ROOT, 'ci', 'out', 'session-baseline.json');
  if (!existsSync(baseline)) {
    record('cost_baseline', true, 'SKIPPED — no session baseline produced', { required: false });
    return;
  }
  const a = JSON.parse(readFileSync(baseline, 'utf8'));
  record(
    'cost_baseline',
    true,
    `reference: $${a.cost.total.toFixed(2)} · ${a.totals.turns} turns · ${a.wall_clock.human} · ` +
      `${(a.totals.cache_read_input_tokens / 1e6).toFixed(1)}M cache-read · hook fires ${a.hooks.total_fires}`,
    { required: false },
  );
}

// ── main ──────────────────────────────────────────────────────────────────
console.log('\n oh-my-evor — isolated auto-test (deterministic + optional agentic)\n');
checkValidate();
await checkMcp();
checkHooks();
checkPytest();
checkVitest();
checkL3();
checkGovernorRegression();
checkCostBaseline();
checkAgentic();

const required = results.filter((r) => r.required);
const reqPass = required.filter((r) => r.ok).length;
const allReqPass = reqPass === required.length;
const report = {
  plugin: 'oh-my-evor',
  in_docker: !!process.env.EVOR_TEST_IN_DOCKER,
  agentic_enabled: !!process.env.ANTHROPIC_API_KEY,
  summary: { required_total: required.length, required_pass: reqPass, verdict: allReqPass ? 'PASS' : 'FAIL' },
  results,
};
mkdirSync(join(ROOT, 'ci', 'out'), { recursive: true });
writeFileSync(join(ROOT, 'ci', 'out', 'report.json'), JSON.stringify(report, null, 2));

console.log(`\n verdict: ${report.summary.verdict}  (${reqPass}/${required.length} required checks passed)`);
console.log(' report: ci/out/report.json\n');
process.exit(allReqPass ? 0 : 1);
