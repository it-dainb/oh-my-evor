/**
 * tests/state-tick.test.ts
 * Tests for the tick_state extension (spec §15B) and evor_read_goal_contract
 * additions to tools/state.ts.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { stateRead, stateWrite, readGoalContract } from "../src/tools/state.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-state-tick-test-"));
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

// ── tick_state write ──────────────────────────────────────────────────────────

describe("stateWrite — tick_state extension", () => {
  it("writes tick-state.json atomically when tick_state is provided", () => {
    const runId = "run-ts-001";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    stateWrite(runId, {
      status: "running",
      tick_state: {
        tick: 3,
        current_step: 4,
        step_status: "running",
        step_outputs: { forge: "node-abc" },
      },
    });

    const tickStatePath = join(paths.runDir, "tick-state.json");
    expect(existsSync(tickStatePath)).toBe(true);

    const ts = JSON.parse(readFileSync(tickStatePath, "utf8"));
    expect(ts.tick).toBe(3);
    expect(ts.current_step).toBe(4);
    expect(ts.step_status).toBe("running");
    expect(ts.step_outputs).toEqual({ forge: "node-abc" });
    expect(ts.updated_at).toBeTruthy();
  });

  it("does not write tick-state.json when tick_state is absent", () => {
    const runId = "run-ts-002";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    stateWrite(runId, { status: "running", tick_count: 2 });

    expect(existsSync(join(paths.runDir, "tick-state.json"))).toBe(false);
  });

  it("tick_state does not bleed into run-state.json", () => {
    const runId = "run-ts-003";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    stateWrite(runId, {
      tick_count: 1,
      tick_state: { tick: 1, current_step: 0, step_status: "pending" },
    });

    const rs = JSON.parse(readFileSync(paths.runStatePath, "utf8"));
    expect(rs).not.toHaveProperty("tick_state");
    expect(rs.tick_count).toBe(1);
  });

  it("overwrites tick-state.json on subsequent writes (atomic replace)", () => {
    const runId = "run-ts-004";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    stateWrite(runId, {
      tick_state: { tick: 1, current_step: 2, step_status: "done" },
    });
    stateWrite(runId, {
      tick_state: { tick: 2, current_step: 0, step_status: "pending" },
    });

    const ts = JSON.parse(readFileSync(join(paths.runDir, "tick-state.json"), "utf8"));
    expect(ts.tick).toBe(2);
    expect(ts.step_status).toBe("pending");
  });

  it("sets updated_at automatically when not provided", () => {
    const runId = "run-ts-005";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    const before = new Date().toISOString();
    stateWrite(runId, {
      tick_state: { tick: 0, current_step: 0, step_status: "pending" },
    });
    const after = new Date().toISOString();

    const ts = JSON.parse(readFileSync(join(paths.runDir, "tick-state.json"), "utf8"));
    expect(ts.updated_at >= before).toBe(true);
    expect(ts.updated_at <= after).toBe(true);
  });
});

// ── tick_state read ───────��─────────────────────────────���─────────────────────

describe("stateRead — tick_state merging", () => {
  it("includes tick_state in the response when tick-state.json exists", () => {
    const runId = "run-ts-read-001";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    writeFileSync(
      join(paths.runDir, "tick-state.json"),
      JSON.stringify({ tick: 5, current_step: 9, step_status: "done", updated_at: "2025-01-01T00:00:00Z" }),
      "utf8",
    );

    const state = stateRead(runId);
    expect(state.tick_state).toBeTruthy();
    const ts = state.tick_state as Record<string, unknown>;
    expect(ts.tick).toBe(5);
    expect(ts.current_step).toBe(9);
    expect(ts.step_status).toBe("done");
  });

  it("omits tick_state key when tick-state.json does not exist", () => {
    const runId = "run-ts-read-002";
    ensureRunDirs(runId);

    const state = stateRead(runId);
    expect(state).not.toHaveProperty("tick_state");
  });

  it("omits tick_state gracefully when tick-state.json is corrupt", () => {
    const runId = "run-ts-read-003";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    writeFileSync(join(paths.runDir, "tick-state.json"), "{ invalid json {{", "utf8");

    const state = stateRead(runId);
    expect(state).not.toHaveProperty("tick_state");
    // run-state.json still readable
    expect(state.run_id).toBe(runId);
  });

  it("round-trip: write tick_state then read returns the same values", () => {
    const runId = "run-ts-read-004";

    stateWrite(runId, {
      status: "running",
      tick_count: 7,
      tick_state: {
        tick: 7,
        current_step: 3,
        step_status: "running",
        step_outputs: { selector: "approved-node-x" },
      },
    });

    const state = stateRead(runId);
    expect(state.tick_count).toBe(7);
    const ts = state.tick_state as Record<string, unknown>;
    expect(ts.tick).toBe(7);
    expect(ts.current_step).toBe(3);
    expect(ts.step_status).toBe("running");
    expect((ts.step_outputs as Record<string, unknown>).selector).toBe("approved-node-x");
  });
});

// ── active_run job_id ───────���─────────────────────────────────────────────────

describe("stateWrite — active_run job_id extension", () => {
  it("writes job_id into active-run.json when provided", () => {
    const runId = "run-ar-job-001";
    ensureRunDirs(runId);

    stateWrite(runId, {
      active_run: {
        mission_id: "mission-001",
        run_id: runId,
        run_dir: "/tmp/fake-run-dir",
        job_id: "job-abc-123",
        status: "running",
      },
    });

    const arPath = join(tmpRoot, "active-run.json");
    expect(existsSync(arPath)).toBe(true);
    const ar = JSON.parse(readFileSync(arPath, "utf8"));
    expect(ar.job_id).toBe("job-abc-123");
    expect(ar.run_dir).toBe("/tmp/fake-run-dir");
    expect(ar.mission_id).toBe("mission-001");
  });

  it("active_run without job_id still writes active-run.json", () => {
    const runId = "run-ar-job-002";
    ensureRunDirs(runId);

    stateWrite(runId, {
      active_run: {
        mission_id: "mission-002",
        run_id: runId,
        run_dir: "/tmp/run-dir-2",
      },
    });

    const ar = JSON.parse(readFileSync(join(tmpRoot, "active-run.json"), "utf8"));
    expect(ar.run_id).toBe(runId);
    expect(ar).not.toHaveProperty("job_id");
  });
});

// ── evor_read_goal_contract ─────��─────────────────────────────���───────────────

describe("readGoalContract", () => {
  /** Minimal valid GoalContract fixture (all required fields). */
  function makeMinimalContract(missionId: string): Record<string, unknown> {
    return {
      mission_id: missionId,
      mode: "seed-repo",
      mission_type: "fixed",
      task_description: "Classify images",
      dataset_ref: "data/",
      metrics: [{ name: "accuracy", direction: "higher", primary: true }],
      metric_specs: [
        {
          metric_name: "accuracy",
          direction: "higher",
          domain_applicability: "all",
          aggregation_rule: "macro_avg",
          role: "primary_fitness",
          constraints: [],
          custom_metrics: [],
        },
      ],
      fitness_mode: "aggregate",
      eval_version: "v1",
      baseline_value: 0.7,
      stop_condition: { type: "beat-baseline" },
      wildness: 0.5,
      budget: {
        max_iterations: 50,
        plateau_window: 5,
        circuit_breaker: 10,
        max_cost_usd: 100,
      },
      locked_split_hash: "abc123",
      eval_script_hash: "def456",
      allowed_licenses: ["MIT"],
      created_at: "2025-01-01T00:00:00.000Z",
    };
  }

  it("returns the validated contract when goal-contract.json exists and is valid", () => {
    const runId = "run-gc-001";
    const paths = ensureRunDirs(runId);

    writeFileSync(
      join(paths.runDir, "goal-contract.json"),
      JSON.stringify(makeMinimalContract("mission-gc-001")),
      "utf8",
    );

    const result = readGoalContract(runId);
    expect(result.ok).toBe(true);
    expect(result.contract?.mission_id).toBe("mission-gc-001");
    expect(result.contract?.mode).toBe("seed-repo");
    expect(result.contract?.baseline_value).toBe(0.7);
  });

  it("returns error when goal-contract.json does not exist", () => {
    const runId = "run-gc-002";
    ensureRunDirs(runId);

    const result = readGoalContract(runId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error when goal-contract.json is corrupt JSON", () => {
    const runId = "run-gc-003";
    const paths = ensureRunDirs(runId);

    writeFileSync(join(paths.runDir, "goal-contract.json"), "{ bad json }", "utf8");

    const result = readGoalContract(runId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("parse");
  });

  it("returns error when contract fails Zod validation (missing required field)", () => {
    const runId = "run-gc-004";
    const paths = ensureRunDirs(runId);

    const partial = makeMinimalContract("mission-gc-004");
    delete (partial as Record<string, unknown>).mission_id;  // remove required field

    writeFileSync(join(paths.runDir, "goal-contract.json"), JSON.stringify(partial), "utf8");

    const result = readGoalContract(runId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("validation failed");
  });
});
