/**
 * ci/bench-trace.mjs — multi-turn trace capture with phase indexing.
 *
 * `phase` is the zero-based index of the user turn that was active when a tool
 * call was made. Preflight §3.2 is explicit that this is not a nicety: A3's
 * canonical field instance is `critic_approved: true` written at 00:21 by a
 * helper agent, while `evor-selector` — the only role whose authority that field
 * carries — was not spawned until 00:32. The value was right-shaped and eleven
 * minutes early. Ordering IS the finding, and a flat trace cannot express it.
 *
 * Measured over the corpus: 168 of 170 scenarios are single-turn, where every
 * call is phase 0. Two are not — `A2-peer-laundering` pos and neg — and they are
 * precisely the pair asking whether a write happened BEFORE the turn that
 * authorised it. Building this for two scenarios is worth it because those two
 * are unmeasurable without it, and would otherwise score as passes.
 */
import { execFileSync } from 'child_process';

/** Parse stream-json stdout into events, tolerating partial lines. */
function parseEvents(raw) {
  const out = [];
  for (const line of String(raw).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* partial line */ }
  }
  return out;
}

function invoke(args, { env, timeoutMs, cwd }) {
  try {
    return execFileSync('claude', args, {
      encoding: 'utf8',
      timeout: timeoutMs ?? 900_000,
      maxBuffer: 64 * 1024 * 1024,
      ...(cwd ? { cwd } : {}),
      // Same isolation as runLive: the operator's global CLAUDE.md is memory, and
      // on this machine it is an unrelated orchestration layer. See the note in
      // knowledge-live-eval.mjs for why no CLI flag reaches it without also
      // disabling the hooks these angles measure.
      // Same two exclusions as runLive: the operator's CLAUDE.md is memory, and the
      // product's Stop hook can only misfire against a fixture that depicts a
      // mid-tick state. See the note in knowledge-live-eval.mjs.
      env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        EVOR_SKIP_HOOKS: [process.env.EVOR_SKIP_HOOKS, 'stop'].filter(Boolean).join(','), ...env },
    });
  } catch (e) {
    // A non-zero exit still carries the stream on stdout — a turn that ended at
    // the ceiling must be INSPECTABLE, not discarded. §4.1 grades it VOID, which
    // requires seeing the trace that proves it.
    const raw = e.stdout ?? '';
    if (!raw) throw new Error(`claude produced no output: ${e.message}`);
    return raw;
  }
}

/**
 * Run one scenario across its user turns, tagging every event with its phase.
 *
 * @returns {{events: object[], results: object[], result: object, phases: number}}
 *   `result` is the LAST turn's result envelope (the run's outcome); `results`
 *   holds every turn's, because cost and denials accumulate across turns and a
 *   caller that reads only the last one under-reports both.
 */
export function runPhased({ prompt, followUps = [], model, effort, maxTurns, timeoutMs, env, mcpConfigPath, allowedTools, cwd, settingsPath, agentsJson, pluginDir }) {
  const base = [
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(maxTurns ?? 20),
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', allowedTools.join(','),
  ];
  if (effort) base.push('--effort', effort);
  if (settingsPath) base.push('--settings', settingsPath);
  if (pluginDir) base.push('--plugin-dir', pluginDir);
  if (agentsJson) base.push('--agents', agentsJson);

  const events = [];
  const results = [];
  let sessionId = null;

  const turns = [prompt, ...followUps];
  for (let phase = 0; phase < turns.length; phase++) {
    // Turn 0 starts the session; later turns resume it, which is what makes the
    // ordering real rather than reconstructed — the model genuinely has not seen
    // the follow-up yet when it acts in phase 0.
    const args = phase === 0
      ? ['-p', turns[phase], ...base]
      : ['-p', turns[phase], '--resume', sessionId, ...base];

    const raw = invoke(args, { env, timeoutMs, cwd });
    const turnEvents = parseEvents(raw);
    if (!turnEvents.length) throw new Error(`turn ${phase} produced no parseable stream-json`);

    for (const e of turnEvents) events.push({ ...e, phase });
    const r = turnEvents.find((e) => e.type === 'result');
    if (!r) throw new Error(`turn ${phase} produced no result event — the turn did not complete`);
    results.push({ ...r, phase });

    sessionId = r.session_id ?? sessionId;
    if (!sessionId && phase < turns.length - 1) {
      throw new Error(`turn ${phase} returned no session_id; cannot deliver follow-up ${phase + 1}`);
    }
  }

  return {
    events,
    results,
    result: results[results.length - 1],
    phases: turns.length,
    // Accumulated across turns, because a caller reading only the last envelope
    // under-reports both of these on any multi-turn scenario.
    total_cost_usd: results.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0),
    permission_denials: results.flatMap((r) => r.permission_denials ?? []),
    num_turns: results.reduce((s, r) => s + (r.num_turns ?? 0), 0),
  };
}

/** Tool calls with their phase, for detectors that grade ordering. */
export function phasedCalls(events) {
  const calls = [];
  const results = new Map();
  for (const e of events) {
    for (const b of e?.message?.content ?? []) {
      if (b?.type === 'tool_use') calls.push({ id: b.id, tool: String(b.name ?? ''), input: b.input ?? {}, phase: e.phase ?? 0 });
      if (b?.type === 'tool_result') results.set(b.tool_use_id, b);
    }
  }
  for (const c of calls) c.errored = !!results.get(c.id)?.is_error;
  return calls;
}
