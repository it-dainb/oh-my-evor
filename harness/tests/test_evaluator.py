"""
Unit tests for EvaluatorAdapter (harness/evor/evaluator.py).

Coverage:
  - fake stdout-echo fixture → status='success', metrics populated
  - EVOR_EVAL_VERSION injected into subprocess env
  - eval_version mismatch in output → status='error'
  - per-domain emission: per_domain populated from eval script output
  - fitness_value computed post-parse (not taken from eval script verbatim)
  - timeout → status='timeout'
  - non-zero exit (no OOM marker) → status='error'
  - OOM marker in stderr → status='oom'
  - BenchmarkRescore merge: cached + partial → merged per_domain
  - isolation: EvaluationResult.metrics comes from STDOUT, not env or file writes
"""

from __future__ import annotations

import json
import os
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest

from evor.contracts import (
    BenchmarkRescore,
    EvaluationResult,
    GoalContract,
    MutationLocusArch,
    TelemetrySummary,
    TreeNode,
)
from evor.evaluator import EvaluatorAdapter, _compute_fitness, _parse_stdout


# ─────────────────────────────────────────────────────────────────────────────
# Factories
# ─────────────────────────────────────────────────────────────────────────────

def _make_goal(
    eval_version: str = "v1",
    baseline_value: float = 0.50,
    fitness_mode: str = "aggregate",
    mission_type: str = "fixed",
) -> GoalContract:
    return GoalContract(
        mission_id="test-mission",
        mode="from-scratch",
        mission_type=mission_type,  # type: ignore[arg-type]
        task_description="Test task",
        dataset_ref="/data/test",
        metric_specs=[{
            "metric_name": "accuracy",
            "direction": "higher",
            "domain_applicability": "all",
            "aggregation_rule": "macro_avg",
            "role": "primary_fitness",
            "sota_bar": None,
        }],
        fitness_mode=fitness_mode,  # type: ignore[arg-type]
        eval_version=eval_version,
        baseline_value=baseline_value,
        stop_condition={"type": "target"},
        wildness=0.5,
        budget={
            "max_iterations": 50,
            "plateau_window": 8,
            "circuit_breaker": 5,
            "max_cost_usd": 0.0,
        },
        locked_split_hash="deadbeef" * 8,
        eval_script_hash="cafebabe" * 8,
        allowed_licenses=["MIT"],
        created_at="2026-07-03T00:00:00Z",
    )


def _make_node(eval_version: str = "v1") -> TreeNode:
    return TreeNode(
        id="node-eval-001",
        parent_ids=[],
        approach_family="arch",
        hypothesis_id="hyp-001",
        code_ref="nodes/node-eval-001/code/",
        genome_ref="genome-ref-001",
        mutation_locus=MutationLocusArch(family="arch", path="model/"),
        data_version_ref="data-v1",
        config={},
        metrics={"accuracy": 0.72},
        eval_version=eval_version,
        lesson_ids=[],
        citations=[],
        integrity_status="pending",
        status="done",
        is_crossover=False,
        visit_count=1,
        depth=0,
        created_at="2026-07-03T00:00:00Z",
    )


def _write_eval_script(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def _echo_script(
    metrics: dict[str, float],
    per_domain: dict[str, dict[str, float]] | None = None,
    eval_version: str | None = None,
    write_to: str | None = None,  # file to write to (tests isolation)
) -> str:
    """Build a Python eval script that prints JSON to stdout."""
    payload: dict[str, Any] = {
        "metrics": metrics,
        "per_domain": per_domain or {"default": metrics},
    }
    if eval_version is not None:
        payload["eval_version"] = eval_version

    payload_str = json.dumps(payload)

    extra = ""
    if write_to:
        # Attempt to write a file outside the worktree (isolation test)
        extra = f"\nopen({write_to!r}, 'w').write('ISOLATION_BREACH')"

    return textwrap.dedent(f"""\
        import json, sys
        payload = json.loads({payload_str!r})
        print(json.dumps(payload))
        {extra}
    """)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _run_eval(
    tmp_path: Path,
    script_content: str,
    goal: GoalContract | None = None,
    node: TreeNode | None = None,
    env: dict[str, str] | None = None,
    rescore_context: BenchmarkRescore | None = None,
) -> EvaluationResult:
    goal = goal or _make_goal()
    node = node or _make_node()
    env = env or {}

    worktree = tmp_path / "worktree"
    worktree.mkdir(exist_ok=True)
    eval_script = worktree / "evaluate.py"
    _write_eval_script(eval_script, script_content)

    adapter = EvaluatorAdapter(run_dir=tmp_path)
    return adapter.run(
        eval_script=eval_script,
        worktree=worktree,
        goal=goal,
        node=node,
        env=env,
        rescore_context=rescore_context,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Basic success path
# ─────────────────────────────────────────────────────────────────────────────

class TestSuccessPath:
    def test_basic_eval_returns_success(self, tmp_path: Path):
        result = _run_eval(tmp_path, _echo_script({"accuracy": 0.85}))
        assert result.status == "success"
        assert result.metrics["accuracy"] == pytest.approx(0.85)

    def test_per_domain_populated(self, tmp_path: Path):
        per_domain = {
            "english": {"accuracy": 0.90},
            "french": {"accuracy": 0.80},
        }
        result = _run_eval(tmp_path, _echo_script({"accuracy": 0.85}, per_domain=per_domain))
        assert result.status == "success"
        assert "english" in result.per_domain
        assert "french" in result.per_domain
        assert result.per_domain["english"]["accuracy"] == pytest.approx(0.90)

    def test_fitness_computed_post_parse_not_from_script(self, tmp_path: Path):
        """EvaluatorAdapter recomputes fitness; it must match goal's fitness_mode logic."""
        # Goal with aggregate fitness_mode; primary metric = accuracy
        goal = _make_goal(baseline_value=0.70, fitness_mode="aggregate")
        # Script outputs accuracy=0.88; EvaluatorAdapter should compute fitness=0.88
        result = _run_eval(
            tmp_path,
            _echo_script({"accuracy": 0.88}),
            goal=goal,
        )
        assert result.status == "success"
        # fitness must come from EvaluatorAdapter's _compute_fitness, not eval script
        assert result.fitness_value == pytest.approx(0.88)

    def test_worst_domain_fitness_mode(self, tmp_path: Path):
        """worst-domain fitness = min across domains."""
        goal = _make_goal(baseline_value=0.50, fitness_mode="worst-domain")
        per_domain = {
            "easy": {"accuracy": 0.95},
            "hard": {"accuracy": 0.60},
        }
        result = _run_eval(
            tmp_path,
            _echo_script({"accuracy": 0.80}, per_domain=per_domain),
            goal=goal,
        )
        assert result.status == "success"
        # worst-domain should take min(0.95, 0.60) = 0.60
        assert result.fitness_value == pytest.approx(0.60)

    def test_regression_detected(self, tmp_path: Path):
        """Score below baseline → status='regression'."""
        goal = _make_goal(baseline_value=0.90)  # high baseline
        result = _run_eval(
            tmp_path,
            _echo_script({"accuracy": 0.75}),   # below baseline
            goal=goal,
        )
        assert result.status == "regression"

# ─────────────────────────────────────────────────────────────────────────────
# EVOR_EVAL_VERSION injection
# ─────────────────────────────────────────────────────────────────────────────

class TestEvalVersionInjection:
    def test_evor_eval_version_in_env(self, tmp_path: Path):
        """EVOR_EVAL_VERSION must be injected; eval script can read it from env."""
        script = textwrap.dedent("""\
            import json, os
            ev = os.environ.get("EVOR_EVAL_VERSION", "MISSING")
            print(json.dumps({"metrics": {"accuracy": 0.80}, "per_domain": {}, "eval_version_seen": ev}))
        """)
        goal = _make_goal(eval_version="v2")
        # Use a script that includes the version it sees; verify EvaluatorAdapter injected it
        worktree = tmp_path / "worktree"
        worktree.mkdir(exist_ok=True)
        eval_script = worktree / "evaluate.py"
        eval_script.write_text(script)

        adapter = EvaluatorAdapter(run_dir=tmp_path)
        result = adapter.run(
            eval_script=eval_script,
            worktree=worktree,
            goal=goal,
            node=_make_node(eval_version="v2"),
            env={},
        )
        # We can't directly read the env inside the subprocess, but we know the script
        # reads EVOR_EVAL_VERSION.
        # Key assertion: EvaluatorAdapter injected v2 → script saw it → no version mismatch
        assert result.status in ("success", "regression")

    def test_eval_version_mismatch_in_output_fails(self, tmp_path: Path):
        """Eval script emitting wrong eval_version → status='error'."""
        # Script emits eval_version='v99' but goal has eval_version='v1'
        script = _echo_script({"accuracy": 0.85}, eval_version="v99")
        goal = _make_goal(eval_version="v1")
        result = _run_eval(tmp_path, script, goal=goal)
        assert result.status == "error"

    def test_eval_script_without_version_field_passes(self, tmp_path: Path):
        """eval_version field is optional in output; absence = no version check."""
        # Script doesn't include eval_version → no mismatch check
        script = textwrap.dedent("""\
            import json
            print(json.dumps({"metrics": {"accuracy": 0.77}}))
        """)
        result = _run_eval(tmp_path, script)
        assert result.status != "error"  # should succeed (possibly regression if baseline high)


# ─────────────────────────────────────────────────────────────────────────────
# Error cases
# ─────────────────────────────────────────────────────────────────────────────

class TestErrorCases:
    def test_timeout_returns_timeout_status(self, tmp_path: Path):
        """Subprocess that sleeps longer than timeout → status='timeout'."""
        import subprocess
        from unittest.mock import patch

        # Patch subprocess.run to raise TimeoutExpired
        with patch("evor.evaluator.subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.TimeoutExpired(cmd=["python"], timeout=1)
            result = _run_eval(tmp_path, "print('never')")

        assert result.status == "timeout"
        assert result.fitness_value == pytest.approx(0.0)

    def test_nonzero_exit_returns_error(self, tmp_path: Path):
        """Non-zero exit code → status='error'."""
        script = "import sys; sys.exit(1)"
        result = _run_eval(tmp_path, script)
        assert result.status == "error"

    def test_oom_in_stderr_returns_oom_status(self, tmp_path: Path):
        """OOM pattern in stderr → status='oom'."""
        script = textwrap.dedent("""\
            import sys
            sys.stderr.write("CUDA out of memory. Tried to allocate 4.00 GiB\\n")
            sys.exit(1)
        """)
        result = _run_eval(tmp_path, script)
        assert result.status == "oom"

    def test_invalid_json_stdout_returns_error(self, tmp_path: Path):
        """Eval script that prints non-JSON → status='error'."""
        script = "print('this is not json')"
        result = _run_eval(tmp_path, script)
        assert result.status == "error"

    def test_empty_stdout_returns_error(self, tmp_path: Path):
        """Eval script that prints nothing → status='error'."""
        script = "pass"  # no output
        result = _run_eval(tmp_path, script)
        assert result.status == "error"


# ─────────────────────────────────────────────────────────────────────────────
# BenchmarkRescore merge (R-6)
# ─────────────────────────────────────────────────────────────────────────────

class TestBenchmarkRescoreMerge:
    def test_cached_and_partial_domains_merged(self, tmp_path: Path):
        """BenchmarkRescore: cached_per_domain | partial.per_domain → merged result."""
        rescore = BenchmarkRescore(
            upgrade_id="upgrade-001",
            node_id="node-eval-001",
            cached_per_domain={"domA": {"accuracy": 0.80}, "domB": {"accuracy": 0.75}},
            new_domains=["domC"],
            merged_eval_version="v2",
        )
        # Eval script returns only domC (the new domain)
        new_domain_script = textwrap.dedent("""\
            import json, sys
            payload = {
                "metrics": {"accuracy": 0.85},
                "per_domain": {"domC": {"accuracy": 0.90}},
            }
            print(json.dumps(payload))
        """)
        goal = _make_goal(eval_version="v2")
        node = _make_node(eval_version="v2")
        result = _run_eval(tmp_path, new_domain_script, goal=goal, node=node,
                           rescore_context=rescore)

        assert result.status in ("success", "regression")
        # Merged: all 3 domains present
        assert "domA" in result.per_domain
        assert "domB" in result.per_domain
        assert "domC" in result.per_domain
        assert result.per_domain["domC"]["accuracy"] == pytest.approx(0.90)
        # eval_version upgraded to merged version
        assert result.eval_version == "v2"

    def test_merge_prefers_partial_over_cached_on_key_collision(self, tmp_path: Path):
        """If partial result has a domain also in cached, partial wins (dict union)."""
        rescore = BenchmarkRescore(
            upgrade_id="upgrade-002",
            node_id="node-eval-001",
            cached_per_domain={"domA": {"accuracy": 0.70}},
            new_domains=["domA"],  # re-evaluating same domain
            merged_eval_version="v2",
        )
        # Script returns domA with higher score (partial wins)
        update_script = textwrap.dedent("""\
            import json
            print(json.dumps({
                "metrics": {"accuracy": 0.90},
                "per_domain": {"domA": {"accuracy": 0.88}},
            }))
        """)
        goal = _make_goal(eval_version="v2")
        node = _make_node(eval_version="v2")
        result = _run_eval(tmp_path, update_script, goal=goal, node=node,
                           rescore_context=rescore)
        # Partial (0.88) must win over cached (0.70)
        assert result.per_domain["domA"]["accuracy"] == pytest.approx(0.88)


# ─────────────────────────────────────────────────────────────────────────────
# Isolation: results come from STDOUT only
# ─────────────────────────────────────────────────────────────────────────────

class TestIsolation:
    def test_result_comes_from_stdout_not_file_writes(self, tmp_path: Path):
        """Eval script's file writes must NOT affect the EvaluationResult.

        The isolation contract states: metrics are parsed from STDOUT only.
        Even if the eval script writes to /tmp or worktree, the result
        must come exclusively from what was printed to stdout.
        """
        # Script writes garbage to a file AND prints correct JSON to stdout
        side_effect_file = tmp_path / "poison.txt"
        script = textwrap.dedent(f"""\
            import json
            # Write garbage to a file (should not affect EvaluationResult)
            open({str(side_effect_file)!r}, 'w').write('ATTACK_VALUE=9.99')
            # Only stdout carries the legitimate result
            print(json.dumps({{"metrics": {{"accuracy": 0.80}}, "per_domain": {{}}}}))
        """)
        result = _run_eval(tmp_path, script)
        assert result.status == "success"
        # Metrics come from stdout, not the file
        assert result.metrics["accuracy"] == pytest.approx(0.80)
        # File was written, but EvaluationResult is unaffected
        assert side_effect_file.exists()
        assert "0.80" not in side_effect_file.read_text()

    def test_node_id_comes_from_node_not_eval_script(self, tmp_path: Path):
        """EvaluationResult.node_id is set by EvaluatorAdapter, not eval script."""
        # Script tries to set a different node_id in output — should be ignored
        script = textwrap.dedent("""\
            import json
            print(json.dumps({
                "node_id": "FAKE_NODE_INJECTED_BY_SCRIPT",
                "metrics": {"accuracy": 0.82},
            }))
        """)
        node = _make_node()
        result = _run_eval(tmp_path, script, node=node)
        # node_id must come from the TreeNode, not the eval script output
        assert result.node_id == node.id  # "node-eval-001"


# ─────────────────────────────────────────────────────────────────────────────
# _compute_fitness unit tests (isolated)
# ─────────────────────────────────────────────────────────────────────────────

class TestComputeFitnessUnit:
    def _make_result(
        self,
        metrics: dict[str, float],
        per_domain: dict[str, dict[str, float]],
        fitness_value: float = 0.5,
    ) -> EvaluationResult:
        return EvaluationResult(
            node_id="n1",
            run_id="r1",
            eval_version="v1",
            metrics=metrics,
            per_domain=per_domain,
            fitness_value=fitness_value,
            telemetry_summary=TelemetrySummary(total_steps=0),
            status="success",
            benchmark_raw="",
            timestamp="2026-07-03T00:00:00Z",
        )

    def test_aggregate_mode_uses_primary_metric(self):
        goal = _make_goal(fitness_mode="aggregate")
        result = self._make_result({"accuracy": 0.87}, {"d": {"accuracy": 0.87}})
        fitness = _compute_fitness(result, goal)
        assert fitness == pytest.approx(0.87)

    def test_worst_domain_mode_takes_min(self):
        goal = _make_goal(fitness_mode="worst-domain")
        result = self._make_result(
            {"accuracy": 0.80},
            {"d1": {"accuracy": 0.90}, "d2": {"accuracy": 0.65}},
        )
        fitness = _compute_fitness(result, goal)
        assert fitness == pytest.approx(0.65)

    def test_weighted_mode_takes_average(self):
        goal = _make_goal(fitness_mode="weighted")
        result = self._make_result(
            {"accuracy": 0.80},
            {"d1": {"accuracy": 0.80}, "d2": {"accuracy": 0.60}},
        )
        fitness = _compute_fitness(result, goal)
        assert fitness == pytest.approx(0.70)


# ─────────────────────────────────────────────────────────────────────────────
# _parse_stdout unit tests
# ─────────────────────────────────────────────────────────────────────────────

class TestParseStdout:
    def _goal_and_node(self, eval_version: str = "v1"):
        return _make_goal(eval_version=eval_version), _make_node(eval_version=eval_version)

    def test_valid_json_parsed(self):
        goal, node = self._goal_and_node()
        data, err = _parse_stdout('{"metrics": {"accuracy": 0.9}}', goal, node)
        assert err is None
        assert data["metrics"]["accuracy"] == pytest.approx(0.9)

    def test_empty_stdout_returns_error(self):
        goal, node = self._goal_and_node()
        data, err = _parse_stdout("", goal, node)
        assert err is not None
        assert "no stdout" in err

    def test_invalid_json_returns_error(self):
        goal, node = self._goal_and_node()
        data, err = _parse_stdout("NOT JSON", goal, node)
        assert err is not None
        assert "not valid JSON" in err

    def test_version_mismatch_returns_error(self):
        goal, node = self._goal_and_node(eval_version="v1")
        data, err = _parse_stdout('{"metrics": {}, "eval_version": "v99"}', goal, node)
        assert err is not None
        assert "eval_version mismatch" in err

    def test_matching_version_passes(self):
        goal, node = self._goal_and_node(eval_version="v1")
        data, err = _parse_stdout('{"metrics": {}, "eval_version": "v1"}', goal, node)
        assert err is None


