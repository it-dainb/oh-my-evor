/**
 * tests/record.test.ts
 * Unit tests for tools/record.ts: recordNode + recordEval
 *
 * Isolated via EVOR_ROOT pointing to a per-test tmpdir.
 * callBridge (integrity) is expected to fail gracefully in test env.
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { recordNode, recordEval, readRunState, writeRunState, fillNodeId } from "../src/tools/record.js";
import { ensureRunDirs } from "../src/run-store.js";
import { writeTree } from "../src/tree-store.js";
import type { TreeNode } from "../src/contracts.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeNode(overrides?: Partial<TreeNode>): TreeNode {
  return {
    id: randomUUID(),
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
    status: "pending",
    is_crossover: false,
    visit_count: 0,
    depth: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Test lifecycle ──────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-record-test-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
});

afterEach(() => {
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── recordNode ──────────────────────────────────────────────────────────────

describe("recordNode", () => {
  it("writes node to tree.json", () => {
    const runId = "run-001";
    const node = makeNode({ depth: 1 });

    const { treePath } = recordNode(runId, node, "test-mission");

    expect(existsSync(treePath)).toBe(true);
    const tree = JSON.parse(readFileSync(treePath, "utf8"));
    expect(tree.nodes).toHaveProperty(node.id);
    expect(tree.nodes[node.id].depth).toBe(1);
  });

  it("creates run directory if it does not exist", () => {
    const runId = "run-002";
    const node = makeNode();
    recordNode(runId, node, "test-mission");
    expect(existsSync(join(tmpRoot, "runs", "test-mission", runId, "tree.json"))).toBe(true);
  });

  it("appends to decision-log.md", () => {
    const runId = "run-003";
    const node = makeNode({ approach_family: "training" });
    recordNode(runId, node, "test-mission");
    const logPath = join(tmpRoot, "runs", "test-mission", runId, "decision-log.md");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain(node.id);
    expect(log).toContain("training");
  });

  it("removes node_id from pending_node_ids in run-state.json", () => {
    const runId = "run-004";
    const node = makeNode();

    // Bootstrap run dirs and pre-populate pending_node_ids
    const paths = ensureRunDirs(runId, "test-mission");
    writeRunState(paths.runStatePath, {
      run_id: runId,
      status: "running",
      tick_count: 0,
      best_score: null,
      frontier_ids: [],
      current_eval_version: "v1",
      pending_node_ids: [node.id, "other-node"],
    });

    const { pendingRemaining } = recordNode(runId, node, "test-mission");

    expect(pendingRemaining).toBe(1);
    const state = readRunState(paths.runStatePath, runId);
    expect(state.pending_node_ids).toEqual(["other-node"]);
  });

  it("handles missing run-state.json gracefully (fresh state)", () => {
    const runId = "run-005";
    const node = makeNode();
    const { pendingRemaining } = recordNode(runId, node, "test-mission");
    expect(pendingRemaining).toBe(0);
  });

  it("second recordNode call upserts the same node", () => {
    const runId = "run-006";
    const node = makeNode({ metrics: { acc: 0.5 } });
    recordNode(runId, node, "test-mission");
    const updated: TreeNode = { ...node, metrics: { acc: 0.9 }, status: "done" };
    recordNode(runId, updated, "test-mission");

    const tree = JSON.parse(
      readFileSync(join(tmpRoot, "runs", "test-mission", runId, "tree.json"), "utf8")
    );
    expect(tree.nodes[node.id].metrics.acc).toBe(0.9);
    expect(tree.nodes[node.id].status).toBe("done");
  });
});

// ── recordEval ──────────────────────────────────────────────────────────────

describe("recordEval", () => {
  const makeResult = (nodeId: string, runId: string) => ({
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
  });

  it("writes results.json to nodes/<nodeId>/", () => {
    const runId = "run-eval-001";
    const nodeId = randomUUID();
    const result = makeResult(nodeId, runId);

    const { resultsPath } = recordEval(runId, nodeId, result, "test-mission");

    expect(existsSync(resultsPath)).toBe(true);
    const written = JSON.parse(readFileSync(resultsPath, "utf8"));
    expect(written.metrics.accuracy).toBe(0.88);
    expect(written.status).toBe("success");
  });

  it("creates node directory when absent", () => {
    const runId = "run-eval-002";
    const nodeId = randomUUID();
    const { resultsPath } = recordEval(runId, nodeId, makeResult(nodeId, runId), "test-mission");
    expect(existsSync(resultsPath)).toBe(true);
  });

  it("returns null integrity_verdict when bridge unavailable (best-effort)", () => {
    const runId = "run-eval-003";
    const nodeId = randomUUID();
    // bridge will fail in test env (no Python harness) — must not throw
    const { integrityVerdict } = recordEval(runId, nodeId, makeResult(nodeId, runId), "test-mission");
    expect(integrityVerdict).toBeNull();
  });

  it("overwrites existing results.json on repeated call", () => {
    const runId = "run-eval-004";
    const nodeId = randomUUID();
    recordEval(runId, nodeId, { ...makeResult(nodeId, runId), metrics: { accuracy: 0.5 } }, "test-mission");
    const { resultsPath } = recordEval(runId, nodeId, { ...makeResult(nodeId, runId), metrics: { accuracy: 0.9 } }, "test-mission");
    const written = JSON.parse(readFileSync(resultsPath, "utf8"));
    expect(written.metrics.accuracy).toBe(0.9);
  });

  // ── P0-5: eval→tree status cascade ─────────────────────────────────────────

  it("P0-5: cascades status to 'done' on the tree node after recordEval (integrity passed)", () => {
    const runId = "run-eval-p05-a";
    const node = makeNode({ status: "running" });

    // Pre-populate the tree with a running node
    recordNode(runId, node, "test-mission");

    // Run recordEval — bridge will fail (no Python) but status must still flip
    recordEval(runId, node.id, makeResult(node.id, runId), "test-mission");

    const treePath = join(tmpRoot, "runs", "test-mission", runId, "tree.json");
    const tree = JSON.parse(readFileSync(treePath, "utf8"));
    expect(tree.nodes[node.id].status).toBe("done");
  });

  it("P0-5: sets status 'done' even when integrity bridge returns null (bridge failed)", () => {
    const runId = "run-eval-p05-b";
    const node = makeNode({ status: "running" });

    recordNode(runId, node, "test-mission");

    // bridge fails in test env — integrityVerdict will be null
    const { integrityVerdict } = recordEval(runId, node.id, makeResult(node.id, runId), "test-mission");
    expect(integrityVerdict).toBeNull();

    const treePath = join(tmpRoot, "runs", "test-mission", runId, "tree.json");
    const tree = JSON.parse(readFileSync(treePath, "utf8"));
    expect(tree.nodes[node.id].status).toBe("done");
  });

  it("P0-5: does not throw when tree node does not exist (no prior recordNode call)", () => {
    const runId = "run-eval-p05-c";
    const nodeId = randomUUID();
    // No recordNode call — tree.json won't have this node; must not throw
    expect(() => recordEval(runId, nodeId, makeResult(nodeId, runId), "test-mission")).not.toThrow();
  });
});

// ── P2-1: auto-ID on evor_record_node ──────────────────────────────────────

describe("fillNodeId (P2-1)", () => {
  it("generates a UUID when node.id is absent", () => {
    const node = makeNode();
    const { id: _ignored, ...nodeWithoutId } = node;
    const filled = fillNodeId(nodeWithoutId as Omit<typeof node, "id"> & { id?: string });
    expect(filled.id).toBeDefined();
    // Must be a valid UUID so TreeNodeSchema.id (z.string().uuid()) accepts it
    expect(filled.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("preserves an explicitly provided node.id unchanged", () => {
    const node = makeNode();
    const filled = fillNodeId(node);
    expect(filled.id).toBe(node.id);
  });

  it("generated id is different on each call (no collisions)", () => {
    const node = makeNode();
    const { id: _ignored, ...nodeWithoutId } = node;
    const a = fillNodeId(nodeWithoutId as Omit<typeof node, "id"> & { id?: string });
    const b = fillNodeId(nodeWithoutId as Omit<typeof node, "id"> & { id?: string });
    expect(a.id).not.toBe(b.id);
  });
});
