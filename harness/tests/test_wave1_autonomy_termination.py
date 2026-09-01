"""
test_wave1_autonomy_termination.py — Wave-2 RED tests, field-trace category 5.

Every test asserts the invariant the 19-hour field run violated. All are expected
to FAIL against this repo at bab279e; none asserts the buggy behaviour.

Findings covered (harness side):

  K-06  Nothing validates that the stop condition is reachable. The mission ran
        `stop_condition: coverage-target` / `coverage_target: 1.0` over an angle
        registry that held `"angles": []` in all three runs, with
        `circuit_breaker: 8` against `max_iterations: 200`.
  K-07  `budget.max_cost_usd: 0` is falsy, so the cost stop is skipped
        unconditionally. A value that reads "zero budget" silently means
        "unlimited". $217+ ran with no ceiling in effect.
  L-05  The launch-consent gate accepted a free-text contract mutation ("add a
        per domain precision score >= 0.8") with zero feasibility validation.
        The incumbent measured min-domain precision 0.0040 against that floor;
        every node scored 0.0 and it was discovered 26 hours later.
  L-02  The autonomy charter asserts "a monotonic move ALWAYS exists" and none
        did. The decision policy has no representable branch for its own
        infeasibility. Only the vocabulary is testable in code — see the test.
  C-01  The run never terminated, it was killed: run state read `running` days
        later, and r3's mission-state was 2h07m behind its own tick-state.

Entry point for the contract findings is `evor.validate.validate_run`, which is
the run-start validation the lane names ("`validate_run` already exists and
already checks `eval_script_hash` presence — extend it"). Each test asserts a
NAMED failing check rather than `report.ok`, so it cannot pass vacuously on some
unrelated failure of the fixture.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import pytest

from evor.contracts import (
    Budget,
    DecisionLogEntry,
    GoalContract,
    MetricConstraint,
    MetricSpec,
    StopCondition,
    StrategyState,
)
from evor.tree import TreeEngine, check_stop_condition
from evor.validate import ValidationReport, validate_run


# ─────────────────────────────────────────────────────────────────────────────
# Fixture factories
# ─────────────────────────────────────────────────────────────────────────────


def _contract_dict(**overrides: Any) -> dict:
    """A complete, schema-valid GoalContract as a dict, mirroring the field run."""
    base: dict[str, Any] = {
        "mission_id": "wave1-autonomy",
        "mode": "from-scratch",
        "mission_type": "open_ended",
        "task_description": "Binarize degraded palm-leaf manuscripts",
        "dataset_ref": "/data/binarization",
        "metric_specs": [
            {
                "metric_name": "fmeasure",
                "direction": "higher",
                "domain_applicability": "all",
                "aggregation_rule": "macro_avg",
                "role": "primary_fitness",
            }
        ],
        "fitness_mode": "worst-domain",
        "eval_version": "v1",
        "baseline_value": 0.5961,
        "target_value": None,
        "coverage_target": 1.0,
        "stop_condition": {"type": "coverage-target"},
        "wildness": 0.5,
        "budget": {
            "max_iterations": 200,
            "plateau_window": 5,
            "circuit_breaker": 200,
            "max_cost_usd": 100.0,
        },
        "framework": "pytorch",
        "locked_split_hash": "86c6462a" + "0" * 24,
        "eval_script_hash": "f123d17c" + "0" * 24,
        "allowed_licenses": ["MIT"],
        "created_at": "2026-08-23T08:12:54Z",
    }
    base.update(overrides)
    return base


def _write_run(
    tmp_path: Path,
    contract: dict | None = None,
    angles: list[dict] | None = None,
    **extra_files: Any,
) -> Path:
    """Build a run dir with the artifacts validate_run reads."""
    run_dir = tmp_path / "runs" / "wave1-autonomy" / "run-live-01"
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "goal-contract.json").write_text(json.dumps(contract or _contract_dict()))
    (run_dir / "tree.json").write_text(json.dumps({"nodes": {}}))
    (run_dir / "run-state.json").write_text(
        json.dumps(
            {
                "run_id": "run-live-01",
                "status": "running",
                "tick_count": 1,
                "frontier_ids": [],
                "best_score": None,
            }
        )
    )
    # A sealed frozen split, so the only failing checks are the ones under test.
    frozen = run_dir / "frozen-splits"
    frozen.mkdir(exist_ok=True)
    (frozen / "v1-test.json").write_text(
        json.dumps({"split_hash": "86c6462a" + "0" * 24, "samples": []})
    )
    (run_dir / "angle-registry.json").write_text(
        json.dumps(
            {
                "mission_id": "wave1-autonomy",
                "angles": angles if angles is not None else [],
                "updated_at": "2026-08-23T23:51:15Z",
            }
        )
    )
    for name, payload in extra_files.items():
        (run_dir / name.replace("__", ".").replace("_", "-")).write_text(json.dumps(payload))
    return run_dir


def _failing(report: ValidationReport) -> list[str]:
    """Names + details of every failing check, for readable assertion messages."""
    return [f"{c.name}: {c.detail}" for c in report.checks if not c.ok]


def _has_failing_check(report: ValidationReport, *keywords: str) -> bool:
    """True if some FAILING check mentions every keyword (name or detail)."""
    for c in report.checks:
        if c.ok:
            continue
        blob = f"{c.name} {c.detail}".lower()
        if all(k.lower() in blob for k in keywords):
            return True
    return False


# ─────────────────────────────────────────────────────────────────────────────
# K-06 — the stop condition must be reachable
# ─────────────────────────────────────────────────────────────────────────────


def test_k06_coverage_target_over_empty_angle_registry_is_rejected(tmp_path: Path) -> None:
    """coverage-target over an EMPTY angle registry has no reachable exit."""
    run_dir = _write_run(tmp_path, angles=[])
    report = validate_run(run_dir)
    assert _has_failing_check(report, "coverage"), (
        "validate_run accepted a coverage-target stop over an empty angle registry — "
        f"no reachable termination criterion. failing checks: {_failing(report)}"
    )


def test_k06_coverage_target_above_maximum_is_rejected(tmp_path: Path) -> None:
    """Coverage is a fraction in [0,1]; a target above 1.0 can never be met."""
    run_dir = _write_run(
        tmp_path,
        contract=_contract_dict(coverage_target=1.5),
        angles=[],
    )
    report = validate_run(run_dir)
    assert _has_failing_check(report, "coverage"), (
        "validate_run accepted coverage_target=1.5, which no run can ever reach. "
        f"failing checks: {_failing(report)}"
    )


def test_k06_circuit_breaker_below_max_iterations_is_flagged(tmp_path: Path) -> None:
    """circuit_breaker 8 vs max_iterations 200: the advertised budget is unreachable."""
    contract = _contract_dict(
        budget={
            "max_iterations": 200,
            "plateau_window": 5,
            "circuit_breaker": 8,
            "max_cost_usd": 100.0,
        }
    )
    report = validate_run(_write_run(tmp_path, contract=contract))
    assert _has_failing_check(report, "circuit_breaker"), (
        "validate_run accepted circuit_breaker=8 with max_iterations=200 — the run "
        f"is cut off at 4% of its stated budget. failing checks: {_failing(report)}"
    )


def test_k06_reachable_stop_condition_still_validates(tmp_path: Path) -> None:
    """Control: a coverage-target run with a registered angle raises no coverage failure."""
    contract = _contract_dict(coverage_target=1.0)
    run_dir = _write_run(
        tmp_path,
        contract=contract,
        angles=[
            {
                "angle_id": "palm-leaf",
                "name": "palm-leaf",
                "sota_bar": 0.80,
                "sources": [],
                "quorum_met": False,
                "last_probed_at": "2026-08-23T23:51:15Z",
            }
        ],
    )
    report = validate_run(run_dir)
    assert not _has_failing_check(report, "coverage"), (
        f"a reachable coverage target was flagged: {_failing(report)}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# K-07 — the cost ceiling must bind
# ─────────────────────────────────────────────────────────────────────────────


def test_k07_zero_cost_ceiling_is_rejected_at_validation(tmp_path: Path) -> None:
    """`max_cost_usd: 0` reads as "no budget" and silently means "unlimited"."""
    contract = _contract_dict(
        budget={
            "max_iterations": 200,
            "plateau_window": 5,
            "circuit_breaker": 200,
            "max_cost_usd": 0.0,
        }
    )
    report = validate_run(_write_run(tmp_path, contract=contract))
    assert _has_failing_check(report, "cost"), (
        "validate_run accepted max_cost_usd=0, which disables the spend ceiling "
        f"entirely. failing checks: {_failing(report)}"
    )


def _engine(goal: GoalContract, tmp_path: Path) -> TreeEngine:
    strategy = StrategyState(
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
        updated_at="2026-08-23T08:12:54Z",
    )
    return TreeEngine(nodes=[], goal=goal, strategy=strategy, run_dir=tmp_path)


def _goal_obj(**overrides: Any) -> GoalContract:
    return GoalContract.model_validate(_contract_dict(**overrides))


def test_k07_cost_ceiling_halts_run_regardless_of_stop_type(tmp_path: Path) -> None:
    """A spend ceiling is a ceiling under every stop type, not just maximize-under-budget."""
    goal = _goal_obj(
        stop_condition={"type": "target"},
        target_value=0.90,
        coverage_target=None,
        budget={
            "max_iterations": 200,
            "plateau_window": 5,
            "circuit_breaker": 200,
            "max_cost_usd": 10.0,
        },
    )
    state = {"tick_count": 3, "best_score": 0.1, "total_cost_usd": 250.0}
    verdict = check_stop_condition(goal, state, _engine(goal, tmp_path))
    assert verdict.should_stop is True, (
        f"spent $250 against a $10 ceiling and the run continued: {verdict.reason}"
    )


def test_k07_zero_ceiling_does_not_mean_unlimited_in_the_stop_path(tmp_path: Path) -> None:
    """`max_cost_usd: 0` must not be read as "spend anything"."""
    goal = _goal_obj(
        stop_condition={"type": "maximize-under-budget"},
        coverage_target=None,
        budget={
            "max_iterations": 200,
            "plateau_window": 5,
            "circuit_breaker": 200,
            "max_cost_usd": 0.0,
        },
    )
    state = {"tick_count": 1, "best_score": 0.0, "total_cost_usd": 217.70}
    verdict = check_stop_condition(goal, state, _engine(goal, tmp_path))
    assert verdict.should_stop is True, (
        f"$217.70 spent against max_cost_usd=0 and the run continued: {verdict.reason}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# L-05 — a gate added at init is validated against the measured baseline
# ─────────────────────────────────────────────────────────────────────────────


def _contract_with_precision_floor(threshold: float) -> dict:
    """The operator's consent-gate mutation, in its code representation.

    "add a per domain precision score >= 0.8" is a MetricConstraint on the
    primary spec: any violated constraint pins fitness to 0.0.
    """
    return _contract_dict(
        metric_specs=[
            {
                "metric_name": "fmeasure",
                "direction": "higher",
                "domain_applicability": "all",
                "aggregation_rule": "min",
                "role": "primary_fitness",
                "constraints": [
                    {"metric": "precision", "op": ">=", "threshold": threshold}
                ],
            }
        ]
    )


def test_l05_out_of_range_gate_threshold_is_rejected(tmp_path: Path) -> None:
    """A precision floor of 1.5 is unsatisfiable by construction — catch it at init."""
    run_dir = _write_run(tmp_path, contract=_contract_with_precision_floor(1.5))
    report = validate_run(run_dir)
    assert _has_failing_check(report, "constraint"), (
        "validate_run accepted a precision >= 1.5 gate that no candidate can ever "
        f"satisfy. failing checks: {_failing(report)}"
    )


def test_l05_gate_unsatisfiable_against_measured_baseline_is_rejected(tmp_path: Path) -> None:
    """The field case: incumbent min-domain precision 0.0040 against a 0.80 floor.

    The measured baseline is supplied as the incumbent's EvaluationResult in the
    run dir (`baseline-eval.json`). If GREEN sources the measurement elsewhere,
    this fixture moves — the invariant does not: a gate 200x above the measured
    incumbent must be flagged at init, not discovered 26 hours later.
    """
    run_dir = _write_run(tmp_path, contract=_contract_with_precision_floor(0.80))
    (run_dir / "baseline-eval.json").write_text(
        json.dumps(
            {
                "metrics": {"fmeasure": 0.5961, "precision": 0.0040},
                "per_domain": {
                    "palm-leaf": {"fmeasure": 0.4102, "precision": 0.0040},
                    "dibco": {"fmeasure": 0.7301, "precision": 0.0121},
                },
                "fitness_value": 0.0,
                "status": "success",
                "benchmark_raw": "incumbent baseline",
                "telemetry_summary": {
                    "epochs_completed": 0,
                    "final_train_loss": 0.0,
                    "final_val_loss": 0.0,
                    "grad_norm_mean": 0.0,
                    "early_stopped": False,
                },
            }
        )
    )
    report = validate_run(run_dir)
    assert _has_failing_check(report, "constraint"), (
        "validate_run accepted a per-domain precision >= 0.80 gate against a measured "
        "incumbent of 0.0040 — every node scores 0.0 and selection has no gradient. "
        f"failing checks: {_failing(report)}"
    )


def test_l05_satisfiable_gate_still_validates(tmp_path: Path) -> None:
    """Control: a gate the incumbent already clears must not be flagged."""
    run_dir = _write_run(tmp_path, contract=_contract_with_precision_floor(0.50))
    (run_dir / "baseline-eval.json").write_text(
        json.dumps(
            {
                "metrics": {"fmeasure": 0.5961, "precision": 0.71},
                "per_domain": {"palm-leaf": {"fmeasure": 0.41, "precision": 0.66}},
                "fitness_value": 0.41,
                "status": "success",
                "benchmark_raw": "incumbent baseline",
                "telemetry_summary": {
                    "epochs_completed": 0,
                    "final_train_loss": 0.0,
                    "final_val_loss": 0.0,
                    "grad_norm_mean": 0.0,
                    "early_stopped": False,
                },
            }
        )
    )
    report = validate_run(run_dir)
    assert not _has_failing_check(report, "constraint"), (
        f"a satisfiable gate was flagged: {_failing(report)}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# L-02 — the decision policy needs a branch for its own infeasibility
# ─────────────────────────────────────────────────────────────────────────────


def test_l02_decision_log_can_record_contract_infeasible() -> None:
    """When no monotonic move exists, the system must emit a specific signal.

    The charter ("a monotonic move ALWAYS exists") is prose on
    AutonomyCharter.invariant with no code branch. The one part that IS
    representable is the vocabulary: the decision log must be able to say
    "the contract is infeasible" instead of the agent silently asking a human.
    """
    entry = DecisionLogEntry.model_validate(
        {
            "timestamp": "2026-08-24T01:37:45Z",
            "tick": 1,
            "decision_type": "contract-infeasible",
            "rationale": (
                "per-domain precision floor >= 0.80 zeroes fitness for every node; "
                "no monotonic move exists"
            ),
            "node_ids": [],
        }
    )
    assert entry.decision_type == "contract-infeasible"


# ─────────────────────────────────────────────────────────────────────────────
# C-01 — a run with no recent activity is stale, not running
# ─────────────────────────────────────────────────────────────────────────────


def _backdate(path: Path, hours: float) -> None:
    stamp = time.time() - hours * 3600
    os.utime(path, (stamp, stamp))


def test_c01_stale_run_is_not_reported_as_running(tmp_path: Path) -> None:
    """A run whose last activity is hours old must be reported stale, not running."""
    run_dir = _write_run(tmp_path)
    (run_dir / "tick-state.json").write_text(
        json.dumps(
            {"tick": 1, "current_step": 9, "step_status": "running", "integrity_verdict": "failed"}
        )
    )
    for name in ("run-state.json", "tick-state.json", "mission-state.json"):
        p = run_dir / name
        if not p.exists():
            p.write_text(json.dumps({"status": "running", "tick": 1}))
        _backdate(p, 8.0)

    report = validate_run(run_dir)
    assert _has_failing_check(report, "stale"), (
        "run-state still reads status=running after 8h of no activity and validate_run "
        f"reported it clean. failing checks: {_failing(report)}"
    )


def test_c01_mission_state_lagging_tick_state_is_flagged(tmp_path: Path) -> None:
    """r3's mission-state was 2h07m behind its own tick-state and nothing noticed."""
    run_dir = _write_run(tmp_path)
    (run_dir / "mission-state.json").write_text(json.dumps({"status": "running", "tick": None}))
    (run_dir / "tick-state.json").write_text(
        json.dumps({"tick": 1, "current_step": 9, "step_status": "running"})
    )
    _backdate(run_dir / "mission-state.json", 2.2)

    report = validate_run(run_dir)
    assert _has_failing_check(report, "mission_state"), (
        "mission-state.json lags tick-state.json by 2h07m and validate_run reported it "
        f"clean. failing checks: {_failing(report)}"
    )


def test_c01_fresh_run_is_not_flagged_stale(tmp_path: Path) -> None:
    """Control: an actively-ticking run must not be called stale."""
    run_dir = _write_run(tmp_path)
    (run_dir / "tick-state.json").write_text(
        json.dumps({"tick": 1, "current_step": 3, "step_status": "running"})
    )
    (run_dir / "mission-state.json").write_text(json.dumps({"status": "running", "tick": 1}))
    report = validate_run(run_dir)
    assert not _has_failing_check(report, "stale"), (
        f"a live run was flagged stale: {_failing(report)}"
    )
