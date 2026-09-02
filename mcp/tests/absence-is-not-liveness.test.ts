/**
 * §1.4, and the invariant §3.2 asserts: **absence of state is never read as liveness.**
 *
 * `readRunState` returned `status: "running"` when the state file was missing AND
 * when it failed to parse. A run that had never written state, or whose write had
 * been truncated, reported itself as live — and three governance gates in
 * `stop.mjs` key on exactly that value while the hook is documented fail-open, so
 * they turn silently permissive rather than loudly wrong.
 *
 * This file is the assertion 3.2 requires. It should keep passing against the
 * transition table when 3.1 lands, rather than being replaced by it.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readRunState, readRunStatus, isRunLive, defaultRunState } from "../src/tools/record.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "evor-absence-"));
}

describe("§1.4 / §3.2 — absence of state is never liveness", () => {
  it("a missing run-state file does not describe a live run", () => {
    const dir = scratch();
    try {
      const state = readRunState(join(dir, "does-not-exist.json"), "r1");
      expect(
        isRunLive(state),
        "a run whose state has never been written is not running. Three stop-hook " +
          "gates key on this value and the hook fails open, so a wrong answer here " +
          "disarms them silently rather than failing loudly.",
      ).toBe(false);
      expect(readRunStatus(state)).toBeUndefined();  // 1.9b: no status at all
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corrupt run-state file does not describe a live run either", () => {
    const dir = scratch();
    try {
      const p = join(dir, "run-state.json");
      writeFileSync(p, '{"run_id": "r1", "status": "run');  // truncated write
      expect(
        isRunLive(readRunState(p, "r1")),
        "the missing-file branch and the parse-failure branch were the same literal. " +
          "Fixing one and not the other leaves the defect reachable by a route nobody " +
          "is watching.",
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a file that genuinely says running is still read as running", () => {
    const dir = scratch();
    try {
      const p = join(dir, "run-state.json");
      writeFileSync(p, JSON.stringify({ run_id: "r1", status: "running", tick_count: 3, frontier_ids: [] }));
      expect(
        isRunLive(readRunState(p, "r1")),
        "the fix must not disarm the gates in the other direction — a genuinely " +
          "running mission still blocks stop",
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the default still carries every field validate.py requires", () => {
    const state = defaultRunState("r1");
    // 1.9b removed `status` from REQUIRED_RUN_STATE_FIELDS at the same time it
    // removed it from this default, so the two still match. Between 1.4 and 1.9b
    // this list included "status" — dropping it from the default first would have
    // made every run fail `run_state_well_formed`.
    for (const field of ["tick_count", "frontier_ids"]) {
      expect(
        state[field],
        `validate.py hard-fails run_state_well_formed when \`${field}\` is absent.`,
      ).toBeDefined();
    }
  });

  it("the default does NOT carry a run status — the field is retired (1.9b)", () => {
    const state = defaultRunState("r1");
    expect(
      "status" in state,
      "AF3 §4.1: a new FSM must REPLACE a field, never accompany it. Re-seeding " +
        "`run-state.status` here is how it comes back as the fifth status field, " +
        "which AF3 names as this redesign's likeliest failure mode.",
    ).toBe(false);
    expect(isRunLive(state)).toBe(false);
  });

  it("absence and liveness are separable questions", () => {
    expect(readRunStatus(undefined)).toBeUndefined();
    expect(readRunStatus({})).toBeUndefined();
    expect(isRunLive(undefined)).toBe(false);
    expect(isRunLive({})).toBe(false);
  });
});
