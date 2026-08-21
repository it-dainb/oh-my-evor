/**
 * ci/eval-core.mjs — the config-driven core shared by every per-role agent eval.
 *
 * Why this exists. `ci/agent-eval.mjs` (selector) and `ci/forge-gate-eval.mjs`
 * (forge's capability gate) are two hand-written harnesses whose runOneCall,
 * runMatrix, tierName, DEFAULT_TIERS and CLI-flag plumbing are near-identical
 * copies. Seven more roles need benchmarking. Copying a third, fourth and fifth
 * time would multiply the one defect that has cost this session the most:
 * **grading a contract the agent was never given.**
 *
 * The countermeasure is structural, not diligence-based. `buildContractText()`
 * and `scoreByContract()` read the SAME `contract.fields` array:
 *
 *   - a field that is graded is necessarily stated in the prompt, because both
 *     come from one list;
 *   - a case that states an expectation for a path NOT in that list throws,
 *     rather than quietly grading an unstated rule.
 *
 * So the drift that has to be caught by review in the bespoke harnesses cannot
 * be expressed here. That is the whole point of the module.
 *
 * Nothing in this file calls the network. The live CLI path lives in the
 * closure returned by makeRunOneCall(), which the test suite never invokes.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Path access — the forge reviewers nest their answers under `checks.*` and
// `risk_assessment.*`, so a flat field name is not enough.
// ─────────────────────────────────────────────────────────────────────────────

/** "proposals[].mutation_tier" -> "proposals" (the array to iterate). */
export const arrayRoot = (path) => String(path).split('[]')[0];
/** "proposals[].mutation_tier" -> "mutation_tier" (the field on each element). */
export const arrayInner = (path) => String(path).split('[].')[1] ?? '';

export function getPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

// ─────────────────────────────────────────────────────────────────────────────
// Contract text — what the agent is told to emit.
// ─────────────────────────────────────────────────────────────────────────────

/** The right-hand side of one contract line: the vocabulary for this field. */
function fieldSpecText(f) {
  if (f.doc) return f.doc;
  switch (f.kind) {
    case 'enum':
      return f.values.join(' | ');
    case 'bool':
      return 'true | false';
    case 'int':
      return '<integer>';
    case 'number':
      return '<number>';
    case 'set':
      return '<comma-separated tokens, or "none">';
    case 'present':
      return '<the object, or null if none>';
    case 'count':
      return '<list>';
    case 'every':
      return '<list of objects>';
    case 'int_or_word':
      return `<integer, or "${f.word}">`;
    default:
      throw new Error(`unknown field kind: ${f.kind}`);
  }
}

/**
 * The block pasted verbatim into the prompt. Also the only source of gradable
 * paths — see scoreByContract, which rejects any expectation outside it.
 */
export function buildContractText(contract) {
  // A per-element rule is a constraint on a list, not a key of its own. Emitting
  // "proposals[].mutation_tier" as a JSON key would ask the agent for a field
  // that does not exist in its own output format.
  const keyed = contract.fields.filter((f) => f.kind !== 'every');
  const perElement = contract.fields.filter((f) => f.kind === 'every');

  const constraints = perElement.map(
    (f) => `- every entry of \`${arrayRoot(f.path)}\` must set \`${arrayInner(f.path)}\` to one of: ${(f.values ?? []).join(' | ')}`,
  );

  if (contract.mode === 'json') {
    // A dotted path describes NESTING, not a key with a dot in it. Rendering it
    // flat made the first live agent emit "eda_summary.telemetry_sane" as a
    // literal key — obeying the prompt exactly — while the scorer read the
    // nested path and saw nothing.
    const tree = {};
    for (const f of keyed) {
      const parts = f.path.split('.');
      let node = tree;
      for (const p of parts.slice(0, -1)) node = node[p] ??= {};
      node[parts[parts.length - 1]] = jsonSkeletonValue(f);
    }
    const render = (node, indent) => {
      const pad = ' '.repeat(indent);
      const lines = Object.entries(node).map(([k, v]) =>
        typeof v === 'object' && v !== null
          ? `${pad}"${k}": {\n${render(v, indent + 2)}\n${pad}}`
          : `${pad}"${k}": ${v}`,
      );
      return lines.join(',\n');
    };
    return [
      'Emit your answer as a single fenced JSON block shaped exactly like this',
      '(nested objects are nested, not dotted keys):',
      '',
      '```json',
      '{',
      render(tree, 2),
      '}',
      '```',
      ...(constraints.length ? ['', 'Constraints on the list entries:', ...constraints] : []),
    ].join('\n');
  }
  return [
    `## ${contract.heading}`,
    ...keyed.map((f) => `- ${f.path}: ${fieldSpecText(f)}`),
    ...constraints,
  ].join('\n');
}

function jsonSkeletonValue(f) {
  switch (f.kind) {
    case 'enum':
      return `"${f.values.join(' | ')}"`;
    case 'bool':
      return 'true | false';
    case 'int':
      return '<integer>';
    case 'number':
      return '<number>';
    case 'set':
      return '["<token>", ...]';
    case 'present':
      return '{ ... } | null';
    case 'count':
      return '[ ... ]';
    case 'every':
      return '[ { ... }, ... ]';
    case 'int_or_word':
      return `<integer, or "${f.word}">`;
    default:
      throw new Error(`unknown field kind: ${f.kind}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Case keys that describe the benchmark rather than the scenario. None of these
 * may reach the agent: `expect` is the answer key, `note` is authoring
 * commentary that usually names the giveaway outright, and `id`/`gate` are
 * bookkeeping that would hint at which rule is under test.
 */
export const RESERVED_CASE_KEYS = new Set(['id', 'gate', 'note', 'expect']);

export function buildRolePrompt(agentPromptBlock, contract, caseObj) {
  const payload = {};
  for (const [k, v] of Object.entries(caseObj)) {
    if (!RESERVED_CASE_KEYS.has(k)) payload[k] = v;
  }
  return [
    agentPromptBlock,
    '',
    '---',
    '',
    'The tool results you would normally fetch are inlined below. Treat them as',
    'authoritative and do not call any tool; reason from them directly.',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    buildContractText(contract),
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing the agent's answer.
// ─────────────────────────────────────────────────────────────────────────────

function parseJsonOutput(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const brace = text.indexOf('{');
  if (brace !== -1) candidates.push(text.slice(brace));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v;
    } catch {
      // Trailing prose after the closing brace is common; retry on the balanced
      // prefix before giving up on this candidate.
      const end = c.lastIndexOf('}');
      if (end > 0) {
        try {
          const v = JSON.parse(c.slice(0, end + 1));
          if (v && typeof v === 'object') return v;
        } catch { /* fall through to the next candidate */ }
      }
    }
  }
  return null;
}

/**
 * Section mode is bounded on both ends. The unbounded version of this was a
 * real bug: forge's report template carries a later "Team Execution" section
 * whose bullets also start with "- " and one of which reads
 * "Architect verdict: approved | rejected | abort" — enough to be read as the
 * gate's own decision.
 */
function parseSectionOutput(text, contract) {
  const headingRe = new RegExp(
    `^[ \\t]*#{1,6}[ \\t]*\\**[ \\t]*${contract.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*$`,
    'im',
  );
  const m = headingRe.exec(text);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.search(/^[ \t]*#{1,6}[ \t]+\S/m);
  const body = next === -1 ? after : after.slice(0, next);

  const out = {};
  for (const f of contract.fields) {
    const re = new RegExp(`^[ \\t]*[-*][ \\t]*\\**[ \\t]*${f.path}\\**[ \\t]*:[ \\t]*(.+)$`, 'im');
    const hit = re.exec(body);
    if (hit) out[f.path] = hit[1].trim().replace(/\*+$/, '').trim();
  }
  return Object.keys(out).length ? out : null;
}

export function parseContractOutput(text, contract) {
  const s = String(text ?? '');
  return contract.mode === 'json' ? parseJsonOutput(s) : parseSectionOutput(s, contract);
}

// ─────────────────────────────────────────────────────────────────────────────
// Grading one field.
// ─────────────────────────────────────────────────────────────────────────────

const strip = (v) => String(v ?? '').replace(/[*`_]/g, '').trim();

function normEnum(f, raw) {
  const s = strip(raw).toLowerCase();
  // `values` is precedence-ordered. It matters only when an answer mentions
  // more than one legal value in prose ("we cannot proceed, abort"); the
  // earlier-declared value wins, so contracts list the conservative answer
  // first. In JSON mode a field almost always holds exactly one token.
  const present = f.values.filter((v) => new RegExp(`\\b${v}\\b`, 'i').test(s));
  if (present.length) return present[0];
  return s;
}

export function gradeField(f, expected, actual, opts = {}) {
  const mk = (correct) => ({ name: f.path, expected, actual: actual ?? null, correct });

  // `present` asks whether the field was filled in at all, so it must be graded
  // before the missing-answer guard that every other kind depends on.
  if (f.kind === 'present') return mk((actual !== undefined && actual !== null) === Boolean(expected));

  // `count` and `every` are about the shape of a list, so they must be graded
  // before the scalar missing-answer guard below.
  if (f.kind === 'count') {
    if (!Array.isArray(actual)) return mk(false);
    const n = actual.length;
    if (expected && typeof expected === 'object') {
      const { min = -Infinity, max = Infinity } = expected;
      return mk(n >= min && n <= max);
    }
    return mk(n === Number(expected));
  }

  if (f.kind === 'every') {
    // An empty list must not pass vacuously: an agent that returned nothing has
    // not demonstrated obedience to a rule, it has declined to answer.
    if (!Array.isArray(actual) || actual.length === 0) return mk(false);
    const innerPath = arrayInner(f.path);
    const inner = { ...f, kind: f.innerKind ?? 'enum', path: innerPath };
    const ok = actual.every((el) => {
      const v = getPath(el, innerPath);
      return f.innerKind
        ? gradeField(inner, expected, v).correct
        : String(strip(v)).toLowerCase() === String(expected).toLowerCase();
    });
    return mk(ok);
  }

  if (actual === undefined || actual === null || strip(actual) === '') return mk(false);

  switch (f.kind) {
    case 'enum':
      return mk(normEnum(f, actual) === String(expected).toLowerCase());

    case 'bool': {
      const s = strip(actual).toLowerCase();
      if (s !== 'true' && s !== 'false') return mk(false);
      return mk((s === 'true') === Boolean(expected));
    }

    case 'int': {
      const s = strip(actual);
      return mk(/^-?\d+$/.test(s) && Number(s) === Number(expected));
    }

    case 'number': {
      const n = Number(strip(actual));
      if (!Number.isFinite(n)) return mk(false);
      const tol = typeof f.tol === 'number' ? f.tol : 0;
      return mk(Math.abs(n - Number(expected)) <= tol);
    }

    case 'set': {
      const norm = (v) => {
        const items = Array.isArray(v) ? v : String(v ?? '').split(',');
        return new Set(
          items
            .map((x) => strip(x).toLowerCase())
            .filter((x) => x && x !== 'none'),
        );
      };
      const a = norm(expected);
      const b = norm(actual);
      return mk(a.size === b.size && [...a].every((x) => b.has(x)));
    }

    case 'int_or_word': {
      const s = strip(actual);
      const asInt = /^-?\d+$/.test(s) ? Number(s) : null;
      if (String(expected).toLowerCase() === String(f.word).toLowerCase()) {
        // The sentinel and re-stating the input value are the same answer
        // spelled two ways; both mean nothing was substituted.
        const restated = opts.restated;
        return mk(
          new RegExp(`^${f.word}$`, 'i').test(s) ||
            (restated !== undefined && asInt !== null && asInt === Number(restated)),
        );
      }
      return mk(asInt !== null && asInt === Number(expected));
    }

    default:
      throw new Error(`unknown field kind: ${f.kind}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grading one case.
// ─────────────────────────────────────────────────────────────────────────────

export function scoreByContract(contract, caseObj, parsed) {
  const byPath = new Map(contract.fields.map((f) => [f.path, f]));

  // A typo in a case file must fail loudly. Silently skipping an unknown path
  // would mean a case that appears to test a rule and tests nothing.
  for (const path of Object.keys(caseObj.expect ?? {})) {
    if (!byPath.has(path)) {
      throw new Error(
        `case "${caseObj.id}" expects field "${path}", which the contract does not state. ` +
          `Gradable fields: ${[...byPath.keys()].join(', ')}`,
      );
    }
  }

  if (!parsed) {
    return { status: 'unparseable', checks: [], reason: 'no parseable answer in the agent output' };
  }

  const checks = [];
  for (const [path, expected] of Object.entries(caseObj.expect ?? {})) {
    const f = byPath.get(path);
    if (f.gradeWhen) {
      // e.g. batch_size is only meaningful when the decision was `proceed`;
      // on an abort it describes a spawn that will never happen.
      const gateExpected = caseObj.expect?.[f.gradeWhen.path];
      if (String(gateExpected).toLowerCase() !== String(f.gradeWhen.equals).toLowerCase()) continue;
    }
    const opts = f.restatedFrom ? { restated: getPath(caseObj, f.restatedFrom) } : {};
    const actual = f.kind === 'every' ? getPath(parsed, arrayRoot(path)) : getPath(parsed, path);
    checks.push(gradeField(f, expected, actual, opts));
  }

  const failed = checks.filter((c) => !c.correct);
  return {
    status: failed.length === 0 ? 'correct' : 'incorrect',
    checks,
    reason: failed.length
      ? failed.map((c) => `${c.name}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`).join('; ')
      : null,
  };
}
