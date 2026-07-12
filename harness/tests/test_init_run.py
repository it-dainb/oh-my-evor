"""
harness/tests/test_init_run.py — Tests for evor init-run (harness CLI + init_run module).

Coverage:
  Unit (run_init_run):
    test_valid_answers_writes_all_7_artifacts  — all 7 paths exist after a valid call
    test_goal_contract_reloads_valid           — goal-contract.json round-trips as GoalContract
    test_autonomy_charter_defaulted            — omitting autonomy_charter fills the default
    test_mission_state_status_is_draft         — mission-state.json status == "draft"
    test_active_run_points_at_run_dir          — active-run.json run_dir matches run_dir
    test_run_id_arg_overrides_auto             — explicit --run-id is respected
    test_mission_id_arg_overrides_answers      — --mission-id overrides answers.mission_id
    test_evor_root_controls_active_run_path    — active-run.json lands in evor_root, not run_dir
    test_run_dir_arg_overrides_default         — explicit --run-dir is respected

  Error path (invalid answers):
    test_invalid_answers_exits_1               — missing required field → exit 1
    test_invalid_answers_error_on_stdout       — {"error":...} printed to stdout
    test_invalid_answers_no_partial_artifact   — goal-contract.json NOT written on failure
    test_bad_mode_literal_exits_1              — bad Literal value → exit 1

  CLI subprocess (cwd=_HARNESS_DIR, mirrors test_gotchas pattern):
    test_cli_valid_exits_0                     — subprocess exits 0, stdout ok:true
    test_cli_invalid_exits_1                   — subprocess exits 1, stdout has error key
    test_cli_help_exits_0                      — --help exits 0
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from evor.contracts import AutonomyCharter, GoalContract
from evor.init_run import run_init_run

# Portable harness dir — works on host and inside container.
_HARNESS_DIR = Path(__file__).resolve().parent.parent
_PYTHON = sys.executable


# ─────────────────────────────────────────────────────────────────────────────
# Shared fixture helpers
# ─────────────────────────────────────────────────────────────────────────────

def _minimal_answers() -> dict:
    """Return a complete, valid GoalContract answers dict."""
    return {
        "mission_id": "test-mission",
        "mode": "from-scratch",
        "mission_type": "fixed",
        "task_description": "Classify images into 10 categories",
        "dataset_ref": "/data/cifar10",
        "metrics": [{"name": "accuracy", "direction": "higher", "primary": True}],
        "metric_specs": [
            {
                "metric_name": "accuracy",
                "direction": "higher",
                "domain_applicability": "all",
                "aggregation_rule": "macro_avg",
                "role": "primary_fitness",
            }
        ],
        "fitness_mode": "aggregate",
        "eval_version": "v1",
        "baseline_value": 0.70,
        "target_value": 0.85,
        "coverage_target": None,
        "stop_condition": {"type": "target"},
        "wildness": 0.5,
        "budget": {
            "max_iterations": 20,
            "plateau_window": 5,
            "circuit_breaker": 3,
            "max_cost_usd": 50.0,
        },
        "framework": "pytorch",
        "seed_repo_path": None,
        "locked_split_hash": "abc123deadbeef",
        "eval_script_hash": "def456cafebabe",
        "expansion_policy": None,
        "allowed_licenses": ["MIT", "Apache-2.0"],
        "evolution_bounds": None,
        "autonomy_charter": None,
        "created_at": "2026-07-06T00:00:00+00:00",
    }


def _write_answers(tmp_path: Path, answers: dict) -> Path:
    """Write answers dict to a temp JSON file and return its path."""
    p = tmp_path / "answers.json"
    p.write_text(json.dumps(answers))
    return p


# ─────────────────────────────────────────────────────────────────────────────
# 1. All 7 artifacts written on valid input
# ─────────────────────────────────────────────────────────────────────────────

def test_valid_answers_writes_all_7_artifacts(tmp_path: Path) -> None:
    answers_path = _write_answers(tmp_path, _minimal_answers())
    evor_root = tmp_path / ".evor"

    rc = run_init_run(
        str(answers_path),
        run_id_arg="run-fixed",
        evor_root_arg=str(evor_root),
    )
    assert rc == 0

    run_dir = evor_root / "runs" / "test-mission" / "run-fixed"
    for name in (
        "goal-contract.json",
        "run-state.json",
        "strategy.json",
        "tree.json",
        "mission-state.json",
        "decision-log.md",
    ):
        assert (run_dir / name).exists(), f"Missing artifact: {name}"

    assert (evor_root / "active-run.json").exists(), "Missing active-run.json in evor_root"


# ─────────────────────────────────────────────────────────────────────────────
# 2. goal-contract.json round-trips as a valid GoalContract
# ─────────────────────────────────────────────────────────────────────────────

def test_goal_contract_reloads_valid(tmp_path: Path) -> None:
    answers_path = _write_answers(tmp_path, _minimal_answers())
    evor_root = tmp_path / ".evor"

    rc = run_init_run(str(answers_path), run_id_arg="run-reload", evor_root_arg=str(evor_root))
    assert rc == 0

    gc_path = evor_root / "runs" / "test-mission" / "run-reload" / "goal-contract.json"
    contract = GoalContract.model_validate_json(gc_path.read_text())
    assert contract.mission_id == "test-mission"
    assert contract.baseline_value == pytest.approx(0.70)


# ─────────────────────────────────────────────────────────────────────────────
# 3. autonomy_charter defaulted when omitted from answers
# ─────────────────────────────────────────────────────────────────────────────

def test_autonomy_charter_defaulted(tmp_path: Path) -> None:
    answers = _minimal_answers()
    del answers["autonomy_charter"]  # omit entirely

    answers_path = _write_answers(tmp_path, answers)
    evor_root = tmp_path / ".evor"

    rc = run_init_run(str(answers_path), run_id_arg="run-charter", evor_root_arg=str(evor_root))
    assert rc == 0

    gc_path = evor_root / "runs" / "test-mission" / "run-charter" / "goal-contract.json"
    gc = json.loads(gc_path.read_text())
    charter = gc.get("autonomy_charter")
    assert charter is not None, "autonomy_charter should be defaulted, not null"
    assert charter["posture"] == "aggressive-never-halt"
    assert charter["license_gate"] is False
    assert charter["data_acquisition_enabled"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 4. mission-state.json status == "draft"
# ─────────────────────────────────────────────────────────────────────────────

def test_mission_state_status_is_draft(tmp_path: Path) -> None:
    answers_path = _write_answers(tmp_path, _minimal_answers())
    evor_root = tmp_path / ".evor"

    rc = run_init_run(str(answers_path), run_id_arg="run-draft", evor_root_arg=str(evor_root))
    assert rc == 0

    ms = json.loads(
        (evor_root / "runs" / "test-mission" / "run-draft" / "mission-state.json").read_text()
    )
    assert ms["status"] == "draft"
    assert ms["current_tick"] == 0
    assert ms["max_ticks"] == 20


# ─────────────────────────────────────────────────────────────────────────────
# 5. active-run.json run_dir matches the resolved run_dir
# ─────────────────────────────────────────────────────────────────────────────

def test_active_run_points_at_run_dir(tmp_path: Path) -> None:
    answers_path = _write_answers(tmp_path, _minimal_answers())
    evor_root = tmp_path / ".evor"

    rc = run_init_run(str(answers_path), run_id_arg="run-ptr", evor_root_arg=str(evor_root))
    assert rc == 0

    active = json.loads((evor_root / "active-run.json").read_text())
    expected_run_dir = str((evor_root / "runs" / "test-mission" / "run-ptr").resolve())
    assert active["run_dir"] == expected_run_dir
    assert active["run_id"] == "run-ptr"
    assert active["mission_id"] == "test-mission"


# ─────────────────────────────────────────────────────────────────────────────
# 6. --run-id arg overrides auto-generated id
# ─────────────────────────────────────────────────────────────────────────────

def test_run_id_arg_overrides_auto(tmp_path: Path) -> None:
    answers_path = _write_answers(tmp_path, _minimal_answers())
    evor_root = tmp_path / ".evor"

    rc = run_init_run(str(answers_path), run_id_arg="my-explicit-run", evor_root_arg=str(evor_root))
    assert rc == 0

    active = json.loads((evor_root / "active-run.json").read_text())
    assert active["run_id"] == "my-explicit-run"
    assert (evor_root / "runs" / "test-mission" / "my-explicit-run" / "goal-contract.json").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 7. --mission-id arg overrides answers.mission_id
# ─────────────────────────────────────────────────────────────────────────────

def test_mission_id_arg_overrides_answers(tmp_path: Path) -> None:
    answers = _minimal_answers()
    answers["mission_id"] = "original-mission"
    answers_path = _write_answers(tmp_path, answers)
    evor_root = tmp_path / ".evor"

    rc = run_init_run(
        str(answers_path),
        run_id_arg="run-override",
        mission_id_arg="overridden-mission",
        evor_root_arg=str(evor_root),
    )
    assert rc == 0

    active = json.loads((evor_root / "active-run.json").read_text())
    assert active["mission_id"] == "overridden-mission"
    gc = GoalContract.model_validate_json(
        (evor_root / "runs" / "overridden-mission" / "run-override" / "goal-contract.json").read_text()
    )
    assert gc.mission_id == "overridden-mission"


# ─────────────────────────────────────────────────────────────────────────────
# 8. active-run.json lives in evor_root, not run_dir
# ─────────────────────────────────────────────────────────────────────────────

def test_evor_root_controls_active_run_path(tmp_path: Path) -> None:
    answers_path = _write_answers(tmp_path, _minimal_answers())
    evor_root = tmp_path / "custom-evor"

    rc = run_init_run(str(answers_path), run_id_arg="run-root", evor_root_arg=str(evor_root))
    assert rc == 0

    assert (evor_root / "active-run.json").exists()
    # Must NOT be written inside the run_dir
    run_dir = evor_root / "runs" / "test-mission" / "run-root"
    assert not (run_dir / "active-run.json").exists()


# ─────────────────────────────────────────────────────────────────────────────
# 9. --run-dir arg overrides default path
# ─────────────────────────────────────────────────────────────────────────────

def test_run_dir_arg_overrides_default(tmp_path: Path) -> None:
    answers_path = _write_answers(tmp_path, _minimal_answers())
    evor_root = tmp_path / ".evor"
    custom_run_dir = tmp_path / "my-custom-run"

    rc = run_init_run(
        str(answers_path),
        run_dir_arg=str(custom_run_dir),
        run_id_arg="run-custom",
        evor_root_arg=str(evor_root),
    )
    assert rc == 0

    assert (custom_run_dir / "goal-contract.json").exists()
    active = json.loads((evor_root / "active-run.json").read_text())
    assert active["run_dir"] == str(custom_run_dir.resolve())


# ─────────────────────────────────────────────────────────────────────────────
# 10. Invalid answers — exit 1
# ─────────────────────────────────────────────────────────────────────────────

def test_invalid_answers_exits_1(tmp_path: Path, capsys) -> None:
    answers = _minimal_answers()
    del answers["baseline_value"]  # required float field — triggers ValidationError

    answers_path = _write_answers(tmp_path, answers)
    evor_root = tmp_path / ".evor"

    rc = run_init_run(str(answers_path), run_id_arg="run-bad", evor_root_arg=str(evor_root))
    assert rc == 1


def test_invalid_answers_error_on_stdout(tmp_path: Path, capsys) -> None:
    answers = _minimal_answers()
    del answers["baseline_value"]

    answers_path = _write_answers(tmp_path, answers)
    evor_root = tmp_path / ".evor"

    run_init_run(str(answers_path), run_id_arg="run-bad2", evor_root_arg=str(evor_root))
    captured = capsys.readouterr()
    data = json.loads(captured.out)
    assert "error" in data, f"Expected 'error' key in stdout JSON, got: {data}"


def test_invalid_answers_no_partial_artifact(tmp_path: Path, capsys) -> None:
    """Validation fails before any disk write — goal-contract.json must NOT exist."""
    answers = _minimal_answers()
    del answers["baseline_value"]

    answers_path = _write_answers(tmp_path, answers)
    evor_root = tmp_path / ".evor"

    run_init_run(str(answers_path), run_id_arg="run-partial", evor_root_arg=str(evor_root))

    gc_path = evor_root / "runs" / "test-mission" / "run-partial" / "goal-contract.json"
    assert not gc_path.exists(), (
        "goal-contract.json must NOT be written when validation fails"
    )


def test_bad_mode_literal_exits_1(tmp_path: Path, capsys) -> None:
    answers = _minimal_answers()
    answers["mode"] = "invalid-mode"  # not in the Literal union

    answers_path = _write_answers(tmp_path, answers)
    evor_root = tmp_path / ".evor"

    rc = run_init_run(str(answers_path), run_id_arg="run-bad-mode", evor_root_arg=str(evor_root))
    assert rc == 1
    captured = capsys.readouterr()
    data = json.loads(captured.out)
    assert "error" in data


# ─────────────────────────────────────────────────────────────────────────────
# 10b. Forgiving defaults (F1) — omitting server-defaultable fields must succeed
# ─────────────────────────────────────────────────────────────────────────────

def test_omitting_eval_version_defaults_v1(tmp_path: Path) -> None:
    """eval_version is optional at input; the stored contract defaults it to v1."""
    answers = _minimal_answers()
    del answers["eval_version"]

    answers_path = _write_answers(tmp_path, answers)
    evor_root = tmp_path / ".evor"

    rc = run_init_run(str(answers_path), run_id_arg="run-no-ev", evor_root_arg=str(evor_root))
    assert rc == 0, "omitting eval_version must not fail init-run"

    gc_path = evor_root / "runs" / "test-mission" / "run-no-ev" / "goal-contract.json"
    gc = GoalContract.model_validate(json.loads(gc_path.read_text()))
    assert gc.eval_version == "v1"


def test_omitting_aggregation_rule_defaults_macro_avg(tmp_path: Path) -> None:
    """MetricSpec.aggregation_rule is optional at input; defaults to macro_avg."""
    answers = _minimal_answers()
    for spec in answers["metric_specs"]:
        spec.pop("aggregation_rule", None)

    answers_path = _write_answers(tmp_path, answers)
    evor_root = tmp_path / ".evor"

    rc = run_init_run(str(answers_path), run_id_arg="run-no-agg", evor_root_arg=str(evor_root))
    assert rc == 0, "omitting aggregation_rule must not fail init-run"

    gc_path = evor_root / "runs" / "test-mission" / "run-no-agg" / "goal-contract.json"
    gc = GoalContract.model_validate(json.loads(gc_path.read_text()))
    assert gc.metric_specs[0].aggregation_rule == "macro_avg"


def test_validation_error_message_is_sanitized(tmp_path: Path, capsys) -> None:
    """A validation failure must not leak Pydantic/model internals to the surface."""
    answers = _minimal_answers()
    del answers["baseline_value"]        # required — forces a ValidationError
    answers["mission_type"] = "nonsense"  # invalid Literal — second error

    answers_path = _write_answers(tmp_path, answers)
    evor_root = tmp_path / ".evor"

    run_init_run(str(answers_path), run_id_arg="run-clean-err", evor_root_arg=str(evor_root))
    err = json.loads(capsys.readouterr().out)["error"].lower()

    # jargon / implementation-detail leaks that must NOT appear
    for banned in ("pydantic", "goalcontract", "http", "validation error", "input_value", "input_type"):
        assert banned not in err, f"error message leaked {banned!r}: {err}"
    # but it must still name the offending user-domain fields so it's actionable
    assert "baseline_value" in err and "mission_type" in err


# ─────────────────────────────────────────────────────────────────────────────
# 11. CLI subprocess tests (cwd=_HARNESS_DIR, mirrors test_gotchas pattern)
# ─────────────────────────────────────────────────────────────────────────────

def test_cli_valid_exits_0(tmp_path: Path) -> None:
    answers_path = tmp_path / "answers.json"
    answers_path.write_text(json.dumps(_minimal_answers()))
    evor_root = tmp_path / ".evor"

    result = subprocess.run(
        [
            _PYTHON, "-m", "evor", "init-run",
            "--answers", str(answers_path),
            "--run-id", "cli-run-valid",
            "--evor-root", str(evor_root),
        ],
        capture_output=True, text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0, (
        f"init-run CLI should exit 0 on valid answers.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    data = json.loads(result.stdout)
    assert data["ok"] is True
    assert data["mission_id"] == "test-mission"
    assert data["run_id"] == "cli-run-valid"


def test_cli_invalid_exits_1(tmp_path: Path) -> None:
    answers = _minimal_answers()
    del answers["baseline_value"]
    answers_path = tmp_path / "answers.json"
    answers_path.write_text(json.dumps(answers))
    evor_root = tmp_path / ".evor"

    result = subprocess.run(
        [
            _PYTHON, "-m", "evor", "init-run",
            "--answers", str(answers_path),
            "--run-id", "cli-run-invalid",
            "--evor-root", str(evor_root),
        ],
        capture_output=True, text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 1, (
        f"init-run CLI should exit 1 on invalid answers.\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    data = json.loads(result.stdout)
    assert "error" in data, f"Expected 'error' key in stdout JSON, got: {data}"


def test_cli_help_exits_0() -> None:
    result = subprocess.run(
        [_PYTHON, "-m", "evor", "init-run", "--help"],
        capture_output=True, text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0
    assert "answers" in result.stdout.lower()
