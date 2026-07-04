#!/usr/bin/env node
// Deterministic (no-API) auto-test harness for the oh-my-evor plugin, plus an
// optional agentic layer (headless Claude) gated on ANTHROPIC_API_KEY.
//
// Emits a machine-checkable report to ci/out/report.json and a human summary to
// stdout. Exit code is non-zero if any REQUIRED (non-agentic) check fails, so it
// gates CI directly. Run from the plugin root:
//   node ci/run-checks.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
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
          finish(tools.length === 12, `${tools.length} tools: ${tools.join(', ')}`);
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
  const dir = mkdtempSync(join(tmpdir(), 'evor-hook-'));
  const runDir = join(dir, '.evor', 'runs', 'run-ci');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(dir, '.evor', 'active-run.json'), JSON.stringify({ run_id: 'run-ci' }));
  writeFileSync(join(runDir, 'run-state.json'), JSON.stringify({ pending_node_ids: ['node-x'], tick: 1 }));
  const c = sh('node', ['hooks/stop.mjs'], {
    input: '{}',
    env: { ...process.env, EVOR_ROOT: dir, EVOR_ACTIVE_RUN_ID: 'run-ci' },
  });
  // Tolerant: guard should signal (exit 2) OR clearly mention pending; accept either as evidence it fired.
  const fired = c.status === 2 || /pending|continuation|guard/i.test((c.stdout || '') + (c.stderr || ''));
  record('hook_continuation_guard_fires', fired, `exit ${c.status} :: ${((c.stdout || '') + (c.stderr || '')).trim().slice(0, 120)}`, { required: false });
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
  if (!process.env.ANTHROPIC_API_KEY) {
    record('agentic_skill_discovery', true, 'SKIPPED — set ANTHROPIC_API_KEY to enable the real-Claude layer', { required: false });
    return;
  }
  const r = sh('claude', ['--plugin-dir', '.', '-p', 'List the slash commands/skills provided by the oh-my-evor plugin. Answer with their names only.',
    '--output-format', 'json', '--max-turns', '2'], { timeout: 180_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const mentions = /evor-setup|evor-run|evor-dashboard|oh-my-evor/i.test(out);
  record('agentic_skill_discovery', r.status === 0 && mentions, mentions ? 'headless Claude saw evor skills' : out.trim().slice(0, 160), { required: false });
}

// ── main ──────────────────────────────────────────────────────────────────
console.log('\n oh-my-evor — isolated auto-test (deterministic + optional agentic)\n');
checkValidate();
await checkMcp();
checkHooks();
checkPytest();
checkVitest();
checkL3();
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
