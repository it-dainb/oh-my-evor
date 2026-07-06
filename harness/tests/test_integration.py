"""
harness/tests/test_integration.py — cross-module GPU-free integration tests.

Each test exercises a real interaction between two or more harness modules.
GPU-gated paths (EvaluatorAdapter.run, preflight, _eval_seed_model,
verification_rerun) are excluded — those are listed in KNOWN_GAPS.md.

Modules spanned per test:
  store + gc                         — blob put/get/gc lifecycle
  store + tree                       — prune marks losers; gc removes orphaned blobs
  freeze + integrity + contracts     — FrozenSplit hash wired into GoalContract check
  benchmark + contracts              — EvalSuite upgrade superset + load round-trip
  wiki + contracts                   — LessonEntry add + query + load_context
  angle_registry + contracts         — add_angle + score_angles coverage
  evaluator + angle_registry         — _apply_angle_scoring with real registry file
"""

from __future__ import annotations

import hashlib
import json
import stat
from pathlib import Path

import pytest

from evor.contracts import (
    AngleEntry,
    AngleRegistry,
    BenchmarkUpgrade,
    Budget,
    Domain,
    EvalSuite,
    EvaluationResult,
    GoalContract,
    LessonEntry,
    MetricSpec,
    MutationLocusArch,
    SotaSource,
    StopCondition,
    StrategyState,
    TelemetrySummary,
    TreeNode,
)
from evor.store import ContentAddressedStore
from evor.tree import TreeEngine
from evor.freeze import FrozenSplitManager, _compute_split_hash
from evor.integrity import IntegrityGate
from evor.benchmark import BenchmarkManager
from evor.wiki import CompoundingWiki
from evor.angle_registry import AngleRegistryManager, _load_registry, _save_registry, _effective_bar
from evor.evaluator import EvaluatorAdapter


# ─── Shared helpers ───────────────────────────────────────────────────────────

_ISO = "2026-07-03T00:00:00Z"
_MISSION = "integ-mission"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _make_goal(
    locked_split_hash: str = "a" * 64,
    mission_type: str = "fixed",
    fitness_mode: str = "aggregate",
    eval_script_hash: str = "e" * 64,
) -> GoalContract:
    return GoalContract(
        mission_id=_MISSION,
        mode="from-scratch",
        mission_type=mission_type,  # type: ignore[arg-type]
        task_description="Integration test task",
        dataset_ref="/data/integ",
        metric_specs=[
            MetricSpec(
                metric_name="accuracy",
                direction="higher",
                domain_applicability="all",
                aggregation_rule="macro_avg",
                role="primary_fitness",
                sota_bar=None,
            )
        ],
        fitness_mode=fitness_mode,  # type: ignore[arg-type]
        eval_version="v1",
        baseline_value=0.72,
        target_value=0.90,
        coverage_target=0.8 if mission_type == "open_ended" else None,
        stop_condition=StopCondition(type="target"),
        wildness=0.5,
        budget=Budget(
            max_iterations=50,
            plateau_window=8,
            circuit_breaker=5,
            max_cost_usd=0.0,
        ),
        locked_split_hash=locked_split_hash,
        eval_script_hash=eval_script_hash,
        allowed_licenses=["MIT", "Apache-2.0"],
        created_at=_ISO,
    )


def _make_strategy() -> StrategyState:
    return StrategyState(
        meta_iteration=0,
        selection_policy="ucb1",
        ucb1_c=1.41,
        wildness=0.5,
        family_mix={"arch": 1.0},
        winning_families=[],
        wins_by_family={},
        meta_loop_interval=5,
        rescore_mode="async",
        post_upgrade_exploration_ticks=0,
        updated_at=_ISO,
    )


def _make_tree_node(
    node_id: str,
    genome_ref: str = "",
    fitness_value: float = 0.80,
    visit_count: int = 1,
    eval_version: str = "v1",
) -> TreeNode:
    return TreeNode(
        id=node_id,
        parent_ids=[],
        approach_family="arch",
        hypothesis_id="hyp-001",
        code_ref=f"nodes/{node_id}/code/",
        genome_ref=genome_ref,
        data_version_ref="",
        config={},
        metrics={"accuracy": fitness_value},
        eval_version=eval_version,
        lesson_ids=[],
        citations=[],
        integrity_status="pending",
        status="done",
        is_crossover=False,
        visit_count=visit_count,
        depth=0,
        created_at=_ISO,
        mutation_locus=MutationLocusArch(family="arch", path="model/"),
    )


def _make_eval_result(
    node_id: str = "node-001",
    score: float = 0.85,
    eval_version: str = "v1",
    per_domain: dict | None = None,
) -> EvaluationResult:
    domain_scores = per_domain or {"default": {"accuracy": score}}
    return EvaluationResult(
        node_id=node_id,
        run_id="run-001",
        eval_version=eval_version,
        metrics={"accuracy": score},
        per_domain=domain_scores,
        fitness_value=score,
        telemetry_summary=TelemetrySummary(total_steps=10),
        status="success",
        benchmark_raw="",
        timestamp=_ISO,
    )


def _frozen_split_from_fsm(tmp_path: Path) -> tuple:
    """Real FrozenSplitManager.freeze_splits call; returns (test_split, split_hash)."""
    fsm = FrozenSplitManager()
    split_config = {
        "mission_id": _MISSION,
        "test": {"0": b"sample zero bytes", "1": b"sample one bytes"},
        "val": {"2": b"sample two bytes"},
    }
    test_split, _val = fsm.freeze_splits(
        dataset_path=tmp_path,
        split_config=split_config,
        eval_version="v1",
        run_dir=tmp_path,
    )
    return test_split, test_split.split_hash


# ─────────────────────────────────────────────────────────────────────────────
# store — blob lifecycle
# ─────────────────────────────────────────────────────────────────────────────


class TestStoreBlobLifecycle:
    """ContentAddressedStore: put, get, gc — no other modules."""

    def test_put_get_roundtrip(self, tmp_path: Path) -> None:
        store = ContentAddressedStore(tmp_path / "store")
        src = tmp_path / "genome.bin"
        src.write_bytes(b"genome payload for integration test")

        h = store.put(src)
        blob = store.get(h)

        assert len(h) == 64
        assert blob.read_bytes() == b"genome payload for integration test"

    def test_gc_removes_unreferenced_blob(self, tmp_path: Path) -> None:
        store = ContentAddressedStore(tmp_path / "store")
        f_a = tmp_path / "a.bin"
        f_b = tmp_path / "b.bin"
        f_a.write_bytes(b"blob-alpha")
        f_b.write_bytes(b"blob-beta")

        h_a = store.put(f_a)
        h_b = store.put(f_b)

        deleted = store.gc({h_a})  # only h_a referenced
        assert deleted == 1
        assert store.get(h_a).read_bytes() == b"blob-alpha"
        with pytest.raises(FileNotFoundError):
            store.get(h_b)

    def test_duplicate_content_deduped(self, tmp_path: Path) -> None:
        """Two files with identical bytes share one blob; gc keeps it."""
        store = ContentAddressedStore(tmp_path / "store")
        f1 = tmp_path / "copy1.bin"
        f2 = tmp_path / "copy2.bin"
        f1.write_bytes(b"shared genome bytes")
        f2.write_bytes(b"shared genome bytes")

        h1 = store.put(f1)
        h2 = store.put(f2)

        assert h1 == h2
        # With h1 referenced, gc deletes nothing (same blob)
        deleted = store.gc({h1})
        assert deleted == 0


# ─────────────────────────────────────────────────────────────────────────────
# store + tree — prune marks losers; gc removes orphaned genome blobs
# ─────────────────────────────────────────────────────────────────────────────


class TestTreePruneStoreGcIntegration:
    """TreeEngine.prune() wires into ContentAddressedStore.gc().

    After prune, winner's blob must survive; loser's blob is gc'd.
    """

    def test_prune_gc_removes_loser_genome(self, tmp_path: Path) -> None:
        store = ContentAddressedStore(tmp_path / "store")

        # Put distinct genome blobs
        fa = tmp_path / "gen_a.bin"; fa.write_bytes(b"genome-winner")
        fb = tmp_path / "gen_b.bin"; fb.write_bytes(b"genome-loser")
        h_winner = store.put(fa)
        h_loser = store.put(fb)

        goal = _make_goal()
        node_w = _make_tree_node("node-winner", genome_ref=h_winner, fitness_value=0.92)
        node_l = _make_tree_node("node-loser", genome_ref=h_loser, fitness_value=0.70)

        engine = TreeEngine(nodes=[node_w, node_l], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
        engine.prune(winner_id="node-winner", losers=["node-loser"], store=store)

        # Winner's blob survives
        assert store.get(h_winner).read_bytes() == b"genome-winner"
        # Loser's blob is gc'd
        with pytest.raises(FileNotFoundError):
            store.get(h_loser)

    def test_prune_skip_hashes_protects_blob(self, tmp_path: Path) -> None:
        """skip_hashes prevents gc even when node is pruned."""
        store = ContentAddressedStore(tmp_path / "store")
        fa = tmp_path / "gen_a.bin"; fa.write_bytes(b"genome-A")
        fb = tmp_path / "gen_b.bin"; fb.write_bytes(b"genome-B")
        h_a = store.put(fa)
        h_b = store.put(fb)

        goal = _make_goal()
        node_a = _make_tree_node("node-A", genome_ref=h_a, fitness_value=0.85)
        node_b = _make_tree_node("node-B", genome_ref=h_b, fitness_value=0.70)

        engine = TreeEngine(nodes=[node_a, node_b], goal=goal, strategy=_make_strategy(), run_dir=tmp_path)
        # Protect h_b even though node-B is a loser
        engine.prune("node-A", ["node-B"], store, skip_hashes={h_b})

        assert store.get(h_a).read_bytes() == b"genome-A"
        assert store.get(h_b).read_bytes() == b"genome-B"  # protected


# ─────────────────────────────────────────────────────────────────────────────
# freeze + integrity + contracts — split hash wired into GoalContract
# ─────────────────────────────────────────────────────────────────────────────


class TestFreezeIntegrityIntegration:
    """FrozenSplitManager produces a FrozenSplit whose split_hash must match
    GoalContract.locked_split_hash for IntegrityGate.check() to pass."""

    def test_freeze_splits_produces_readonly_files(self, tmp_path: Path) -> None:
        test_split, _ = _frozen_split_from_fsm(tmp_path)

        assert test_split.split_type == "test"
        assert len(test_split.split_hash) == 64
        assert test_split.item_count == 2

        # All materialised sample files must be read-only
        split_dir = tmp_path / "frozen-splits" / "v1-test"
        files = list(split_dir.iterdir())
        assert len(files) >= 1
        for f in files:
            assert not (f.stat().st_mode & stat.S_IWUSR), f"{f} is writable"

    def test_integrity_check_passes_with_real_frozen_split(self, tmp_path: Path) -> None:
        """Full IntegrityGate.check() spanning freeze + integrity + contracts."""
        # Build a real FrozenSplit via FrozenSplitManager
        test_split, split_hash = _frozen_split_from_fsm(tmp_path)

        # Eval script with known sha256
        eval_script = tmp_path / "evaluate.py"
        eval_script.write_text("# eval script")
        script_hash = _sha256(b"# eval script")

        # Decreasing-loss telemetry (avoids telemetry_sane=False)
        tel_path = tmp_path / "nodes" / "node-001" / "telemetry.jsonl"
        tel_path.parent.mkdir(parents=True, exist_ok=True)
        with open(tel_path, "w") as fh:
            for step, loss in enumerate([1.0, 0.8, 0.6]):
                fh.write(json.dumps({
                    "step": step, "train_loss": loss, "grad_norm": 1.0,
                    "node_id": "node-001", "run_id": "run-001", "timestamp": _ISO,
                }) + "\n")

        goal = _make_goal(locked_split_hash=split_hash, eval_script_hash=script_hash)
        node = _make_tree_node("node-001")
        result = _make_eval_result("node-001")

        gate = IntegrityGate()
        report = gate.check(
            node=node,
            result=result,
            goal=goal,
            telemetry_path=tel_path,
            eval_script_path=eval_script,
            frozen_test=test_split,
            provenance_path=None,
            run_dir=tmp_path,
        )

        assert report.checks.split_hash_match is True
        assert report.verdict == "passed"

    def test_integrity_check_fails_on_hash_mismatch(self, tmp_path: Path) -> None:
        """Wrong locked_split_hash → split_hash_match=False, verdict=failed."""
        test_split, _correct_hash = _frozen_split_from_fsm(tmp_path)

        eval_script = tmp_path / "evaluate.py"
        eval_script.write_text("# eval")
        tel_path = tmp_path / "nodes" / "node-001" / "telemetry.jsonl"
        tel_path.parent.mkdir(parents=True, exist_ok=True)
        tel_path.write_text(json.dumps({
            "step": 0, "train_loss": 0.5, "grad_norm": 1.0,
            "node_id": "node-001", "run_id": "run-001", "timestamp": _ISO,
        }) + "\n")

        # Intentionally wrong locked_split_hash
        goal = _make_goal(locked_split_hash="b" * 64)
        gate = IntegrityGate()
        report = gate.check(
            node=_make_tree_node("node-001"),
            result=_make_eval_result("node-001"),
            goal=goal,
            telemetry_path=tel_path,
            eval_script_path=eval_script,
            frozen_test=test_split,
            provenance_path=None,
            run_dir=tmp_path,
        )

        assert report.checks.split_hash_match is False
        assert report.verdict == "failed"

    def test_lock_splits_is_deterministic(self) -> None:
        """IntegrityGate.lock_splits() produces the same hash for the same index set."""
        gate = IntegrityGate()
        cfg = {"train": [0, 1, 2], "val": [3, 4], "test": [5, 6, 7]}
        assert gate.lock_splits(cfg) == gate.lock_splits(cfg)


# ─────────────────────────────────────────────────────────────────────────────
# benchmark + contracts — EvalSuite upgrade superset + load round-trip
# ─────────────────────────────────────────────────────────────────────────────


class TestBenchmarkUpgradeIntegration:
    """BenchmarkManager.apply_upgrade creates a strict superset EvalSuite;
    get_eval_suite round-trips it from disk."""

    def _seed_v1(self, tmp_path: Path) -> None:
        v1 = EvalSuite(
            eval_version="v1",
            mission_id=_MISSION,
            parent_eval_version=None,
            domains=[
                Domain(
                    domain_id="math",
                    description="Math reasoning",
                    metric_specs=[],
                    added_at_eval_version="v1",
                )
            ],
            split_hashes={},
            created_at=_ISO,
            created_by="user",
            consent_log_ref="log-v1",
        )
        suites_dir = tmp_path / "eval-suites"
        suites_dir.mkdir(parents=True, exist_ok=True)
        (suites_dir / "v1.json").write_text(v1.model_dump_json(indent=2))

    def _upgrade(self) -> BenchmarkUpgrade:
        return BenchmarkUpgrade(
            upgrade_id="upg-001",
            mission_id=_MISSION,
            from_eval_version="v1",
            to_eval_version="v2",
            proposed_by="user",
            proposal_citations=["paper-xyz"],
            consent_granted=True,
            consent_at=_ISO,
            new_domains_added=["code"],
            domains_removed=[],
            rescore_status="pending",
            rescore_deadline_ticks=5,
            decision_log_ref="log-v2",
            created_at=_ISO,
        )

    def _strategy(self) -> StrategyState:
        return _make_strategy()

    def test_apply_upgrade_produces_superset(self, tmp_path: Path) -> None:
        self._seed_v1(tmp_path)
        mgr = BenchmarkManager(run_dir=tmp_path)
        v2 = mgr.apply_upgrade(
            self._upgrade(), tmp_path,
            seed_checkpoint_hash=None,
            strategy_state=self._strategy(),
        )

        assert v2.eval_version == "v2"
        domain_ids = {d.domain_id for d in v2.domains}
        assert "math" in domain_ids
        assert "code" in domain_ids
        assert len(v2.domains) == 2

    def test_apply_upgrade_round_trips_to_disk(self, tmp_path: Path) -> None:
        self._seed_v1(tmp_path)
        mgr = BenchmarkManager(run_dir=tmp_path)
        mgr.apply_upgrade(
            self._upgrade(), tmp_path,
            seed_checkpoint_hash=None,
            strategy_state=self._strategy(),
        )

        loaded = mgr.get_eval_suite("v2", tmp_path)
        assert loaded.eval_version == "v2"
        assert {d.domain_id for d in loaded.domains} == {"math", "code"}
        assert loaded.parent_eval_version == "v1"

    def test_upgrade_with_domains_removed_raises(self, tmp_path: Path) -> None:
        """domains_removed non-empty → IntegrityError (additive-only invariant)."""
        from evor.benchmark import IntegrityError

        self._seed_v1(tmp_path)
        bad_upgrade = BenchmarkUpgrade(
            upgrade_id="upg-bad",
            mission_id=_MISSION,
            from_eval_version="v1",
            to_eval_version="v2",
            proposed_by="user",
            proposal_citations=[],
            consent_granted=True,
            new_domains_added=[],
            domains_removed=["math"],       # MUST raise
            rescore_status="pending",
            rescore_deadline_ticks=5,
            decision_log_ref="log-bad",
            created_at=_ISO,
        )
        mgr = BenchmarkManager(run_dir=tmp_path)
        with pytest.raises(IntegrityError, match="domains_removed"):
            mgr.apply_upgrade(
                bad_upgrade, tmp_path,
                seed_checkpoint_hash=None,
                strategy_state=self._strategy(),
            )

    def test_list_versions_after_upgrade(self, tmp_path: Path) -> None:
        self._seed_v1(tmp_path)
        mgr = BenchmarkManager(run_dir=tmp_path)
        mgr.apply_upgrade(
            self._upgrade(), tmp_path,
            seed_checkpoint_hash=None,
            strategy_state=self._strategy(),
        )
        versions = mgr.list_versions(tmp_path)
        assert "v1" in versions
        assert "v2" in versions


# ─────────────────────────────────────────────────────────────────────────────
# wiki + contracts — LessonEntry add + query + load_context
# ─────────────────────────────────────────────────────────────────────────────


class TestWikiIntegration:
    """CompoundingWiki.add() wires a LessonEntry into the cross-run index;
    query() and load_context() retrieve it."""

    def _lesson(self, lesson_id: str = "les-001", tags: list[str] | None = None) -> LessonEntry:
        return LessonEntry(
            lesson_id=lesson_id,
            node_id="node-001",
            run_id="run-001",
            mission_id=_MISSION,
            approach_family="arch",
            hypothesis_verdict="confirmed",
            observation="Dropout 0.3 reduces overfitting on small datasets.",
            actionable_lesson="Use dropout=0.3 in classifier head for <10k samples.",
            citations=["arxiv:2001.00001"],
            tags=tags or ["dropout", "regularization"],
            created_at=_ISO,
        )

    def test_add_then_query_returns_lesson(self, tmp_path: Path) -> None:
        wiki = CompoundingWiki(tmp_path)
        run_dir = tmp_path / "runs" / "run-001"
        run_dir.mkdir(parents=True)

        lid = wiki.add(self._lesson(), run_dir)
        assert lid == "les-001"

        results = wiki.query("dropout regularization")
        assert len(results) >= 1
        ids = [r.lesson_id for r in results]
        assert "les-001" in ids

    def test_query_family_filter(self, tmp_path: Path) -> None:
        wiki = CompoundingWiki(tmp_path)
        run_dir = tmp_path / "runs" / "run-001"
        run_dir.mkdir(parents=True)

        wiki.add(self._lesson("les-arch", tags=["arch"]), run_dir)

        results_arch = wiki.query("arch", family="arch")
        results_other = wiki.query("arch", family="training")
        assert any(r.lesson_id == "les-arch" for r in results_arch)
        assert all(r.lesson_id != "les-arch" for r in results_other)

    def test_load_context_returns_recent_lessons(self, tmp_path: Path) -> None:
        wiki = CompoundingWiki(tmp_path)
        run_dir = tmp_path / "runs" / "run-001"
        run_dir.mkdir(parents=True)

        for i in range(3):
            wiki.add(self._lesson(f"les-{i:03d}", tags=[f"tag{i}"]), run_dir)

        ctx = wiki.load_context(_MISSION, limit=2)
        assert len(ctx) <= 2

    def test_confirmed_only_filter(self, tmp_path: Path) -> None:
        wiki = CompoundingWiki(tmp_path)
        run_dir = tmp_path / "runs" / "run-001"
        run_dir.mkdir(parents=True)
        wiki.add(self._lesson(), run_dir)  # hypothesis_verdict="confirmed"

        confirmed = wiki.query("dropout", confirmed_only=True)
        assert any(r.lesson_id == "les-001" for r in confirmed)


# ─────────────────────────────────────────────────────────────────────────────
# angle_registry + contracts — add_angle + score_angles coverage
# ─────────────────────────────────────────────────────────────────────────────


class TestAngleRegistryIntegration:
    """AngleRegistryManager.add_angle() writes to disk; score_angles() reads
    the registry and computes per-angle coverage."""

    def _src(self, sid: str) -> SotaSource:
        return SotaSource(
            source_id=sid,
            name=f"Source {sid}",
            retrieval_method="human_provided",
            trust_level="authoritative",
            citation=f"Paper {sid}",
            retrieved_at=_ISO,
        )

    def test_add_angle_then_score_above_sota(self, tmp_path: Path) -> None:
        mgr = AngleRegistryManager(mission_id=_MISSION)
        mgr.add_angle(
            angle_id="math-gsm8k",
            sota_bar=0.75,
            sota_sources=[self._src("src-a"), self._src("src-b")],
            baseline_score=0.60,
            run_dir=tmp_path,
        )

        registry = _load_registry(tmp_path)
        result = _make_eval_result(
            per_domain={"math-gsm8k": {"accuracy": 0.85}},
        )
        per_angle, coverage = mgr.score_angles(result, registry, "v1")

        assert "math-gsm8k" in per_angle
        assert per_angle["math-gsm8k"].above_sota is True  # 0.85 >= max(0.75, 0.60)
        assert coverage == pytest.approx(1.0)

    def test_add_angle_below_sota_coverage_zero(self, tmp_path: Path) -> None:
        mgr = AngleRegistryManager(mission_id=_MISSION)
        mgr.add_angle(
            angle_id="code-bench",
            sota_bar=0.90,
            sota_sources=[self._src("s1"), self._src("s2")],
            baseline_score=None,
            run_dir=tmp_path,
        )

        registry = _load_registry(tmp_path)
        result = _make_eval_result(
            per_domain={"code-bench": {"accuracy": 0.70}},  # below SOTA bar
        )
        per_angle, coverage = mgr.score_angles(result, registry, "v1")

        assert per_angle["code-bench"].above_sota is False
        assert coverage == pytest.approx(0.0)

    def test_effective_bar_uses_baseline_when_higher(self, tmp_path: Path) -> None:
        """_effective_bar = max(sota_bar, baseline) per R-9."""
        angle = AngleEntry(
            angle_id="reasoning",
            eval_version_added="v1",
            sota_bar=0.60,
            sota_source_ids=["src-x"],
            sota_quorum_met=True,
            baseline_model_score_before_finetune=0.80,  # baseline > sota_bar
            sota_retrieved_at=_ISO,
            held_out_split_hash="",
            is_public_benchmark=False,
            pretraining_contamination_risk="low",
        )
        assert _effective_bar(angle) == pytest.approx(0.80)

    def test_unscored_angle_excluded_from_coverage(self, tmp_path: Path) -> None:
        """Angle absent from result.per_domain is not counted in coverage denominator."""
        mgr = AngleRegistryManager(mission_id=_MISSION)
        mgr.add_angle(
            angle_id="scored-angle",
            sota_bar=0.70,
            sota_sources=[self._src("s1"), self._src("s2")],
            baseline_score=None,
            run_dir=tmp_path,
        )
        mgr.add_angle(
            angle_id="unscored-angle",
            sota_bar=0.80,
            sota_sources=[self._src("s3"), self._src("s4")],
            baseline_score=None,
            run_dir=tmp_path,
        )

        registry = _load_registry(tmp_path)
        # Only "scored-angle" present in per_domain
        result = _make_eval_result(
            per_domain={"scored-angle": {"accuracy": 0.85}},
        )
        per_angle, coverage = mgr.score_angles(result, registry, "v1")

        assert "unscored-angle" not in per_angle
        assert "scored-angle" in per_angle
        # coverage denominator = 1 (only scored-angle); 1/1 = 1.0
        assert coverage == pytest.approx(1.0)

    def test_monotonic_sota_write_lock(self, tmp_path: Path) -> None:
        """update_angle() raises ValueError if new bar < existing bar."""
        mgr = AngleRegistryManager(mission_id=_MISSION)
        mgr.add_angle(
            angle_id="safety-bench",
            sota_bar=0.80,
            sota_sources=[self._src("s1"), self._src("s2")],
            baseline_score=None,
            run_dir=tmp_path,
        )
        with pytest.raises(ValueError, match="Monotonic SOTA write-lock"):
            mgr.update_angle("safety-bench", new_sota_bar=0.70, new_sources=["s1"], run_dir=tmp_path)


# ─────────────────────────────────────────────────────────────────────────────
# evaluator + angle_registry — _apply_angle_scoring with real registry on disk
# ─────────────────────────────────────────────────────────────────────────────


class TestEvaluatorAngleRegistryIntegration:
    """EvaluatorAdapter._apply_angle_scoring() reads angle-registry.json from
    run_dir and populates worst_angle_coverage + per_angle_vs_sota on the result.

    No subprocess / GPU required — the private method is callable directly.
    """

    def _populate_registry(self, run_dir: Path) -> None:
        mgr = AngleRegistryManager(mission_id=_MISSION)
        src = SotaSource(
            source_id="src-human",
            name="Human eval source",
            retrieval_method="human_provided",
            trust_level="authoritative",
            citation="Human eval paper",
            retrieved_at=_ISO,
        )
        mgr.add_angle(
            angle_id="reasoning",
            sota_bar=0.75,
            sota_sources=[src, SotaSource(
                source_id="src-human-2",
                name="Second human eval",
                retrieval_method="human_provided",
                trust_level="authoritative",
                citation="Second eval",
                retrieved_at=_ISO,
            )],
            baseline_score=0.55,
            run_dir=run_dir,
        )

    def test_apply_angle_scoring_enriches_result(self, tmp_path: Path) -> None:
        self._populate_registry(tmp_path)
        evaluator = EvaluatorAdapter(run_dir=tmp_path)
        goal = _make_goal(mission_type="open_ended")

        result = _make_eval_result(
            per_domain={"reasoning": {"accuracy": 0.82}},
        )
        enriched = evaluator._apply_angle_scoring(result, goal, "v1")

        # worst_angle_coverage populated (0.82 >= max(0.75, 0.55) → above_sota)
        assert enriched.worst_angle_coverage == pytest.approx(1.0)
        assert "reasoning" in enriched.per_angle_vs_sota
        assert enriched.per_angle_vs_sota["reasoning"].above_sota is True

    def test_apply_angle_scoring_below_sota(self, tmp_path: Path) -> None:
        self._populate_registry(tmp_path)
        evaluator = EvaluatorAdapter(run_dir=tmp_path)
        goal = _make_goal(mission_type="open_ended")

        result = _make_eval_result(
            per_domain={"reasoning": {"accuracy": 0.60}},  # below effective_bar=0.75
        )
        enriched = evaluator._apply_angle_scoring(result, goal, "v1")

        assert enriched.worst_angle_coverage == pytest.approx(0.0)
        assert enriched.per_angle_vs_sota["reasoning"].above_sota is False

    def test_apply_angle_scoring_missing_registry_returns_result_unchanged(
        self, tmp_path: Path
    ) -> None:
        """If angle-registry.json is absent, result is returned unchanged (no crash)."""
        evaluator = EvaluatorAdapter(run_dir=tmp_path)
        goal = _make_goal()
        result = _make_eval_result()

        returned = evaluator._apply_angle_scoring(result, goal, "v1")
        assert returned.fitness_value == pytest.approx(result.fitness_value)
        assert returned.per_angle_vs_sota == result.per_angle_vs_sota
