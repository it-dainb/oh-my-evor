/**
 * mcp/tests/sage-gate.test.ts
 *
 * The P1-8 conditional Sage gate skipped Sage entirely when the wiki already
 * answered every angle Mutagen raised, the approach family had been tried, and
 * wildness was below 0.7.
 *
 * Every one of those is a CONVERGENCE signal. So the gate switched off the only
 * channel that can widen the hypothesis space at exactly the moment the search was
 * settling into familiar ground — and nothing in the loop noticed, because the
 * only thing it measured was cost saved.
 *
 * Why it cannot self-correct: Mutagen can only ask about what it already suspects,
 * and Sage (pre-A4) only ever answered Mutagen. A mission that stops asking new
 * questions therefore stops receiving new ideas, permanently.
 *
 * Measured on the ladder run: evor-sage spawned in 1 of 3 ticks, all ticks at
 * wildness 0.3-0.55, sage_proactive_findings = 0. A4's self-directed angle read as
 * "not working" when it had simply never been given a tick to run in.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const loop = readFileSync(join(REPO, "skills", "evor", "SKILL.md"), "utf8");
const sage = readFileSync(join(REPO, "agents", "evor-sage.md"), "utf8");

/** The P1-8 gate block, so assertions are scoped to the gate and not the file. */
function gateBlock(): string {
  const start = loop.indexOf("P1-8");
  expect(start, "P1-8 gate not found — this test is stale").toBeGreaterThan(-1);
  const end = loop.indexOf("POST-CONDITION", start);
  return loop.slice(start, end === -1 ? start + 4000 : end);
}

describe("the conditional Sage gate narrows Sage, it never skips it", () => {
  it("no longer instructs skipping Sage entirely", () => {
    expect(
      gateBlock(),
      "skipping Sage outright disables the only channel that widens the hypothesis space",
    ).not.toMatch(/skip sage entirely/i);
  });

  it("routes the convergent case to a self-directed angle instead", () => {
    expect(gateBlock()).toMatch(/self-directed angle/i);
  });

  it("says Sage is never skipped outright", () => {
    expect(gateBlock()).toMatch(/never skipped outright/i);
  });

  it("still allows the cheap path — full scope is conditional, not mandatory", () => {
    // The gate exists for a real reason: full Sage on every tick is expensive.
    // Narrowing is the fix, not removing the gate.
    expect(gateBlock()).toMatch(/FULL scope/);
    expect(gateBlock()).toMatch(/wildness/i);
  });
});

describe("the loop and the agent agree about the self-directed angle", () => {
  // A4 lives in agents/evor-sage.md; the gate that decides whether Sage runs at all
  // lives in skills/evor/SKILL.md. If those two disagree, the channel is dead and
  // both files still read as correct — which is exactly how this was missed.
  it("the loop points at the protocol step the agent actually defines", () => {
    expect(gateBlock()).toMatch(/Step 1b/);
    expect(sage, "agents/evor-sage.md must define the step the loop references").toMatch(/Step 1b/);
  });

  it("the agent's self-directed findings are identifiable, so the channel is measurable", () => {
    // Was asserting investigation_query_ref + null, which is the OLD contract and
    // passed for the wrong reason: both strings appear in the file regardless.
    expect(sage).toMatch(/self_directed/);
  });
});

describe("fields an agent is told to set must exist in the schema it is shown", () => {
  /**
   * A4 instructed Sage to mark self-chosen findings by setting
   * `investigation_query_ref: null` on each finding. That field is ARTIFACT-level —
   * one per tick — and findings have no such key. So the instruction was
   * unfollowable, and the analyzer that counted it measured a level where nothing
   * could ever appear. Two full runs reported "0 proactive findings" as if it said
   * something about Sage's behaviour. It only said the measurement was aimed at a
   * field that does not exist there.
   *
   * Both halves read as correct in isolation, which is the whole difficulty. The
   * check that catches it is cross-file: the instruction and the schema must agree.
   */
  const schemaBlock = (() => {
    // The documented CitationBackedFinding shape: the JSON object containing
    // "quorum_met", which is the finding-level marker field. Match the quoted
    // JSON key, not the bare word — prose above the schema names the field too
    // ("report quorum_met=false"), and anchoring on the first mention pointed
    // this block at the SotaVerifier prose instead of the schema.
    const i = sage.indexOf('"quorum_met"');
    expect(i, "finding schema not found — this test is stale").toBeGreaterThan(-1);
    return sage.slice(Math.max(0, i - 1200), i + 400);
  })();

  it("the self-directed marker is a per-finding field in the documented schema", () => {
    expect(
      schemaBlock,
      "Step 1b tells Sage to mark individual findings, so the marker must live on a finding",
    ).toMatch(/self_directed/);
  });

  it("the instruction names that same field", () => {
    const step1b = sage.slice(sage.indexOf("Step 1b"), sage.indexOf("Step 1b") + 1800);
    expect(step1b).toMatch(/self_directed/);
  });

  it("the instruction no longer names the artifact-level field it cannot set per finding", () => {
    const step1b = sage.slice(sage.indexOf("Step 1b"), sage.indexOf("Step 1b") + 1800);
    // It may mention investigation_query_ref to EXPLAIN why it is wrong, but must
    // not instruct setting it as the marker.
    expect(step1b).not.toMatch(/Set `investigation_query_ref/);
  });
});

describe("S1 — routing Mutagen's queries to Sage is unconditional, including tick 1", () => {
  /**
   * Traced from two full runs. Spawn sequences:
   *   tick 1: wiki_query -> mutagen -> selector -> forge      <- Sage never considered
   *   tick 2: read_handoff -> mutagen -> write_handoff -> wiki+gotcha -> SAGE -> selector
   *   tick 3: read_handoff -> mutagen -> write_handoff -> SAGE -> selector
   *
   * Every tick that began by READING an inbound handoff spawned Sage; tick 1, which has
   * none, did not. `evor_write_handoff` is overloaded — it does within-tick routing
   * (Mutagen -> Sage) and between-tick continuity — so with nothing inbound to anchor on,
   * tick 1's agent treated the handoff as an end-of-tick artifact and never entered the
   * route-to-Sage sub-procedure.
   *
   * It compounded: Sage's POST-CONDITION was nested INSIDE the conditional gate, while
   * Mutagen's sits at step level. An agent that never enters the gate never sees the
   * check that would have caught the omission.
   *
   * Tick 1 is the worst possible tick to lose: the wiki is empty, so it is the tick where
   * external grounding is the only grounding available.
   */
  const step2 = (() => {
    const i = loop.indexOf("2. **Every tick routes");
    expect(i, "step 2 not found — this test is stale").toBeGreaterThan(-1);
    return loop.slice(i, loop.indexOf("3. Attach Sage's findings", i));
  })();

  it("states the step is unconditional and names tick 1", () => {
    expect(step2).toMatch(/unconditional/i);
    expect(step2).toMatch(/tick 1/i);
  });

  it("explains that the two uses of evor_write_handoff are different jobs", () => {
    expect(step2).toMatch(/WITHIN this tick/i);
    expect(step2).toMatch(/NEXT tick/i);
  });

  it("carries a post-condition that applies whatever the gate decided", () => {
    const pc = step2.slice(step2.indexOf("POST-CONDITION"));
    expect(pc).toMatch(/every tick/i);
    expect(pc).toMatch(/whatever the gate/i);
  });

  it("forbids advancing to Selector with no Sage artifact", () => {
    expect(step2).toMatch(/not proceed to step 3|before advancing to Selector/i);
  });

  it("Mutagen's post-condition is still step-level, so the two are symmetric", () => {
    // The asymmetry is what hid this: one check always applied, the other did not.
    const step1 = loop.slice(loop.indexOf('1. `Task(subagent_type="oh-my-evor:evor-mutagen"'), loop.indexOf("2. **Every tick routes"));
    expect(step1).toMatch(/POST-CONDITION/);
  });
});
