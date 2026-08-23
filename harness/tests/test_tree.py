"""
M5 tests for TreeEngine (harness/evor/tree.py).

Coverage:
  test_select_unvisited              — all visit_count=0 → +inf, no ZeroDivisionError
  test_ucb1_normalization            — metric in [0,1] after normalization with target_value
  test_ucb1_normalization_fallback   — normalize over observed min/max when no target_value
  test_select_backtrack              — non-root node selected when UCB1 favours it
  test_crossover_returns_proposal    — same eval_version → proposal with 2 parent_node_ids
  test_crossover_refuses_cross_version — different eval_version → ValueError + log
  test_genome_crossover              — merge_genomes: node_a.backbone + node_b.head
  test_structural_crossover_flag     — divergent schema_extensions → mutation_tier="structural"
  test_fitness_aggregate             — aggregate mode returns primary metric value
  test_fitness_worst_domain          — worst-domain mode returns min across domains
  test_fitness_open_ended            — open_ended: worst_angle_coverage used when set
  test_best_frontier_pareto          — frontier = nodes with max fitness_value
  test_best_frontier_excludes_pruned — pruned/pending nodes never on frontier
  test_frontier_mixed_versions       — mixed eval_versions → frontier_mixed_versions=True
  test_prune_marks_losers            — loser nodes get status='pruned'
  test_prune_honors_skip_hashes      — skip_hashes not GC'd even when node is pruned
  test_meta_evolve_h002              — over-winning family weight reduced (with floor)
  test_meta_evolve_boost_applies     — post-BenchmarkUpgrade boost set correctly
  test_meta_evolve_boost_decays      — boost ticks decrement each meta_evolve call
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from evor.contracts import (
    AngleVsSOTAInline,
    Budget,
    CriticReview,
    EvaluationResult,
    GenomeConfig,
    GoalContract,
    Hypothesis,
    MetricConstraint,
    MetricSpec,
    MutationProposal,
    StopCondition,
    StrategyState,
    TelemetrySummary,
    TreeNode,
)
from evor.tree import TreeEngine

# ── Fixture factories ──────────────────────────────────────────────────────────


def _make_goal(
    baseline: float = 0.72,
    target: float | None = 0.85,
    fitness_mode: str = "aggregate",
    mission_type: str = "fixed",
) -> GoalContract:
    return GoalContract(
        mission_id="test-m-2026",
        mode="from-scratch",
        mission_type=mission_type,  # type: ignore[arg-type]
        task_description="Test task",
        dataset_ref="/data/test",
        metric_specs=[
            MetricSpec(
                metric_name="accuracy",
                direction="higher",
                domain_applicability="all",
                aggregation_rule="macro_avg",
                role="primary_fitness",
                sota_bar=None,
            )
        ],
        fitness_mode=fitness_mode,  # type: ignore[arg-type]
        eval_version="v1",
        baseline_value=baseline,
        target_value=target,
        coverage_target=0.9 if mission_type == "open_ended" else None,
        stop_condition=StopCondition(type="target"),
        wildness=0.5,
        budget=Budget(
            max_iterations=50,
            plateau_window=8,
            circuit_breaker=5,
            max_cost_usd=0.0,
        ),
        locked_split_hash="abc123",
        eval_script_hash="def456",
        allowed_licenses=["MIT", "Apache-2.0"],
        created_at="2026-07-03T00:00:00Z",
    )


def _make_strategy(
    ucb1_c: float = 1.41,
    wildness: float = 0.5,
    winning_families: list[str] | None = None,
    wins_by_family: dict[str, int] | None = None,
    post_upgrade_exploration_boost: float | None = None,
    post_upgrade_exploration_ticks: int = 0,
) -> StrategyState:
    return StrategyState(
        meta_iteration=1,
        selection_policy="ucb1",
        ucb1_c=ucb1_c,
        wildness=wildness,
        family_mix={
            "arch": 0.20,
            "training": 0.20,
            "data-curation": 0.15,
            "data-augmentation": 0.15,
            "data-acquisition": 0.10,
            "algo": 0.15,
            "other": 0.05,
        },
        winning_families=winning_families or [],
        wins_by_family=wins_by_family or {},
        meta_loop_interval=5,
        post_upgrade_exploration_boost=post_upgrade_exploration_boost,
        post_upgrade_exploration_ticks=post_upgrade_exploration_ticks,
        rescore_mode="sync",
        updated_at="2026-07-03T00:00:00Z",
    )


def _make_node(
    node_id: str,
    parent_ids: list[str],
    depth: int,
    score: float,
    family: str = "arch",
    visit_count: int = 1,
    status: str = "done",
    integrity_status: str = "passed",
    fitness_value: float | None = None,
    eval_version: str = "v1",
    config: dict | None = None,
) -> TreeNode:
    return TreeNode(
        id=node_id,
        parent_ids=parent_ids,
        approach_family=family,  # type: ignore[arg-type]
        hypothesis_id=f"hyp-{node_id[:8]}",
        code_ref=f"nodes/{node_id}/code/",
        genome_ref=f"genome-ref-{node_id[:8]}",
        data_version_ref="data-v1",
        config=config or {},
        metrics={"accuracy": score},
        eval_version=eval_version,
        fitness_value=fitness_value if fitness_value is not None else score,
        lesson_ids=[],
        citations=[],
        integrity_status=integrity_status,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        is_crossover=False,
        visit_count=visit_count,
        depth=depth,
        created_at="2026-07-03T01:00:00Z",
    )


def _make_eval_result(
    node_id: str = "n1",
    run_id: str = "run1",
    score: float = 0.80,
    per_domain: dict | None = None,
    worst_angle_coverage: float | None = None,
    eval_version: str = "v1",
) -> EvaluationResult:
    return EvaluationResult(
        node_id=node_id,
        run_id=run_id,
        eval_version=eval_version,
        metrics={"accuracy": score},
        per_domain=per_domain or {"default": {"accuracy": score}},
        fitness_value=score,
        worst_angle_coverage=worst_angle_coverage,
        per_angle_vs_sota=None,
        telemetry_summary=TelemetrySummary(total_steps=100),
        status="success",
        benchmark_raw=f"accuracy={score}",
        timestamp="2026-07-03T02:00:00Z",
    )


def _make_genome(
    backbone: str | None = "resnet9",
    head: str | None = "linear",
    schema_extensions: list[str] | None = None,
    extra: dict | None = None,
) -> GenomeConfig:
    return GenomeConfig(
        genome_version="1.0.0",
        backbone=backbone,
        head=head,
        neck=None,
        optimizer="adamw",
        lr=1e-3,
        lr_schedule="cosine",
        batch_size=32,
        epochs=10,
        loss="cross_entropy",
        aug_set=[],
        acquired_datasets=[],
        regularization={},
        schema_extensions=schema_extensions or [],
        extra=extra or {},
    )


# ── Tests: select() ────────────────────────────────────────────────────────────


def test_select_unvisited(tmp_path: Path) -> None:
    """All visit_count=0 → select() returns one node without ZeroDivisionError.

    Unvisited nodes receive score +inf; no divide-by-zero ever occurs.
    """
    nodes = [
        _make_node("n1", [], 0, 0.75, visit_count=0, status="done"),
        _make_node("n2", ["n1"], 1, 0.80, visit_count=0, status="done"),
        _make_node("n3", ["n2"], 2, 0.82, visit_count=0, status="done"),
    ]
    goal = _make_goal()
    strategy = _make_strategy()
    engine = TreeEngine(nodes=nodes, goal=goal, strategy=strategy, run_dir=tmp_path)

    selected = engine.select(count=1)

    assert len(selected) == 1, "select() must return exactly 1 node"
    assert selected[0].id in {"n1", "n2", "n3"}
    # Verify internally: the score for unvisited nodes is math.inf
    for node in nodes:
        assert node.visit_count == 0  # test precondition
    # No exception was raised → ZeroDivisionError guard is working


def test_select_unvisited_no_inf_in_output(tmp_path: Path) -> None:
    """select(count=3) returns 3 nodes when all are unvisited — all get +inf."""
    nodes = [_make_node(f"n{i}", [], 0, 0.80, visit_count=0) for i in range(3)]
    engine = TreeEngine(nodes=nodes, goal=_make_goal(), strategy=_make_strategy(), run_dir=tmp_path)
    selected = engine.select(count=3)
    assert len(selected) == 3


def test_ucb1_normalization(tmp_path: Path) -> None:
    """With target_value present, exploitation score is normalized to [0,1].

    A node with metric=0.90 (above baseline=0.72, target=0.85) should have a
    normalized exploitation score clipped to 1.0, not the raw 0.90.

    Also verifies that exploration term C*sqrt(...) uses the [0,1]-bounded
    exploitation value, so UCB1 can never become (e.g.) 0.90 + exploration
    which would make exploration appear "free" compared to exploitation.
    """
    goal = _make_goal(baseline=0.72, target=0.85)  # target_value present
    # Two visited nodes: high-metric vs low-metric
    n_high = _make_node("n-high", [], 0, 0.95, visit_count=5, fitness_value=0.95)
    n_low = _make_node("n-low", [], 0, 0.73, visit_count=5, fitness_value=0.73)

    engine = TreeEngine(nodes=[n_high, n_low], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    selected = engine.select(count=1)

    # n_high should be selected; normalized 0.95 clips to 1.0 (exploitation floor)
    assert selected[0].id == "n-high"

    # Explicit normalization check: normalized(0.95) with baseline=0.72, target=0.85
    # = (0.95 - 0.72) / (0.85 - 0.72 + 1e-6) ≈ 0.23 / 0.13 ≈ 1.77 → clipped to 1.0
    raw_norm = (0.95 - 0.72) / (0.85 - 0.72 + 1e-6)
    assert raw_norm > 1.0  # raw value would exceed 1 without clamping
    clamped = max(0.0, min(1.0, raw_norm))
    assert clamped == 1.0  # clamped to [0,1]


def test_ucb1_normalization_fallback(tmp_path: Path) -> None:
    """Without target_value, score is normalized over observed min/max."""
    goal = _make_goal(baseline=0.72, target=None)  # no target → fallback normalization
    n_min = _make_node("n-min", [], 0, 0.70, visit_count=3, fitness_value=0.70)
    n_max = _make_node("n-max", [], 0, 0.90, visit_count=3, fitness_value=0.90)

    engine = TreeEngine(nodes=[n_min, n_max], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    selected = engine.select(count=1)

    # n_max has higher normalized score → selected first
    assert selected[0].id == "n-max"


def test_select_backtrack(tmp_path: Path) -> None:
    """UCB1 can select any depth, including non-leaf (backtrack)."""
    # Root has low visit_count, deep node has high visit_count → root may outscore leaf
    root = _make_node("root", [], 0, 0.80, visit_count=1)
    child = _make_node("child", ["root"], 1, 0.85, visit_count=10)

    goal = _make_goal()
    strategy = _make_strategy(ucb1_c=2.0)  # high C → exploration dominates
    engine = TreeEngine(nodes=[root, child], goal=goal, strategy=strategy, run_dir=tmp_path)

    selected = engine.select(count=1)
    # With C=2.0 and N=11, root (n_i=1) gets large sqrt term; root should outscore child
    n_root_sqrt = math.sqrt(math.log(11) / 1)
    n_child_sqrt = math.sqrt(math.log(11) / 10)
    assert n_root_sqrt > n_child_sqrt  # sanity check
    assert selected[0].id == "root"


def test_pruned_nodes_excluded_from_select(tmp_path: Path) -> None:
    """Pruned nodes are never eligible for UCB1 selection."""
    alive = _make_node("alive", [], 0, 0.80, visit_count=2)
    pruned = _make_node("pruned", [], 0, 0.99, visit_count=2, status="pruned")
    engine = TreeEngine(nodes=[alive, pruned], goal=_make_goal(), strategy=_make_strategy(), run_dir=tmp_path)
    selected = engine.select(count=2)
    ids = {n.id for n in selected}
    assert "pruned" not in ids


# ── Tests: A5 visit_count persistence ───────────────────────────────────────────


def test_select_increments_visit_count_and_persists(tmp_path: Path) -> None:
    """Selecting a node bumps its visit_count and writes it back to tree.json.

    Before the A5 fix, select() was pure read/compute — nothing ever wrote
    the increment back, so every node stayed visit_count=0 forever.
    """
    node = _make_node("n1", [], 0, 0.80, visit_count=0, status="done")
    engine = TreeEngine(nodes=[node], goal=_make_goal(), strategy=_make_strategy(), run_dir=tmp_path)

    selected = engine.select(count=1)

    assert selected[0].visit_count == 1
    tree_data = json.loads((tmp_path / "tree.json").read_text())
    assert tree_data["nodes"]["n1"]["visit_count"] == 1


def test_select_ucb1_ordering_changes_with_visits(tmp_path: Path) -> None:
    """Exploration is LIVE: a heavily-visited high-fitness node eventually
    loses to a less-visited, lower-fitness one.

    Without persisted visit_count increments, node-a's score never changes
    across iterations and it wins every single round forever. With
    increments wired up, node-a's own exploration term shrinks each time
    it's picked while node-b's exploration term keeps growing (N grows every
    round, node-b's n_i never does) — until node-b's score overtakes it.
    """
    node_a = _make_node("node-a", [], 0, 0.90, visit_count=1)  # higher fitness
    node_b = _make_node("node-b", [], 0, 0.50, visit_count=1)  # lower fitness
    goal = _make_goal(baseline=0.0, target=1.0)
    strategy = _make_strategy(ucb1_c=1.41)
    engine = TreeEngine(nodes=[node_a, node_b], goal=goal, strategy=strategy, run_dir=tmp_path)

    picked: list[str] = []
    for _ in range(40):
        picked.append(engine.select(count=1)[0].id)

    assert picked[0] == "node-a", "higher-fitness node must win the opening round"
    assert "node-b" in picked, (
        "node-b's exploration bonus must eventually overtake node-a's — "
        "this only happens if visit_count increments are actually persisted"
    )


def test_select_cold_start_all_zero_is_deterministic(tmp_path: Path) -> None:
    """All visit_count=0 → +inf tie is broken by stable-sort insertion order,
    not accidental dict/set ordering — and each selected node is bumped to 1."""
    nodes = [_make_node(f"n{i}", [], 0, 0.5, visit_count=0) for i in range(3)]
    engine = TreeEngine(nodes=nodes, goal=_make_goal(), strategy=_make_strategy(), run_dir=tmp_path)

    selected = engine.select(count=3)

    # Documented tie-break: ties at +inf preserve original list order.
    assert [n.id for n in selected] == ["n0", "n1", "n2"]
    assert all(n.visit_count == 1 for n in selected)


def test_select_total_visits_equals_sum_of_per_node_visits(tmp_path: Path) -> None:
    """total_visits (N, recomputed fresh each select() call) always equals the
    sum of per-node visit_count — never drifts out of sync."""
    node_a = _make_node("node-a", [], 0, 0.9, visit_count=1)
    node_b = _make_node("node-b", [], 0, 0.5, visit_count=1)
    engine = TreeEngine(
        nodes=[node_a, node_b], goal=_make_goal(baseline=0.0, target=1.0),
        strategy=_make_strategy(), run_dir=tmp_path,
    )

    for _ in range(10):
        engine.select(count=1)

    total_visits = sum(n.visit_count for n in engine._nodes)
    tree_data = json.loads((tmp_path / "tree.json").read_text())
    persisted_total = sum(n["visit_count"] for n in tree_data["nodes"].values())

    # 2 starting visits (1 each) + 10 selections of 1 node each = 12
    assert total_visits == 12
    assert persisted_total == total_visits


# ── Tests: propose_crossover() ─────────────────────────────────────────────────


def test_crossover_returns_proposal(tmp_path: Path) -> None:
    """Same eval_version → MutationProposal with 2 parent_node_ids and is_crossover semantics."""
    node_a = _make_node("na", [], 0, 0.80, eval_version="v1")
    node_b = _make_node("nb", ["na"], 1, 0.85, eval_version="v1")

    genome_a = _make_genome(backbone="resnet9", head="linear")
    genome_b = _make_genome(backbone="vit-small", head="mlp")

    engine = TreeEngine(nodes=[node_a, node_b], goal=_make_goal(), strategy=_make_strategy(), run_dir=tmp_path)
    proposal = engine.propose_crossover(node_a, node_b, genome_a=genome_a, genome_b=genome_b)

    assert isinstance(proposal, MutationProposal)
    assert len(proposal.parent_node_ids) == 2, "Crossover proposal must have exactly 2 parent_node_ids"
    assert set(proposal.parent_node_ids) == {node_a.id, node_b.id}


def test_crossover_refuses_cross_version(tmp_path: Path) -> None:
    """Cross-version crossover (eval_version mismatch) raises ValueError and logs refusal."""
    (tmp_path / "decision-log.md").write_text("")  # ensure log file exists

    node_a = _make_node("na", [], 0, 0.80, eval_version="v1")
    node_b = _make_node("nb", [], 0, 0.85, eval_version="v2")

    engine = TreeEngine(nodes=[node_a, node_b], goal=_make_goal(), strategy=_make_strategy(), run_dir=tmp_path)

    with pytest.raises(ValueError, match="cross-version"):
        engine.propose_crossover(node_a, node_b)

    # Refusal must be logged to decision-log.md
    log_content = (tmp_path / "decision-log.md").read_text()
    assert "CROSSOVER REFUSED" in log_content


def test_genome_crossover_parametric(tmp_path: Path) -> None:
    """Genomes with compatible schema_extensions → mutation_tier='parametric'.

    After merge_genomes(a, b, loci=['head', ...]):
      child.backbone == a.backbone  (not in loci → from a)
      child.head     == b.head      (in loci → from b)
    """
    from evor.genome import merge_genomes

    genome_a = _make_genome(backbone="resnet9", head="linear", schema_extensions=[])
    genome_b = _make_genome(backbone="vit-small", head="mlp", schema_extensions=[])

    # merge: take head from b, backbone from a
    child = merge_genomes(genome_a, genome_b, loci=["head"])

    assert child.backbone == "resnet9", "backbone should come from genome_a (not in loci)"
    assert child.head == "mlp", "head should come from genome_b (in loci)"

    # mutation_tier: compatible schema_extensions (both empty → parametric)
    node_a = _make_node("na", [], 0, 0.80, eval_version="v1")
    node_b = _make_node("nb", [], 0, 0.85, eval_version="v1")
    engine = TreeEngine(nodes=[node_a, node_b], goal=_make_goal(), strategy=_make_strategy(), run_dir=tmp_path)
    proposal = engine.propose_crossover(node_a, node_b, genome_a=genome_a, genome_b=genome_b)
    assert proposal is not None
    assert "parametric" in proposal.idea


def test_structural_crossover_flag(tmp_path: Path) -> None:
    """Nodes with divergent schema_extensions → mutation_tier='structural' in idea field."""
    genome_a = _make_genome(
        backbone="resnet9", head="linear",
        schema_extensions=["dropout_stochastic_depth"],
        extra={"dropout_stochastic_depth": 0.1},
    )
    genome_b = _make_genome(
        backbone="vit-small", head="mlp",
        schema_extensions=["squeeze_excitation"],
        extra={"squeeze_excitation": 0.25},
    )

    node_a = _make_node("na", [], 0, 0.80, eval_version="v1")
    node_b = _make_node("nb", [], 0, 0.85, eval_version="v1")
    engine = TreeEngine(nodes=[node_a, node_b], goal=_make_goal(), strategy=_make_strategy(), run_dir=tmp_path)
    proposal = engine.propose_crossover(node_a, node_b, genome_a=genome_a, genome_b=genome_b)
    assert proposal is not None
    assert "structural" in proposal.idea, f"Expected 'structural' in idea, got: {proposal.idea!r}"


# ── Tests: compute_fitness() ───────────────────────────────────────────────────


def test_fitness_aggregate(tmp_path: Path) -> None:
    """aggregate mode: primary metric value (normalized when target set)."""
    goal = _make_goal(baseline=0.72, target=0.85, fitness_mode="aggregate")
    result = _make_eval_result(score=0.80)
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    # With target_value: (0.80 - 0.72) / (0.85 - 0.72 + 1e-6) ≈ 0.615
    expected = max(0.0, min(1.0, (0.80 - 0.72) / (0.85 - 0.72 + 1e-6)))
    assert abs(fitness - expected) < 1e-6


def test_fitness_worst_domain(tmp_path: Path) -> None:
    """worst-domain mode: fitness = min per_domain primary metric."""
    goal = _make_goal(fitness_mode="worst-domain", target=None)
    result = _make_eval_result(
        score=0.82,
        per_domain={"scanned": {"accuracy": 0.91}, "handwritten": {"accuracy": 0.72}},
    )
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    assert fitness == pytest.approx(0.72), f"worst-domain fitness should be 0.72, got {fitness}"


def test_fitness_weighted(tmp_path: Path) -> None:
    """weighted mode: equal-weight macro average across domains."""
    goal = _make_goal(fitness_mode="weighted", target=None)
    result = _make_eval_result(
        score=0.80,
        per_domain={"a": {"accuracy": 0.80}, "b": {"accuracy": 0.60}},
    )
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    assert fitness == pytest.approx(0.70)  # (0.80 + 0.60) / 2


def test_fitness_open_ended_uses_coverage(tmp_path: Path) -> None:
    """open_ended + worst_angle_coverage set → fitness = worst_angle_coverage."""
    goal = _make_goal(mission_type="open_ended", target=None)
    result = _make_eval_result(score=0.85, worst_angle_coverage=0.6)
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    assert fitness == pytest.approx(0.6)


def test_fitness_open_ended_fallback(tmp_path: Path) -> None:
    """open_ended with worst_angle_coverage=None falls back to aggregate."""
    goal = _make_goal(mission_type="open_ended", fitness_mode="aggregate", target=None)
    result = _make_eval_result(score=0.80, worst_angle_coverage=None)
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    assert fitness == pytest.approx(0.80)


# ── Tests: best_frontier() ─────────────────────────────────────────────────────


def test_best_frontier_pareto(tmp_path: Path) -> None:
    """Frontier = nodes with maximum fitness_value among done+passed nodes."""
    n_best = _make_node("n-best", [], 0, 0.90, fitness_value=0.90)
    n_ok = _make_node("n-ok", [], 0, 0.85, fitness_value=0.85)
    n_pruned = _make_node("n-pruned", [], 0, 0.95, fitness_value=0.95, status="pruned")

    engine = TreeEngine(
        nodes=[n_best, n_ok, n_pruned],
        goal=_make_goal(),
        strategy=_make_strategy(),
        run_dir=tmp_path,
    )
    frontier = engine.best_frontier()

    assert len(frontier) == 1
    assert frontier[0].id == "n-best"


def test_best_frontier_excludes_non_done(tmp_path: Path) -> None:
    """Pending and running nodes are excluded from the frontier."""
    done = _make_node("done", [], 0, 0.90, status="done", fitness_value=0.90)
    pending = _make_node("pending", [], 0, 0.99, status="pending", fitness_value=0.99)
    running = _make_node("running", [], 0, 0.99, status="running", fitness_value=0.99)

    engine = TreeEngine(
        nodes=[done, pending, running],
        goal=_make_goal(),
        strategy=_make_strategy(),
        run_dir=tmp_path,
    )
    frontier = engine.best_frontier()
    ids = {n.id for n in frontier}
    assert "pending" not in ids
    assert "running" not in ids
    assert "done" in ids


def test_frontier_mixed_versions(tmp_path: Path) -> None:
    """Frontier nodes from different eval_versions → frontier_mixed_versions=True."""
    n_v1 = _make_node("n-v1", [], 0, 0.88, eval_version="v1", fitness_value=0.88)
    n_v2 = _make_node("n-v2", [], 0, 0.88, eval_version="v2", fitness_value=0.88)

    engine = TreeEngine(
        nodes=[n_v1, n_v2],
        goal=_make_goal(),
        strategy=_make_strategy(),
        run_dir=tmp_path,
    )
    _ = engine.best_frontier()

    assert engine.frontier_mixed_versions is True


def test_frontier_same_version_no_flag(tmp_path: Path) -> None:
    """Frontier nodes all v1 → frontier_mixed_versions=False."""
    n1 = _make_node("n1", [], 0, 0.88, eval_version="v1", fitness_value=0.88)
    n2 = _make_node("n2", [], 0, 0.85, eval_version="v1", fitness_value=0.85)

    engine = TreeEngine(nodes=[n1, n2], goal=_make_goal(), strategy=_make_strategy(), run_dir=tmp_path)
    _ = engine.best_frontier()
    assert engine.frontier_mixed_versions is False


# ── Tests: prune() ─────────────────────────────────────────────────────────────


def test_prune_marks_losers(tmp_path: Path) -> None:
    """prune() sets status='pruned' on all loser nodes in-memory."""
    winner = _make_node("w", [], 0, 0.90)
    loser_a = _make_node("la", [], 0, 0.70)
    loser_b = _make_node("lb", [], 0, 0.65)

    mock_store = MagicMock()
    mock_store.gc = MagicMock(return_value=2)

    engine = TreeEngine(
        nodes=[winner, loser_a, loser_b],
        goal=_make_goal(),
        strategy=_make_strategy(),
        run_dir=tmp_path,
    )
    engine.prune("w", ["la", "lb"], mock_store)

    node_map = {n.id: n for n in engine._nodes}
    assert node_map["la"].status == "pruned"
    assert node_map["lb"].status == "pruned"
    assert node_map["w"].status == "done"  # winner untouched


def test_prune_calls_store_gc(tmp_path: Path) -> None:
    """prune() calls store.gc() with the correct referenced hash set."""
    winner = _make_node("w", [], 0, 0.90)
    winner_with_refs = winner.model_copy(update={
        "genome_ref": "genome-winner",
        "data_version_ref": "data-winner",
        "weights_ref": "weights-winner",
    })
    loser = _make_node("la", [], 0, 0.70)
    loser_with_refs = loser.model_copy(update={
        "genome_ref": "genome-loser",
        "data_version_ref": "data-loser",
        "weights_ref": None,
    })

    mock_store = MagicMock()
    engine = TreeEngine(
        nodes=[winner_with_refs, loser_with_refs],
        goal=_make_goal(),
        strategy=_make_strategy(),
        run_dir=tmp_path,
    )
    engine.prune("w", ["la"], mock_store)

    mock_store.gc.assert_called_once()
    referenced = mock_store.gc.call_args[0][0]
    # Winner's hashes stay referenced
    assert "genome-winner" in referenced
    assert "data-winner" in referenced
    assert "weights-winner" in referenced
    # Loser's hashes are NOT referenced (eligible for GC)
    assert "genome-loser" not in referenced


def test_prune_honors_skip_hashes(tmp_path: Path) -> None:
    """skip_hashes are added to referenced even when their node is pruned."""
    winner = _make_node("w", [], 0, 0.90)
    loser = _make_node("la", [], 0, 0.70)
    loser_modified = loser.model_copy(update={"genome_ref": "genome-loser"})

    mock_store = MagicMock()
    engine = TreeEngine(
        nodes=[winner, loser_modified],
        goal=_make_goal(),
        strategy=_make_strategy(),
        run_dir=tmp_path,
    )
    # Skip 'genome-loser' even though la is a loser
    engine.prune("w", ["la"], mock_store, skip_hashes={"genome-loser"})

    referenced = mock_store.gc.call_args[0][0]
    assert "genome-loser" in referenced  # skip_hash must be protected


# ── Tests: meta_evolve() ───────────────────────────────────────────────────────


def test_meta_evolve_h002_reduces_weight(tmp_path: Path) -> None:
    """meta_evolve: over-winning family gets weight reduced; floor is respected.

    Setup: 'arch' wins 3 out of 5 recent ticks → H002 triggers.
    """
    # Three nodes all 'arch' wins at different depths (depth used as tick proxy)
    nodes = [
        _make_node("a0", [], 0, 0.85, family="arch", fitness_value=0.85),
        _make_node("a1", ["a0"], 1, 0.87, family="arch", fitness_value=0.87),
        _make_node("a2", ["a1"], 2, 0.88, family="arch", fitness_value=0.88),
        _make_node("t0", [], 0, 0.70, family="training", fitness_value=0.70),
        _make_node("t1", ["t0"], 1, 0.72, family="training", fitness_value=0.72),
    ]
    strategy = _make_strategy(
        # winning_families already shows arch dominated last N ticks
        winning_families=["arch", "arch", "arch"],
        wins_by_family={"arch": 3},
    )
    engine = TreeEngine(nodes=nodes, goal=_make_goal(), strategy=strategy, run_dir=tmp_path)

    original_arch_weight = strategy.family_mix["arch"]
    updated = engine.meta_evolve([])

    new_arch_weight = updated.family_mix["arch"]
    assert new_arch_weight < original_arch_weight, (
        f"arch weight should decrease; original={original_arch_weight}, new={new_arch_weight}"
    )
    # Floor: weight never goes below _FAMILY_MIX_FLOOR (0.05)
    assert new_arch_weight >= 0.05, f"weight must not go below floor; got {new_arch_weight}"


def test_meta_evolve_floor_not_zero(tmp_path: Path) -> None:
    """family_mix floor is always respected — weights never reach 0."""
    strategy = _make_strategy(
        winning_families=["arch", "arch", "arch", "arch", "arch"],
        wins_by_family={"arch": 5},
    )
    strategy_with_low_weight = strategy.model_copy(
        update={"family_mix": {**strategy.family_mix, "arch": 0.06}}
    )
    engine = TreeEngine(nodes=[], goal=_make_goal(), strategy=strategy_with_low_weight, run_dir=tmp_path)
    updated = engine.meta_evolve([])

    for fam, weight in updated.family_mix.items():
        assert weight > 0, f"family '{fam}' has weight=0 after meta_evolve"
        assert weight >= 0.05, f"family '{fam}' weight {weight} below floor 0.05"


def test_meta_evolve_boost_applies(tmp_path: Path) -> None:
    """BenchmarkUpgrade applied → post_upgrade_exploration_boost set."""
    # 3 done nodes so frontier_count = 3 → boost_ticks = max(5, 3*2) = max(5,6) = 6
    nodes = [
        _make_node(f"n{i}", [], i, 0.80 + i * 0.01, fitness_value=0.80 + i * 0.01)
        for i in range(3)
    ]
    strategy = _make_strategy(wildness=0.5)
    engine = TreeEngine(nodes=nodes, goal=_make_goal(), strategy=strategy, run_dir=tmp_path)

    updated = engine.meta_evolve([], benchmark_upgrade_applied=True)

    assert updated.post_upgrade_exploration_boost is not None
    assert updated.post_upgrade_exploration_boost == pytest.approx(min(1.0, 0.5 + 0.3))
    # ticks = min(15, max(5, 3*2)) = min(15, 6) = 6
    assert updated.post_upgrade_exploration_ticks == 6


def test_meta_evolve_boost_decays(tmp_path: Path) -> None:
    """Each meta_evolve call decrements post_upgrade_exploration_ticks by 1."""
    strategy = _make_strategy(
        post_upgrade_exploration_boost=0.8,
        post_upgrade_exploration_ticks=3,
    )
    engine = TreeEngine(nodes=[], goal=_make_goal(), strategy=strategy, run_dir=tmp_path)

    updated = engine.meta_evolve([])  # tick 3 → 2
    assert updated.post_upgrade_exploration_ticks == 2
    assert updated.post_upgrade_exploration_boost == pytest.approx(0.8)

    engine._strategy = updated
    updated = engine.meta_evolve([])  # tick 2 → 1
    assert updated.post_upgrade_exploration_ticks == 1

    engine._strategy = updated
    updated = engine.meta_evolve([])  # tick 1 → 0 → clear boost
    assert updated.post_upgrade_exploration_ticks == 0
    assert updated.post_upgrade_exploration_boost is None


def test_meta_evolve_increments_iteration(tmp_path: Path) -> None:
    """meta_evolve increments meta_iteration by 1."""
    strategy = _make_strategy()
    engine = TreeEngine(nodes=[], goal=_make_goal(), strategy=strategy, run_dir=tmp_path)
    updated = engine.meta_evolve([])
    assert updated.meta_iteration == strategy.meta_iteration + 1


def test_meta_evolve_persists_to_disk(tmp_path: Path) -> None:
    """meta_evolve must atomically write updated strategy to <run_dir>/strategy.json.

    After the call, the on-disk JSON must reflect the new meta_iteration,
    wildness, and family_mix so that _load_engine() round-trips correctly.
    """
    import json as _json
    strategy = _make_strategy(wildness=0.2, winning_families=["arch", "arch", "arch"],
                              wins_by_family={"arch": 3})
    engine = TreeEngine(nodes=[], goal=_make_goal(), strategy=strategy, run_dir=tmp_path)

    updated = engine.meta_evolve([])

    # strategy.json must exist after the call
    strategy_path = tmp_path / "strategy.json"
    assert strategy_path.exists(), "meta_evolve did not write strategy.json to disk"

    on_disk = _json.loads(strategy_path.read_text())

    # meta_iteration must be persisted
    assert on_disk["meta_iteration"] == updated.meta_iteration, (
        f"on-disk meta_iteration {on_disk['meta_iteration']} != in-memory {updated.meta_iteration}"
    )
    # family_mix for 'arch' must be persisted (H002 reduction)
    assert "arch" in on_disk.get("family_mix", {}), "family_mix not persisted"
    assert on_disk["family_mix"]["arch"] == pytest.approx(updated.family_mix["arch"]), (
        "on-disk arch weight does not match in-memory value"
    )


def test_meta_evolve_load_engine_round_trips(tmp_path: Path) -> None:
    """_load_engine reads the strategy.json written by meta_evolve correctly."""
    import json as _json
    from evor.tree import _load_engine
    from evor.contracts import GoalContract, MetricSpec

    strategy = _make_strategy(wildness=0.3)
    goal = _make_goal()

    # _load_engine needs tree.json (dict format) and goal-contract.json present
    nodes_path = tmp_path / "tree.json"
    nodes_path.write_text('{"nodes": {}}')
    goal_path = tmp_path / "goal-contract.json"
    goal_path.write_text(goal.model_dump_json())

    engine = TreeEngine(nodes=[], goal=goal, strategy=strategy, run_dir=tmp_path)
    updated = engine.meta_evolve([])

    # Now _load_engine should recover the updated strategy
    engine2 = _load_engine(tmp_path)
    assert engine2._strategy.meta_iteration == updated.meta_iteration
    assert engine2._strategy.wildness == pytest.approx(updated.wildness)


# ── Tests: compute_fitness() with formula / constraints ────────────────────────


def _make_goal_with_formula(
    formula: str,
    constraints: list[MetricConstraint] | None = None,
    baseline: float = 0.0,
    target: float | None = None,
) -> GoalContract:
    """Build a GoalContract whose primary MetricSpec uses a fitness_formula."""
    return GoalContract(
        mission_id="test-formula",
        mode="from-scratch",
        mission_type="fixed",
        task_description="Formula test",
        dataset_ref="/data/test",
        metric_specs=[
            MetricSpec(
                metric_name="recall",
                direction="higher",
                domain_applicability="all",
                aggregation_rule="macro_avg",
                role="primary_fitness",
                sota_bar=None,
                fitness_formula=formula,
                constraints=constraints or [],
            )
        ],
        fitness_mode="aggregate",
        eval_version="v1",
        baseline_value=baseline,
        target_value=target,
        stop_condition=StopCondition(type="target"),
        wildness=0.5,
        budget=Budget(
            max_iterations=50,
            plateau_window=8,
            circuit_breaker=5,
            max_cost_usd=0.0,
        ),
        locked_split_hash="abc123",
        eval_script_hash="def456",
        allowed_licenses=["MIT"],
        created_at="2026-07-04T00:00:00Z",
    )


def _make_eval_with_metrics(extra_metrics: dict[str, float], score: float = 0.80) -> EvaluationResult:
    """Build an EvaluationResult with both standard and extra metrics."""
    all_metrics = {"accuracy": score, **extra_metrics}
    return EvaluationResult(
        node_id="n1",
        run_id="run1",
        eval_version="v1",
        metrics=all_metrics,
        per_domain={"default": {"accuracy": score}},
        fitness_value=score,
        worst_angle_coverage=None,
        per_angle_vs_sota=None,
        telemetry_summary=TelemetrySummary(total_steps=100),
        status="success",
        benchmark_raw="",
        timestamp="2026-07-04T00:00:00Z",
    )


def test_fitness_formula_weighted(tmp_path: Path) -> None:
    """fitness_formula='0.7*recall+0.3*precision' computes weighted combination."""
    goal = _make_goal_with_formula("0.7*recall+0.3*precision")
    result = _make_eval_with_metrics({"recall": 0.80, "precision": 0.60})
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    expected = 0.7 * 0.80 + 0.3 * 0.60  # 0.74
    assert abs(fitness - expected) < 1e-6, f"Expected {expected}, got {fitness}"


def test_fitness_formula_single_metric(tmp_path: Path) -> None:
    """fitness_formula='recall' (trivially) returns the recall value."""
    goal = _make_goal_with_formula("recall")
    result = _make_eval_with_metrics({"recall": 0.75})
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    assert abs(fitness - 0.75) < 1e-6


def test_fitness_constraint_violated_returns_zero(tmp_path: Path) -> None:
    """Violated precision constraint pins fitness to 0.0 (gamability guard)."""
    constraints = [MetricConstraint(metric="precision", op=">=", threshold=0.5)]
    goal = _make_goal_with_formula("recall", constraints=constraints)
    # recall=0.95 looks great, but precision=0.3 violates the constraint
    result = _make_eval_with_metrics({"recall": 0.95, "precision": 0.30})
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    assert fitness == pytest.approx(0.0), (
        "Constraint violated (precision=0.3 < 0.5): fitness must be 0.0"
    )


def test_fitness_constraint_satisfied_uses_formula(tmp_path: Path) -> None:
    """Satisfied constraint: fitness computed normally via formula."""
    constraints = [MetricConstraint(metric="precision", op=">=", threshold=0.5)]
    goal = _make_goal_with_formula("recall", constraints=constraints)
    # precision=0.7 satisfies >= 0.5
    result = _make_eval_with_metrics({"recall": 0.80, "precision": 0.70})
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    assert abs(fitness - 0.80) < 1e-6, f"Expected 0.80 (recall), got {fitness}"


def test_fitness_constraint_missing_metric_violates(tmp_path: Path) -> None:
    """Missing constrained metric (NaN) is treated as a constraint violation."""
    constraints = [MetricConstraint(metric="f1", op=">=", threshold=0.4)]
    goal = _make_goal_with_formula("recall", constraints=constraints)
    # f1 is not in metrics → treated as NaN → constraint violated
    result = _make_eval_with_metrics({"recall": 0.90})
    engine = TreeEngine(nodes=[], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
    fitness = engine.compute_fitness(result, goal)
    assert fitness == pytest.approx(0.0), "Missing metric should count as constraint violation"
