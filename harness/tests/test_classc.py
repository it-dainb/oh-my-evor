"""
tests/test_classc.py
Unit tests for Class-C backing tools (Areas 4 and 6 — harness side).

Coverage:
  Area 6:
    test_strategy_state_meta_evolve_fields    — StrategyState accepts new fields w/ defaults
    test_strategy_state_meta_evolve_reason_enum — only valid literals accepted
    test_strategy_state_backwards_compat      — old dict without new fields still validates

  Area 4 (check_stop_condition):
    test_stop_beat_baseline                  — best_score > baseline → should_stop=True
    test_stop_target                         — best_score >= target → should_stop=True
    test_stop_evolve_n                       — tick >= n → should_stop=True
    test_stop_evolve_n_not_yet               — tick < n → should_stop=False
    test_stop_maximize_under_budget_iters    — tick >= max_iterations → should_stop=True
    test_stop_maximize_under_budget_cost     — cost >= max_cost_usd → should_stop=True
    test_stop_plateau                        — last 3 scores within 0.5% → should_stop=True
    test_stop_plateau_not_enough_history     — < 3 scores → should_stop=False
    test_stop_regression                     — 2 consecutive regressions → should_stop=True
    test_stop_regression_only_one            — only 1 regression → should_stop=False
    test_stop_coverage_target                — coverage >= target → should_stop=True
    test_stop_circuit_breaker_overrides      — tick >= circuit_breaker → always True
    test_stop_no_condition_triggered         — nothing satisfied → should_stop=False
    test_stop_worst_angle_plateau            — plateau within plateau_window → should_stop=True
"""

from __future__ import annotations

import math
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from evor.contracts import (
    Budget,
    GoalContract,
    MetricSpec,
    StopCondition,
    StrategyState,
    TreeNode,
)
from evor.tree import StopVerdict, TreeEngine, check_stop_condition


# ── Fixture factories ─────────────────────────────────────────────────────────


def _make_budget(
    max_iterations: int = 50,
    plateau_window: int = 5,
    circuit_breaker: int = 100,
    max_cost_usd: float = 100.0,
) -> Budget:
    return Budget(
        max_iterations=max_iterations,
        plateau_window=plateau_window,
        circuit_breaker=circuit_breaker,
        max_cost_usd=max_cost_usd,
    )


def _make_goal(
    stop_type: str = "target",
    stop_n: int | None = None,
    baseline: float = 0.70,
    target: float | None = 0.90,
    coverage_target: float | None = None,
    mission_type: str = "fixed",
    budget: Budget | None = None,
) -> GoalContract:
    return GoalContract(
        mission_id="test-classc",
        mode="from-scratch",
        mission_type=mission_type,  # type: ignore[arg-type]
        task_description="Class-C test task",
        dataset_ref="/data/test",
        metric_specs=[
            MetricSpec(
                metric_name="accuracy",
                direction="higher",
                domain_applicability="all",
                aggregation_rule="macro_avg",
                role="primary_fitness",
            )
        ],
        fitness_mode="aggregate",
        eval_version="v1",
        baseline_value=baseline,
        target_value=target,
        coverage_target=coverage_target,
        stop_condition=StopCondition(type=stop_type, n=stop_n),  # type: ignore[arg-type]
        wildness=0.5,
        budget=budget or _make_budget(),
        allowed_licenses=["MIT"],
        created_at="2026-07-13T00:00:00Z",
    )


def _make_strategy() -> StrategyState:
    return StrategyState(
        meta_iteration=1,
        selection_policy="ucb1",
        ucb1_c=1.41,
        wildness=0.5,
        family_mix={"arch": 1.0, "training": 0.0, "data-curation": 0.0,
                    "data-augmentation": 0.0, "data-acquisition": 0.0,
                    "algo": 0.0, "other": 0.0},
        winning_families=[],
        wins_by_family={},
        meta_loop_interval=5,
        post_upgrade_exploration_boost=None,
        post_upgrade_exploration_ticks=0,
        rescore_mode="sync",
        updated_at="2026-07-13T00:00:00Z",
    )


def _make_node(
    node_id: str,
    score: float = 0.80,
    status: str = "done",
    fitness_value: float | None = None,
) -> TreeNode:
    return TreeNode(
        id=node_id,
        parent_ids=[],
        approach_family="arch",
        hypothesis_id="h-1",
        code_ref="code/",
        genome_ref="genome-ref",
        data_version_ref="data-v1",
        config={},
        metrics={"accuracy": score},
        eval_version="v1",
        fitness_value=fitness_value if fitness_value is not None else score,
        status=status,  # type: ignore[arg-type]
        integrity_status="passed",
        is_crossover=False,
        visit_count=1,
        depth=0,
        created_at="2026-07-13T00:00:00Z",
    )


def _make_engine(
    nodes: list[TreeNode] | None = None,
    goal: GoalContract | None = None,
    tmp_path: Path | None = None,
) -> TreeEngine:
    return TreeEngine(
        nodes=nodes or [],
        goal=goal or _make_goal(),
        strategy=_make_strategy(),
        run_dir=tmp_path or Path("/tmp"),
    )


def _run_state(
    tick: int = 0,
    best_score: float = 0.0,
    total_cost_usd: float = 0.0,
    tick_history: list[float] | None = None,
    worst_angle_coverage: float = 0.0,
) -> dict:
    return {
        "tick_count": tick,
        "best_score": best_score,
        "total_cost_usd": total_cost_usd,
        "tick_history_scores": tick_history or [],
        "worst_angle_coverage": worst_angle_coverage,
    }


# ── Area 6: StrategyState new fields ─────────────────────────────────────────


def test_strategy_state_meta_evolve_fields_defaults() -> None:
    """StrategyState with new fields defaults to meta_evolve_requested=False, reason=None."""
    s = StrategyState(
        meta_iteration=1,
        selection_policy="ucb1",
        ucb1_c=1.41,
        wildness=0.5,
        family_mix={"arch": 1.0},
        winning_families=[],
        wins_by_family={},
        meta_loop_interval=5,
        post_upgrade_exploration_boost=None,
        post_upgrade_exploration_ticks=0,
        rescore_mode="sync",
        updated_at="2026-07-13T00:00:00Z",
    )
    assert s.meta_evolve_requested is False
    assert s.meta_evolve_reason is None


def test_strategy_state_meta_evolve_requested_true() -> None:
    """StrategyState accepts meta_evolve_requested=True with a valid reason."""
    s = StrategyState(
        meta_iteration=1,
        selection_policy="ucb1",
        ucb1_c=1.41,
        wildness=0.5,
        family_mix={"arch": 1.0},
        winning_families=[],
        wins_by_family={},
        meta_loop_interval=5,
        post_upgrade_exploration_boost=None,
        post_upgrade_exploration_ticks=0,
        rescore_mode="sync",
        updated_at="2026-07-13T00:00:00Z",
        meta_evolve_requested=True,
        meta_evolve_reason="plateau",
    )
    assert s.meta_evolve_requested is True
    assert s.meta_evolve_reason == "plateau"


def test_strategy_state_meta_evolve_reason_all_literals() -> None:
    """All three valid reason literals are accepted."""
    for reason in ("plateau", "regression", "lock"):
        s = StrategyState(
            meta_iteration=1, selection_policy="ucb1", ucb1_c=1.41, wildness=0.5,
            family_mix={"arch": 1.0}, winning_families=[], wins_by_family={},
            meta_loop_interval=5, post_upgrade_exploration_boost=None,
            post_upgrade_exploration_ticks=0, rescore_mode="sync",
            updated_at="2026-07-13T00:00:00Z",
            meta_evolve_requested=True,
            meta_evolve_reason=reason,  # type: ignore[arg-type]
        )
        assert s.meta_evolve_reason == reason


def test_strategy_state_backwards_compat_old_dict() -> None:
    """Old strategy dict without meta_evolve_* fields still validates (backward compat)."""
    old_dict = {
        "meta_iteration": 2,
        "selection_policy": "ucb1",
        "ucb1_c": 1.41,
        "wildness": 0.5,
        "family_mix": {"arch": 1.0},
        "winning_families": [],
        "wins_by_family": {},
        "meta_loop_interval": 5,
        "post_upgrade_exploration_boost": None,
        "post_upgrade_exploration_ticks": 0,
        "rescore_mode": "sync",
        "updated_at": "2026-07-13T00:00:00Z",
    }
    s = StrategyState.model_validate(old_dict)
    assert s.meta_evolve_requested is False
    assert s.meta_evolve_reason is None


# ── Area 4: check_stop_condition ─────────────────────────────────────────────


def test_stop_beat_baseline(tmp_path: Path) -> None:
    """beat-baseline: best_score > baseline → should_stop=True."""
    goal = _make_goal(stop_type="beat-baseline", baseline=0.70, target=None)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=3, best_score=0.75)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "beat-baseline" in verdict.reason


def test_stop_beat_baseline_not_yet(tmp_path: Path) -> None:
    """beat-baseline: best_score <= baseline → should_stop=False."""
    goal = _make_goal(stop_type="beat-baseline", baseline=0.70, target=None)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=2, best_score=0.68)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is False


def test_stop_target(tmp_path: Path) -> None:
    """target: best_score >= target_value → should_stop=True."""
    goal = _make_goal(stop_type="target", baseline=0.70, target=0.90)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=5, best_score=0.91)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "target" in verdict.reason


def test_stop_target_not_yet(tmp_path: Path) -> None:
    """target: best_score < target_value → should_stop=False."""
    goal = _make_goal(stop_type="target", baseline=0.70, target=0.90)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=3, best_score=0.85)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is False


def test_stop_evolve_n(tmp_path: Path) -> None:
    """evolve-n: tick >= n → should_stop=True."""
    goal = _make_goal(stop_type="evolve-n", stop_n=10, target=None)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=10, best_score=0.80)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "evolve-n" in verdict.reason


def test_stop_evolve_n_not_yet(tmp_path: Path) -> None:
    """evolve-n: tick < n → should_stop=False."""
    goal = _make_goal(stop_type="evolve-n", stop_n=10, target=None)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=7, best_score=0.80)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is False


def test_stop_maximize_under_budget_iterations(tmp_path: Path) -> None:
    """maximize-under-budget: tick >= max_iterations → should_stop=True."""
    budget = _make_budget(max_iterations=20, circuit_breaker=100, max_cost_usd=500.0)
    goal = _make_goal(stop_type="maximize-under-budget", target=None, budget=budget)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=20, best_score=0.85, total_cost_usd=10.0)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "max_iterations" in verdict.reason


def test_stop_maximize_under_budget_cost(tmp_path: Path) -> None:
    """maximize-under-budget: cost >= max_cost_usd → should_stop=True."""
    budget = _make_budget(max_iterations=50, circuit_breaker=100, max_cost_usd=25.0)
    goal = _make_goal(stop_type="maximize-under-budget", target=None, budget=budget)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=5, best_score=0.80, total_cost_usd=30.0)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "max_cost_usd" in verdict.reason


def test_stop_plateau(tmp_path: Path) -> None:
    """evolve-until-plateau: last 3 scores within 0.5% spread → should_stop=True."""
    goal = _make_goal(stop_type="evolve-until-plateau", target=None)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    # Three nearly identical scores: spread << 0.5%
    history = [0.70, 0.75, 0.8000, 0.8001, 0.8002]
    state = _run_state(tick=5, best_score=0.8002, tick_history=history)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "plateau" in verdict.reason


def test_stop_plateau_not_enough_history(tmp_path: Path) -> None:
    """evolve-until-plateau: fewer than 3 ticks → should_stop=False."""
    goal = _make_goal(stop_type="evolve-until-plateau", target=None)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=2, best_score=0.80, tick_history=[0.78, 0.80])
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is False


def test_stop_regression(tmp_path: Path) -> None:
    """evolve-until-regression: 2 consecutive regressions → should_stop=True."""
    goal = _make_goal(stop_type="evolve-until-regression", target=None)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    # ...0.85, 0.84, 0.83 — each tick regresses
    history = [0.70, 0.80, 0.85, 0.84, 0.83]
    state = _run_state(tick=5, best_score=0.85, tick_history=history)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "regression" in verdict.reason


def test_stop_regression_only_one(tmp_path: Path) -> None:
    """evolve-until-regression: only 1 regression → should_stop=False."""
    goal = _make_goal(stop_type="evolve-until-regression", target=None)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    # 0.85 → 0.84 (one regression), 0.86 (recovery)
    history = [0.70, 0.80, 0.85, 0.84, 0.86]
    state = _run_state(tick=5, best_score=0.86, tick_history=history)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is False


def test_stop_coverage_target(tmp_path: Path) -> None:
    """coverage-target: worst_angle_coverage >= coverage_target → should_stop=True."""
    goal = _make_goal(
        stop_type="coverage-target", coverage_target=0.8, target=None, mission_type="open_ended"
    )
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=3, best_score=0.75, worst_angle_coverage=0.85)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "coverage" in verdict.reason


def test_stop_coverage_not_yet(tmp_path: Path) -> None:
    """coverage-target: coverage < target → should_stop=False."""
    goal = _make_goal(
        stop_type="coverage-target", coverage_target=0.8, target=None, mission_type="open_ended"
    )
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=3, best_score=0.70, worst_angle_coverage=0.65)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is False


def test_stop_circuit_breaker_overrides(tmp_path: Path) -> None:
    """circuit-breaker: tick >= circuit_breaker always stops, even if no other condition fires."""
    budget = _make_budget(max_iterations=50, circuit_breaker=10, max_cost_usd=1000.0)
    goal = _make_goal(stop_type="target", baseline=0.70, target=0.99, budget=budget)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    # best_score=0.50 would not trigger target; but circuit_breaker=10, tick=10
    state = _run_state(tick=10, best_score=0.50)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "circuit_breaker" in verdict.reason


def test_stop_no_condition_triggered(tmp_path: Path) -> None:
    """No stop condition fires when nothing is satisfied."""
    goal = _make_goal(stop_type="target", baseline=0.70, target=0.90)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=3, best_score=0.75)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is False
    assert verdict.tick_count == 3
    assert verdict.best_score == pytest.approx(0.75)


def test_stop_worst_angle_plateau(tmp_path: Path) -> None:
    """worst-angle-plateau: no improvement across plateau_window ticks → should_stop=True."""
    budget = _make_budget(plateau_window=3, circuit_breaker=100)
    goal = _make_goal(stop_type="worst-angle-plateau", target=None, budget=budget)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    # Last 3 ticks within 0.5% spread
    history = [0.70, 0.80, 0.8000, 0.8001, 0.8002]
    state = _run_state(tick=5, best_score=0.8002, tick_history=history)
    verdict = check_stop_condition(goal, state, engine)
    assert verdict.should_stop is True
    assert "plateau" in verdict.reason


def test_stop_verdict_budget_remaining(tmp_path: Path) -> None:
    """StopVerdict always includes budget_remaining with iterations_left and cost_left_usd."""
    budget = _make_budget(max_iterations=20, max_cost_usd=50.0, circuit_breaker=100)
    goal = _make_goal(stop_type="target", baseline=0.70, target=0.99, budget=budget)
    engine = _make_engine(goal=goal, tmp_path=tmp_path)
    state = _run_state(tick=5, best_score=0.75, total_cost_usd=10.0)
    verdict = check_stop_condition(goal, state, engine)
    assert "iterations_left" in verdict.budget_remaining
    assert "cost_left_usd" in verdict.budget_remaining
    assert verdict.budget_remaining["iterations_left"] == 15   # 20 - 5
    assert verdict.budget_remaining["cost_left_usd"] == pytest.approx(40.0)  # 50 - 10
