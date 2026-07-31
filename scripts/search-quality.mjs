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


/**
 * Proposal distance, for C2.
 *
 * The first novelty metric counted distinct (family, tier) pairs and distinct file
 * loci. On real runs it pinned at 1.00 — every proposal touched a fresh locus — so
 * it was at ceiling and could not discriminate. Counting whether two things differ
 * says nothing about how much.
 *
 * This measures the `idea` text instead, as Jaccard distance over word shingles.
 * Crude, but it is a continuous quantity with a real ceiling, and it can tell "five
 * rewordings of one idea" from "five different ideas" — which is exactly the
 * silent-conservatism failure Mutagen's moonshot quota exists to prevent and does
 * not enforce.
 */
function shingles(text, n = 2) {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

function jaccardDistance(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? 1 - inter / union : 0;
}

/** Mean pairwise distance within a set; null when there are fewer than two. */
function meanPairwise(sets) {
  if (sets.length < 2) return null;
  let total = 0, n = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) { total += jaccardDistance(sets[i], sets[j]); n++; }
  }
  return n ? total / n : null;
}

const perTick = [];
const priorShingles = [];
const seenTags = new Set();
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

  // Selector's artifact has NO ENFORCED SCHEMA and drifts within a single run.
  // Observed across three consecutive ticks of one run:
  //   tick 1  reviews[]              -> critic_review.verdict
  //   tick 2  per_proposal_reviews[] -> verdict: "deferred"
  //   tick 3  reviews[]              -> critic_approved: true
  // Reading only the first shape reported "0 approved" for tick 2 and a confident
  // 0% selector precision. That is the third time in this work that a parser miss
  // has been indistinguishable from a finding about the search, so unparseable is
  // now tracked separately from zero and surfaced in the output.
  // C2 (real answer): novelty over DECLARED mechanisms. Both inferred proxies —
  // file locus and text similarity — sat at ceiling on real data, so the proposal
  // now declares its own technique_tags[] and novelty is measured over that space.
  // A proposal reusing only seen tags is a variation; one introducing an unseen tag
  // is exploration. This is the measure that makes the moonshot quota enforceable.
  const tagsPerProposal = props.map((p) =>
    (Array.isArray(p.technique_tags) ? p.technique_tags : []).map((t) => String(t).toLowerCase()));
  const tagged = tagsPerProposal.filter((t) => t.length).length;
  let newTags = 0, proposalsWithNewTag = 0;
  for (const tags of tagsPerProposal) {
    let introducedOne = false;
    for (const t of tags) {
      if (!seenTags.has(t)) { seenTags.add(t); newTags++; introducedOne = true; }
    }
    if (introducedOne) proposalsWithNewTag++;
  }

  // C2: continuous diversity, replacing the ceiling-pinned locus count.
  const ideaSets = props.map((p) => shingles(p.idea ?? p.hypothesis ?? ''));
  const intraTickDiversity = meanPairwise(ideaSets);
  const vsHistory = priorShingles.length && ideaSets.length
    ? ideaSets.reduce((a, s2) => a + Math.min(...priorShingles.map((h) => jaccardDistance(s2, h))), 0) / ideaSets.length
    : null;
  priorShingles.push(...ideaSets);

  const reviews = verdict?.reviews ?? verdict?.per_proposal_reviews ?? [];
  const verdictUnparsed = Boolean(verdict) && reviews.length === 0;

  const approvalOf = (r) => {
    const cr = r.critic_review ?? {};
    if (typeof r.critic_approved === 'boolean') return r.critic_approved;
    for (const v of [cr.verdict, r.verdict]) {
      if (typeof v === 'string') return v === 'approved';
    }
    if (typeof r.selected === 'boolean') return r.selected;
    if (typeof r.selected_for_forge === 'boolean') return r.selected_for_forge;
    return null; // shape not recognised — do NOT silently count as a rejection
  };

  const decisions = reviews.map(approvalOf);
  const approved = decisions.filter((d) => d === true).length;
  const undecidable = decisions.filter((d) => d === null).length;

  const rejectedGates = {};
  for (const r of reviews) {
    if (approvalOf(r) === true) continue;
    for (const [gate, res] of Object.entries({ ...(r.critic_review ?? {}), ...r })) {
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
    proposals_tagged: tagged,
    new_technique_tags: newTags,
    proposals_introducing_a_new_tag: proposalsWithNewTag,
    exploration_rate: props.length ? proposalsWithNewTag / props.length : null,
    intra_tick_diversity: intraTickDiversity,
    distance_from_history: vsHistory,
    novel_family_tier_combos: novelCombos,
    novel_loci: novelLoci,
    reviewed: reviews.length,
    approved,
    undecidable,
    verdict_unparsed: verdictUnparsed,
    schema_shape: verdict?.reviews ? 'reviews' : verdict?.per_proposal_reviews ? 'per_proposal_reviews' : 'none',
    rejection_gates: rejectedGates,
    sage_present: Boolean(sage),
    sage_findings: sageFindings.length,
    sage_queries_asked: queries.length,
    sage_disconfirming: disconfirming,
    sage_proactive_findings: proactive,
    // C3: Sage answered how much of what it was asked? One real run wrote
    // quorum_met:true over a findings set covering 1 of 6 queries.
    sage_coverage: queries.length ? Math.min(1, sageFindings.length / queries.length) : null,
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

// C1 — Selector calibration. Its verdicts are PREDICTIONS ("this is worth a
// training run") and the realized fitness is ground truth, so it is the one agent
// that can be scored against reality rather than against a rubric.
//
// Coarse by necessity: a proposal is linked to its outcome through the tick, not
// individually, because only the tick's forge-report names the node. And there is
// no recall term at all — see the censoring note at the bottom of the output.
const decided = perTick.filter((t) => t.reviewed > 0);
const withApproval = decided.filter((t) => t.approved > 0);
const approvedAndImproved = withApproval.filter((t) => trajectory.find((x) => x.tick === t.tick)?.improved).length;
const selectorPrecision = withApproval.length ? approvedAndImproved / withApproval.length : null;

// C2 — did wildness translate into actually-different proposals, or is the dial
// decorative? Compares Mutagen's declared wildness against the novel-loci rate it
// produced. A rising dial with a flat novelty rate is the silent-conservatism
// failure the moonshot prose exists to prevent and does not enforce.
const wildnessVsNovelty = perTick
  .filter((t) => typeof t.wildness === 'number' && t.proposals > 0)
  .map((t) => ({ tick: t.tick, wildness: t.wildness, novel_locus_rate: t.novel_loci / t.proposals }));

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
  verdicts_unparsed: perTick.filter((t) => t.verdict_unparsed).length,
  reviews_undecidable: perTick.reduce((a, t) => a + t.undecidable, 0),
  selector_schema_drift: new Set(perTick.filter((t) => t.reviewed > 0).map((t) => t.schema_shape)).size > 1,
  nodes_with_empty_tree_metrics: nodes.filter((n) => n.tree_metrics_empty).length,
  sage_proactive_total: perTick.reduce((a, t) => a + t.sage_proactive_findings, 0),
  selector_precision: selectorPrecision,
  technique_tag_vocabulary: seenTags.size,
  proposals_untagged: perTick.reduce((a, t) => a + (t.proposals - t.proposals_tagged), 0),
  selector_ticks_scored: withApproval.length,
  wildness_vs_novelty: wildnessVsNovelty,
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
if (summary.verdicts_unparsed || summary.reviews_undecidable) {
  console.log(`SELECTOR ARTIFACTS UNREADABLE — ${summary.verdicts_unparsed} verdict file(s) parsed to zero reviews, ` +
              `${summary.reviews_undecidable} review(s) had no recognisable approval field.`);
  console.log('  Treat every Selector number below as incomplete, not as a result.');
}
if (summary.selector_schema_drift) {
  console.log('SELECTOR SCHEMA DRIFTS BETWEEN TICKS in this run — the artifact has no enforced');
  console.log('  shape, so any consumer of it (including the orchestrator) is guessing.');
}
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

console.log('\nSELECTOR calibration (precision only, no recall — see note):');
if (summary.selector_precision === null) {
  console.log('  no tick had an approval to score');
} else {
  console.log(`  ${pct(summary.selector_precision)} of ticks where Selector approved something improved the running best` +
              `  (n=${summary.selector_ticks_scored})`);
}

console.log('\nMUTAGEN exploration over DECLARED mechanisms (technique_tags):');
if (summary.proposals_untagged === summary.total_proposals) {
  console.log('  no proposal declared technique_tags — this run predates the field.');
  console.log('  Mechanism-level novelty is unmeasurable for it; the lexical numbers below');
  console.log('  are the fallback and they saturate.');
} else {
  for (const t of perTick) {
    console.log(`  tick ${t.tick}: ${t.proposals_tagged}/${t.proposals} tagged · ` +
                `${t.new_technique_tags} new mechanism(s) · exploration rate ${t.exploration_rate === null ? 'n/a' : t.exploration_rate.toFixed(2)}`);
  }
  console.log(`  vocabulary after ${summary.ticks} tick(s): ${summary.technique_tag_vocabulary} distinct mechanisms`);
  if (summary.proposals_untagged) console.log(`  ! ${summary.proposals_untagged} proposal(s) declared no tags and are invisible to this measure`);
}

console.log('\nMUTAGEN wildness vs realized diversity (Jaccard on proposal text):');
const f2 = (x) => (x === null ? ' n/a' : x.toFixed(2));
for (const t of perTick) {
  console.log(`  tick ${t.tick}: wildness ${String(t.wildness ?? '-').padStart(4)} ` +
              `-> intra-tick ${f2(t.intra_tick_diversity)}  vs-history ${f2(t.distance_from_history)}`);
}
if (summary.wildness_vs_novelty.length > 1) {
  const first = summary.wildness_vs_novelty[0], last = summary.wildness_vs_novelty.at(-1);
  const vals = perTick.map((t) => t.intra_tick_diversity).filter((x) => x !== null);
  const lexSaturated = vals.length > 0 && vals.every((v) => v > 0.9);
  const locusSaturated = summary.wildness_vs_novelty.every((w) => w.novel_locus_rate >= 1);
  if (lexSaturated && locusSaturated) {
    console.log('  ! BOTH cheap novelty proxies are at ceiling here: every proposal touches a');
    console.log('    fresh locus (rate 1.00) and shares almost no wording with the others');
    console.log('    (Jaccard > 0.9). Neither can distinguish five genuinely different ideas');
    console.log('    from five different phrasings of one. Conceptual novelty needs a semantic');
    console.log('    measure — embedding proposals against each other and the citation corpus.');
    console.log('    Until then, treat Mutagen diversity as UNMEASURED, not as good.');
  } else if (last && first && last.wildness > first.wildness && vals.length > 1 && vals.at(-1) < vals[0]) {
    console.log('  ! the dial went up and diversity went down — wildness may be decorative');
  }
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
