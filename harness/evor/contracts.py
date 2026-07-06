"""
oh-my-evor data contracts — Pydantic v2 strict models.

All 27+ schemas mirroring mcp/src/contracts.ts exactly.
Field names match the TypeScript interfaces; model_config = ConfigDict(strict=True) on all.

ApproachFamily: 7-tag literal taxonomy per R-12.
Legacy "augmentation" tag aliased to "data-augmentation" on read (H002/H003).
"""

from __future__ import annotations

from typing import Any, Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, field_validator

# ────────────────────────────────────────────────────────────────────────────
# Shared type aliases
# ────────────────────────────────────────────────────────────────────────────

# 7-tag ApproachFamily taxonomy (R-12); legacy "augmentation" aliased on read
ApproachFamily = Literal[
    "arch",
    "training",
    "data-curation",
    "data-augmentation",
    "data-acquisition",
    "algo",
    "other",
]


def _alias_approach_family(value: str) -> str:
    """Normalise legacy 'augmentation' tag to 'data-augmentation'."""
    if value == "augmentation":
        return "data-augmentation"
    return value


# ────────────────────────────────────────────────────────────────────────────
# MetricSpec / MetricRegistry (Pillar 3)
# ────────────────────────────────────────────────────────────────────────────


class MetricConstraint(BaseModel):
    """Hard constraint on a secondary metric used as a gamability guard.

    A candidate violating ANY constraint on the primary MetricSpec receives
    penalized fitness = 0.0 regardless of its formula score. This prevents
    degenerate solutions such as predicting all-positive to maximize recall
    while ignoring precision.

    Example: ``{"metric": "precision", "op": ">=", "threshold": 0.5}``
    prevents recall-gaming when recall is the primary metric.
    """

    model_config = ConfigDict(strict=True)

    metric: str
    """Name of the metric to constrain (must appear in EvaluationResult.metrics)."""
    op: Literal[">=", "<=", "==", ">", "<"]
    """Comparison operator applied as: metric_value op threshold."""
    threshold: float
    """Threshold value for the constraint."""


class MetricSpec(BaseModel):
    """Specification for a single tracked metric.

    Supports scalar, composite-weighted, F-beta, preference-with-constraint,
    and fully-custom metric modes:

    * Scalar:          metric_name="accuracy", no formula/fbeta/constraints
    * Composite:       fitness_formula="0.7*recall+0.3*precision"
    * F-beta:          metric_name="fbeta", fbeta=2.0  (F2 score)
    * Constrained:     fitness_formula + constraints guard degenerate solutions
    * Custom:          custom_metrics=["my_ndcg"] instructs the evaluator to emit it
    """

    model_config = ConfigDict(strict=True)

    metric_name: str
    direction: Literal["higher", "lower"]
    domain_applicability: Union[list[str], Literal["all"]]
    aggregation_rule: Literal["macro_avg", "weighted_avg", "min", "max"]
    role: Literal["primary_fitness", "secondary_reported"]
    sota_bar: Optional[float] = None

    # ── Composite / constraint / custom extensions ────────────────────────────

    fitness_formula: Optional[str] = None
    """Weighted fitness formula evaluated over EvaluationResult.metrics.
    Example: "0.7*recall+0.3*precision"
    Uses metric names as variable names; only identifiers, numbers, and
    basic arithmetic (+, -, *, /) are permitted.
    None = use metric_name as the scalar fitness value.
    """

    fbeta: Optional[float] = None
    """Beta for F-beta score (e.g. 2.0 → F2, recall-weighted).
    Only active when metric_name="fbeta". None = not applicable.
    """

    constraints: list[MetricConstraint] = Field(default_factory=list)
    """Hard constraint guards on secondary metrics.
    Any violated constraint pins fitness to 0.0 regardless of the formula.
    Typical use: precision floor to prevent recall-gaming.
    """

    custom_metrics: list[str] = Field(default_factory=list)
    """Names of additional metrics the evaluator will emit (informational).
    Must appear in EvaluationResult.metrics for constraint checks to function.
    """


# MetricRegistry is a dict keyed by metric_name
MetricRegistry = dict[str, MetricSpec]


# ────────────────────────────────────────────────────────────────────────────
# SotaSource (Pillar 4)
# ────────────────────────────────────────────────────────────────────────────


class SotaSource(BaseModel):
    model_config = ConfigDict(strict=True)

    source_id: str
    name: str
    url: Optional[str] = None
    retrieval_method: Literal["mcp_search", "web_fetch", "human_provided"]
    trust_level: Literal["authoritative", "indicative"]


# ────────────────────────────────────────────────────────────────────────────
# ExpansionPolicy (Pillar 4)
# ────────────────────────────────────────────────────────────────────────────


class MaxUpgradesPerNTicks(BaseModel):
    model_config = ConfigDict(strict=True)

    max_upgrades: int
    per_ticks: int


class ExpansionPolicy(BaseModel):
    model_config = ConfigDict(strict=True)

    auto_add_within_families: list[str]
    require_consent_for: list[str]
    sota_sources: list[SotaSource]
    max_angles_per_upgrade: int
    max_upgrades_per_N_ticks: MaxUpgradesPerNTicks
    """at most max_upgrades BenchmarkUpgrades per per_ticks ticks"""
    pretraining_canary_threshold_pp: float
    """ABSOLUTE pp residual threshold; default 5.0 (R-9)"""


# ────────────────────────────────────────────────────────────────────────────
# GoalContract
# ────────────────────────────────────────────────────────────────────────────


class LegacyMetric(BaseModel):
    model_config = ConfigDict(strict=True)

    name: str
    direction: Literal["higher", "lower"]
    primary: bool


class StopCondition(BaseModel):
    model_config = ConfigDict(strict=True)

    type: Literal[
        "beat-baseline",
        "beat-sota",
        "target",
        "maximize-under-budget",
        "evolve-n",
        "evolve-until-plateau",
        "evolve-until-regression",
        "worst-angle-plateau",
        "coverage-target",
    ]
    n: Optional[int] = None


class Budget(BaseModel):
    model_config = ConfigDict(strict=True)

    max_iterations: int
    plateau_window: int
    circuit_breaker: int
    max_cost_usd: float
    max_wall_clock_hours: Optional[float] = None
    max_gpu_hours: Optional[float] = None


class EvolutionBounds(BaseModel):
    """How far escalate-mode may adapt the otherwise-locked GoalContract.

    Escalation is MONOTONIC — it may only make the objective harder or more
    honest, never easier. Softening is structurally impossible; comparability
    changes need consent; the anti-cheat core (primary metric, split/eval hash)
    is frozen. ``None`` on a contract = fully frozen (no auto-adaptation).
    """

    model_config = ConfigDict(strict=True)

    benchmark_may_harden: bool = True
    """auto: add harder eval domains / worst-case slices (can only lower scores)."""
    metrics_may_add_tracked: bool = True
    """auto: add secondary *tracked* metrics (never replace the primary)."""
    budget_ceiling_extensions: int = 0
    """auto: number of times budget may be extended within a pre-set ceiling."""
    primary_metric_frozen: bool = True
    """the primary metric definition + comparability basis never auto-change."""
    comparability_change_requires_consent: bool = True
    """any change to what the primary number MEANS is gated on human consent."""


class AutonomyCharter(BaseModel):
    """Principle-based FULL autonomy: after setup, the mission runs to the goal with
    ZERO human-in-the-loop. Every mid-run decision is auto-resolved by the
    Monotonic-Honesty Invariant — it must move the evaluation toward *harder / more
    honest*, never *easier / score-inflating*. A monotonic move always exists, so the
    run never halts for a human; a forbidden-direction action is routed around, not
    asked about. Setup is the sole HITL. ``None`` on a contract = legacy consent-gated
    behavior (may ask mid-run).
    """

    model_config = ConfigDict(strict=True)

    posture: Literal["aggressive-never-halt"] = "aggressive-never-halt"
    """The only posture: never stop for a human; always take the monotonic move."""
    invariant: str = (
        "Every autonomous decision MUST be monotonic: it may make the evaluation harder "
        "or more honest, never easier or comparability-shifting. Forbidden directions "
        "(softening the metric, shifting comparability to inflate a score, leaking test "
        "into train) are routed around — never executed, never halted on."
    )
    license_gate: bool = False
    """False = research mode: acquire data from any source (GitHub/HF/web/authors) freely."""
    data_acquisition_enabled: bool = True
    """Agents may enrich train + harden test by acquiring external data (always de-duped)."""
    always_on_checks: list[str] = ["no-test-leakage", "comparability-eval-version"]
    """The two checks that ARE the invariant — enforced automatically, never HITL, never bypassed."""


class GoalContract(BaseModel):
    model_config = ConfigDict(strict=True)

    mission_id: str
    mode: Literal["seed-repo", "from-scratch"]
    mission_type: Literal["fixed", "open_ended"]
    task_description: str
    dataset_ref: str
    metrics: list[LegacyMetric]
    """legacy flat metrics; retained for back-compat reading"""
    metric_specs: list[MetricSpec]
    fitness_mode: Literal["aggregate", "worst-domain", "weighted"]
    eval_version: str
    baseline_value: float
    target_value: Optional[float] = None
    coverage_target: Optional[float] = None
    """open_ended stop: fraction of angles >= SOTA (0.0-1.0)"""
    stop_condition: StopCondition
    wildness: float
    budget: Budget
    framework: Optional[str] = None
    seed_repo_path: Optional[str] = None
    locked_split_hash: str
    eval_script_hash: str
    expansion_policy: Optional[ExpansionPolicy] = None
    allowed_licenses: list[str]
    """allowlist for data-acquisition provenance (R-3)"""
    evolution_bounds: Optional[EvolutionBounds] = None
    """escalate-mode bounds; None = fully frozen (no auto-adaptation)."""
    autonomy_charter: Optional[AutonomyCharter] = None
    """full-autonomy charter; None = legacy consent-gated (may ask mid-run)."""
    created_at: str


# ────────────────────────────────────────────────────────────────────────────
# Hypothesis
# ────────────────────────────────────────────────────────────────────────────


class Hypothesis(BaseModel):
    model_config = ConfigDict(strict=True)

    id: str
    statement: str
    prediction: str
    confirmed: Optional[bool] = None
    evidence: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────────
# MutationLocus (Pillar 1) — discriminated union via field
# ────────────────────────────────────────────────────────────────────────────


class MutationLocusArch(BaseModel):
    model_config = ConfigDict(strict=True)
    family: Literal["arch"]
    path: Literal["model/"]


class MutationLocusTraining(BaseModel):
    model_config = ConfigDict(strict=True)
    family: Literal["training"]
    path: Literal["train/"]


class MutationLocusDataCuration(BaseModel):
    model_config = ConfigDict(strict=True)
    family: Literal["data-curation"]
    path: Literal["data/builder"]


class MutationLocusDataAugmentation(BaseModel):
    model_config = ConfigDict(strict=True)
    family: Literal["data-augmentation"]
    path: Literal["data/aug"]


class MutationLocusDataAcquisition(BaseModel):
    model_config = ConfigDict(strict=True)
    family: Literal["data-acquisition"]
    path: Literal["data/acquisition"]
    acquisition_type: Literal["external", "synthetic"]


class MutationLocusAlgo(BaseModel):
    model_config = ConfigDict(strict=True)
    family: Literal["algo"]
    path: str
    genome_extension: str


MutationLocus = Union[
    MutationLocusArch,
    MutationLocusTraining,
    MutationLocusDataCuration,
    MutationLocusDataAugmentation,
    MutationLocusDataAcquisition,
    MutationLocusAlgo,
]


# ────────────────────────────────────────────────────────────────────────────
# TreeNode
# ────────────────────────────────────────────────────────────────────────────


class TreeNode(BaseModel):
    model_config = ConfigDict(strict=True)

    id: str
    parent_ids: list[str]
    approach_family: ApproachFamily
    hypothesis_id: str
    code_ref: str
    parent_patch_ref: Optional[str] = None
    genome_ref: str
    mutation_tier: Optional[Literal["parametric", "structural"]] = None
    mutation_locus: Optional[MutationLocus] = None
    data_version_ref: str
    config: dict[str, Any]
    weights_ref: Optional[str] = None
    metrics: dict[str, float]
    eval_version: str
    fitness_value: Optional[float] = None
    telemetry_ref: Optional[str] = None
    lesson_ids: list[str]
    citations: list[str]
    integrity_status: Literal["pending", "passed", "failed"]
    status: Literal["pending", "running", "done", "pruned"]
    is_crossover: bool
    ucb1_score: Optional[float] = None
    visit_count: int
    depth: int
    created_at: str
    completed_at: Optional[str] = None

    @field_validator("approach_family", mode="before")
    @classmethod
    def normalise_approach_family(cls, v: str) -> str:
        return _alias_approach_family(v)


# ────────────────────────────────────────────────────────────────────────────
# MutationProposal
# ────────────────────────────────────────────────────────────────────────────


class CriticReview(BaseModel):
    model_config = ConfigDict(strict=True)

    h001_one_hypothesis: Literal["pass", "fail"]
    h002_family_streak: Literal["pass", "fail"]
    h003_intra_tick_diversity: Literal["pass", "fail"]
    integrity_risk: Literal["pass", "fail"]
    instrumentation_check: Literal["pass", "fail"]
    schema_valid: Literal["pass", "fail"]
    verdict: Literal["approved", "rejected"]
    rejection_reason: Optional[str] = None


class MutationProposal(BaseModel):
    model_config = ConfigDict(strict=True)

    proposal_id: str
    parent_node_ids: list[str]
    approach_family: ApproachFamily
    idea: str
    hypothesis: Hypothesis
    citations: list[str]
    wildness: float
    critic_approved: bool
    critic_review: CriticReview

    @field_validator("approach_family", mode="before")
    @classmethod
    def normalise_approach_family(cls, v: str) -> str:
        return _alias_approach_family(v)


# ────────────────────────────────────────────────────────────────────────────
# EvaluationResult
# ────────────────────────────────────────────────────────────────────────────


class TelemetrySummary(BaseModel):
    model_config = ConfigDict(strict=True)

    final_train_loss: Optional[float] = None
    best_val_metric: Optional[float] = None
    grad_norm_median: Optional[float] = None
    throughput_samples_per_sec: Optional[float] = None
    total_steps: int
    val_series: Optional[list[float]] = None
    """Per-step validation metric values emitted by the trainer.
    Required for per-step spike detection in IntegrityGate._check_reward_hacking.
    Eval scripts should emit this under telemetry_summary.val_series."""


class AngleVsSOTAInline(BaseModel):
    """Inline per-angle result embedded in EvaluationResult.per_angle_vs_sota."""
    model_config = ConfigDict(strict=True)

    value: float
    sota_bar: float
    above_sota: bool


class EvaluationResult(BaseModel):
    model_config = ConfigDict(strict=True)

    node_id: str
    run_id: str
    eval_version: str
    metrics: dict[str, float]
    per_domain: dict[str, dict[str, float]]
    fitness_value: float
    worst_angle_coverage: Optional[float] = None
    per_angle_vs_sota: Optional[dict[str, AngleVsSOTAInline]] = None
    telemetry_summary: TelemetrySummary
    status: Literal["success", "regression", "error", "timeout", "oom"]
    benchmark_raw: str
    timestamp: str


# ────────────────────────────────────────────────────────────────────────────
# IntegrityReport
# ────────────────────────────────────────────────────────────────────────────


class IntegrityChecks(BaseModel):
    model_config = ConfigDict(strict=True)

    split_hash_match: bool
    frozen_split_read_only: bool
    no_test_leakage: bool
    near_dup_leakage: bool
    data_provenance_valid: bool
    no_label_contamination: bool
    no_eval_shift: bool
    eval_version_consistent: bool
    telemetry_sane: bool
    reward_hacking_probe: bool
    acquisition_contamination_clear: Optional[bool] = None
    acquired_data_provenance_valid: Optional[bool] = None
    acquisition_namespace_enforced: Optional[bool] = None
    structure_ok: Optional[bool] = None
    """ForgeStructureGate passed: genome seams + forward pass + telemetry + eval lock.
    None = gate not run (candidate_dir not provided to IntegrityGate.check())."""


class IntegrityReport(BaseModel):
    model_config = ConfigDict(strict=True)

    node_id: str
    eval_version: str
    checks: IntegrityChecks
    verdict: Literal["passed", "failed"]
    failure_reason: Optional[str] = None
    verified_at: str


# ────────────────────────────────────────────────────────────────────────────
# TelemetryRecord
# ────────────────────────────────────────────────────────────────────────────


class TelemetryRecord(BaseModel):
    model_config = ConfigDict(strict=True)

    step: int
    epoch: Optional[float] = None
    train_loss: Optional[float] = None
    val_metric: Optional[float] = None
    lr: Optional[float] = None
    grad_norm: Optional[float] = None
    param_norm: Optional[float] = None
    update_ratio: Optional[float] = None
    throughput: Optional[float] = None
    gpu_util: Optional[float] = None
    mem_used_gb: Optional[float] = None
    mem_total_gb: Optional[float] = None
    node_id: str
    run_id: str
    timestamp: str


# ────────────────────────────────────────────────────────────────────────────
# LessonEntry
# ────────────────────────────────────────────────────────────────────────────


class LessonEntry(BaseModel):
    model_config = ConfigDict(strict=True)

    lesson_id: str
    node_id: str
    run_id: str
    mission_id: str
    approach_family: ApproachFamily
    hypothesis_verdict: Literal["confirmed", "refuted", "inconclusive"]
    observation: str
    root_cause: Optional[str] = None
    actionable_lesson: str
    citations: list[str]
    telemetry_evidence: Optional[str] = None
    tags: list[str]
    created_at: str

    @field_validator("approach_family", mode="before")
    @classmethod
    def normalise_approach_family(cls, v: str) -> str:
        return _alias_approach_family(v)


# ────────────────────────────────────────────────────────────────────────────
# StrategyState
# ────────────────────────────────────────────────────────────────────────────


class StrategyState(BaseModel):
    model_config = ConfigDict(strict=True)

    meta_iteration: int
    selection_policy: Literal["ucb1", "mcts", "beam"]
    ucb1_c: float
    beam_width: Optional[int] = None
    wildness: float
    family_mix: dict[str, float]
    winning_families: list[str]
    wins_by_family: dict[str, int]
    meta_loop_interval: int
    post_upgrade_exploration_boost: Optional[float] = None
    """null = no boost active"""
    post_upgrade_exploration_ticks: int
    """ticks remaining for boost; default max(5, frontier_size*2) capped at 15"""
    rescore_mode: Literal["sync", "async"]
    """SINGLE source of truth for BenchmarkUpgrade re-score mode (Q1)"""
    updated_at: str


# ────────────────────────────────────────────────────────────────────────────
# ResourcePlan
# ────────────────────────────────────────────────────────────────────────────


class ResourcePlan(BaseModel):
    model_config = ConfigDict(strict=True)

    concurrency: int
    gpu_ids: list[int]
    cpu_fallback: bool
    throughput_samples_per_sec: float
    vram_per_job_gb: float
    util_target: float
    last_probed_at: str


# ────────────────────────────────────────────────────────────────────────────
# DecisionLogEntry
# ────────────────────────────────────────────────────────────────────────────


class DecisionLogEntry(BaseModel):
    model_config = ConfigDict(strict=True)

    timestamp: str
    tick: int
    decision_type: Literal[
        "select",
        "propose",
        "critique",
        "implement",
        "evaluate",
        "analyze",
        "record",
        "prune",
        "stop",
        "meta-evolve",
    ]
    rationale: str
    node_ids: list[str]
    strategy_delta: Optional[dict[str, Any]] = None


# ────────────────────────────────────────────────────────────────────────────
# GenomeConfig (Pillar 1)
# ────────────────────────────────────────────────────────────────────────────


class GenomeConfig(BaseModel):
    model_config = ConfigDict(strict=True)

    genome_version: str
    model_family: Optional[str] = None
    """Architecture family for ForgeStructureGate seam check: cnn, embedding, graph, vlm.
    None = universal-only invariants (no family-specific seam files required)."""
    backbone: Optional[str] = None
    head: Optional[str] = None
    neck: Optional[str] = None
    optimizer: str
    lr: float
    lr_schedule: str
    batch_size: int
    epochs: int
    loss: str
    aug_set: list[str]
    acquired_datasets: list[str]
    """acquisition_ids from AcquisitionProvenance; [] = no external/synthetic data"""
    regularization: dict[str, Any]
    schema_extensions: list[str]
    """names of structurally-added keys; empty for gen-1 root"""
    extra: dict[str, Any]


# ────────────────────────────────────────────────────────────────────────────
# AcquisitionProvenance (data-acquisition)
# ────────────────────────────────────────────────────────────────────────────


class AcquisitionProvenance(BaseModel):
    model_config = ConfigDict(strict=True)

    acquisition_id: str
    acquisition_type: Literal["external", "synthetic"]
    source_name: Optional[str] = None
    source_url: Optional[str] = None
    license_identifier: str
    """SPDX identifier e.g. 'CC-BY-4.0', 'MIT', 'proprietary-restricted' (R-3)"""
    license_in_allowlist: bool
    """true iff license_identifier is in GoalContract.allowed_licenses (R-3)"""
    citation: str
    generator_config: Optional[dict[str, Any]] = None
    sample_count: int
    acquired_at: str
    ingestion_contamination_cleared: bool


# ────────────────────────────────────────────────────────────────────────────
# FrozenSplit (Pillar 2)
# ────────────────────────────────────────────────────────────────────────────


class FrozenSplit(BaseModel):
    model_config = ConfigDict(strict=True)

    split_id: str
    mission_id: str
    split_type: Literal["test", "val"]
    split_hash: str
    per_sample_hashes: dict[str, str]
    item_count: int
    frozen_at: str
    storage_path: str
    eval_version: str


# ────────────────────────────────────────────────────────────────────────────
# DataProvenance (Pillar 2)
# ────────────────────────────────────────────────────────────────────────────


class DataProvenance(BaseModel):
    model_config = ConfigDict(strict=True)

    sample_id: str
    source_sample_id: str
    split_type: Literal["train"]
    """DataProvenance only exists for train samples"""
    transform_applied: list[str]
    is_synthetic: bool
    verified_not_in_test: bool


# ────────────────────────────────────────────────────────────────────────────
# Domain (Pillar 3)
# ────────────────────────────────────────────────────────────────────────────


class Domain(BaseModel):
    model_config = ConfigDict(strict=True)

    domain_id: str
    description: str
    metric_specs: list[MetricSpec]
    sota_source: Optional[SotaSource] = None
    added_at_eval_version: str


# ────────────────────────────────────────────────────────────────────────────
# EvalSuite / EvalVersion (Pillar 3)
# ────────────────────────────────────────────────────────────────────────────


class EvalSuite(BaseModel):
    model_config = ConfigDict(strict=True)

    eval_version: str
    mission_id: str
    parent_eval_version: Optional[str] = None
    domains: list[Domain]
    split_hashes: dict[str, str]
    """{ domain_id: sha256 } — each domain's frozen held-out split"""
    created_at: str
    created_by: Literal["user", "policy"]
    consent_log_ref: str


# EvalVersion is the same schema as EvalSuite
EvalVersion = EvalSuite


# ────────────────────────────────────────────────────────────────────────────
# BenchmarkUpgrade (Pillar 3 + 4)
# ────────────────────────────────────────────────────────────────────────────


class BenchmarkUpgrade(BaseModel):
    model_config = ConfigDict(strict=True)

    upgrade_id: str
    mission_id: str
    from_eval_version: str
    to_eval_version: str
    proposed_by: Literal["user", "probe", "sage", "policy"]
    proposal_citations: list[str]
    consent_granted: bool
    consent_at: Optional[str] = None
    new_domains_added: list[str]
    domains_removed: list[str]
    """DEFENSIVE INVARIANT: MUST always be empty (Q4)"""
    rescore_status: Literal["pending", "in_progress", "complete", "partial"]
    rescore_deadline_ticks: int
    """tick count after which not-yet-rescored nodes are demoted to v{old}-only (R-2)"""
    decision_log_ref: str
    created_at: str


# ────────────────────────────────────────────────────────────────────────────
# BenchmarkUpgradeProposal
# ────────────────────────────────────────────────────────────────────────────


class BenchmarkUpgradeProposal(BaseModel):
    model_config = ConfigDict(strict=True)

    proposed_by: Literal["probe", "sage"]
    new_domains: list[str]
    rationale: str
    citations: list[str]


# ────────────────────────────────────────────────────────────────────────────
# AngleRegistry (Pillar 4)
# ────────────────────────────────────────────────────────────────────────────


class AngleEntry(BaseModel):
    model_config = ConfigDict(strict=True)

    angle_id: str
    eval_version_added: str
    sota_bar: float
    sota_source_ids: list[str]
    """>=2 required for authoritative trust_level (R-1)"""
    sota_quorum_met: bool
    """true iff >=2 distinct sources with divergence <=5% (R-1)"""
    baseline_model_score_before_finetune: Optional[float] = None
    """seed/foundation model score before any fine-tuning; null until evaluated"""
    sota_retrieved_at: str
    held_out_split_hash: str
    is_public_benchmark: bool
    pretraining_contamination_risk: Literal["low", "medium", "high", "unknown"]


class AngleRegistry(BaseModel):
    model_config = ConfigDict(strict=True)

    mission_id: str
    angles: list[AngleEntry]
    updated_at: str


# ────────────────────────────────────────────────────────────────────────────
# CoverageTarget (Pillar 4)
# ────────────────────────────────────────────────────────────────────────────


class CoverageTarget(BaseModel):
    model_config = ConfigDict(strict=True)

    target_fraction: float
    current_worst_angle_id: Optional[str] = None
    current_coverage: float


# ────────────────────────────────────────────────────────────────────────────
# BenchmarkRescore (consensus pass 2, R-6)
# ────────────────────────────────────────────────────────────────────────────


class BenchmarkRescore(BaseModel):
    model_config = ConfigDict(strict=True)

    upgrade_id: str
    node_id: str
    cached_per_domain: dict[str, dict[str, float]]
    """v_old per_domain scores, carried forward"""
    new_domains: list[str]
    merged_eval_version: str


# ────────────────────────────────────────────────────────────────────────────
# AngleVsSOTA (consensus pass 2, R-11)
# ────────────────────────────────────────────────────────────────────────────


class AngleVsSOTA(BaseModel):
    model_config = ConfigDict(strict=True)

    angle_id: str
    value: float
    sota_bar: float
    """effective bar = max(sota_bar, baseline_model_score_before_finetune) (R-9)"""
    above_sota: bool
    """value >= sota_bar (only counts if trust_level='authoritative')"""
    trust_level: Literal["authoritative", "indicative"]


# ────────────────────────────────────────────────────────────────────────────
# GenomeSeedAdapterReport (Q2 — Pillar 1 seed-repo reproducibility artifact)
# ────────────────────────────────────────────────────────────────────────────


class DetectedSeam(BaseModel):
    model_config = ConfigDict(strict=True)

    kind: Literal["model_def", "training_loop", "data_pipeline"]
    file: str
    symbol: str


class GenomeSeedAdapterReport(BaseModel):
    model_config = ConfigDict(strict=True)

    seed_repo_path: str
    detected_seams: list[DetectedSeam]
    genome_mapping: dict[str, str]
    """genome.yaml gene -> seed-repo symbol it maps to"""
    unmapped_regions: list[str]
    """seed-repo files/symbols with no genome counterpart"""
    created_at: str


# ────────────────────────────────────────────────────────────────────────────
# GotchaEntry + CapabilityProfile (Gotcha knowledge layer)
# ────────────────────────────────────────────────────────────────────────────


class GotchaEntry(BaseModel):
    """A single recorded failure/constraint that future agents should avoid.

    Stored under .evor/wiki/gotchas/ (global scope) or per run-dir (mission
    scope) so they survive across missions on the same machine.

    ``signature`` is the dedup key \u2014 e.g. ``"cuda-oom"``, ``"flash-attn-v3-sm90"``.
    Duplicate add() calls with the same (signature, scope) increment
    ``occurrences``, bump ``last_seen``, and raise ``confidence`` toward 1.0.
    """

    model_config = ConfigDict(strict=True)

    gotcha_id: str
    """Unique ID \u2014 typically ``<kind>-<signature>-<hash>``."""
    kind: Literal["runtime-failure", "hardware-constraint", "approach-deadend"]
    """Broad category of gotcha."""
    signature: str
    """Dedup key used to detect repeat occurrences (e.g. 'cuda-oom', 'nan-loss-lr')."""
    context: dict[str, Any]
    """Free-form context: gpu_arch, vram_gb, task, batch, mutation_family, etc."""
    resolution: str
    """What was done to recover (e.g. 'batch 256->128 + grad-accum')."""
    avoidance: str
    """Actionable advice for future agents to AVOID this gotcha."""
    scope: Literal["mission", "global"]
    """'global' gotchas persist cross-mission; 'mission' are run-scoped."""
    confidence: float
    """0.0\u20131.0; raised toward 1.0 on each repeated occurrence."""
    occurrences: int
    """How many times this gotcha has been recorded."""
    first_seen: str
    """ISO 8601 timestamp of first occurrence."""
    last_seen: str
    """ISO 8601 timestamp of most recent occurrence."""


# Signal facet vocabularies — the ONLY closed sets in the signal system.
# Signal `kind` stays free-text/open; facets are how lenses subscribe.
SignalShape = Literal["limit", "opportunity", "failure", "trend"]
SignalAxis = Literal[
    "memory", "compute", "accuracy", "stability", "data", "generalization", "cost"
]
SignalSeverity = Literal["low", "medium", "high", "critical"]


class Signal(BaseModel):
    """A neutral, self-describing observation on the run's signal bus.

    Producers emit signals; consumers read them through their own lens (see each
    agent's <Signal_Lens>). The bus lives at ``<run_dir>/signals.jsonl``.

    ``kind`` is free-text and open-ended (e.g. 'cuda-oom', 'training-too-slow',
    'class-confusion', 'eval-saturated') so new signal types need no code change.
    ``shapes``/``axes`` are the closed facet vocabularies lenses subscribe to.
    ``signature`` is the dedup key: repeat emits increment ``occurrences``,
    bump ``last_seen``, and raise ``confidence`` (mirrors GotchaEntry) — this is
    the storm/dedup + oscillation damper (recurrence x confidence).
    """

    model_config = ConfigDict(strict=True)

    signal_id: str
    kind: str
    """Free-text signal type — open-ended by design."""
    signature: str
    """Dedup key (e.g. 'cuda-oom-bs256', 'slow-train-cand'); repeats aggregate."""
    shapes: list[SignalShape]
    """Closed facet set: limit | opportunity | failure | trend (>=1)."""
    axes: list[SignalAxis]
    """Closed facet set: memory | compute | accuracy | stability | data | generalization | cost."""
    severity: SignalSeverity
    """low | medium | high | critical — gates whether it reaches a spawn digest."""
    evidence: dict[str, Any]
    """Structured evidence (metric values, config, telemetry excerpt, node_id, etc.)."""
    source: str
    """Emitting role (e.g. 'evor-forge-analyst', 'evor-probe', 'self-heal-monitor')."""
    tick: Optional[int] = None
    node_id: Optional[str] = None
    confidence: float = 0.5
    """0.0-1.0; raised toward 1.0 on repeat (recurrence damper)."""
    occurrences: int = 1
    first_seen: str
    last_seen: str


class CapabilityProfile(BaseModel):
    """Hardware capability profile probed at preflight time.

    Written to ``.evor/capability.json`` (global) so all agents can read it.
    When no GPU is available, ``cpu_only=True`` and GPU fields are None.
    """

    model_config = ConfigDict(strict=True)

    gpu_arch: Optional[str] = None
    """CUDA capability string, e.g. 'sm_80', 'sm_90'. None on CPU-only box."""
    gpu_name: Optional[str] = None
    """GPU device name, e.g. 'NVIDIA A100 80GB PCIe'."""
    vram_gb: Optional[float] = None
    """Total VRAM in GB. None on CPU-only box."""
    supported_dtypes: list[str]
    """Confirmed supported dtypes, e.g. ['fp32', 'fp16', 'bf16']."""
    available_libs: list[str]
    """Confirmed importable GPU-acceleration libs, e.g. ['flash-attn', 'xformers']."""
    cuda_version: Optional[str] = None
    """CUDA runtime version string, e.g. '12.1'. None if CUDA unavailable."""
    cpu_only: bool
    """True when no CUDA GPU was detected. Agents must downgrade or skip GPU ops."""
    probed_at: str
    """ISO 8601 timestamp of when this profile was last probed."""



# ────────────────────────────────────────────────────────────────────────────
# Schema registry (all models, for validation tooling / test iteration)
# ────────────────────────────────────────────────────────────────────────────

ALL_MODELS: dict[str, type[BaseModel]] = {
    # Base 11 (+ Hypothesis)
    "GoalContract": GoalContract,
    "TreeNode": TreeNode,
    "Hypothesis": Hypothesis,
    "MutationProposal": MutationProposal,
    "EvaluationResult": EvaluationResult,
    "IntegrityReport": IntegrityReport,
    "TelemetryRecord": TelemetryRecord,
    "LessonEntry": LessonEntry,
    "StrategyState": StrategyState,
    "ResourcePlan": ResourcePlan,
    "DecisionLogEntry": DecisionLogEntry,
    # Addendum v2
    "GenomeConfig": GenomeConfig,
    "MutationLocusArch": MutationLocusArch,
    "MutationLocusTraining": MutationLocusTraining,
    "MutationLocusDataCuration": MutationLocusDataCuration,
    "MutationLocusDataAugmentation": MutationLocusDataAugmentation,
    "MutationLocusDataAcquisition": MutationLocusDataAcquisition,
    "MutationLocusAlgo": MutationLocusAlgo,
    "AcquisitionProvenance": AcquisitionProvenance,
    "FrozenSplit": FrozenSplit,
    "DataProvenance": DataProvenance,
    "EvalSuite": EvalSuite,
    "Domain": Domain,
    "MetricSpec": MetricSpec,
    "BenchmarkUpgrade": BenchmarkUpgrade,
    "BenchmarkUpgradeProposal": BenchmarkUpgradeProposal,
    "ExpansionPolicy": ExpansionPolicy,
    "SotaSource": SotaSource,
    "AngleRegistry": AngleRegistry,
    "CoverageTarget": CoverageTarget,
    # Consensus pass 2
    "BenchmarkRescore": BenchmarkRescore,
    "AngleVsSOTA": AngleVsSOTA,
    # Q2
    "GenomeSeedAdapterReport": GenomeSeedAdapterReport,
    # Gotcha knowledge layer
    "GotchaEntry": GotchaEntry,
    "CapabilityProfile": CapabilityProfile,
}
