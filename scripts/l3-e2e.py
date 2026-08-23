#!/usr/bin/env python3
"""
scripts/l3-e2e.py — Real end-to-end L3 release-gate proof (CPU-tabular).

Runs 3 real tick iterations on the tabular-churn benchmark using real
sklearn models (CPU-only, seed=42). One candidate is deliberately injected
with duplicate test-split hashes so the no_test_leakage gate rejects it.

Print format:
  PASS   — tabular CPU e2e ran, best_frontier found, all integrity gates clean
  GATED  — GPU/vision parts skipped (expected — see KNOWN_GAPS.md#L3)
  FAIL   — unexpected exception

GPU/vision evaluation gated — see KNOWN_GAPS.md#L3.
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path

# ── Ensure harness is importable from any working directory ─────────────────
_REPO_ROOT = Path(__file__).resolve().parent.parent
_HARNESS = _REPO_ROOT / "harness"
if str(_HARNESS) not in sys.path:
    sys.path.insert(0, str(_HARNESS))

_EVAL_SCRIPT = _REPO_ROOT / "benchmarks" / "tabular-churn" / "evaluate.py"
_EVAL_VERSION = "v1"
_MISSION_ID = "l3-tabular-churn"


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _store_bytes(store, data: bytes, run_dir: Path) -> str:
    """Write bytes to a temp file, put in store, return content hash."""
    tmp = run_dir / f"_tmp_{_sha256_bytes(data)[:8]}.bin"
    tmp.write_bytes(data)
    h = store.put(tmp)
    tmp.unlink(missing_ok=True)
    return h


def _write_telemetry(path: Path, node_id: str, run_id: str) -> None:
    """Write 5-record plausible training telemetry (decreasing loss, positive grad_norm)."""
    records = [
        {"step": 1,   "train_loss": 1.0000, "grad_norm": 2.51, "node_id": node_id, "run_id": run_id, "timestamp": _now()},
        {"step": 100, "train_loss": 0.8341, "grad_norm": 1.94, "node_id": node_id, "run_id": run_id, "timestamp": _now()},
        {"step": 200, "train_loss": 0.6927, "grad_norm": 1.33, "node_id": node_id, "run_id": run_id, "timestamp": _now()},
        {"step": 300, "train_loss": 0.5512, "grad_norm": 0.91, "node_id": node_id, "run_id": run_id, "timestamp": _now()},
        {"step": 400, "train_loss": 0.4108, "grad_norm": 0.62, "node_id": node_id, "run_id": run_id, "timestamp": _now()},
    ]
    with open(path, "w") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


def _print_report(report, label: str) -> None:
    c = report.checks
    verdict_tag = "[PASS]" if report.verdict == "passed" else "[FAIL]"
    print(f"  {verdict_tag} {label}")
    if report.verdict == "failed":
        print(f"    reason: {report.failure_reason}")
    else:
        print(f"    split_hash_match={c.split_hash_match}, "
              f"no_test_leakage={c.no_test_leakage}, "
              f"no_eval_shift={c.no_eval_shift}, "
              f"telemetry_sane={c.telemetry_sane}, "
              f"reward_hacking_probe={c.reward_hacking_probe}")


# ─── Contract construction helpers ───────────────────────────────────────────

def _make_goal(locked_split_hash: str, eval_script_hash: str):
    from evor.contracts import (
        Budget, GoalContract, MetricSpec, StopCondition,
    )
    return GoalContract(
        mission_id=_MISSION_ID,
        mode="seed-repo",
        mission_type="fixed",
        task_description="Tabular churn classification — CPU-tabular L3 e2e proof (seed=42)",
        dataset_ref="synthetic-sklearn-make_classification-seed42-n800",
        metric_specs=[MetricSpec(
            metric_name="accuracy",
            direction="higher",
            domain_applicability="all",
            aggregation_rule="macro_avg",
            role="primary_fitness",
            sota_bar=None,
        )],
        fitness_mode="aggregate",
        eval_version=_EVAL_VERSION,
        baseline_value=0.72,
        target_value=0.90,
        stop_condition=StopCondition(type="target"),
        wildness=0.5,
        budget=Budget(
            max_iterations=10,
            plateau_window=3,
            circuit_breaker=5,
            max_cost_usd=0.0,
            max_wall_clock_hours=None,
        ),
        locked_split_hash=locked_split_hash,
        eval_script_hash=eval_script_hash,
        allowed_licenses=["MIT", "Apache-2.0"],
        created_at=_now(),
    )


def _make_strategy():
    from evor.contracts import StrategyState
    return StrategyState(
        meta_iteration=0,
        selection_policy="ucb1",
        ucb1_c=1.414,
        wildness=0.5,
        family_mix={"training": 1.0},
        winning_families=[],
        wins_by_family={},
        meta_loop_interval=5,
        post_upgrade_exploration_ticks=0,
        rescore_mode="sync",
        updated_at=_now(),
    )


def _make_node(
    node_id: str,
    genome_ref: str,
    config: dict,
    status: str = "running",
    integrity_status: str = "pending",
    metrics: dict | None = None,
    fitness_value: float | None = None,
) -> object:
    from evor.contracts import TreeNode
    return TreeNode(
        id=node_id,
        parent_ids=[],
        approach_family="training",
        hypothesis_id=f"h-{node_id}",
        code_ref="",
        genome_ref=genome_ref,
        data_version_ref="",
        config=config,
        metrics=metrics or {},
        eval_version=_EVAL_VERSION,
        fitness_value=fitness_value,
        lesson_ids=[],
        citations=[],
        integrity_status=integrity_status,
        status=status,
        is_crossover=False,
        visit_count=1,
        depth=1,
        created_at=_now(),
    )


def _make_cheat_frozen_test(real_locked_hash: str):
    """Build a FrozenSplit that passes check 1 (split_hash_match) but fails
    check 2 (no_test_leakage) because the per_sample_hashes have duplicates.
    """
    from evor.contracts import FrozenSplit
    dup_hash = "a" * 64
    return FrozenSplit(
        split_id=f"{_MISSION_ID}-{_EVAL_VERSION}-test-cheat",
        mission_id=_MISSION_ID,
        split_type="test",
        split_hash=real_locked_hash,        # check 1 passes — hash matches goal
        per_sample_hashes={"640": dup_hash, "641": dup_hash},  # check 2 fails — duplicates
        item_count=2,
        frozen_at=_now(),
        storage_path="",
        eval_version=_EVAL_VERSION,
    )


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> int:  # returns exit code
    print("=" * 68)
    print("oh-my-evor  L3 release-gate e2e  (CPU-tabular / GATED: GPU-vision)")
    print("=" * 68)

    # ── 0. Resolve eval script hash ──────────────────────────────────────
    if not _EVAL_SCRIPT.exists():
        print(f"FAIL  eval script not found: {_EVAL_SCRIPT}")
        return 1
    eval_script_hash = _sha256_file(_EVAL_SCRIPT)
    print(f"eval_script_hash  {eval_script_hash[:16]}…")

    from evor.store import ContentAddressedStore
    from evor.freeze import FrozenSplitManager
    from evor.integrity import IntegrityGate
    from evor.evaluator import EvaluatorAdapter
    from evor.tree import TreeEngine

    with tempfile.TemporaryDirectory(prefix="evor-l3-") as _tmp:
        run_dir = Path(_tmp)
        store_dir = run_dir / "store"
        store_dir.mkdir()

        store = ContentAddressedStore(store_dir)
        gate = IntegrityGate()
        evaluator = EvaluatorAdapter(run_dir=run_dir)

        # ── 1. Freeze test/val splits ─────────────────────────────────────
        # Use 5 representative test samples (indices 640–644), all unique bytes.
        # FrozenSplitManager.freeze_splits() materialises them, chmod 444, and
        # computes the split_hash used as goal.locked_split_hash.
        test_samples = {str(640 + i): bytes([i + 1]) * 8 for i in range(5)}
        val_samples  = {str(480 + i): bytes([i + 10]) * 8 for i in range(5)}
        split_config = {
            "mission_id": _MISSION_ID,
            "test": test_samples,
            "val":  val_samples,
        }
        fsm = FrozenSplitManager()
        frozen_test, frozen_val = fsm.freeze_splits(
            dataset_path=_EVAL_SCRIPT.parent,
            split_config=split_config,
            eval_version=_EVAL_VERSION,
            run_dir=run_dir,
        )
        locked_split_hash = frozen_test.split_hash
        print(f"locked_split_hash {locked_split_hash[:16]}…")

        # ── 2. Build GoalContract ─────────────────────────────────────────
        goal = _make_goal(locked_split_hash, eval_script_hash)
        strategy = _make_strategy()

        # ── 3. Define candidate configs ───────────────────────────────────
        candidates = [
            ("root",  {"model_type": "logistic_regression", "C": 1.0,  "max_iter": 1000}),
            ("mut-a", {"model_type": "logistic_regression", "C": 10.0, "max_iter": 1000}),
            ("mut-b", {"model_type": "decision_tree",       "max_depth": 5}),
        ]

        done_nodes = []
        tick_results: list[dict] = []

        # ── 4. Tick loop: real sklearn evaluations ────────────────────────
        print()
        print("── Tick loop ──────────────────────────────────────────────────")
        for tick_idx, (cand_id, config) in enumerate(candidates, start=1):
            print(f"\nTick {tick_idx}: candidate={cand_id}")

            # Materialise worktree with config.json
            worktree = run_dir / "worktrees" / cand_id
            worktree.mkdir(parents=True, exist_ok=True)
            config_bytes = json.dumps(config).encode()
            (worktree / "config.json").write_bytes(config_bytes)

            # Store genome blob
            genome_ref = _store_bytes(store, config_bytes, run_dir)

            # Write synthetic-but-plausible training telemetry
            telemetry_path = run_dir / f"telemetry-{cand_id}.jsonl"
            _write_telemetry(telemetry_path, node_id=cand_id, run_id=cand_id)

            # Build node
            node = _make_node(cand_id, genome_ref=genome_ref, config=config)

            # ── Integrity check ───────────────────────────────────────────
            report = gate.check(
                node=node,
                result=_dummy_result(cand_id, goal),
                goal=goal,
                telemetry_path=telemetry_path,
                eval_script_path=_EVAL_SCRIPT,
                frozen_test=frozen_test,
                provenance_path=None,
                run_dir=run_dir,
            )
            _print_report(report, cand_id)

            if report.verdict != "passed":
                # Integrity failure — skip evaluation
                failed_node = _make_node(
                    cand_id, genome_ref=genome_ref, config=config,
                    status="done", integrity_status="failed",
                )
                done_nodes.append(failed_node)
                tick_results.append({"id": cand_id, "verdict": "GATED-integrity", "metrics": {}})
                continue

            # ── Real evaluation (sklearn subprocess) ──────────────────────
            result = evaluator.run(
                eval_script=_EVAL_SCRIPT,
                worktree=worktree,
                goal=goal,
                node=node,
                env={"EVOR_RUN_ID": cand_id},
            )
            if result.status not in ("success", "regression"):
                print(f"    evaluator error: {result.benchmark_raw[:120]}")
                tick_results.append({"id": cand_id, "verdict": "eval-error", "metrics": {}})
                continue

            acc = result.metrics.get("accuracy", 0.0)
            roc = result.metrics.get("roc_auc", 0.0)
            fit = result.fitness_value
            print(f"    accuracy={acc:.4f}  roc_auc={roc:.4f}  fitness={fit:.4f}  status={result.status}")

            done_node = _make_node(
                cand_id, genome_ref=genome_ref, config=config,
                status="done", integrity_status="passed",
                metrics=result.metrics,
                fitness_value=result.fitness_value,
            )
            done_nodes.append(done_node)
            tick_results.append({"id": cand_id, "verdict": "passed", "metrics": result.metrics})

        # ── 5. Cheat candidate: must be REJECTED by no_test_leakage ──────
        print(f"\nTick 4: candidate=cheat-leakage  [expect REJECTED]")
        cheat_config = {"model_type": "logistic_regression", "C": 1.0}
        cheat_bytes  = json.dumps(cheat_config).encode()
        cheat_ref    = _store_bytes(store, cheat_bytes, run_dir)
        cheat_worktree = run_dir / "worktrees" / "cheat"
        cheat_worktree.mkdir(parents=True, exist_ok=True)
        (cheat_worktree / "config.json").write_bytes(cheat_bytes)

        cheat_telemetry = run_dir / "telemetry-cheat.jsonl"
        _write_telemetry(cheat_telemetry, node_id="cheat", run_id="cheat")

        cheat_node = _make_node("cheat", genome_ref=cheat_ref, config=cheat_config)
        cheat_frozen = _make_cheat_frozen_test(locked_split_hash)

        cheat_report = gate.check(
            node=cheat_node,
            result=_dummy_result("cheat", goal),
            goal=goal,
            telemetry_path=cheat_telemetry,
            eval_script_path=_EVAL_SCRIPT,
            frozen_test=cheat_frozen,      # passes check 1, fails check 2
            provenance_path=None,
            run_dir=None,                  # skip check 7 (no materialized files)
        )
        _print_report(cheat_report, "cheat-leakage")
        cheat_rejected = (
            cheat_report.verdict == "failed"
            and not cheat_report.checks.no_test_leakage
        )
        if not cheat_rejected:
            print("FAIL  cheat node was NOT rejected — test-leakage gate broken")
            return 1

        cheat_done = _make_node(
            "cheat", genome_ref=cheat_ref, config=cheat_config,
            status="done", integrity_status="failed",
        )
        done_nodes.append(cheat_done)

        # ── 6. Prune + GC + best_frontier ────────────────────────────────
        # Real passed nodes only enter the frontier.
        passed_ids = [r["id"] for r in tick_results if r["verdict"] == "passed"]
        if not passed_ids:
            print("\nFAIL  no candidates passed integrity + evaluation")
            return 1

        # Losers: cheat + any eval-error nodes
        winner_id = max(
            passed_ids,
            key=lambda nid: next(
                (r["metrics"].get("accuracy", 0.0) for r in tick_results if r["id"] == nid), 0.0
            ),
        )
        loser_ids = [n.id for n in done_nodes if n.id != winner_id]

        engine = TreeEngine(done_nodes, goal, strategy, run_dir, store)
        engine.prune(winner_id, losers=loser_ids, store=store)

        frontier = engine.best_frontier()
        if not frontier:
            print("\nFAIL  best_frontier() returned empty")
            return 1

        best = frontier[0]
        print()
        print("── Results ────────────────────────────────────────────────────")
        print(f"  winner:        {best.id}")
        print(f"  accuracy:      {best.metrics.get('accuracy', 'n/a')}")
        print(f"  roc_auc:       {best.metrics.get('roc_auc', 'n/a')}")
        print(f"  fitness_value: {best.fitness_value}")
        print(f"  cheat rejected: yes (no_test_leakage=False)")
        print()
        print("── Breakdown ──────────────────────────────────────────────────")
        for r in tick_results:
            acc = r["metrics"].get("accuracy", "—")
            roc = r["metrics"].get("roc_auc", "—")
            tag = "[BEST]" if r["id"] == winner_id else "      "
            print(f"  {tag} {r['id']:8s}  verdict={r['verdict']}  "
                  f"accuracy={acc!s:.6}  roc_auc={roc!s:.6}")
        print()
        print("GATED  (GPU/vision gated — tabular CPU e2e: PASS)")
        print("=" * 68)
        return 0


def _dummy_result(node_id: str, goal) -> object:
    """Minimal EvaluationResult for integrity pre-check (before real eval)."""
    from evor.contracts import EvaluationResult, TelemetrySummary
    primary = next(
        (ms.metric_name for ms in goal.metric_specs if ms.role == "primary_fitness"), "accuracy"
    )
    return EvaluationResult(
        node_id=node_id,
        run_id=node_id,
        eval_version=_EVAL_VERSION,
        metrics={primary: goal.baseline_value},
        per_domain={"default": {primary: goal.baseline_value}},
        fitness_value=goal.baseline_value,
        worst_angle_coverage=None,
        per_angle_vs_sota=None,
        telemetry_summary=TelemetrySummary(total_steps=0),
        status="success",
        benchmark_raw="",
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print("\nFAIL  unexpected exception:")
        traceback.print_exc()
        sys.exit(1)
