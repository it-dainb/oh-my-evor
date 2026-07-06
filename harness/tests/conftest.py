"""Shared pytest fixtures for harness tests.

The ``evor_root`` fixture creates a minimal but complete ``.evor/``-style
directory in ``tmp_path`` so dashboard tests are standalone and do not require
a live training run.  All data matches the Pydantic contracts in
``evor.contracts``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

# ── Constants ─────────────────────────────────────────────────────────────────

MISSION_ID = "test-mission-2026-07"
RUN_ID = "run-20260703T000000"

NODE_A = "node-aaaaaaaa-0001"
NODE_B = "node-bbbbbbbb-0002"


# ── Data factories ────────────────────────────────────────────────────────────


def _goal_contract(mission_type: str = "fixed") -> dict:
    return {
        "mission_id": MISSION_ID,
        "mode": "from-scratch",
        "mission_type": mission_type,
        "task_description": "Improve CIFAR-10 accuracy",
        "dataset_ref": "/data/cifar10",
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
        "fitness_mode": "worst-domain" if mission_type == "open_ended" else "aggregate",
        "eval_version": "v1",
        "baseline_value": 0.720,
        "target_value": 0.850,
        "coverage_target": 0.90 if mission_type == "open_ended" else None,
        "stop_condition": {"type": "coverage-target" if mission_type == "open_ended" else "target"},
        "wildness": 0.5,
        "budget": {
            "max_iterations": 50,
            "plateau_window": 8,
            "circuit_breaker": 5,
            "max_cost_usd": 0.0,
        },
        "framework": "pytorch",
        "seed_repo_path": None,
        "locked_split_hash": "abc123deadbeef",
        "eval_script_hash": "def456cafebabe",
        "expansion_policy": (
            {
                "auto_add_within_families": ["arch"],
                "require_consent_for": ["data-acquisition"],
                "sota_sources": [
                    {
                        "source_id": "src-pwc",
                        "name": "Papers With Code",
                        "url": "https://paperswithcode.com",
                        "retrieval_method": "web_fetch",
                        "trust_level": "authoritative",
                    }
                ],
                "max_angles_per_upgrade": 3,
                "max_upgrades_per_N_ticks": {"max_upgrades": 1, "per_ticks": 5},
                "pretraining_canary_threshold_pp": 5.0,
            }
            if mission_type == "open_ended"
            else None
        ),
        "allowed_licenses": ["MIT", "Apache-2.0", "CC-BY-4.0"],
        "created_at": "2026-07-03T00:00:00Z",
    }


def _run_state(frontier_ids: list[str] | None = None) -> dict:
    return {
        "status": "running",
        "tick_count": 3,
        "best_score": 0.851,
        "frontier_ids": frontier_ids if frontier_ids is not None else [NODE_A],
        "current_eval_version": "v1",
        "hypotheses": [],
    }


def _make_node(
    node_id: str,
    parent_ids: list[str],
    depth: int,
    score: float,
    family: str = "arch",
    eval_version: str = "v1",
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
        "mutation_locus": {"family": family, "path": "model/"},
        "data_version_ref": "data-v1-hash",
        "config": {},
        "weights_ref": None,
        "metrics": {"accuracy": score},
        "eval_version": eval_version,
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
        "created_at": "2026-07-03T01:00:00Z",
        "completed_at": "2026-07-03T02:00:00Z",
    }


def _make_result(
    node_id: str,
    run_id: str,
    score: float,
    include_angles: bool = False,
    eval_version: str = "v1",
) -> dict:
    result: dict = {
        "node_id": node_id,
        "run_id": run_id,
        "eval_version": eval_version,
        "metrics": {"accuracy": score},
        "per_domain": {
            "scanned": {"accuracy": round(score + 0.02, 4)},
            "handwritten": {"accuracy": round(score - 0.03, 4)},
        },
        "fitness_value": score,
        "worst_angle_coverage": None,
        "per_angle_vs_sota": None,
        "telemetry_summary": {
            "final_train_loss": 0.182,
            "best_val_metric": score,
            "grad_norm_median": 2.31,
            "throughput_samples_per_sec": 512.0,
            "total_steps": 500,
        },
        "status": "success",
        "benchmark_raw": f"test_accuracy={score}",
        "timestamp": "2026-07-03T02:00:00Z",
    }
    if include_angles:
        result["per_angle_vs_sota"] = {
            "scanned": {
                "value": round(score + 0.02, 4),
                "sota_bar": 0.88,
                "above_sota": (score + 0.02) >= 0.88,
            },
            "handwritten": {
                "value": round(score - 0.03, 4),
                "sota_bar": 0.85,
                "above_sota": (score - 0.03) >= 0.85,
            },
        }
        # 1 of 2 angles above sota for score=0.851 (scanned=0.871 < 0.88, handwritten=0.821 < 0.85)
        result["worst_angle_coverage"] = 0.0
    return result


def _make_integrity(node_id: str, eval_version: str = "v1") -> dict:
    return {
        "node_id": node_id,
        "eval_version": eval_version,
        "checks": {
            "split_hash_match": True,
            "frozen_split_read_only": True,
            "no_test_leakage": True,
            "near_dup_leakage": False,
            "data_provenance_valid": True,
            "no_label_contamination": True,
            "no_eval_shift": True,
            "eval_version_consistent": True,
            "telemetry_sane": True,
            "reward_hacking_probe": False,
            "acquisition_contamination_clear": None,
            "acquired_data_provenance_valid": None,
            "acquisition_namespace_enforced": None,
        },
        "verdict": "passed",
        "failure_reason": None,
        "verified_at": "2026-07-03T02:05:00Z",
    }


def _make_eval_suite(
    version: str,
    prev_version: str | None = None,
    extra_domain: str | None = None,
) -> dict:
    domains = [
        {
            "domain_id": "scanned",
            "description": "Scanned document images",
            "metric_specs": [
                {
                    "metric_name": "accuracy",
                    "direction": "higher",
                    "domain_applicability": ["scanned"],
                    "aggregation_rule": "macro_avg",
                    "role": "primary_fitness",
                    "sota_bar": 0.88,
                }
            ],
            "sota_source": None,
            "added_at_eval_version": "v1",
        },
        {
            "domain_id": "handwritten",
            "description": "Handwritten document images",
            "metric_specs": [
                {
                    "metric_name": "accuracy",
                    "direction": "higher",
                    "domain_applicability": ["handwritten"],
                    "aggregation_rule": "macro_avg",
                    "role": "primary_fitness",
                    "sota_bar": 0.85,
                }
            ],
            "sota_source": None,
            "added_at_eval_version": "v1",
        },
    ]
    if extra_domain:
        domains.append(
            {
                "domain_id": extra_domain,
                "description": "Additional evaluation domain",
                "metric_specs": [
                    {
                        "metric_name": "accuracy",
                        "direction": "higher",
                        "domain_applicability": [extra_domain],
                        "aggregation_rule": "macro_avg",
                        "role": "primary_fitness",
                        "sota_bar": 0.80,
                    }
                ],
                "sota_source": None,
                "added_at_eval_version": version,
            }
        )
    return {
        "eval_version": version,
        "mission_id": MISSION_ID,
        "parent_eval_version": prev_version,
        "domains": domains,
        "split_hashes": {"scanned": "aaa111", "handwritten": "bbb222"},
        "created_at": "2026-07-03T00:00:00Z",
        "created_by": "user",
        "consent_log_ref": "decision-log-entry-1",
    }


def _make_angle_registry() -> dict:
    return {
        "mission_id": MISSION_ID,
        "angles": [
            {
                "angle_id": "scanned",
                "eval_version_added": "v1",
                "sota_bar": 0.88,
                "sota_source_ids": ["src-pwc", "src-arxiv"],
                "sota_quorum_met": True,
                "baseline_model_score_before_finetune": 0.810,
                "sota_retrieved_at": "2026-07-03T00:00:00Z",
                "held_out_split_hash": "aaa111",
                "is_public_benchmark": True,
                "pretraining_contamination_risk": "medium",
            },
            {
                "angle_id": "handwritten",
                "eval_version_added": "v1",
                "sota_bar": 0.85,
                "sota_source_ids": ["src-pwc"],
                "sota_quorum_met": False,
                "baseline_model_score_before_finetune": None,
                "sota_retrieved_at": "2026-07-03T00:00:00Z",
                "held_out_split_hash": "bbb222",
                "is_public_benchmark": True,
                "pretraining_contamination_risk": "unknown",
            },
        ],
        "updated_at": "2026-07-03T00:00:00Z",
    }


def _make_strategy() -> dict:
    return {
        "meta_iteration": 1,
        "selection_policy": "ucb1",
        "ucb1_c": 1.41,
        "beam_width": None,
        "wildness": 0.5,
        "family_mix": {
            "arch": 0.2, "training": 0.2, "data-curation": 0.15,
            "data-augmentation": 0.15, "data-acquisition": 0.1,
            "algo": 0.15, "other": 0.05,
        },
        "winning_families": ["arch", "training", "arch"],
        "wins_by_family": {"arch": 2, "training": 1},
        "meta_loop_interval": 5,
        "post_upgrade_exploration_boost": None,
        "post_upgrade_exploration_ticks": 0,
        "rescore_mode": "sync",
        "updated_at": "2026-07-03T02:00:00Z",
    }


def _telemetry_lines(node_id: str, run_id: str, steps: int = 5) -> str:
    lines = []
    for i in range(steps):
        rec = {
            "step": i,
            "epoch": round(i / steps, 3),
            "train_loss": round(1.0 - i * 0.12, 4),
            "val_metric": round(0.70 + i * 0.025, 4),
            "lr": 0.001,
            "grad_norm": round(2.0 + i * 0.1, 3),
            "throughput": 512.0,
            "node_id": node_id,
            "run_id": run_id,
            "timestamp": f"2026-07-03T01:0{i}:00Z",
        }
        lines.append(json.dumps(rec))
    return "\n".join(lines) + "\n"


# ── Fixture builders ──────────────────────────────────────────────────────────


def build_run(
    root: Path,
    mission_type: str = "fixed",
    include_angles: bool = False,
) -> Path:
    """Populate a full run directory structure under *root* and return ``root``."""
    run_dir = root / "runs" / MISSION_ID / RUN_ID

    for sub in ("nodes", "evaluations", "eval-suites"):
        (run_dir / sub).mkdir(parents=True, exist_ok=True)
    (run_dir / "nodes" / NODE_A).mkdir(parents=True, exist_ok=True)
    (run_dir / "nodes" / NODE_B).mkdir(parents=True, exist_ok=True)

    # Core run files
    (run_dir / "goal-contract.json").write_text(json.dumps(_goal_contract(mission_type)))
    (run_dir / "run-state.json").write_text(json.dumps(_run_state()))
    (run_dir / "strategy.json").write_text(json.dumps(_make_strategy()))

    # Tree (DICT format: {"nodes": {"<id>": {...}}, "updated_at": "..."})
    node_a = _make_node(NODE_A, [], 0, 0.851, "arch")
    node_b = _make_node(NODE_B, [NODE_A], 1, 0.823, "training")
    (run_dir / "tree.json").write_text(
        json.dumps({"nodes": {NODE_A: node_a, NODE_B: node_b}, "updated_at": "2026-01-01T00:00:00Z"})
    )

    # Per-node data
    for node_id, score in [(NODE_A, 0.851), (NODE_B, 0.823)]:
        result = _make_result(node_id, RUN_ID, score, include_angles)
        (run_dir / "nodes" / node_id / "results.json").write_text(json.dumps(result))
        (run_dir / "nodes" / node_id / "telemetry.jsonl").write_text(
            _telemetry_lines(node_id, RUN_ID)
        )
        (run_dir / "evaluations" / f"{node_id}.json").write_text(
            json.dumps(_make_integrity(node_id))
        )

    # Eval suites
    (run_dir / "eval-suites" / "v1.json").write_text(
        json.dumps(_make_eval_suite("v1"))
    )

    # Angle registry — only for open_ended (but written regardless; coverage
    # endpoint guards on mission_type)
    if include_angles:
        (run_dir / "angle-registry.json").write_text(
            json.dumps(_make_angle_registry())
        )

    return root


# ── Pytest fixtures ───────────────────────────────────────────────────────────


@pytest.fixture()
def evor_root(tmp_path: Path) -> Path:
    """Minimal .evor/ root with one fixed-mission run."""
    return build_run(tmp_path / ".evor", mission_type="fixed", include_angles=False)


@pytest.fixture()
def evor_root_open(tmp_path: Path) -> Path:
    """Minimal .evor/ root with one open_ended run (includes angle-registry)."""
    return build_run(tmp_path / ".evor", mission_type="open_ended", include_angles=True)


@pytest.fixture()
def client(evor_root: Path):
    """Sync TestClient for the fixed-mission dashboard."""
    from fastapi.testclient import TestClient

    from evor.dashboard.server import create_app

    return TestClient(create_app(evor_root))


@pytest.fixture()
def open_client(evor_root_open: Path):
    """Sync TestClient for the open_ended-mission dashboard."""
    from fastapi.testclient import TestClient

    from evor.dashboard.server import create_app

    return TestClient(create_app(evor_root_open))
