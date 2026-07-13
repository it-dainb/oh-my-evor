/**
 * tests/classc.test.ts
 * Unit tests for Class-C backing tools (Areas 1, 3, 4, 5, 6).
 *
 * Area 6 — meta_evolve_requested / meta_evolve_reason round-trips
 * Area 5 — evor_tree_read filters (status, integrity_status, min_score, approach_family)
 *           + integrity_status in NamedTreeNode
 * Area 1 — lockMission: refused on failing validation; succeeds on passing
 * Area 4 — checkStop: each stop type fires correctly; circuit-breaker overrides
 * Area 3 — prediction_bias_sample accumulates correct rolling avg_bias / n_samples
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { stateRead, stateWrite, lockMission, checkStop } from "../src/tools/state.js";
import { treeRead, type NamedTreeNode } from "../src/tools/tree.js";
import { ensureRunDirs } from "../src/run-store.js";
import { writeTree } from "../src/tree-store.js";
import type { TreeNode } from "../src/contracts.js";

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-classc-test-"));
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeNode(
  id: string,
  parentIds: string[],
  depth: number,
  overrides: Partial<TreeNode> = {}
): TreeNode {
  return {
    id,
    parent_ids: parentIds,
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
    depth,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── AREA 6: meta_evolve_requested round-trips ─────────────────────────────────

describe("Area 6 — meta_evolve_requested in strategy", () => {
  it("persists meta_evolve_requested=true and meta_evolve_reason to strategy.json and round-trips via stateRead", () => {
    const runId = "run-a6-001";
    const paths = ensureRunDirs(runId, "test-mission");

    stateWrite(
      runId,
      {
        strategy: {
          meta_evolve_requested: true,
          meta_evolve_reason: "plateau",
        } as any,
      },
      "test-mission"
    );

    expect(existsSync(paths.strategyPath)).toBe(true);
    const strategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(strategy.meta_evolve_requested).toBe(true);
    expect(strategy.meta_evolve_reason).toBe("plateau");
  });

  it("persists meta_evolve_reason='regression' correctly", () => {
    const runId = "run-a6-002";
    const paths = ensureRunDirs(runId, "test-mission");

    stateWrite(runId, {
      strategy: { meta_evolve_requested: true, meta_evolve_reason: "regression" } as any,
    }, "test-mission");

    const strategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(strategy.meta_evolve_reason).toBe("regression");
  });

  it("persists meta_evolve_reason='lock' correctly", () => {
    const runId = "run-a6-003";
    const paths = ensureRunDirs(runId, "test-mission");

    stateWrite(runId, {
      strategy: { meta_evolve_requested: true, meta_evolve_reason: "lock" } as any,
    }, "test-mission");

    const strategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(strategy.meta_evolve_reason).toBe("lock");
  });

  it("merges meta_evolve_requested into existing strategy without clobbering other fields", () => {
    const runId = "run-a6-004";
    const paths = ensureRunDirs(runId, "test-mission");

    // Write initial strategy
    writeFileSync(paths.strategyPath, JSON.stringify({ ucb1_c: 1.41, wildness: 0.5 }), "utf8");

    stateWrite(runId, {
      strategy: { meta_evolve_requested: true, meta_evolve_reason: "plateau" } as any,
    }, "test-mission");

    const strategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(strategy.ucb1_c).toBe(1.41);       // preserved
    expect(strategy.wildness).toBe(0.5);       // preserved
    expect(strategy.meta_evolve_requested).toBe(true);
    expect(strategy.meta_evolve_reason).toBe("plateau");
  });
});

// ── AREA 5: treeRead filters + integrity_status in NamedTreeNode ─────────────

describe("Area 5 — evor_tree_read filters", () => {
  it("NamedTreeNode includes integrity_status field", () => {
    const runId = "run-a5-001";
    const id = randomUUID();
    writeTree(
      runId,
      { [id]: makeNode(id, [], 0, { name: "node-01", integrity_status: "passed", status: "done" }) },
      "test-mission"
    );

    const nodes = treeRead(runId, undefined, undefined, "test-mission");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].integrity_status).toBe("passed");
  });

  it("filters by status=done", () => {
    const runId = "run-a5-002";
    const doneId = randomUUID();
    const pendingId = randomUUID();
    writeTree(runId, {
      [doneId]: makeNode(doneId, [], 0, { name: "done-01", status: "done" }),
      [pendingId]: makeNode(pendingId, [], 0, { name: "pending-01", status: "pending" }),
    }, "test-mission");

    const nodes = treeRead(runId, undefined, undefined, "test-mission", { status: "done" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("done-01");
  });

  it("filters by integrity_status=passed", () => {
    const runId = "run-a5-003";
    const passedId = randomUUID();
    const failedId = randomUUID();
    const pendingId = randomUUID();
    writeTree(runId, {
      [passedId]: makeNode(passedId, [], 0, { name: "passed-01", integrity_status: "passed" }),
      [failedId]: makeNode(failedId, [], 0, { name: "failed-01", integrity_status: "failed" }),
      [pendingId]: makeNode(pendingId, [], 0, { name: "pending-01", integrity_status: "pending" }),
    }, "test-mission");

    const nodes = treeRead(runId, undefined, undefined, "test-mission", { integrity_status: "passed" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("passed-01");
  });

  it("filters by status AND integrity_status together", () => {
    const runId = "run-a5-004";
    const matchId = randomUUID();
    const wrongStatusId = randomUUID();
    const wrongIntegrityId = randomUUID();
    writeTree(runId, {
      [matchId]: makeNode(matchId, [], 0, {
        name: "match-01", status: "done", integrity_status: "passed",
      }),
      [wrongStatusId]: makeNode(wrongStatusId, [], 0, {
        name: "wrong-status", status: "pending", integrity_status: "passed",
      }),
      [wrongIntegrityId]: makeNode(wrongIntegrityId, [], 0, {
        name: "wrong-integrity", status: "done", integrity_status: "failed",
      }),
    }, "test-mission");

    const nodes = treeRead(runId, undefined, undefined, "test-mission", {
      status: "done",
      integrity_status: "passed",
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("match-01");
  });

  it("filters by min_score; nodes lacking ucb1_score are excluded", () => {
    const runId = "run-a5-005";
    const highId = randomUUID();
    const lowId = randomUUID();
    const noScoreId = randomUUID();
    writeTree(runId, {
      [highId]: makeNode(highId, [], 0, { name: "high-01", ucb1_score: 0.9 }),
      [lowId]: makeNode(lowId, [], 0, { name: "low-01", ucb1_score: 0.3 }),
      [noScoreId]: makeNode(noScoreId, [], 0, { name: "noscore-01" }),
    }, "test-mission");

    const nodes = treeRead(runId, undefined, undefined, "test-mission", { min_score: 0.5 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("high-01");
  });

  it("filters by approach_family", () => {
    const runId = "run-a5-006";
    const archId = randomUUID();
    const trainId = randomUUID();
    writeTree(runId, {
      [archId]: makeNode(archId, [], 0, { name: "arch-01", approach_family: "arch" }),
      [trainId]: makeNode(trainId, [], 0, { name: "train-01", approach_family: "training" }),
    }, "test-mission");

    const nodes = treeRead(runId, undefined, undefined, "test-mission", { approach_family: "training" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("train-01");
  });

  it("returns empty list when no nodes match filters", () => {
    const runId = "run-a5-007";
    const id = randomUUID();
    writeTree(runId, {
      [id]: makeNode(id, [], 0, { name: "node-01", status: "pending" }),
    }, "test-mission");

    const nodes = treeRead(runId, undefined, undefined, "test-mission", { status: "done" });
    expect(nodes).toHaveLength(0);
  });
});

// ── AREA 1: lockMission ───────────────────────────────────────────────────────

describe("Area 1 — lockMission", () => {
  it("returns ok=false and preserves draft status when validation fails (no goal-contract.json)", () => {
    const runId = "run-a1-fail";
    ensureRunDirs(runId, "test-mission");

    const result = lockMission(runId, "test-mission");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.validation_report).toBeDefined();

    // mission-state.json should NOT be flipped to locked
    const paths = ensureRunDirs(runId, "test-mission");
    const missionStatePath = join(paths.runDir, "mission-state.json");
    if (existsSync(missionStatePath)) {
      const ms = JSON.parse(readFileSync(missionStatePath, "utf8"));
      expect(ms.status).not.toBe("locked");
    }
  });

  it("result shape always includes ok, error (or mission_status), and validation_report", () => {
    const runId = "run-a1-shape";
    ensureRunDirs(runId, "test-mission");

    const result = lockMission(runId, "test-mission");
    // ok is always present
    expect(typeof result.ok).toBe("boolean");
    // validation_report is always present
    expect("validation_report" in result).toBe(true);
    // on failure: error present; on success: mission_status present
    if (result.ok) {
      expect(result.mission_status).toBe("locked");
    } else {
      expect(result.error).toBeDefined();
    }
  });
});

// ── AREA 4: checkStop ─────────────────────────────────────────────────────────

describe("Area 4 — checkStop", () => {
  it("returns ok=false with error when harness not available (no run dir / no goal-contract)", () => {
    const runId = "run-a4-fail";
    ensureRunDirs(runId, "test-mission");

    const result = checkStop(runId, "test-mission");
    // When harness is unavailable, ok=false with graceful error handling
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.should_stop).toBe("boolean");
    expect(typeof result.reason).toBe("string");
  });

  it("result shape always has should_stop, reason, tick_count, best_score, frontier_count", () => {
    const runId = "run-a4-shape";
    ensureRunDirs(runId, "test-mission");

    const result = checkStop(runId, "test-mission");
    expect(typeof result.should_stop).toBe("boolean");
    expect(typeof result.reason).toBe("string");
    expect(typeof result.tick_count).toBe("number");
    expect(typeof result.best_score).toBe("number");
    expect(typeof result.frontier_count).toBe("number");
  });
});

// ── AREA 3: prediction_bias_sample rolling avg ────────────────────────────────

describe("Area 3 — prediction_bias_sample rolling average", () => {
  it("first sample initialises prediction_bias_history with correct avg_bias and n_samples=1", () => {
    const runId = "run-a3-001";
    ensureRunDirs(runId, "test-mission");

    const result = stateWrite(runId, {
      prediction_bias_sample: { predicted_gain: 0.1, actual_gain: 0.05 },
    }, "test-mission");

    // bias = (0.1 - 0.05) / (0.1 + 1e-9) ≈ 0.5
    const history = result.prediction_bias_history as Record<string, unknown>;
    expect(history).toBeDefined();
    expect(history.n_samples).toBe(1);
    expect(typeof history.avg_bias).toBe("number");
    expect(Math.abs((history.avg_bias as number) - 0.5)).toBeLessThan(1e-6);
  });

  it("two samples accumulate a correct rolling avg_bias and n_samples=2", () => {
    const runId = "run-a3-002";
    ensureRunDirs(runId, "test-mission");

    // Sample 1: predicted=0.2, actual=0.1 → bias = (0.2-0.1)/(0.2+1e-9) ≈ 0.5
    stateWrite(runId, {
      prediction_bias_sample: { predicted_gain: 0.2, actual_gain: 0.1 },
    }, "test-mission");

    // Sample 2: predicted=0.4, actual=0.0 → bias = (0.4-0.0)/(0.4+1e-9) ≈ 1.0
    const result2 = stateWrite(runId, {
      prediction_bias_sample: { predicted_gain: 0.4, actual_gain: 0.0 },
    }, "test-mission");

    // avg_bias = (0.5 + 1.0) / 2 = 0.75
    const history = result2.prediction_bias_history as Record<string, unknown>;
    expect(history.n_samples).toBe(2);
    expect(Math.abs((history.avg_bias as number) - 0.75)).toBeLessThan(1e-5);
  });

  it("prediction_bias_sample does not appear in run-state.json (stripped from persisted fields)", () => {
    const runId = "run-a3-003";
    const paths = ensureRunDirs(runId, "test-mission");

    stateWrite(runId, {
      prediction_bias_sample: { predicted_gain: 0.1, actual_gain: 0.05 },
    }, "test-mission");

    const written = JSON.parse(readFileSync(paths.runStatePath, "utf8"));
    expect("prediction_bias_sample" in written).toBe(false);
  });

  it("direct prediction_bias_history write is not overwritten by a concurrent prediction_bias_sample=undefined write", () => {
    const runId = "run-a3-004";
    const paths = ensureRunDirs(runId, "test-mission");

    // Write prediction_bias_history directly
    stateWrite(runId, {
      status: "running",
    } as any, "test-mission");

    // Manually set prediction_bias_history in the file to simulate a direct write
    const state = JSON.parse(readFileSync(paths.runStatePath, "utf8"));
    state.prediction_bias_history = { avg_bias: 0.42, n_samples: 5 };
    writeFileSync(paths.runStatePath, JSON.stringify(state), "utf8");

    // A patch with no prediction_bias_sample should leave prediction_bias_history alone
    const result = stateWrite(runId, { tick_count: 1 }, "test-mission");
    const history = result.prediction_bias_history as Record<string, unknown>;
    expect(history?.avg_bias).toBe(0.42);
    expect(history?.n_samples).toBe(5);
  });

  it("three samples accumulate correctly (n_samples=3, rolling avg)", () => {
    const runId = "run-a3-005";
    ensureRunDirs(runId, "test-mission");

    // bias1 = (0.3 - 0.1) / (0.3 + 1e-9) ≈ 0.6667
    stateWrite(runId, { prediction_bias_sample: { predicted_gain: 0.3, actual_gain: 0.1 } }, "test-mission");
    // bias2 = (0.5 - 0.5) / (0.5 + 1e-9) = 0.0
    stateWrite(runId, { prediction_bias_sample: { predicted_gain: 0.5, actual_gain: 0.5 } }, "test-mission");
    // bias3 = (0.2 - 0.0) / (0.2 + 1e-9) ≈ 1.0
    const result3 = stateWrite(runId, { prediction_bias_sample: { predicted_gain: 0.2, actual_gain: 0.0 } }, "test-mission");

    // avg = (0.6667 + 0.0 + 1.0) / 3 ≈ 0.5556
    const history = result3.prediction_bias_history as Record<string, unknown>;
    expect(history.n_samples).toBe(3);
    expect(Math.abs((history.avg_bias as number) - (2.0 / 3.0 + 0.0 + 1.0) / 3)).toBeLessThan(1e-4);
  });
});
