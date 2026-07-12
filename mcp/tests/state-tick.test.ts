/**
 * tests/state-tick.test.ts
 * Tests for the tick_state extension (spec §15B) and evor_read_goal_contract
 * additions to tools/state.ts.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { stateRead, stateWrite, readGoalContract, checkPlateauCondition, shouldAbortForge } from "../src/tools/state.js";
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
    ensureRunDirs(runId, "test-mission");
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
    ensureRunDirs(runId, "test-mission");
    const paths = resolveRunPaths(runId);

    stateWrite(runId, { status: "running", tick_count: 2 });

    expect(existsSync(join(paths.runDir, "tick-state.json"))).toBe(false);
  });

  it("tick_state does not bleed into run-state.json", () => {
    const runId = "run-ts-003";
    ensureRunDirs(runId, "test-mission");
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
    ensureRunDirs(runId, "test-mission");
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
    ensureRunDirs(runId, "test-mission");
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
    ensureRunDirs(runId, "test-mission");
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
    ensureRunDirs(runId, "test-mission");

    const state = stateRead(runId);
    expect(state).not.toHaveProperty("tick_state");
  });

  it("omits tick_state gracefully when tick-state.json is corrupt", () => {
    const runId = "run-ts-read-003";
    ensureRunDirs(runId, "test-mission");
    const paths = resolveRunPaths(runId);

    writeFileSync(join(paths.runDir, "tick-state.json"), "{ invalid json {{", "utf8");

    const state = stateRead(runId);
    expect(state).not.toHaveProperty("tick_state");
    // run-state.json still readable
    expect(state.run_id).toBe(runId);
  });

  it("round-trip: write tick_state then read returns the same values", () => {
    const runId = "run-ts-read-004";
    ensureRunDirs(runId, "test-mission");

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
    ensureRunDirs(runId, "test-mission");

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
    ensureRunDirs(runId, "test-mission");

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
    const paths = ensureRunDirs(runId, "test-mission");

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
    ensureRunDirs(runId, "test-mission");

    const result = readGoalContract(runId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error when goal-contract.json is corrupt JSON", () => {
    const runId = "run-gc-003";
    const paths = ensureRunDirs(runId, "test-mission");

    writeFileSync(join(paths.runDir, "goal-contract.json"), "{ bad json }", "utf8");

    const result = readGoalContract(runId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("parse");
  });

  it("returns error when contract fails Zod validation (missing required field)", () => {
    const runId = "run-gc-004";
    const paths = ensureRunDirs(runId, "test-mission");

    const partial = makeMinimalContract("mission-gc-004");
    delete (partial as Record<string, unknown>).mission_id;  // remove required field

    writeFileSync(join(paths.runDir, "goal-contract.json"), JSON.stringify(partial), "utf8");

    const result = readGoalContract(runId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("validation failed");
  });
});

// ── P1-3 checkPlateauCondition ───────────────────────────────────────────────

describe("checkPlateauCondition (P1-3 — adaptive meta-trigger)", () => {
  it("returns plateau=true when last 3 tick scores are within 0.5% of each other", () => {
    const runId = "run-plateau-001";
    ensureRunDirs(runId, "test-mission");

    // Scores within 0.5%: 0.8380, 0.8382, 0.8379 — max spread = 0.0003 / 0.8380 ≈ 0.036%
    stateWrite(runId, {
      tick_history_scores: [0.8200, 0.8300, 0.8380, 0.8382, 0.8379],
    } as any);

    const result = checkPlateauCondition(runId);
    expect(result.plateau).toBe(true);
    expect(result.consecutive_regression).toBe(false);
    expect(result.ticks_checked).toBeGreaterThanOrEqual(3);
    expect(result.scores.length).toBeGreaterThanOrEqual(3);
  });

  it("returns consecutive_regression=true when last 2 ticks regressed", () => {
    const runId = "run-plateau-002";
    ensureRunDirs(runId, "test-mission");

    // Scores: improving then two regressions
    stateWrite(runId, {
      tick_history_scores: [0.8200, 0.8500, 0.8400, 0.8350],
    } as any);

    const result = checkPlateauCondition(runId);
    expect(result.consecutive_regression).toBe(true);
    expect(result.plateau).toBe(false);
  });

  it("returns plateau=false and consecutive_regression=false when scores are improving", () => {
    const runId = "run-plateau-003";
    ensureRunDirs(runId, "test-mission");

    stateWrite(runId, {
      tick_history_scores: [0.80, 0.82, 0.84, 0.86, 0.88],
    } as any);

    const result = checkPlateauCondition(runId);
    expect(result.plateau).toBe(false);
    expect(result.consecutive_regression).toBe(false);
  });

  it("returns plateau=false when fewer than 3 ticks available (insufficient data)", () => {
    const runId = "run-plateau-004";
    ensureRunDirs(runId, "test-mission");

    stateWrite(runId, {
      tick_history_scores: [0.80, 0.81],
    } as any);

    const result = checkPlateauCondition(runId);
    expect(result.plateau).toBe(false);
    expect(result.ticks_checked).toBeLessThan(3);
  });

  it("returns plateau=false when no tick history exists", () => {
    const runId = "run-plateau-005";
    ensureRunDirs(runId, "test-mission");

    const result = checkPlateauCondition(runId);
    expect(result.plateau).toBe(false);
    expect(result.consecutive_regression).toBe(false);
    expect(result.ticks_checked).toBe(0);
    expect(result.scores).toEqual([]);
  });
});

// ── P1-4 prediction_bias_history state passthrough ────────────────────────────

describe("prediction_bias_history state passthrough (P1-4)", () => {
  it("roundtrips prediction_bias_history via state_write / state_read", () => {
    const runId = "run-bias-001";
    ensureRunDirs(runId, "test-mission");

    stateWrite(runId, {
      prediction_bias_history: { avg_bias: 0.4, n_samples: 5 },
    } as any);

    const state = stateRead(runId);
    const bias = state.prediction_bias_history as { avg_bias: number; n_samples: number };
    expect(bias).toBeDefined();
    expect(bias.avg_bias).toBe(0.4);
    expect(bias.n_samples).toBe(5);
  });

  it("overwrites prediction_bias_history on subsequent writes", () => {
    const runId = "run-bias-002";
    ensureRunDirs(runId, "test-mission");

    stateWrite(runId, { prediction_bias_history: { avg_bias: 0.4, n_samples: 3 } } as any);
    stateWrite(runId, { prediction_bias_history: { avg_bias: -0.1, n_samples: 7 } } as any);

    const state = stateRead(runId);
    const bias = state.prediction_bias_history as { avg_bias: number; n_samples: number };
    expect(bias.avg_bias).toBe(-0.1);
    expect(bias.n_samples).toBe(7);
  });
});

// ── P1-14 dream_k strategy field roundtrip ───────────────────────────────────

describe("dream_k strategy field roundtrip (P1-14)", () => {
  it("stores and retrieves dream_k in strategy.json", () => {
    const runId = "run-dreamk-001";
    const paths = ensureRunDirs(runId, "test-mission");

    stateWrite(runId, {
      strategy: { dream_k: 7 } as any,
    });

    const strategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(strategy.dream_k).toBe(7);
  });

  it("dream_k survives a strategy merge (other fields preserved)", () => {
    const runId = "run-dreamk-002";
    const paths = ensureRunDirs(runId, "test-mission");

    stateWrite(runId, { strategy: { dream_k: 6, wildness: 0.5 } as any });
    stateWrite(runId, { strategy: { wildness: 0.8 } as any });

    const strategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(strategy.dream_k).toBe(6);   // preserved from first write
    expect(strategy.wildness).toBe(0.8); // updated
  });

  it("dream_k defaults semantics: absent field returns undefined (not error)", () => {
    const runId = "run-dreamk-003";
    const paths = ensureRunDirs(runId, "test-mission");

    stateWrite(runId, { strategy: { wildness: 0.5 } as any });

    const strategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(strategy.dream_k).toBeUndefined();
  });
});

// ── P2-8 forge_attempt tracking ──────────────────────────────────────────────

describe("forge_attempt state field (P2-8)", () => {
  it("roundtrips forge_attempt via stateWrite / stateRead", () => {
    const runId = "run-forge-001";
    ensureRunDirs(runId, "test-mission");

    stateWrite(runId, { forge_attempt: 1 } as any);
    const state = stateRead(runId);
    expect(state.forge_attempt).toBe(1);
  });

  it("increments forge_attempt across writes", () => {
    const runId = "run-forge-002";
    ensureRunDirs(runId, "test-mission");

    stateWrite(runId, { forge_attempt: 0 } as any);
    stateWrite(runId, { forge_attempt: 1 } as any);
    stateWrite(runId, { forge_attempt: 2 } as any);

    const state = stateRead(runId);
    expect(state.forge_attempt).toBe(2);
  });

  it("forge_attempt=0 does not trigger abort (below max)", () => {
    expect(shouldAbortForge(0)).toBe(false);
    expect(shouldAbortForge(0, 2)).toBe(false);
  });

  it("forge_attempt=1 does not trigger abort when max=2", () => {
    expect(shouldAbortForge(1, 2)).toBe(false);
  });

  it("forge_attempt=2 triggers abort at default max=2", () => {
    expect(shouldAbortForge(2)).toBe(true);
  });

  it("forge_attempt=3 triggers abort at default max=2", () => {
    expect(shouldAbortForge(3, 2)).toBe(true);
  });

  it("shouldAbortForge respects custom max", () => {
    expect(shouldAbortForge(4, 5)).toBe(false);
    expect(shouldAbortForge(5, 5)).toBe(true);
    expect(shouldAbortForge(6, 5)).toBe(true);
  });

  it("forge_attempt does not bleed into tick_state or strategy", () => {
    const runId = "run-forge-003";
    const paths = ensureRunDirs(runId, "test-mission");

    stateWrite(runId, {
      forge_attempt: 1,
      tick_state: { tick: 1, current_step: 3, step_status: "running" },
    } as any);

    // run-state.json should have forge_attempt
    const rs = JSON.parse(readFileSync(paths.runStatePath, "utf8"));
    expect(rs.forge_attempt).toBe(1);

    // tick-state.json must NOT have forge_attempt
    const ts = JSON.parse(readFileSync(join(paths.runDir, "tick-state.json"), "utf8"));
    expect(ts).not.toHaveProperty("forge_attempt");
  });
});
