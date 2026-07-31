"""
harness/tests/test_bench_evaluator.py

Acceptance tests for benchmarks/tabular-churn/evaluate.py — the "canonical
CPU evaluator" installed into fresh missions by scripts/bench-seed-mission.mjs.

The defect (diagnosed from a real 3-tick bench run): the old evaluate.py never
executed the candidate's code. It read config.json keys and retrained its own
internal model on its own internal dataset, so every candidate genome scored
identically and telemetry.jsonl was always empty (EVOR_TELEMETRY_PATH never
wired), which made every node fail integrity's telemetry_sane check.

These tests exercise evaluate.py through the REAL harness contract
(EvaluatorAdapter.run(), same as production) against fixture candidate
worktrees under harness/tests/fixtures/bench-cpu-tabular/candidates/*, each
providing its own train/trainer.py (the §19-clean env-path telemetry pattern
documented in harness/evor/telemetry.py and enforced by
harness/evor/quality_gate.py's ForgeStructureGate._check_telemetry).

Coverage:
  - two structurally different candidates (tree vs logreg) score differently
  - telemetry.jsonl is non-empty and passes IntegrityGate._check_telemetry_sane
  - a candidate whose trainer.py raises -> status='error' (recorded failure,
    not a silent constant score)
  - a candidate missing train/trainer.py entirely -> status='error'
"""

from __future__ import annotations

from pathlib import Path

import pytest

from evor.contracts import GoalContract, MutationLocusArch, TreeNode
from evor.evaluator import EvaluatorAdapter
from evor.integrity import IntegrityGate

REPO_ROOT = Path(__file__).resolve().parents[2]
EVAL_SCRIPT = REPO_ROOT / "benchmarks" / "tabular-churn" / "evaluate.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "bench-cpu-tabular" / "candidates"


def _goal() -> GoalContract:
    return GoalContract(
        mission_id="bench-cpu-tabular",
        mode="from-scratch",
        mission_type="fixed",
        task_description="Binary tabular classification bench",
        dataset_ref="/data/bench-cpu-tabular",
        metric_specs=[{
            "metric_name": "accuracy",
            "direction": "higher",
            "domain_applicability": "all",
            "aggregation_rule": "macro_avg",
            "role": "primary_fitness",
            "sota_bar": None,
        }],
        fitness_mode="aggregate",
        eval_version="v1",
        baseline_value=0.0,  # never trigger the regression path in these tests
        stop_condition={"type": "evolve-n", "n": 1},
        wildness=0.3,
        budget={
            "max_iterations": 1,
            "plateau_window": 3,
            "circuit_breaker": 5,
            "max_cost_usd": 25,
        },
        locked_split_hash="deadbeef" * 8,
        eval_script_hash="cafebabe" * 8,
        framework="python-stdlib",
        allowed_licenses=["MIT"],
        created_at="2026-07-31T00:00:00Z",
    )


def _node(node_id: str) -> TreeNode:
    return TreeNode(
        id=node_id,
        parent_ids=[],
        approach_family="arch",
        hypothesis_id="hyp-bench-001",
        code_ref=f"nodes/{node_id}/code/",
        genome_ref=f"genome-{node_id}",
        mutation_locus=MutationLocusArch(family="arch", path="model/"),
        data_version_ref="data-v1",
        config={},
        metrics={},
        eval_version="v1",
        lesson_ids=[],
        citations=[],
        integrity_status="pending",
        status="running",
        is_crossover=False,
        visit_count=1,
        depth=0,
        created_at="2026-07-31T00:00:00Z",
    )


def _run(tmp_path: Path, candidate: str, node_id: str = "node-001"):
    adapter = EvaluatorAdapter(run_dir=tmp_path)
    return adapter.run(
        eval_script=EVAL_SCRIPT,
        worktree=FIXTURES / candidate,
        goal=_goal(),
        node=_node(node_id),
        env={"EVOR_RUN_ID": "run-bench-001"},
    )


class TestFitnessSignal:
    def test_two_different_candidates_score_differently(self, tmp_path: Path):
        tree_result = _run(tmp_path / "tree", "tree", node_id="node-tree")
        logreg_result = _run(tmp_path / "logreg", "logreg", node_id="node-logreg")

        assert tree_result.status == "success", tree_result.benchmark_raw
        assert logreg_result.status == "success", logreg_result.benchmark_raw
        assert tree_result.metrics["accuracy"] != pytest.approx(
            logreg_result.metrics["accuracy"]
        )

    def test_depth_limited_tree_beats_linear_model(self, tmp_path: Path):
        """Sanity: the dataset is deliberately non-linear, so the real tree
        candidate should out-score the real logistic-regression candidate —
        confirms the scores reflect genuinely different executed code, not
        just noise."""
        tree_result = _run(tmp_path / "tree", "tree", node_id="node-tree")
        logreg_result = _run(tmp_path / "logreg", "logreg", node_id="node-logreg")
        assert tree_result.metrics["accuracy"] > logreg_result.metrics["accuracy"]


class TestTelemetry:
    def test_telemetry_written_and_passes_sanity_check(self, tmp_path: Path):
        result = _run(tmp_path, "tree", node_id="node-tel")
        assert result.status == "success", result.benchmark_raw

        telemetry_path = tmp_path / "nodes" / "node-tel" / "telemetry.jsonl"
        assert telemetry_path.exists()
        assert telemetry_path.read_text().strip() != ""

        gate = IntegrityGate()
        assert gate._check_telemetry_sane(telemetry_path) is True

    def test_logreg_candidate_telemetry_includes_grad_norm_and_passes_sanity(
        self, tmp_path: Path
    ):
        result = _run(tmp_path, "logreg", node_id="node-tel-lr")
        assert result.status == "success", result.benchmark_raw

        telemetry_path = tmp_path / "nodes" / "node-tel-lr" / "telemetry.jsonl"
        lines = [ln for ln in telemetry_path.read_text().splitlines() if ln.strip()]
        assert len(lines) >= 2
        assert '"grad_norm"' in telemetry_path.read_text()

        gate = IntegrityGate()
        assert gate._check_telemetry_sane(telemetry_path) is True


class TestCandidateFailureIsRecorded:
    def test_raising_trainer_is_recorded_as_error_not_a_score(self, tmp_path: Path):
        result = _run(tmp_path, "broken", node_id="node-broken")
        assert result.status == "error"
        assert result.metrics == {}

    def test_missing_trainer_is_recorded_as_error(self, tmp_path: Path):
        result = _run(tmp_path, "no_trainer", node_id="node-missing")
        assert result.status == "error"
        assert result.metrics == {}
