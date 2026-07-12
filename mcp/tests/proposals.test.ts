/**
 * tests/proposals.test.ts
 * Unit tests for tools/proposals.ts — evor_validate_proposals deterministic gates.
 *
 * Tests: H001 (quantified prediction), H002 (streak), H003 (duplicate family),
 * H004 (champion-share), schema, verdict routing, and batch semantics.
 */

import { describe, it, expect } from "vitest";
import {
  gateH001,
  gateH002,
  gateH003,
  gateH004,
  gateSchema,
  validateProposals,
  type ProposalVerdict,
  type ValidationSummary,
} from "../src/tools/proposals.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeProposal(overrides: {
  proposal_id?: string;
  parent_node_ids?: string[];
  approach_family?: string;
  prediction?: string;
  wildness?: number;
  is_acquisition?: boolean;
} = {}) {
  return {
    proposal_id: overrides.proposal_id ?? "p-001",
    parent_node_ids: overrides.parent_node_ids ?? ["node-champion-A"],
    approach_family: overrides.approach_family ?? "training",
    hypothesis: {
      prediction: overrides.prediction ?? "improve accuracy by 2%",
    },
    wildness: overrides.wildness ?? 0.4,
    ...(overrides.is_acquisition !== undefined
      ? { is_acquisition: overrides.is_acquisition }
      : {}),
  };
}

const EMPTY_STRATEGY = { winning_families: [] };

// ── H001: quantified prediction ───────────────────────────────────────────────

describe("gateH001 — quantified prediction", () => {
  it("passes when prediction contains digit + percent", () => {
    expect(gateH001("improve accuracy by 2%")).toBe("pass");
    expect(gateH001("reduce val_loss by 0.5%")).toBe("pass");
  });

  it("passes when prediction contains digit + common units", () => {
    expect(gateH001("reduce latency by 50ms")).toBe("pass");
    expect(gateH001("+300bps on AUC")).toBe("pass");
    expect(gateH001("+5pp on F1")).toBe("pass");
    expect(gateH001("1.5x throughput improvement")).toBe("pass");
  });

  it("passes on a long numeric claim without unit (e.g. reduce loss by 0.05)", () => {
    expect(gateH001("reduce validation loss by 0.05 over baseline")).toBe("pass");
  });

  it("fails on vague qualitative claim", () => {
    expect(gateH001("should improve things a bit")).toBe("fail");
    expect(gateH001("maybe better convergence")).toBe("fail");
  });

  it("fails on empty or whitespace-only prediction", () => {
    expect(gateH001("")).toBe("fail");
    expect(gateH001("   ")).toBe("fail");
  });

  it("fails when digit is present but prediction is too short to be a real claim", () => {
    // Very short strings like "5%" pass via the QUANTIFIED regex
    expect(gateH001("5%")).toBe("pass"); // unit matched
    // A lone digit with no unit and under 10 chars fails
    expect(gateH001("maybe 3")).toBe("fail");
  });
});

// ── H002: win-streak guard ────────────────────────────────────────────────────

describe("gateH002 — 3-tick streak guard", () => {
  it("passes when fewer than 3 winning families (no streak possible)", () => {
    expect(gateH002("training", ["training", "training"])).toBe("pass");
  });

  it("fails when same family won last 3 ticks and proposal is that family", () => {
    expect(gateH002("training", ["arch", "training", "training", "training"])).toBe("fail");
  });

  it("passes when last 3 are streak but proposal is a different family", () => {
    expect(gateH002("arch", ["training", "training", "training"])).toBe("pass");
  });

  it("passes when last 3 are mixed (no streak)", () => {
    expect(gateH002("training", ["arch", "training", "data-curation"])).toBe("pass");
  });

  it("passes when last 3 has streak but proposal breaks it", () => {
    expect(gateH002("data-curation", ["training", "training", "training"])).toBe("pass");
  });
});

// ── H003: intra-tick family uniqueness ───────────────────────────────────────

describe("gateH003 — intra-tick family uniqueness", () => {
  it("passes when family not yet seen in this batch", () => {
    const seen = new Set<string>(["arch", "data-curation"]);
    expect(gateH003("training", seen)).toBe("pass");
  });

  it("fails when family already appears in this batch", () => {
    const seen = new Set<string>(["training"]);
    expect(gateH003("training", seen)).toBe("fail");
  });

  it("passes on first occurrence of any family (empty set)", () => {
    expect(gateH003("arch", new Set())).toBe("pass");
  });
});

// ── H004: champion-share guard ────────────────────────────────────────────────

describe("gateH004 — champion-share guard", () => {
  it("passes when share is exactly floor(N/2)", () => {
    const counts = new Map([["champion-A", 2]]);
    expect(gateH004("champion-A", counts, 4)).toBe("pass"); // 2 <= floor(4/2)=2
  });

  it("fails when share exceeds floor(N/2)", () => {
    // 3 of 4 proposals share parent → 3 > floor(4/2)=2
    const counts = new Map([["champion-A", 3]]);
    expect(gateH004("champion-A", counts, 4)).toBe("fail");
  });

  it("passes with N=3 when share is 1 (well under floor(3/2)=1)", () => {
    const counts = new Map([["champion-A", 1]]);
    expect(gateH004("champion-A", counts, 3)).toBe("pass"); // 1 <= 1
  });

  it("fails with N=3 when 2 of 3 share same parent", () => {
    const counts = new Map([["champion-A", 2]]);
    expect(gateH004("champion-A", counts, 3)).toBe("fail"); // 2 > floor(3/2)=1
  });
});

// ── Schema gate ───────────────────────────────────────────────────────────────

describe("gateSchema — required fields", () => {
  it("passes a fully populated proposal", () => {
    expect(gateSchema(makeProposal())).toBe("pass");
  });

  it("passes when proposal_id is empty (server-generated — no longer a schema gate)", () => {
    // proposal_id is now server-owned; gateSchema must not fail on absent/empty id.
    expect(gateSchema(makeProposal({ proposal_id: "" }))).toBe("pass");
  });

  it("fails when parent_node_ids is empty array", () => {
    expect(gateSchema(makeProposal({ parent_node_ids: [] }))).toBe("fail");
  });

  it("fails when approach_family is blank", () => {
    expect(gateSchema(makeProposal({ approach_family: "  " }))).toBe("fail");
  });

  it("fails when prediction is empty", () => {
    expect(gateSchema(makeProposal({ prediction: "" }))).toBe("fail");
  });
});

// ── validateProposals — verdict routing ──────────────────────────────────────

describe("validateProposals — verdict routing", () => {
  it("verdict=pass for a clean low-wildness proposal set", () => {
    const proposals = [
      makeProposal({ proposal_id: "p-001", approach_family: "training", wildness: 0.3,
                     parent_node_ids: ["nodeA"], prediction: "improve accuracy by 2%" }),
      makeProposal({ proposal_id: "p-002", approach_family: "arch", wildness: 0.4,
                     parent_node_ids: ["nodeB"], prediction: "reduce latency by 50ms" }),
      makeProposal({ proposal_id: "p-003", approach_family: "data-curation", wildness: 0.2,
                     parent_node_ids: ["nodeC"], prediction: "boost F1 by 3pp over baseline" }),
    ];
    const strategy = { winning_families: ["arch", "training", "data-curation"] };
    // last 3 are mixed → no streak; each has unique family + diverse parents
    const summary = validateProposals(proposals, strategy);
    expect(summary.pass_count).toBe(3);
    expect(summary.reject_count).toBe(0);
    expect(summary.needs_llm_count).toBe(0);
    summary.results.forEach(r => expect(r.verdict).toBe("pass"));
  });

  it("verdict=needs_llm for high-wildness proposals (wildness >= 0.8)", () => {
    // Two proposals with distinct parents so H4 passes (share=1 <= floor(2/2)=1).
    // The high-wildness proposal has all other gates passing, so wildness is what
    // pushes it to needs_llm.
    const proposals = [
      makeProposal({ proposal_id: "p-hw", approach_family: "arch", wildness: 0.85,
                     parent_node_ids: ["nodeA"], prediction: "improve accuracy by 5%" }),
      makeProposal({ proposal_id: "p-normal", approach_family: "training", wildness: 0.3,
                     parent_node_ids: ["nodeB"], prediction: "reduce latency by 50ms" }),
    ];
    const summary = validateProposals(proposals, EMPTY_STRATEGY);
    const hwResult = summary.results.find(r => r.proposal_id === "p-hw")!;
    expect(hwResult.verdict).toBe("needs_llm");
    expect(hwResult.h004).toBe("pass"); // 1 <= floor(2/2)=1
    expect(hwResult.reason).toMatch(/wildness.*0\.85/);
  });

  it("verdict=reject when H001 fails (no digit in prediction)", () => {
    const proposals = [
      makeProposal({ proposal_id: "p-noquant", prediction: "might be better somehow",
                     wildness: 0.3 }),
    ];
    const summary = validateProposals(proposals, EMPTY_STRATEGY);
    expect(summary.results[0].verdict).toBe("reject");
    expect(summary.results[0].h001).toBe("fail");
    expect(summary.results[0].reason).toMatch(/h001/);
  });

  it("verdict=reject when schema fails (blank approach_family)", () => {
    // proposal_id is now server-generated and no longer a schema gate field.
    // Use blank approach_family as the schema failure trigger instead.
    const proposals = [
      { parent_node_ids: ["nodeA"], approach_family: "   ",
        hypothesis: { prediction: "improve by 5%" }, wildness: 0.3 },
    ];
    const summary = validateProposals(proposals as never, EMPTY_STRATEGY);
    expect(summary.results[0].verdict).toBe("reject");
    expect(summary.results[0].schema).toBe("fail");
  });

  it("H004 violation: 2 of 3 proposals share same parent → needs_llm for those two", () => {
    // 3 proposals; 2 share "champion-parent" → share=2 > floor(3/2)=1 → H004 fail
    const proposals = [
      makeProposal({ proposal_id: "p-A", approach_family: "training",
                     parent_node_ids: ["champion-parent"], prediction: "improve by 3%" }),
      makeProposal({ proposal_id: "p-B", approach_family: "arch",
                     parent_node_ids: ["champion-parent"], prediction: "reduce loss 0.1 over baseline" }),
      makeProposal({ proposal_id: "p-C", approach_family: "data-curation",
                     parent_node_ids: ["other-parent"], prediction: "boost recall by 4pp" }),
    ];
    const summary = validateProposals(proposals, EMPTY_STRATEGY);
    const byId = Object.fromEntries(summary.results.map(r => [r.proposal_id, r]));

    // p-A and p-B share champion-parent; 2 > floor(3/2)=1 → H004 fail → needs_llm
    expect(byId["p-A"].h004).toBe("fail");
    expect(byId["p-A"].verdict).toBe("needs_llm");
    expect(byId["p-B"].h004).toBe("fail");
    expect(byId["p-B"].verdict).toBe("needs_llm");
    // p-C is on a different parent → passes H004
    expect(byId["p-C"].h004).toBe("pass");
    expect(byId["p-C"].verdict).toBe("pass");
  });

  it("H002 violation: same family as 3-tick streak → needs_llm", () => {
    const proposals = [
      makeProposal({ proposal_id: "p-streak", approach_family: "training",
                     parent_node_ids: ["nodeA"], prediction: "improve accuracy by 2%" }),
    ];
    const strategy = { winning_families: ["training", "training", "training"] };
    const summary = validateProposals(proposals, strategy);
    expect(summary.results[0].h002).toBe("fail");
    expect(summary.results[0].verdict).toBe("needs_llm");
    expect(summary.results[0].reason).toMatch(/h002/);
  });

  it("H003 violation: second proposal with same family → needs_llm", () => {
    const proposals = [
      makeProposal({ proposal_id: "p-first", approach_family: "arch",
                     parent_node_ids: ["nodeA"], prediction: "faster inference 2x" }),
      makeProposal({ proposal_id: "p-dup", approach_family: "arch",
                     parent_node_ids: ["nodeB"], prediction: "improve accuracy by 1%" }),
    ];
    const summary = validateProposals(proposals, EMPTY_STRATEGY);
    expect(summary.results[0].h003).toBe("pass");  // first arch → pass
    expect(summary.results[1].h003).toBe("fail");  // second arch → fail
    expect(summary.results[1].verdict).toBe("needs_llm");
    expect(summary.results[1].reason).toMatch(/h003/);
  });

  it("acquisition proposals always route to needs_llm even if all gates pass", () => {
    const proposals = [
      makeProposal({ proposal_id: "p-acq", approach_family: "data-curation",
                     wildness: 0.3, prediction: "add 5% more data improves F1 by 2pp",
                     is_acquisition: true }),
    ];
    const summary = validateProposals(proposals, EMPTY_STRATEGY);
    expect(summary.results[0].verdict).toBe("needs_llm");
    expect(summary.results[0].reason).toMatch(/acquisition/);
  });

  it("returns correct aggregate counts", () => {
    const proposals = [
      // pass
      makeProposal({ proposal_id: "p-pass", approach_family: "training",
                     parent_node_ids: ["nA"], prediction: "improve by 2%", wildness: 0.3 }),
      // needs_llm (high wildness)
      makeProposal({ proposal_id: "p-llm", approach_family: "arch",
                     parent_node_ids: ["nB"], prediction: "reduce latency 50ms", wildness: 0.9 }),
      // reject (no digit in prediction)
      makeProposal({ proposal_id: "p-rej", approach_family: "data-curation",
                     parent_node_ids: ["nC"], prediction: "maybe better", wildness: 0.2 }),
    ];
    const summary = validateProposals(proposals, EMPTY_STRATEGY);
    expect(summary.total).toBe(3);
    expect(summary.pass_count).toBe(1);
    expect(summary.needs_llm_count).toBe(1);
    expect(summary.reject_count).toBe(1);
  });
});

// ── Class 7 schema-fabrication fixes ─────────────────────────────────────────

describe("proposal_id — server-generated when absent (Class 7)", () => {
  it("assigns a non-empty proposal_id when agent omits it", () => {
    const proposals = [
      {
        // no proposal_id
        parent_node_ids: ["nodeA"],
        approach_family: "training",
        hypothesis: { prediction: "improve accuracy by 2%" },
        wildness: 0.3,
      },
    ];
    const summary = validateProposals(proposals as never, EMPTY_STRATEGY);
    expect(summary.results[0].proposal_id).toBeTruthy();
    expect(summary.results[0].proposal_id.length).toBeGreaterThan(0);
  });

  it("each absent proposal_id gets a distinct generated value", () => {
    const proposals = [
      {
        parent_node_ids: ["nodeA"],
        approach_family: "training",
        hypothesis: { prediction: "improve by 2%" },
        wildness: 0.3,
      },
      {
        parent_node_ids: ["nodeB"],
        approach_family: "arch",
        hypothesis: { prediction: "reduce loss by 0.05 over baseline" },
        wildness: 0.4,
      },
    ];
    const summary = validateProposals(proposals as never, EMPTY_STRATEGY);
    expect(summary.results[0].proposal_id).not.toBe(summary.results[1].proposal_id);
  });

  it("preserves agent-supplied proposal_id when present", () => {
    const proposals = [makeProposal({ proposal_id: "my-explicit-id" })];
    const summary = validateProposals(proposals, EMPTY_STRATEGY);
    expect(summary.results[0].proposal_id).toBe("my-explicit-id");
  });

  it("gateSchema passes when proposal_id is absent (no longer required)", () => {
    const proposal = {
      parent_node_ids: ["nodeA"],
      approach_family: "training",
      hypothesis: { prediction: "improve accuracy by 2%" },
      wildness: 0.3,
    };
    expect(gateSchema(proposal as never)).toBe("pass");
  });

  it("gateSchema still fails when parent_node_ids is empty (semantic field)", () => {
    const proposal = {
      parent_node_ids: [],
      approach_family: "training",
      hypothesis: { prediction: "improve accuracy by 2%" },
      wildness: 0.3,
    };
    expect(gateSchema(proposal as never)).toBe("fail");
  });
});

describe("critic_review — server-populated (Class 7)", () => {
  it("validateProposals result has all gate fields set (for server critic_review wiring)", () => {
    // The tool handler populates critic_review from gate results;
    // validateProposals itself returns the gate fields that are used to build it.
    // Use 2 proposals with distinct parents so H004 passes (share=1 <= floor(2/2)=1).
    const proposals = [
      makeProposal({ proposal_id: "p-cr-001", prediction: "improve by 2%",
                     approach_family: "training", parent_node_ids: ["nodeA"] }),
      makeProposal({ proposal_id: "p-cr-002", prediction: "reduce latency 50ms",
                     approach_family: "arch", parent_node_ids: ["nodeB"] }),
    ];
    const summary = validateProposals(proposals, EMPTY_STRATEGY);
    const r = summary.results[0];
    // Gate fields are always present — these are what the tool maps to critic_review.
    expect(r.h001).toBe("pass");
    expect(r.h002).toBe("pass");
    expect(r.h003).toBe("pass");
    expect(r.h004).toBe("pass");
    expect(r.schema).toBe("pass");
    expect(r.verdict).toBe("pass");
  });

  it("rejected proposal has h001=fail gate result available for critic_review mapping", () => {
    const proposals = [makeProposal({ proposal_id: "p-cr-rej", prediction: "maybe better" })];
    const summary = validateProposals(proposals, EMPTY_STRATEGY);
    const r = summary.results[0];
    expect(r.h001).toBe("fail");
    expect(r.verdict).toBe("reject");
    expect(r.reason).toMatch(/h001/);
  });
});
