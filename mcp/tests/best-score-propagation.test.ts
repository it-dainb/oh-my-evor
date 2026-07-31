/**
 * mcp/tests/best-score-propagation.test.ts — C5 Stage 1.7
 *
 * Found by the Phase 2 measurement: `mission_state.best_score` was `null` after a
 * completed tick with 9 artifacts and a successful `evor_record_eval`.
 *
 * The cause is not a reporting bug. `recordEval` writes results.json, runs the
 * integrity check and cascades tree status — but never touches run-state's
 * `best_score`. Nothing else does either. Meanwhile `harness/evor/tree.py:701`
 * reads it for the stop decision:
 *
 *     best_score = float(run_state.get("best_score") or 0.0)
 *     if stop_type == "beat-baseline":  if best_score > goal.baseline_value: ...
 *     elif stop_type == "target":       if best_score >= goal.target_value: ...
 *
 * With best_score pinned at 0.0, BOTH score-based stop conditions are unreachable.
 * An evolutionary search that cannot recognise success runs to max_iterations or
 * budget regardless of what it finds.
 *
 * P3 constraint: only an integrity-PASSED node may move best_score. Letting a
 * failed node set it would allow a cheating candidate to define the mission's
 * success — the precise failure class the integrity gate exists to prevent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { updateBestScore } from "../src/tools/record.js";

let root: string;
let runDir: string;
const RUN = "r1";
const MISSION = "m1";

/** Minimal run dir with a goal contract naming the primary metric. */
function seed(opts: { direction?: "higher" | "lower"; best?: number | null } = {}) {
  runDir = join(root, "runs", MISSION, RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "goal-contract.json"),
    JSON.stringify({
      mission_id: MISSION,
      metric_specs: [
        {
          metric_name: "accuracy",
          direction: opts.direction ?? "higher",
          role: "primary_fitness",
          domain_applicability: "all",
        },
        // A secondary metric must never be mistaken for fitness.
        { metric_name: "roc_auc", direction: "higher", role: "secondary_reported", domain_applicability: "all" },
      ],
    }),
  );
  writeFileSync(
    join(runDir, "run-state.json"),
    JSON.stringify({ run_id: RUN, tick_count: 1, best_score: opts.best ?? null, best_node_id: null }),
  );
  return runDir;
}

const state = () => JSON.parse(readFileSync(join(runDir, "run-state.json"), "utf8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evor-bestscore-"));
  process.env.EVOR_ROOT = root;
});
afterEach(() => {
  delete process.env.EVOR_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("best_score propagation", () => {
  it("sets best_score from the primary metric on a passing node", () => {
    seed();
    updateBestScore(RUN, "node-a", { metrics: { accuracy: 0.9062, roc_auc: 0.9048 } }, "passed", MISSION);
    expect(state().best_score).toBeCloseTo(0.9062, 4);
    expect(state().best_node_id).toBe("node-a");
  });

  it("ignores secondary metrics when choosing fitness", () => {
    seed();
    // roc_auc is higher, but accuracy is the declared primary_fitness metric.
    updateBestScore(RUN, "node-a", { metrics: { accuracy: 0.60, roc_auc: 0.99 } }, "passed", MISSION);
    expect(state().best_score).toBeCloseTo(0.60, 4);
  });

  it("keeps the better score when a weaker node is recorded later", () => {
    seed({ best: 0.90 });
    updateBestScore(RUN, "node-b", { metrics: { accuracy: 0.71 } }, "passed", MISSION);
    expect(state().best_score).toBeCloseTo(0.90, 4);
    expect(state().best_node_id).not.toBe("node-b");
  });

  it("honours lower-is-better metrics", () => {
    seed({ direction: "lower", best: 0.40 });
    updateBestScore(RUN, "node-b", { metrics: { accuracy: 0.25 } }, "passed", MISSION);
    expect(state().best_score).toBeCloseTo(0.25, 4);
    expect(state().best_node_id).toBe("node-b");
  });

  it("REFUSES to record a score from an integrity-failed node", () => {
    seed();
    updateBestScore(RUN, "cheater", { metrics: { accuracy: 0.999 } }, "failed", MISSION);
    expect(state().best_score, "a failed node must not define mission success").toBeNull();
    expect(state().best_node_id).toBeNull();
  });

  it("REFUSES when the integrity verdict is unknown", () => {
    seed();
    // A null verdict means the check did not complete — absence of a failure is
    // not evidence of integrity.
    updateBestScore(RUN, "unchecked", { metrics: { accuracy: 0.999 } }, null, MISSION);
    expect(state().best_score).toBeNull();
  });

  it("leaves state untouched when the result carries no usable metric", () => {
    seed({ best: 0.5 });
    updateBestScore(RUN, "node-c", { metrics: {} }, "passed", MISSION);
    expect(state().best_score).toBeCloseTo(0.5, 4);
  });

  it("does not throw when the run has no goal contract", () => {
    runDir = join(root, "runs", MISSION, RUN);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ run_id: RUN, best_score: null }));
    expect(() =>
      updateBestScore(RUN, "node-a", { metrics: { accuracy: 0.9 } }, "passed", MISSION),
    ).not.toThrow();
  });
});
