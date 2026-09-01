/**
 * mcp/tests/live-seal-provenance.test.ts
 * LIVE-MODEL wrapper for wave-2 category 1 (M-01 / I-02 / J-01 / O-01).
 *
 * The sibling suite `wave1-seal-provenance.test.ts` pins the LOGIC by calling
 * the tool handlers directly. This one pins the BEHAVIOUR the unit suite cannot
 * see: a real agent, driving the real `mcp/dist/index.cjs` over a real `.evor/`
 * fixture, with the tool-call path actually exercised.
 *
 * That distinction is the point. Lane P-04 found v1.2.0's 2,320-session tier
 * corpus contains not one `tool_use` block — the MCP server was never attached,
 * so every tier claim was measured on agents answering from the prompt alone. A
 * pure unit suite reproduces that same blind spot from the other direction.
 *
 * GATING. These cost money and need API access, so they run only under
 * EVOR_LIVE_EVAL=1. The gate is not a way to hide a failure: when it is ON the
 * tests fail loudly on the invariant, and an unreachable model is graded
 * `error`, never `pass` (see runEpisode's missing-result-envelope branch).
 *
 *   EVOR_LIVE_EVAL=1 npx vitest run tests/live-seal-provenance.test.ts
 *
 * STATISTICS. Each test is ONE episode: an existence proof that the invariant
 * can be violated through the live path, not an estimate of how often. Nothing
 * here reports a rate, and nothing here compares two arms — at n=1 no
 * comparison is supportable.
 */

import { describe, it, expect } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE = process.env.EVOR_LIVE_EVAL === "1";
const MODEL = process.env.LIVE_EVAL_MODEL ?? "sonnet";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = {
  CASES: any[];
  buildServer: () => void;
  runEpisode: (a: { caseObj: any; model: string; maxTurns: number; timeoutMs: number }) => any;
  gradeEpisode: (c: any, e: any) => { verdict: string; tool_calls: boolean | null; invariant: boolean | null; failures: string[] };
};

async function runner(): Promise<Runner> {
  return (await import(resolve(REPO, "ci", "live-seal-eval.mjs"))) as unknown as Runner;
}

/** Run one live case and return its grade plus the tool names actually used. */
async function liveCase(id: string) {
  const r = await runner();
  const caseObj = r.CASES.find((c) => c.id === id);
  if (!caseObj) throw new Error(`no live case ${id}`);
  r.buildServer();
  const episode = r.runEpisode({ caseObj, model: MODEL, maxTurns: 12, timeoutMs: 300_000 });
  const graded = r.gradeEpisode(caseObj, episode);
  return { episode, graded };
}

describe.skipIf(!LIVE)("live — seal and provenance integrity (n=1 per case)", () => {
  /**
   * O-01 — invariant: a node's deliverables are found regardless of which of its
   * two identities the writer used. The fixture is the field shape: tree.json
   * carries id=<uuid> name=<slug>, the harness wrote nodes/<uuid>/results.json,
   * the trainer wrote nodes/<slug>/telemetry.jsonl.
   *
   * Current behaviour: evor_verify_artifacts resolves the slug to the uuid and
   * looks only there, so it reports has_telemetry=false against 400 well-formed
   * records — the same false negative that failed the field run's only
   * successful candidate.
   */
  it("evor_verify_artifacts finds telemetry the trainer wrote under the slug", async () => {
    const { episode, graded } = await liveCase("o01-verify-artifacts");

    expect(graded.verdict, `episode errored: ${graded.failures.join(" | ")}`).not.toBe("error");
    // The mandated call is a precondition, asserted separately so a missing call
    // is never confused with a satisfied invariant.
    expect(
      episode.toolUses,
      "the agent answered without calling evor_verify_artifacts — the tool path was never exercised",
    ).toContain("mcp__evor__evor_verify_artifacts");
    expect(graded.invariant, graded.failures.join(" | ")).toBe(true);
  }, 600_000);

  /**
   * M-01 / I-02 / J-01 — invariants, in the order the grader checks them:
   *   1. a superseded run's sealed evaluator still hashes to the anchor it
   *      recorded (r2's number stays reproducible);
   *   2. a run's sealed evaluator is the sole reference to its inode;
   *   3. re-sealing does not silently re-record the anchor over changed content.
   *
   * The agent is given an operator-approved threshold change and told to apply
   * it and re-seal, i.e. the sanctioned channel. Nothing about the invariant
   * depends on the agent misbehaving.
   */
  it("re-sealing after an approved change does not launder the anchor", async () => {
    const { episode, graded } = await liveCase("j01-reseal-after-threshold-change");

    expect(graded.verdict, `episode errored: ${graded.failures.join(" | ")}`).not.toBe("error");
    expect(
      episode.toolUses,
      "the agent answered without calling evor_seal_eval_script — the seal path was never exercised",
    ).toContain("mcp__evor__evor_seal_eval_script");
    expect(graded.invariant, graded.failures.join(" | ")).toBe(true);
  }, 600_000);
});

describe("live-eval gating", () => {
  /**
   * The gate itself is testable and worth testing: a live suite that silently
   * stops running is how a benchmark goes green on an outage. This runs
   * unconditionally.
   */
  it("live cases are declared and each mandates at least one MCP tool call", async () => {
    const r = await runner();
    expect(r.CASES.length).toBeGreaterThan(0);
    for (const c of r.CASES) {
      expect(c.mandated.length, `case ${c.id} mandates no tool call`).toBeGreaterThan(0);
      for (const t of c.mandated) {
        expect(t, `case ${c.id} mandates a non-MCP tool`).toMatch(/^mcp__evor__/);
        expect(c.tools, `case ${c.id} mandates ${t} without allowing it`).toContain(t);
      }
      // MCP tools are deferred in this CLI: without ToolSearch the agent cannot
      // load the schema, and "never called it" becomes a harness artefact.
      expect(c.tools, `case ${c.id} allows an MCP tool without ToolSearch`).toContain("ToolSearch");
    }
  });
});
