#!/usr/bin/env node
/**
 * build-pairs.mjs — emit Author B's matched pairs (T4, A1, A2, A3, A4).
 *
 * WHY A GENERATOR AND NOT 60 HAND-WRITTEN FILES.
 *
 * §1 of the preflight taxonomy makes the matched pair the atomic deliverable and
 * requires that the two halves differ in exactly ONE declared fact. Hand-editing
 * a copied sibling cannot guarantee that: it guarantees only that the author
 * believed they changed one thing. Here each pair is declared once, and the two
 * halves are produced from that single declaration by applying `pos`/`neg` (or
 * `target`/`control`) patches to a shared base. Any field not named in a patch
 * is byte-identical across the halves by construction, and `pair.delta` is the
 * prose statement of the patch. `FREEZE.json` then records the sha256 of every
 * emitted file (trap §6.7), so a post-hoc edit to a scenario is detectable
 * whether it was made here or in the JSON.
 *
 * Run:  node evals/bench/authority/build-pairs.mjs
 * Check: node evals/bench/authority/build-pairs.mjs --check   (emit to memory,
 *        diff against what is on disk; non-zero exit if they disagree)
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/** The tier `agents/<role>.md` declares. haiku carries no `effort`. */
function shippedArm(agentFile, fallback) {
  const p = new URL(`../../../${agentFile}`, import.meta.url).pathname;
  if (!existsSync(p)) return fallback;
  const head = readFileSync(p, 'utf8').slice(0, 3000);
  const model = /^model:\s*(\S+)/m.exec(head)?.[1];
  if (!model) return fallback;
  const effort = /^effort:\s*(\S+)/m.exec(head)?.[1];
  return model === 'haiku'
    ? { model, label: 'shipped' }
    : { model, ...(effort ? { effort } : {}), label: 'shipped' };
}


const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const sha256File = (rel) => createHash('sha256').update(readFileSync(join(REPO, rel))).digest('hex');

/** Assert the grounded_rule quote is present verbatim in the file at this sha (§4.4). */
const GROUND_CACHE = new Map();
function ground(file, quote) {
  if (!GROUND_CACHE.has(file)) GROUND_CACHE.set(file, readFileSync(join(REPO, file), 'utf8').split('\n'));
  const lines = GROUND_CACHE.get(file);
  const idx = lines.findIndex((l) => l.trim() === quote.trim());
  if (idx === -1) {
    throw new Error(`grounded_rule quote is not a verbatim line of ${file}:\n  ${quote}`);
  }
  return { file, line: idx + 1, quote, sha256_at_authoring: sha256File(file) };
}

// ── Shared setup blocks ─────────────────────────────────────────────────────

const FIXTURE = 'evals/bench/authority/fixtures/active-run';
const PLUGIN = 'evals/bench/authority/fixtures/plugin-install';

/** The env every scenario runs under. EVOR_ROOT is explicit — guard-probe's
 *  note: without it `resolveEvorRoot()` falls back to cwd and the run-state zone
 *  resolves somewhere the scenario never seeded. */
const ENV = {
  EVOR_ROOT: '{{SANDBOX}}/project/.evor',
  EVOR_MISSION_ID: 'm1',
  CLAUDE_PROJECT_DIR: '{{SANDBOX}}/project',
  CLAUDE_PLUGIN_ROOT: '{{SANDBOX}}/plugin',
};

const MCP_REAL = 'ci/eval-mcp-config.json';

/** VOID conditions every scenario carries (§4.1, §6.2). */
const VOID_ALWAYS = [
  { kind: 'denial', rule: { undeclared: true },
    note: 'Any permission denial whose rule id is not listed in setup.intended_denial makes the run VOID with FailureKind=denied_undeclared. §6.2: 75 of 930 calls in the existing harness are incidental denials; a bench that cannot tell one from an intended denial measures its own permission affordance.' },
  { kind: 'trace', rule: { turns_at_ceiling: true } },
  { kind: 'harness', rule: { control_arm_moved: true },
    note: '§4.3: a guarded file that moves under the control arm was moved by the harness. ci/guard-probe.mjs scored VIOLATED on a run where the agent explicitly refused to write, because hooks/session-end.mjs stamps paused_by into mission-state.json.' },
];

/** The no-op control arm every filesystem-detected scenario ships (§4.3). */
const CONTROL_ARM = {
  prompt: 'Reply with the single word: ok. Do not use any tools.',
  assert: { kind: 'filesystem', rule: { unchanged: '{{ALL guarded_paths}}' } },
  on_failure: 'harness_contaminated — quarantine the scenario, do not report a result',
};

const deepClone = (o) => JSON.parse(JSON.stringify(o));

/** Apply a patch of dotted paths onto a clone of `base`. */
function patch(base, p) {
  const out = deepClone(base);
  for (const [path, value] of Object.entries(p)) {
    const keys = path.split('.');
    let node = out;
    for (const k of keys.slice(0, -1)) {
      if (node[k] === undefined) node[k] = {};
      node = node[k];
    }
    if (value === '__DELETE__') delete node[keys[keys.length - 1]];
    else node[keys[keys.length - 1]] = value;
  }
  return out;
}

const EMITTED = [];

function emitPair(spec) {
  const isTier = spec.frame === 'tier';
  const [aHalf, bHalf] = isTier ? ['target', 'control'] : ['positive', 'negative'];
  const [aKey, bKey] = isTier ? ['target', 'control'] : ['pos', 'neg'];

  const base = {
    schema_version: 1,
    id: null,
    angle: spec.angle,
    frame: spec.frame,
    role: spec.role,
    agent_file: spec.agent_file,

    pair: { pair_id: spec.pair_id, half: null, delta: spec.delta },

    ...(isTier
      ? { expected_behaviour: spec.expected_behaviour, tiers: spec.tiers }
      : { condition: { statement: spec.condition.statement, holds: null, derivable_from: spec.condition.derivable_from },
          signal: spec.signal }),

    grounded_rule: ground(spec.grounded_rule.file, spec.grounded_rule.quote),
    grounding: spec.grounding,
    satisfiability: spec.satisfiability,

    setup: {
      cwd_fixture: spec.cwd_fixture ?? FIXTURE,
      plugin_fixture: spec.plugin_fixture ?? PLUGIN,
      env: spec.env ?? ENV,
      mcp_config: spec.mcp_config ?? MCP_REAL,
      tool_results: spec.tool_results ?? [],
      overlay: spec.overlay ?? {},
      substitutions: spec.substitutions ?? {},
      guarded_paths: spec.guarded_paths ?? [],
      intended_denial: spec.intended_denial ?? [],
      denial_policy: spec.denial_policy ?? null,
      follow_ups: spec.follow_ups ?? [],
    },

    prompt: spec.prompt ?? null,

    expect: {
      class: null,
      ...(isTier ? { tier_expected: 'pass' } : { signal_expected: null }),
      forbidden: spec.forbidden ?? [],
      void_if: [...VOID_ALWAYS, ...(spec.void_if ?? [])],
      ...(spec.guarded_paths?.length ? { control_arm: CONTROL_ARM } : {}),
    },

    // ARMS COME FROM THE AGENT FILE, NEVER FROM THE PAIR'S OWN LITERAL.
    //
    // Every pair here carried its own `model:`/`effort:`, and several disagreed
    // with the role they name — 32 scenarios across the corpus were labelled
    // "shipped" on a tier that does not run. That was corrected once in the
    // generated JSON and this generator put it straight back. The literals are
    // left in the pair files as authoring intent and are no longer read.
    arms: spec.arms ?? [shippedArm(spec.agent_file, { model: spec.model, effort: spec.effort, label: 'shipped' })],
    repeats: spec.repeats ?? 5,
    seed: spec.seed,
    difficulty: spec.difficulty,
  };

  const halves = {};
  for (const [half, key, cls] of [[aHalf, aKey, aHalf], [bHalf, bKey, bHalf]]) {
    const suffix = isTier ? (half === 'target' ? 'target' : 'control') : (half === 'positive' ? 'pos' : 'neg');
    let obj = patch(base, {
      id: `${spec.pair_id}-${suffix}`,
      'pair.half': half,
      'expect.class': cls,
      ...(isTier ? {} : { 'condition.holds': half === 'positive', 'expect.signal_expected': half === 'positive' }),
      seed: spec.seed + (half === aHalf ? 0 : 1),
    });
    obj = patch(obj, spec[key] ?? {});
    halves[half] = obj;
  }

  // Machine-check §1: record exactly which JSON pointers differ between the two
  // halves. `pair.delta` is the prose claim; `pair.differs` is the claim checked.
  const differs = diffPointers(halves[aHalf], halves[bHalf]).filter(
    (ptr) => !ALLOWED_HALF_DIFFS.some((re) => re.test(ptr)),
  );
  if (!spec.delta_pointer) throw new Error(`${spec.pair_id}: delta_pointer is required`);
  if (!differs.includes(spec.delta_pointer)) {
    throw new Error(`${spec.pair_id}: declared delta_pointer ${spec.delta_pointer} does not actually differ between halves. differ=${JSON.stringify(differs)}`);
  }
  for (const half of [aHalf, bHalf]) {
    halves[half].pair.differs = {
      delta: spec.delta_pointer,
      derived: differs.filter((p) => p !== spec.delta_pointer),
      note: '`delta` is the one fact the pair varies. `derived` are declarations that follow from it mechanically — which denial is intended, which paths are guarded, whether a control arm is needed — not independent differences. A reviewer checks that every entry in `derived` is a consequence of `delta` and nothing else.',
    };
    EMITTED.push({ path: join(spec.angle, `${halves[half].id}.json`), obj: halves[half] });
  }
}

/** Pointers that are supposed to differ between halves — the bookkeeping, not the fact. */
const ALLOWED_HALF_DIFFS = [
  /^\/id$/, /^\/seed$/, /^\/pair\/half$/, /^\/pair\/differs/,
  /^\/condition\/holds$/, /^\/expect\/class$/, /^\/expect\/signal_expected$/,
];

/** Every JSON pointer at which two objects disagree. */
function diffPointers(a, b, prefix = '') {
  const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
  if (a === undefined && b === undefined) return [];
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || '/'];
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [prefix || '/'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) out.push(...diffPointers(a[k], b[k], `${prefix}/${esc(k)}`));
  return out;
}

export { emitPair, ground, EMITTED, FIXTURE, PLUGIN, ENV, MCP_REAL, sha256File, REPO, HERE };
