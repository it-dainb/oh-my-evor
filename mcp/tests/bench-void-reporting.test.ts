/**
 * mcp/tests/bench-void-reporting.test.ts — the harness's report on itself.
 *
 * The lite calibration exposed three ways the runner misdescribed its own
 * failures. None of them changed a verdict; all three sent a reader to the
 * wrong fix, which is worse than saying nothing:
 *
 *   - Both T2 voids were labelled `budget_exceeded` when the run had hit a
 *     denial, because the code keyed off the detector's TYPE (`trace`) rather
 *     than what fired.
 *   - The SATURATION line reported 5.6% against a true harness-caused rate of
 *     38.9% — a 7x undercount, from the one check whose job is to stop a run
 *     being read as more covered than it is.
 *   - A denial of a tool the bench never granted was counted as an undeclared
 *     governor denial, voiding two runs because evor-sage-junior reached for
 *     the Tier-3 web fallback its own agent file documents.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { undeclaredDenials } from "../../ci/bench-detect.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runner = () => readFileSync(join(REPO_ROOT, "ci", "bench-run.mjs"), "utf8");

describe("void reporting", () => {
  it("attributes a void from what fired, not from the detector's kind", () => {
    const src = runner();
    // The bug in one line: `voided.kind === 'denial' ? ... : 'budget_exceeded'`.
    expect(src).not.toMatch(/voided\.kind === 'denial' \? 'denied_undeclared' : 'budget_exceeded'/);
    expect(src).toContain('"denied":');
    expect(src).toContain("turns_at_ceiling");
    expect(src).toContain("denied_undeclared");
  });

  it("the saturation check counts every harness-caused void", () => {
    const src = runner();
    expect(src).toMatch(/failure_kind === 'harness_error'/);
    expect(src).toMatch(/failure_kind === 'evaluator_error'/);
  });

  it("a denial of a tool the bench never granted is not an undeclared denial", () => {
    const ctx = {
      denials: [{ tool_name: "WebFetch" }, { tool_name: "WebSearch" }],
      harness_allowed_tools: ["mcp__evor", "Read", "Glob", "Grep", "Bash", "Write", "Edit"],
    };
    expect(undeclaredDenials(ctx)).toEqual([]);
  });

  it("...but a denial of a tool it DID grant still voids", () => {
    // The governor firing on a granted tool is a real, undeclared denial and
    // must keep voiding. Weakening this would hide the product's own guards.
    const ctx = {
      denials: [{ tool_name: "Write" }],
      harness_allowed_tools: ["mcp__evor", "Read", "Write"],
    };
    expect(undeclaredDenials(ctx)).toHaveLength(1);
  });

  it("evor_* denials are matched against the mcp__evor grant", () => {
    const granted = { harness_allowed_tools: ["mcp__evor", "Read"] };
    expect(undeclaredDenials({ ...granted, denials: [{ tool_name: "evor_state_read" }] })).toHaveLength(1);
    expect(undeclaredDenials({ ...granted, denials: [{ tool_name: "AskUserQuestion" }] })).toEqual([]);
  });
});
