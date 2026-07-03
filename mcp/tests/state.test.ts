/**
 * tests/state.test.ts
 * Unit tests for tools/state.ts: stateRead + stateWrite
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { stateRead, stateWrite } from "../src/tools/state.js";
import { ensureRunDirs } from "../src/run-store.js";

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-state-test-"));
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

// ── stateRead ────────────────────────────────────────────────────────────────

describe("stateRead", () => {
  it("returns fresh default state when run-state.json absent", () => {
    const state = stateRead("run-sr-001");
    expect(state.run_id).toBe("run-sr-001");
    expect(state.status).toBe("running");
    expect(state.tick_count).toBe(0);
    expect(Array.isArray(state.pending_node_ids)).toBe(true);
  });

  it("reads existing run-state.json", () => {
    const runId = "run-sr-002";
    const paths = ensureRunDirs(runId);
    writeFileSync(
      paths.runStatePath,
      JSON.stringify({
        run_id: runId,
        status: "paused",
        tick_count: 5,
        best_score: 0.92,
        frontier_ids: ["node-a"],
        current_eval_version: "v2",
        pending_node_ids: ["node-b"],
      }),
      "utf8"
    );

    const state = stateRead(runId);
    expect(state.status).toBe("paused");
    expect(state.tick_count).toBe(5);
    expect(state.best_score).toBe(0.92);
    expect(state.frontier_ids).toEqual(["node-a"]);
    expect(state.pending_node_ids).toEqual(["node-b"]);
  });

  it("returns fresh default when run-state.json is corrupt JSON", () => {
    const runId = "run-sr-003";
    const paths = ensureRunDirs(runId);
    writeFileSync(paths.runStatePath, "{ not valid json {{", "utf8");

    const state = stateRead(runId);
    expect(state.run_id).toBe(runId);
    expect(state.status).toBe("running");
  });
});

// ── stateWrite ───────────────────────────────────────────────────────────────

describe("stateWrite", () => {
  it("creates run-state.json with patched fields", () => {
    const runId = "run-sw-001";
    const updated = stateWrite(runId, { status: "running", tick_count: 3 });

    expect(updated.status).toBe("running");
    expect(updated.tick_count).toBe(3);

    const paths = ensureRunDirs(runId);
    const written = JSON.parse(readFileSync(paths.runStatePath, "utf8"));
    expect(written.tick_count).toBe(3);
  });

  it("merges patch into existing state (non-patched fields preserved)", () => {
    const runId = "run-sw-002";
    // Write initial state
    stateWrite(runId, { status: "initialized", tick_count: 0, best_score: 0.5 });
    // Patch only best_score
    const updated = stateWrite(runId, { best_score: 0.95 });

    expect(updated.best_score).toBe(0.95);
    expect(updated.status).toBe("initialized");
    expect(updated.tick_count).toBe(0);
  });

  it("updates pending_node_ids", () => {
    const runId = "run-sw-003";
    stateWrite(runId, { pending_node_ids: ["node-x", "node-y"] });

    const state = stateRead(runId);
    expect(state.pending_node_ids).toEqual(["node-x", "node-y"]);
  });

  it("writes strategy delta to strategy.json", () => {
    const runId = "run-sw-004";
    const paths = ensureRunDirs(runId);

    stateWrite(runId, {
      strategy: {
        ucb1_c: 2.0,
        wildness: 0.3,
      } as any,
    });

    expect(existsSync(paths.strategyPath)).toBe(true);
    const strategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(strategy.ucb1_c).toBe(2.0);
    expect(strategy.wildness).toBe(0.3);
  });

  it("merges strategy delta into existing strategy.json", () => {
    const runId = "run-sw-005";
    const paths = ensureRunDirs(runId);

    // Write initial strategy
    writeFileSync(
      paths.strategyPath,
      JSON.stringify({ ucb1_c: 1.41, wildness: 0.5, beam_width: 3 }),
      "utf8"
    );

    stateWrite(runId, { strategy: { wildness: 0.8 } as any });

    const strategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(strategy.ucb1_c).toBe(1.41);   // preserved
    expect(strategy.wildness).toBe(0.8);  // updated
    expect(strategy.beam_width).toBe(3);  // preserved
  });

  it("skips strategy.json update when no strategy in patch", () => {
    const runId = "run-sw-006";
    const paths = ensureRunDirs(runId);

    stateWrite(runId, { tick_count: 1 });

    expect(existsSync(paths.strategyPath)).toBe(false);
  });
});
