"""
harness/tests/test_validate.py — Unit tests for evor.validate (Phase 2).

Coverage:
  - valid contract passes (all checks green)
  - missing required field fails
  - gameable recall-only metric without guard: flagged by BOTH rule-registry AND probe
  - F1 metric: passes both layers
  - guarded recall (precision constraint): passes both layers
  - locked/draft mission-state transitions
  - frozen-split hash checks
  - tree.json DICT vs LIST format
  - run-state.json well-formed check
  - validate CLI exits 0 on valid, 1 on invalid
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from evor.validate import (
    CheckResult,
    ValidationReport,
    _check_gameability_probe,
    _check_gameability_registry,
    probe_metric_gameability,
    validate_run,
)
from evor.contracts import GoalContract, MetricSpec, MetricConstraint


# ── Item 6.1 / R-08: a run may not start before its machine is measured ──────
#
# `run_init_run` now refuses when `.evor/capability.json` is absent or stale:
# the field run began 26 minutes BEFORE its own capability probe, so its sizing
# decisions preceded the measurement they depend on.
#
# These tests are about what init WRITES, not about probe policy, so they get a
# probe. Fixture migration only — no assertion changes.
@pytest.fixture(autouse=True)
def _seed_capability_probe(tmp_path):
    import json as _json
    from datetime import datetime, timezone

    evor_root = tmp_path / ".evor"
    evor_root.mkdir(parents=True, exist_ok=True)
    (evor_root / "capability.json").write_text(_json.dumps({
        "gpu_arch": None, "gpu_name": None, "vram_gb": None,
        "supported_dtypes": ["fp32"], "available_libs": [],
        "cuda_version": None, "cpu_only": True,
        "probed_at": datetime.now(timezone.utc).isoformat(),
        "source": "probe",
    }))
    return evor_root


_PYTHON = sys.executable
_HARNESS_DIR = Path(__file__).resolve().parent.parent


# ─── Fixture helpers ───────────────────────────────────────────────────────────

def _minimal_run_dir(tmp_path: Path, *, mission_type: str = "fixed") -> Path:
    """Build a minimal valid run directory and return it."""
    run_dir = tmp_path / "runs" / "test-mission" / "run-test-001"
    run_dir.mkdir(parents=True, exist_ok=True)

    # goal-contract.json — valid contract with accuracy (non-gameable)
    gc = {
        "mission_id": "test-mission",
        "mode": "from-scratch",
        "mission_type": mission_type,
        "task_description": "Test task",
        "dataset_ref": "/data/test",
        "metric_specs": [
            {
                "metric_name": "accuracy",
                "direction": "higher",
                "domain_applicability": "all",
                "aggregation_rule": "macro_avg",
                "role": "primary_fitness",
                "sota_bar": None,
            }
        ],
        "fitness_mode": "aggregate",
        "eval_version": "v1",
        "baseline_value": 0.70,
        "target_value": 0.85,
        "stop_condition": {"type": "target"},
        "wildness": 0.5,
        "budget": {
            # Item 9.3 / K-06 + K-07 made both of these checkable, and the old
            # values encoded exactly what the checks now reject:
            #
            #   circuit_breaker=3 with max_iterations=20 — `check_stop_condition`
            #     tests `tick >= circuit_breaker`, so it is a hard TICK CAP, not a
            #     consecutive-failure counter. The run stopped at tick 3 and the
            #     other 17 iterations were budget it could never spend.
            #
            #   max_cost_usd=0.0 — read as UNLIMITED by the stop path, which is
            #     the opposite of what setting a ceiling to zero means, and is why
            #     $217.70 went out under a contract that declared one.
            #
            # Fixture migration only; no assertion changed.
            "max_iterations": 20,
            "plateau_window": 5,
            "circuit_breaker": 20,
            "max_cost_usd": 50.0,
        },
        "framework": "pytorch",
        "seed_repo_path": None,
        "locked_split_hash": "abc123deadbeef",
        "eval_script_hash": "def456cafebabe",
        "expansion_policy": None,
        "allowed_licenses": ["MIT", "Apache-2.0"],
        "created_at": "2026-07-04T00:00:00Z",
    }
    (run_dir / "goal-contract.json").write_text(json.dumps(gc))

    # frozen-splits
    frozen_dir = run_dir / "frozen-splits"
    frozen_dir.mkdir()
    test_split_dir = frozen_dir / "v1-test"
    test_split_dir.mkdir()
    per_sample = {"0": hashlib.sha256(b"s0").hexdigest(), "1": hashlib.sha256(b"s1").hexdigest()}
    sorted_keys = sorted(per_sample.keys())
    split_hash = hashlib.sha256(
        json.dumps(sorted_keys).encode() + json.dumps([per_sample[k] for k in sorted_keys]).encode()
    ).hexdigest()
    (frozen_dir / "v1-test.json").write_text(json.dumps({
        "split_id": "test-split",
        "mission_id": "test-mission",
        "split_type": "test",
        "split_hash": split_hash,
        "per_sample_hashes": per_sample,
        "item_count": 2,
        "frozen_at": "2026-07-04T00:00:00Z",
        "storage_path": str(frozen_dir / "v1-test.json"),
        "eval_version": "v1",
    }))

    # tree.json — DICT format
    (run_dir / "tree.json").write_text(json.dumps({
        "nodes": {},
        "updated_at": "2026-07-04T00:00:00Z",
    }))

    # run-state.json
    (run_dir / "run-state.json").write_text(json.dumps({
        "status": "running",
        "tick_count": 0,
        "best_score": None,
        "frontier_ids": [],
        "current_eval_version": "v1",
        "hypotheses": [],
    }))

    return run_dir


def _with_labels(run_dir: Path, labels: list[int]) -> Path:
    """Write a labels.json into the frozen-splits test dir so the probe can run."""
    test_dir = run_dir / "frozen-splits" / "v1-test"
    test_dir.mkdir(parents=True, exist_ok=True)
    (test_dir / "labels.json").write_text(json.dumps({
        "format": "binary_classification",
        "labels": labels,
        "positive_class": 1,
    }))
    return run_dir


def _goal_with_spec(tmp_path: Path, spec: dict, *, target: float = 0.85) -> Path:
    """Return a run_dir whose goal-contract has the given metric_spec."""
    run_dir = _minimal_run_dir(tmp_path)
    gc_path = run_dir / "goal-contract.json"
    gc = json.loads(gc_path.read_text())
    gc["metric_specs"] = [spec]
    gc["target_value"] = target
    gc_path.write_text(json.dumps(gc))
    return run_dir


# ─── 1. Valid contract — all checks pass ──────────────────────────────────────

def test_valid_contract_passes(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    report = validate_run(run_dir)
    assert report.ok, f"Expected VALID but got: {report.verdict}\nFailed checks: {[c for c in report.checks if not c.ok]}"


def test_check_details_do_not_leak_paths_or_filenames(tmp_path: Path) -> None:
    """F3: report details must be name-only — no absolute .evor paths or internal filenames.

    The report is agent-facing; a stray absolute run path or a raw state filename
    (goal-contract.json, tree.json, run-state.json, v1-test.json) is an internal
    -implementation leak. Assert every check detail is clean, on both the pass path
    and a fail path (missing frozen splits, which exercises the failure details).
    """
    banned_substrings = (
        str(tmp_path),          # absolute run directory
        ".evor/",               # internal state root
        "goal-contract.json",
        "run-state.json",
        "tree.json",
        "-test.json",           # frozen split filename shape (e.g. v1-test.json)
    )

    # Pass path — all files present.
    ok_report = validate_run(_minimal_run_dir(tmp_path / "ok"))
    # Fail path — remove frozen splits to fire the failure-branch details.
    fail_dir = _minimal_run_dir(tmp_path / "fail")
    shutil.rmtree(fail_dir / "frozen-splits")
    fail_report = validate_run(fail_dir)

    for report in (ok_report, fail_report):
        for check in report.checks:
            for banned in banned_substrings:
                assert banned not in check.detail, (
                    f"check {check.name!r} leaked {banned!r} in detail: {check.detail!r}"
                )


# ─── 2. Missing required field fails ─────────────────────────────────────────

def test_missing_task_description_fails(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    gc_path = run_dir / "goal-contract.json"
    gc = json.loads(gc_path.read_text())
    gc["task_description"] = ""
    gc_path.write_text(json.dumps(gc))

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "goal_contract_required_fields" in failed_names


def test_empty_metric_specs_fails(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    gc_path = run_dir / "goal-contract.json"
    gc = json.loads(gc_path.read_text())
    gc["metric_specs"] = []
    gc_path.write_text(json.dumps(gc))

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "goal_contract_required_fields" in failed_names


def test_null_stop_condition_fails_at_schema_level(tmp_path: Path) -> None:
    """GoalContract.stop_condition is non-Optional so null fails Pydantic validation."""
    run_dir = _minimal_run_dir(tmp_path)
    gc_path = run_dir / "goal-contract.json"
    gc = json.loads(gc_path.read_text())
    gc["stop_condition"] = None  # strict Pydantic: not nullable
    gc_path.write_text(json.dumps(gc))

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    # Pydantic strict validation fires before the custom stop-condition check
    assert "goal_contract_schema" in failed_names


# ─── 3. Gameable recall-only metric: flagged by BOTH registry AND probe ────────

def test_recall_only_no_guard_flagged_by_registry(tmp_path: Path) -> None:
    """Rule-registry layer: recall alone without constraint/formula fails."""
    recall_spec = {
        "metric_name": "recall",
        "direction": "higher",
        "domain_applicability": "all",
        "aggregation_rule": "macro_avg",
        "role": "primary_fitness",
        "sota_bar": None,
    }
    run_dir = _goal_with_spec(tmp_path, recall_spec)

    report = validate_run(run_dir)
    assert not report.ok, "recall-only without guard should fail validation"
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "metric_gameability_registry" in failed_names, (
        f"Expected metric_gameability_registry to fail. Got failed: {failed_names}"
    )


def test_recall_only_no_guard_flagged_by_probe(tmp_path: Path) -> None:
    """Empirical probe layer: all-positive achieves recall=1 on ANY label vector."""
    recall_spec = {
        "metric_name": "recall",
        "direction": "higher",
        "domain_applicability": "all",
        "aggregation_rule": "macro_avg",
        "role": "primary_fitness",
        "sota_bar": None,
    }
    run_dir = _goal_with_spec(tmp_path, recall_spec, target=0.85)
    # Add labels so the probe actually runs (5 samples: 3 pos, 2 neg)
    _with_labels(run_dir, [1, 0, 1, 0, 1])

    gc = GoalContract.model_validate(json.loads((run_dir / "goal-contract.json").read_text()))
    result = probe_metric_gameability(gc, run_dir)

    assert not result["skipped"], "probe should run when labels.json is present"
    assert result["gameable"], (
        f"all-positive should achieve recall=1.0 and flag as gameable. Got: {result}"
    )
    assert result["worst_cheater"] is not None
    assert "all-positive" in result["worst_cheater"]
    assert result["layer"] == "probe"


def test_recall_only_flagged_in_full_validation_with_labels(tmp_path: Path) -> None:
    """Full validation pipeline: recall-only fails BOTH registry and probe layers."""
    recall_spec = {
        "metric_name": "recall",
        "direction": "higher",
        "domain_applicability": "all",
        "aggregation_rule": "macro_avg",
        "role": "primary_fitness",
        "sota_bar": None,
    }
    run_dir = _goal_with_spec(tmp_path, recall_spec, target=0.85)
    _with_labels(run_dir, [1, 0, 1, 0, 1])

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "metric_gameability_registry" in failed_names
    assert "metric_gameability_probe" in failed_names, (
        f"Expected both registry and probe to fail. Got failed: {failed_names}"
    )


# ─── 4. F1 metric passes both layers ──────────────────────────────────────────

def test_f1_metric_passes(tmp_path: Path) -> None:
    f1_spec = {
        "metric_name": "f1",
        "direction": "higher",
        "domain_applicability": "all",
        "aggregation_rule": "macro_avg",
        "role": "primary_fitness",
        "sota_bar": None,
    }
    run_dir = _goal_with_spec(tmp_path, f1_spec)
    _with_labels(run_dir, [1, 0, 1, 0, 1])

    report = validate_run(run_dir)
    # f1 is not in the gameable registry and is not trivially gamed
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "metric_gameability_registry" not in failed_names, (
        f"f1 should not be flagged by registry. Got failed: {failed_names}"
    )
    assert "metric_gameability_probe" not in failed_names, (
        f"f1 should not be flagged by probe. Got failed: {failed_names}"
    )


# ─── 5. Guarded recall (precision constraint) passes ─────────────────────────

def test_recall_with_precision_constraint_passes_registry(tmp_path: Path) -> None:
    """recall + precision>=0.5 constraint passes the rule-registry layer."""
    guarded_spec = {
        "metric_name": "recall",
        "direction": "higher",
        "domain_applicability": "all",
        "aggregation_rule": "macro_avg",
        "role": "primary_fitness",
        "sota_bar": None,
        "constraints": [{"metric": "precision", "op": ">=", "threshold": 0.85}],
    }
    run_dir = _goal_with_spec(tmp_path, guarded_spec)

    report = validate_run(run_dir)
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "metric_gameability_registry" not in failed_names, (
        f"Guarded recall should pass registry. Failed: {failed_names}"
    )


def test_recall_with_formula_passes_registry(tmp_path: Path) -> None:
    """recall with fitness_formula (composite) passes the rule-registry layer."""
    formula_spec = {
        "metric_name": "recall",
        "direction": "higher",
        "domain_applicability": "all",
        "aggregation_rule": "macro_avg",
        "role": "primary_fitness",
        "sota_bar": None,
        "fitness_formula": "0.7*recall+0.3*precision",
    }
    run_dir = _goal_with_spec(tmp_path, formula_spec)

    report = validate_run(run_dir)
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "metric_gameability_registry" not in failed_names, (
        f"Recall with formula guard should pass registry. Failed: {failed_names}"
    )


# ─── 6. Locked/draft mission-state transitions ────────────────────────────────

def test_validate_report_is_valid_with_locked_mission_state(tmp_path: Path) -> None:
    """validate_run succeeds regardless of mission-state.json (it doesn't check it)."""
    run_dir = _minimal_run_dir(tmp_path)
    # Write a locked mission-state.json
    (run_dir / "mission-state.json").write_text(json.dumps({
        "status": "locked",
        "current_tick": 0,
        "max_ticks": 20,
        "best_score": None,
        "best_node_id": None,
        "started_at": "2026-07-04T00:00:00Z",
        "updated_at": "2026-07-04T00:00:00Z",
    }))
    report = validate_run(run_dir)
    assert report.ok, f"validate_run should succeed with a valid run: {report.verdict}"


# ─── 7. Frozen-split checks ───────────────────────────────────────────────────

def test_missing_frozen_splits_dir_fails(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    import shutil
    shutil.rmtree(run_dir / "frozen-splits")

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "frozen_splits_dir" in failed_names


def test_frozen_split_missing_hash_fails(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    # Overwrite the test split JSON to remove split_hash
    frozen_dir = run_dir / "frozen-splits"
    for test_json in frozen_dir.glob("*-test.json"):
        data = json.loads(test_json.read_text())
        data["split_hash"] = ""
        test_json.write_text(json.dumps(data))

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "frozen_splits_hash" in failed_names


# ─── 8. Tree format ──────────────────────────────────────────────────────────

def test_list_format_tree_fails(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    # Write legacy LIST format
    (run_dir / "tree.json").write_text(json.dumps({"nodes": [], "updated_at": "..."}))

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "tree_json_dict_format" in failed_names


def test_dict_format_tree_passes(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    (run_dir / "tree.json").write_text(json.dumps({"nodes": {}, "updated_at": "..."}))
    report = validate_run(run_dir)
    check = next(c for c in report.checks if c.name == "tree_json_dict_format")
    assert check.ok


# ─── 9. run-state.json ───────────────────────────────────────────────────────

def test_run_state_missing_fields_fails(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    (run_dir / "run-state.json").write_text(json.dumps({"status": "running"}))

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "run_state_well_formed" in failed_names


# ─── 10. CLI invocation ──────────────────────────────────────────────────────

def test_validate_cli_exits_0_on_valid(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    result = subprocess.run(
        [_PYTHON, "-m", "evor", "validate", "--run-id", str(run_dir)],
        capture_output=True, text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0, (
        f"validate CLI should exit 0 on valid contract.\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )
    data = json.loads(result.stdout)
    assert data["ok"] is True


def test_validate_cli_exits_1_on_invalid(tmp_path: Path) -> None:
    run_dir = _minimal_run_dir(tmp_path)
    # Break the tree format
    (run_dir / "tree.json").write_text(json.dumps({"nodes": [], "updated_at": "..."}))

    result = subprocess.run(
        [_PYTHON, "-m", "evor", "validate", "--run-id", str(run_dir)],
        capture_output=True, text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 1, (
        f"validate CLI should exit 1 on invalid contract.\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )
    data = json.loads(result.stdout)
    assert data["ok"] is False


def test_validate_cli_help(tmp_path: Path) -> None:
    result = subprocess.run(
        [_PYTHON, "-m", "evor", "validate", "--help"],
        capture_output=True, text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0
    assert "run-id" in result.stdout.lower() or "run_id" in result.stdout.lower()


def test_doctor_cli_help(tmp_path: Path) -> None:
    result = subprocess.run(
        [_PYTHON, "-m", "evor", "doctor", "--help"],
        capture_output=True, text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0


# ─── 11. Probe detail verification ───────────────────────────────────────────

def test_probe_skipped_when_no_labels(tmp_path: Path) -> None:
    """Probe is skipped (not failed) when no labels.json exists."""
    recall_spec = {
        "metric_name": "recall",
        "direction": "higher",
        "domain_applicability": "all",
        "aggregation_rule": "macro_avg",
        "role": "primary_fitness",
        "sota_bar": None,
    }
    run_dir = _goal_with_spec(tmp_path, recall_spec)
    # Do NOT write labels.json

    gc = GoalContract.model_validate(json.loads((run_dir / "goal-contract.json").read_text()))
    result = probe_metric_gameability(gc, run_dir)
    assert result["skipped"] is True


def test_probe_all_positive_recall_gameable(tmp_path: Path) -> None:
    """Empirical probe: all-positive achieves recall=1.0 on any label set."""
    recall_spec = {
        "metric_name": "recall",
        "direction": "higher",
        "domain_applicability": "all",
        "aggregation_rule": "macro_avg",
        "role": "primary_fitness",
        "sota_bar": None,
    }
    run_dir = _goal_with_spec(tmp_path, recall_spec, target=0.85)
    _with_labels(run_dir, [0, 0, 1, 0, 1, 1, 0])  # minority positive

    gc = GoalContract.model_validate(json.loads((run_dir / "goal-contract.json").read_text()))
    result = probe_metric_gameability(gc, run_dir)

    assert not result["skipped"]
    assert result["gameable"]
    assert result["worst_cheater"] is not None
    # The worst cheater should achieve recall near 1.0
    assert result["score"] is not None
    assert result["score"] >= 0.9 * 0.85, f"Expected score near target: {result['score']}"


# ─── 12. Integrity anchor checks ─────────────────────────────────────────────

def test_missing_split_anchor_fails(tmp_path: Path) -> None:
    """validate_run must fail when locked_split_hash is None/missing."""
    run_dir = _minimal_run_dir(tmp_path)
    gc_path = run_dir / "goal-contract.json"
    gc = json.loads(gc_path.read_text())
    gc["locked_split_hash"] = None
    gc_path.write_text(json.dumps(gc))

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "goal_contract_split_anchor" in failed_names


def test_missing_eval_anchor_fails(tmp_path: Path) -> None:
    """validate_run must fail when eval_script_hash is None/missing."""
    run_dir = _minimal_run_dir(tmp_path)
    gc_path = run_dir / "goal-contract.json"
    gc = json.loads(gc_path.read_text())
    gc["eval_script_hash"] = None
    gc_path.write_text(json.dumps(gc))

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "goal_contract_eval_anchor" in failed_names


def test_both_anchors_missing_fails_both_checks(tmp_path: Path) -> None:
    """Both anchor checks fire independently when both are None."""
    run_dir = _minimal_run_dir(tmp_path)
    gc_path = run_dir / "goal-contract.json"
    gc = json.loads(gc_path.read_text())
    gc["locked_split_hash"] = None
    gc["eval_script_hash"] = None
    gc_path.write_text(json.dumps(gc))

    report = validate_run(run_dir)
    assert not report.ok
    failed_names = {c.name for c in report.checks if not c.ok}
    assert "goal_contract_split_anchor" in failed_names
    assert "goal_contract_eval_anchor" in failed_names


def test_both_anchors_present_pass(tmp_path: Path) -> None:
    """validate_run passes when both anchors are non-empty strings."""
    run_dir = _minimal_run_dir(tmp_path)
    # _minimal_run_dir already sets both anchors to non-empty strings
    report = validate_run(run_dir)
    assert report.ok
    passed_names = {c.name for c in report.checks if c.ok}
    assert "goal_contract_split_anchor" in passed_names
    assert "goal_contract_eval_anchor" in passed_names


def test_probe_accuracy_not_gameable(tmp_path: Path) -> None:
    """Accuracy with balanced classes is not trivially gameable."""
    acc_spec = {
        "metric_name": "accuracy",
        "direction": "higher",
        "domain_applicability": "all",
        "aggregation_rule": "macro_avg",
        "role": "primary_fitness",
        "sota_bar": None,
    }
    run_dir = _goal_with_spec(tmp_path, acc_spec, target=0.85)
    # Balanced classes: majority-class accuracy = 0.5, not near target 0.85
    _with_labels(run_dir, [0, 1, 0, 1, 0, 1, 0, 1])

    gc = GoalContract.model_validate(json.loads((run_dir / "goal-contract.json").read_text()))
    result = probe_metric_gameability(gc, run_dir)

    assert not result["skipped"]
    # accuracy=0.5 from all-positive is well below 0.9*0.85=0.765
    assert not result["gameable"], (
        f"balanced accuracy should not be gameable. Got: {result}"
    )
