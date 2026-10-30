/**
 * mcp/tests/tick-completeness-hypothesis-ids.test.ts
 *
 * The server assigns each proposal a hypothesis id distinct from its proposal id
 * (h-<proposal_id>), and Forge records the node with the hypothesis id. Matching
 * selected proposals to nodes by proposal id alone reported every candidate as
 * "missing a node" although both were trained, evaluated and integrity-checked.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { owed } from "../../hooks/lib/tick-completeness.mjs";

function run(nodeHypothesisId: string) {
  const r = mkdtempSync(join(tmpdir(), "evor-tc-"));
  const t = join(r, "ticks", "4");
  mkdirSync(join(t, "selector"), { recursive: true });
  mkdirSync(join(t, "mutagen"), { recursive: true });
  mkdirSync(join(r, "evaluations"), { recursive: true });
  mkdirSync(join(r, "nodes", "n1"), { recursive: true });
  writeFileSync(join(t, "selector", "verdict.json"), JSON.stringify({ reviews: [{ proposal_id: "prop-abc-0", selected: true }] }));
  writeFileSync(join(t, "mutagen", "proposals.json"), JSON.stringify({ proposals: [{ proposal_id: "prop-abc-0", hypothesis: { id: "h-prop-abc-0" } }] }));
  writeFileSync(join(r, "tree.json"), JSON.stringify({ nodes: { n1: { id: "n1", name: "t4-x", hypothesis_id: nodeHypothesisId, fitness_value: 1.2 } } }));
  writeFileSync(join(r, "evaluations", "n1.json"), "{}");
  writeFileSync(join(r, "nodes", "n1", "telemetry.jsonl"), '{"step":1}\n');
  const o = owed(r, 4);
  rmSync(r, { recursive: true, force: true });
  return o;
}

describe("a selected proposal is matched by its hypothesis id too", () => {
  it("discharges a proposal whose node carries the server-assigned hypothesis id", () => {
    expect(run("h-prop-abc-0")).toEqual([]);
  });
  it("still discharges a node recorded with the proposal id itself", () => {
    expect(run("prop-abc-0")).toEqual([]);
  });
  it("still reports a proposal with no node", () => {
    expect(run("someone-else")).toEqual([{ proposal_id: "prop-abc-0", missing: ["node"] }]);
  });
});
