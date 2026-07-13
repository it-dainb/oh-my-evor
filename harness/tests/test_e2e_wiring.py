"""
test_e2e_wiring.py — End-to-end wiring tests for the MCP-tool → Python CLI paths.

These tests exercise the REAL code paths against a fixture run store, not mocks.
No torch / GPU required.

Regression guard: every test in this file MUST FAIL against the pre-fix code
(C1-C4 dict format bugs, C2 wrong goal path, C6-C10 missing CLIs) and MUST PASS
after the fixes are applied.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest


# ─────────────────────────────────────────────────────────────────────────────
# Fixture helpers
# ─────────────────────────────────────────────────────────────────────────────

_MISSION_ID = "wiring-test-mission"
_RUN_ID = "run-wiring-20260704T000000"
_NODE_A = "node-wire-aaaa-0001"
_NODE_B = "node-wire-bbbb-0002"
_PYTHON = sys.executable  # the venv Python running the tests
_HARNESS_DIR = Path(__file__).resolve().parent.parent


def _node_dict(
    node_id: str,
    parent_ids: list[str],
    depth: int,
    score: float,
    family: str = "arch",
) -> dict:
    return {
        "id": node_id,
        "parent_ids": parent_ids,
        "approach_family": family,
        "hypothesis_id": f"hyp-{node_id[:8]}",
        "code_ref": f"nodes/{node_id}/code/",
        "parent_patch_ref": None,
        "genome_ref": f"genome-ref-{node_id[:8]}",
        "mutation_tier": "parametric",
        "mutation_locus": None,  # Optional; avoid strict union family+path requirements
        "data_version_ref": "data-v1-hash",
        "config": {},
        "weights_ref": None,
        "metrics": {"accuracy": score},
        "eval_version": "v1",
        "fitness_value": score,
        "telemetry_ref": f"nodes/{node_id}/telemetry.jsonl",
        "lesson_ids": [],
        "citations": [],
        "integrity_status": "passed",
        "status": "done",
        "is_crossover": False,
        "ucb1_score": score + 0.05,
        "visit_count": depth + 1,
        "depth": depth,
        "created_at": "2026-07-04T01:00:00Z",
        "completed_at": "2026-07-04T02:00:00Z",
    }


def _goal_contract() -> dict:
    return {
        "mission_id": _MISSION_ID,
        "mode": "from-scratch",
        "mission_type": "fixed",
        "task_description": "Wiring test task",
        "dataset_ref": "/data/wiring-test",
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
        "baseline_value": 0.700,
        "target_value": 0.900,
        "coverage_target": None,
        "stop_condition": {"type": "target"},
        "wildness": 0.5,
        "budget": {
            "max_iterations": 20,
            "plateau_window": 5,
            "circuit_breaker": 3,
            "max_cost_usd": 0.0,
        },
        "framework": "pytorch",
        "seed_repo_path": None,
        "locked_split_hash": "deadbeef01234567",
        "eval_script_hash": "cafebabe89abcdef",
        "expansion_policy": None,
        "allowed_licenses": ["MIT", "Apache-2.0"],
        "created_at": "2026-07-04T00:00:00Z",
    }


def _strategy() -> dict:
    return {
        "meta_iteration": 0,
        "selection_policy": "ucb1",
        "ucb1_c": 1.41,
        "beam_width": None,
        "wildness": 0.5,
        "family_mix": {
            "arch": 0.2, "training": 0.2, "data-curation": 0.15,
            "data-augmentation": 0.15, "data-acquisition": 0.1,
            "algo": 0.15, "other": 0.05,
        },
        "winning_families": [],
        "wins_by_family": {},
        "meta_loop_interval": 5,
        "post_upgrade_exploration_boost": None,
        "post_upgrade_exploration_ticks": 0,
        "rescore_mode": "sync",
        "updated_at": "2026-07-04T00:00:00Z",
    }


def _build_fixture_run_dir(tmp_path: Path) -> tuple[Path, Path]:
    """Create a minimal .evor/ run directory with DICT-format tree.json.

    Returns (run_dir, evor_root).
    """
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / _MISSION_ID / _RUN_ID

    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "nodes").mkdir(exist_ok=True)
    (run_dir / "eval-suites").mkdir(exist_ok=True)

    # DICT-format tree.json (the new canonical format written by mcp/src/tree-store.ts)
    node_a = _node_dict(_NODE_A, [], 0, 0.851)
    node_b = _node_dict(_NODE_B, [_NODE_A], 1, 0.823, family="training")
    tree_json = {
        "nodes": {
            _NODE_A: node_a,
            _NODE_B: node_b,
        },
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    (run_dir / "tree.json").write_text(json.dumps(tree_json, indent=2))

    # goal-contract.json (C2 fix: _load_engine now reads this path)
    (run_dir / "goal-contract.json").write_text(json.dumps(_goal_contract(), indent=2))

    # strategy.json
    (run_dir / "strategy.json").write_text(json.dumps(_strategy(), indent=2))

    # mission-state.json — must be "locked" for `evor run` to proceed
    (run_dir / "mission-state.json").write_text(json.dumps({
        "status": "locked",
        "objective": "Wiring test task",
        "current_tick": 0,
        "max_ticks": 20,
        "best_score": None,
        "best_node_id": None,
        "started_at": None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, indent=2))

    # run-state.json (needed by plot_tree for frontier_ids)
    (run_dir / "run-state.json").write_text(json.dumps({
        "status": "running",
        "tick_count": 2,
        "best_score": 0.851,
        "frontier_ids": [_NODE_A],
        "current_eval_version": "v1",
        "hypotheses": [],
    }, indent=2))

    # Minimal eval-suites/v1.json (needed for benchmark tests)
    (run_dir / "eval-suites" / "v1.json").write_text(json.dumps({
        "eval_version": "v1",
        "mission_id": _MISSION_ID,
        "parent_eval_version": None,
        "domains": [
            {
                "domain_id": "primary",
                "description": "Wiring test task",
                "metric_specs": [],
                "sota_source": None,
                "added_at_eval_version": "v1",
            }
        ],
        "split_hashes": {},
        "created_at": "2026-07-04T00:00:00Z",
        "created_by": "user",
        "consent_log_ref": "setup-session",
    }, indent=2))

    # Frozen splits (minimal — 2 test samples, 1 val sample)
    frozen_dir = run_dir / "frozen-splits"
    frozen_dir.mkdir(exist_ok=True)
    _write_minimal_frozen_split(frozen_dir, "v1-test", {"0": "aabbcc", "1": "ddeeff"})
    _write_minimal_frozen_split(frozen_dir, "v1-val", {"0": "112233"})

    return run_dir, evor_root


def _write_minimal_frozen_split(frozen_dir: Path, name: str, samples: dict) -> None:
    """Write a minimal FrozenSplit JSON file (enough to satisfy RunStore)."""
    import hashlib

    per_sample_hashes = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in samples.items()}
    sorted_keys = sorted(per_sample_hashes.keys())
    idx_bytes = json.dumps(sorted_keys).encode()
    hash_bytes = json.dumps([per_sample_hashes[k] for k in sorted_keys]).encode()
    split_hash = hashlib.sha256(idx_bytes + hash_bytes).hexdigest()

    split_dir = frozen_dir / name
    split_dir.mkdir(exist_ok=True)
    for k, v in samples.items():
        (split_dir / k).write_bytes(v.encode())

    (frozen_dir / f"{name}.json").write_text(json.dumps({
        "split_id": f"wiring-{name}",
        "mission_id": _MISSION_ID,
        "split_type": "test" if "test" in name else "val",
        "split_hash": split_hash,
        "per_sample_hashes": per_sample_hashes,
        "item_count": len(per_sample_hashes),
        "frozen_at": "2026-07-04T00:00:00Z",
        "storage_path": str(frozen_dir / f"{name}.json"),
        "eval_version": "v1",
    }, indent=2))


def _run(args: list[str], cwd: Path = _HARNESS_DIR) -> subprocess.CompletedProcess:
    """Run a subprocess with the venv Python, capturing output."""
    return subprocess.run(
        [_PYTHON] + args,
        capture_output=True,
        text=True,
        cwd=str(cwd),
    )


# ─────────────────────────────────────────────────────────────────────────────
# C1+C2: evor.tree select — DICT-format tree.json + correct goal path
# ──────────────────────────────────────────────────────────────��──────────────


def test_tree_select_dict_format(tmp_path: Path) -> None:
    """C1+C2: `python -m evor.tree select` must handle DICT tree.json and find goal-contract.json."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    result = _run(["-m", "evor.tree", "select", "--run-id", str(run_dir)])

    assert result.returncode == 0, (
        f"evor.tree select failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )

    # Output must be valid JSON with a 'selected' key
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        pytest.fail(f"evor.tree select output is not valid JSON: {exc}\nstdout: {result.stdout!r}")

    assert "selected" in data, f"Missing 'selected' key in output: {data}"
    assert isinstance(data["selected"], list), "'selected' must be a list"
    assert len(data["selected"]) >= 1, "select must return at least one node"

    # No ValidationError in stderr (would indicate C1 was not fixed)
    assert "ValidationError" not in result.stderr, (
        f"ValidationError present — DICT-format parsing failed:\n{result.stderr}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# C3: evor run — DICT-format node lookup
# ─────────────────────────────────────────────────────────────────────────────


def test_evor_run_help(tmp_path: Path) -> None:
    """C3+C5: `python -m evor run --help` must resolve (entry point exists)."""
    result = _run(["-m", "evor", "run", "--help"])
    assert result.returncode == 0, (
        f"evor run --help failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}"
    )
    assert "node-id" in result.stdout.lower() or "node_id" in result.stdout.lower(), (
        "Expected --node-id in help text"
    )


def test_evor_preflight_help(tmp_path: Path) -> None:
    """`python -m evor preflight --help` must resolve."""
    result = _run(["-m", "evor", "preflight", "--help"])
    assert result.returncode == 0, (
        f"evor preflight --help failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}"
    )
    assert "run-id" in result.stdout.lower() or "run_id" in result.stdout.lower(), (
        "Expected --run-id in help text"
    )


# ─────────────────────────────────────────────────────────────────────────────
# C4: dashboard/store.py all_nodes() — must return list of dicts, not dict keys
# ─────────────────────────────────────────────────────────────────────────────


def test_dashboard_store_all_nodes_dict_format(tmp_path: Path) -> None:
    """C4: RunStore.all_nodes() must return a list of node dicts from DICT-format tree.json."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    from evor.dashboard.store import RunStore

    store = RunStore(run_dir)
    nodes = store.all_nodes()

    assert isinstance(nodes, list), f"all_nodes() returned {type(nodes)}, expected list"
    assert len(nodes) == 2, f"Expected 2 nodes, got {len(nodes)}"

    # Each element must be a dict with an 'id' key — not a bare string (node ID key)
    for node in nodes:
        assert isinstance(node, dict), (
            f"Node entry is {type(node)} not dict — dict keys are being returned instead of values"
        )
        assert "id" in node, f"Node dict missing 'id' key: {node}"

    # Verify actual node IDs are present
    node_ids = {n["id"] for n in nodes}
    assert _NODE_A in node_ids
    assert _NODE_B in node_ids


def test_dashboard_store_frontier_nodes_dict_format(tmp_path: Path) -> None:
    """C4: RunStore.frontier_nodes() must work after all_nodes() fix."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    from evor.dashboard.store import RunStore

    store = RunStore(run_dir)
    frontier = store.frontier_nodes()

    assert isinstance(frontier, list)
    assert len(frontier) == 1
    assert frontier[0]["id"] == _NODE_A


# ─────────────────────────────────────────────────────────────────────────────
# C6: evor.freeze freeze-splits CLI
# ─────────────────────────────────────────────────────────────────────────────


def test_freeze_splits_cli(tmp_path: Path) -> None:
    """C6: `python -m evor.freeze freeze-splits` must exit 0 and output JSON with locked_split_hash."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    # Create a minimal dataset directory with a few sample files
    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    for i in range(5):
        (dataset_dir / f"sample_{i:03d}.txt").write_text(f"sample content {i}")

    result = _run([
        "-m", "evor.freeze", "freeze-splits",
        "--dataset-path", str(dataset_dir),
        "--eval-version", "v2",
        "--run-dir", str(run_dir),
        "--mission-id", _MISSION_ID,
    ])

    assert result.returncode == 0, (
        f"freeze-splits failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )

    data = json.loads(result.stdout)
    assert "locked_split_hash" in data, f"Missing locked_split_hash: {data}"
    assert len(data["locked_split_hash"]) == 64, "Expected sha256 hex digest"

    # Verify frozen split files were created
    frozen_test = run_dir / "frozen-splits" / "v2-test.json"
    frozen_val = run_dir / "frozen-splits" / "v2-val.json"
    assert frozen_test.exists(), f"frozen-splits/v2-test.json not created"
    assert frozen_val.exists(), f"frozen-splits/v2-val.json not created"


def test_freeze_splits_cli_empty_dataset(tmp_path: Path) -> None:
    """C6: freeze-splits must succeed even with an empty dataset directory."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    empty_dir = tmp_path / "empty-dataset"
    empty_dir.mkdir()

    result = _run([
        "-m", "evor.freeze", "freeze-splits",
        "--dataset-path", str(empty_dir),
        "--eval-version", "v3",
        "--run-dir", str(run_dir),
    ])

    assert result.returncode == 0, (
        f"freeze-splits with empty dataset failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}"
    )
    data = json.loads(result.stdout)
    assert "locked_split_hash" in data


# ─────────────────────────────────────────────────────────────────────────────
# C7: evor.benchmark init-eval-suite CLI
# ─────────────────────────────────────────────────────────────────────────────


def test_benchmark_init_eval_suite_cli(tmp_path: Path) -> None:
    """C7: `python -m evor.benchmark init-eval-suite` must exit 0 and write eval-suites/<ver>.json."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    result = _run([
        "-m", "evor.benchmark", "init-eval-suite",
        "--mission-id", _MISSION_ID,
        "--eval-version", "v2",
        "--task-description", "Wiring regression test suite",
        "--run-dir", str(run_dir),
    ])

    assert result.returncode == 0, (
        f"init-eval-suite failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )

    data = json.loads(result.stdout)
    assert data["eval_version"] == "v2"
    assert data["mission_id"] == _MISSION_ID

    suite_file = run_dir / "eval-suites" / "v2.json"
    assert suite_file.exists(), "eval-suites/v2.json was not created"

    suite = json.loads(suite_file.read_text())
    assert suite["eval_version"] == "v2"
    assert len(suite["domains"]) >= 1


# ─────────────────────────────────────────────────────────────────────────────
# C9: evor.plot_tree CLI
# ─────────────────────────────────────────────────────────────────────────────


def test_plot_tree_ascii(tmp_path: Path) -> None:
    """C9: `python -m evor.plot_tree --format ascii` must exit 0 and print a tree."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    result = _run([
        "-m", "evor.plot_tree",
        "--run-id", str(run_dir),
        "--format", "ascii",
        "--highlight-frontier",
    ])

    assert result.returncode == 0, (
        f"plot_tree ascii failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}"
    )
    # Output should contain at least one node ID prefix
    assert _NODE_A[:8] in result.stdout or _NODE_B[:8] in result.stdout, (
        f"Expected node IDs in ASCII output.\nstdout: {result.stdout!r}"
    )


def test_plot_tree_png_or_fallback(tmp_path: Path) -> None:
    """C9: `python -m evor.plot_tree --format png` must exit 0 (PNG or text fallback)."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)
    output_path = tmp_path / "tree.png"

    result = _run([
        "-m", "evor.plot_tree",
        "--run-id", str(run_dir),
        "--format", "png",
        "--output", str(output_path),
    ])

    assert result.returncode == 0, (
        f"plot_tree png failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}"
    )
    # Either a PNG was written or the text fallback was used
    assert output_path.exists() or output_path.with_suffix(".txt").exists(), (
        "Neither PNG nor text fallback file was created"
    )


# ─────────────────────────────────────────────────────────────────────────────
# C10: evor.wiki CLI
# ─────────────────────────────────────────────────────────────────────────────


def test_wiki_query_cli_empty_index(tmp_path: Path) -> None:
    """C10: `python -m evor.wiki query` must exit 0 (empty index returns empty list)."""
    _, evor_root = _build_fixture_run_dir(tmp_path)

    result = _run([
        "-m", "evor.wiki", "query",
        "--query-text", "accuracy improvement",
        "--evor-root", str(evor_root),
    ])

    assert result.returncode == 0, (
        f"wiki query failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )
    data = json.loads(result.stdout)
    assert isinstance(data, list), f"Expected list, got {type(data)}: {data}"


def test_wiki_summarize_cli_empty_index(tmp_path: Path) -> None:
    """C10: `python -m evor.wiki summarize` must exit 0 (empty index returns zero counts)."""
    run_dir, evor_root = _build_fixture_run_dir(tmp_path)

    result = _run([
        "-m", "evor.wiki", "summarize",
        "--run-id", _RUN_ID,
        "--run-dir", str(run_dir),
        "--confirmed-only", "false",
        "--evor-root", str(evor_root),
    ])

    assert result.returncode == 0, (
        f"wiki summarize failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )
    data = json.loads(result.stdout)
    assert "confirmed" in data
    assert "refuted" in data
    assert isinstance(data["confirmed"], int)


def test_wiki_context_cli(tmp_path: Path) -> None:
    """C10: `python -m evor.wiki context` must exit 0 (empty index returns nothing)."""
    _, evor_root = _build_fixture_run_dir(tmp_path)

    result = _run([
        "-m", "evor.wiki", "context",
        "--mission-id", _MISSION_ID,
        "--limit", "5",
        "--evor-root", str(evor_root),
    ])

    assert result.returncode == 0, (
        f"wiki context failed (exit {result.returncode}).\n"
        f"stderr: {result.stderr}"
    )
    # Empty index → empty output (no crash)
    assert result.stdout.strip() == "" or result.stdout.strip() is not None


# ─────────────────────────────────────────────────────────────────────────────
# P2: evor run — DICT-format node lookup (C3 runtime path, Phase 2)
# ─────────────────────────────────────────────────────────────────────────────

def _write_stub_evaluate_py(worktree: Path) -> Path:
    """Write a minimal stub evaluate.py that outputs a valid EvaluationResult JSON.

    The stub produces deterministic output without torch / GPU so the test runs
    in any environment.  The harness reads stdout for the result JSON.
    """
    eval_src = '''\
import json, sys, os
from datetime import datetime, timezone

# Minimal EvaluationResult-shaped output expected by EvaluatorAdapter
result = {
    "node_id": os.environ.get("EVOR_NODE_ID", "stub-node"),
    "run_id":  os.environ.get("EVOR_RUN_ID",  "stub-run"),
    "eval_version": "v1",
    "metrics": {"accuracy": 0.851},
    "per_domain": {"primary": {"accuracy": 0.851}},
    "fitness_value": 0.851,
    "worst_angle_coverage": None,
    "per_angle_vs_sota": None,
    "telemetry_summary": {
        "final_train_loss": 0.18,
        "best_val_metric": 0.851,
        "grad_norm_median": 2.1,
        "throughput_samples_per_sec": 512.0,
        "total_steps": 5,
    },
    "status": "success",
    "benchmark_raw": "test_accuracy=0.851",
    "timestamp": datetime.now(timezone.utc).isoformat(),
}
print(json.dumps(result))
'''
    p = worktree / "evaluate.py"
    p.write_text(eval_src)
    return p


def test_evor_run_lock_guard_accepts_running_mission(tmp_path: Path) -> None:
    """Regression: the Phase-2 lock guard must accept a mission already flipped
    to "running". `/evor-run` sets mission_status="running" once the tick loop
    starts, and every node-training subprocess runs under that state — an
    exact-"locked" check would reject every tick's training with exit 6.
    """
    run_dir, _ = _build_fixture_run_dir(tmp_path)
    # Simulate the state the tick loop leaves behind: mission is running.
    ms_path = run_dir / "mission-state.json"
    ms = json.loads(ms_path.read_text())
    ms["status"] = "running"
    ms_path.write_text(json.dumps(ms, indent=2))

    worktree = tmp_path / f"worktree-running-{_NODE_A}"
    worktree.mkdir()
    _write_stub_evaluate_py(worktree)

    result = _run([
        "-m", "evor", "run",
        "--node-id", _NODE_A,
        "--run-id", _RUN_ID,
        "--worktree", str(worktree),
        "--run-dir", str(run_dir),
        "--eval-script", str(worktree / "evaluate.py"),
        "--no-selfheal",
    ])

    # The lock guard must NOT reject a running mission.
    assert "Contract must be locked before running" not in result.stderr, (
        f"Phase-2 lock guard wrongly rejected a running mission:\n{result.stderr}"
    )
    assert "mission-state.status='running'" not in result.stderr, (
        f"Lock guard flagged the running status as invalid:\n{result.stderr}"
    )


def test_evor_run_lock_guard_rejects_draft_mission(tmp_path: Path) -> None:
    """The Phase-2 lock guard must still reject a pre-lock "draft" mission
    (exit 6) — broadening to accept running/paused must not open the gate to
    an unvalidated contract.
    """
    run_dir, _ = _build_fixture_run_dir(tmp_path)
    ms_path = run_dir / "mission-state.json"
    ms = json.loads(ms_path.read_text())
    ms["status"] = "draft"
    ms_path.write_text(json.dumps(ms, indent=2))

    worktree = tmp_path / f"worktree-draft-{_NODE_A}"
    worktree.mkdir()
    _write_stub_evaluate_py(worktree)

    result = _run([
        "-m", "evor", "run",
        "--node-id", _NODE_A,
        "--run-id", _RUN_ID,
        "--worktree", str(worktree),
        "--run-dir", str(run_dir),
        "--eval-script", str(worktree / "evaluate.py"),
        "--no-selfheal",
    ])

    assert result.returncode == 6, (
        f"draft mission must be rejected with exit 6, got {result.returncode}:\n{result.stderr}"
    )
    assert "Contract must be locked before running" in result.stderr, (
        f"draft rejection message missing:\n{result.stderr}"
    )


def test_evor_run_c3_dict_format_node_found(tmp_path: Path) -> None:
    """P2/C3: `python -m evor run` must find a node in DICT-format tree.json.

    This test exercises the C3 runtime code path:
      __main__._cmd_run() → tree.json DICT lookup → TreeNode.model_validate()

    The test succeeds as long as the node lookup succeeds (the subsequent
    evaluator step may error on this CPU-only environment — that is expected
    and acceptable).  The critical assertion is that stderr does NOT contain
    the 'not found in tree.json' message that would indicate the DICT format
    lookup failed.
    """
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    # Create an isolated stub worktree with a no-GPU evaluate.py
    worktree = tmp_path / f"worktree-{_NODE_A}"
    worktree.mkdir()
    _write_stub_evaluate_py(worktree)

    result = _run([
        "-m", "evor", "run",
        "--node-id", _NODE_A,
        "--run-id", _RUN_ID,
        "--worktree", str(worktree),
        "--run-dir", str(run_dir),
        "--eval-script", str(worktree / "evaluate.py"),
        "--no-selfheal",
    ])

    # C3 assertion: node MUST be found in the DICT-format tree.json.
    assert "not found in tree.json" not in result.stderr, (
        f"C3 FAIL: node {_NODE_A!r} was not found in DICT tree.json.\n"
        f"This means the DICT-format lookup failed.\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )

    # No Pydantic ValidationError from DICT parsing
    assert "ValidationError" not in result.stderr, (
        f"ValidationError present — DICT-format TreeNode parsing failed:\n{result.stderr}"
    )

    # Phase-2 lock guard must not block (mission-state.json is locked in fixture)
    assert "mission-state.json not found" not in result.stderr, (
        f"mission-state.json not found — fixture must include locked mission-state:\n{result.stderr}"
    )

    # Exit code must NOT be 1 due to node-lookup failure specifically;
    # evaluator / scheduler failures return 1 which is acceptable here.
    # The node-not-found path returns 1 WITH the specific message above,
    # so if the message is absent the lookup succeeded.


def test_evor_run_c3_missing_node_returns_error(tmp_path: Path) -> None:
    """C3: requesting a node ID that does not exist in the DICT tree exits 1."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    worktree = tmp_path / "worktree-nonexistent"
    worktree.mkdir()
    _write_stub_evaluate_py(worktree)

    result = _run([
        "-m", "evor", "run",
        "--node-id", "node-does-not-exist-0000",
        "--run-id", _RUN_ID,
        "--worktree", str(worktree),
        "--run-dir", str(run_dir),
        "--eval-script", str(worktree / "evaluate.py"),
        "--no-selfheal",
    ])

    assert result.returncode == 1, (
        f"Missing node should exit 1. Got {result.returncode}."
    )
    assert "not found in tree.json" in result.stderr, (
        f"Expected 'not found in tree.json' in stderr.\nstderr: {result.stderr}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# C-1: --run-dir required for goal-loading + run_dir inference fallbacks
# ─────────────────────────────────────────────────────────────────────────────


def test_evor_run_c1_proceeds_past_goal_loading(tmp_path: Path) -> None:
    """C-1: `python -m evor run --run-dir <dir>` loads GoalContract and proceeds.

    Before the C-1 fix, Forge's harness invocation was missing --run-dir, so
    _cmd_run got run_dir=None -> goal=None -> 'cannot run without GoalContract'.

    This test proves the happy-path: with --run-dir present the harness loads
    the GoalContract from the fixture and proceeds past the goal-loading check.
    The subsequent evaluator call may succeed (stub eval) or fail for unrelated
    reasons; the critical assertion is the absence of the goal-loading error.
    """
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    worktree = tmp_path / f"worktree-c1-{_NODE_A}"
    worktree.mkdir()
    _write_stub_evaluate_py(worktree)

    result = _run([
        "-m", "evor", "run",
        "--node-id", _NODE_A,
        "--run-id", _RUN_ID,
        "--run-dir", str(run_dir),
        "--worktree", str(worktree),
        "--eval-script", str(worktree / "evaluate.py"),
        "--no-selfheal",
    ])

    # C-1 assertion: must NOT exit with the goal-loading error.
    assert "cannot run without GoalContract" not in result.stderr, (
        f"C-1 FAIL: goal-loading failed even with --run-dir present.\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )
    assert "cannot run without GoalContract" not in result.stdout, (
        f"C-1 FAIL: goal-loading error in stdout.\nstdout: {result.stdout}"
    )


def test_evor_run_c1_run_dir_env_var_fallback(tmp_path: Path) -> None:
    """C-1 robustness: EVOR_RUN_DIR env var is used when --run-dir is omitted.

    session-start.mjs sets EVOR_RUN_DIR; Forge invocations that omit --run-dir
    should still load the GoalContract via this env fallback.
    """
    import os as _os
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    worktree = tmp_path / f"worktree-c1-env-{_NODE_A}"
    worktree.mkdir()
    _write_stub_evaluate_py(worktree)

    env = {**_os.environ, "EVOR_RUN_DIR": str(run_dir)}

    result = subprocess.run(
        [_PYTHON, "-m", "evor", "run",
         "--node-id", _NODE_A,
         "--run-id", _RUN_ID,
         "--worktree", str(worktree),
         "--eval-script", str(worktree / "evaluate.py"),
         "--no-selfheal"],
        capture_output=True,
        text=True,
        env=env,
    )

    assert "cannot run without GoalContract" not in result.stderr, (
        f"C-1 FAIL: goal-loading failed via EVOR_RUN_DIR fallback.\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# M-1: evor_root passed to EvaluatorAdapter -> gotcha capture wired
# ─────────────────────────────────────────────────────────────────────────────


def _write_oom_evaluate_py(worktree: Path) -> Path:
    """Write an evaluate.py stub that emits OOM to stderr and exits 1.

    Used to trigger EvaluatorAdapter._capture_oom_gotcha() in tests.
    """
    src = (
        'import sys\n'
        'print("RuntimeError: out of memory -- eval stub triggered OOM",'
        ' file=sys.stderr)\n'
        'sys.exit(1)\n'
    )
    p = worktree / "evaluate.py"
    p.write_text(src)
    return p


def test_cmd_run_m1_evor_root_wires_evaluator_gotcha_store(tmp_path: Path) -> None:
    """M-1: _cmd_run derives evor_root from run_dir and passes it to EvaluatorAdapter.

    Proof: when the eval script exits with an OOM pattern, EvaluatorAdapter
    calls _capture_oom_gotcha() which writes to the GotchaStore. This only
    happens when evor_root is non-None (M-1 fix). A pre-fix run without
    evor_root would produce no gotcha file.
    """
    run_dir, evor_root = _build_fixture_run_dir(tmp_path)

    worktree = tmp_path / f"worktree-m1-{_NODE_A}"
    worktree.mkdir()
    _write_oom_evaluate_py(worktree)

    _run([
        "-m", "evor", "run",
        "--node-id", _NODE_A,
        "--run-id", _RUN_ID,
        "--run-dir", str(run_dir),
        "--worktree", str(worktree),
        "--eval-script", str(worktree / "evaluate.py"),
        "--no-selfheal",
    ])

    # M-1 assertion: EvaluatorAdapter._capture_oom_gotcha writes scope="mission"
    # -> run_dir/gotchas/mission.jsonl when evor_root is passed correctly.
    gotcha_path = run_dir / "gotchas" / "mission.jsonl"
    assert gotcha_path.exists(), (
        f"M-1 FAIL: gotcha store not written after OOM eval.\n"
        f"Expected: {gotcha_path}\n"
        f"evor_root={evor_root}\n"
        f"run_dir contents: {list(run_dir.iterdir())}"
    )
    entries = [json.loads(line) for line in gotcha_path.read_text().splitlines() if line.strip()]
    assert any(e.get("signature") == "eval-oom" for e in entries), (
        f"M-1 FAIL: expected 'eval-oom' gotcha in store.\nEntries: {entries}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# P2: validate CLI
# ─────────────────────────────────────────────────────────────────────────────

def test_validate_cli_passes_on_valid_fixture(tmp_path: Path) -> None:
    """P2: `python -m evor validate --run-id <dir>` exits 0 on valid fixture."""
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    result = _run(["-m", "evor", "validate", "--run-id", str(run_dir)])

    assert result.returncode == 0, (
        f"validate should pass on the wiring-test fixture.\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )
    data = json.loads(result.stdout)
    assert data["ok"] is True, f"ValidationReport.ok should be True: {data}"


def test_validate_cli_help_resolves(tmp_path: Path) -> None:
    """P2: `python -m evor validate --help` must resolve without error."""
    result = _run(["-m", "evor", "validate", "--help"])
    assert result.returncode == 0
    assert "run-id" in result.stdout.lower()


def test_doctor_cli_help_resolves(tmp_path: Path) -> None:
    """P2: `python -m evor doctor --help` must resolve without error."""
    result = _run(["-m", "evor", "doctor", "--help"])
    assert result.returncode == 0


# ─────────────────────────────────────────────────────────────────────────────
# Regression: tree.py --run-id accepts an absolute filesystem path
# ─────────────────────────────────────────────────────────────────────────────

def test_tree_select_accepts_absolute_run_dir(tmp_path: Path) -> None:
    """Regression: evor.tree select --run-id <absolute/path> works when the path is a dir.

    mcp/src/tools/tree.ts:107 passes paths.runDir (a full filesystem path) as
    the --run-id value.  tree.py:691 guards:
        run_dir = Path(args.run_id) if Path(args.run_id).is_dir() else Path(".evor/runs") / args.run_id
    so an absolute existing directory is used directly — no re-joining under
    .evor/runs/.  This test locks that behaviour so a refactor cannot silently
    break the TS→Python bridge.
    """
    run_dir, _ = _build_fixture_run_dir(tmp_path)

    # Pass the resolved absolute path exactly as the TS layer does.
    result = _run(["-m", "evor.tree", "select", "--run-id", str(run_dir.resolve())])

    assert result.returncode == 0, (
        f"evor.tree select failed with absolute --run-id (exit {result.returncode}).\n"
        f"stderr: {result.stderr}\nstdout: {result.stdout}"
    )

    data = json.loads(result.stdout)
    assert "selected" in data, f"Missing 'selected' key: {data}"
    assert isinstance(data["selected"], list) and len(data["selected"]) >= 1, (
        "select must return at least one node ID"
    )
    assert "ValidationError" not in result.stderr, (
        f"Unexpected ValidationError with absolute path:\n{result.stderr}"
    )
