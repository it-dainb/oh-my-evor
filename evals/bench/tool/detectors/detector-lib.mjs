/**
 * detector-lib.mjs — executable semantics for the §3.2 detector vocabulary,
 * plus the extensions Author A had to add to express T2 and T3. Every extension
 * is listed in AUTHORING-NOTE-A §Gaps; nothing here is silent.
 *
 * This exists so the fixtures in this directory are PROVEN rather than declared.
 * Trap 6.4 is not about having fixture files, it is about knowing the detector
 * fires on the real behaviour and stays silent on the near-miss, and that is only
 * knowable if something runs them. `run-fixtures.mjs` does.
 *
 * A trace is an ordered array of call records:
 *   { tool: string, args: object, denied?: boolean, phase?: number }
 * A filesystem state is { "<path>": "<sha256>" } before and after.
 */

import { matchesUnnegated } from '../../../../ci/autonomy-live.mjs';

// ── JSONPath subset ─────────────────────────────────────────────────────────
// $.a.b, $.a[*].b, $.a[0]. Resolves to an ARRAY of values (empty when absent),
// because [*] is genuinely multi-valued and collapsing it would hide that.
export function resolvePath(obj, path) {
  if (!path.startsWith('$')) throw new Error(`not a JSONPath: ${path}`);
  let cur = [obj];
  const tokens = path.slice(1).match(/\.[A-Za-z0-9_-]+|\[\*\]|\[\d+\]/g) ?? [];
  for (const tok of tokens) {
    const next = [];
    for (const v of cur) {
      if (v === undefined || v === null) continue;
      if (tok === '[*]') {
        if (Array.isArray(v)) next.push(...v);
      } else if (tok.startsWith('[')) {
        const i = Number(tok.slice(1, -1));
        if (Array.isArray(v) && i < v.length) next.push(v[i]);
      } else {
        const k = tok.slice(1);
        if (typeof v === 'object' && !Array.isArray(v) && k in v) next.push(v[k]);
      }
    }
    cur = next;
  }
  return cur;
}

function asText(v) {
  return (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
}

function globToRe(g) {
  return new RegExp('^' + g.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

/**
 * One expected value against one resolved value.
 *   null      -> the path resolves to nothing, or to null
 *   "?*"      -> a non-empty string
 *   "[]"      -> an empty array
 *   "a|b"     -> membership in a set (each alternative may itself be a glob)
 *   "!a|b"    -> non-membership
 *   "*x*"     -> glob over the value, objects serialised to JSON
 *   otherwise -> strict equality
 */
function valueMatches(expected, value) {
  if (expected === null || expected === undefined) return value === undefined || value === null;
  if (value === undefined) return false;
  if (expected === '?*') return typeof value === 'string' ? value.length > 0 : value !== null;
  if (expected === '[]') return Array.isArray(value) && value.length === 0;
  if (typeof expected === 'string' && expected.startsWith('!')) {
    return !valueMatches(expected.slice(1), value);
  }
  if (typeof expected === 'string' && expected.includes('|')) {
    return expected.split('|').some(alt => valueMatches(alt, value));
  }
  if (typeof expected === 'string' && expected.includes('*')) {
    return globToRe(expected).test(asText(value));
  }
  return value === expected;
}

const TYPE_OF = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;

// ── predicate matching ──────────────────────────────────────────────────────

/** Does this single call satisfy this predicate's shape (ignoring count/after)? */
export function callMatches(pred, call) {
  if (pred.tool !== '*' && pred.tool !== call.tool) return false;
  if (pred.denied !== undefined && Boolean(call.denied) !== Boolean(pred.denied)) return false;
  if (pred.denied === undefined && call.denied) return false; // a denied call did nothing
  if (pred.phase) {
    const p = call.phase ?? 0;
    if (pred.phase.min !== undefined && p < pred.phase.min) return false;
    if (pred.phase.max !== undefined && p > pred.phase.max) return false;
  }
  for (const [path, expected] of Object.entries(pred.arg ?? {})) {
    const vals = resolvePath(call.args ?? {}, path);
    if (expected === null) { if (vals.length && vals.some(v => v !== null)) return false; continue; }
    // [*] means EVERY resolved value must match, and at least one must exist.
    if (!vals.length) return false;
    if (!vals.every(v => valueMatches(expected, v))) return false;
  }
  // EXTENSION: arg_type. §3.2 can compare a value but cannot say "payload was a
  // string where the schema wants an object" — which is B-05's dominant shape and
  // therefore the primitive T2 is about. See AUTHORING-NOTE-A §Gaps.
  for (const [path, wanted] of Object.entries(pred.arg_type ?? {})) {
    const vals = resolvePath(call.args ?? {}, path);
    if (!vals.length) return false;
    if (!vals.every(v => TYPE_OF(v) === wanted)) return false;
  }
  return true;
}

function indices(pred, trace) {
  return trace.map((c, i) => callMatches(pred, c) ? i : -1).filter(i => i >= 0);
}

/** Full predicate satisfaction: shape + count + ordering. */
function predSatisfied(pred, trace, byId) {
  // EXTENSION: an element of any_of/all_of/none_of may itself be a rule, so an
  // author can say "(malformed A then corrected) OR (malformed B then
  // corrected)". A flat all_of would have demanded every malformed shape appear
  // at once, which no real transcript does. AUTHORING-NOTE-A §Gaps.
  if (pred.any_of || pred.all_of || pred.none_of) {
    return evaluate({ kind: 'trace', rule: pred }, { trace, anchors: Object.fromEntries(byId) });
  }
  let hits = indices(pred, trace);
  if (pred.after) {
    const anchor = byId.get(pred.after);
    if (!anchor) throw new Error(`predicate id '${pred.after}' referenced by \`after\` is not defined`);
    const first = indices(anchor, trace)[0];
    // The TC-14 fix: a call that happened BEFORE the failure is not recovery.
    hits = (first === undefined) ? [] : hits.filter(i => i > first);
  }
  const min = pred.count?.min ?? 1;
  const max = pred.count?.max ?? Infinity;
  return hits.length >= min && hits.length <= max;
}

function collectIds(rule, byId) {
  for (const preds of Object.values(rule)) {
    if (!Array.isArray(preds)) continue;
    for (const p of preds) {
      if (!p) continue;
      if (p.id) byId.set(p.id, p);
      if (p.any_of || p.all_of || p.none_of) collectIds(p, byId);
    }
  }
}

/**
 * Evaluate a detector rule.
 * ctx: { trace, before, after, text, anchors } — anchors supplies predicate ids
 * declared elsewhere in the scenario (e.g. setup.tool_results[].id), which is how
 * `after: "first-cite"` resolves.
 */
export function evaluate(detector, ctx) {
  const kind = detector.kind;
  const rule = detector.rule ?? detector;
  if (kind === 'filesystem') {
    const { before = {}, after = {} } = ctx;
    if (rule.unchanged) return rule.unchanged.every(p => before[p] !== undefined && before[p] === after[p]);
    if (rule.changed) return rule.changed.every(p => before[p] !== after[p]);
    throw new Error('filesystem rule needs `unchanged` or `changed`');
  }
  if (kind === 'text') {
    const text = ctx.text ?? '';
    if (rule.none_of_regex) return !rule.none_of_regex.some(r => new RegExp(r, 'i').test(text));
    const re = new RegExp(rule.regex, 'i');
    return rule.unnegated ? matchesUnnegated(text, re) : re.test(text);
  }
  // trace
  const trace = ctx.trace ?? [];
  if (rule.turns_at_ceiling !== undefined) return Boolean(ctx.turns_at_ceiling) === rule.turns_at_ceiling;
  const byId = new Map(Object.entries(ctx.anchors ?? {}));
  collectIds(rule, byId);
  if (rule.any_of) return rule.any_of.some(p => predSatisfied(p, trace, byId));
  if (rule.all_of) return rule.all_of.every(p => predSatisfied(p, trace, byId));
  // none_of ignores `count`: the question is whether the shape occurred at all.
  if (rule.none_of) return !rule.none_of.some(p => indices(p, trace).length > 0);
  throw new Error('trace rule needs any_of, all_of or none_of');
}
