#!/usr/bin/env node
/**
 * ci/bench-run.mjs — execute evor-eval-bench scenarios.
 *
 *   node ci/bench-run.mjs evals/bench/lifecycle/L3/L3-*-pos.json --repeats 2
 *   node ci/bench-run.mjs --angle L3 --repeats 8 --out ci/out/bench-pilot
 *
 * No stub tool server is involved, and none is needed: every scenario points at
 * `ci/eval-mcp-config.json` — the real evor MCP server — against a real seeded
 * `cwd_fixture`. That is deliberate (taxonomy trap 6.3): a first version of
 * `ci/autonomy-live.mjs` inlined state into the prompt and all three runs
 * classified it as prompt injection and refused to act. State lives on disk.
 *
 * VOID COMES FIRST (§4.1). A run whose trace contains a denial we did not intend,
 * or which ended at the turn ceiling, or which mutated a guarded path, is VOID —
 * not a false negative. 8.1% of calls in the existing harness carry incidental
 * denials, so a bench that scores them would measure its own permission
 * affordance instead of the agent.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runLive } from './knowledge-live-eval.mjs';
import { extractAgentPromptBlock } from './agent-eval.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Tools the role's own agent file declares it does not have. */
function readRoleDisallowedTools(agentFile) {
  const out = new Set();
  if (!agentFile) return out;
  const p = resolve(REPO, agentFile);
  if (!existsSync(p)) return out;
  const m = /^disallowedTools:\s*(.+)$/m.exec(readFileSync(p, 'utf8').slice(0, 4000));
  if (m) for (const t of m[1].split(',')) out.add(t.trim());
  return out;
}

// ── tiny JSON path: $.a.b, $.a[*], $.a[0] ────────────────────────────────────
function pick(obj, path) {
  const parts = String(path).replace(/^\$\.?/, '').split(/\.|\[|\]/).filter(Boolean);
  let cur = [obj];
  for (const p of parts) {
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      if (p === '*') { if (Array.isArray(c)) next.push(...c); else next.push(...Object.values(c)); }
      else if (Array.isArray(c) && /^\d+$/.test(p)) next.push(c[Number(p)]);
      else if (typeof c === 'object') next.push(c[p]);
    }
    cur = next;
  }
  return cur.filter((v) => v !== undefined);
}
const truthy = (vals, cond) => {
  if (cond.equals !== undefined) return vals.some((v) => v === cond.equals);
  if (cond.present !== undefined) return cond.present ? vals.length > 0 && vals.some((v) => v !== null) : vals.length === 0;
  if (cond.contains !== undefined) return vals.some((v) => String(v).includes(cond.contains));
  if (cond.count) { const n = vals.length; return (cond.count.min == null || n >= cond.count.min) && (cond.count.max == null || n <= cond.count.max); }
  return false;
};

// ── the model's final answer, parsed as the contract requires ────────────────
function finalJson(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text ?? '');
  const body = fenced ? fenced[1] : text ?? '';
  const i = body.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(body.slice(i, body.lastIndexOf('}') + 1)); } catch { return null; }
}

// ── trace view: every tool call, whether it was denied ───────────────────────
function traceOf(events, roleDisallowed = new Set(), deniedTools = new Set()) {
  const calls = [];
  const results = new Map();
  for (const e of events) {
    for (const b of e?.message?.content ?? []) {
      if (b?.type === 'tool_use') calls.push({ id: b.id, tool: String(b.name ?? ''), input: b.input ?? {} });
      if (b?.type === 'tool_result') results.set(b.tool_use_id, b);
    }
  }
  for (const c of calls) {
    const r = results.get(c.id);
    const txt = JSON.stringify(r?.content ?? '');
    // A denial can arrive as is_error, or as a governor message in the payload.
    // A DENIAL IS NOT AN ERROR. Two prior versions got this wrong: first a regex
    // over the payload (trap 6.4 — evor results legitimately contain the word
    // "denied"), then `is_error`, which voided a run where the agent behaved
    // correctly because the fixture's deliberately malformed tree.json made
    // `evor_tree_read` fail as designed. A failing tool is angle T3's SUBJECT;
    // treating it as interference discards every scenario built on one.
    //
    // Denials are only what the CLI reports in `permission_denials`.
    c.errored = !!r?.is_error;
    c.role_expected_denial = deniedTools.has(c.tool) && roleDisallowed.has(c.tool);
    c.denied = deniedTools.has(c.tool) && !c.role_expected_denial;
    c.result_text = txt;
  }
  return calls;
}

function evalRule(rule, ctx) {
  if (!rule) return false;
  if (rule.any_of) return rule.any_of.some((r) => evalRule(r, ctx));
  if (rule.all_of) return rule.all_of.every((r) => evalRule(r, ctx));
  if (rule.turns_at_ceiling !== undefined) return ctx.turnsAtCeiling === rule.turns_at_ceiling;
  if (rule.changed) return rule.changed.some((p) => ctx.changed.has(p));
  if (rule.tool !== undefined) {
    const hits = ctx.calls.filter((c) => rule.tool === '*' || c.tool.endsWith(rule.tool));
    if (rule.denied !== undefined) {
      // `{tool: "*", denied: true}` asks "was anything denied at all", which the
      // envelope answers directly and completely.
      if (rule.tool === '*' && rule.denied) return ctx.envelopeDenials > 0 || hits.some((c) => c.denied);
      return hits.some((c) => c.denied === rule.denied);
    }
    let ok = hits;
    if (rule.arg) ok = ok.filter((c) => Object.entries(rule.arg).every(([p, want]) => {
      const vals = pick(c.input, p);
      return Array.isArray(want) ? vals.some((v) => want.includes(v)) : vals.some((v) => v === want || String(v).includes(String(want)));
    }));
    return rule.count ? truthy(ok, { count: rule.count }) : ok.length > 0;
  }
  if (rule.path) return truthy(pick(ctx.answer ?? {}, rule.path), rule);
  return false;
}

function detect(spec, ctx) {
  if (!spec) return false;
  if (spec.kind === 'answer') return evalRule(spec.rule, ctx);
  if (spec.kind === 'trace') return evalRule(spec.rule, ctx);
  if (spec.kind === 'filesystem') return evalRule(spec.rule, ctx);
  return false;
}

function runScenario(path, { repeats, outDir }) {
  const sc = JSON.parse(readFileSync(path, 'utf8'));
  const fixture = sc.setup?.cwd_fixture ? resolve(REPO, sc.setup.cwd_fixture) : null;
  const arm = (sc.arms ?? [])[0] ?? { model: 'sonnet', effort: 'medium' };
  const agentPromptBlock = extractAgentPromptBlock(readFileSync(resolve(REPO, sc.agent_file), 'utf8'));
  const records = [];

  for (let r = 0; r < repeats; r++) {
    const work = mkdtempSync(join(tmpdir(), 'bench-'));
    if (fixture && existsSync(fixture)) cpSync(fixture, work, { recursive: true });
    const env = {};
    for (const [k, v] of Object.entries(sc.setup?.env ?? {})) env[k] = String(v).replace(/\{\{FIXTURE\}\}/g, work);

    // Guarded paths are hashed in the REPO, not the fixture: the harm this
    // detects is an agent reaching out of its sandbox into the plugin tree.
    const before = new Map();
    for (const g of sc.setup?.guarded_paths ?? []) {
      const p = resolve(REPO, g.path);
      if (existsSync(p)) before.set(g.path, sha(p));
    }

    let live, err = null;
    try {
      live = runLive({
        // THE ROLE MUST BE LOADED. Without this the run is a generic Claude that
        // has never been told it is `evor-tick`, that its entire return is one
        // JSON object, or that Bash is disallowed to it. The first scored run
        // answered in prose — correctly diagnosing the stall, in detail — and
        // the detector could not fire because nothing had ever asked it for
        // JSON. Scoring that as FN would have published a model failure that
        // was entirely the harness's doing. `ci/role-eval.mjs` has always done
        // this; the bench runner did not.
        prompt: `${agentPromptBlock}\n\n---\n\n${sc.prompt}`,
        model: arm.model,
        effort: arm.effort,
        maxTurns: Number(arg('max-turns', 20)),
        timeoutMs: 900_000,
        env: { ...env, CLAUDE_PROJECT_DIR: work },
        mcpConfigPath: resolve(REPO, sc.setup?.mcp_config ?? 'ci/eval-mcp-config.json'),
        // DEFAULTING TO `mcp__evor` ALONE MANUFACTURED 11 DENIALS AND BURNED
        // THE TURN BUDGET. The role is told to read run state off disk, so
        // denying Read guarantees the failure the bench then scores — trap 6.2,
        // committed by the runner. The default is the read-only surface these
        // roles legitimately hold; a scenario may narrow it explicitly.
        allowedTools: sc.setup?.allowed_tools ?? ['mcp__evor', 'Read', 'Glob', 'Grep'],
        tolerateError: true,
      });
    } catch (e) { err = String(e.message ?? e); }

    const changed = new Set();
    for (const [rel, h] of before) {
      const p = resolve(REPO, rel);
      if (!existsSync(p) || sha(p) !== h) changed.add(rel);
    }

    let status, cls = null, note = '';
    if (err) { status = 'HARNESS_ERROR'; note = err.slice(0, 300); }
    else {
      const roleDisallowed = readRoleDisallowedTools(sc.agent_file);
      const denials = live.result?.permission_denials ?? [];
      const deniedTools = new Set(denials.map((d) => String(d.tool_name ?? '')));
      const calls = traceOf(live.events, roleDisallowed, deniedTools);
      const answer = finalJson(live.result?.result ?? '');
      const turnsAtCeiling =
        live.result?.subtype === 'error_max_turns' ||
        live.result?.terminal_reason === 'max_turns' ||
        (live.result?.num_turns ?? 0) >= Number(arg('max-turns', 20));
      // The CLI reports denials in the result envelope. That is the number to
      // trust: it counts denials the model never surfaced in its text, which is
      // most of them.
      // A DENIAL OF A TOOL THE ROLE IS DECLARED NOT TO HAVE IS NOT INCIDENTAL.
      //
      // `agents/evor-tick.md` carries `disallowedTools: Bash, Write, Edit`. When
      // the tick reaches for Bash and the harness refuses, that is the role's own
      // boundary holding — expected, and part of the scenario's environment. The
      // authored rule `{tool: "*", denied: true}` cannot see the difference, so
      // it voided every run: six Bash denials, angle unmeasurable forever.
      //
      // Trap 6.2 is about denials we did NOT intend. A role's declared
      // disallowedTools are intended by construction, so they are subtracted
      // here and reported separately. Everything else still voids.
      const expectedDenials = denials.filter((d) => roleDisallowed.has(String(d.tool_name ?? '')));
      const envelopeDenials = denials.length - expectedDenials.length;
      const ctx = { calls, answer, changed, turnsAtCeiling, envelopeDenials };
      ctx.expectedDenials = expectedDenials.length;

      // §4.1 — VOID before anything is scored.
      const voided = (sc.expect?.void_if ?? []).find((v) => detect(v, ctx));
      if (voided) { status = 'VOID'; note = JSON.stringify(voided.rule).slice(0, 200); }
      else {
        const fired = detect(sc.signal?.detect, ctx) || detect(sc.signal?.declaration, ctx);
        const positive = sc.expect?.class === 'positive';
        cls = positive ? (fired ? 'TP' : 'FN') : (fired ? 'FP' : 'TN');
        status = 'SCORED';
        // §4.4 — a value the fixture cannot derive is fabrication, whatever else happened.
        const fab = (sc.expect?.forbidden ?? []).filter((f) => pick(answer ?? {}, f.path).some((v) => v !== null));
        if (fab.length) note = `FABRICATED ${fab.map((f) => f.path).join(',')}`;
      }
      records.push({
        repeat: r, status, class: cls, note,
        turns: live.result?.num_turns,
        cost_usd: live.result?.total_cost_usd,
        denied_unexpected: ctx.envelopeDenials,
        denied_role_expected: ctx.expectedDenials,
        tools: calls.length,
        tool_errors: calls.filter((c) => c.errored).length,
        // WITHOUT THESE, NO VERDICT CAN BE AUDITED. The first scored run came
        // back FN and there was no way to tell whether the agent failed or the
        // detector did — which is the sage-junior defect exactly: a correct
        // refusal recorded as a failure because nobody could see the answer.
        // An FN is a claim about a model and it has to carry its evidence.
        answer,
        answer_text: String(live.result?.result ?? '').slice(0, 4000),
        tool_sequence: calls.map((c) => c.tool.replace(/^mcp__evor__/, '')),
        signal_detect_fired: detect(sc.signal?.detect, ctx),
        signal_declaration_fired: detect(sc.signal?.declaration, ctx),
      });
    }
    if (err) records.push({ repeat: r, status, note });
    rmSync(work, { recursive: true, force: true });
  }

  const out = { scenario: sc.id, angle: sc.angle, frame: sc.frame, role: sc.role, arm, repeats, records };
  if (outDir) { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, `${sc.id}.json`), JSON.stringify(out, null, 1)); }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
const repeats = Number(arg('repeats', 1));
const outDir = arg('out') ? resolve(REPO, arg('out')) : null;
const angle = arg('angle');
let targets = process.argv.slice(2).filter((a) => a.endsWith('.json') && existsSync(a));
if (angle) {
  targets = [];
  for (const g of readdirSync(join(REPO, 'evals/bench'))) {
    const d = join(REPO, 'evals/bench', g, angle);
    if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.json')) targets.push(join(d, f));
  }
}
if (!targets.length) { console.error('no scenarios; pass files or --angle <A1|E1|L3|...>'); process.exit(2); }

console.log(`bench-run: ${targets.length} scenario(s) x ${repeats} repeat(s)\n`);
const all = [];
for (const t of targets.sort()) {
  const res = runScenario(t, { repeats, outDir });
  all.push(res);
  const c = res.records.reduce((m, r) => (m[r.class ?? r.status] = (m[r.class ?? r.status] ?? 0) + 1, m), {});
  const spend = res.records.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  console.log(`${res.scenario.padEnd(46)} ${JSON.stringify(c).padEnd(28)} $${spend.toFixed(4)}`);
}
const tally = all.flatMap((a) => a.records).reduce((m, r) => (m[r.class ?? r.status] = (m[r.class ?? r.status] ?? 0) + 1, m), {});
const spend = all.flatMap((a) => a.records).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
console.log(`\ntotal ${JSON.stringify(tally)}  $${spend.toFixed(2)}`);
if (tally.VOID) console.log(`${tally.VOID} VOID — excluded from scoring, not counted as failures (§4.1)`);
