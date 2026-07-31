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
    expect(sage).toMatch(/investigation_query_ref/);
    expect(sage).toMatch(/null/);
  });
});
