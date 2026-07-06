"""
harness/tests/test_tree_cli.py

Proves that tree.py's _cli() --run-id handler correctly accepts a full
filesystem path (as passed by mcp/src/tools/tree.ts) rather than only bare
run IDs.

Relevant line in tree.py::_cli():
    run_dir = Path(args.run_id) if Path(args.run_id).is_dir() else Path(".evor/runs") / args.run_id

Two-part proof:
  1. Subprocess test — full absolute path to an existing run dir → select
     returns the expected node and exits 0.
  2. Unit test — pathlib invariant: Path(".evor/runs") / absolute_path
     resolves to the absolute path unchanged, so even the fallback branch is
     safe for absolute paths.
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evor.contracts import (
    Budget,
    GoalContract,
    LegacyMetric,
    MetricSpec,
    StopCondition,
    StrategyState,
    TreeNode,
)

_PYTHON = sys.executable
_HARNESS_DIR = Path(__file__).resolve().parent.parent


# ── Fixture helpers ────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_tree_fixture(run_dir: Path) -> None:
    """Write minimal valid tree.json / strategy.json / goal-contract.json."""
    node = TreeNode(
        id="node-cli-tree-001",
        parent_ids=[],
        approach_family="arch",  # type: ignore[arg-type]
        hypothesis_id="hyp-cli-001",
        code_ref="nodes/node-cli-tree-001/code/",
        genome_ref="genome-cli-001",
        data_version_ref="data-v1",
        config={},
        metrics={"accuracy": 0.72},
        eval_version="v1",
        fitness_value=0.72,
        lesson_ids=[],
        citations=[],
        integrity_status="passed",
        status="done",
        is_crossover=False,
        visit_count=1,
        depth=0,
        created_at=_now(),
    )
    tree_data = {
        "nodes": {"node-cli-tree-001": json.loads(node.model_dump_json())},
        "updated_at": _now(),
    }
    (run_dir / "tree.json").write_text(json.dumps(tree_data))

    strategy = StrategyState(
        meta_iteration=1,
        selection_policy="ucb1",
        ucb1_c=1.41,
        wildness=0.5,
        family_mix={
            "arch": 0.20, "training": 0.20, "data-curation": 0.15,
            "data-augmentation": 0.15, "data-acquisition": 0.10,
            "algo": 0.15, "other": 0.05,
        },
        winning_families=[],
        wins_by_family={},
        meta_loop_interval=5,
        post_upgrade_exploration_ticks=0,
        rescore_mode="sync",
        updated_at=_now(),
    )
    (run_dir / "strategy.json").write_text(strategy.model_dump_json())

    goal = GoalContract(
        mission_id="mission-cli-test",
        mode="from-scratch",
        mission_type="fixed",
        task_description="CLI path test",
        dataset_ref="/data/test",
        metrics=[LegacyMetric(name="accuracy", direction="higher", primary=True)],
        metric_specs=[MetricSpec(
            metric_name="accuracy",
            direction="higher",
            domain_applicability="all",
            aggregation_rule="macro_avg",
            role="primary_fitness",
            sota_bar=None,
        )],
        fitness_mode="aggregate",
        eval_version="v1",
        baseline_value=0.5,
        stop_condition=StopCondition(type="target"),
        wildness=0.5,
        budget=Budget(
            max_iterations=10, plateau_window=5,
            circuit_breaker=3, max_cost_usd=0.0,
        ),
        locked_split_hash="abc123",
        eval_script_hash="def456",
        allowed_licenses=["MIT"],
        created_at="2026-07-06T00:00:00Z",
    )
    (run_dir / "goal-contract.json").write_text(goal.model_dump_json())


def _run_tree(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [_PYTHON, "-m", "evor.tree"] + args,
        capture_output=True, text=True,
        cwd=str(_HARNESS_DIR),
    )


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestTreeCliRunIdPath:
    """tree.py _cli() --run-id correctly accepts a full filesystem path."""

    def test_select_with_full_absolute_path(self, tmp_path: Path) -> None:
        """Passing a full absolute path as --run-id resolves the run dir correctly.

        This is the real MCP call pattern: mcp/src/tools/tree.ts passes the
        full runDir filesystem path as --run-id (not a bare ID).  The harness
        must load tree.json from that exact path and return valid JSON.
        """
        run_dir = tmp_path / "runs" / "mission-x" / "run-cli-001"
        run_dir.mkdir(parents=True)
        _write_tree_fixture(run_dir)

        result = _run_tree(["select", "--run-id", str(run_dir)])

        assert result.returncode == 0, (
            f"select with full path failed (returncode={result.returncode}):\n"
            f"stderr: {result.stderr}\nstdout: {result.stdout}"
        )
        data = json.loads(result.stdout)
        assert "selected" in data, f"unexpected output: {data}"
        assert data["selected"] == ["node-cli-tree-001"]

    def test_select_nested_path_loads_correct_run_dir(self, tmp_path: Path) -> None:
        """Full path to a nested runs/<mission>/<run-id>/ is resolved correctly."""
        run_dir = tmp_path / "runs" / "deep-mission" / "nested-run-002"
        run_dir.mkdir(parents=True)
        _write_tree_fixture(run_dir)

        # A sibling run dir must NOT be selected
        sibling = tmp_path / "runs" / "deep-mission" / "sibling-run"
        sibling.mkdir(parents=True)

        result = _run_tree(["select", "--run-id", str(run_dir)])

        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout)
        assert data["selected"] == ["node-cli-tree-001"]

    def test_pathlib_absolute_wins_in_fallback_join(self) -> None:
        """Unit-level proof: Path('.evor/runs') / absolute_path == absolute_path.

        This is the pathlib invariant that makes the fallback branch in _cli()
        safe for absolute paths even when is_dir() returns False (e.g. before
        first write).  If this invariant ever changes, the fallback must be
        updated to match.
        """
        absolute = Path("/storages_local/research/some-evor-root/.evor/runs/m/r")
        result = Path(".evor/runs") / str(absolute)
        assert result == absolute, (
            "pathlib must resolve absolute-path join to the absolute path; "
            f"got {result!r} instead of {absolute!r}"
        )
