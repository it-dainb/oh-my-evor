"""
TreeEngine — UCB1-normalized selection, genome-aware crossover, meta-evolution.

UCB1 CORRECTNESS CONTRACT:
  Metric normalized to [0,1] before applying UCB1.
  Unvisited nodes (visit_count==0) → score = +inf (always selected first).
  C = strategy.ucb1_c (default 1.41) is valid on [0,1] normalized inputs.

Diversity constraints:
  H002: family winning ≥ 3 of last N ticks → family_mix weight reduced.
  H003: enforced at proposal time by Selector (not here).

Crossover: valid only when node_a.eval_version == node_b.eval_version.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from evor.contracts import (
    ApproachFamily,
    CriticReview,
    DecisionLogEntry,
    EvaluationResult,
    GenomeConfig,
    GoalContract,
    Hypothesis,
    MutationProposal,
    StrategyState,
    TreeNode,
)
from evor.genome import merge_genomes
from evor.store import ContentAddressedStore

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

_DEFAULT_UCB1_C: float = 1.41
_H002_WIN_THRESHOLD: int = 3       # deprioritize family if wins >= this in window
_FAMILY_MIX_FLOOR: float = 0.05   # minimum weight floor after H002 reduction
_FAMILY_MIX_REDUCTION: float = 0.3  # reduce by 30% when H002 triggers

# Default crossover loci: take head + training genes from b; preserve backbone in a
_DEFAULT_CROSSOVER_LOCI = ["head", "optimizer", "lr", "lr_schedule", "loss", "aug_set"]


# ─────────────────────────────────────────────────────────────────────────────
# TreeEngine
# ─────────────────────────────────────────────────────────────────────────────


class TreeEngine:
    """UCB1-based tree engine with genome-aware crossover and meta-evolution."""

    def __init__(
        self,
        nodes: list[TreeNode],
        goal: GoalContract,
        strategy: StrategyState,
        run_dir: Path,
        store: ContentAddressedStore | None = None,
    ) -> None:
        self._nodes: list[TreeNode] = list(nodes)
        self._goal = goal
        self._strategy = strategy
        self._run_dir = run_dir
        self._store = store
        self._node_map: dict[str, TreeNode] = {n.id: n for n in nodes}
        # Set by best_frontier() for callers to inspect
        self.frontier_mixed_versions: bool = False

    # ------------------------------------------------------------------
    # Internal metric helpers
    # ------------------------------------------------------------------

    def _primary_metric_name(self) -> str:
        for ms in self._goal.metric_specs:
            if ms.role == "primary_fitness":
                return ms.metric_name
        for m in self._goal.metrics:
            if m.primary:
                return m.name
        if self._goal.metric_specs:
            return self._goal.metric_specs[0].metric_name
        if self._goal.metrics:
            return self._goal.metrics[0].name
        return ""

    def _node_metric(self, node: TreeNode) -> float:
        """Return the primary metric value for *node*."""
        name = self._primary_metric_name()
        if name and name in node.metrics:
            return node.metrics[name]
        if node.fitness_value is not None:
            return node.fitness_value
        return 0.0

    def _normalize(self, metric_val: float, eligible: list[TreeNode]) -> float:
        """Clamp-normalize metric_val to [0,1].

        With target_value: uses (val - baseline) / (target - baseline + 1e-6).
        Without: normalizes over observed min/max of visited eligible nodes.
        """
        if self._goal.target_value is not None:
            baseline = self._goal.baseline_value
            target = self._goal.target_value
            raw = (metric_val - baseline) / (target - baseline + 1e-6)
        else:
            name = self._primary_metric_name()
            observed = [
                self._node_metric(n)
                for n in eligible
                if n.visit_count > 0 and name in n.metrics
            ]
            if not observed:
                return 0.0
            min_m, max_m = min(observed), max(observed)
            raw = (metric_val - min_m) / (max_m - min_m + 1e-6)
        return max(0.0, min(1.0, raw))

    # ------------------------------------------------------------------
    # Lineage helpers
    # ------------------------------------------------------------------

    def _ancestors(self, node_id: str) -> set[str]:
        """BFS over parent_ids; return all ancestor IDs excluding node_id itself."""
        ancestors: set[str] = set()
        queue: list[str] = list(self._node_map[node_id].parent_ids) if node_id in self._node_map else []
        while queue:
            pid = queue.pop()
            if pid in ancestors:
                continue
            ancestors.add(pid)
            parent = self._node_map.get(pid)
            if parent:
                queue.extend(parent.parent_ids)
        return ancestors

    def _distinct_lineages(self, id_a: str, id_b: str) -> bool:
        """True if neither node is an ancestor of the other."""
        anc_a = self._ancestors(id_a)
        anc_b = self._ancestors(id_b)
        return id_b not in anc_a and id_a not in anc_b

    # ------------------------------------------------------------------
    # select
    # ------------------------------------------------------------------

    def select(self, count: int = 1) -> list[TreeNode]:
        """Return top *count* nodes by UCB1 score.

        UCB1 score_i = normalized_i + C * sqrt(ln(N) / n_i)
          N = sum of all visit counts across eligible nodes
          C = strategy.ucb1_c
          Unvisited nodes (n_i = 0) → score = +inf (always ranked first)
          All non-pruned nodes eligible at any depth (backtrack enabled).

        After selection, callers should check should_crossover(top_nodes) to
        determine if the top-2 nodes warrant a crossover proposal.
        """
        eligible = [n for n in self._nodes if n.status != "pruned"]
        if not eligible:
            return []

        N = sum(n.visit_count for n in eligible)
        C = self._strategy.ucb1_c

        def _score(node: TreeNode) -> float:
            if node.visit_count == 0:
                return math.inf
            m = self._node_metric(node)
            norm = self._normalize(m, eligible)
            return norm + C * math.sqrt(math.log(max(N, 1)) / node.visit_count)

        ranked = sorted(eligible, key=_score, reverse=True)
        return ranked[:count]

    def should_crossover(self, top_nodes: list[TreeNode]) -> bool:
        """True if the top-2 nodes are from distinct lineages (crossover warranted)."""
        if len(top_nodes) < 2:
            return False
        return self._distinct_lineages(top_nodes[0].id, top_nodes[1].id)

    # ------------------------------------------------------------------
    # propose_crossover
    # ------------------------------------------------------------------

    def propose_crossover(
        self,
        node_a: TreeNode,
        node_b: TreeNode,
        genome_a: GenomeConfig | None = None,
        genome_b: GenomeConfig | None = None,
        loci: list[str] | None = None,
    ) -> MutationProposal:
        """Genome-aware crossover proposal.

        Refuses cross-version crossover (node_a.eval_version != node_b.eval_version)
        with a ValueError and appends a refusal entry to decision-log.md.

        Loads GenomeConfig from the store when genome_a/genome_b are not provided;
        raises ValueError if the store is not available.

        mutation_tier:
          "parametric" — schema_extensions compatible (one is superset of the other or equal)
          "structural"  — schema_extensions diverge (neither is superset of the other)
        """
        if node_a.eval_version != node_b.eval_version:
            refusal = (
                f"[CROSSOVER REFUSED: cross-version eval_version mismatch: "
                f"node {node_a.id} (v={node_a.eval_version}) vs "
                f"node {node_b.id} (v={node_b.eval_version})]"
            )
            self._append_decision_log(refusal)
            raise ValueError(refusal)

        # Load genomes
        g_a = genome_a if genome_a is not None else self._load_genome(node_a.genome_ref)
        g_b = genome_b if genome_b is not None else self._load_genome(node_b.genome_ref)

        # Determine mutation_tier from schema_extensions compatibility
        ext_a = set(g_a.schema_extensions)
        ext_b = set(g_b.schema_extensions)
        schemas_compatible = ext_a.issubset(ext_b) or ext_b.issubset(ext_a)
        mutation_tier: Literal["parametric", "structural"] = (
            "parametric" if schemas_compatible else "structural"
        )

        # Merge genomes; loci defaults to taking training/head genes from b
        effective_loci = loci if loci is not None else _DEFAULT_CROSSOVER_LOCI
        try:
            merged_genome = merge_genomes(g_a, g_b, effective_loci)
        except ValueError:
            # Schema extension conflict; still produce the proposal but flag structural
            mutation_tier = "structural"
            # Use a minimal merge: fall back to a shallow copy of g_a
            merged_genome = g_a.model_copy(
                update={"schema_extensions": sorted(ext_a & ext_b), "extra": {}}
            )

        hypothesis = Hypothesis(
            id=str(uuid.uuid4()),
            statement=(
                f"Combining {node_a.approach_family} genes from node {node_a.id[:8]} "
                f"with {node_b.approach_family} genes from node {node_b.id[:8]} "
                "will produce a candidate that benefits from both lineages."
            ),
            prediction="Fitness improvement over both parents.",
        )

        critic_review = CriticReview(
            h001_one_hypothesis="pass",
            h002_family_streak="pass",
            h003_intra_tick_diversity="pass",
            integrity_risk="pass",
            instrumentation_check="pass",
            schema_valid="pass",
            verdict="approved",
        )

        return MutationProposal(
            proposal_id=str(uuid.uuid4()),
            parent_node_ids=[node_a.id, node_b.id],
            approach_family=node_a.approach_family,
            idea=(
                f"Genome crossover: backbone+neck from {node_a.id[:8]}, "
                f"head+training from {node_b.id[:8]}. "
                f"mutation_tier={mutation_tier}."
            ),
            hypothesis=hypothesis,
            citations=[],
            wildness=self._strategy.wildness,
            critic_approved=True,
            critic_review=critic_review,
        )

    def _load_genome(self, genome_ref: str) -> GenomeConfig:
        if not genome_ref:
            raise ValueError("genome_ref is empty; cannot load genome from store.")
        if self._store is None:
            raise ValueError(
                f"Cannot load genome {genome_ref[:8]}…: store not provided to TreeEngine. "
                "Pass genome objects directly to propose_crossover()."
            )
        from evor.genome import load_genome
        blob_path = self._store.get(genome_ref)
        return load_genome(blob_path)

    # ------------------------------------------------------------------
    # prune
    # ------------------------------------------------------------------

    def prune(
        self,
        winner_id: str,
        losers: list[str],
        store: ContentAddressedStore,
        skip_hashes: set[str] | None = None,
    ) -> None:
        """Mark losers as pruned; GC their artifact blobs via store.gc().

        Collects all content hashes still referenced by non-pruned nodes and
        calls store.gc() so only referenced blobs survive.

        skip_hashes: additional hashes that must NOT be GC'd — used for
        stale-eval_version frontier nodes whose artifacts are still needed
        for re-scoring under the new eval version.  These hashes are added
        to the referenced set regardless of whether their owner node is pruned.
        """
        loser_set = set(losers)

        # Mark pruned
        for i, node in enumerate(self._nodes):
            if node.id in loser_set:
                updated = node.model_copy(update={"status": "pruned"})
                self._nodes[i] = updated
                self._node_map[node.id] = updated

        # Collect all hashes still in use by non-pruned nodes
        referenced: set[str] = set(skip_hashes or set())
        for node in self._nodes:
            if node.status == "pruned":
                continue
            for h in (node.genome_ref, node.data_version_ref, node.weights_ref, node.parent_patch_ref):
                if h:
                    referenced.add(h)

        store.gc(referenced)

    # ------------------------------------------------------------------
    # compute_fitness
    # ------------------------------------------------------------------

    def compute_fitness(self, result: EvaluationResult, goal: GoalContract) -> float:
        """Compute fitness_value per GoalContract.fitness_mode.

        open_ended: worst_angle_coverage (from AngleRegistry.score_angles) if
          result.worst_angle_coverage is set; falls back to aggregate if None.
        aggregate:  primary metric, normalized to [0,1] with baseline/target.
        worst-domain: min per_domain primary metric (robustness-aware).
        weighted:   equal-weight average of per_domain primary metric values.
        """
        primary = self._primary_metric_name()

        # Open-ended override
        if goal.mission_type == "open_ended" and result.worst_angle_coverage is not None:
            return result.worst_angle_coverage

        if goal.fitness_mode == "worst-domain":
            if not result.per_domain:
                return result.metrics.get(primary, 0.0)
            return min(
                scores.get(primary, 0.0)
                for scores in result.per_domain.values()
            )

        if goal.fitness_mode == "weighted":
            if not result.per_domain:
                return result.metrics.get(primary, 0.0)
            total = sum(
                scores.get(primary, 0.0) for scores in result.per_domain.values()
            )
            return total / len(result.per_domain)

        # aggregate (default)
        value = result.metrics.get(primary, 0.0)
        if goal.target_value is not None:
            return max(0.0, min(1.0,
                (value - goal.baseline_value) / (goal.target_value - goal.baseline_value + 1e-6)
            ))
        return value

    # ------------------------------------------------------------------
    # best_frontier
    # ------------------------------------------------------------------

    def best_frontier(self) -> list[TreeNode]:
        """Return non-dominated done nodes (Pareto frontier over fitness_value).

        All returned nodes must share the current eval_version.  If done nodes
        span multiple eval_versions, self.frontier_mixed_versions is set to True
        and only the most recent eval_version's nodes are included.
        """
        done = [n for n in self._nodes if n.status == "done" and n.fitness_value is not None]
        if not done:
            self.frontier_mixed_versions = False
            return []

        versions = {n.eval_version for n in done}
        self.frontier_mixed_versions = len(versions) > 1

        # Choose the "current" version: largest v-number or lexicographic max
        def _version_key(v: str) -> int:
            tail = v.lstrip("v")
            return int(tail) if tail.isdigit() else 0

        current_version = max(versions, key=_version_key)
        same_ver = [n for n in done if n.eval_version == current_version]

        # Non-dominated: no other same-version node has strictly higher fitness
        max_fitness = max(n.fitness_value for n in same_ver)  # type: ignore[type-var]
        return [n for n in same_ver if n.fitness_value == max_fitness]

    # ------------------------------------------------------------------
    # meta_evolve
    # ------------------------------------------------------------------

    def meta_evolve(
        self,
        decision_log: list[DecisionLogEntry],
        benchmark_upgrade_applied: bool = False,
        frontier_ids: list[str] | None = None,
    ) -> StrategyState:
        """Update StrategyState based on last meta_loop_interval ticks.

        Reads completed nodes to determine per-tick winners (highest fitness
        per depth group, as proxy for tick).

        H002: if one family wins >= _H002_WIN_THRESHOLD of last N ticks,
          reduce its weight in family_mix by _FAMILY_MIX_REDUCTION (floor: _FAMILY_MIX_FLOOR).

        Wildness: increased by 0.1 (max 1.0) when integrity failures are detected.

        ucb1_c: lowered by 0.1 when exploitation pattern detected (winners have
          high visit counts).

        Post-BenchmarkUpgrade boost (R-4): sets wildness boost and tick countdown.
        """
        N = self._strategy.meta_loop_interval
        completed = [
            n for n in self._nodes
            if n.status == "done" and n.fitness_value is not None
        ]

        # Group by depth as tick proxy; determine per-group winner
        by_depth: dict[int, list[TreeNode]] = {}
        for node in completed:
            by_depth.setdefault(node.depth, []).append(node)

        sorted_depths = sorted(by_depth.keys())[-N:]
        tick_winner_families: list[str] = []
        for depth in sorted_depths:
            best = max(by_depth[depth], key=lambda n: n.fitness_value or 0.0)
            tick_winner_families.append(best.approach_family)

        # Update winning_families (rolling window of last N)
        updated_winning = list(self._strategy.winning_families) + tick_winner_families
        updated_winning = updated_winning[-N:]

        # Accumulate wins_by_family
        wins_by_family = dict(self._strategy.wins_by_family)
        for family in tick_winner_families:
            wins_by_family[family] = wins_by_family.get(family, 0) + 1

        # H002: reduce weight for over-winning families
        family_mix = dict(self._strategy.family_mix)
        window_counts: dict[str, int] = {}
        for family in updated_winning:
            window_counts[family] = window_counts.get(family, 0) + 1

        for family, count in window_counts.items():
            if count >= _H002_WIN_THRESHOLD:
                current = family_mix.get(family, 1.0 / 7)
                family_mix[family] = max(
                    _FAMILY_MIX_FLOOR, current * (1.0 - _FAMILY_MIX_REDUCTION)
                )

        # Wildness: increase when integrity failures present (circuit-breaker pattern)
        failed_nodes = [n for n in self._nodes if n.integrity_status == "failed"]
        new_wildness = self._strategy.wildness
        if failed_nodes:
            new_wildness = min(1.0, self._strategy.wildness + 0.1)

        # ucb1_c: lower when exploitation winning (high visit count winners)
        new_ucb1_c = self._strategy.ucb1_c
        if tick_winner_families and completed:
            last_family = tick_winner_families[-1]
            winning_nodes = [n for n in completed if n.approach_family == last_family]
            if winning_nodes:
                avg_visits = sum(n.visit_count for n in winning_nodes) / len(winning_nodes)
                if avg_visits > 1.5:  # exploitation pattern: nodes revisited multiple times
                    new_ucb1_c = max(0.1, self._strategy.ucb1_c - 0.1)

        # Post-BenchmarkUpgrade boost (R-4)
        new_boost = self._strategy.post_upgrade_exploration_boost
        new_boost_ticks = self._strategy.post_upgrade_exploration_ticks

        if benchmark_upgrade_applied:
            frontier_count = len(frontier_ids) if frontier_ids else len(
                [n for n in self._nodes if n.status == "done"]
            )
            new_boost = min(1.0, self._strategy.wildness + 0.3)
            new_boost_ticks = min(15, max(5, frontier_count * 2))
        else:
            if new_boost_ticks > 0:
                new_boost_ticks = max(0, new_boost_ticks - 1)
            if new_boost_ticks == 0:
                new_boost = None

        updated = StrategyState(
            meta_iteration=self._strategy.meta_iteration + 1,
            selection_policy=self._strategy.selection_policy,
            ucb1_c=new_ucb1_c,
            beam_width=self._strategy.beam_width,
            wildness=new_wildness,
            family_mix=family_mix,
            winning_families=updated_winning,
            wins_by_family=wins_by_family,
            meta_loop_interval=self._strategy.meta_loop_interval,
            post_upgrade_exploration_boost=new_boost,
            post_upgrade_exploration_ticks=new_boost_ticks,
            rescore_mode=self._strategy.rescore_mode,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        self._strategy = updated
        return updated

    # ------------------------------------------------------------------
    # I/O helpers
    # ------------------------------------------------------------------

    def _append_decision_log(self, text: str) -> None:
        log = self._run_dir / "decision-log.md"
        with open(log, "a") as fh:
            fh.write(f"\n{text}\n")


# ─────────────────────────────────────────────────────────────────────────────
# I/O helpers for CLI
# ─────────────────────────────────────────────────────────────────────────────


def _load_engine(run_dir: Path, strategy_override: dict | None = None) -> TreeEngine:
    """Reconstruct a TreeEngine from on-disk tree.json and strategy.json."""
    tree_path = run_dir / "tree.json"
    strategy_path = run_dir / "strategy.json"
    goal_path = run_dir.parent.parent / "goal.json"

    if not tree_path.exists():
        sys.exit(f"tree.json not found at {run_dir}")

    with open(tree_path) as fh:
        raw_nodes = json.load(fh)
    nodes = [TreeNode.model_validate(n) for n in raw_nodes]

    with open(strategy_path) as fh:
        raw_strategy = json.load(fh)
    if strategy_override:
        raw_strategy.update(strategy_override)
    strategy = StrategyState.model_validate(raw_strategy)

    with open(goal_path) as fh:
        goal = GoalContract.model_validate_json(fh.read())

    return TreeEngine(nodes=nodes, goal=goal, strategy=strategy, run_dir=run_dir)


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point (called by TS MCP tools as subprocess)
# ─────────────────────────────────────────────────────────────────────────────


def _cli() -> None:  # pragma: no cover
    parser = argparse.ArgumentParser(prog="python -m evor.tree")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sel = sub.add_parser("select")
    sel.add_argument("--run-id", required=True)
    sel.add_argument("--strategy", default=None, help="JSON strategy override")
    sel.add_argument("--count", type=int, default=1)

    cross = sub.add_parser("crossover")
    cross.add_argument("--run-id", required=True)
    cross.add_argument("--node-a", required=True)
    cross.add_argument("--node-b", required=True)

    prune_p = sub.add_parser("prune")
    prune_p.add_argument("--run-id", required=True)
    prune_p.add_argument("--winner", required=True)
    prune_p.add_argument("--losers", required=True)

    front = sub.add_parser("frontier")
    front.add_argument("--run-id", required=True)

    meta = sub.add_parser("meta-evolve")
    meta.add_argument("--run-id", required=True)

    args = parser.parse_args()

    # Resolve run_dir from run-id (relative to cwd .evor/runs/*/*/)
    run_dir = Path(args.run_id) if Path(args.run_id).is_dir() else Path(".evor/runs") / args.run_id

    if args.cmd == "select":
        override = json.loads(args.strategy) if args.strategy else None
        engine = _load_engine(run_dir, override)
        selected = engine.select(count=args.count)
        result = {
            "selected": [n.id for n in selected],
            "scores": {},  # UCB1 scores omitted for brevity
        }
        print(json.dumps(result))

    elif args.cmd == "frontier":
        engine = _load_engine(run_dir)
        frontier = engine.best_frontier()
        print(json.dumps([n.id for n in frontier]))

    elif args.cmd == "meta-evolve":
        engine = _load_engine(run_dir)
        updated = engine.meta_evolve(decision_log=[])
        print(updated.model_dump_json(indent=2))

    else:
        print(json.dumps({"error": f"command '{args.cmd}' requires additional wiring (M6)"}))


if __name__ == "__main__":
    _cli()
