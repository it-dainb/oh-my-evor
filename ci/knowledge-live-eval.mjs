/**
 * ci/knowledge-live-eval.mjs — LIVE, MCP-ATTACHED evals for the knowledge
 * lifecycle findings (field trace v1.2.0, lane N).
 *
 * WHY THIS FILE EXISTS AND ci/role-eval.mjs DOES NOT COVER IT.
 * Every existing role eval runs the agent with its tools DETACHED and the tool
 * results inlined as text — `ci/eval-core.mjs:182` literally instructs the model
 * "do not call any tool; reason from them directly", and `ci/agent-eval.mjs:371`
 * says "no MCP tools are available here". That is the right design for grading
 * judgement, and it is exactly why the 2,320-session tier corpus contains not
 * one `tool_use` block (README category 7).
 *
 * N-03 cannot be reproduced that way. The defect is not that the model reasons
 * badly; it is that a REAL sage-junior, following its REAL prompt, calls
 * `evor_cite` in a state where the tool can never succeed — and receives
 * `ok:false` inside an `is_error:false` envelope, so it never learns that it
 * failed. Reproducing it needs the real role, the real prompt, and the real
 * server attached over stdio. This runner supplies that.
 *
 * Scenarios:
 *   cite     N-03a/N-03b/N-01/N-04 — evor-sage-junior, empty tree, angle slug.
 *   selector N-06                  — evor-selector served a stale confidence-1.0
 *                                    gotcha whose gate a later contract relaxed.
 *
 * SECRETS. Only the `evor` MCP server is attached (`--strict-mcp-config`). The
 * research MCPs (semantic-scholar, arxiv, hf-mcp) are deliberately NOT attached:
 * they are the ones that take an API key, and R-01 is an open key-exposure
 * blocker in this trace. Nothing here reads, prints, or writes a credential, and
 * no scenario needs the network.
 *
 * GATING. Nothing runs unless EVOR_LIVE_EVAL=1. Gate off = the wrapper suite
 * does not execute these. Gate on = they must FAIL LOUDLY; an unreachable model,
 * a missing build, or a tier mismatch is an error, never a pass.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { extractAgentPromptBlock } from './agent-eval.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The MCP tool-name prefix the CLI assigns to a server named "evor". */
export const EVOR_TOOL_PREFIX = 'mcp__evor__';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — the field condition, on disk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seed a .evor root in the shape the run had when the 18 evor_cite calls failed:
 * a live run with an ACTIVE tree file that contains ZERO nodes, because Sage runs
 * before Forge records anything.
 *
 * @param root absolute path to use as EVOR_ROOT (created if absent)
 * @param opts.gotchas GotchaEntry-shaped objects written to the global store
 * @returns {{evorRoot, missionId, runId, runDir, wikiDir}}
 */
export function seedEvorRoot(root, opts = {}) {
  const missionId = opts.missionId ?? 'binarization-worldmodel-min98-2026-08';
  const runId = opts.runId ?? 'run-live-01';
  const runDir = join(root, 'runs', missionId, runId);
  const wikiDir = join(root, 'wiki');

  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(wikiDir, 'gotchas'), { recursive: true });

  writeFileSync(
    join(root, 'active-run.json'),
    JSON.stringify({ run_id: runId, mission_id: missionId }, null, 2),
  );

  // An EMPTY tree, not a missing one: r3's tree.json existed and held no nodes.
  // The shape must satisfy TreeFileSchema (tree-store.ts:15) — `updated_at` is
  // required, and omitting it makes readTree throw "tree.json is corrupt",
  // which is a DIFFERENT failure that masks the one under test.
  writeFileSync(
    join(runDir, 'tree.json'),
    JSON.stringify({ nodes: {}, updated_at: new Date().toISOString() }, null, 2),
  );

  if (opts.gotchas?.length) {
    writeFileSync(
      join(wikiDir, 'gotchas', 'global.jsonl'),
      opts.gotchas.map((g) => JSON.stringify(g)).join('\n') + '\n',
    );
  }

  return { evorRoot: root, missionId, runId, runDir, wikiDir };
}

/** The r1 gotcha that survived its own invalidation (N-06), verbatim in shape. */
export function staleLatencyGotcha() {
  const t = '2026-08-23T09:12:21+00:00';
  return {
    // Deterministic-id shape, as gotchas.py._gotcha_id produces. It deliberately
    // contains no word like "stale": an id carrying the test's own vocabulary
    // made a staleness-marker assertion pass by matching the fixture itself.
    gotcha_id: 'gotcha-7f3c1a9e4b02',
    kind: 'hardware-constraint',
    signature: 'cpu-4k-latency-gate-requires-lt-3kmac-per-pixel',
    context: { gate: 'cpu_4k_latency_s < 0.1', budget_kmac_per_px: '1-3' },
    resolution: 'Screen proposals by kMAC/px before training.',
    avoidance:
      'Reject any architecture above ~3 kMAC/px; it cannot meet the 4k CPU latency gate.',
    scope: 'global',
    confidence: 1.0,
    occurrences: 4,
    first_seen: t,
    last_seen: t,
  };
}

/** Minimal MCP config: the evor server only. No keyed servers, by design. */
export function writeMcpConfig(path, env) {
  const server = join(REPO_ROOT, 'mcp', 'dist', 'index.cjs');
  if (!existsSync(server)) {
    throw new Error(
      `mcp/dist/index.cjs is missing — run \`npm --prefix mcp run build\` first. ` +
        `A live eval against a stale or absent build measures nothing.`,
    );
  }
  writeFileSync(
    path,
    JSON.stringify({ mcpServers: { evor: { command: 'node', args: [server], env } } }, null, 2),
  );
  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts — the REAL agent prompt block, plus the tick task
// ─────────────────────────────────────────────────────────────────────────────

export function agentPromptBlock(agentFile) {
  return extractAgentPromptBlock(readFileSync(join(REPO_ROOT, agentFile), 'utf8'));
}

/**
 * The sage-junior tick task. Deliberately supplies the literature rather than
 * asking for a search: the finding under test is the TOOL STATE (angle slug +
 * empty tree), not the search. Keeping the research MCPs out also keeps the API
 * key out, which R-01 requires.
 */
export function buildCiteTask({ runId, angleSlug }) {
  return [
    '---',
    '',
    `Run dir / run_id: ${runId}. Your assigned angle slug is \`${angleSlug}\`.`,
    'This is tick 1. Forge has not run yet, so the run tree currently has no nodes —',
    'that is normal and expected at this point in the tick.',
    '',
    'The literature for your angle has already been retrieved for you; do NOT search.',
    'Treat these two sources as your angle evidence:',
    '',
    '  1. doi:10.1109/ACCESS.2026.3681411 — IIR-BinNet: an ultra-lightweight network for',
    '     document image binarization using IIR filters. 49K parameters, F-measure 90.37',
    '     on H-DIBCO 2018, at least 40x smaller than the U-Net baseline.',
    '  2. arXiv:2312.00752 — Mamba: linear-time sequence modeling with selective state',
    '     spaces; the selective SSM is a learnable IIR filter.',
    '',
    'Do exactly this, using the evor MCP tools that are attached:',
    '  1. Record your citation-backed findings for this angle.',
    '  2. Register EVERY source above against your angle with `evor_cite`, as the',
    '     citation-backed mandate requires.',
    '',
    'Then report, as your final message, a JSON block:',
    '```json',
    '{ "angle": "<slug>", "cite_calls_made": <integer>, "cite_calls_that_succeeded": <integer> }',
    '```',
  ].join('\n');
}

/**
 * The selector tick task for N-06. Both proposals target the REAL bottleneck
 * (palm-leaf data), neither carries a kMAC/px estimate, and the contract in
 * force has the RELAXED gate. The stale gotcha in the store encodes the old one.
 */
export function buildSelectorTask() {
  // Proposal shape copied from evals/selector/cases.json's "clean-2" baseline,
  // which the offline selector eval treats as passing all seven gates: distinct
  // families, distinct parents, quantified predictions, an `idea`, and a
  // telemetry-writing code_stub. Neither is `data-acquisition`, so the license /
  // ingestion gate is out of scope. The ONLY live ground left to reject on is
  // the stale kMAC/px gotcha — which is the point of the scenario.
  const proposals = [
    {
      proposal_id: 'h003',
      parent_node_ids: ['iir-scan-binnet-02'],
      approach_family: 'data-curation',
      idea: 'Augraphy synthetic palm-leaf degradation applied to the existing 370-page corpus (no new data sourced).',
      hypothesis: {
        statement: 'The palmleaf_khmer domain gap is a degradation-distribution gap, not a capacity gap.',
        prediction: 'min-domain F improves by 8 to 14 points on palmleaf_khmer',
      },
      wildness: 0.4,
      code_stub: "open(os.environ['EVOR_TELEMETRY_PATH'],'a').write(json.dumps(row))",
    },
    {
      proposal_id: 'h004',
      parent_node_ids: ['iir-binnet-01'],
      approach_family: 'algo',
      idea: 'Hard-example mining: per-sample loss weighting over the palm-leaf pages, architecture unchanged.',
      hypothesis: {
        statement: 'Worst-domain F is limited by sample weighting, not by model capacity.',
        prediction: 'min-domain F improves by 4 to 7 points with no change in parameter count',
      },
      wildness: 0.35,
      code_stub: "with open(os.environ['EVOR_TELEMETRY_PATH'],'a') as f: f.write(line)",
    },
  ];

  return [
    '---',
    '',
    'This is tick 1 of mission `binarization-worldmodel-min98-2026-08`, run `run-live-01`.',
    '',
    'The goal contract IN FORCE for this tick has these latency gates:',
    '  latency_cpu_4k_s < 1        (one second)',
    '  latency_gpu_ms   < 500',
    'The current best node measures 74.85 ms GPU and 0.62 s CPU@4k, so there is roughly',
    '15x GPU and 1.6x CPU headroom against the gates above. The binding constraint this',
    'tick is the palmleaf_khmer domain, at 3.527% min-domain F.',
    '',
    'Step 1, before you judge anything: call `evor_gotcha_query` and read what the',
    'store returns. Your Gotcha_Avoidance gate cannot be scored without it, and an',
    'unqueried store is a gate failure on your own protocol.',
    '',
    'Step 2: two proposals are up for gating:',
    '```json',
    JSON.stringify({ tick: 1, proposals }, null, 2),
    '```',
    '',
    'Emit your critic_review for both proposals as a single fenced JSON block:',
    '```json',
    '{ "reviews": [ { "proposal_id": "...", "verdict": "approved | rejected", "rejection_reason": "<string or null>" } ] }',
    '```',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Live CLI call — stream-json so tool_use / tool_result are observable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one live agent call with the evor MCP server attached.
 *
 * FAILS LOUDLY on every abnormal condition: a CLI error, an unparseable stream,
 * or a model that is not the tier we asked for. A live eval that degrades to a
 * pass when the model is unreachable is worse than no eval.
 *
 * @returns {{events: object[], result: object, model: string, cost_usd: number, wall_ms: number}}
 */
export function runLive({ prompt, model, effort, maxTurns, timeoutMs, env, mcpConfigPath, allowedTools, cwd, settingsPath, agentsJson, pluginDir, tolerateError = false }) {
  // A PROMPT MAY NOT OPEN WITH A DASH. `-p` will not accept an option-looking
  // token as its value, so the CLI exits 1 with `unknown option` and no output —
  // indistinguishable, from the outside, from a model that said nothing. Name it
  // here rather than let it arrive as an unreadable harness error.
  if (/^-/.test(prompt)) {
    throw new Error(`prompt starts with '-' (${JSON.stringify(prompt.slice(0, 40))}) — the CLI parses it as a flag; strip leading frontmatter or dashes before calling runLive`);
  }
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(maxTurns ?? 12),
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', allowedTools.join(','),
  ];
  if (effort) args.push('--effort', effort);
  // REGISTER THE ROLES THE ROLE IS TOLD TO DELEGATE TO (defect 23).
  // Without this the bench runs every role as a top-level agent, so
  // `oh-my-evor:evor-*` types do not exist, `SubagentStart`/`SubagentStop` never
  // fire, and every role emits a high-severity `capability-gap` about the gap —
  // which the group-L declarations then counted as a declaration on BOTH halves
  // of the same pair. `--agents` takes {name: {description, prompt, model, tools}}
  // and the spawned type is addressable by bare name; verified live.
  // The sandbox plugin, under its real name. See the note at the call site.
  if (pluginDir) args.push('--plugin-dir', pluginDir);
  if (agentsJson) args.push('--agents', agentsJson);
  // The product's own PreToolUse guard, scoped to the sandbox. Without it the
  // governance angles grade prose compliance instead of the gate they name.
  if (settingsPath) args.push('--settings', settingsPath);

  const t0 = Date.now();
  let raw;
  try {
    raw = execFileSync('claude', args, {
      encoding: 'utf8',
      timeout: timeoutMs ?? 600000,
      maxBuffer: 64 * 1024 * 1024,
      // THE SANDBOX IS ONLY A SANDBOX IF THE PROCESS RUNS IN IT. Without this
      // the child inherits the repo root, so every relative Read/Glob/Bash the
      // agent issues addresses the LIVE TREE. `A3-best-score-pos` said so in
      // its answer — "no file matching iir-binnet-01 exists in the repo" — and
      // three bench fixtures were mutated by pilot runs writing through it.
      // Callers that want the repo pass nothing and inherit, as before.
      ...(cwd ? { cwd } : {}),
      env: {
        ...process.env,
        // THE BENCH WAS MEASURING THE OPERATOR'S CLAUDE.md, NOT THE ROLE'S.
        //
        // `claude -p` loads the user's global CLAUDE.md as memory, and on this
        // machine that file is the oh-my-claudecode orchestration layer — "delegate
        // to executor", "route SDK questions to document-specialist", "prefer the
        // lightest path". Every scored bench run since the pilot has read it.
        // Verified by asking a bare `claude -p` to quote its first memory heading:
        // it answered "# oh-my-claudecode - Intelligent Multi-Agent Orchestration".
        //
        // `--system-prompt` does NOT suppress it — memory is injected separately
        // from the default system prompt, checked. `--bare` and `--safe-mode` do,
        // but both disable hooks, and the product's PreToolUse guard is the thing
        // half these angles measure. Isolating CLAUDE_CONFIG_DIR breaks auth.
        // This env var is the only lever that removes the contamination and leaves
        // hooks and credentials alone.
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        // THE PRODUCT'S STOP HOOK CAN ONLY MISFIRE HERE, and my own fix loaded it.
        // `--plugin-dir` brought all of hooks.json into force — which is what finally
        // gave SubagentStart/SubagentStop to the roles, and brought `Stop` along.
        //
        // `hooks/stop.mjs` blocks when the tick is incomplete, up to 8 times, and never
        // for a `pending_node_ids` violation. Every fixture in this corpus DEPICTS a
        // mid-tick state — that is the point of them — so a role asked one question
        // about that state trips the hook on its way out, every time, and is handed a
        // content-free notice with no new instruction. The agents describe it exactly:
        // "This is the fourth identical hook notice with no new content or instruction",
        // "I'm receiving repeated feedback from your stop hook with no new information".
        // Nine records across lite19 and lite22 say so in their final answer, and it is
        // the mechanism behind the `prompt_not_delivered` voids and part of the
        // `no terminal JSON answer` ones: the last message replies to the hook, not the
        // task.
        //
        // The hook is doing its job; the bench put it somewhere it cannot do anything
        // else. Disabled through the product's OWN documented kill switch
        // (hooks/stop.mjs:7) rather than by filtering hooks.json, so exactly one named
        // hook is excluded and the rest of the reflex layer stays in force.
        //
        // Stop discipline deserves an angle that measures it deliberately, with a
        // fixture whose tick is COMPLETE so a block is a finding rather than a
        // certainty. None exists today.
        EVOR_SKIP_HOOKS: [process.env.EVOR_SKIP_HOOKS, 'stop'].filter(Boolean).join(','),
        ...env,
      },
    });
  } catch (e) {
    raw = e.stdout ?? '';
    if (!raw) {
      // NAME THE EXIT, NOT THE COMMAND. `e.message` for execFileSync opens with
      // the entire argv, so a 40KB prompt buried the one fact that identifies
      // the failure. L1 voided in six consecutive runs behind that prefix.
      const st = e.status ?? e.code ?? '?';
      const sig = e.signal ? ` signal=${e.signal}` : '';
      const err = String(e.stderr ?? '').trim().slice(0, 400) || '(stderr empty)';
      throw new Error(`live call failed and produced no output: exit=${st}${sig} stderr=${err}`);
    }
  }
  const wall_ms = Date.now() - t0;

  const events = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* partial line — skip */
    }
  }
  if (events.length === 0) {
    throw new Error(`live call produced no parseable stream-json events: ${raw.slice(0, 400)}`);
  }

  const result = events.find((e) => e.type === 'result');
  if (!result) throw new Error('live call produced no result event — the run did not complete');
  // `tolerateError` is for callers that must INSPECT a failed run rather than
  // abort on it. ci/bench-run.mjs needs this: a run that ends at the turn
  // ceiling, or that accumulated permission denials, is VOID under §4.1 — a
  // fact about the harness, not a wrong answer from the model. Throwing here
  // would collapse that distinction into a generic harness error and lose the
  // trace that proves which it was. Default stays throw: a live eval that
  // degrades to a pass when the model is unreachable is worse than none.
  if (result.is_error && !tolerateError) {
    throw new Error(`CLI reported an error: ${String(result.result ?? '').slice(0, 400)}`);
  }

  const usedModels = Object.keys(result.modelUsage ?? {});
  return {
    events,
    result,
    model: usedModels.join(','),
    cost_usd: Number(result.total_cost_usd ?? 0),
    num_turns: Number(result.num_turns ?? 0),
    wall_ms,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream analysis (pure — unit-tested without the network)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract every call to one MCP tool and pair it with its result.
 *
 * The pairing is what makes N-03b observable: `is_error` lives on the
 * tool_result block, and `ok` lives inside its text payload. When they disagree,
 * the agent was told a failure had succeeded.
 *
 * @returns {{name, input, is_error, ok, error, text}[]} one entry per call
 */
export function extractToolCalls(events, toolNameSuffix) {
  const byId = new Map();
  for (const ev of events) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && String(block.name ?? '').endsWith(toolNameSuffix)) {
        byId.set(block.id, { name: block.name, input: block.input, is_error: null, ok: null, error: null, text: '' });
      }
    }
  }
  for (const ev of events) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const call = byId.get(block.tool_use_id);
      if (!call) continue;
      call.is_error = Boolean(block.is_error);
      const text = Array.isArray(block.content)
        ? block.content.map((c) => c?.text ?? '').join('')
        : String(block.content ?? '');
      call.text = text;
      try {
        const body = JSON.parse(text.slice(text.indexOf('{')));
        call.ok = body.ok;
        call.error = body.error ?? null;
      } catch {
        /* non-JSON payload — leave ok null, the caller reports it */
      }
    }
  }
  return [...byId.values()];
}

/** attempted / landed / silent-failure counts for one tool. The field ratio was 0/18. */
export function tallyCiteOutcomes(calls) {
  const attempted = calls.length;
  const landed = calls.filter((c) => c.ok === true).length;
  const silentFailures = calls.filter((c) => c.ok === false && c.is_error !== true).length;
  return { attempted, landed, silentFailures };
}

/** Did the model reject a proposal on a kMAC/px-shaped ground? (N-06 harm) */
export function rejectedForKmac(review) {
  if (!review || review.verdict !== 'rejected') return false;
  return /kmac|mac\s*\/?\s*(px|pixel)|macs per pixel/i.test(String(review.rejection_reason ?? ''));
}

/**
 * Pull a JSON object out of a final message.
 *
 * Scans EVERY fenced json block, not just the first: a real agent narrates
 * around its answer and often emits a gate table or a preamble block before the
 * one that matters. `requiredKey` selects the block that actually carries the
 * answer, so a missing answer stays distinguishable from a parse miss.
 */
export function parseFinalJson(text, requiredKey) {
  const raw = String(text ?? '');
  const candidates = [...raw.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  candidates.push(raw); // unfenced fallback
  for (const body of candidates) {
    const start = body.indexOf('{');
    if (start === -1) continue;
    let parsed;
    try {
      parsed = JSON.parse(body.slice(start, body.lastIndexOf('}') + 1));
    } catch {
      continue;
    }
    if (!requiredKey || Object.prototype.hasOwnProperty.call(parsed, requiredKey)) return parsed;
  }
  return null;
}
