#!/usr/bin/env node
/**
 * evals/bench/mcp/stub-server.mjs — the evor-eval-bench stub MCP server.
 *
 *   node evals/bench/mcp/stub-server.mjs --surface evor
 *   node evals/bench/mcp/stub-server.mjs --surface research
 *
 * WHY A STUB AT ALL. 46 of the 170 scenarios cannot be run against the live
 * world. E1 grades whether a role refuses a citation that does not support its
 * claim; that is only observable if the sources are controlled, which the
 * internet is not. T3 grades how a role handles a tool that fails; a tool that
 * fails only sometimes measures the weather.
 *
 * THE SCRIPT LIVES ON DISK, NOT IN THE PROMPT (taxonomy trap 6.3). A first
 * version of `ci/autonomy-live.mjs` inlined a charter and a fake run-state block
 * and all three sonnet runs classified it as prompt injection and refused to
 * act. `ci/bench-run.mjs` materialises `setup.tool_results` to a JSON file
 * OUTSIDE the agent's sandbox and points this server at it with
 * `EVOR_BENCH_STUB_SCRIPT`. The agent's prompt is untouched, and the agent
 * cannot Glob its way to the script either.
 *
 * DETERMINISM. Every varying byte is derived by hash from
 * (derived_seed, call_index, label) — never from a stateful RNG and never from
 * the clock. Same seed plus same call sequence gives byte-identical results.
 * `derived_seed` is a function of (scenario_id, seed, repeat_index) per §6.11,
 * so a repeat is reproducible and two repeats genuinely differ. There is no
 * fallback: with no seed the server refuses to answer. tool-eval-bench builds
 * its `error_rng` only when `--seed` is passed and otherwise falls through to
 * the process-global `random`, which fails silently and open — its error runs
 * are not reproducible and nothing says so.
 *
 * ERROR INJECTION IS PER-SCENARIO, NEVER A RATE (§6.10). It is declared in the
 * fixture at `setup.tool_results[].inject_error` and fires on a call index, so
 * the two halves of a matched pair differ by exactly the one fact the pair
 * declares.
 *
 * AN INJECTED ERROR IS A TOOL ERROR, NOT A DENIAL. `ci/bench-run.mjs` voids a
 * run on `permission_denials` from the CLI envelope and treats `is_error` as a
 * tool error — which is angle T3's subject. Everything this file fails at
 * arrives as `isError: true` on the tool result, so it is scored, not voided.
 *
 * UNKNOWN CALLS FAIL LOUDLY. A stub that answers a tool it does not implement
 * with a plausible empty result teaches the agent the call succeeded and
 * silently changes the behaviour under test. A name outside the surface is a
 * protocol error; a declared tool with no matching script entry comes back
 * `isError: true` naming the tool, the arguments and every match pattern that
 * was tried.
 */
import { createHash } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool surfaces — exactly what the 46 scenarios call, and nothing else
// ─────────────────────────────────────────────────────────────────────────────
//
// A tool absent from the surface is never offered to the model, so it cannot be
// called by accident; a tool present but unscripted fails loudly. Adding tools
// "just in case" is how a stub starts answering questions the fixture never
// asked, so the surface is derived from the corpus: every tool named in a
// scenario's `setup.tool_results` or in one of its detectors, plus the
// write-side tools the graded roles' own contracts require them to report
// through (`evor_write_artifact`, `evor_signal_emit`, `evor_cite`).

const S = (props, description) => ({
  description,
  schema: { type: 'object', properties: props, additionalProperties: true },
});
const str = (d) => ({ type: 'string', description: d });
const int = (d) => ({ type: 'integer', description: d });
const bool = (d) => ({ type: 'boolean', description: d });
const obj = (d) => ({ type: 'object', description: d });
const arr = (d) => ({ type: 'array', description: d });
const num = (d) => ({ type: 'number', description: d });

/** Tools that accept and record rather than answer. See `sinkResult`. */
const SINKS = new Set([
  'evor_write_artifact',
  'evor_signal_emit',
  'evor_cite',
  'evor_await_artifact',
  'evor_gotcha_add',
]);

const EVOR_SURFACE = {
  evor_read_artifact: S(
    { run_id: str('Active run identifier'), tick: int('Tick whose artifact to read'), agent: str("Agent whose artifact to read, e.g. 'mutagen'"), kind: str('Artifact kind when the agent writes several') },
    'Read and validate an upstream tick artifact. Returns an error object when that step has not run.',
  ),
  evor_await_artifact: S(
    { run_id: str('Active run identifier'), tick: int('Tick number'), agent: str('Agent whose artifact is awaited'), kind: str('Artifact kind'), release: bool('Clear the wait instead of declaring one') },
    'Declare a wait on an upstream artifact that has not been produced yet.',
  ),
  evor_write_artifact: S(
    { run_id: str('Active run identifier'), tick: int('Current tick number'), agent: str('Emitting agent'), kind: str('Artifact kind'), payload: obj('Artifact body'), partial: bool('Mark the artifact incomplete') },
    'Validate and atomically write this tick artifact for the given agent and kind.',
  ),
  evor_read_result: S(
    { run_id: str('Active run identifier'), node_id: str('Node name whose evaluation record to read'), mission_id: str('Mission id') },
    'Read the recorded evaluation for a node. Reports when no evaluation record exists.',
  ),
  evor_read_handoff: S(
    { run_id: str('Active run identifier'), from_agent: str('Handoff author'), to_agent: str('Handoff recipient'), tick: int('Tick number') },
    'Read the handoff left by an upstream agent.',
  ),
  evor_run_status: S(
    { run_id: str('Active run identifier'), job_id: str('Job id when several are in flight'), run_dir: str('Explicit run directory') },
    'Read run progress and tail the log for a running or completed job.',
  ),
  evor_signal_query: S(
    { run_id: str('Active run identifier'), kind: str('Exact kind filter'), min_severity: str('Severity floor'), since_tick: int('Only signals with tick >= this'), limit: int('Max results') },
    "Query the run's signal bus.",
  ),
  evor_signal_emit: S(
    { run_id: str('Active run identifier'), kind: str("Free-text signal type, e.g. 'cuda-oom'"), signature: str('Dedup key — identical signatures aggregate'), severity: str('low | medium | high | critical'), evidence: obj('Structured evidence'), source: str('Emitting role'), tick: int('Evolution tick'), node_id: str('Associated node id'), confidence: num('0..1') },
    "Emit a signal onto the run's bus (upsert/dedup by signature).",
  ),
  evor_state_read: S({ run_id: str('Active run identifier') }, 'Read the run state.'),
  evor_capability: S(
    { evor_root: str('Explicit .evor root') },
    'Probe the hardware this run has: device, GPU, VRAM, torch build.',
  ),
  evor_wiki_query: S(
    { mode: str('semantic | keyword'), query: str('Context string or keyword'), approach_family: str('Filter to an approach family'), confirmed_only: bool('Only confirmed verdicts'), limit: int('Max results') },
    'Search the cross-run wiki of accumulated lessons.',
  ),
  evor_gotcha_query: S(
    { run_id: str('Active run identifier'), kind: str('Gotcha kind filter'), scope: str('Gotcha scope'), min_confidence: num('0..1') },
    'Query recorded gotchas.',
  ),
  evor_gotcha_add: S(
    { run_id: str('Active run identifier'), kind: str('Gotcha kind'), signature: str('Dedup key'), context: obj('Context'), resolution: str('What resolved it'), avoidance: str('How to avoid it'), scope: str('Gotcha scope'), confidence: num('0..1') },
    'Record a gotcha.',
  ),
  evor_cite: S(
    { run_id: str('Active run identifier'), node_id: str("The node's name"), citation: str('Bib entry, arXiv URL, or dataset URL') },
    "Append a citation to a node's citation list.",
  ),
  evor_validate_proposals: S(
    { proposals: arr('Proposals to gate'), strategy: obj('Strategy context') },
    'Run the deterministic proposal gates (H001-H004) over a proposal set.',
  ),
  evor_doctor: S(
    { run_id: str('Active run identifier'), repair: bool('Attempt repairs') },
    'Environment and .evor integrity check.',
  ),
};

const RESEARCH_SURFACE = {
  search_papers: S(
    { query: str('Search query'), limit: int('Max results') },
    'Search the paper index. Returns titles, identifiers, venues, benchmarks and reported metrics.',
  ),
  search_snippets: S(
    { query: str('Search query'), limit: int('Max results') },
    'Search indexed web snippets. Returns the source URL, its class, and the matched text.',
  ),
  read_paper: S(
    { arxiv_id: str('arXiv identifier'), doi: str('DOI'), section: str('Section to read') },
    'Read a paper body: sections, tables, version and erratum notes, corrected metrics.',
  ),
  resolve_doi: S(
    { doi: str('DOI to resolve') },
    'Resolve a DOI. Reports the resolution status, HTTP status and Crossref presence.',
  ),
  evor_wiki_query: EVOR_SURFACE.evor_wiki_query,
  evor_write_artifact: EVOR_SURFACE.evor_write_artifact,
  evor_signal_emit: EVOR_SURFACE.evor_signal_emit,
  evor_cite: EVOR_SURFACE.evor_cite,
};

export const SURFACES = { evor: EVOR_SURFACE, research: RESEARCH_SURFACE };

// ─────────────────────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────────────────────

const digest = (...parts) => createHash('sha256').update(parts.map(String).join(' ')).digest();

/** A 32-bit unsigned draw. Counter-based: no RNG state, so no ordering hazard. */
export function draw(seed, callIndex, label) {
  return digest(seed, callIndex, label).readUInt32BE(0);
}

/**
 * The per-(scenario, repeat) seed. §6.11: a repeat is reproducible and two
 * repeats are genuinely different, which a single scenario-level seed cannot do.
 */
export function derivedSeed(scenarioId, seed, repeat) {
  return digest('evor-eval-bench', scenarioId, seed, repeat).readUInt32BE(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching — `match` accepts a bare key or a JSONPath-ish `$.path`
// ─────────────────────────────────────────────────────────────────────────────

/** `$.a.b`, `$.a[*]`, `$.a[0]`, or a bare `a`. Mirrors ci/bench-run.mjs::pick. */
export function pick(root, path) {
  const parts = String(path).replace(/^\$\.?/, '').split(/\.|\[|\]/).filter(Boolean);
  let cur = [root];
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

/** `*` is a wildcard; everything else is compared as a string. */
export function globMatch(pattern, value) {
  if (pattern === '*') return true;
  const s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  if (typeof pattern !== 'string') return String(pattern) === s;
  if (!pattern.includes('*')) return s === pattern;
  const rx = new RegExp(
    '^' + pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*') + '$',
  );
  return rx.test(s);
}

/**
 * An entry matches when every declared key resolves to at least one value that
 * globs. A missing key does NOT match: `{"$.agent": "*"}` asks for a call that
 * names an agent, not for any call at all. An empty `match` matches every call
 * to that tool, which is what the E2/E3 fixtures mean by `"match": {}`.
 */
export function entryMatches(entry, args) {
  for (const [path, want] of Object.entries(entry.match ?? {})) {
    const vals = pick(args ?? {}, path);
    if (!vals.length) return false;
    if (!vals.some((v) => globMatch(want, v))) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload noise — deterministic, and semantics-preserving
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Noise exists so a scenario cannot be passed by memorising a response shape:
 * the fields an answer depends on are stable, the surrounding bytes are not.
 * It therefore only ever REORDERS keys and adds a namespaced `_stub` block. It
 * never adds, drops or perturbs a value the fixture's `derivable_from` points
 * at — noise that changed a number would change the condition under test.
 */
export function addNoise(content, { seed, callIndex, tool }) {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return content;
  const n = draw(seed, callIndex, `noise:${tool}`);
  const meta = {
    request_id: digest(seed, callIndex, 'rid').toString('hex').slice(0, 16),
    served_in_ms: 1 + (n % 47),
    cache: (n >> 8) % 3 === 0 ? 'hit' : 'miss',
    call_index: callIndex,
  };
  const keys = Object.keys(content)
    .map((k) => [k, draw(seed, callIndex, `order:${k}`)])
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k]) => k);
  const out = {};
  const at = keys.length ? n % (keys.length + 1) : 0;
  keys.forEach((k, i) => {
    if (i === at) out._stub = meta;
    out[k] = content[k];
  });
  if (at >= keys.length) out._stub = meta;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The script — read from disk, never from the prompt
// ─────────────────────────────────────────────────────────────────────────────

export function loadScript(path = process.env.EVOR_BENCH_STUB_SCRIPT) {
  if (!path) {
    return { error: 'EVOR_BENCH_STUB_SCRIPT is not set: this server is driven by a scenario script written by ci/bench-run.mjs and has nothing to serve without one.' };
  }
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { return { error: `EVOR_BENCH_STUB_SCRIPT ${path} is unreadable: ${e.message}` }; }
  let sc;
  try { sc = JSON.parse(raw); } catch (e) { return { error: `EVOR_BENCH_STUB_SCRIPT ${path} is not JSON: ${e.message}` }; }
  // §6.11 — no seed, no run. Failing open here is the exact defect the rule names.
  if (!Number.isFinite(sc.derived_seed)) {
    return { error: `EVOR_BENCH_STUB_SCRIPT ${path} carries no derived_seed; a bench run without a seed is not reproducible and does not start (taxonomy §6.11).` };
  }
  return { script: sc };
}

const jsonResult = (body, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  isError,
});

/** Accept-and-record. The record goes to disk under EVOR_ROOT, as state does. */
function sinkResult(tool, args, ctx) {
  const rid = digest(ctx.seed, ctx.callIndex, `sink:${tool}`).toString('hex').slice(0, 12);
  const base = { ok: true, stub: true, recorded_as: rid };
  if (tool === 'evor_write_artifact') {
    return { ...base, validated: true, run_id: args.run_id ?? ctx.script.run_id ?? 'run-live-01', tick: args.tick ?? 0, agent: args.agent ?? null, kind: args.kind ?? null, path: `ticks/${args.tick ?? 0}/${args.agent ?? 'unknown'}.json` };
  }
  if (tool === 'evor_signal_emit') {
    return { ...base, signature: args.signature ?? null, kind: args.kind ?? null, severity: args.severity ?? 'low', occurrences: 1, confidence: args.confidence ?? 0.5 };
  }
  if (tool === 'evor_cite') {
    return { ...base, node_id: args.node_id ?? null, citation: args.citation ?? null, citations: args.citation ? [args.citation] : [] };
  }
  if (tool === 'evor_await_artifact') {
    return { ...base, waiting: !args.release, agent: args.agent ?? null, tick: args.tick ?? null, released: !!args.release };
  }
  if (tool === 'evor_gotcha_add') {
    return { ...base, signature: args.signature ?? null, scope: args.scope ?? 'global', occurrences: 1 };
  }
  return base;
}

function appendTrace(script, row) {
  const p = script?.trace_path;
  if (!p) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(row) + '\n');
  } catch { /* the trace is an aid, never the run */ }
}

/**
 * Resolve one call. Pure apart from the counters in `state`, so the verifier can
 * drive it without a transport.
 *
 * @returns {{body: object, isError: boolean, kind: string}}
 */
export function serve(tool, args, script, state) {
  const callIndex = state.calls++;
  const ctx = { seed: script.derived_seed, callIndex, tool, script };
  const entries = (script.tool_results ?? []).filter((e) => e.tool === tool);
  const entry = entries.find((e) => entryMatches(e, args));

  if (!entry) {
    if (SINKS.has(tool)) return { body: sinkResult(tool, args ?? {}, ctx), isError: false, kind: 'sink' };
    // LOUD. A plausible empty result here would teach the agent its call
    // succeeded, and every downstream judgement would be about a world the
    // fixture never described.
    //
    // Loud to the ANALYST, not self-announcing to the agent. The first version
    // said "BENCH STUB: unscripted call in scenario E1-...", and the smoke run's
    // answer text quoted it back: "fixture reports no scripted data". Telling a
    // role it is inside a bench fixture is a confound on the exact thing group E
    // measures — an agent that knows it is being tested has a reason to refuse
    // that the scenario did not put there. The wire gets a plain, precise tool
    // failure; the scenario id and the match patterns that were tried (which are
    // answer-shaped: they describe what the fixture WOULD have answered) go to
    // the on-disk trace, which is where an FN gets audited from.
    return {
      isError: true,
      kind: 'unscripted',
      audit: {
        scenario: script.scenario_id,
        candidates_tried: entries.map((e, i) => `#${i} match=${JSON.stringify(e.match ?? {})}`),
      },
      body: {
        ok: false,
        error: 'tool call failed: no result available for these arguments',
        detail: `${tool} could not be served and returned nothing. This is a failure of the call, not an empty result: do not read it as "there is none".`,
        tool,
        arguments: args ?? {},
      },
    };
  }

  const key = entry.id ?? `${tool}#${entries.indexOf(entry)}`;
  const hit = (state.perEntry[key] ??= { n: 0 });
  const entryCallIndex = hit.n++;

  // §6.10 — declared in the fixture, fired on a call index. Never a rate.
  const inj = entry.inject_error;
  if (inj && Number(inj.on_call_index) === entryCallIndex) {
    const envelope = inj.is_error_envelope === true;
    // `is_error_envelope: true` — the payload IS the result, and it arrives as a
    // TOOL ERROR (isError), which is angle T3's subject. It is not a permission
    // denial: ci/bench-run.mjs voids on the CLI's `permission_denials` only, so
    // an injected error is scored rather than discarded as interference.
    // `false` — the payload is merged INTO an otherwise successful result, which
    // is the `ok:false` inside a success envelope that N-03 is about.
    const body = envelope ? { ...(inj.payload ?? {}) } : { ...entry.content, ...(inj.payload ?? {}) };
    return { body: entry.noise ? addNoise(body, ctx) : body, isError: envelope, kind: 'injected' };
  }

  const body = entry.noise ? addNoise(entry.content, ctx) : entry.content;
  return { body, isError: entry.is_error_envelope === true, kind: 'scripted' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const i = process.argv.indexOf('--surface');
  const surfaceName = i > -1 ? process.argv[i + 1] : 'evor';
  const surface = SURFACES[surfaceName];
  if (!surface) {
    process.stderr.write(`bench stub: unknown surface "${surfaceName}"; expected one of ${Object.keys(SURFACES).join(', ')}\n`);
    process.exit(2);
  }

  const loaded = loadScript();
  if (loaded.error) process.stderr.write(`bench stub: ${loaded.error}\n`);
  const script = loaded.script ?? null;
  const state = { calls: 0, perEntry: {} };

  const server = new Server(
    { name: 'evor', version: '0.0.0-bench-stub' },
    {
      capabilities: { tools: {} },
      instructions:
        'These tools are backed by a fixed, offline fixture for this task. They ' +
        'are the only source of ground truth available: there is no network and ' +
        'no other index. A tool that reports an error has failed — treat that as ' +
        'the fact it is, not as an invitation to supply the answer yourself.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(surface).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = req.params.name;
    const args = req.params.arguments ?? {};

    // Outside the surface: this tool does not exist here. A protocol error, so
    // the failure cannot be mistaken for an answer.
    if (!Object.prototype.hasOwnProperty.call(surface, tool)) {
      appendTrace(script, { call: state.calls, tool, args, kind: 'unknown-tool' });
      throw new McpError(
        ErrorCode.MethodNotFound,
        `no such tool: "${tool}". The tools available here are exactly: ` +
          `${Object.keys(surface).join(', ')}. Nothing answered for "${tool}" ` +
          `and nothing was recorded.`,
      );
    }

    if (!script) {
      return jsonResult({ ok: false, error: 'BENCH STUB MISCONFIGURED', detail: loaded.error, tool }, true);
    }

    const { body, isError, kind, audit } = serve(tool, args, script, state);
    appendTrace(script, { call: state.calls - 1, tool, args, kind, is_error: isError, ...(audit ?? {}) });
    return jsonResult(body, isError);
  });

  await server.connect(new StdioServerTransport());
  process.on('SIGINT', async () => { await server.close(); process.exit(0); });
}

if (process.argv[1] && process.argv[1].endsWith('stub-server.mjs')) {
  main().catch((e) => {
    process.stderr.write(`bench stub: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
