"""
harness/tests/test_contracts.py — L2 unit tests for harness/evor/contracts.py

Tests Pydantic v2 strict-mode model construction, the 7-tag ApproachFamily
literal, and invalid-input rejection via ValidationError.

Only contracts.py is imported; no other harness module is touched.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from evor.contracts import (
    AcquisitionProvenance,
    AngleEntry,
    AngleRegistry,
    BenchmarkUpgrade,
    Budget,
    CriticReview,
    GoalContract,
    Hypothesis,
    LessonEntry,
    MetricSpec,
    MutationProposal,
    StrategyState,
    StopCondition,
    TreeNode,
    infer_metric_scale,
    is_contract_authentic,
    seal_contract,
    verify_contract_seal,
    verify_contract_seal_strict,
)

# ─── Shared fixtures ──────────────────────────────────────────────────────────

ISO_TS = "2026-01-01T00:00:00Z"
UUID_A = "550e8400-e29b-41d4-a716-446655440000"

VALID_METRIC_SPEC = MetricSpec(
    metric_name="accuracy",
    direction="higher",
    domain_applicability="all",
    aggregation_rule="macro_avg",
    role="primary_fitness",
)

VALID_STOP_CONDITION = StopCondition(type="beat-baseline")

VALID_BUDGET = Budget(
    max_iterations=50,
    plateau_window=8,
    circuit_breaker=5,
    max_cost_usd=100.0,
)

VALID_GOAL_CONTRACT_KWARGS: dict = dict(
    mission_id="m-001",
    mode="from-scratch",
    mission_type="fixed",
    task_description="Train image classifier on CIFAR-10 subset",
    dataset_ref="s3://bucket/cifar10",
    metric_specs=[VALID_METRIC_SPEC],
    fitness_mode="aggregate",
    eval_version="v1",
    baseline_value=0.72,
    stop_condition=VALID_STOP_CONDITION,
    wildness=0.5,
    budget=VALID_BUDGET,
    locked_split_hash="abc123",
    eval_script_hash="def456",
    allowed_licenses=["MIT", "Apache-2.0"],
    created_at=ISO_TS,
)

VALID_TREE_NODE_KWARGS: dict = dict(
    id=UUID_A,
    parent_ids=[],
    approach_family="arch",
    hypothesis_id="h-001",
    code_ref="sha256:abc",
    genome_ref="sha256:def",
    data_version_ref="sha256:ghi",
    config={"lr": 0.001},
    metrics={"accuracy": 0.85},
    eval_version="v1",
    lesson_ids=[],
    citations=[],
    integrity_status="passed",
    status="done",
    is_crossover=False,
    visit_count=0,
    depth=0,
    created_at=ISO_TS,
)

VALID_CRITIC_REVIEW = CriticReview(
    h001_one_hypothesis="pass",
    h002_family_streak="pass",
    h003_intra_tick_diversity="pass",
    integrity_risk="pass",
    instrumentation_check="pass",
    schema_valid="pass",
    verdict="approved",
)


# ─── ApproachFamily ───────────────────────────────────────────────────────────


APPROACH_FAMILY_TAGS = [
    "arch",
    "training",
    "data-curation",
    "data-augmentation",
    "data-acquisition",
    "algo",
    "other",
]


class TestApproachFamily:
    """7-tag taxonomy enforced via Literal on every model that carries the field."""

    @pytest.mark.parametrize("tag", APPROACH_FAMILY_TAGS)
    def test_all_seven_tags_accepted_on_tree_node(self, tag: str) -> None:
        node = TreeNode(**{**VALID_TREE_NODE_KWARGS, "approach_family": tag})
        assert node.approach_family == tag

    @pytest.mark.parametrize("tag", APPROACH_FAMILY_TAGS)
    def test_all_seven_tags_accepted_on_mutation_proposal(self, tag: str) -> None:
        prop = MutationProposal(
            proposal_id="prop-001",
            parent_node_ids=[UUID_A],
            approach_family=tag,
            idea="test idea",
            hypothesis=Hypothesis(
                id="h-001",
                statement="stmt",
                prediction="pred",
            ),
            citations=[],
            wildness=0.5,
            critic_review=VALID_CRITIC_REVIEW,
        )
        assert prop.approach_family == tag

    def test_invalid_tag_rejected_on_tree_node(self) -> None:
        with pytest.raises(ValidationError):
            TreeNode(**{**VALID_TREE_NODE_KWARGS, "approach_family": "vision"})

    def test_completely_unknown_tag_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TreeNode(**{**VALID_TREE_NODE_KWARGS, "approach_family": "nlp"})

    def test_augmentation_bare_tag_rejected(self) -> None:
        """'augmentation' (no longer aliased) is not a valid ApproachFamily tag."""
        with pytest.raises(ValidationError):
            TreeNode(**{**VALID_TREE_NODE_KWARGS, "approach_family": "augmentation"})

    def test_canonical_data_augmentation_accepted(self) -> None:
        node = TreeNode(**{**VALID_TREE_NODE_KWARGS, "approach_family": "data-augmentation"})
        assert node.approach_family == "data-augmentation"


# ─── GoalContract ─────────────────────────────────────────────────────────────


class TestGoalContract:
    def test_valid_construction(self) -> None:
        gc = GoalContract(**VALID_GOAL_CONTRACT_KWARGS)
        assert gc.mission_id == "m-001"
        assert gc.mission_type == "fixed"
        assert gc.metric_specs[0].role == "primary_fitness"

    def test_open_ended_mission_type(self) -> None:
        gc = GoalContract(**{**VALID_GOAL_CONTRACT_KWARGS, "mission_type": "open_ended"})
        assert gc.mission_type == "open_ended"

    def test_model_dump_roundtrip(self) -> None:
        gc = GoalContract(**VALID_GOAL_CONTRACT_KWARGS)
        data = gc.model_dump()
        gc2 = GoalContract.model_validate(data)
        assert gc2.mission_id == gc.mission_id
        assert gc2.eval_version == gc.eval_version

    def test_invalid_mode_rejected(self) -> None:
        with pytest.raises(ValidationError):
            GoalContract(**{**VALID_GOAL_CONTRACT_KWARGS, "mode": "clone"})

    def test_invalid_fitness_mode_rejected(self) -> None:
        with pytest.raises(ValidationError):
            GoalContract(**{**VALID_GOAL_CONTRACT_KWARGS, "fitness_mode": "min-loss"})

    def test_missing_required_field_rejected(self) -> None:
        kwargs = {k: v for k, v in VALID_GOAL_CONTRACT_KWARGS.items() if k != "mission_id"}
        with pytest.raises((ValidationError, TypeError)):
            GoalContract(**kwargs)


# ─── TreeNode ─────────────────────────────────────────────────────────────────


class TestTreeNode:
    def test_valid_construction(self) -> None:
        node = TreeNode(**VALID_TREE_NODE_KWARGS)
        assert node.id == UUID_A
        assert node.integrity_status == "passed"
        assert node.is_crossover is False

    def test_optional_fields_default_to_none(self) -> None:
        node = TreeNode(**VALID_TREE_NODE_KWARGS)
        assert node.fitness_value is None
        assert node.ucb1_score is None
        assert node.completed_at is None
        assert node.parent_patch_ref is None

    def test_model_dump_roundtrip(self) -> None:
        node = TreeNode(**VALID_TREE_NODE_KWARGS)
        data = node.model_dump()
        node2 = TreeNode.model_validate(data)
        assert node2.id == node.id
        assert node2.approach_family == node.approach_family

    def test_invalid_integrity_status_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TreeNode(**{**VALID_TREE_NODE_KWARGS, "integrity_status": "unknown"})

    def test_invalid_status_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TreeNode(**{**VALID_TREE_NODE_KWARGS, "status": "cancelled"})

    def test_invalid_approach_family_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TreeNode(**{**VALID_TREE_NODE_KWARGS, "approach_family": "kernel"})


# ─── MutationProposal ─────────────────────────────────────────────────────────


class TestMutationProposal:
    def _make(self, **overrides) -> MutationProposal:
        base = dict(
            proposal_id="prop-001",
            parent_node_ids=[UUID_A],
            approach_family="training",
            idea="Switch from SGD to AdamW",
            hypothesis=Hypothesis(id="h-001", statement="AdamW converges faster", prediction="+2pp"),
            citations=["https://arxiv.org/abs/1711.05101"],
            wildness=0.3,
            critic_review=VALID_CRITIC_REVIEW,
        )
        return MutationProposal(**{**base, **overrides})

    def test_valid_construction(self) -> None:
        prop = self._make()
        assert prop.proposal_id == "prop-001"
        assert prop.critic_review.verdict == "approved"

    def test_rejected_verdict_with_reason(self) -> None:
        review = CriticReview(
            h001_one_hypothesis="pass",
            h002_family_streak="fail",
            h003_intra_tick_diversity="pass",
            integrity_risk="pass",
            instrumentation_check="pass",
            schema_valid="pass",
            verdict="rejected",
            rejection_reason="Family streak exceeded",
        )
        prop = self._make(critic_review=review)  # 2b.2: critic_approved removed
        assert prop.critic_review.verdict == "rejected"
        assert prop.critic_review.rejection_reason == "Family streak exceeded"

    def test_invalid_verdict_rejected(self) -> None:
        review_dict = VALID_CRITIC_REVIEW.model_dump()
        review_dict["verdict"] = "pending"
        with pytest.raises(ValidationError):
            CriticReview(**review_dict)

    def test_empty_citations_accepted(self) -> None:
        prop = self._make(citations=[])
        assert prop.citations == []


# ─── AcquisitionProvenance ───────────────────────────────────────────────────


class TestAcquisitionProvenance:
    def _make(self, **overrides) -> AcquisitionProvenance:
        base = dict(
            acquisition_id="acq-001",
            acquisition_type="external",
            license_identifier="CC-BY-4.0",
            license_in_allowlist=True,
            citation="Common Crawl 2024-01 snapshot",
            sample_count=50000,
            acquired_at=ISO_TS,
            ingestion_contamination_cleared=True,
        )
        return AcquisitionProvenance(**{**base, **overrides})

    def test_valid_external(self) -> None:
        prov = self._make()
        assert prov.acquisition_type == "external"
        assert prov.license_in_allowlist is True

    def test_valid_synthetic_with_generator_config(self) -> None:
        prov = self._make(
            acquisition_type="synthetic",
            generator_config={"model": "gpt-4o", "temperature": 0.7},
        )
        assert prov.acquisition_type == "synthetic"
        assert prov.generator_config == {"model": "gpt-4o", "temperature": 0.7}

    def test_invalid_acquisition_type_rejected(self) -> None:
        with pytest.raises(ValidationError):
            self._make(acquisition_type="crowd-sourced")

    def test_missing_citation_rejected(self) -> None:
        with pytest.raises((ValidationError, TypeError)):
            AcquisitionProvenance(
                acquisition_id="acq-002",
                acquisition_type="external",
                license_identifier="MIT",
                license_in_allowlist=True,
                # citation omitted
                sample_count=100,
                acquired_at=ISO_TS,
                ingestion_contamination_cleared=True,
            )


# ─── AngleRegistry ────────────────────────────────────────────────────────────


class TestAngleRegistry:
    def _make_angle(self, **overrides) -> AngleEntry:
        base = dict(
            angle_id="angle-cifar10-acc",
            eval_version_added="v1",
            sota_bar=0.985,
            sota_source_ids=["src-papers", "src-mlcommons"],
            sota_quorum_met=True,
            baseline_model_score_before_finetune=None,
            sota_retrieved_at=ISO_TS,
            held_out_split_hash="sha256:xyz",
            is_public_benchmark=True,
            pretraining_contamination_risk="medium",
        )
        return AngleEntry(**{**base, **overrides})

    def test_valid_registry_with_one_angle(self) -> None:
        reg = AngleRegistry(
            mission_id="m-001",
            angles=[self._make_angle()],
            updated_at=ISO_TS,
        )
        assert len(reg.angles) == 1
        assert reg.angles[0].sota_quorum_met is True

    def test_empty_angles_list(self) -> None:
        reg = AngleRegistry(mission_id="m-001", angles=[], updated_at=ISO_TS)
        assert reg.angles == []

    def test_null_baseline_model_score(self) -> None:
        angle = self._make_angle(baseline_model_score_before_finetune=None)
        assert angle.baseline_model_score_before_finetune is None

    def test_numeric_baseline_model_score(self) -> None:
        angle = self._make_angle(baseline_model_score_before_finetune=0.82)
        assert angle.baseline_model_score_before_finetune == 0.82

    def test_invalid_contamination_risk_rejected(self) -> None:
        with pytest.raises(ValidationError):
            self._make_angle(pretraining_contamination_risk="extreme")

    def test_model_dump_roundtrip(self) -> None:
        reg = AngleRegistry(
            mission_id="m-001",
            angles=[self._make_angle()],
            updated_at=ISO_TS,
        )
        data = reg.model_dump()
        reg2 = AngleRegistry.model_validate(data)
        assert reg2.mission_id == reg.mission_id
        assert len(reg2.angles) == 1


# ─── StrategyState ────────────────────────────────────────────────────────────


class TestStrategyState:
    def _make(self, **overrides) -> StrategyState:
        base = dict(
            meta_iteration=0,
            selection_policy="ucb1",
            ucb1_c=1.41,
            wildness=0.5,
            family_mix={"arch": 0.5, "training": 0.5},
            winning_families=["arch"],
            wins_by_family={"arch": 3},
            meta_loop_interval=5,
            post_upgrade_exploration_boost=None,
            post_upgrade_exploration_ticks=0,
            rescore_mode="sync",
            updated_at=ISO_TS,
        )
        return StrategyState(**{**base, **overrides})

    def test_valid_construction(self) -> None:
        state = self._make()
        assert state.selection_policy == "ucb1"
        assert state.rescore_mode == "sync"
        assert state.ucb1_c == pytest.approx(1.41)

    def test_null_post_upgrade_exploration_boost(self) -> None:
        state = self._make(post_upgrade_exploration_boost=None)
        assert state.post_upgrade_exploration_boost is None

    def test_non_null_boost_with_ticks(self) -> None:
        state = self._make(post_upgrade_exploration_boost=2.0, post_upgrade_exploration_ticks=8)
        assert state.post_upgrade_exploration_boost == 2.0
        assert state.post_upgrade_exploration_ticks == 8

    def test_rescore_mode_async(self) -> None:
        """Q1 — rescore_mode is single source of truth for BenchmarkUpgrade re-score."""
        state = self._make(rescore_mode="async")
        assert state.rescore_mode == "async"

    @pytest.mark.parametrize("policy", ["ucb1", "mcts", "beam"])
    def test_all_selection_policies(self, policy: str) -> None:
        state = self._make(selection_policy=policy)
        assert state.selection_policy == policy

    def test_invalid_selection_policy_rejected(self) -> None:
        with pytest.raises(ValidationError):
            self._make(selection_policy="greedy")

    def test_invalid_rescore_mode_rejected(self) -> None:
        with pytest.raises(ValidationError):
            self._make(rescore_mode="eager")

    def test_zero_post_upgrade_exploration_ticks_accepted(self) -> None:
        # ticks=0 means no boost countdown active
        state = self._make(post_upgrade_exploration_ticks=0)
        assert state.post_upgrade_exploration_ticks == 0


# ─── BenchmarkUpgrade ─────────────────────────────────────────────────────────


class TestBenchmarkUpgrade:
    def _make(self, **overrides) -> BenchmarkUpgrade:
        base = dict(
            upgrade_id="upg-001",
            mission_id="m-001",
            from_eval_version="v1",
            to_eval_version="v2",
            proposed_by="probe",
            proposal_citations=["https://arxiv.org/abs/2101.00001"],
            consent_granted=True,
            new_domains_added=["tabular-churn"],
            domains_removed=[],  # DEFENSIVE INVARIANT: always empty (Q4)
            rescore_status="pending",
            rescore_deadline_ticks=10,
            decision_log_ref="decision-log.md",
            created_at=ISO_TS,
        )
        return BenchmarkUpgrade(**{**base, **overrides})

    def test_valid_construction_empty_domains_removed(self) -> None:
        upg = self._make()
        assert upg.upgrade_id == "upg-001"
        assert upg.domains_removed == []  # invariant

    @pytest.mark.parametrize("status", ["pending", "in_progress", "complete", "partial"])
    def test_all_rescore_statuses(self, status: str) -> None:
        upg = self._make(rescore_status=status)
        assert upg.rescore_status == status

    @pytest.mark.parametrize("proposer", ["user", "probe", "sage", "policy"])
    def test_all_proposed_by_values(self, proposer: str) -> None:
        upg = self._make(proposed_by=proposer)
        assert upg.proposed_by == proposer

    def test_optional_consent_at(self) -> None:
        upg = self._make(consent_at=ISO_TS)
        assert upg.consent_at == ISO_TS

    def test_model_dump_roundtrip(self) -> None:
        upg = self._make()
        data = upg.model_dump()
        upg2 = BenchmarkUpgrade.model_validate(data)
        assert upg2.upgrade_id == upg.upgrade_id
        assert upg2.domains_removed == []

    def test_invalid_proposed_by_rejected(self) -> None:
        with pytest.raises(ValidationError):
            self._make(proposed_by="admin")

    def test_invalid_rescore_status_rejected(self) -> None:
        with pytest.raises(ValidationError):
            self._make(rescore_status="done")

    def test_zero_rescore_deadline_ticks_accepted(self) -> None:
        # zero deadline = demote immediately (valid edge case)
        upg = self._make(rescore_deadline_ticks=0)
        assert upg.rescore_deadline_ticks == 0


# ─── P0-6: exclude_none ───────────────────────────────────────────────────────


class TestExcludeNone:
    """P0-6: Pydantic serializes optional=None fields as null by default; Zod
    .optional() rejects explicit null.  All models with optional fields must
    suppress null keys in model_dump() output."""

    def test_goal_contract_dump_has_no_null_keys(self) -> None:
        """GoalContract with only required fields must produce zero null values."""
        gc = GoalContract(**VALID_GOAL_CONTRACT_KWARGS)
        data = gc.model_dump()
        null_keys = [k for k, v in data.items() if v is None]
        assert null_keys == [], f"model_dump() contains null keys: {null_keys}"

    def test_goal_contract_optional_none_absent_from_dump(self) -> None:
        """target_value=None must be absent (not present as null) in the dump."""
        gc = GoalContract(**VALID_GOAL_CONTRACT_KWARGS)
        assert gc.target_value is None
        data = gc.model_dump()
        assert "target_value" not in data, (
            "target_value=None must be excluded from model_dump(); "
            "add exclude_none=True to ConfigDict"
        )

    def test_metric_spec_dump_has_no_null_keys(self) -> None:
        """MetricSpec optional fields (sota_bar, fitness_formula, fbeta) absent when None."""
        spec = MetricSpec(
            metric_name="f1",
            direction="higher",
            domain_applicability="all",
            aggregation_rule="macro_avg",
            role="primary_fitness",
        )
        data = spec.model_dump()
        null_keys = [k for k, v in data.items() if v is None]
        assert null_keys == [], f"MetricSpec.model_dump() contains null keys: {null_keys}"

    def test_strategy_state_dump_has_no_null_keys(self) -> None:
        """StrategyState with post_upgrade_exploration_boost=None must not emit null."""
        state = StrategyState(
            meta_iteration=0,
            selection_policy="ucb1",
            ucb1_c=1.41,
            wildness=0.5,
            family_mix={"arch": 0.5, "training": 0.5},
            winning_families=[],
            wins_by_family={},
            meta_loop_interval=5,
            post_upgrade_exploration_boost=None,
            post_upgrade_exploration_ticks=0,
            rescore_mode="sync",
            updated_at=ISO_TS,
        )
        data = state.model_dump()
        null_keys = [k for k, v in data.items() if v is None]
        assert null_keys == [], f"StrategyState.model_dump() contains null keys: {null_keys}"


# ─── P0-7: GoalContract.metric_scale ─────────────────────────────────────────


class TestMetricScale:
    """P0-7: DIBCO and other 0-100 scale metrics need metric_scale on GoalContract
    so reward_hacking_probe normalises before the ≥0.98 ceiling check."""

    def test_metric_scale_defaults_to_1(self) -> None:
        gc = GoalContract(**VALID_GOAL_CONTRACT_KWARGS)
        assert gc.metric_scale == 1.0

    def test_metric_scale_accepts_100(self) -> None:
        gc = GoalContract(**{**VALID_GOAL_CONTRACT_KWARGS, "metric_scale": 100.0})
        assert gc.metric_scale == 100.0

    def test_metric_scale_roundtrip(self) -> None:
        gc = GoalContract(**{**VALID_GOAL_CONTRACT_KWARGS, "metric_scale": 100.0})
        data = gc.model_dump()
        gc2 = GoalContract.model_validate(data)
        assert gc2.metric_scale == 100.0

    def test_metric_scale_absent_from_dump_when_default(self) -> None:
        """metric_scale=1.0 is the default; when exclude_none is active and the value
        equals the default, it may or may not appear — but it must never be None."""
        gc = GoalContract(**VALID_GOAL_CONTRACT_KWARGS)
        data = gc.model_dump()
        # It must not be None; if present, value must be 1.0
        if "metric_scale" in data:
            assert data["metric_scale"] == 1.0


class TestRewardHackingProbeMetricScale:
    """P0-7: reward_hacking_probe must normalise score by metric_scale before ceiling check."""

    def _make_result(self, score: float) -> object:
        from evor.contracts import EvaluationResult, TelemetrySummary
        return EvaluationResult(
            node_id="n-001",
            run_id="r-001",
            eval_version="v1",
            metrics={"accuracy": score},
            per_domain={},
            fitness_value=score,
            telemetry_summary=TelemetrySummary(total_steps=100),
            status="success",
            benchmark_raw="{}",
            timestamp=ISO_TS,
        )

    def _make_goal(self, metric_scale: float = 1.0) -> GoalContract:
        return GoalContract(**{**VALID_GOAL_CONTRACT_KWARGS, "metric_scale": metric_scale})

    def test_score_98_scale_100_triggers_at_ceiling(self) -> None:
        """98.0 / 100.0 = 0.98 — exactly at the ceiling (LEAK_CEILING = 0.98).
        The check uses >=, so the exact ceiling fires just like raw 0.98 with scale=1.0.
        This confirms normalisation is applied before the ceiling comparison."""
        from evor.integrity import IntegrityGate
        gate = IntegrityGate()
        result = self._make_result(98.0)
        goal = self._make_goal(metric_scale=100.0)
        # reward_hacking_probe returns True when hacking detected (bad)
        flagged = gate._check_reward_hacking(result, goal, corroborated=True)
        # 98/100 == 0.98 == LEAK_CEILING → triggers (>= is inclusive) when corroborated
        assert flagged, "98/100 = 0.98 at the ceiling should be flagged (>= is inclusive) when corroborated"

    def test_score_97_scale_100_does_not_trigger(self) -> None:
        """97.0 / 100.0 = 0.97 — clearly below ceiling; must not trigger."""
        from evor.integrity import IntegrityGate
        gate = IntegrityGate()
        result = self._make_result(97.0)
        goal = self._make_goal(metric_scale=100.0)
        flagged = gate._check_reward_hacking(result, goal)
        assert not flagged, "97/100 = 0.97 should not be flagged"

    def test_score_99_scale_100_triggers(self) -> None:
        """99.0 / 100.0 = 0.99 > 0.98 — above ceiling; must trigger."""
        from evor.integrity import IntegrityGate
        gate = IntegrityGate()
        result = self._make_result(99.0)
        goal = self._make_goal(metric_scale=100.0)
        flagged = gate._check_reward_hacking(result, goal, corroborated=True)
        assert flagged, "99/100 = 0.99 should be flagged as reward hacking ceiling when corroborated"

    def test_score_0_98_scale_1_triggers(self) -> None:
        """Legacy scale=1.0: raw score 0.98 still triggers (no change to existing behaviour)."""
        from evor.integrity import IntegrityGate
        gate = IntegrityGate()
        result = self._make_result(0.98)
        goal = self._make_goal(metric_scale=1.0)
        flagged = gate._check_reward_hacking(result, goal, corroborated=True)
        assert flagged, "0.98 with scale=1.0 must still trigger when corroborated (backward compat)"


# ─── P0-2: Contract seal ──────────────────────────────────────────────────────


class TestContractSeal:
    """P0-2: seal_contract() stamps GoalContract with a sha256 of its own content;
    verify_contract_seal() detects any post-lock mutation."""

    def _base_gc(self) -> GoalContract:
        return GoalContract(**VALID_GOAL_CONTRACT_KWARGS)

    def test_seal_sets_contract_seal_field(self) -> None:
        gc = self._base_gc()
        sealed = seal_contract(gc)
        assert sealed.contract_seal is not None
        assert len(sealed.contract_seal) == 64  # sha256 hex digest

    def test_verify_sealed_contract_passes(self) -> None:
        gc = seal_contract(self._base_gc())
        assert verify_contract_seal(gc) is True

    def test_verify_unsealed_contract_passes(self) -> None:
        """Backward compat: no seal → verify returns True (warning only, not failure)."""
        gc = self._base_gc()
        assert gc.contract_seal is None
        assert verify_contract_seal(gc) is True

    def test_verify_detects_field_mutation(self) -> None:
        """After sealing, changing any field must make verify return False."""
        gc = seal_contract(self._base_gc())
        # Mutate a field on a fresh copy (Pydantic v2 models are immutable by default,
        # so use model_copy with update)
        tampered = gc.model_copy(update={"baseline_value": 0.99})
        assert verify_contract_seal(tampered) is False

    def test_verify_detects_mission_id_change(self) -> None:
        gc = seal_contract(self._base_gc())
        tampered = gc.model_copy(update={"mission_id": "m-TAMPERED"})
        assert verify_contract_seal(tampered) is False

    def test_seal_is_deterministic(self) -> None:
        """Same contract → same seal on repeated calls."""
        gc = self._base_gc()
        s1 = seal_contract(gc)
        s2 = seal_contract(gc)
        assert s1.contract_seal == s2.contract_seal

    def test_contract_seal_excluded_from_dump_when_none(self) -> None:
        """With exclude_none, unsealed contract's contract_seal=None must not appear."""
        gc = self._base_gc()
        data = gc.model_dump()
        assert "contract_seal" not in data


# ─── P0-2: Strict seal verification ──────────────────────────────────────────


class TestStrictSealVerification:
    """is_contract_authentic() and verify_contract_seal_strict() must reject
    unsigned contracts instead of silently accepting them."""

    def _base_gc(self) -> GoalContract:
        return GoalContract(**VALID_GOAL_CONTRACT_KWARGS)

    # ── is_contract_authentic ────────────────────────────────────────────────

    def test_authentic_sealed_contract_returns_true(self) -> None:
        gc = seal_contract(self._base_gc())
        assert is_contract_authentic(gc) is True

    def test_unsigned_contract_is_not_authentic(self) -> None:
        """None seal → False, NOT True+warn (unlike verify_contract_seal)."""
        gc = self._base_gc()
        assert gc.contract_seal is None
        assert is_contract_authentic(gc) is False

    def test_tampered_contract_is_not_authentic(self) -> None:
        gc = seal_contract(self._base_gc())
        tampered = gc.model_copy(update={"baseline_value": 0.99})
        assert is_contract_authentic(tampered) is False

    def test_mission_id_tamper_detected(self) -> None:
        gc = seal_contract(self._base_gc())
        tampered = gc.model_copy(update={"mission_id": "m-EVIL"})
        assert is_contract_authentic(tampered) is False

    def test_backward_compat_verify_still_passes_for_unsigned(self) -> None:
        """Legacy verify_contract_seal() must still return True+warn for None seal."""
        gc = self._base_gc()
        import warnings
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = verify_contract_seal(gc)
        assert result is True
        assert len(caught) == 1
        assert "no contract_seal" in str(caught[0].message).lower()

    def test_strict_rejects_unsigned_where_lenient_passes(self) -> None:
        """Key divergence: same unsigned contract → lenient=True, strict=False."""
        gc = self._base_gc()
        import warnings
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            lenient = verify_contract_seal(gc)
        strict = verify_contract_seal_strict(gc)
        assert lenient is True
        assert strict is False

    # ── verify_contract_seal_strict ──────────────────────────────────────────

    def test_strict_sealed_contract_passes(self) -> None:
        gc = seal_contract(self._base_gc())
        assert verify_contract_seal_strict(gc) is True

    def test_strict_tampered_contract_fails(self) -> None:
        gc = seal_contract(self._base_gc())
        tampered = gc.model_copy(update={"wildness": 0.99})
        assert verify_contract_seal_strict(tampered) is False

    def test_strict_unsigned_fails(self) -> None:
        gc = self._base_gc()
        assert verify_contract_seal_strict(gc) is False


# ─── P0-7: infer_metric_scale + auto-fill ─────────────────────────────────────


class TestInferMetricScale:
    """Unit tests for the infer_metric_scale() helper function."""

    @pytest.mark.parametrize("metric_name,expected", [
        # DIBCO family → 100.0
        ("f_measure", 100.0),
        ("F_Measure", 100.0),          # case-insensitive
        ("pfm", 100.0),
        ("fps", 100.0),
        ("pseudo_fm", 100.0),
        ("dibco_fm", 100.0),
        # percent-expressed → 100.0
        ("cer_percent", 100.0),
        ("wer_percent", 100.0),
        ("accuracy_percent", 100.0),
        ("map_percent", 100.0),
        ("iou_percent", 100.0),
        ("miou_percent", 100.0),
        # standard [0,1] metrics → 1.0
        ("accuracy", 1.0),
        ("f1", 1.0),
        ("precision", 1.0),
        ("recall", 1.0),
        ("auc", 1.0),
        ("loss", 1.0),
        ("psnr", 1.0),          # PSNR is 0-40+dB, not 0-100
        ("ssim", 1.0),
        ("cer", 1.0),           # CER without _percent suffix stays 1.0
        ("wer", 1.0),           # WER without _percent suffix stays 1.0
    ])
    def test_metric_name_inference(self, metric_name: str, expected: float) -> None:
        assert infer_metric_scale(metric_name) == expected

    @pytest.mark.parametrize("dataset_ref,expected", [
        ("dibco2019", 100.0),
        ("DIBCO2017", 100.0),           # case-insensitive
        ("s3://bucket/dibco", 100.0),
        ("binarization/train", 100.0),
        ("document_binarization", 100.0),
        # negative cases
        ("s3://bucket/cifar10", 1.0),
        ("imagenet", 1.0),
        ("coco/train2017", 1.0),
        ("my-dataset", 1.0),
    ])
    def test_dataset_ref_inference(self, dataset_ref: str, expected: float) -> None:
        assert infer_metric_scale("accuracy", dataset_ref) == expected

    def test_metric_name_wins_over_neutral_dataset(self) -> None:
        """DIBCO metric_name → 100.0 even if dataset ref is neutral."""
        assert infer_metric_scale("f_measure", "s3://bucket/cifar10") == 100.0

    def test_dataset_ref_wins_for_unknown_metric_on_dibco(self) -> None:
        """Unknown metric but DIBCO dataset → still 100.0."""
        assert infer_metric_scale("custom_score", "dibco2019") == 100.0

    def test_empty_inputs_return_1(self) -> None:
        assert infer_metric_scale("") == 1.0
        assert infer_metric_scale("", "") == 1.0

    def test_none_inputs_do_not_crash(self) -> None:
        """dataset_ref/metric_name may be None on a real contract — must not raise."""
        assert infer_metric_scale("accuracy", None) == 1.0
        assert infer_metric_scale(None, None) == 1.0  # type: ignore[arg-type]
        assert infer_metric_scale("f_measure", None) == 100.0  # metric still infers


class TestMetricScaleAutoInference:
    """P0-7: GoalContract must auto-fill metric_scale from infer_metric_scale()
    when the caller omits the field, and preserve explicit values."""

    def _make_gc(self, metric_name: str = "accuracy", dataset_ref: str = "s3://bucket/cifar10",
                 **extra) -> GoalContract:
        spec = MetricSpec(
            metric_name=metric_name,
            direction="higher",
            domain_applicability="all",
            aggregation_rule="macro_avg",
            role="primary_fitness",
        )
        return GoalContract(**{
            **VALID_GOAL_CONTRACT_KWARGS,
            "metric_specs": [spec],
            "dataset_ref": dataset_ref,
            **extra,
        })

    def test_omitted_metric_scale_infers_1_for_accuracy(self) -> None:
        gc = self._make_gc(metric_name="accuracy")
        # metric_scale not in kwargs → auto-inferred → 1.0 for accuracy
        assert gc.metric_scale == 1.0

    def test_omitted_metric_scale_infers_100_for_dibco_metric(self) -> None:
        gc = self._make_gc(metric_name="f_measure")
        assert gc.metric_scale == 100.0

    def test_omitted_metric_scale_infers_100_for_dibco_dataset(self) -> None:
        gc = self._make_gc(metric_name="custom_score", dataset_ref="dibco2019")
        assert gc.metric_scale == 100.0

    def test_explicit_metric_scale_1_preserved(self) -> None:
        """Explicit 1.0 even on a DIBCO metric must NOT be overridden."""
        gc = self._make_gc(metric_name="f_measure", metric_scale=1.0)
        assert gc.metric_scale == 1.0

    def test_explicit_metric_scale_100_preserved(self) -> None:
        """Explicit 100.0 on a neutral metric must NOT be overridden."""
        gc = self._make_gc(metric_name="accuracy", metric_scale=100.0)
        assert gc.metric_scale == 100.0

    def test_explicit_metric_scale_50_preserved(self) -> None:
        """Arbitrary non-standard explicit value must survive unchanged."""
        gc = self._make_gc(metric_name="accuracy", metric_scale=50.0)
        assert gc.metric_scale == 50.0

    def test_roundtrip_preserves_inferred_scale(self) -> None:
        """After dump+reload the inferred scale survives in the serialised form."""
        gc = self._make_gc(metric_name="f_measure")
        assert gc.metric_scale == 100.0
        data = gc.model_dump()
        # metric_scale must be present in dump when non-default
        assert data.get("metric_scale") == 100.0
        gc2 = GoalContract.model_validate(data)
        assert gc2.metric_scale == 100.0


# ─── Class 7: server-owned bookkeeping defaults ───────────────────────────────


class TestServerOwnedDefaults:
    """Server-owned fields must be optional with correct defaults (Class 7 fix)."""

    # ── TreeNode ─────────────────────────────────────────────────────────────────

    def test_tree_node_lesson_ids_defaults_to_empty_list(self) -> None:
        node = TreeNode(**{k: v for k, v in VALID_TREE_NODE_KWARGS.items()
                           if k not in ("lesson_ids",)})
        assert node.lesson_ids == []

    def test_tree_node_citations_defaults_to_empty_list(self) -> None:
        node = TreeNode(**{k: v for k, v in VALID_TREE_NODE_KWARGS.items()
                           if k not in ("citations",)})
        assert node.citations == []

    def test_tree_node_integrity_status_defaults_to_pending(self) -> None:
        node = TreeNode(**{k: v for k, v in VALID_TREE_NODE_KWARGS.items()
                           if k not in ("integrity_status",)})
        assert node.integrity_status == "pending"

    def test_tree_node_status_defaults_to_pending(self) -> None:
        node = TreeNode(**{k: v for k, v in VALID_TREE_NODE_KWARGS.items()
                           if k not in ("status",)})
        assert node.status == "pending"

    def test_tree_node_is_crossover_defaults_to_false(self) -> None:
        node = TreeNode(**{k: v for k, v in VALID_TREE_NODE_KWARGS.items()
                           if k not in ("is_crossover",)})
        assert node.is_crossover is False

    def test_tree_node_visit_count_defaults_to_zero(self) -> None:
        node = TreeNode(**{k: v for k, v in VALID_TREE_NODE_KWARGS.items()
                           if k not in ("visit_count",)})
        assert node.visit_count == 0

    def test_tree_node_depth_defaults_to_zero(self) -> None:
        node = TreeNode(**{k: v for k, v in VALID_TREE_NODE_KWARGS.items()
                           if k not in ("depth",)})
        assert node.depth == 0

    def test_tree_node_created_at_is_optional(self) -> None:
        node = TreeNode(**{k: v for k, v in VALID_TREE_NODE_KWARGS.items()
                           if k not in ("created_at",)})
        assert node.created_at is None

    def test_tree_node_all_bookkeeping_omitted(self) -> None:
        """Node with only semantic fields constructs without error."""
        omit = {"lesson_ids", "citations", "integrity_status", "status",
                 "is_crossover", "visit_count", "depth", "created_at"}
        node = TreeNode(**{k: v for k, v in VALID_TREE_NODE_KWARGS.items()
                           if k not in omit})
        assert node.lesson_ids == []
        assert node.integrity_status == "pending"
        assert node.visit_count == 0
        assert node.depth == 0

    # ── EvaluationResult ─────────────────────────────────────────────────────────

    def _make_eval_result(self, **overrides):
        from evor.contracts import EvaluationResult, TelemetrySummary
        base = dict(
            metrics={"accuracy": 0.88},
            per_domain={},
            fitness_value=0.88,
            telemetry_summary=TelemetrySummary(total_steps=50),
            status="success",
            benchmark_raw="{}",
        )
        base.update(overrides)
        return EvaluationResult(**base)

    def test_eval_result_node_id_optional(self) -> None:
        from evor.contracts import EvaluationResult
        r = self._make_eval_result()
        assert r.node_id is None

    def test_eval_result_run_id_optional(self) -> None:
        r = self._make_eval_result()
        assert r.run_id is None

    def test_eval_result_eval_version_optional(self) -> None:
        r = self._make_eval_result()
        assert r.eval_version is None

    def test_eval_result_timestamp_optional(self) -> None:
        r = self._make_eval_result()
        assert r.timestamp is None

    def test_eval_result_with_all_bookkeeping_provided(self) -> None:
        r = self._make_eval_result(
            node_id="node-abc",
            run_id="run-001",
            eval_version="v2",
            timestamp="2026-01-01T00:00:00Z",
        )
        assert r.node_id == "node-abc"
        assert r.eval_version == "v2"

    # ── TelemetryRecord ───────────────────────────────────────────────────────────

    def _make_telemetry(self, **overrides):
        from evor.contracts import TelemetryRecord
        base = dict(step=10)
        base.update(overrides)
        return TelemetryRecord(**base)

    def test_telemetry_node_id_optional(self) -> None:
        r = self._make_telemetry()
        assert r.node_id is None

    def test_telemetry_run_id_optional(self) -> None:
        r = self._make_telemetry()
        assert r.run_id is None

    def test_telemetry_timestamp_optional(self) -> None:
        r = self._make_telemetry()
        assert r.timestamp is None

    def test_telemetry_with_bookkeeping_provided(self) -> None:
        r = self._make_telemetry(
            node_id="n1", run_id="r1", timestamp="2026-01-01T00:00:00Z"
        )
        assert r.node_id == "n1"
        assert r.run_id == "r1"

    # ── LessonEntry ───────────────────────────────────────────────────────────────

    def _make_lesson(self, **overrides):
        from evor.contracts import LessonEntry
        base = dict(
            approach_family="arch",
            hypothesis_verdict="confirmed",
            observation="loss dropped significantly",
            actionable_lesson="use residual connections",
            citations=[],
            tags=["arch"],
        )
        base.update(overrides)
        return LessonEntry(**base)

    def test_lesson_id_optional(self) -> None:
        r = self._make_lesson()
        assert r.lesson_id is None

    def test_lesson_node_id_optional(self) -> None:
        r = self._make_lesson()
        assert r.node_id is None

    def test_lesson_run_id_optional(self) -> None:
        r = self._make_lesson()
        assert r.run_id is None

    def test_lesson_mission_id_optional(self) -> None:
        r = self._make_lesson()
        assert r.mission_id is None

    def test_lesson_created_at_optional(self) -> None:
        r = self._make_lesson()
        assert r.created_at is None

    # ── GoalContract ──────────────────────────────────────────────────────────────

    def test_goal_contract_created_at_optional(self) -> None:
        gc = GoalContract(**{k: v for k, v in VALID_GOAL_CONTRACT_KWARGS.items()
                              if k != "created_at"})
        assert gc.created_at is None

    def test_goal_contract_locked_split_hash_optional(self) -> None:
        gc = GoalContract(**{k: v for k, v in VALID_GOAL_CONTRACT_KWARGS.items()
                              if k != "locked_split_hash"})
        assert gc.locked_split_hash is None

    def test_goal_contract_eval_script_hash_optional(self) -> None:
        gc = GoalContract(**{k: v for k, v in VALID_GOAL_CONTRACT_KWARGS.items()
                              if k != "eval_script_hash"})
        assert gc.eval_script_hash is None

    def test_goal_contract_all_server_fields_omitted(self) -> None:
        """Contract with no server-owned fields constructs without error."""
        omit = {"created_at", "locked_split_hash", "eval_script_hash"}
        gc = GoalContract(**{k: v for k, v in VALID_GOAL_CONTRACT_KWARGS.items()
                              if k not in omit})
        assert gc.created_at is None
        assert gc.locked_split_hash is None
        assert gc.eval_script_hash is None

    # ── MutationProposal ──────────────────────────────────────────────────────────

    def test_mutation_proposal_proposal_id_optional(self) -> None:
        prop = MutationProposal(
            parent_node_ids=[UUID_A],
            approach_family="arch",
            idea="test",
            hypothesis=Hypothesis(id="h-1", statement="s", prediction="p"),
            citations=[],
            wildness=0.3,
        )
        assert prop.proposal_id is None

    def test_mutation_proposal_critic_review_optional(self) -> None:
        prop = MutationProposal(
            proposal_id="p-001",
            parent_node_ids=[UUID_A],
            approach_family="arch",
            idea="test",
            hypothesis=Hypothesis(id="h-1", statement="s", prediction="p"),
            citations=[],
            wildness=0.3,
        )
        assert prop.critic_review is None

    def test_mutation_proposal_all_server_fields_omitted(self) -> None:
        """MutationProposal with no proposal_id and no critic_review is valid."""
        prop = MutationProposal(
            parent_node_ids=[UUID_A],
            approach_family="training",
            idea="use mixup",
            hypothesis=Hypothesis(id="h-2", statement="s", prediction="p"),
            citations=[],
            wildness=0.5,
        )
        assert prop.proposal_id is None
        assert prop.critic_review is None
