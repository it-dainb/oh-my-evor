/**
 * tests/wave2-bugs.test.ts
 *
 * Proves three wave-2 bugs identified by cross-checking the TS contracts and
 * tool logic against the Python harness (harness/evor/contracts.py):
 *
 * Bug E (HIGH): IntegrityReport.checks missing `structure_ok` field.
 *   Python IntegrityChecks has `structure_ok: Optional[bool] = None`.
 *   The TS IntegrityReportSchema.checks object did not include it, so any
 *   IntegrityReport parsed by the TS side (e.g. from integrity_bridge.py)
 *   silently dropped the field — Zod .parse() with a strict-schema child would
 *   fail, or with passthrough would strip it.
 *
 * Bug F (MED): MetricSpecSchema missing four fields present in Python MetricSpec.
 *   Python defines fitness_formula, fbeta, constraints, custom_metrics.
 *   The TS schema only had the six base fields; GoalContracts carrying composite
 *   or constrained MetricSpecs would fail validation or lose their configuration.
 *
 * Bug G (HIGH): recordEval does not write the integrity verdict back to the
 *   TreeNode's integrity_status field in tree.json.  After calling the integrity
 *   bridge and getting verdict "passed" or "failed", the node stays at
 *   integrity_status: "pending" forever.  The stop-hook drift-guard and any
 *   downstream consumer that reads tree.json for integrity status would see the
 *   wrong value.
 *
 * Each test FAILS before the corresponding fix and PASSES after.
 */

import { vi } from "vitest";

// ── Mock callBridge for Bug G test — must be declared before any imports ─────

const bridgeMock = vi.hoisted(() => ({
  verdict: null as string | null,
}));

vi.mock("../src/subprocess-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/subprocess-bridge.js")>();
  return {
    ...actual,
    callBridge: vi.fn((..._args: unknown[]) => {
      if (bridgeMock.verdict !== null) {
        return {
          ok: true,
          data: { verdict: bridgeMock.verdict, node_id: "mock-node" },
        };
      }
      // default: simulate bridge unavailable (no Python harness in test env)
      return { ok: false, error: "python not available in test env" };
    }),
  };
});

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { IntegrityReportSchema, MetricSpecSchema } from "../src/contracts.js";
import { recordEval } from "../src/tools/record.js";
import { readTree, writeTree } from "../src/tree-store.js";
import { ensureRunDirs } from "../src/run-store.js";
import type { TreeNode } from "../src/contracts.js";

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeNode(id: string, overrides?: Partial<TreeNode>): TreeNode {
  return {
    id,
    parent_ids: [],
    approach_family: "arch",
    hypothesis_id: "h-1",
    code_ref: "sha:abc",
    genome_ref: "sha:genome",
    data_version_ref: "sha:data",
    config: {},
    metrics: {},
    eval_version: "v1",
    lesson_ids: [],
    citations: [],
    integrity_status: "pending",
    status: "done",
    is_crossover: false,
    visit_count: 1,
    depth: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeResult(nodeId: string, runId: string) {
  return {
    node_id: nodeId,
    run_id: runId,
    eval_version: "v1",
    metrics: { accuracy: 0.88 },
    per_domain: {},
    fitness_value: 0.88,
    telemetry_summary: { total_steps: 50 },
    status: "success" as const,
    benchmark_raw: "{}",
    timestamp: new Date().toISOString(),
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-wave2-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
  bridgeMock.verdict = null; // reset per test
});

afterEach(() => {
  bridgeMock.verdict = null;
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Bug E — IntegrityReport.checks missing structure_ok
// ════════════════════════════════════════════════════════════════════════════

describe("Bug E: IntegrityReportSchema.checks missing structure_ok field", () => {
  it("accepts a report with structure_ok: true (would fail before fix)", () => {
    // Python integrity_bridge.py can emit structure_ok in the checks object.
    // Before fix: Zod strict-mode parsing strips / rejects it.
    // After fix: field is accepted and round-trips correctly.
    const raw = {
      node_id: randomUUID(),
      eval_version: "v1",
      checks: {
        split_hash_match: true,
        frozen_split_read_only: true,
        no_test_leakage: true,
        near_dup_leakage: false,
        data_provenance_valid: true,
        no_label_contamination: true,
        no_eval_shift: true,
        eval_version_consistent: true,
        telemetry_sane: true,
        reward_hacking_probe: false,
        acquisition_contamination_clear: null,
        acquired_data_provenance_valid: null,
        acquisition_namespace_enforced: null,
        structure_ok: true, // BUG: stripped / rejected before fix
      },
      verdict: "passed",
      verified_at: new Date().toISOString(),
    };

    // BUG (before fix): parse throws or strips structure_ok → not present in result
    // AFTER FIX: parses cleanly and structure_ok is preserved
    const parsed = IntegrityReportSchema.parse(raw);
    expect(parsed.checks.structure_ok).toBe(true);
  });

  it("accepts a report with structure_ok: null (gate not run)", () => {
    const raw = {
      node_id: randomUUID(),
      eval_version: "v1",
      checks: {
        split_hash_match: false,
        frozen_split_read_only: true,
        no_test_leakage: true,
        near_dup_leakage: false,
        data_provenance_valid: true,
        no_label_contamination: true,
        no_eval_shift: true,
        eval_version_consistent: true,
        telemetry_sane: true,
        reward_hacking_probe: false,
        acquisition_contamination_clear: null,
        acquired_data_provenance_valid: null,
        acquisition_namespace_enforced: null,
        structure_ok: null,
      },
      verdict: "failed",
      failure_reason: "split_hash_match failed",
      verified_at: new Date().toISOString(),
    };

    const parsed = IntegrityReportSchema.parse(raw);
    expect(parsed.checks.structure_ok).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Bug F — MetricSpecSchema missing fitness_formula / fbeta / constraints / custom_metrics
// ════════════════════════════════════════════════════════════════════════════

describe("Bug F: MetricSpecSchema missing composite / constrained / F-beta / custom fields", () => {
  it("accepts a composite MetricSpec with fitness_formula (would strip before fix)", () => {
    const raw = {
      metric_name: "composite",
      direction: "higher",
      domain_applicability: "all",
      aggregation_rule: "macro_avg",
      role: "primary_fitness",
      fitness_formula: "0.7*recall+0.3*precision",
    };

    // BUG (before fix): fitness_formula is stripped by Zod (unknown key).
    // AFTER FIX: field is preserved in the parsed object.
    const parsed = MetricSpecSchema.parse(raw);
    expect(parsed.fitness_formula).toBe("0.7*recall+0.3*precision");
  });

  it("accepts an F-beta MetricSpec with fbeta field (would strip before fix)", () => {
    const raw = {
      metric_name: "fbeta",
      direction: "higher",
      domain_applicability: ["en"],
      aggregation_rule: "macro_avg",
      role: "primary_fitness",
      fbeta: 2.0,
    };

    const parsed = MetricSpecSchema.parse(raw);
    expect(parsed.fbeta).toBe(2.0);
  });

  it("accepts a constrained MetricSpec with constraints array (would strip before fix)", () => {
    const raw = {
      metric_name: "recall",
      direction: "higher",
      domain_applicability: "all",
      aggregation_rule: "macro_avg",
      role: "primary_fitness",
      constraints: [
        { metric: "precision", op: ">=", threshold: 0.5 },
      ],
    };

    const parsed = MetricSpecSchema.parse(raw);
    expect(parsed.constraints).toHaveLength(1);
    expect(parsed.constraints[0].metric).toBe("precision");
    expect(parsed.constraints[0].op).toBe(">=");
    expect(parsed.constraints[0].threshold).toBe(0.5);
  });

  it("accepts a custom MetricSpec with custom_metrics list (would strip before fix)", () => {
    const raw = {
      metric_name: "accuracy",
      direction: "higher",
      domain_applicability: "all",
      aggregation_rule: "macro_avg",
      role: "secondary_reported",
      custom_metrics: ["my_ndcg", "bleu"],
    };

    const parsed = MetricSpecSchema.parse(raw);
    expect(parsed.custom_metrics).toEqual(["my_ndcg", "bleu"]);
  });

  it("constraints and custom_metrics default to empty arrays (backward compat)", () => {
    const raw = {
      metric_name: "accuracy",
      direction: "higher",
      domain_applicability: "all",
      aggregation_rule: "macro_avg",
      role: "primary_fitness",
    };

    const parsed = MetricSpecSchema.parse(raw);
    expect(parsed.constraints).toEqual([]);
    expect(parsed.custom_metrics).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Bug G — recordEval does not write integrity verdict back to tree.json
// ════════════════════════════════════════════════════════════════════════════

describe("Bug G: recordEval does not backwrite integrity_status to tree.json", () => {
  it('node integrity_status updated to "passed" in tree.json after bridge returns passed', () => {
    const runId = "run-backwrite-passed";
    const nodeId = randomUUID();
    const paths = ensureRunDirs(runId, "test-mission");

    // Pre-write node to tree.json with integrity_status: "pending"
    const node = makeNode(nodeId, { integrity_status: "pending" });
    writeTree(runId, { [nodeId]: node });

    // Simulate bridge returning a "passed" verdict
    bridgeMock.verdict = "passed";

    recordEval(runId, nodeId, makeResult(nodeId, runId));

    // BUG (before fix): node.integrity_status stays "pending" in tree.json
    // AFTER FIX: integrity_status is updated to "passed"
    const updatedNodes = readTree(runId);
    expect(updatedNodes[nodeId].integrity_status).toBe("passed");
  });

  it('node integrity_status updated to "failed" in tree.json after bridge returns failed', () => {
    const runId = "run-backwrite-failed";
    const nodeId = randomUUID();
    ensureRunDirs(runId, "test-mission");

    const node = makeNode(nodeId, { integrity_status: "pending" });
    writeTree(runId, { [nodeId]: node });

    bridgeMock.verdict = "failed";

    recordEval(runId, nodeId, makeResult(nodeId, runId));

    const updatedNodes = readTree(runId);
    expect(updatedNodes[nodeId].integrity_status).toBe("failed");
  });

  it("integrity_status stays pending when bridge is unavailable (best-effort, no throw)", () => {
    // Bridge unavailable (verdict = null → mock returns ok: false).
    // Node should remain "pending" and recordEval should not throw.
    const runId = "run-backwrite-unavail";
    const nodeId = randomUUID();
    ensureRunDirs(runId, "test-mission");

    const node = makeNode(nodeId, { integrity_status: "pending" });
    writeTree(runId, { [nodeId]: node });

    bridgeMock.verdict = null; // bridge fails

    expect(() => recordEval(runId, nodeId, makeResult(nodeId, runId))).not.toThrow();

    const updatedNodes = readTree(runId);
    expect(updatedNodes[nodeId].integrity_status).toBe("pending");
  });

  it("backwrite is a no-op (non-fatal) when node does not exist in tree.json", () => {
    // recordEval may be called before recordNode in some workflows.
    // The backwrite should not throw when the node is absent from tree.json.
    const runId = "run-backwrite-no-node";
    const nodeId = randomUUID();
    ensureRunDirs(runId, "test-mission");
    // Do NOT write the node to tree.json (absent)

    bridgeMock.verdict = "passed";

    expect(() => recordEval(runId, nodeId, makeResult(nodeId, runId))).not.toThrow();
  });
});
