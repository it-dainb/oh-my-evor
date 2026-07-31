"""
oh-my-evor data contracts — Pydantic v2 strict models.

All 27+ schemas mirroring mcp/src/contracts.ts exactly.
Field names match the TypeScript interfaces; model_config = ConfigDict(strict=True, exclude_none=True) on all.

ApproachFamily: 7-tag literal taxonomy per R-12.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, model_validator

# ────────────────────────────────────────────────────────────────────────────
# Shared type aliases
# ────────────────────────────────────────────────────────────────────────────

# 7-tag ApproachFamily taxonomy (R-12)
ApproachFamily = Literal[
    "arch",
    "training",
    "data-curation",
    "data-augmentation",
    "data-acquisition",
    "algo",
    "other",
]


# ────────────────────────────────────────────────────────────────────────────
# Base model — exclude_none=True by default on all serialisation calls (P0-6)
# ────────────────────────────────────────────────────────────────────────────


class BaseEvorModel(BaseModel):
    """Shared base for all evor contracts.

    Overrides model_dump / model_dump_json so that optional fields whose value
    is None are omitted from serialised output by default.  This keeps Pydantic
    output compatible with Zod schemas that use .optional() (not .nullish()),
    which reject explicit null values.

    The exclude_none default can still be overridden by passing
    ``model_dump(exclude_none=False)`` explicitly.
    """

    def model_dump(self, *, exclude_none: bool = True, **kwargs) -> dict:  # type: ignore[override]
        return super().model_dump(exclude_none=exclude_none, **kwargs)

    def model_dump_json(self, *, exclude_none: bool = True, **kwargs) -> str:  # type: ignore[override]
        return super().model_dump_json(exclude_none=exclude_none, **kwargs)


# ────────────────────────────────────────────────────────────────────────────
# MetricSpec / MetricRegistry (Pillar 3)
# ────────────────────────────────────────────────────────────────────────────


class MetricConstraint(BaseEvorModel):
    """Hard constraint on a secondary metric used as a gamability guard.

    A candidate violating ANY constraint on the primary MetricSpec receives
    penalized fitness = 0.0 regardless of its formula score. This prevents
    degenerate solutions such as predicting all-positive to maximize recall
    while ignoring precision.

    Example: ``{"metric": "precision", "op": ">=", "threshold": 0.5}``
    prevents recall-gaming when recall is the primary metric.
    """

    model_config = ConfigDict(strict=True, exclude_none=True)

    metric: str
    """Name of the metric to constrain (must appear in EvaluationResult.metrics)."""
    op: Literal[">=", "<=", "==", ">", "<"]
    """Comparison operator applied as: metric_value op threshold."""
    threshold: float
    """Threshold value for the constraint."""


class MetricSpec(BaseEvorModel):
    """Specification for a single tracked metric.

    Supports scalar, composite-weighted, F-beta, preference-with-constraint,
    and fully-custom metric modes:

    * Scalar:          metric_name="accuracy", no formula/fbeta/constraints
    * Composite:       fitness_formula="0.7*recall+0.3*precision"
    * F-beta:          metric_name="fbeta", fbeta=2.0  (F2 score)
    * Constrained:     fitness_formula + constraints guard degenerate solutions
    * Custom:          custom_metrics=["my_ndcg"] instructs the evaluator to emit it
    """

    model_config = ConfigDict(strict=True, exclude_none=True)

    metric_name: str
    direction: Literal["higher", "lower"]
    domain_applicability: Union[list[str], Literal["all"]]
    # Sensible default so a spec is never rejected for omitting it; macro_avg
    # weights every domain equally (override for weighted/min/max aggregation).
    aggregation_rule: Literal["macro_avg", "weighted_avg", "min", "max"] = "macro_avg"
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


class SotaSource(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    source_id: str
    name: str
    url: Optional[str] = None
    retrieval_method: Literal["mcp_search", "web_fetch", "human_provided"]
    trust_level: Literal["authoritative", "indicative"]


# ────────────────────────────────────────────────────────────────────────────
# ExpansionPolicy (Pillar 4)
# ────────────────────────────────────────────────────────────────────────────


class MaxUpgradesPerNTicks(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    max_upgrades: int
    per_ticks: int


class ExpansionPolicy(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    auto_add_within_families: list[str]
    require_consent_for: list[str]
    sota_sources: list[SotaSource]
    max_angles_per_upgrade: int
    max_upgrades_per_N_ticks: MaxUpgradesPerNTicks
    """at most max_upgrades BenchmarkUpgrades per per_ticks ticks"""
    pretraining_canary_threshold_pp: float
    """ABSOLUTE pp residual threshold; default 5.0 (R-9)"""


# ────────────────────────────────────────────────────────────────────────────
# P0-7: metric_scale inference helpers
# ────────────────────────────────────────────────────────────────────────────

# Metric-name substrings that imply a 0-100 reporting scale.
_METRIC_NAME_100_KEYWORDS: frozenset[str] = frozenset([
    # DIBCO document-binarization family
    "dibco", "f_measure", "f-measure", "pfm", "fps", "pseudo_fm",
    # Percent-expressed error rates
    "cer_percent", "wer_percent",
    # Percent-expressed accuracy / IoU
    "accuracy_percent", "acc_percent",
    "map_percent", "coco_map_percent", "iou_percent", "miou_percent",
])

# Dataset-ref substrings that imply a 0-100 reporting scale (e.g. DIBCO benchmarks).
_DATASET_REF_100_KEYWORDS: frozenset[str] = frozenset([
    "dibco", "binarization", "document_binarization",
])


def infer_metric_scale(metric_name: str, dataset_ref: str = "") -> float:
    """Infer the metric_scale divisor for a GoalContract.

    Returns 100.0 when *metric_name* or *dataset_ref* match a known 0-100
    reporting convention (DIBCO F-measure, CER%, accuracy-as-percent, etc.).
    Returns 1.0 for everything else (standard [0,1] metrics).

    This is a heuristic covering the most common cases; unusual metric naming
    or novel benchmarks should set ``metric_scale`` explicitly on GoalContract
    rather than relying on inference.

    Args:
        metric_name: Primary metric name (e.g. ``"f_measure"``, ``"accuracy"``).
        dataset_ref: Dataset reference string (e.g. ``"dibco2019"``).  Optional.

    Returns:
        100.0 if the metric is on a 0-100 scale, else 1.0.
    """
    lower_metric = (metric_name or "").lower()
    lower_dataset = (dataset_ref or "").lower()

    for kw in _METRIC_NAME_100_KEYWORDS:
        if kw in lower_metric:
            return 100.0

    for kw in _DATASET_REF_100_KEYWORDS:
        if kw in lower_dataset:
            return 100.0

    return 1.0


# ────────────────────────────────────────────────────────────────────────────
# GoalContract
# ────────────────────────────────────────────────────────────────────────────


class StopCondition(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class Budget(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    max_iterations: int
    plateau_window: int
    circuit_breaker: int
    max_cost_usd: float
    max_wall_clock_hours: Optional[float] = None
    max_gpu_hours: Optional[float] = None


class EvolutionBounds(BaseEvorModel):
    """How far escalate-mode may adapt the otherwise-locked GoalContract.

    Escalation is MONOTONIC — it may only make the objective harder or more
    honest, never easier. Softening is structurally impossible; comparability
    changes need consent; the anti-cheat core (primary metric, split/eval hash)
    is frozen. ``None`` on a contract = fully frozen (no auto-adaptation).
    """

    model_config = ConfigDict(strict=True, exclude_none=True)

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


class AutonomyCharter(BaseEvorModel):
    """Principle-based FULL autonomy: after setup, the mission runs to the goal with
    ZERO human-in-the-loop. Every mid-run decision is auto-resolved by the
    Monotonic-Honesty Invariant — it must move the evaluation toward *harder / more
    honest*, never *easier / score-inflating*. A monotonic move always exists, so the
    run never halts for a human; a forbidden-direction action is routed around, not
    asked about. Setup is the sole HITL.
    """

    model_config = ConfigDict(strict=True, exclude_none=True)

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


class GoalContract(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    mission_id: str
    mode: Literal["seed-repo", "from-scratch"]
    mission_type: Literal["fixed", "open_ended"]
    task_description: str
    dataset_ref: str
    metric_specs: list[MetricSpec]
    fitness_mode: Literal["aggregate", "worst-domain", "weighted"]
    # Defaults to the first eval suite version so setup never fails for omitting
    # it; the harness names frozen splits and eval suites "v1" by convention.
    eval_version: str = "v1"
    baseline_value: float
    target_value: Optional[float] = None
    coverage_target: Optional[float] = None
    """open_ended stop: fraction of angles >= SOTA (0.0-1.0)"""
    stop_condition: StopCondition
    wildness: float
    budget: Budget
    framework: Optional[str] = None
    seed_repo_path: Optional[str] = None
    # Server-owned: harness computes at freeze — agent must never supply.
    # Required in stored contract; optional at agent-facing input layer.
    locked_split_hash: Optional[str] = None
    eval_script_hash: Optional[str] = None
    expansion_policy: Optional[ExpansionPolicy] = None
    allowed_licenses: list[str]
    """allowlist for data-acquisition provenance (R-3)"""
    evolution_bounds: Optional[EvolutionBounds] = None
    """escalate-mode bounds; None = fully frozen (no auto-adaptation)."""
    autonomy_charter: AutonomyCharter = Field(default_factory=AutonomyCharter)
    """full-autonomy charter; always present — charter is mandatory for all missions."""
    # Server-owned: filled via now() at creation time.
    created_at: Optional[str] = None

    # ── P0-7: metric scale ────────────────────────────────────────────────────
    metric_scale: float = 1.0
    """Divisor to normalise reported scores to [0,1] before integrity ceiling checks.
    Default 1.0 = scores already in [0,1] (accuracy, F1, …).
    Set to 100.0 for metrics reported on a 0-100 scale (DIBCO, COCO mAP %, …).
    reward_hacking_probe divides candidate_val by metric_scale before the ≥0.98 check.
    """

    # ── P0-2: contract seal ───────────────────────────────────────────────────
    contract_seal: Optional[str] = None
    """sha256 hex digest of the contract's own content (excluding this field).
    Set by seal_contract(); verified by verify_contract_seal().
    Absent (None) on legacy contracts → backward-compat pass with a warning.
    """

    # ── P0-7: auto-infer metric_scale when not explicitly provided ────────────
    @model_validator(mode="before")
    @classmethod
    def _auto_infer_metric_scale(cls, data: object) -> object:
        """Fill metric_scale from infer_metric_scale() when caller omits it.

        Runs only when ``metric_scale`` is absent from the input dict.
        Explicit user values (including 1.0) are always preserved as-is.
        """
        if not isinstance(data, dict) or "metric_scale" in data:
            return data
        metric_specs = data.get("metric_specs", [])
        dataset_ref = str(data.get("dataset_ref", ""))
        primary_name = ""
        if metric_specs:
            first = metric_specs[0]
            if isinstance(first, dict):
                primary_name = str(first.get("metric_name", ""))
            elif hasattr(first, "metric_name"):
                primary_name = str(first.metric_name)
        data["metric_scale"] = infer_metric_scale(primary_name, dataset_ref)
        return data


# ── P0-2: seal helpers ────────────────────────────────────────────────────────


def seal_contract(contract: "GoalContract") -> "GoalContract":
    """Return a copy of *contract* with contract_seal set to the sha256 of its content.

    The seal is computed over model_dump(exclude={'contract_seal'}) serialised
    with sorted keys so it is deterministic regardless of field insertion order.
    """
    payload = contract.model_dump(exclude={"contract_seal"})
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()
    return contract.model_copy(update={"contract_seal": digest})


def verify_contract_seal(contract: "GoalContract") -> bool:
    """Return True if the contract seal is valid or absent (backward compat).

    * Seal absent (None) → True with a warning (legacy contracts pre-P0-2).
    * Seal present → recompute and compare; return True only on match.
    """
    if contract.contract_seal is None:
        import warnings
        warnings.warn(
            f"GoalContract {contract.mission_id!r} has no contract_seal — "
            "consider sealing with seal_contract() to detect post-lock mutations.",
            stacklevel=2,
        )
        return True
    payload = contract.model_dump(exclude={"contract_seal"})
    expected = hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()
    return expected == contract.contract_seal


def _compute_seal(contract: "GoalContract") -> str:
    """Recompute the expected seal digest for *contract* (internal helper)."""
    payload = contract.model_dump(exclude={"contract_seal"})
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()


def is_contract_authentic(contract: "GoalContract") -> bool:
    """Return True only when the seal is present AND matches the contract content.

    Unlike :func:`verify_contract_seal`, this never silently accepts an unsigned
    contract:

    * Seal absent (None) → **False** (unsigned = not authentic).
    * Seal present but tampered → **False**.
    * Seal present and matching → **True**.

    Use this instead of ``verify_contract_seal`` for locked/production contracts
    where the absence of a seal is itself a security failure.
    """
    if contract.contract_seal is None:
        return False
    return _compute_seal(contract) == contract.contract_seal


def verify_contract_seal_strict(contract: "GoalContract") -> bool:
    """Strict alias for :func:`is_contract_authentic`.

    Returns False for unsigned contracts (seal=None) rather than True+warn.
    Intended for locked contracts in production paths where a missing seal
    must be treated as a verification failure, not a backward-compat pass.
    """
    return is_contract_authentic(contract)


# ────────────────────────────────────────────────────────────────────────────
# Hypothesis
# ────────────────────────────────────────────────────────────────────────────


class Hypothesis(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    id: str
    statement: str
    prediction: str
    confirmed: Optional[bool] = None
    evidence: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────────
# MutationLocus (Pillar 1) — discriminated union via field
# ────────────────────────────────────────────────────────────────────────────


class MutationLocusArch(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)
    family: Literal["arch"]
    path: Literal["model/"]


class MutationLocusTraining(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)
    family: Literal["training"]
    path: Literal["train/"]


class MutationLocusDataCuration(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)
    family: Literal["data-curation"]
    path: Literal["data/builder"]


class MutationLocusDataAugmentation(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)
    family: Literal["data-augmentation"]
    path: Literal["data/aug"]


class MutationLocusDataAcquisition(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)
    family: Literal["data-acquisition"]
    path: Literal["data/acquisition"]
    acquisition_type: Literal["external", "synthetic"]


class MutationLocusAlgo(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)
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


class TreeNode(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    id: str
    name: Optional[str] = None
    """Human-readable node slug the agent coined (P2-1). Node tools accept it in
    place of the UUID. Optional for back-compat with pre-slug tree.json entries."""
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
    # Server-owned bookkeeping — optional at agent-facing input; server fills defaults.
    lesson_ids: list[str] = Field(default_factory=list)
    citations: list[str] = Field(default_factory=list)
    integrity_status: Literal["pending", "passed", "failed"] = "pending"
    status: Literal["pending", "running", "done", "pruned"] = "pending"
    is_crossover: bool = False
    ucb1_score: Optional[float] = None
    visit_count: int = 0
    depth: int = 0
    created_at: Optional[str] = None
    completed_at: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────────
# MutationProposal
# ────────────────────────────────────────────────────────────────────────────


class CriticReview(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    h001_one_hypothesis: Literal["pass", "fail"]
    h002_family_streak: Literal["pass", "fail"]
    h003_intra_tick_diversity: Literal["pass", "fail"]
    # Optional: not populated by evor_validate_proposals (H001-H003 only); the
    # Selector agent's full 9-gate review (verdict.json) sets these.
    h004_parent_diversity: Optional[Literal["pass", "fail"]] = None
    integrity_risk: Literal["pass", "fail"]
    instrumentation_check: Literal["pass", "fail"]
    schema_valid: Literal["pass", "fail"]
    acquisition_contamination: Optional[Literal["pass", "fail"]] = None
    gotcha_avoidance: Optional[Literal["pass", "fail"]] = None
    verdict: Literal["approved", "rejected"]
    rejection_reason: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────────
# SelectorVerdict — canonical shape for ticks/<tick>/selector/verdict.json
# ────────────────────────────────────────────────────────────────────────────


class SelectorReview(BaseEvorModel):
    """One proposal's gate review within a Selector verdict artifact.

    Field names mirror agents/evor-selector.md's Output_Format exactly —
    the agent's own instructions are the source of truth for this shape.
    """

    model_config = ConfigDict(strict=True, exclude_none=True, extra="forbid")

    proposal_id: str
    approach_family: ApproachFamily
    critic_review: CriticReview
    selected: bool
    selection_note: Optional[str] = None


class SelectorVerdict(BaseEvorModel):
    """Canonical Selector verdict artifact (ticks/<tick>/selector/verdict.json).

    One review per proposal in the tick, plus the winning proposal_id (or None
    if no proposal was selected). This is the single accepted shape — see the
    module docstring in evor/artifacts.py for the drift this replaces.
    """

    model_config = ConfigDict(strict=True, exclude_none=True, extra="forbid")

    reviews: list[SelectorReview]
    winner: Optional[str] = None


class MutationProposal(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    # Server-owned: generated server-side if absent.
    proposal_id: Optional[str] = None
    parent_node_ids: list[str]
    approach_family: ApproachFamily
    idea: str
    hypothesis: Hypothesis
    citations: list[str]
    wildness: float
    critic_approved: bool
    # Server-owned: evor_validate_proposals computes gate codes deterministically.
    critic_review: Optional[CriticReview] = None


# ────────────────────────────────────────────────────────────────────────────
# EvaluationResult
# ────────────────────────────────────────────────────────────────────────────


class TelemetrySummary(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    final_train_loss: Optional[float] = None
    best_val_metric: Optional[float] = None
    grad_norm_median: Optional[float] = None
    throughput_samples_per_sec: Optional[float] = None
    total_steps: int
    val_series: Optional[list[float]] = None
    """Per-step validation metric values emitted by the trainer.
    Required for per-step spike detection in IntegrityGate._check_reward_hacking.
    Eval scripts should emit this under telemetry_summary.val_series."""


class AngleVsSOTAInline(BaseEvorModel):
    """Inline per-angle result embedded in EvaluationResult.per_angle_vs_sota."""
    model_config = ConfigDict(strict=True, exclude_none=True)

    value: float
    sota_bar: float
    above_sota: bool


class EvaluationResult(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    # Server-owned bookkeeping — filled server-side from tool args + cache + now().
    node_id: Optional[str] = None
    run_id: Optional[str] = None
    eval_version: Optional[str] = None
    metrics: dict[str, float]
    per_domain: dict[str, dict[str, float]]
    fitness_value: float
    worst_angle_coverage: Optional[float] = None
    per_angle_vs_sota: Optional[dict[str, AngleVsSOTAInline]] = None
    telemetry_summary: TelemetrySummary
    status: Literal["success", "regression", "error", "timeout", "oom"]
    benchmark_raw: str
    # Server-owned: filled via now().
    timestamp: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────────
# IntegrityReport
# ────────────────────────────────────────────────────────────────────────────


class IntegrityChecks(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class IntegrityReport(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    node_id: str
    eval_version: str
    checks: IntegrityChecks
    verdict: Literal["passed", "failed"]
    failure_reason: Optional[str] = None
    verified_at: str


# ────────────────────────────────────────────────────────────────────────────
# TelemetryRecord
# ────────────────────────────────────────────────────────────────────────────


class TelemetryRecord(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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
    # Server-owned bookkeeping — telemetry.ts worker fills these from tool args + now().
    node_id: Optional[str] = None
    run_id: Optional[str] = None
    timestamp: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────────
# LessonEntry
# ────────────────────────────────────────────────────────────────────────────


class LessonEntry(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    # Server-owned bookkeeping — derived/generated server-side.
    lesson_id: Optional[str] = None
    node_id: Optional[str] = None
    run_id: Optional[str] = None
    mission_id: Optional[str] = None
    approach_family: ApproachFamily
    hypothesis_verdict: Literal["confirmed", "refuted", "inconclusive"]
    observation: str
    root_cause: Optional[str] = None
    actionable_lesson: str
    citations: list[str]
    telemetry_evidence: Optional[str] = None
    tags: list[str]
    # Server-owned: filled via now().
    created_at: Optional[str] = None


# ────────────────────────────────────────────────────────────────────────────
# StrategyState
# ────────────────────────────────────────────────────────────────────────────


class StrategyState(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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
    # ── Area 6: meta-evolve request flag (server-side) ────────────────────────
    meta_evolve_requested: bool = False
    """True when an agent has requested a meta-evolve cycle; cleared by orchestrator at tick-start."""
    meta_evolve_reason: Optional[Literal["plateau", "regression", "lock"]] = None
    """Why the meta-evolve was requested; None when meta_evolve_requested is False."""


# ────────────────────────────────────────────────────────────────────────────
# ResourcePlan
# ────────────────────────────────────────────────────────────────────────────


class ResourcePlan(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class DecisionLogEntry(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class GenomeConfig(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class AcquisitionProvenance(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class FrozenSplit(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class DataProvenance(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class Domain(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    domain_id: str
    description: str
    metric_specs: list[MetricSpec]
    sota_source: Optional[SotaSource] = None
    added_at_eval_version: str


# ────────────────────────────────────────────────────────────────────────────
# EvalSuite / EvalVersion (Pillar 3)
# ────────────────────────────────────────────────────────────────────────────


class EvalSuite(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class BenchmarkUpgrade(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class BenchmarkUpgradeProposal(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    proposed_by: Literal["probe", "sage"]
    new_domains: list[str]
    rationale: str
    citations: list[str]


# ────────────────────────────────────────────────────────────────────────────
# AngleRegistry (Pillar 4)
# ────────────────────────────────────────────────────────────────────────────


class AngleEntry(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class AngleRegistry(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    mission_id: str
    angles: list[AngleEntry]
    updated_at: str


# ────────────────────────────────────────────────────────────────────────────
# CoverageTarget (Pillar 4)
# ────────────────────────────────────────────────────────────────────────────


class CoverageTarget(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    target_fraction: float
    current_worst_angle_id: Optional[str] = None
    current_coverage: float


# ────────────────────────────────────────────────────────────────────────────
# BenchmarkRescore (consensus pass 2, R-6)
# ────────────────────────────────────────────────────────────────────────────


class BenchmarkRescore(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    upgrade_id: str
    node_id: str
    cached_per_domain: dict[str, dict[str, float]]
    """v_old per_domain scores, carried forward"""
    new_domains: list[str]
    merged_eval_version: str


# ────────────────────────────────────────────────────────────────────────────
# AngleVsSOTA (consensus pass 2, R-11)
# ────────────────────────────────────────────────────────────────────────────


class AngleVsSOTA(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class DetectedSeam(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

    kind: Literal["model_def", "training_loop", "data_pipeline"]
    file: str
    symbol: str


class GenomeSeedAdapterReport(BaseEvorModel):
    model_config = ConfigDict(strict=True, exclude_none=True)

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


class GotchaEntry(BaseEvorModel):
    """A single recorded failure/constraint that future agents should avoid.

    Stored under .evor/wiki/gotchas/ (global scope) or per run-dir (mission
    scope) so they survive across missions on the same machine.

    ``signature`` is the dedup key \u2014 e.g. ``"cuda-oom"``, ``"flash-attn-v3-sm90"``.
    Duplicate add() calls with the same (signature, scope) increment
    ``occurrences``, bump ``last_seen``, and raise ``confidence`` toward 1.0.
    """

    model_config = ConfigDict(strict=True, exclude_none=True)

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


class Signal(BaseEvorModel):
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

    model_config = ConfigDict(strict=True, exclude_none=True)

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


class CapabilityProfile(BaseEvorModel):
    """Hardware capability profile probed at preflight time.

    Written to ``.evor/capability.json`` (global) so all agents can read it.
    When no GPU is available, ``cpu_only=True`` and GPU fields are None.
    """

    model_config = ConfigDict(strict=True, exclude_none=True)

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
# CitationBackedFinding (math-fidelity schema, v0.4.0)
# ────────────────────────────────────────────────────────────────────────────


class CitationBackedFinding(BaseEvorModel):
    """A single research finding backed by ≥1 citation, with an optional full
    implementation blueprint.

    Sage and Sage-junior emit these as structured evidence; Forge consumes them
    to guide implementation.  ``implementation_spec`` carries EVERYTHING Forge-junior
    needs to reproduce or inherit from the paper — formulas AND training recipe,
    augmentation, inference tricks, libraries, etc. — not just math.  ``libraries``
    names the exact tools the paper uses so Forge can adopt them directly.
    Paraphrasing is forbidden for verbatim math inside implementation_spec.
    """

    model_config = ConfigDict(strict=True, exclude_none=True)

    title: str
    """Short descriptive title of the finding."""
    source_url: str
    """Primary URL (paper, blog, leaderboard) that anchors this finding."""
    sources: list[str]
    """All URLs / DOIs consulted (>=1 required for quorum_met=True)."""
    finding: str
    """One concrete English sentence stating what was found."""
    evidence: str
    """Metric values, dataset names, and experimental conditions supporting the finding."""
    confidence: Literal["high", "medium", "low"]
    trust_level: Literal["authoritative", "indicative"]
    sota_bar: Optional[float] = None
    """Numeric SOTA threshold this finding implies, if applicable."""
    applicable_families: list[ApproachFamily]
    """Which ApproachFamily tags this finding applies to."""
    quorum_met: bool
    """True iff >=2 independent sources with <=5% divergence confirmed the finding."""
    junior_sources: list[str] = Field(default_factory=list)
    """URLs fetched by Sage-junior (informational; not counted toward quorum)."""
    # ── Implementation fidelity (NEW in v0.4.0) — a COMPLETE blueprint, not just math ──
    implementation_spec: Optional[str] = None
    """Everything Forge-junior needs to reproduce or INHERIT from the paper — more than
    less.  Copy math VERBATIM (formulas / pseudocode / algorithm boxes: loss, attention,
    optimizer update); structure the rest.  Include, as present: architecture details
    (blocks, dims, backbone/head); training method / recipe (schedule, warmup, multi-stage,
    freeze/unfreeze, EMA, distillation); augmentation pipeline (exact transforms + order +
    params); inference tricks (TTA, ensembling, temperature/calibration, sliding-window);
    and any other reproducible detail.  When in doubt, INCLUDE it.
    None = a standard well-known technique needing no paper-specific detail."""
    key_hyperparams: Optional[dict[str, Any]] = None
    """Exact hyperparameter values from the paper's experiments, e.g.
    {"tau": 0.1, "lr": 3e-4, "epochs": 90}.  None = none to carry forward."""
    libraries: list[str] = Field(default_factory=list)
    """Exact libraries / tools the paper uses that Forge can inherit or reuse directly,
    e.g. ["augraphy", "timm", "kornia", "albumentations"].  Empty if none noted."""


# ────────────────────────────────────────────────────────────────────────────
# Schema registry (all models, for validation tooling / test iteration)
# ────────────────────────────────────────────────────────────────────────────

# ────────────────────────────────────────────────────────────────────────────
# Distill contracts (evor-distill workspace scanner / brownfield onboarding)
# ────────────────────────────────────────────────────────────────────────────

WorkspaceClass = Literal["greenfield", "brownfield", "evor-active", "possibly-training"]
"""Workspace classification produced by classify_workspace() / evor-distill."""


class DetectedDataset(BaseEvorModel):
    """A dataset directory or file found by the distill scanner."""

    model_config = ConfigDict(strict=True, exclude_none=True)

    path: str
    kind: Literal["images-dir", "csv", "parquet", "tfrecord", "hf-cache", "unknown"]
    approx_size_bytes: Optional[int] = None
    notes: Optional[str] = None


class DetectedModel(BaseEvorModel):
    """A model checkpoint found by the distill scanner."""

    model_config = ConfigDict(strict=True, exclude_none=True)

    path: str
    format: Literal["torch", "checkpoint", "safetensors", "onnx", "h5", "pickle", "unknown"]
    approx_param_count: Optional[int] = None
    """None — computing param count requires loading the model (GPU-gated)."""
    arch_guess: Optional[str] = None
    """Best-effort architecture family inferred from filename/parent dir."""
    mtime: str
    """ISO 8601 last-modified timestamp."""


class DetectedConfig(BaseEvorModel):
    """A config file found by the distill scanner."""

    model_config = ConfigDict(strict=True, exclude_none=True)

    path: str
    format: Literal["yaml", "json", "toml", "hydra"]
    key_hyperparams: dict[str, Any] = Field(default_factory=dict)
    """Best-effort extraction of lr/batch_size/epochs/model/optimizer."""


class ScrapedMetric(BaseEvorModel):
    """A metric/value pair scraped from documentation or experiment logs.

    INVARIANT: verified is ALWAYS False at distill time. EVOR must re-measure
    on the frozen split before trusting any claimed number.
    """

    model_config = ConfigDict(strict=True, exclude_none=True)

    source: Literal["readme", "wandb", "tensorboard", "log", "json", "csv"]
    source_path: str
    metric: str
    value: float
    split_hint: Optional[str] = None
    """Inferred split context: 'val', 'test', 'train', or None."""
    verified: bool = False
    """ALWAYS False at distill — distill never trusts a repo's claimed number."""


class BaselineCandidate(BaseEvorModel):
    """Best baseline candidate extracted from the distill scan.

    INVARIANT: verified is ALWAYS False. The distilled value becomes the
    mission baseline ONLY as ``claimed``; EVOR's measured value is whatever
    the evaluator computes on the frozen split.
    """

    model_config = ConfigDict(strict=True, exclude_none=True)

    model_path: Optional[str] = None
    metric_name: Optional[str] = None
    claimed_value: Optional[float] = None
    source: Optional[str] = None
    verified: bool = False
    """ALWAYS False — EVOR must re-measure before trusting this number."""


class StartingPointReport(BaseEvorModel):
    """Full distill scan result written to ``<evorRoot>/starting-point.json``."""

    model_config = ConfigDict(strict=True, exclude_none=True)

    workspace_class: WorkspaceClass
    root: str
    framework: Optional[Literal["pytorch", "tensorflow", "sklearn", "jax", "unknown"]] = None
    task_guess: Optional[str] = None
    datasets: list[DetectedDataset]
    models: list[DetectedModel]
    configs: list[DetectedConfig]
    scraped_metrics: list[ScrapedMetric]
    entry_points: list[str]
    baseline_candidate: Optional[BaselineCandidate] = None
    warnings: list[str] = Field(default_factory=list)
    generated_at: str


ALL_MODELS: dict[str, type[BaseModel]] = {
    # Base 10 (+ Hypothesis)
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
    # Math-fidelity schema (v0.4.0)
    "CitationBackedFinding": CitationBackedFinding,
    # Distill contracts
    "DetectedDataset": DetectedDataset,
    "DetectedModel": DetectedModel,
    "DetectedConfig": DetectedConfig,
    "ScrapedMetric": ScrapedMetric,
    "BaselineCandidate": BaselineCandidate,
    "StartingPointReport": StartingPointReport,
}
