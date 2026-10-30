/**
 * mcp/tests/validate-proposals-by-id.test.ts
 *
 * The tick knows its proposals by id; Mutagen's artifact holds them in full.
 * evor_validate_proposals resolves ids (or no list at all) from that artifact
 * instead of rejecting the call for missing fields.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerProposalTools } from "../src/tools/proposals.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers = new Map<string, Handler>();
registerProposalTools({
  tool: (name: string, _d: string, _s: unknown, h: Handler) => { handlers.set(name, h); },
} as never);
const call = async (args: Record<string, unknown>) =>
  JSON.parse((await handlers.get("evor_validate_proposals")!(args)).content[0].text);

const PROPOSAL = {
  proposal_id: "prop-a-0",
  parent_node_ids: ["root"],
  approach_family: "training",
  mutation_tier: "parametric",
  mutation_locus: { family: "training", path: "train/" },
  idea: "Replace the constant learning rate with a cosine decay to 1e-5 over the same epochs.",
  hypothesis: { id: "h-prop-a-0", statement: "cosine decay helps the worst domain", prediction: "worst-domain S rises by 2 points" },
  citations: [],
  wildness: 0.5,
};

let root: string;
const saved = { root: process.env.EVOR_ROOT, mission: process.env.EVOR_MISSION_ID };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evor-vp-"));
  const dir = join(root, "runs", "m1", "r1", "ticks", "1", "mutagen");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposals.json"), JSON.stringify({ proposals: [PROPOSAL] }));
  process.env.EVOR_ROOT = root;
  process.env.EVOR_MISSION_ID = "m1";
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["EVOR_ROOT", saved.root], ["EVOR_MISSION_ID", saved.mission]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("evor_validate_proposals resolves proposals from Mutagen's artifact", () => {
  it("accepts proposal ids with run_id and tick", async () => {
    const r = await call({ run_id: "r1", tick: 1, proposals: [{ proposal_id: "prop-a-0" }] });
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(1);
  });

  it("validates every Mutagen proposal when the list is omitted", async () => {
    const r = await call({ run_id: "r1", tick: 1 });
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(1);
  });

  it("names an id that Mutagen did not propose", async () => {
    const r = await call({ run_id: "r1", tick: 1, proposals: [{ proposal_id: "prop-x" }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/prop-x/);
  });

  it("full proposals still validate without a run", async () => {
    const r = await call({ proposals: [PROPOSAL] });
    expect(r.ok).toBe(true);
  });
});

describe("the tick defaults to the one in progress", () => {
  it("ids resolve against tick-state's tick when tick is omitted", async () => {
    writeFileSync(join(root, "runs", "m1", "r1", "tick-state.json"), JSON.stringify({ tick: 1, current_step: 3 }));
    const r = await call({ run_id: "r1", proposals: [{ proposal_id: "prop-a-0" }] });
    expect(r.ok).toBe(true);
  });

  it("without run_id says what is missing, not that proposals are unwritten", async () => {
    const r = await call({ proposals: [{ proposal_id: "prop-a-0" }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/run_id/);
  });
});
