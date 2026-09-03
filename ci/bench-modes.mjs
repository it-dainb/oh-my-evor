/**
 * ci/bench-modes.mjs — lite / normal / hard, as nested subsets.
 *
 *   node ci/bench-modes.mjs --mode lite [--json]
 *
 * WHY RANK WITHIN AN ANGLE RATHER THAN SELECT BY DIFFICULTY LABEL.
 *
 * The corpus carries `difficulty` (low 32, medium 90, high 48) but it is not
 * spread evenly: A2 and E4 are ALL high, A1 and A3 have no high at all. Eight
 * angles have no `low` scenario and eight have no `high`. Selecting by label
 * would drop A2, A4, E3, E4, L3, L5, T4 and T5 out of lite entirely — and the
 * requirement is that every mode covers every angle, because an angle absent
 * from the dev loop is an angle nobody is watching between releases.
 *
 * So each angle ranks its own pairs (low < medium < high, then by id for
 * determinism) and each mode takes a prefix. Every angle appears in every mode
 * at its own easiest end.
 *
 * THE MODES NEST: lite ⊂ normal ⊂ hard. A scenario that passes in lite is still
 * present in normal, so a promotion cannot silently drop the evidence that
 * justified it.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = join(REPO, 'evals', 'bench');
const RANK = { low: 0, medium: 1, high: 2 };

/** Pairs-per-angle taken by each mode, and repeats. */
export const MODES = {
  // Dev loop. One pair per angle: every angle watched, cheapest possible.
  lite:   { pairs: 1, repeats: 1 },
  // Pre-merge. The pilot measured 17 of 24 scenarios scoring identically on all
  // eight repeats, so 2 is not a compromise — it is the measured plateau.
  normal: { pairs: 3, repeats: 2 },
  // Pre-release. Everything, including each angle's hardest.
  hard:   { pairs: Infinity, repeats: 2 },
};

export function loadPairs() {
  const byAngle = new Map();
  for (const group of readdirSync(BENCH, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const gdir = join(BENCH, group.name);
    for (const angle of readdirSync(gdir, { withFileTypes: true })) {
      if (!angle.isDirectory() || !/^[A-Z]\d$/.test(angle.name)) continue;
      const adir = join(gdir, angle.name);
      const pairs = new Map();
      for (const f of readdirSync(adir)) {
        if (!f.endsWith('.json')) continue;
        const sc = JSON.parse(readFileSync(join(adir, f), 'utf8'));
        // `pair` is the authored link between halves; fall back to the filename
        // stem so a scenario missing it is still grouped rather than dropped.
        // `pair` is an object: { pair_id, half, delta }. The id is the link
        // between halves and `delta` states the one fact that differs — the
        // structure §1 makes the atomic deliverable.
        const key = sc.pair?.pair_id ?? f.replace(/-(pos|neg|target|control)\.json$/, '');
        if (!pairs.has(key)) pairs.set(key, { key, angle: angle.name, difficulty: sc.difficulty, files: [] });
        const p = pairs.get(key);
        p.files.push(join(adir, f));
        // A pair is as hard as its harder half.
        if (RANK[sc.difficulty] > RANK[p.difficulty]) p.difficulty = sc.difficulty;
      }
      byAngle.set(angle.name, [...pairs.values()].sort(
        (a, b) => (RANK[a.difficulty] ?? 1) - (RANK[b.difficulty] ?? 1) || a.key.localeCompare(b.key)));
    }
  }
  return byAngle;
}

export function selectMode(mode) {
  const cfg = MODES[mode];
  if (!cfg) throw new Error(`unknown mode ${mode}; known: ${Object.keys(MODES).join(', ')}`);
  const out = [];
  for (const [angle, pairs] of [...loadPairs()].sort()) {
    const take = pairs.slice(0, cfg.pairs === Infinity ? pairs.length : cfg.pairs);
    // EVERY ANGLE, ALWAYS. An angle with fewer pairs than the mode asks for
    // contributes what it has rather than being skipped.
    if (!take.length) throw new Error(`angle ${angle} has no pairs — it would be silently absent from ${mode}`);
    out.push(...take);
  }
  return { mode, ...cfg, pairs: out, scenarios: out.flatMap((p) => p.files) };
}

// GUARDED, and `indexOf` is checked. Unguarded, the CLI ran on every import —
// including `bench-run.mjs`'s own `await import('./bench-modes.mjs')`. And with
// no `--mode` on the line, `indexOf(...) + 1` is 0, so the mode became
// `process.argv[0]`: the path to the node binary, reported as an unknown mode.
const i = process.argv.indexOf('--mode');
const mode = i > -1 ? process.argv[i + 1] : 'lite';
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!IS_CLI) { /* imported for selectMode only */ } else {
const sel = selectMode(mode);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ mode: sel.mode, repeats: sel.repeats, scenarios: sel.scenarios }, null, 1));
} else if (process.argv.includes('--files')) {
  console.log(sel.scenarios.join('\n'));
} else {
  const runs = sel.scenarios.length * sel.repeats;
  console.log(`${sel.mode}: ${sel.pairs.length} pairs, ${sel.scenarios.length} scenarios, ${sel.repeats} repeat(s) = ${runs} runs, ~$${(runs * 0.197).toFixed(0)} at the pilot's measured $0.197/run`);
  const byAngle = {};
  for (const p of sel.pairs) (byAngle[p.angle] ??= []).push(p.difficulty);
  console.log(`angles covered: ${Object.keys(byAngle).length}/18`);
  for (const [a, d] of Object.entries(byAngle)) console.log(`   ${a}: ${d.length} pair(s) [${d.join(', ')}]`);
}
}
