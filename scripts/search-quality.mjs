#!/usr/bin/env node
/**
 * scripts/search-quality.mjs — measure whether the SEARCH is any good.
 *
 *   node scripts/search-quality.mjs <run-dir> [--json]
 *
 * Every metric this repo had measured cost: $/tick, context growth, cache-read
 * ratio, denial counts. None of them say whether the evolution is working. The
 * only quality number the system produced was `best_score`, and a run where two
 * of three ticks found nothing reported identically to one where they all did.
 *
 * The agents that decide the evolution are Mutagen (what to try), Sage (what is
 * known), and Selector (what is worth a training run). Forge implements what has
 * already been decided — it dominates cost and decides nothing. Optimising it is
 * a cost activity, not a quality one.
 *
 * WHAT THIS CANNOT TELL YOU, stated up front:
 *
 *  - Selector's approvals are scoreable; its REJECTIONS are not. A rejected
 *    proposal is never run, so its counterfactual fitness does not exist. Every
 *    approval-quality number below is precision on the approved set only, with no
 *    recall term. Fixing that needs deliberate control approvals — occasionally
 *    running a rejected proposal to observe what was thrown away.
 *
 *  - Novelty here is STRUCTURAL (family / tier / locus / wildness), not semantic.
 *    It answers "is the search re-treading the same ground", not "has anyone in
 *    the literature had this idea". The latter needs an embedding of the proposal
 *    against the citation corpus, which is a bigger build.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const runDir = process.argv[2];
const asJson = process.argv.includes('--json');
if (!runDir || !existsSync(runDir)) {
  console.error('usage: node scripts/search-quality.mjs <run-dir> [--json]');
  process.exit(2);
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const ticksDir = join(runDir, 'ticks');
const ticks = existsSync(ticksDir)
  ? readdirSync(ticksDir).filter((t) => /^\d+$/.test(t)).sort((a, b) => Number(a) - Number(b))
  : [];

const tree = readJson(join(runDir, 'tree.json'))?.nodes ?? {};
const runState = readJson(join(runDir, 'run-state.json')) ?? {};

/**
 * Fitness for a node.
 *
 * NOT from tree.json — every node there carries `metrics: {}` and `visit_count: 0`
 * even after a successful, integrity-passed evaluation. The real numbers live in
 * nodes/<id>/results.json. The tree that drives selection therefore has no scores
 * in it at all, which is reported separately below because it is a defect, not a
 * storage detail.
 */
function fitnessOf(id) {
  const r = readJson(join(runDir, 'nodes', id, 'results.json'));
  if (typeof r?.fitness_value === 'number') return r.fitness_value;
  for (const k of ['accuracy', 'score']) {
    if (typeof r?.metrics?.[k] === 'number') return r.metrics[k];
  }
  return null;
}

/** Tick a node belongs to, inferred from which tick's artifacts name it. */
function tickOfNode(id, name) {
  for (const t of ticks) {
    const blob = JSON.stringify(readJson(join(ticksDir, t, 'forge', 'forge-report.json')) ?? {});
    if (blob.includes(id) || (name && blob.includes(name))) return Number(t);
  }
  return null;
}

const perTick = [];
const seenCombos = new Set();
const seenLoci = new Set();

for (const t of ticks) {
  const d = (a, f) => readJson(join(ticksDir, t, a, f));
  const proposals = d('mutagen', 'proposals.json');
  const verdict = d('selector', 'verdict.json');
  const sage = d('sage', 'findings.json');
  const probe = d('probe', 'findings.json');

  const props = proposals?.proposals ?? [];
  const families = new Set(props.map((p) => p.approach_family).filter(Boolean));
  const tiers = new Set(props.map((p) => p.mutation_tier).filter(Boolean));

  // Structural novelty: has this (family, tier) pair or this file locus been
  // touched before in this run? Re-treading is the premature-convergence signal
  // Mutagen exists to prevent.
  let novelCombos = 0, novelLoci = 0;
  for (const p of props) {
    const combo = `${p.approach_family}/${p.mutation_tier}`;
    const locus = p.mutation_locus?.path ?? p.mutation_locus?.family ?? '';
    if (combo && !seenCombos.has(combo)) { novelCombos++; seenCombos.add(combo); }
    if (locus && !seenLoci.has(locus)) { novelLoci++; seenLoci.add(locus); }
  }

  const reviews = verdict?.reviews ?? [];
  const approved = reviews.filter((r) => r.critic_review?.verdict === 'approved');
  const rejectedGates = {};
  for (const r of reviews) {
    const cr = r.critic_review ?? {};
    if (cr.verdict === 'approved') continue;
    for (const [gate, res] of Object.entries(cr)) {
      if (res === 'fail') rejectedGates[gate] = (rejectedGates[gate] ?? 0) + 1;
    }
  }

  // Sage: absence is itself a finding. A tick that ran without grounding tells
  // you the gate is skippable in practice, whatever the prose says.
  const sageFindings = Array.isArray(sage) ? sage : (sage?.findings ?? []);
  // A4: an angle Sage chose itself carries investigation_query_ref: null. This is
  // the only channel by which a concept Mutagen did not already suspect can enter
  // the system — Sage is otherwise purely reactive and can only ever deepen the
  // hypothesis space Mutagen arrived with.
  const proactive = sageFindings.filter((f) => f && 'investigation_query_ref' in f
    ? f.investigation_query_ref === null : false).length;
  const queries = props.flatMap((p) => p.investigation_queries ?? []);
  const disconfirming = sageFindings.filter((f) => {
    const s = JSON.stringify(f).toLowerCase();
    return /no evidence|not found|contradict|refut|fail|negative|limitation|does not/.test(s);
  }).length;

  perTick.push({
    tick: Number(t),
    proposals: props.length,
    families: [...families],
    tiers: [...tiers],
    wildness: proposals?.wildness_used ?? null,
    crossover: proposals?.crossover_triggered ?? null,
    novel_family_tier_combos: novelCombos,
    novel_loci: novelLoci,
    reviewed: reviews.length,
    approved: approved.length,
    rejection_gates: rejectedGates,
    sage_present: Boolean(sage),
    sage_findings: sageFindings.length,
    sage_queries_asked: queries.length,
    sage_disconfirming: disconfirming,
    sage_proactive_findings: proactive,
    probe_present: Boolean(probe),
  });
}

// ── Outcome trajectory: did the search actually move? ────────────────────────
const nodes = Object.entries(tree).map(([id, n]) => ({ id, name: n.name, tick: n.tick ?? tickOfNode(id, n.name), fitness: fitnessOf(id), integrity: n.integrity_status, family: n.approach_family, tree_metrics_empty: !n.metrics || Object.keys(n.metrics).length === 0 }));
const scored = nodes.filter((n) => typeof n.fitness === 'number');
let best = -Infinity;
const trajectory = [];
for (const t of ticks.map(Number)) {
  const tickNodes = scored.filter((n) => n.tick === t);
  const tickBest = tickNodes.length ? Math.max(...tickNodes.map((n) => n.fitness)) : null;
  const improved = tickBest !== null && tickBest > best;
  if (improved) best = tickBest;
  trajectory.push({ tick: t, nodes: tickNodes.length, tick_best: tickBest, running_best: best === -Infinity ? null : best, improved });
}
const improvingTicks = trajectory.filter((x) => x.improved).length;

const summary = {
  run_id: runState.run_id ?? null,
  ticks: ticks.length,
  nodes_total: nodes.length,
  nodes_scored: scored.length,
  nodes_integrity_passed: nodes.filter((n) => n.integrity === 'passed').length,
  best_score: runState.best_score ?? null,
  improving_ticks: improvingTicks,
  improving_tick_ratio: ticks.length ? improvingTicks / ticks.length : null,
  distinct_families_explored: new Set(perTick.flatMap((t) => t.families)).size,
  total_proposals: perTick.reduce((a, t) => a + t.proposals, 0),
  approval_rate: (() => {
    const r = perTick.reduce((a, t) => a + t.reviewed, 0);
    const a2 = perTick.reduce((a, t) => a + t.approved, 0);
    return r ? a2 / r : null;
  })(),
  ticks_without_sage: perTick.filter((t) => !t.sage_present).length,
  nodes_with_empty_tree_metrics: nodes.filter((n) => n.tree_metrics_empty).length,
  sage_proactive_total: perTick.reduce((a, t) => a + t.sage_proactive_findings, 0),
  distinct_fitness_values: [...new Set(scored.map((n) => n.fitness))].sort((a, b) => a - b),
};

if (asJson) {
  console.log(JSON.stringify({ summary, per_tick: perTick, trajectory }, null, 2));
  process.exit(0);
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
console.log('='.repeat(74));
console.log(`SEARCH QUALITY — ${summary.run_id ?? runDir}`);
console.log('='.repeat(74));
console.log(`ticks ${summary.ticks} · proposals ${summary.total_proposals} · nodes ${summary.nodes_total} ` +
            `(scored ${summary.nodes_scored}, integrity-passed ${summary.nodes_integrity_passed})`);
console.log(`best_score ${summary.best_score} · families explored ${summary.distinct_families_explored} · approval rate ${pct(summary.approval_rate)}`);
console.log(`\nIMPROVING TICKS  ${summary.improving_ticks}/${summary.ticks}  (${pct(summary.improving_tick_ratio)})` +
            `${summary.improving_tick_ratio !== null && summary.improving_tick_ratio < 0.5 ? '   <-- the search is mostly not finding anything' : ''}`);
if (summary.sage_proactive_total === 0 && summary.ticks > 1) {
  console.log('SAGE PROACTIVE FINDINGS 0 — every answer stayed inside the question set');
  console.log('  Mutagen already had. Nothing new can enter the hypothesis space this way.');
}
if (summary.ticks_without_sage) {
  console.log(`SAGE ABSENT in ${summary.ticks_without_sage} tick(s) — grounding gate was skipped, not enforced`);
}

console.log('\nper tick:');
console.log('tick'.padStart(4) + 'props'.padStart(6) + 'appr'.padStart(5) + 'wild'.padStart(6) +
            'newCombo'.padStart(9) + 'newLocus'.padStart(9) + 'sage'.padStart(6) + 'disconf'.padStart(8) + '  families');
for (const t of perTick) {
  console.log(
    `${String(t.tick).padStart(4)} ${String(t.proposals).padStart(5)} ${String(t.approved).padStart(4)} ` +
    `${String(t.wildness ?? '-').padStart(5)} ${String(t.novel_family_tier_combos).padStart(8)} ${String(t.novel_loci).padStart(8)} ` +
    `${String(t.sage_present ? t.sage_findings : 'MISS').padStart(5)} ${String(t.sage_disconfirming).padStart(7)}  ${t.families.join(',')}`
  );
}

console.log('\ntrajectory:');
for (const x of trajectory) {
  console.log(`  tick ${x.tick}: nodes ${x.nodes} · best ${x.tick_best ?? '-'} · running ${x.running_best ?? '-'}` +
              `${x.improved ? '  IMPROVED' : '  (no gain)'}`);
}

const gates = {};
for (const t of perTick) for (const [g, n] of Object.entries(t.rejection_gates)) gates[g] = (gates[g] ?? 0) + n;
if (Object.keys(gates).length) {
  console.log('\nrejections by gate:');
  for (const [g, n] of Object.entries(gates).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${g}`);
} else {
  console.log('\nrejections by gate: none — Selector approved everything it saw.');
}

console.log('\nNOT MEASURED: rejected proposals are never run, so approval quality has no');
console.log('recall term. Semantic novelty vs the literature is not computed — only');
console.log('structural re-tread within this run.');
