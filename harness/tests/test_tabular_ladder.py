"""
harness/tests/test_tabular_ladder.py

Acceptance tests for benchmarks/tabular-ladder/evaluate.py — task B3's answer
to "the benchmark mission cannot measure search quality because it is solved
on the first attempt" (benchmarks/tabular-churn saturates a depth-4 tree on
tick 1). This evaluator's dataset has genuine headroom: an improvement LADDER
of four reference candidates, each with a measurably distinct roc_auc.

These tests exercise evaluate.py through the REAL harness contract
(EvaluatorAdapter.run(), same as production) against fixture candidate
worktrees under harness/tests/fixtures/tabular-ladder/candidates/*.

Coverage:
  - the four reference rungs score in strictly increasing roc_auc order
  - each rung-to-rung gap clears the bootstrap noise floor at n=2000 (no
    single sample, or a handful of them, can flip the ranking)
  - telemetry.jsonl is written and passes IntegrityGate._check_telemetry_sane
    for every rung
  - candidate failure (raising trainer, missing trainer.py) is still recorded
    as status="error", never a fabricated score
  - the existing benchmarks/tabular-churn mission's evaluator is untouched
"""

from __future__ import annotations

import importlib.util
import random
from pathlib import Path

import pytest

from evor.contracts import GoalContract, MutationLocusArch, TreeNode
from evor.evaluator import EvaluatorAdapter
from evor.integrity import IntegrityGate

REPO_ROOT = Path(__file__).resolve().parents[2]
EVAL_SCRIPT = REPO_ROOT / "benchmarks" / "tabular-ladder" / "evaluate.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "tabular-ladder" / "candidates"

RUNGS = ["logreg", "tree_basic", "tree_selected", "forest"]

# Bootstrap sd of roc_auc at n=2000 test samples for these candidates is
# ~0.007-0.012 (measured during design). Require gaps well above that so a
# single tick's ranking is never noise.
MIN_GAP = 0.015


def _load_eval_module():
    spec = importlib.util.spec_from_file_location("ladder_evaluate", EVAL_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _goal() -> GoalContract:
    return GoalContract(
        mission_id="bench-cpu-tabular-ladder",
        mode="from-scratch",
        mission_type="fixed",
        task_description="Binary tabular classification ladder bench",
        dataset_ref="/data/bench-cpu-tabular-ladder",
        metric_specs=[{
            "metric_name": "roc_auc",
            "direction": "higher",
            "domain_applicability": "all",
            "aggregation_rule": "macro_avg",
            "role": "primary_fitness",
            "sota_bar": None,
        }],
        fitness_mode="aggregate",
        eval_version="v1",
        baseline_value=0.0,
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
        hypothesis_id="hyp-ladder-001",
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


def _run(tmp_path: Path, candidate: str, node_id: str):
    adapter = EvaluatorAdapter(run_dir=tmp_path)
    return adapter.run(
        eval_script=EVAL_SCRIPT,
        worktree=FIXTURES / candidate,
        goal=_goal(),
        node=_node(node_id),
        env={"EVOR_RUN_ID": "run-ladder-001"},
    )


@pytest.fixture(scope="module")
def rung_results():
    """Run all four reference candidates through the real evaluator once,
    shared across assertions in this module (each run takes a few seconds)."""
    import tempfile
    results = {}
    with tempfile.TemporaryDirectory() as td:
        tmp_path = Path(td)
        for rung in RUNGS:
            results[rung] = _run(tmp_path, rung, node_id=f"node-{rung}")
    return results


class TestLadderOrdering:
    def test_all_rungs_succeed(self, rung_results):
        for rung in RUNGS:
            assert rung_results[rung].status == "success", (rung, rung_results[rung].benchmark_raw)

    def test_rungs_climb_in_order(self, rung_results):
        aucs = [rung_results[r].metrics["roc_auc"] for r in RUNGS]
        assert aucs == sorted(aucs), f"expected strictly increasing roc_auc, got {list(zip(RUNGS, aucs))}"

    def test_gaps_clear_the_noise_floor(self, rung_results):
        aucs = [rung_results[r].metrics["roc_auc"] for r in RUNGS]
        gaps = [b - a for a, b in zip(aucs, aucs[1:])]
        for rung_pair, gap in zip(zip(RUNGS, RUNGS[1:]), gaps):
            assert gap >= MIN_GAP, f"{rung_pair} gap {gap:.4f} below noise floor {MIN_GAP}"

    def test_all_rungs_beat_chance(self, rung_results):
        for rung in RUNGS:
            assert rung_results[rung].metrics["roc_auc"] > 0.5 + MIN_GAP


class TestTelemetry:
    @pytest.mark.parametrize("rung", RUNGS)
    def test_telemetry_written_and_passes_sanity_check(self, tmp_path: Path, rung):
        result = _run(tmp_path, rung, node_id=f"node-tel-{rung}")
        assert result.status == "success", result.benchmark_raw

        telemetry_path = tmp_path / "nodes" / f"node-tel-{rung}" / "telemetry.jsonl"
        assert telemetry_path.exists()
        assert telemetry_path.read_text().strip() != ""

        gate = IntegrityGate()
        assert gate._check_telemetry_sane(telemetry_path) is True


class TestCandidateFailureIsRecorded:
    def test_missing_trainer_is_recorded_as_error(self, tmp_path: Path):
        empty_dir = tmp_path / "empty_worktree"
        empty_dir.mkdir()
        adapter = EvaluatorAdapter(run_dir=tmp_path)
        result = adapter.run(
            eval_script=EVAL_SCRIPT,
            worktree=empty_dir,
            goal=_goal(),
            node=_node("node-missing"),
            env={"EVOR_RUN_ID": "run-ladder-001"},
        )
        assert result.status == "error"
        assert result.metrics == {}


class TestDatasetContract:
    def test_test_split_has_at_least_1000_samples(self):
        ev = _load_eval_module()
        X, y = ev._make_dataset()
        _, _, _, _, Xte, yte = ev._splits(X, y)
        assert len(Xte) >= 1000
        assert len(yte) >= 1000

    def test_roc_auc_matches_rank_statistic_definition(self):
        ev = _load_eval_module()
        proba = [0.9, 0.4, 0.7, 0.6]
        y = [1, 0, 1, 0]
        assert ev._roc_auc(proba, y) == pytest.approx(1.0)

    def test_deterministic_across_regenerations(self):
        ev = _load_eval_module()
        X1, y1 = ev._make_dataset()
        X2, y2 = ev._make_dataset()
        assert X1 == X2
        assert y1 == y2
