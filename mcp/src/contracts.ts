/**
 * oh-my-evor data contracts — Zod schemas + TypeScript interfaces
 *
 * All 27+ schemas covering:
 *   - 11 base schemas (GoalContract → DecisionLogEntry + Hypothesis)
 *   - 13 Addendum v2 schemas (GenomeConfig → CoverageTarget)
 *   - 2 consensus pass-2 schemas (BenchmarkRescore, AngleVsSOTA)
 *   - 1 Q2 addition (GenomeSeedAdapterReport)
 *
 * Field names match the plan's Data Contracts section exactly.
 * ApproachFamily: 7-tag literal per R-12.
 */

import { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ────────────────────────────────────────────────────────────────────────────

/** ISO 8601 datetime string */
const ISODate = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T/));

/** 7-tag approach family taxonomy (R-12) */
export const ApproachFamilySchema = z.enum([
  "arch",
  "training",
  "data-curation",
  "data-augmentation",
  "data-acquisition",
  "algo",
  "other",
]);
export type ApproachFamily = z.infer<typeof ApproachFamilySchema>;

// ────────────────────────────────────────────────────────────────────────────
// MetricSpec / MetricRegistry (Pillar 3)
// ────────────────────────────────────────────────────────────────────────────

/** Hard constraint on a secondary metric used as a gamability guard (mirrors Python MetricConstraint). */
export const MetricConstraintSchema = z.object({
  metric: z.string().describe("Name of the metric to constrain"),
  op: z.enum([">=", "<=", "==", ">", "<"]).describe("Comparison operator"),
  threshold: z.number().describe("Threshold value for the constraint"),
});
export type MetricConstraint = z.infer<typeof MetricConstraintSchema>;

export const MetricSpecSchema = z.object({
  metric_name: z.string(),
  direction: z.enum(["higher", "lower"]),
  domain_applicability: z.union([z.array(z.string()), z.literal("all")]),
  aggregation_rule: z.enum(["macro_avg", "weighted_avg", "min", "max"]).default("macro_avg"),
  role: z.enum(["primary_fitness", "secondary_reported"]),
  sota_bar: z.number().optional(),
  // Composite / F-beta / constrained / custom modes (mirrors Python MetricSpec)
  fitness_formula: z.string().optional().describe("Expression e.g. '0.7*recall+0.3*precision'"),
  fbeta: z.number().optional().describe("Beta for F-beta score; only active when metric_name='fbeta'"),
  constraints: z.array(MetricConstraintSchema).default([]).describe("Hard guards against degenerate solutions"),
  custom_metrics: z.array(z.string()).default([]).describe("Extra metric names the evaluator should emit"),
});
export type MetricSpec = z.infer<typeof MetricSpecSchema>;

/** MetricRegistry: GoalContract's live view of all registered MetricSpecs */
export const MetricRegistrySchema = z.record(z.string(), MetricSpecSchema);
export type MetricRegistry = z.infer<typeof MetricRegistrySchema>;

// ────────────────────────────────────────────────────────────────────────────
// SotaSource (Pillar 4)
// ────────────────────────────────────────────────────────────────────────────

export const SotaSourceSchema = z.object({
  source_id: z.string(),
  name: z.string(),
  url: z.string().optional(),
  retrieval_method: z.enum(["mcp_search", "web_fetch", "human_provided"]),
  trust_level: z.enum(["authoritative", "indicative"]),
});
export type SotaSource = z.infer<typeof SotaSourceSchema>;

// ────────────────────────────────────────────────────────────────────────────
// ExpansionPolicy (Pillar 4)
// ────────────────────────────────────────────────────────────────────────────

export const ExpansionPolicySchema = z.object({
  auto_add_within_families: z.array(z.string()),
  require_consent_for: z.array(z.string()),
  sota_sources: z.array(SotaSourceSchema),
  max_angles_per_upgrade: z.number().int().positive(),
  /** at most max_upgrades BenchmarkUpgrades per per_ticks ticks */
  max_upgrades_per_N_ticks: z.object({
    max_upgrades: z.number().int().positive(),
    per_ticks: z.number().int().positive(),
  }),
  /** ABSOLUTE pp residual threshold for high-contamination flag (R-9); default 5.0 */
  pretraining_canary_threshold_pp: z.number(),
});
export type ExpansionPolicy = z.infer<typeof ExpansionPolicySchema>;

// ────────────────────────────────────────────────────────────────────────────
// EvolutionBounds / AutonomyCharter (GoalContract addenda)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Escalate-mode bounds — how far the mission may auto-adapt the GoalContract.
 * Escalation is MONOTONIC: it may only make the objective harder/more honest,
 * never easier. None on a contract = fully frozen (no auto-adaptation).
 * Mirrors Python EvolutionBounds exactly.
 */
export const EvolutionBoundsSchema = z.object({
  benchmark_may_harden: z.boolean().default(true).describe("auto: add harder eval domains / worst-case slices"),
  metrics_may_add_tracked: z.boolean().default(true).describe("auto: add secondary tracked metrics (never replace primary)"),
  budget_ceiling_extensions: z.number().int().min(0).default(0).describe("auto: number of times budget may be extended within a pre-set ceiling"),
  primary_metric_frozen: z.boolean().default(true).describe("the primary metric definition + comparability basis never auto-change"),
  comparability_change_requires_consent: z.boolean().default(true).describe("any change to what the primary number MEANS is gated on human consent"),
});
export type EvolutionBounds = z.infer<typeof EvolutionBoundsSchema>;

/**
 * Full-autonomy charter — after setup, the mission runs to the goal with
 * ZERO human-in-the-loop. Every mid-run decision is auto-resolved by the
 * Monotonic-Honesty Invariant. Mirrors Python AutonomyCharter exactly.
 */
export const AutonomyCharterSchema = z.object({
  posture: z.literal("aggressive-never-halt").default("aggressive-never-halt").describe("The only posture: never stop for a human; always take the monotonic move"),
  invariant: z.string().describe("Monotonic-honesty invariant statement"),
  license_gate: z.boolean().default(false).describe("False = research mode: acquire data from any source freely"),
  data_acquisition_enabled: z.boolean().default(true).describe("Agents may enrich train + harden test by acquiring external data"),
  always_on_checks: z.array(z.string()).default(["no-test-leakage", "comparability-eval-version"]).describe("Checks that are the invariant — enforced automatically, never HITL"),
});
export type AutonomyCharter = z.infer<typeof AutonomyCharterSchema>;

// ────────────────────────────────────────────────────────────────────────────
// GoalContract
// ────────────────────────────────────────────────────────────────────────────

export const GoalContractSchema = z.object({
  mission_id: z.string(),
  mode: z.enum(["seed-repo", "from-scratch"]),
  mission_type: z.enum(["fixed", "open_ended"]),
  task_description: z.string(),
  dataset_ref: z.string(),
  metric_specs: z.array(MetricSpecSchema),
  fitness_mode: z.enum(["aggregate", "worst-domain", "weighted"]),
  eval_version: z.string().default("v1"),
  baseline_value: z.number(),
  target_value: z.number().optional(),
  coverage_target: z.number().min(0).max(1).optional(),
  stop_condition: z.object({
    type: z.enum([
      "beat-baseline",
      "beat-sota",
      "target",
      "maximize-under-budget",
      "evolve-n",
      "evolve-until-plateau",
      "evolve-until-regression",
      "worst-angle-plateau",
      "coverage-target",
    ]),
    n: z.number().int().optional(),
  }),
  wildness: z.number().min(0).max(1),
  budget: z.object({
    max_iterations: z.number().int().positive(),
    plateau_window: z.number().int().positive(),
    circuit_breaker: z.number().int().positive(),
    max_cost_usd: z.number().min(0),
    max_wall_clock_hours: z.number().optional(),
    max_gpu_hours: z.number().optional(),
  }),
  framework: z.string().optional(),
  seed_repo_path: z.string().optional(),
  // Server-owned: harness computes at freeze — agent must never supply.
  locked_split_hash: z.string().optional(),
  eval_script_hash: z.string().optional(),
  expansion_policy: ExpansionPolicySchema.optional(),
  allowed_licenses: z.array(z.string()),
  evolution_bounds: EvolutionBoundsSchema.optional().describe(
    "escalate-mode bounds; None = fully frozen (no auto-adaptation)"
  ),
  autonomy_charter: AutonomyCharterSchema.default({
    invariant:
      "Every autonomous decision MUST be monotonic: it may make the evaluation harder " +
      "or more honest, never easier or comparability-shifting. Forbidden directions " +
      "(softening the metric, shifting comparability to inflate a score, leaking test " +
      "into train) are routed around — never executed, never halted on.",
  }).describe("full-autonomy charter; always present — charter is mandatory for all missions."),
  // Server-owned: filled via now() at creation time.
  created_at: ISODate.optional(),
});
export type GoalContract = z.infer<typeof GoalContractSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Hypothesis
// ────────────────────────────────────────────────────────────────────────────

export const HypothesisSchema = z.object({
  id: z.string(),
  statement: z.string(),
  prediction: z.string(),
  confirmed: z.boolean().optional(),
  evidence: z.string().optional(),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

// ────────────────────────────────────────────────────────────────────────────
// MutationLocus (Pillar 1)
// ────────────────────────────────────────────────────────────────────────────

export const MutationLocusSchema = z.discriminatedUnion("family", [
  z.object({ family: z.literal("arch"), path: z.literal("model/") }),
  z.object({ family: z.literal("training"), path: z.literal("train/") }),
  z.object({ family: z.literal("data-curation"), path: z.literal("data/builder") }),
  z.object({ family: z.literal("data-augmentation"), path: z.literal("data/aug") }),
  z.object({
    family: z.literal("data-acquisition"),
    path: z.literal("data/acquisition"),
    acquisition_type: z.enum(["external", "synthetic"]),
  }),
  z.object({
    family: z.literal("algo"),
    path: z.string(),
    genome_extension: z.string(),
  }),
]);
export type MutationLocus = z.infer<typeof MutationLocusSchema>;

// ────────────────────────────────────────────────────────────────────────────
// TreeNode
// ────────────────────────────────────────────────────────────────────────────

export const TreeNodeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional().describe(
    "Human-readable node slug the agent coined (e.g. 'immune-memory-02'). " +
    "Optional; when set, every node tool accepts it in place of the UUID (P2-1).",
  ),
  parent_ids: z.array(z.string()),
  approach_family: ApproachFamilySchema,
  hypothesis_id: z.string(),
  code_ref: z.string(),
  parent_patch_ref: z.string().optional(),
  genome_ref: z.string(),
  mutation_tier: z.enum(["parametric", "structural"]).optional(),
  mutation_locus: MutationLocusSchema.optional(),
  data_version_ref: z.string(),
  config: z.record(z.string(), z.unknown()),
  weights_ref: z.string().optional(),
  metrics: z.record(z.string(), z.number()),
  eval_version: z.string(),
  fitness_value: z.number().optional(),
  telemetry_ref: z.string().optional(),
  // Server-owned bookkeeping — optional in input; server fills defaults before persist.
  lesson_ids: z.array(z.string()).optional().default([]),
  citations: z.array(z.string()).optional().default([]),
  integrity_status: z.enum(["pending", "passed", "failed"]).optional().default("pending"),
  status: z.enum(["pending", "running", "done", "pruned"]).optional().default("pending"),
  is_crossover: z.boolean().optional().default(false),
  ucb1_score: z.number().optional(),
  visit_count: z.number().int().min(0).optional().default(0),
  depth: z.number().int().min(0).optional().default(0),
  created_at: ISODate.optional(),
  completed_at: ISODate.optional(),
});
export type TreeNode = z.infer<typeof TreeNodeSchema>;

// ────────────────────────────────────────────────────────────────────────────
// MutationProposal
// ────────────────────────────────────────────────────────────────────────────

export const MutationProposalSchema = z.object({
  // Server-owned: generated server-side if absent.
  proposal_id: z.string().optional(),
  parent_node_ids: z.array(z.string()),
  approach_family: ApproachFamilySchema,
  idea: z.string(),
  hypothesis: HypothesisSchema,
  citations: z.array(z.string()),
  wildness: z.number().min(0).max(1),
  // `critic_approved` REMOVED (item 2b.2): the contract required the PROPOSER to
  // assert the REVIEWER's verdict, and nothing read it. A self-report standing in
  // for a review is the self-approval vector the review gates exist to prevent.
  // Server-owned: evor_validate_proposals computes gate codes deterministically.
  // Agent must NOT supply internal gate codes; the server populates critic_review.
  critic_review: z.object({
    h001_one_hypothesis: z.enum(["pass", "fail"]),
    h002_family_streak: z.enum(["pass", "fail"]),
    h003_intra_tick_diversity: z.enum(["pass", "fail"]),
    integrity_risk: z.enum(["pass", "fail"]),
    instrumentation_check: z.enum(["pass", "fail"]),
    schema_valid: z.enum(["pass", "fail"]),
    verdict: z.enum(["approved", "rejected"]),
    rejection_reason: z.string().optional(),
  }).optional(),
});
export type MutationProposal = z.infer<typeof MutationProposalSchema>;

// ────────────────────────────────────────────────────────────────────────────
// EvaluationResult
// ────────────────────────────────────────────────────────────────────────────

export const EvaluationResultSchema = z.object({
  // Server-owned bookkeeping — filled server-side from tool args + cache + now().
  node_id: z.string().optional(),
  run_id: z.string().optional(),
  eval_version: z.string().optional(),
  metrics: z.record(z.string(), z.number()),
  per_domain: z.record(z.string(), z.record(z.string(), z.number())),
  fitness_value: z.number(),
  worst_angle_coverage: z.number().min(0).max(1).optional(),
  per_angle_vs_sota: z
    .record(
      z.string(),
      z.object({
        value: z.number(),
        sota_bar: z.number(),
        above_sota: z.boolean(),
      })
    )
    .optional(),
  telemetry_summary: z.object({
    final_train_loss: z.number().optional(),
    best_val_metric: z.number().optional(),
    grad_norm_median: z.number().optional(),
    throughput_samples_per_sec: z.number().optional(),
    total_steps: z.number().int().min(0),
  }),
  status: z.enum(["success", "regression", "error", "timeout", "oom"]),
  benchmark_raw: z.string(),
  // Server-owned: filled via now().
  timestamp: ISODate.optional(),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

// ────────────────────────────────────────────────────────────────────────────
// IntegrityReport
// ────────────────────────────────────────────────────────────────────────────

export const IntegrityReportSchema = z.object({
  node_id: z.string(),
  eval_version: z.string(),
  checks: z.object({
    split_hash_match: z.boolean(),
    frozen_split_read_only: z.boolean(),
    no_test_leakage: z.boolean(),
    near_dup_leakage: z.boolean(),
    data_provenance_valid: z.boolean(),
    no_label_contamination: z.boolean(),
    no_eval_shift: z.boolean(),
    eval_version_consistent: z.boolean(),
    telemetry_sane: z.boolean(),
    reward_hacking_probe: z.boolean(),
    acquisition_contamination_clear: z.boolean().nullable(),
    acquired_data_provenance_valid: z.boolean().nullable(),
    acquisition_namespace_enforced: z.boolean().nullable(),
    structure_ok: z.boolean().nullable().optional().describe(
      "ForgeStructureGate: genome seams + forward pass + telemetry + eval lock. null = gate not run."
    ),
  }),
  verdict: z.enum(["passed", "failed"]),
  failure_reason: z.string().optional(),
  verified_at: ISODate,
});
export type IntegrityReport = z.infer<typeof IntegrityReportSchema>;

// ────────────────────────────────────────────────────────────────────────────
// TelemetryRecord
// ────────────────────────────────────────────────────────────────────────────

export const TelemetryRecordSchema = z.object({
  step: z.number().int().min(0),
  epoch: z.number().optional(),
  train_loss: z.number().optional(),
  val_metric: z.number().optional(),
  lr: z.number().optional(),
  grad_norm: z.number().optional(),
  param_norm: z.number().optional(),
  update_ratio: z.number().optional(),
  throughput: z.number().optional(),
  gpu_util: z.number().min(0).max(100).optional(),
  mem_used_gb: z.number().optional(),
  mem_total_gb: z.number().optional(),
  // Server-owned bookkeeping — telemetry.ts worker fills these from tool args + now().
  node_id: z.string().optional(),
  run_id: z.string().optional(),
  timestamp: ISODate.optional(),
});
export type TelemetryRecord = z.infer<typeof TelemetryRecordSchema>;

// ────────────────────────────────────────────────────────────────────────────
// LessonEntry
// ────────────────────────────────────────────────────────────────────────────

export const LessonEntrySchema = z.object({
  // Server-owned bookkeeping — optional at agent-facing input; server fills before persist.
  // Defaults to "" so the stored TypeScript type remains `string` (wiki.ts sorts/files on these).
  lesson_id: z.string().optional().default(""),
  node_id: z.string().optional().default(""),
  run_id: z.string().optional().default(""),
  mission_id: z.string().optional().default(""),
  approach_family: ApproachFamilySchema,
  hypothesis_verdict: z.enum(["confirmed", "refuted", "inconclusive"]),
  observation: z.string(),
  root_cause: z.string().optional(),
  actionable_lesson: z.string(),
  citations: z.array(z.string()),
  telemetry_evidence: z.string().optional(),
  tags: z.array(z.string()),
  // ── Item 5.3: a lesson refuted by measurement must be markable ──────────
  //
  // N-02. The r1 entry claiming a latency figure was falsified TWICE — measured
  // at 81.4ms and 74.85ms — and was never retracted. It was then cited 23 times
  // across the tree. Overwriting in place is not enough: the refutation needs a
  // POINTER to the evidence, or the next reader cannot tell a stale claim from a
  // live one, and the history of having believed it is lost.
  superseded_by: z.string().optional().describe(
    "Node or lesson id whose measurement refutes this entry. Set => not a confirmed lesson.",
  ),
  superseded_reason: z.string().optional().describe(
    "Why it was superseded, recorded when it was, not reconstructed afterwards.",
  ),
  // Server-owned: filled via now(); defaults to "" to keep stored type as string.
  created_at: ISODate.optional().default(""),
});
export type LessonEntry = z.infer<typeof LessonEntrySchema>;

// ────────────────────────────────────────────────────────────────────────────
// StrategyState
// ────────────────────────────────────────────────────────────────────────────

export const StrategyStateSchema = z.object({
  meta_iteration: z.number().int().min(0),
  selection_policy: z.enum(["ucb1", "mcts", "beam"]),
  ucb1_c: z.number(),
  beam_width: z.number().int().positive().optional(),
  wildness: z.number().min(0).max(1),
  family_mix: z.record(ApproachFamilySchema, z.number()),
  winning_families: z.array(ApproachFamilySchema),
  wins_by_family: z.record(ApproachFamilySchema, z.number()),
  meta_loop_interval: z.number().int().positive(),
  /** null = no boost active */
  post_upgrade_exploration_boost: z.number().nullable(),
  /** ticks remaining for boost; default max(5, frontier_size*2) capped at 15 */
  post_upgrade_exploration_ticks: z.number().int().min(0),
  /** SINGLE source of truth for BenchmarkUpgrade re-score mode (Q1) */
  rescore_mode: z.enum(["sync", "async"]),
  /**
   * dream_k — number of proposals Mutagen generates per tick (P1-14).
   * Decoupled from concurrency (train_k): dream more, gate with Selector,
   * train only the approved subset. Default = max(concurrency * 2, 5).
   */
  dream_k: z.number().int().positive().optional().describe(
    "Proposals Mutagen generates per tick; Selector gates to at most concurrency for Forge. Default = max(concurrency*2, 5)."
  ),
  updated_at: ISODate,
  // ── Area 6: meta-evolve request flag (server-side) ────────────────────────
  /** True when an agent has requested a meta-evolve cycle; cleared by orchestrator at tick-start. */
  meta_evolve_requested: z.boolean().optional(),
  /** Why the meta-evolve was requested; absent when meta_evolve_requested is false. */
  meta_evolve_reason: z.enum(["plateau", "regression", "lock"]).optional(),
});
export type StrategyState = z.infer<typeof StrategyStateSchema>;

// ────────────────────────────────────────────────────────────────────────────
// ResourcePlan
// ────────────────────────────────────────────────────────────────────────────

export const ResourcePlanSchema = z.object({
  concurrency: z.number().int().positive(),
  gpu_ids: z.array(z.number().int().min(0)),
  cpu_fallback: z.boolean(),
  throughput_samples_per_sec: z.number(),
  vram_per_job_gb: z.number(),
  util_target: z.number().min(0).max(1),
  last_probed_at: ISODate,
});
export type ResourcePlan = z.infer<typeof ResourcePlanSchema>;

// ────────────────────────────────────────────────────────────────────────────
// DecisionLogEntry
// ────────────────────────────────────────────────────────────────────────────

export const DecisionLogEntrySchema = z.object({
  timestamp: ISODate,
  tick: z.number().int().min(0),
  decision_type: z.enum([
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
  ]),
  rationale: z.string(),
  node_ids: z.array(z.string()),
  strategy_delta: StrategyStateSchema.partial().optional(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntrySchema>;

// ────────────────────────────────────────────────────────────────────────────
// GenomeConfig (Pillar 1)
// ────────────────────────────────────────────────────────────────────────────

export const GenomeConfigSchema = z.object({
  genome_version: z.string(),
  model_family: z.string().optional().describe(
    "Architecture family for ForgeStructureGate seam check: cnn, embedding, graph, vlm. None = universal-only invariants"
  ),
  backbone: z.string().optional(),
  head: z.string().optional(),
  neck: z.string().optional(),
  optimizer: z.string(),
  lr: z.number().positive(),
  lr_schedule: z.string(),
  batch_size: z.number().int().positive(),
  epochs: z.number().int().positive(),
  loss: z.string(),
  aug_set: z.array(z.string()),
  /** acquisition_ids from AcquisitionProvenance; [] = no external/synthetic data */
  acquired_datasets: z.array(z.string()),
  regularization: z.record(z.string(), z.unknown()),
  /** names of structurally-added keys; empty for gen-1 root */
  schema_extensions: z.array(z.string()),
  extra: z.record(z.string(), z.unknown()),
});
export type GenomeConfig = z.infer<typeof GenomeConfigSchema>;

// ────────────────────────────────────────────────────────────────────────────
// AcquisitionProvenance (data-acquisition)
// ────────────────────────────────────────────────────────────────────────────

export const AcquisitionProvenanceSchema = z.object({
  acquisition_id: z.string(),
  acquisition_type: z.enum(["external", "synthetic"]),
  source_name: z.string().optional(),
  source_url: z.string().optional(),
  /** SPDX identifier e.g. "CC-BY-4.0", "MIT", "proprietary-restricted" (R-3) */
  license_identifier: z.string(),
  /** true iff license_identifier ∈ GoalContract.allowed_licenses (R-3) */
  license_in_allowlist: z.boolean(),
  citation: z.string(),
  generator_config: z.record(z.string(), z.unknown()).optional(),
  sample_count: z.number().int().min(0),
  acquired_at: ISODate,
  ingestion_contamination_cleared: z.boolean(),
});
export type AcquisitionProvenance = z.infer<typeof AcquisitionProvenanceSchema>;

// ────────────────────────────────────────────────────────────────────────────
// FrozenSplit (Pillar 2)
// ────────────────────────────────────────────────────────────────────────────

export const FrozenSplitSchema = z.object({
  split_id: z.string(),
  mission_id: z.string(),
  split_type: z.enum(["test", "val"]),
  split_hash: z.string(),
  per_sample_hashes: z.record(z.string(), z.string()),
  item_count: z.number().int().min(0),
  frozen_at: ISODate,
  storage_path: z.string(),
  eval_version: z.string(),
});
export type FrozenSplit = z.infer<typeof FrozenSplitSchema>;

// ────────────────────────────────────────────────────────────────────────────
// DataProvenance (Pillar 2)
// ────────────────────────────────────────────────────────────────────────────

export const DataProvenanceSchema = z.object({
  sample_id: z.string(),
  source_sample_id: z.string(),
  /** DataProvenance only exists for train samples */
  split_type: z.literal("train"),
  transform_applied: z.array(z.string()),
  is_synthetic: z.boolean(),
  verified_not_in_test: z.boolean(),
});
export type DataProvenance = z.infer<typeof DataProvenanceSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Domain (Pillar 3)
// ────────────────────────────────────────────────────────────────────────────

export const DomainSchema = z.object({
  domain_id: z.string(),
  description: z.string(),
  metric_specs: z.array(MetricSpecSchema),
  sota_source: SotaSourceSchema.optional(),
  added_at_eval_version: z.string(),
});
export type Domain = z.infer<typeof DomainSchema>;

// ────────────────────────────────────────────────────────────────────────────
// EvalSuite / EvalVersion (Pillar 3)
// ────────────────────────────────────────────────────────────────────────────

export const EvalSuiteSchema = z.object({
  eval_version: z.string(),
  mission_id: z.string(),
  parent_eval_version: z.string().optional(),
  domains: z.array(DomainSchema),
  /** { domain_id: sha256 } — each domain's frozen held-out split */
  split_hashes: z.record(z.string(), z.string()),
  created_at: ISODate,
  created_by: z.enum(["user", "policy"]),
  consent_log_ref: z.string(),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

// EvalVersion is the same schema as EvalSuite (version alias)
export const EvalVersionSchema = EvalSuiteSchema;
export type EvalVersion = EvalSuite;

// ────────────────────────────────────────────────────────────────────────────
// BenchmarkUpgrade (Pillar 3 + 4)
// ────────────────────────────────────────────────────────────────────────────

export const BenchmarkUpgradeSchema = z.object({
  upgrade_id: z.string(),
  mission_id: z.string(),
  from_eval_version: z.string(),
  to_eval_version: z.string(),
  proposed_by: z.enum(["user", "probe", "sage", "policy"]),
  proposal_citations: z.array(z.string()),
  consent_granted: z.boolean(),
  consent_at: ISODate.optional(),
  new_domains_added: z.array(z.string()),
  /** DEFENSIVE INVARIANT: MUST always be empty (Q4) */
  domains_removed: z.array(z.string()),
  rescore_status: z.enum(["pending", "in_progress", "complete", "partial"]),
  /** tick count after which not-yet-rescored nodes are demoted to v{old}-only (R-2) */
  rescore_deadline_ticks: z.number().int().min(0),
  decision_log_ref: z.string(),
  created_at: ISODate,
});
export type BenchmarkUpgrade = z.infer<typeof BenchmarkUpgradeSchema>;

// ────────────────────────────────────────────────────────────────────────────
// BenchmarkUpgradeProposal
// ────────────────────────────────────────────────────────────────────────────

export const BenchmarkUpgradeProposalSchema = z.object({
  proposed_by: z.enum(["probe", "sage"]),
  new_domains: z.array(z.string()),
  rationale: z.string(),
  citations: z.array(z.string()),
});
export type BenchmarkUpgradeProposal = z.infer<typeof BenchmarkUpgradeProposalSchema>;

// ────────────────────────────────────────────────────────────────────────────
// AngleRegistry (Pillar 4)
// ────────────────────────────────────────────────────────────────────────────

export const AngleRegistrySchema = z.object({
  mission_id: z.string(),
  angles: z.array(
    z.object({
      angle_id: z.string(),
      eval_version_added: z.string(),
      sota_bar: z.number(),
      /** >=2 required for authoritative trust_level (R-1) */
      sota_source_ids: z.array(z.string()),
      /** true iff >=2 distinct sources with divergence <=5% (R-1) */
      sota_quorum_met: z.boolean(),
      /** seed/foundation model score before any fine-tuning; null until evaluated */
      baseline_model_score_before_finetune: z.number().nullable(),
      sota_retrieved_at: ISODate,
      held_out_split_hash: z.string(),
      is_public_benchmark: z.boolean(),
      pretraining_contamination_risk: z.enum(["low", "medium", "high", "unknown"]),
    })
  ),
  updated_at: ISODate,
});
export type AngleRegistry = z.infer<typeof AngleRegistrySchema>;

// ────────────────────────────────────────────────────────────────────────────
// CoverageTarget (Pillar 4)
// ────────────────────────────────────────────────────────────────────────────

export const CoverageTargetSchema = z.object({
  target_fraction: z.number().min(0).max(1),
  current_worst_angle_id: z.string().optional(),
  current_coverage: z.number().min(0).max(1),
});
export type CoverageTarget = z.infer<typeof CoverageTargetSchema>;

// ────────────────────────────────────────────────────────────────────────────
// BenchmarkRescore (consensus pass 2, R-6)
// ────────────────────────────────────────────────────────────────────────────

export const BenchmarkRescoreSchema = z.object({
  upgrade_id: z.string(),
  node_id: z.string(),
  /** v_old per_domain scores, carried forward */
  cached_per_domain: z.record(z.string(), z.record(z.string(), z.number())),
  new_domains: z.array(z.string()),
  merged_eval_version: z.string(),
});
export type BenchmarkRescore = z.infer<typeof BenchmarkRescoreSchema>;

// ────────────────────────────────────────────────────────────────────────────
// AngleVsSOTA (consensus pass 2, R-11)
// ────────────────────────────────────────────────────────────────────────────

export const AngleVsSOTASchema = z.object({
  angle_id: z.string(),
  value: z.number(),
  /** effective bar = max(sota_bar, baseline_model_score_before_finetune) (R-9) */
  sota_bar: z.number(),
  /** value >= sota_bar (only counts if trust_level="authoritative") */
  above_sota: z.boolean(),
  trust_level: z.enum(["authoritative", "indicative"]),
});
export type AngleVsSOTA = z.infer<typeof AngleVsSOTASchema>;

// ────────────────────────────────────────────────────────────────────────────
// GenomeSeedAdapterReport (Q2 — Pillar 1 seed-repo reproducibility artifact)
// ────────────────────────────────────────────────────────────────────────────

export const GenomeSeedAdapterReportSchema = z.object({
  seed_repo_path: z.string(),
  detected_seams: z.array(
    z.object({
      kind: z.enum(["model_def", "training_loop", "data_pipeline"]),
      file: z.string(),
      symbol: z.string(),
    })
  ),
  /** genome.yaml gene → seed-repo symbol it maps to */
  genome_mapping: z.record(z.string(), z.string()),
  /** seed-repo files/symbols with no genome counterpart */
  unmapped_regions: z.array(z.string()),
  created_at: ISODate,
});
export type GenomeSeedAdapterReport = z.infer<typeof GenomeSeedAdapterReportSchema>;


// ────────────────────────────────────────────────────────────────────────────
// GotchaEntry + CapabilityProfile (Gotcha knowledge layer)
// ────────────────────────────────────────────────────────────────────────────

export const GotchaEntrySchema = z.object({
  gotcha_id: z.string(),
  kind: z.enum(["runtime-failure", "hardware-constraint", "approach-deadend"]),
  signature: z.string(),
  context: z.record(z.string(), z.unknown()),
  resolution: z.string(),
  avoidance: z.string(),
  scope: z.enum(["mission", "global"]),
  confidence: z.number().min(0).max(1),
  occurrences: z.number().int().min(1),
  first_seen: ISODate,
  last_seen: ISODate,
});
export type GotchaEntry = z.infer<typeof GotchaEntrySchema>;

export const CapabilityProfileSchema = z.object({
  gpu_arch: z.string().nullable().optional(),
  gpu_name: z.string().nullable().optional(),
  vram_gb: z.number().nullable().optional(),
  supported_dtypes: z.array(z.string()),
  available_libs: z.array(z.string()),
  cuda_version: z.string().nullable().optional(),
  cpu_only: z.boolean(),
  probed_at: ISODate,
});
export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Signal (signal bus — <run_dir>/signals.jsonl)
// ────────────────────────────────────────────────────────────────────────────

export const SignalShapeSchema = z.enum(["limit", "opportunity", "failure", "trend"]);
export const SignalAxisSchema = z.enum([
  "memory", "compute", "accuracy", "stability", "data", "generalization", "cost",
]);
export const SignalSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export const SignalSchema = z.object({
  signal_id: z.string(),
  kind: z.string(),
  /** Dedup key — repeat emits with the same signature aggregate. */
  signature: z.string(),
  shapes: z.array(SignalShapeSchema).min(1),
  axes: z.array(SignalAxisSchema),
  severity: SignalSeveritySchema,
  evidence: z.record(z.string(), z.unknown()),
  source: z.string(),
  tick: z.number().int().nullable().optional(),
  node_id: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  occurrences: z.number().int().min(1),
  first_seen: ISODate,
  last_seen: ISODate,
});
export type Signal = z.infer<typeof SignalSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Schema registry (all 27 schemas, for validation tooling)
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle domain model (plan item 1.1)
//
// AF6: 58 contract models and not one of them was a `Mission`, a `Run` or a
// `Tick`. The three things this system actually IS had no type — they lived as
// untyped keys in JSON blobs written by a merge-patch that accepted anything.
// "~25 enumerated fixes collapse into 7 once one writer owns run state."
//
// Statuses are enums rather than `z.string()` because every one of them is
// compared against a string literal somewhere in three languages, and a typo in
// any of those comparisons fails silently in the permissive direction.
// ────────────────────────────────────────────────────────────────────────────

/**
 * A run's lifecycle. `initialized` is what a run reports before it has recorded
 * anything — including when its state file is missing or unreadable (1.4).
 * Absence is not liveness, so there is deliberately no state here meaning
 * "probably running".
 */
export const RunStatusSchema = z.enum([
  "initialized",
  "running",
  "paused",
  "completed",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * A mission's lifecycle. `locked` IS included here, unlike the patch schema in
 * `state.ts`, because this is the domain model — the mission genuinely occupies
 * that state, and `stop.mjs` records that it stays `locked` for the whole of an
 * active run. What `state.ts` withholds is the ability to PATCH into it, which
 * is an ownership rule, not a claim that the state does not exist. Conflating
 * the two is what left `locked` undescribable by the only model we had.
 */
export const MissionStatusSchema = z.enum([
  "draft",
  "locked",
  "running",
  "paused",
  "completed",
  "failed",
  "superseded",
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

/** A tick's step lifecycle. Distinct from run status; the two were often confused. */
export const StepStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/** The 9-step tick loop. One definition of where the end is. */
export const TICK_FINAL_STEP = 9;

/**
 * A Campaign is one goal pursued across attempts.
 *
 * r1 -> r2 -> r3 were three attempts at a single objective and the model had no
 * word for that, so each looked like an unrelated mission that happened to share
 * a name. Every question worth asking about the field run — did it improve, what
 * did attempt 2 learn from attempt 1, which attempt holds the node worth
 * re-scoring — is a question about a campaign.
 */
export const CampaignSchema = z.object({
  campaign_id: z.string(),
  objective: z.string(),
  created_at: ISODate,
  /** Attempt ids in the order they were made. */
  attempt_ids: z.array(z.string()),
  status: MissionStatusSchema,
});
export type Campaign = z.infer<typeof CampaignSchema>;

/** One attempt at a campaign's objective — what r1, r2 and r3 each were. */
export const MissionAttemptSchema = z.object({
  attempt_id: z.string(),
  campaign_id: z.string(),
  mission_id: z.string(),
  /** 1-based; r3 is attempt 3. */
  ordinal: z.number().int().positive(),
  started_at: ISODate,
  ended_at: ISODate.nullable().default(null),
  /**
   * Why this attempt ended, recorded WHEN it ended. K-08's supersession reason
   * was reconstructed afterwards by a human editing JSON in vim, because there
   * was no field to write it into at the time.
   */
  outcome_reason: z.string().nullable().default(null),
  supersedes_attempt_id: z.string().nullable().default(null),
});
export type MissionAttempt = z.infer<typeof MissionAttemptSchema>;

export const MissionSchema = z.object({
  mission_id: z.string(),
  campaign_id: z.string().nullable().default(null),
  status: MissionStatusSchema,
  created_at: ISODate,
  updated_at: ISODate,
  /** Set when status is `paused` — the origin the pause is walked back to (0.7). */
  paused_from: MissionStatusSchema.nullable().default(null),
  paused_at: ISODate.nullable().default(null),
  paused_by: z.string().nullable().default(null),
});
export type Mission = z.infer<typeof MissionSchema>;

export const RunSchema = z.object({
  run_id: z.string(),
  mission_id: z.string(),
  status: RunStatusSchema,
  tick_count: z.number().int().min(0),
  frontier_ids: z.array(z.string()),
  best_score: z.number().nullable().default(null),
  current_eval_version: z.string().default("v1"),
  pending_node_ids: z.array(z.string()).default([]),
  /**
   * The validated state root, established once at lock time (1.3). Every hook
   * re-derived this independently from `CLAUDE_PLUGIN_ROOT ?? process.cwd()`,
   * and when both were wrong all 14 of them read a different project's `.evor/`
   * for 19 hours without one noticing (Q-01).
   */
  state_root: z.string().nullable().default(null),
  started_at: ISODate.nullable().default(null),
  ended_at: ISODate.nullable().default(null),
});
export type Run = z.infer<typeof RunSchema>;

export const TickSchema = z.object({
  tick: z.number().int().min(0),
  run_id: z.string(),
  current_step: z.number().int().min(0).max(TICK_FINAL_STEP),
  step_status: StepStatusSchema,
  pending_subagent_ids: z.array(z.string()).default([]),
  /** Set while the tick waits on something it does not own (2b.3). */
  blocked: z
    .object({ on: z.string(), since: ISODate })
    .nullable()
    .default(null),
  started_at: ISODate.nullable().default(null),
});
export type Tick = z.infer<typeof TickSchema>;

/**
 * Is this tick finished? (Plan item 1.2.)
 *
 * ONE definition, owned here. The predicate was re-derived in five places across
 * three languages: `stop.mjs:379` had `const finished = step >= 9` while
 * `tree.py:894` defaulted the other way, and you cannot tune your way out of two
 * disagreeing defaults.
 *
 * Reaching the last step is not the same as finishing it. The final r3 tick sat
 * at step 9 with `step_status: "running"` and a failed integrity verdict, and
 * `step >= 9` alone called that done.
 */
export function isTickFinished(tick: Pick<Tick, "current_step" | "step_status">): boolean {
  return tick.current_step >= TICK_FINAL_STEP && tick.step_status === "done";
}

/** Is this run live — may a governance check still hold on its behalf? */
export function isRunActive(run: Pick<Run, "status">): boolean {
  return run.status === "running";
}

// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Concurrency semantics (plan item 1.9)
//
// Never decided, therefore settled by whoever wrote last. O-09: three missions
// in one workspace overlapping in time, with no statement anywhere about whether
// that was legal — so nothing could be called a violation, and nothing was.
//
// Mirrors `SINGLETON_PER_PARENT` in harness/evor/contracts.py. Both halves must
// change together; a concurrency rule that holds in one language is not a rule.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Entities of which at most one may be live at a time, per parent.
 *
 *   tick    -> run       one `tick-state.json` per run; a second concurrent tick
 *                        has nowhere to record itself
 *   run     -> mission   `active-run.json` is singular, and two runs advancing
 *                        one frontier each compute what the other invalidates
 *   mission -> campaign  r1 -> r2 -> r3 were sequential ATTEMPTS; two live
 *                        attempts at one objective are two campaigns
 */
export const SINGLETON_PER_PARENT: Record<string, string> = {
  tick: "run",
  run: "mission",
  mission: "campaign",
};

/**
 * The one deliberate plural: sub-agents within a tick overlap, because that
 * fan-out is what the design exists for. `Tick.pending_subagent_ids` is plural
 * for this reason and is the only plural here.
 */
export const CONCURRENT_WITHIN_TICK = ["subagent"] as const;

/** Is more than one live `entity` legal under its parent? Ask; do not assume. */
export function mayOverlap(entity: string): boolean {
  return !(entity in SINGLETON_PER_PARENT);
}

export const ALL_SCHEMAS = {
  // Base 11 (+ Hypothesis)
  GoalContract: GoalContractSchema,
  TreeNode: TreeNodeSchema,
  ApproachFamily: ApproachFamilySchema,
  Hypothesis: HypothesisSchema,
  MutationProposal: MutationProposalSchema,
  EvaluationResult: EvaluationResultSchema,
  IntegrityReport: IntegrityReportSchema,
  TelemetryRecord: TelemetryRecordSchema,
  LessonEntry: LessonEntrySchema,
  StrategyState: StrategyStateSchema,
  ResourcePlan: ResourcePlanSchema,
  DecisionLogEntry: DecisionLogEntrySchema,
  // Addendum v2
  GenomeConfig: GenomeConfigSchema,
  MutationLocus: MutationLocusSchema,
  AcquisitionProvenance: AcquisitionProvenanceSchema,
  FrozenSplit: FrozenSplitSchema,
  DataProvenance: DataProvenanceSchema,
  EvalSuite: EvalSuiteSchema,
  Domain: DomainSchema,
  MetricSpec: MetricSpecSchema,
  MetricRegistry: MetricRegistrySchema,
  BenchmarkUpgrade: BenchmarkUpgradeSchema,
  BenchmarkUpgradeProposal: BenchmarkUpgradeProposalSchema,
  ExpansionPolicy: ExpansionPolicySchema,
  SotaSource: SotaSourceSchema,
  AngleRegistry: AngleRegistrySchema,
  CoverageTarget: CoverageTargetSchema,
  // Consensus pass 2
  BenchmarkRescore: BenchmarkRescoreSchema,
  AngleVsSOTA: AngleVsSOTASchema,
  // Q2
  GenomeSeedAdapterReport: GenomeSeedAdapterReportSchema,
  // Gotcha knowledge layer
  GotchaEntry: GotchaEntrySchema,
  CapabilityProfile: CapabilityProfileSchema,
  // Signal bus
  Signal: SignalSchema,
  // Lifecycle domain model (1.1)
  Campaign: CampaignSchema,
  MissionAttempt: MissionAttemptSchema,
  Mission: MissionSchema,
  Run: RunSchema,
  Tick: TickSchema,
} as const;
