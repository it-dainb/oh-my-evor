"""
test_tick_loop.py — end-to-end object-level tick DRY-RUN (M8, GPU-free).

Exercises the full 9-step tick pipeline using real Python modules with a
fake evaluator (a tiny script that echoes a JSON result to stdout — no
GPU or torch required):

  1.  Create a ContentAddressedStore + freeze a tiny test/val split
  2.  Seed a root TreeNode
  3.  TreeEngine.select() → root picked (unvisited, UCB1 score = inf)
  4.  Propose a mutation  (manual MutationProposal, 1 parent)
  5.  Propose a crossover (TreeEngine.propose_crossover, 2 parents)
  6.  IntegrityGate.check():
        • SEEDED cheating node (test-leakage via duplicate per_sample_hashes) → REJECTED
        • Clean node (proper split) → PASSES
  7.  EvaluatorAdapter.run(fake_evaluator_script) → per-domain EvaluationResult
  8.  Record node into tree-store (write nodes/<id>/results.json)
  9.  TreeEngine.prune() + ContentAddressedStore.gc()
  10. TreeEngine.best_frontier()
  11. TreeEngine.meta_evolve() tick

Assertions:
  - loop closes (meta_evolve returns valid updated StrategyState)
  - tree grows from 1 node (root) to 4 nodes (root + clean + cheat + branch)
  - integrity gate rejects the cheat; clean node passes
  - clean node's results.json is written to nodes/<id>/results.json
"""
from __future__ import annotations

import hashlib
import json
import textwrap
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evor.contracts import (
    CriticReview,
    EvaluationResult,
    GenomeConfig,
    GoalContract,
    Hypothesis,
    MutationProposal,
    StrategyState,
    TelemetrySummary,
    TreeNode,
    FrozenSplit,
)
from evor.evaluator import EvaluatorAdapter
from evor.freeze import FrozenSplitManager, _compute_split_hash
from evor.integrity import IntegrityGate
from evor.store import ContentAddressedStore
from evor.tree import TreeEngine


# ─────────────────────────────────────────────────────────────────────────────
# Test helpers / factories
# ─────────────────────────────────────────────────────────────────────────────


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _make_goal(locked_split_hash: str, eval_script_hash: str) -> GoalContract:
    return GoalContract(
        mission_id="tick-loop-mission",
        mode="from-scratch",
        mission_type="fixed",
        task_description="Tick-loop dry-run (GPU-free)",
        dataset_ref="/data/fake",
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
        baseline_value=0.70,
        target_value=0.90,
        stop_condition={"type": "target"},
        wildness=0.5,
        budget={
            "max_iterations": 10,
            "plateau_window": 5,
            "circuit_breaker": 3,
            "max_cost_usd": 0.0,
        },
        locked_split_hash=locked_split_hash,
        eval_script_hash=eval_script_hash,
        allowed_licenses=["MIT", "Apache-2.0"],
        created_at="2026-07-03T00:00:00Z",
    )


def _make_strategy() -> StrategyState:
    return StrategyState(
        meta_iteration=0,
        selection_policy="ucb1",
        ucb1_c=1.41,
        beam_width=None,
        wildness=0.5,
        family_mix={
            "arch": 0.2,
            "training": 0.2,
            "data-curation": 0.15,
            "data-augmentation": 0.15,
            "data-acquisition": 0.10,
            "algo": 0.15,
            "other": 0.05,
        },
        winning_families=[],
        wins_by_family={},
        meta_loop_interval=5,
        post_upgrade_exploration_boost=None,
        post_upgrade_exploration_ticks=0,
        rescore_mode="sync",
        updated_at="2026-07-03T00:00:00Z",
    )


def _make_genome(backbone: str = "resnet9") -> GenomeConfig:
    return GenomeConfig(
        genome_version="1.0.0",
        backbone=backbone,
        head="linear",
        neck=None,
        optimizer="adamw",
        lr=0.001,
        lr_schedule="cosine",
        batch_size=64,
        epochs=10,
        loss="cross_entropy",
        aug_set=["random_crop", "random_flip"],
        acquired_datasets=[],
        regularization={"weight_decay": 0.01},
        schema_extensions=[],
        extra={},
    )


def _make_node(
    node_id: str,
    parent_ids: list[str],
    genome_ref: str,
    depth: int,
    approach_family: str = "arch",
    status: str = "pending",
    eval_version: str = "v1",
) -> TreeNode:
    return TreeNode(
        id=node_id,
        parent_ids=parent_ids,
        approach_family=approach_family,
        hypothesis_id=f"hyp-{node_id[:8]}",
        code_ref=f"nodes/{node_id}/code/",
        genome_ref=genome_ref,
        data_version_ref="data-v1-fake",
        config={},
        metrics={},
        eval_version=eval_version,
        lesson_ids=[],
        citations=[],
        integrity_status="pending",
        status=status,
        is_crossover=False,
        visit_count=0,
        depth=depth,
        created_at="2026-07-03T00:00:00Z",
    )


def _make_eval_result(
    node_id: str,
    accuracy: float = 0.80,
    eval_version: str = "v1",
) -> EvaluationResult:
    return EvaluationResult(
        node_id=node_id,
        run_id="run-001",
        eval_version=eval_version,
        metrics={"accuracy": accuracy},
        per_domain={"default": {"accuracy": accuracy}},
        fitness_value=accuracy,
        telemetry_summary=TelemetrySummary(total_steps=10),
        status="success",
        benchmark_raw="",
        timestamp="2026-07-03T02:00:00Z",
    )


def _write_telemetry(path: Path, node_id: str, run_id: str) -> None:
    """Write a minimal valid telemetry.jsonl (loss decreasing, grad_norm positive)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [
        json.dumps({
            "step": step,
            "train_loss": round(1.0 - step * 0.12, 4),   # decreasing: 1.0 → 0.52
            "lr": 0.001,
            "grad_norm": round(2.0 + step * 0.1, 3),      # positive throughout
            "node_id": node_id,
            "run_id": run_id,
            "timestamp": f"2026-07-03T01:0{step}:00Z",
        })
        for step in range(5)
    ]
    path.write_text("\n".join(records) + "\n")


def _approved_critic_review() -> CriticReview:
    return CriticReview(
        h001_one_hypothesis="pass",
        h002_family_streak="pass",
        h003_intra_tick_diversity="pass",
        integrity_risk="pass",
        instrumentation_check="pass",
        schema_valid="pass",
        verdict="approved",
    )


# ─────────────────────────────────────────────────────────────────────────────
# Main tick-loop test
# ─────────────────────────────────────────────────────────────────────────────


class TestTickLoopDryRun:
    """End-to-end object-level tick dry-run: full pipeline without GPU or torch."""

    def test_tick_loop(self, tmp_path: Path) -> None:  # noqa: PLR0915
        # ── 1. Run directory ───────────────────────────────────────────────────
        run_dir = tmp_path / "runs" / "tick-loop-mission" / "run-001"
        (run_dir / "nodes").mkdir(parents=True)
        (run_dir / "evaluations").mkdir()
        (run_dir / "frozen-splits").mkdir()

        # ── 2. ContentAddressedStore (artifact blob store) ─────────────────────
        store = ContentAddressedStore(tmp_path / "artifacts")

        # Store two genome YAML blobs (one per root lineage).
        import yaml  # pyyaml; listed in harness/pyproject.toml deps

        genome_a = _make_genome(backbone="resnet9")
        genome_b = _make_genome(backbone="vit-small")

        genome_a_file = tmp_path / "genome_a.yaml"
        genome_b_file = tmp_path / "genome_b.yaml"
        genome_a_file.write_text(yaml.dump(genome_a.model_dump()))
        genome_b_file.write_text(yaml.dump(genome_b.model_dump()))
        genome_ref_a = store.put(genome_a_file)
        genome_ref_b = store.put(genome_b_file)
        assert genome_ref_a != genome_ref_b, "distinct genomes must have distinct hashes"

        # ── 3. Freeze a tiny test/val split ───────────────────────────────────
        fsm = FrozenSplitManager()
        test_split, _val_split = fsm.freeze_splits(
            dataset_path=tmp_path / "data",  # unused by freeze_splits internals
            split_config={
                "mission_id": "tick-loop-mission",
                "test": {
                    "0": b"sample_zero",
                    "1": b"sample_one",
                    "2": b"sample_two",
                },
                "val": {"3": b"sample_val_a"},
            },
            eval_version="v1",
            run_dir=run_dir,
        )
        locked_split_hash = test_split.split_hash

        # ── 4. Fake evaluator script (no GPU, no torch) ────────────────────────
        fake_eval_script = tmp_path / "evaluate.py"
        fake_eval_script.write_text(textwrap.dedent("""\
            import json
            print(json.dumps({
                "metrics": {"accuracy": 0.80},
                "per_domain": {"default": {"accuracy": 0.80}},
                "telemetry_summary": {"total_steps": 10},
                "status": "success",
                "benchmark_raw": "",
            }))
        """))
        eval_script_hash = _sha256(fake_eval_script.read_bytes())

        # ── 5. GoalContract + StrategyState ───────────────────────────────────
        goal = _make_goal(
            locked_split_hash=locked_split_hash,
            eval_script_hash=eval_script_hash,
        )
        strategy = _make_strategy()

        # ── 6. Seed root TreeNode ─────────────────────────────────────────────
        ROOT_ID = "root-node-tick-001"
        root_node = _make_node(ROOT_ID, [], genome_ref_a, depth=0, approach_family="arch")

        # ── 7. TreeEngine.select() ─────────────────────────────────────────────
        engine = TreeEngine([root_node], goal, strategy, run_dir=run_dir, store=store)
        selected = engine.select(count=1)

        assert len(selected) == 1, "select() should return exactly 1 node"
        assert selected[0].id == ROOT_ID, (
            "unvisited root has UCB1 score=inf and must always be selected first"
        )

        # ── 8a. Propose a mutation (manual MutationProposal, 1 parent) ─────────
        mutation_proposal = MutationProposal(
            proposal_id="prop-mutation-001",
            parent_node_ids=[ROOT_ID],
            approach_family="training",
            idea="Lower learning rate from 1e-3 to 3e-4 for smoother convergence",
            hypothesis=Hypothesis(
                id="hyp-mutation-001",
                statement="Reducing LR will lower oscillation and improve final val accuracy",
                prediction="val_acc +2-3% over 10 epochs",
            ),
            citations=[],
            wildness=0.5,
            critic_approved=True,
            critic_review=_approved_critic_review(),
        )
        assert mutation_proposal.critic_approved
        assert len(mutation_proposal.parent_node_ids) == 1, "mutation has exactly 1 parent"

        # ── 8b. Second node (distinct lineage, depth=0) for crossover ──────────
        BRANCH_ID = "branch-node-tick-002"
        branch_node = _make_node(
            BRANCH_ID,
            [],               # empty parent_ids → distinct lineage from root
            genome_ref_b,
            depth=0,
            approach_family="training",
        )

        engine_two = TreeEngine(
            [root_node, branch_node], goal, strategy, run_dir=run_dir, store=store
        )

        # ── 8c. TreeEngine.propose_crossover() ────────────────────────────────
        crossover_proposal = engine_two.propose_crossover(
            root_node,
            branch_node,
            genome_a=genome_a,   # pass GenomeConfig directly to avoid store lookup
            genome_b=genome_b,
        )
        assert len(crossover_proposal.parent_node_ids) == 2, (
            "crossover proposal must carry exactly 2 parent IDs"
        )
        assert set(crossover_proposal.parent_node_ids) == {ROOT_ID, BRANCH_ID}
        assert crossover_proposal.critic_approved

        # ── 9. Write shared telemetry for integrity checks ─────────────────────
        # Both clean and cheat nodes reuse the same telemetry content; the
        # telemetry_sane check only inspects train_loss and grad_norm values.
        CLEAN_ID = "clean-node-tick-003"
        shared_telemetry = run_dir / "nodes" / CLEAN_ID / "telemetry.jsonl"
        _write_telemetry(shared_telemetry, node_id=CLEAN_ID, run_id="run-001")

        gate = IntegrityGate()

        # ── 10. IntegrityGate: CHEAT node → REJECTED (test-leakage) ───────────
        #
        # Craft a FrozenSplit where two distinct indices share the same hash.
        # IntegrityGate._check_no_test_leakage() returns:
        #   len(values) == len(set(values))   →  len([dup,dup]) != len({dup})  → False
        #
        # The GoalContract.locked_split_hash is set to match this cheat split so
        # that split_hash_match=True; the ONLY failure is no_test_leakage=False.
        dup_hash = _sha256(b"same_sample_in_train_and_test")
        cheat_per_sample_hashes = {
            "0": dup_hash,
            "1": dup_hash,  # duplicate value → internal split contamination
        }
        cheat_split_hash = _compute_split_hash(cheat_per_sample_hashes)
        cheat_frozen_split = FrozenSplit(
            split_id="tick-loop-mission-v1-test-cheat",
            mission_id="tick-loop-mission",
            split_type="test",
            split_hash=cheat_split_hash,
            per_sample_hashes=cheat_per_sample_hashes,
            item_count=2,
            frozen_at="2026-07-03T00:00:00Z",
            storage_path=str(run_dir / "frozen-splits" / "v1-cheat-test.json"),
            eval_version="v1",
        )
        goal_cheat = goal.model_copy(update={"locked_split_hash": cheat_split_hash})

        CHEAT_ID = "cheat-node-tick-cheat"
        cheat_node = _make_node(
            CHEAT_ID, [ROOT_ID], genome_ref_a, depth=1, approach_family="arch"
        )
        cheat_result = _make_eval_result(CHEAT_ID, accuracy=0.78)

        cheat_report = gate.check(
            node=cheat_node,
            result=cheat_result,
            goal=goal_cheat,            # locked_split_hash matches cheat split
            telemetry_path=shared_telemetry,
            eval_script_path=fake_eval_script,
            frozen_test=cheat_frozen_split,
            provenance_path=None,
            run_dir=None,              # skip frozen_split_read_only (no on-disk cheat files)
        )

        assert cheat_report.checks.split_hash_match is True, (
            "split_hash must match (cheat split was crafted to match)"
        )
        assert cheat_report.checks.no_test_leakage is False, (
            "duplicate per_sample_hashes must trigger test-leakage detection"
        )
        assert cheat_report.verdict == "failed", (
            "IntegrityGate MUST reject the cheat node"
        )

        # ── 11. IntegrityGate: CLEAN node → PASSES ────────────────────────────
        clean_node = _make_node(
            CLEAN_ID, [ROOT_ID], genome_ref_a, depth=1, approach_family="training"
        )
        clean_result = _make_eval_result(CLEAN_ID, accuracy=0.80)

        clean_report = gate.check(
            node=clean_node,
            result=clean_result,
            goal=goal,                  # proper locked_split_hash
            telemetry_path=shared_telemetry,
            eval_script_path=fake_eval_script,
            frozen_test=test_split,
            provenance_path=None,
            run_dir=run_dir,            # enables frozen_split_read_only check (chmod 444 by fsm)
        )

        assert clean_report.verdict == "passed", (
            f"clean node must PASS; failures: {clean_report.failure_reason}"
        )
        assert clean_report.checks.split_hash_match is True
        assert clean_report.checks.no_test_leakage is True
        assert clean_report.checks.no_eval_shift is True
        assert clean_report.checks.telemetry_sane is True
        assert clean_report.checks.frozen_split_read_only is True, (
            "FrozenSplitManager.freeze_splits() must have chmod-444'd the split files"
        )

        # ── 12. EvaluatorAdapter.run(fake_evaluator) ──────────────────────────
        adapter = EvaluatorAdapter(run_dir=None)
        eval_result = adapter.run(
            eval_script=fake_eval_script,
            worktree=tmp_path,
            goal=goal,
            node=clean_node,
            env={"EVOR_RUN_ID": "run-001"},
        )

        assert eval_result.status == "success", (
            f"fake evaluator must exit successfully; got status={eval_result.status!r}"
        )
        assert eval_result.metrics.get("accuracy") == pytest.approx(0.80), (
            "fake evaluator accuracy must be 0.80 as emitted"
        )
        assert "default" in eval_result.per_domain, "per_domain must include 'default' domain"
        assert eval_result.fitness_value > 0.0, "fitness_value must be positive after evaluation"

        # ── 13. Record node into tree-store (write results.json) ───────────────
        results_path = run_dir / "nodes" / CLEAN_ID / "results.json"
        results_path.parent.mkdir(parents=True, exist_ok=True)
        results_path.write_text(eval_result.model_dump_json(indent=2))

        assert results_path.exists(), (
            "results.json must be written to nodes/<node_id>/results.json"
        )
        written = json.loads(results_path.read_text())
        assert written["node_id"] == CLEAN_ID
        assert written["status"] == "success"
        assert written["eval_version"] == "v1"

        # ── 14. Build final tree: root(done) + clean(done) + cheat(done,failed) + branch ──
        root_done = root_node.model_copy(update={
            "status": "done",
            "integrity_status": "passed",
            "metrics": {"accuracy": 0.75},
            "fitness_value": 0.75,
            "visit_count": 1,
        })
        clean_done = clean_node.model_copy(update={
            "status": "done",
            "integrity_status": "passed",
            "metrics": eval_result.metrics,
            "fitness_value": eval_result.fitness_value,
            "visit_count": 1,
        })
        cheat_done = cheat_node.model_copy(update={
            "status": "done",
            "integrity_status": "failed",
            "metrics": cheat_result.metrics,
            "fitness_value": cheat_result.fitness_value,
            "visit_count": 1,
        })

        all_nodes = [root_done, clean_done, cheat_done, branch_node]
        engine_final = TreeEngine(
            all_nodes, goal, strategy, run_dir=run_dir, store=store
        )

        assert len(engine_final._nodes) == 4, (
            "tree must have grown from 1 (root) to 4 nodes: "
            "root + clean-child + cheat-child + branch (crossover candidate)"
        )

        # ── 15. prune() + gc() ─────────────────────────────────────────────────
        # Prune the cheat node (integrity_failed) and the branch node (unused).
        # Clean node and root survive as non-pruned.
        engine_final.prune(
            winner_id=clean_done.id,
            losers=[cheat_done.id, branch_node.id],
            store=store,
        )

        assert engine_final._node_map[cheat_done.id].status == "pruned"
        assert engine_final._node_map[branch_node.id].status == "pruned"
        assert engine_final._node_map[ROOT_ID].status != "pruned"
        assert engine_final._node_map[CLEAN_ID].status != "pruned"

        # genome_ref_b was referenced only by branch_node (now pruned); gc() removes it.
        with pytest.raises((FileNotFoundError, KeyError)):
            store.get(genome_ref_b)

        # genome_ref_a still referenced by root_done and clean_done → survives.
        assert store.get(genome_ref_a).exists()

        # ── 16. best_frontier() ───────────────────────────────────────────────
        frontier = engine_final.best_frontier()

        assert len(frontier) >= 1, "at least one node must be on the frontier"
        frontier_ids = {n.id for n in frontier}
        assert CLEAN_ID in frontier_ids, (
            "clean node (highest fitness=0.80, integrity=passed) must be on frontier"
        )
        # Cheat node is pruned, so it can't appear on the frontier.
        assert CHEAT_ID not in frontier_ids, (
            "cheat node (pruned after integrity failure) must not appear on frontier"
        )

        # ── 17. meta_evolve() — one tick ──────────────────────────────────────
        new_strategy = engine_final.meta_evolve(decision_log=[])

        assert new_strategy.meta_iteration == strategy.meta_iteration + 1, (
            "meta_iteration must increment by 1 after meta_evolve()"
        )
        assert new_strategy.selection_policy == "ucb1"
        assert isinstance(new_strategy.ucb1_c, float)
        # Loop closes: a valid StrategyState is returned, proving the tick completed.
        assert new_strategy.updated_at >= "2026-07-03", (
            "updated_at timestamp must be set by meta_evolve()"
        )
