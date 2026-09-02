/**
 * mcp/tests/schemas.test.ts — L2 unit tests for contracts.ts and tree-store.ts
 *
 * Schema tests verify round-trip parse and invalid-input rejection for the key
 * data contracts. Tree-store tests verify the atomic write/read/upsert path.
 *
 * Tool coverage (all 12 registered tools):
 *   evor_record_node      → TreeNodeSchema
 *   evor_record_eval      → EvaluationResultSchema
 *   evor_tree_read        → run_id / subtree / depth params (z.string, z.number)
 *   evor_select           → StrategyStateSchema (partial)
 *   evor_state_read       → run_id param
 *   evor_state_write      → StrategyStateSchema (partial) via RunStatePatch
 *   evor_integrity_check  → z.string params
 *   evor_telemetry_ingest → TelemetryRecordSchema
 *   evor_cite             → z.string.min(1)
 *   evor_schedule         → JobSpec (validated inline)
 *   evor_wiki_add         → LessonEntrySchema
 *   evor_wiki_query       → ApproachFamilySchema
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ApproachFamilySchema,
  GoalContractSchema,
  TreeNodeSchema,
  MutationProposalSchema,
  AcquisitionProvenanceSchema,
  AngleRegistrySchema,
  StrategyStateSchema,
  BenchmarkUpgradeSchema,
  EvaluationResultSchema,
  TelemetryRecordSchema,
  LessonEntrySchema,
} from "../src/contracts.js";
import { readTree, writeTree, upsertNode } from "../src/tree-store.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ISO_TS = "2026-01-01T00:00:00Z";
const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const VALID_METRIC_SPEC = {
  metric_name: "accuracy",
  direction: "higher" as const,
  domain_applicability: "all" as const,
  aggregation_rule: "macro_avg" as const,
  role: "primary_fitness" as const,
};

/** Minimal valid TreeNode; used by both schema tests and tree-store tests. */
const VALID_NODE_RAW = {
  id: UUID_A,
  parent_ids: [],
  approach_family: "arch",
  hypothesis_id: "h-001",
  code_ref: "sha256:abc",
  genome_ref: "sha256:def",
  data_version_ref: "sha256:ghi",
  config: { lr: 0.001 },
  metrics: { accuracy: 0.85 },
  eval_version: "v1",
  lesson_ids: [],
  citations: [],
  integrity_status: "passed",
  status: "done",
  is_crossover: false,
  visit_count: 0,
  depth: 0,
  created_at: ISO_TS,
};

// ─── ApproachFamily ───────────────────────────────────────────────────────────

describe("ApproachFamily", () => {
  const VALID_TAGS = [
    "arch",
    "training",
    "data-curation",
    "data-augmentation",
    "data-acquisition",
    "algo",
    "other",
  ] as const;

  it.each(VALID_TAGS)('accepts tag "%s"', (tag) => {
    expect(ApproachFamilySchema.parse(tag)).toBe(tag);
  });

  it("rejects the legacy 'augmentation' tag (must be 'data-augmentation')", () => {
    expect(() => ApproachFamilySchema.parse("augmentation")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => ApproachFamilySchema.parse("")).toThrow();
  });

  it("rejects a completely unknown tag", () => {
    expect(() => ApproachFamilySchema.parse("vision")).toThrow();
  });
});

// ─── GoalContract ─────────────────────────────────────────────────────────────

describe("GoalContract", () => {
  const VALID: Record<string, unknown> = {
    mission_id: "m-001",
    mode: "from-scratch",
    mission_type: "fixed",
    task_description: "Train image classifier on CIFAR-10 subset",
    dataset_ref: "s3://bucket/cifar10",
    metric_specs: [VALID_METRIC_SPEC],
    fitness_mode: "aggregate",
    eval_version: "v1",
    baseline_value: 0.72,
    stop_condition: { type: "beat-baseline" },
    wildness: 0.5,
    budget: {
      max_iterations: 50,
      plateau_window: 8,
      circuit_breaker: 5,
      max_cost_usd: 100.0,
    },
    locked_split_hash: "abc123",
    eval_script_hash: "def456",
    allowed_licenses: ["MIT", "Apache-2.0"],
    created_at: ISO_TS,
  };

  it("round-trips a valid GoalContract", () => {
    const result = GoalContractSchema.parse(VALID);
    expect(result.mission_id).toBe("m-001");
    expect(result.mission_type).toBe("fixed");
    expect(result.metric_specs[0].role).toBe("primary_fitness");
  });

  it("accepts mission_type 'open_ended'", () => {
    const result = GoalContractSchema.parse({ ...VALID, mission_type: "open_ended" });
    expect(result.mission_type).toBe("open_ended");
  });

  it("accepts all valid stop_condition types", () => {
    const types = [
      "beat-baseline", "beat-sota", "target", "maximize-under-budget",
      "evolve-n", "evolve-until-plateau", "evolve-until-regression",
      "worst-angle-plateau", "coverage-target",
    ];
    for (const type of types) {
      const r = GoalContractSchema.parse({ ...VALID, stop_condition: { type } });
      expect(r.stop_condition.type).toBe(type);
    }
  });

  it("rejects invalid mode", () => {
    expect(() => GoalContractSchema.parse({ ...VALID, mode: "clone" })).toThrow();
  });

  it("rejects wildness > 1", () => {
    expect(() => GoalContractSchema.parse({ ...VALID, wildness: 1.5 })).toThrow();
  });

  it("rejects wildness < 0", () => {
    expect(() => GoalContractSchema.parse({ ...VALID, wildness: -0.1 })).toThrow();
  });

  it("rejects invalid stop_condition type", () => {
    expect(() =>
      GoalContractSchema.parse({ ...VALID, stop_condition: { type: "unknown" } })
    ).toThrow();
  });

  it("rejects missing required field mission_id", () => {
    const { mission_id: _omit, ...noId } = VALID;
    expect(() => GoalContractSchema.parse(noId)).toThrow();
  });
});

// ─── TreeNode ─────────────────────────────────────────────────────────────────

describe("TreeNode", () => {
  it("round-trips a minimal valid TreeNode", () => {
    const result = TreeNodeSchema.parse(VALID_NODE_RAW);
    expect(result.id).toBe(UUID_A);
    expect(result.approach_family).toBe("arch");
    expect(result.integrity_status).toBe("passed");
  });

  it.each(["arch", "training", "data-curation", "data-augmentation", "data-acquisition", "algo", "other"] as const)(
    'accepts approach_family "%s"',
    (family) => {
      const result = TreeNodeSchema.parse({ ...VALID_NODE_RAW, approach_family: family });
      expect(result.approach_family).toBe(family);
    }
  );

  it("rejects a non-UUID id", () => {
    expect(() => TreeNodeSchema.parse({ ...VALID_NODE_RAW, id: "not-a-uuid" })).toThrow();
  });

  it("rejects the legacy 'augmentation' approach_family", () => {
    expect(() =>
      TreeNodeSchema.parse({ ...VALID_NODE_RAW, approach_family: "augmentation" })
    ).toThrow();
  });

  it("rejects invalid integrity_status", () => {
    expect(() =>
      TreeNodeSchema.parse({ ...VALID_NODE_RAW, integrity_status: "unknown" })
    ).toThrow();
  });

  it("rejects invalid status", () => {
    expect(() =>
      TreeNodeSchema.parse({ ...VALID_NODE_RAW, status: "cancelled" })
    ).toThrow();
  });

  it("rejects negative visit_count", () => {
    expect(() =>
      TreeNodeSchema.parse({ ...VALID_NODE_RAW, visit_count: -1 })
    ).toThrow();
  });

  it("optional fields are absent when not provided", () => {
    const result = TreeNodeSchema.parse(VALID_NODE_RAW);
    expect(result.fitness_value).toBeUndefined();
    expect(result.ucb1_score).toBeUndefined();
    expect(result.completed_at).toBeUndefined();
    expect(result.parent_patch_ref).toBeUndefined();
  });
});

// ─── MutationProposal ─────────────────────────────────────────────────────────

describe("MutationProposal", () => {
  const VALID: Record<string, unknown> = {
    proposal_id: "prop-001",
    parent_node_ids: [UUID_A],
    approach_family: "training",
    idea: "Switch from SGD to AdamW with weight decay 0.01",
    hypothesis: {
      id: "h-001",
      statement: "AdamW will improve convergence",
      prediction: "Val accuracy +2pp within 10 epochs",
    },
    citations: ["https://arxiv.org/abs/1711.05101"],
    wildness: 0.3,
    critic_review: {
      h001_one_hypothesis: "pass",
      h002_family_streak: "pass",
      h003_intra_tick_diversity: "pass",
      integrity_risk: "pass",
      instrumentation_check: "pass",
      schema_valid: "pass",
      verdict: "approved",
    },
  };

  it("round-trips a valid MutationProposal", () => {
    const result = MutationProposalSchema.parse(VALID);
    expect(result.proposal_id).toBe("prop-001");
    expect(result.critic_review.verdict).toBe("approved");
  });

  it.each(["arch", "training", "data-curation", "data-augmentation", "data-acquisition", "algo", "other"] as const)(
    'accepts all 7 approach_family tags — "%s"',
    (family) => {
      const result = MutationProposalSchema.parse({ ...VALID, approach_family: family });
      expect(result.approach_family).toBe(family);
    }
  );

  it("accepts rejected verdict with rejection_reason", () => {
    const result = MutationProposalSchema.parse({
      ...VALID,
      critic_approved: false,
      critic_review: {
        ...(VALID.critic_review as object),
        h002_family_streak: "fail",
        verdict: "rejected",
        rejection_reason: "Family streak limit exceeded",
      },
    });
    expect(result.critic_review.verdict).toBe("rejected");
    expect(result.critic_review.rejection_reason).toBe("Family streak limit exceeded");
  });

  it("rejects invalid verdict value", () => {
    expect(() =>
      MutationProposalSchema.parse({
        ...VALID,
        critic_review: { ...(VALID.critic_review as object), verdict: "pending" },
      })
    ).toThrow();
  });

  it("rejects wildness > 1", () => {
    expect(() => MutationProposalSchema.parse({ ...VALID, wildness: 1.1 })).toThrow();
  });
});

// ─── AcquisitionProvenance ───────────────────────────────────────────────────

describe("AcquisitionProvenance", () => {
  const VALID: Record<string, unknown> = {
    acquisition_id: "acq-001",
    acquisition_type: "external",
    license_identifier: "CC-BY-4.0",
    license_in_allowlist: true,
    citation: "Common Crawl 2024-01 snapshot",
    sample_count: 50000,
    acquired_at: ISO_TS,
    ingestion_contamination_cleared: true,
  };

  it("round-trips a valid AcquisitionProvenance (external)", () => {
    const result = AcquisitionProvenanceSchema.parse(VALID);
    expect(result.acquisition_id).toBe("acq-001");
    expect(result.acquisition_type).toBe("external");
    expect(result.license_in_allowlist).toBe(true);
  });

  it("accepts synthetic acquisition_type with generator_config", () => {
    const result = AcquisitionProvenanceSchema.parse({
      ...VALID,
      acquisition_type: "synthetic",
      generator_config: { model: "gpt-4o", temperature: 0.7 },
    });
    expect(result.acquisition_type).toBe("synthetic");
    expect(result.generator_config).toEqual({ model: "gpt-4o", temperature: 0.7 });
  });

  it("rejects invalid acquisition_type", () => {
    expect(() =>
      AcquisitionProvenanceSchema.parse({ ...VALID, acquisition_type: "crowd-sourced" })
    ).toThrow();
  });

  it("rejects negative sample_count", () => {
    expect(() =>
      AcquisitionProvenanceSchema.parse({ ...VALID, sample_count: -1 })
    ).toThrow();
  });
});

// ─── AngleRegistry ────────────────────────────────────────────────────────────

describe("AngleRegistry", () => {
  const VALID_ANGLE = {
    angle_id: "angle-cifar10-acc",
    eval_version_added: "v1",
    sota_bar: 0.985,
    sota_source_ids: ["src-paperswithcode", "src-mlcommons"],
    sota_quorum_met: true,
    baseline_model_score_before_finetune: null,
    sota_retrieved_at: ISO_TS,
    held_out_split_hash: "sha256:xyz",
    is_public_benchmark: true,
    pretraining_contamination_risk: "medium",
  };

  it("round-trips a valid AngleRegistry with one angle", () => {
    const result = AngleRegistrySchema.parse({
      mission_id: "m-001",
      angles: [VALID_ANGLE],
      updated_at: ISO_TS,
    });
    expect(result.angles).toHaveLength(1);
    expect(result.angles[0].sota_quorum_met).toBe(true);
  });

  it("accepts an empty angles array", () => {
    const result = AngleRegistrySchema.parse({
      mission_id: "m-001",
      angles: [],
      updated_at: ISO_TS,
    });
    expect(result.angles).toHaveLength(0);
  });

  it("accepts null baseline_model_score_before_finetune", () => {
    const result = AngleRegistrySchema.parse({
      mission_id: "m-001",
      angles: [{ ...VALID_ANGLE, baseline_model_score_before_finetune: null }],
      updated_at: ISO_TS,
    });
    expect(result.angles[0].baseline_model_score_before_finetune).toBeNull();
  });

  it("accepts a numeric baseline_model_score_before_finetune once evaluated", () => {
    const result = AngleRegistrySchema.parse({
      mission_id: "m-001",
      angles: [{ ...VALID_ANGLE, baseline_model_score_before_finetune: 0.82 }],
      updated_at: ISO_TS,
    });
    expect(result.angles[0].baseline_model_score_before_finetune).toBe(0.82);
  });

  it("rejects invalid pretraining_contamination_risk", () => {
    expect(() =>
      AngleRegistrySchema.parse({
        mission_id: "m-001",
        angles: [{ ...VALID_ANGLE, pretraining_contamination_risk: "extreme" }],
        updated_at: ISO_TS,
      })
    ).toThrow();
  });
});

// ─── StrategyState ────────────────────────────────────────────────────────────

describe("StrategyState", () => {
  const VALID: Record<string, unknown> = {
    meta_iteration: 0,
    selection_policy: "ucb1",
    ucb1_c: 1.41,
    wildness: 0.5,
    family_mix: { arch: 0.5, training: 0.5 },
    winning_families: ["arch"],
    wins_by_family: { arch: 3 },
    meta_loop_interval: 5,
    post_upgrade_exploration_boost: null,
    post_upgrade_exploration_ticks: 0,
    rescore_mode: "sync",
    updated_at: ISO_TS,
  };

  it("round-trips a valid StrategyState", () => {
    const result = StrategyStateSchema.parse(VALID);
    expect(result.selection_policy).toBe("ucb1");
    expect(result.rescore_mode).toBe("sync");
    expect(result.ucb1_c).toBe(1.41);
  });

  it("accepts null post_upgrade_exploration_boost (no boost active)", () => {
    const result = StrategyStateSchema.parse(VALID);
    expect(result.post_upgrade_exploration_boost).toBeNull();
  });

  it("accepts non-null post_upgrade_exploration_boost with ticks > 0", () => {
    const result = StrategyStateSchema.parse({
      ...VALID,
      post_upgrade_exploration_boost: 2.0,
      post_upgrade_exploration_ticks: 8,
    });
    expect(result.post_upgrade_exploration_boost).toBe(2.0);
    expect(result.post_upgrade_exploration_ticks).toBe(8);
  });

  it('accepts rescore_mode "async" (Q1 — single source of truth)', () => {
    const result = StrategyStateSchema.parse({ ...VALID, rescore_mode: "async" });
    expect(result.rescore_mode).toBe("async");
  });

  it("accepts 'mcts' and 'beam' selection policies", () => {
    expect(StrategyStateSchema.parse({ ...VALID, selection_policy: "mcts" }).selection_policy).toBe("mcts");
    expect(StrategyStateSchema.parse({ ...VALID, selection_policy: "beam" }).selection_policy).toBe("beam");
  });

  it("rejects invalid selection_policy", () => {
    expect(() =>
      StrategyStateSchema.parse({ ...VALID, selection_policy: "greedy" })
    ).toThrow();
  });

  it("rejects invalid rescore_mode", () => {
    expect(() =>
      StrategyStateSchema.parse({ ...VALID, rescore_mode: "eager" })
    ).toThrow();
  });

  it("rejects negative post_upgrade_exploration_ticks", () => {
    expect(() =>
      StrategyStateSchema.parse({ ...VALID, post_upgrade_exploration_ticks: -1 })
    ).toThrow();
  });

  it("rejects invalid approach_family key in family_mix", () => {
    expect(() =>
      StrategyStateSchema.parse({ ...VALID, family_mix: { invalid_family: 0.5 } })
    ).toThrow();
  });
});

// ─── BenchmarkUpgrade ─────────────────────────────────────────────────────────

describe("BenchmarkUpgrade", () => {
  const VALID: Record<string, unknown> = {
    upgrade_id: "upg-001",
    mission_id: "m-001",
    from_eval_version: "v1",
    to_eval_version: "v2",
    proposed_by: "probe",
    proposal_citations: ["https://arxiv.org/abs/2101.00001"],
    consent_granted: true,
    new_domains_added: ["tabular-churn"],
    domains_removed: [], // DEFENSIVE INVARIANT: always empty per Q4
    rescore_status: "pending",
    rescore_deadline_ticks: 10,
    decision_log_ref: "decision-log.md",
    created_at: ISO_TS,
  };

  it("round-trips a valid BenchmarkUpgrade with empty domains_removed", () => {
    const result = BenchmarkUpgradeSchema.parse(VALID);
    expect(result.upgrade_id).toBe("upg-001");
    expect(result.domains_removed).toHaveLength(0); // invariant
    expect(result.rescore_status).toBe("pending");
  });

  it("accepts all valid rescore_status values", () => {
    for (const status of ["pending", "in_progress", "complete", "partial"]) {
      const r = BenchmarkUpgradeSchema.parse({ ...VALID, rescore_status: status });
      expect(r.rescore_status).toBe(status);
    }
  });

  it("accepts optional consent_at timestamp", () => {
    const result = BenchmarkUpgradeSchema.parse({ ...VALID, consent_at: ISO_TS });
    expect(result.consent_at).toBe(ISO_TS);
  });

  it("accepts all valid proposed_by values", () => {
    for (const proposer of ["user", "probe", "sage", "policy"]) {
      const r = BenchmarkUpgradeSchema.parse({ ...VALID, proposed_by: proposer });
      expect(r.proposed_by).toBe(proposer);
    }
  });

  it("rejects invalid proposed_by", () => {
    expect(() =>
      BenchmarkUpgradeSchema.parse({ ...VALID, proposed_by: "admin" })
    ).toThrow();
  });

  it("rejects invalid rescore_status", () => {
    expect(() =>
      BenchmarkUpgradeSchema.parse({ ...VALID, rescore_status: "done" })
    ).toThrow();
  });

  it("rejects negative rescore_deadline_ticks", () => {
    expect(() =>
      BenchmarkUpgradeSchema.parse({ ...VALID, rescore_deadline_ticks: -1 })
    ).toThrow();
  });
});

// ─── EvaluationResult (used by evor_record_eval) ─────────────────────────────

describe("EvaluationResult", () => {
  const VALID: Record<string, unknown> = {
    node_id: UUID_A,
    run_id: "run-001",
    eval_version: "v1",
    metrics: { accuracy: 0.87 },
    per_domain: { cifar10: { accuracy: 0.87 } },
    fitness_value: 0.87,
    telemetry_summary: { total_steps: 1000 },
    status: "success",
    benchmark_raw: '{"accuracy": 0.87}',
    timestamp: ISO_TS,
  };

  it("round-trips a valid EvaluationResult", () => {
    const result = EvaluationResultSchema.parse(VALID);
    expect(result.status).toBe("success");
    expect(result.fitness_value).toBe(0.87);
  });

  it("accepts all valid status values", () => {
    for (const status of ["success", "regression", "error", "timeout", "oom"]) {
      const r = EvaluationResultSchema.parse({ ...VALID, status });
      expect(r.status).toBe(status);
    }
  });

  it("rejects invalid status", () => {
    expect(() => EvaluationResultSchema.parse({ ...VALID, status: "running" })).toThrow();
  });
});

// ─── TelemetryRecord (used by evor_telemetry_ingest) ─────────────────────────

describe("TelemetryRecord", () => {
  const VALID: Record<string, unknown> = {
    step: 100,
    train_loss: 0.45,
    node_id: UUID_A,
    run_id: "run-001",
    timestamp: ISO_TS,
  };

  it("round-trips a minimal valid TelemetryRecord", () => {
    const result = TelemetryRecordSchema.parse(VALID);
    expect(result.step).toBe(100);
    expect(result.train_loss).toBe(0.45);
  });

  it("rejects negative step count", () => {
    expect(() => TelemetryRecordSchema.parse({ ...VALID, step: -1 })).toThrow();
  });

  it("rejects gpu_util above 100", () => {
    expect(() => TelemetryRecordSchema.parse({ ...VALID, gpu_util: 101 })).toThrow();
  });

  it("rejects gpu_util below 0", () => {
    expect(() => TelemetryRecordSchema.parse({ ...VALID, gpu_util: -1 })).toThrow();
  });
});

// ─── LessonEntry (used by evor_wiki_add / evor_wiki_query) ───────────────────

describe("LessonEntry", () => {
  const VALID: Record<string, unknown> = {
    lesson_id: "lesson-001",
    node_id: UUID_A,
    run_id: "run-001",
    mission_id: "m-001",
    approach_family: "algo",
    hypothesis_verdict: "confirmed",
    observation: "AdamW converged 2x faster than SGD on transformer baseline",
    actionable_lesson: "Default to AdamW with wd=0.01 for transformer experiments",
    citations: ["https://arxiv.org/abs/1711.05101"],
    tags: ["optimizer", "convergence"],
    created_at: ISO_TS,
  };

  it("round-trips a valid LessonEntry", () => {
    const result = LessonEntrySchema.parse(VALID);
    expect(result.lesson_id).toBe("lesson-001");
    expect(result.hypothesis_verdict).toBe("confirmed");
  });

  it("accepts all hypothesis_verdict values", () => {
    for (const verdict of ["confirmed", "refuted", "inconclusive"]) {
      const r = LessonEntrySchema.parse({ ...VALID, hypothesis_verdict: verdict });
      expect(r.hypothesis_verdict).toBe(verdict);
    }
  });

  it("rejects invalid hypothesis_verdict", () => {
    expect(() =>
      LessonEntrySchema.parse({ ...VALID, hypothesis_verdict: "maybe" })
    ).toThrow();
  });
});

// ─── tree-store: atomic write / read / upsert ────────────────────────────────

describe("tree-store", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-test-"));
    // getEvorRoot() reads process.env.EVOR_ROOT at call time, so setting here is safe.
    process.env.EVOR_ROOT = tmpDir;
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.EVOR_ROOT;
  });

  it("readTree returns an empty map when tree.json does not exist", () => {
    const nodes = readTree("run-nonexistent", "test-mission");
    expect(nodes).toEqual({});
  });

  it("writeTree + readTree round-trips a node map", () => {
    const node = TreeNodeSchema.parse(VALID_NODE_RAW);
    writeTree("run-rw", { [node.id]: node }, "test-mission");
    const result = readTree("run-rw");
    expect(result[UUID_A]).toBeDefined();
    expect(result[UUID_A].approach_family).toBe("arch");
    expect(result[UUID_A].visit_count).toBe(0);
  });

  it("upsertNode adds a second node without overwriting the first", () => {
    const node1 = TreeNodeSchema.parse(VALID_NODE_RAW);
    const node2 = TreeNodeSchema.parse({ ...VALID_NODE_RAW, id: UUID_B, depth: 1 });
    writeTree("run-upsert", { [node1.id]: node1 }, "test-mission");
    upsertNode("run-upsert", node2);
    const result = readTree("run-upsert");
    expect(Object.keys(result)).toHaveLength(2);
    expect(result[UUID_A]).toBeDefined();
    expect(result[UUID_B].depth).toBe(1);
  });

  it("writeTree is idempotent on repeated writes to the same run", () => {
    const node = TreeNodeSchema.parse(VALID_NODE_RAW);
    writeTree("run-idempotent", { [node.id]: node }, "test-mission");
    writeTree("run-idempotent", { [node.id]: node }, "test-mission");
    const result = readTree("run-idempotent");
    expect(Object.keys(result)).toHaveLength(1);
    expect(result[UUID_A].id).toBe(UUID_A);
  });

  it("upsertNode overwrites a node with the same id", () => {
    const node = TreeNodeSchema.parse(VALID_NODE_RAW);
    writeTree("run-overwrite", { [node.id]: node }, "test-mission");
    const updated = TreeNodeSchema.parse({ ...VALID_NODE_RAW, visit_count: 5 });
    upsertNode("run-overwrite", updated);
    const result = readTree("run-overwrite");
    expect(result[UUID_A].visit_count).toBe(5);
  });
});
