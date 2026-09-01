/**
 * mcp/tests/wave1-autonomy-termination.test.ts
 *
 * Wave-2 RED tests for field-trace category 5 (autonomy and termination),
 * TypeScript/hook side. Every test here asserts the invariant the field run
 * violated; each is expected to FAIL against this repo at bab279e.
 *
 * Findings covered:
 *   C-02  the stop hook's finished-test is `current_step >= 9` alone, so it
 *         cleared a tick that was still `running` with `integrity_verdict:
 *         "failed"` — 54 invocations, preventedContinuation:false on all 54.
 *   C-01  the run never terminated; `active-run.json` still reads
 *         `status: "running"` days after the session was killed.
 *   K-09  no stall / no-progress guard exists in this repo (the field's
 *         `stalled`/`auto_resume` subsystem was authored mid-run into the
 *         installed cache and never landed here).
 *
 * `stop-incomplete-tick.test.ts` already covers the started-but-below-step-9
 * case and deliberately asserts that step 9 WITHOUT a step_status is allowed
 * (a false-stop guard). Nothing here contradicts that: these cases all carry an
 * explicit, non-terminal step_status or verdict.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

import { stateRead } from "../src/tools/state.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");

/** exit 2 is how a Stop hook blocks; 0 lets the turn end. */
const BLOCKED = 2;

function runStop(tickState: unknown, payload: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "evor-w1-stop-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(root, ".evor", "active-run.json"),
    JSON.stringify({ run_id: "r1", mission_id: "m1" }),
  );
  writeFileSync(
    join(runDir, "run-state.json"),
    JSON.stringify({ run_id: "r1", tick: 1, pending_node_ids: [] }),
  );
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running", tick: 1 }));
  if (tickState !== undefined) writeFileSync(join(runDir, "tick-state.json"), JSON.stringify(tickState));
  const r = spawnSync("node", [join(HOOKS, "stop.mjs")], {
    input: JSON.stringify({ stop_hook_active: false, ...payload }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
  });
  rmSync(root, { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout ?? "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// C-02 — step 9 is not, by itself, "finished"
// ─────────────────────────────────────────────────────────────────────────────

describe("C-02: a tick at step 9 is only finished if it actually finished", () => {
  it("blocks when step 9 explicitly says step_status: running", () => {
    // r3's final tick-state, verbatim in shape: step 9, still running.
    const r = runStop({ tick: 1, current_step: 9, step_status: "running" });
    expect(r.code, r.stdout).toBe(BLOCKED);
    expect(r.stdout).toMatch(/EVOR CONTINUATION/);
  });

  it("blocks when the tick's integrity verdict failed, even at step 9", () => {
    // A tick whose integrity gate said "failed" has not produced a usable
    // outcome; ending the turn there ends the mission on a failed tick.
    const r = runStop({
      tick: 1,
      current_step: 9,
      step_status: "done",
      integrity_verdict: "failed",
    });
    expect(r.code, r.stdout).toBe(BLOCKED);
    expect(r.stdout).toMatch(/EVOR CONTINUATION|integrity/i);
  });

  it("blocks on the exact final r3 tick-state (step 9 / running / integrity failed)", () => {
    const r = runStop({
      tick: 1,
      current_step: 9,
      step_status: "running",
      integrity_verdict: "failed",
    });
    expect(r.code, r.stdout).toBe(BLOCKED);
  });

  it("still allows a genuinely complete tick (regression guard for the above)", () => {
    expect(runStop({ tick: 1, current_step: 9, step_status: "done" }).code).toBe(0);
    // step 9 with no step_status stays allowed — the deliberate false-stop guard.
    expect(runStop({ tick: 4, current_step: 9 }).code).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C-01 — a session that ends must close the run record
// ─────────────────────────────────────────────────────────────────────────────

describe("C-01: session end writes a terminal status to the run record", () => {
  function runSessionEnd(activeRun: Record<string, unknown>, missionState: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), "evor-w1-end-"));
    const evorRoot = join(root, ".evor");
    const runDir = join(evorRoot, "runs", "m1", "r1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(evorRoot, "active-run.json"), JSON.stringify(activeRun));
    writeFileSync(join(runDir, "mission-state.json"), JSON.stringify(missionState));
    const r = spawnSync("node", [join(HOOKS, "session-end.mjs")], {
      input: JSON.stringify({ reason: "other" }),
      encoding: "utf8",
      env: { ...process.env, EVOR_ROOT: evorRoot, CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
    });
    const after = {
      activeRun: JSON.parse(readFileSync(join(evorRoot, "active-run.json"), "utf8")),
      missionState: JSON.parse(readFileSync(join(runDir, "mission-state.json"), "utf8")),
      code: r.status,
    };
    rmSync(root, { recursive: true, force: true });
    return after;
  }

  it("leaves active-run.json with a non-running status after the session ends", () => {
    // The field run's active-run.json still read status:"running" days after the
    // operator killed the session. Whatever closes a run must close this file too.
    const after = runSessionEnd(
      { run_id: "r1", mission_id: "m1", status: "running" },
      { status: "running", tick: 1 },
    );
    expect(after.missionState.status).toBe("paused"); // already implemented
    expect(after.activeRun.status).not.toBe("running");
  });

  it("records when the run was closed, so staleness is computable", () => {
    const after = runSessionEnd(
      { run_id: "r1", mission_id: "m1", status: "running" },
      { status: "running", tick: 1 },
    );
    expect(
      after.activeRun.ended_at ?? after.activeRun.paused_at ?? after.activeRun.closed_at,
    ).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-09 / C-03 — no stall or no-progress guard
// ─────────────────────────────────────────────────────────────────────────────

describe("K-09: a run with no progress past a threshold is reported stalled", () => {
  let tmpRoot: string;
  let savedEvorRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "evor-w1-stall-"));
    savedEvorRoot = process.env.EVOR_ROOT;
    process.env.EVOR_ROOT = tmpRoot;
  });

  afterEach(() => {
    if (savedEvorRoot === undefined) delete process.env.EVOR_ROOT;
    else process.env.EVOR_ROOT = savedEvorRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function seed(tickUpdatedAt: string) {
    const runId = "run-stall-01";
    ensureRunDirs(runId, "m1");
    const paths = resolveRunPaths(runId, "m1");
    writeFileSync(
      paths.runStatePath,
      JSON.stringify({ run_id: runId, status: "running", tick_count: 1, frontier_ids: [] }),
    );
    writeFileSync(
      join(paths.runDir, "tick-state.json"),
      JSON.stringify({
        tick: 1,
        current_step: 9,
        step_status: "running",
        updated_at: tickUpdatedAt,
      }),
    );
    return runId;
  }

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  it("reports stalled when the tick has not advanced for hours", () => {
    // The field run sat at one step for 8h16m with nothing checking liveness.
    const runId = seed(hoursAgo(8));
    const state = stateRead(runId, "m1") as Record<string, unknown>;
    expect(state.stalled).toBe(true);
  });

  it("names the step it stalled at, so the report is actionable", () => {
    const runId = seed(hoursAgo(8));
    const state = stateRead(runId, "m1") as Record<string, unknown>;
    expect(String(state.stall_reason ?? "")).toMatch(/step/i);
  });

  it("does not report stalled for a tick that just advanced", () => {
    const runId = seed(hoursAgo(0));
    const state = stateRead(runId, "m1") as Record<string, unknown>;
    expect(state.stalled ?? false).toBe(false);
  });
});
