/**
 * mcp/tests/forge-gate-eval.test.ts — ci/forge-gate-eval.mjs, the offline
 * capability-gate harness for agents/evor-forge.md.
 *
 * Nothing here calls the API. The live path (runMatrix in the .mjs) is reached
 * only by `node ci/forge-gate-eval.mjs` with no args, which this suite never
 * invokes; the pure parse/score/prompt functions are imported directly, the
 * same way mcp/tests/agent-eval.test.ts does.
 *
 * What is being defended: the harness must grade ONLY the three HARD RULES that
 * <Check_Capability_And_Gotchas> already states, and must not reward the two
 * degenerate strategies (always abort, always proceed untouched) that the
 * negative-control cases exist to catch.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import {
  parseGateSection,
  scoreGateCase,
  buildGatePrompt,
  GATE_OUTPUT_CONTRACT,
} from "../../ci/forge-gate-eval.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASES = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "evals/forge/cases.json"), "utf8"),
) as {
  cases: Array<{
    id: string;
    gate: string;
    proposal: Record<string, unknown>;
    expect: { decision: string; batch_size: number | string; constraints: string[] };
  }>;
};

const caseById = (id: string) => {
  const c = CASES.cases.find((x) => x.id === id);
  if (!c) throw new Error(`no such case "${id}" in evals/forge/cases.json`);
  return c;
};

/** A well-formed Capability Gate section, as the prompt asks for it. */
const gateSection = (
  decision: string,
  constraints: string,
  batchSize: string,
) =>
  [
    "## Capability Gate",
    `- decision: ${decision}`,
    "- reason: derived from the payload",
    `- constraints_to_junior: ${constraints}`,
    `- batch_size: ${batchSize}`,
  ].join("\n");

describe("forge-gate-eval: parsing the Capability Gate section", () => {
  it("reads the four fields out of a clean section", () => {
    const parsed = parseGateSection(gateSection("proceed", "none", "unchanged"));
    expect(parsed).toMatchObject({
      decision: "proceed",
      constraints_to_junior: "none",
      batch_size: "unchanged",
    });
    expect(parsed?.reason).toBe("derived from the payload");
  });

  it("finds the section inside a full forge-report and stops at the next heading", () => {
    const report = [
      "## Forge Report — Node n-17",
      "",
      "### Capability Gate",
      "- decision: abort",
      "- reason: flash-attention-2 needs sm_80, host is sm_61",
      "- constraints_to_junior: none",
      "- batch_size: unchanged",
      "",
      "### Team Execution",
      "- decision: proceed",
      "- Forge-junior attempts: 0 total",
    ].join("\n");
    const parsed = parseGateSection(report);
    // The `decision: proceed` line below belongs to Team Execution and must not
    // leak into the gate — section bounds, not a whole-document grep.
    expect(parsed?.decision).toBe("abort");
  });

  it("returns null when there is no Capability Gate section at all", () => {
    expect(parseGateSection("## Forge Report\n\n### Run\n- evor_run_start: called")).toBeNull();
    expect(parseGateSection("")).toBeNull();
    expect(parseGateSection(null as unknown as string)).toBeNull();
  });

  it("returns null when the section exists but never states a decision", () => {
    expect(parseGateSection("## Capability Gate\n- reason: looks fine to me\n")).toBeNull();
  });

  it("tolerates bold/backtick decoration and heading case", () => {
    const parsed = parseGateSection(
      "#### capability gate\n- **decision**: `abort`\n- batch_size: `128`\n",
    );
    expect(parsed?.decision).toBe("abort");
    expect(parsed?.batch_size).toBe("128");
  });
});

describe("forge-gate-eval: scoring the three HARD RULES", () => {
  it("scores the clean baseline correct only when nothing is imposed", () => {
    const c = caseById("clean-proceed");
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "none", "unchanged"))).status)
      .toBe("correct");
    expect(scoreGateCase(c, parseGateSection(gateSection("abort", "none", "unchanged"))).status)
      .toBe("incorrect");
  });

  it("requires the cpu_only constraint to be passed down, not merely noticed", () => {
    const c = caseById("cpu-only-constraint");
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "cpu_only", "unchanged"))).status)
      .toBe("correct");
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "none", "unchanged"))).status)
      .toBe("incorrect");
    // Aborting is also wrong: the proposal is CPU-runnable.
    expect(scoreGateCase(c, parseGateSection(gateSection("abort", "cpu_only", "unchanged"))).status)
      .toBe("incorrect");
  });

  it("requires abort when a hardware-constraint gotcha matches the technique", () => {
    const c = caseById("hw-gotcha-abort");
    expect(scoreGateCase(c, parseGateSection(gateSection("abort", "none", "unchanged"))).status)
      .toBe("correct");
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "no flash-attn", "unchanged"))).status)
      .toBe("incorrect");
  });

  it("does not grade constraints or batch_size once the answer is abort", () => {
    // There is no forge-junior to configure on an abort, so whatever those two
    // fields say is not a defect. Grading them would punish agents for filling
    // in fields the abort makes moot.
    const c = caseById("hw-gotcha-abort");
    const r = scoreGateCase(c, parseGateSection(gateSection("abort", "cpu_only", "64")));
    expect(r.status).toBe("correct");
    expect(r.checks.map((k) => k.name)).toEqual(["decision"]);
  });

  it("substitutes the known-safe batch_size when the gotcha names the same one", () => {
    const c = caseById("batch-size-substitution");
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "none", "128"))).status)
      .toBe("correct");
    // Left at 512 — the OOM config the gotcha recorded.
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "none", "unchanged"))).status)
      .toBe("incorrect");
    // Substituted, but not to the value the gotcha actually recorded as safe.
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "none", "256"))).status)
      .toBe("incorrect");
    // Aborting on a runtime-failure gotcha is rule 2's remedy, not rule 3's.
    expect(scoreGateCase(c, parseGateSection(gateSection("abort", "none", "128"))).status)
      .toBe("incorrect");
  });

  it("accepts the proposal's own batch_size as a spelling of 'unchanged'", () => {
    const c = caseById("batch-size-no-match");
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "none", "unchanged"))).status)
      .toBe("correct");
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "none", "64"))).status)
      .toBe("correct");
    // 128 is the gotcha's safe value, but this proposal's 64 was never the
    // failing config — copying it across RAISES the batch size on OOM evidence.
    expect(scoreGateCase(c, parseGateSection(gateSection("proceed", "none", "128"))).status)
      .toBe("incorrect");
  });

  it("marks a missing section unparseable rather than incorrect", () => {
    const r = scoreGateCase(caseById("clean-proceed"), parseGateSection("no gate here"));
    expect(r.status).toBe("unparseable");
  });
});

describe("forge-gate-eval: the degenerate strategies do not pass", () => {
  const sweep = (section: (c: ReturnType<typeof caseById>) => string) =>
    CASES.cases.filter(
      (c) => scoreGateCase(c, parseGateSection(section(c))).status === "correct",
    ).length;

  it("always-abort scores 1 of 6", () => {
    expect(sweep(() => gateSection("abort", "none", "unchanged"))).toBe(1);
  });

  it("always-proceed-untouched scores 3 of 6", () => {
    expect(sweep(() => gateSection("proceed", "none", "unchanged"))).toBe(3);
  });

  it("only a per-case answer scores 6 of 6", () => {
    expect(
      sweep((c) =>
        gateSection(
          c.expect.decision,
          c.expect.constraints.length ? c.expect.constraints.join(", ") : "none",
          String(c.expect.batch_size),
        ),
      ),
    ).toBe(6);
  });
});

describe("forge-gate-eval: the prompt states everything it grades", () => {
  const agentPromptBlock = "<Agent_Prompt>...forge rules...</Agent_Prompt>";
  const prompt = buildGatePrompt(agentPromptBlock, caseById("batch-size-substitution"));

  it("carries the agent file's own prompt block, not a paraphrase", () => {
    expect(prompt).toContain(agentPromptBlock);
  });

  it("inlines the capability, gotchas and proposal the case is about", () => {
    expect(prompt).toContain("cifar10-resnet");
    expect(prompt).toContain("safe_batch_size");
    expect(prompt).toContain("\"batch_size\": 512");
  });

  it("names every field the scorer reads, so nothing is graded unstated", () => {
    for (const field of ["decision", "reason", "constraints_to_junior", "batch_size"]) {
      expect(GATE_OUTPUT_CONTRACT).toContain(field);
      expect(prompt).toContain(field);
    }
    // The exact token the constraints check looks for.
    expect(prompt).toContain("cpu_only");
    expect(prompt).toContain("unchanged");
  });

  it("tells the agent the MCP tools its own prompt block demands are absent", () => {
    expect(prompt).toContain("evor_capability");
    expect(prompt).toContain("evor_gotcha_query");
    expect(prompt.toLowerCase()).toContain("offline");
  });

  it("does not leak the expected answer into the prompt", () => {
    for (const c of CASES.cases) {
      const p = buildGatePrompt(agentPromptBlock, c);
      expect(p).not.toContain("expect");
      expect(p).not.toContain(c.note);
    }
  });
});
