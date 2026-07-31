/**
 * mcp/tests/governor-enforcement-inventory.test.ts — C5 Stage 0.3
 *
 * One must-deny payload per governor rule. Two purposes:
 *
 *  1. Regression net. `hooks/pre-tool-use.mjs` has 20 deny sites; several had no
 *     test at all, so a refactor could silence them exactly as run 29d17abc's
 *     entire enforcement layer was silenced — with no failing test to notice.
 *
 *  2. The licence for later prose deletion. C5 Stage 4 removes agent/skill prose
 *     that merely restates a rule enforced in code. That deletion is only safe if
 *     the rule is proven to hold WITHOUT the prose. These tests are that proof;
 *     without them, "the hook enforces it" is itself just an assertion.
 *
 * The rules below were previously untested. They are not incidental: the research
 * gates preserve anchoring-bias separation (a proposer must not gather its own
 * evidence), and the artifact-slot guard blocks one role writing into another's
 * slot — a direct self-approval vector, which is the P3 failure this whole plan
 * exists to prevent.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const PRE_TOOL_USE = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks"),
  "pre-tool-use.mjs",
);

function callGovernor(payload: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "evor-inventory-"));
  try {
    const evorRoot = join(dir, ".evor");
    mkdirSync(join(evorRoot, "runs", "m1", "r1"), { recursive: true });
    writeFileSync(join(evorRoot, "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
    const r = spawnSync(process.execPath, [PRE_TOOL_USE], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EVOR_ROOT: evorRoot },
      encoding: "utf8",
      timeout: 10_000,
    });
    const out = (r.stdout ?? "").trim();
    if (!out) return {};
    const parsed = JSON.parse(out.split("\n").pop()!);
    return {
      decision: parsed?.hookSpecificOutput?.permissionDecision,
      reason: parsed?.hookSpecificOutput?.permissionDecisionReason,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const as = (agent: string, tool: string, input: Record<string, unknown> = {}) => ({
  tool_name: tool,
  tool_input: input,
  agent_type: `oh-my-evor:${agent}`,
});

describe("enforcement inventory — Mutagen may not gather its own evidence", () => {
  // Anchoring-bias separation: Mutagen proposes, Sage gathers. A proposer that
  // researches its own evidence anchors on what it already believes, which
  // silently narrows proposal diversity — the search gets worse with no error.
  const RESEARCH_TOOLS = [
    "WebSearch",
    "WebFetch",
    "mcp__claude_ai_Consensus__search",
    "mcp__plugin_oh-my-evor_semantic-scholar__search_papers",
    "mcp__plugin_oh-my-evor_evor__evor_cite",
  ];

  for (const tool of RESEARCH_TOOLS) {
    it(`denies evor-mutagen ${tool}`, () => {
      const d = callGovernor(as("evor-mutagen", tool, { query: "x" }));
      expect(d.decision).toBe("deny");
      expect(d.reason, "must name the delegation route, or the run stalls (PM3)").toMatch(/Sage|investigation_queries/i);
    });
  }

  it("still lets Sage research — the gate is role-scoped, not global", () => {
    expect(callGovernor(as("evor-sage", "WebSearch", { query: "x" })).decision).not.toBe("deny");
  });
});

describe("enforcement inventory — forge-junior reads citations, never discovers them", () => {
  it("denies a web search", () => {
    expect(callGovernor(as("evor-forge-junior", "WebSearch", { query: "x" })).decision).toBe("deny");
  });

  it("denies paper discovery via semantic-scholar", () => {
    const d = callGovernor(
      as("evor-forge-junior", "mcp__plugin_oh-my-evor_semantic-scholar__search_papers", { query: "x" }),
    );
    expect(d.decision).toBe("deny");
  });

  it("ALLOWS reading a specific cited paper — verifying a formula is its job", () => {
    // The narrow arxiv read-only grant. Denying this would force the junior to
    // implement from a paraphrase, which is the citation-fidelity failure mode.
    const d = callGovernor(
      as("evor-forge-junior", "mcp__plugin_oh-my-evor_arxiv__get_paper", { paper_id: "2401.00001" }),
    );
    expect(d.decision, `read-only arxiv access denied: ${d.reason ?? ""}`).not.toBe("deny");
  });

  it("denies arxiv SEARCH even though arxiv reads are allowed", () => {
    const d = callGovernor(
      as("evor-forge-junior", "mcp__plugin_oh-my-evor_arxiv__search_papers", { query: "x" }),
    );
    expect(d.decision, "search is discovery, which belongs to Sage").toBe("deny");
  });
});

describe("enforcement inventory — a role may not write another role's artifact", () => {
  // Direct self-approval vector: if a proposer can write into the reviewer's
  // slot, it can manufacture its own verdict. This is the mechanism behind the
  // `finding:"test", quorum_met:true` incident's whole risk class.
  it("denies mutagen writing into sage's artifact slot", () => {
    const d = callGovernor(
      as("evor-mutagen", "mcp__plugin_oh-my-evor_evor__evor_write_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "sage",
        payload: { finding: "fabricated" },
      }),
    );
    expect(d.decision).toBe("deny");
  });

  it("allows mutagen writing its own slot", () => {
    const d = callGovernor(
      as("evor-mutagen", "mcp__plugin_oh-my-evor_evor__evor_write_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "mutagen",
        payload: { proposals: [] },
      }),
    );
    expect(d.decision, `own-slot write denied: ${d.reason ?? ""}`).not.toBe("deny");
  });
});

describe("enforcement inventory — S2 narrow READ grants for sub-sub-agents", () => {
  // Stage S2: sage-junior, forge-critic, forge-junior are leaf/near-leaf roles
  // that legitimately need to READ one specific upstream slot to do their job
  // (see agents/evor-forge.md spawn prompts + agents/evor-forge-critic.md
  // Check 1). The grant is READ-only, per (role -> specific slot); it must
  // never extend to WRITE, and roles/slots outside the grant list stay denied.

  it("allows forge-junior to READ mutagen's proposal", () => {
    const d = callGovernor(
      as("evor-forge-junior", "mcp__plugin_oh-my-evor_evor__evor_read_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "mutagen",
      }),
    );
    expect(d.decision, `forge-junior read of mutagen denied: ${d.reason ?? ""}`).not.toBe("deny");
  });

  it("denies forge-junior WRITING into mutagen's slot (read grant is not a write grant)", () => {
    const d = callGovernor(
      as("evor-forge-junior", "mcp__plugin_oh-my-evor_evor__evor_write_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "mutagen",
        payload: { proposals: [] },
      }),
    );
    expect(d.decision).toBe("deny");
  });

  it("allows forge-junior to READ forge-critic's verdict (re-attempt feedback)", () => {
    const d = callGovernor(
      as("evor-forge-junior", "mcp__plugin_oh-my-evor_evor__evor_read_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "forge-critic",
      }),
    );
    expect(d.decision, `forge-junior read of forge-critic denied: ${d.reason ?? ""}`).not.toBe("deny");
  });

  it("denies forge-junior WRITING into forge-critic's slot", () => {
    const d = callGovernor(
      as("evor-forge-junior", "mcp__plugin_oh-my-evor_evor__evor_write_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "forge-critic",
        payload: { verdict: "approved" },
      }),
    );
    expect(d.decision).toBe("deny");
  });

  it("allows forge-critic to READ mutagen's proposal", () => {
    const d = callGovernor(
      as("evor-forge-critic", "mcp__plugin_oh-my-evor_evor__evor_read_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "mutagen",
      }),
    );
    expect(d.decision, `forge-critic read of mutagen denied: ${d.reason ?? ""}`).not.toBe("deny");
  });

  it("denies forge-critic WRITING into mutagen's slot", () => {
    const d = callGovernor(
      as("evor-forge-critic", "mcp__plugin_oh-my-evor_evor__evor_write_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "mutagen",
        payload: { proposals: [] },
      }),
    );
    expect(d.decision).toBe("deny");
  });

  it("does NOT grant forge-critic a read of forge-critic's sibling forge-analyst slot (no such need in its prompt)", () => {
    const d = callGovernor(
      as("evor-forge-critic", "mcp__plugin_oh-my-evor_evor__evor_read_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "forge-analyst",
      }),
    );
    expect(d.decision).toBe("deny");
  });

  it("does NOT grant sage-junior any upstream READ — its own prompt has no read call", () => {
    const d = callGovernor(
      as("evor-sage-junior", "mcp__plugin_oh-my-evor_evor__evor_read_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "sage",
      }),
    );
    expect(d.decision).toBe("deny");
  });

  it("sage-junior may still read/write its own slot", () => {
    const d = callGovernor(
      as("evor-sage-junior", "mcp__plugin_oh-my-evor_evor__evor_read_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "sage-junior",
        kind: "angle-a",
      }),
    );
    expect(d.decision).not.toBe("deny");
  });

  it("a role NOT in the grant list (sage-junior) is still denied reading forge-critic's slot", () => {
    // This case originally used forge-analyst reading mutagen. That is exactly a
    // read evor-forge.md's own spawn prompt instructs, so the assertion pinned the
    // defect rather than the property — the harvest suite below now proves it.
    // sage-junior is the right example: nothing anywhere tells it to read this.
    const d = callGovernor(
      as("evor-sage-junior", "mcp__plugin_oh-my-evor_evor__evor_read_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "forge-critic",
      }),
    );
    expect(d.decision).toBe("deny");
  });

  it("mutagen (unrelated role) is still denied reading forge-critic's slot", () => {
    const d = callGovernor(
      as("evor-mutagen", "mcp__plugin_oh-my-evor_evor__evor_read_artifact", {
        run_id: "r1",
        tick: 1,
        agent: "forge-critic",
      }),
    );
    expect(d.decision).toBe("deny");
  });
});

describe("enforcement inventory — .evor state is written through tools, not by hand", () => {
  it("denies a direct write to a run state file", () => {
    const d = callGovernor(
      as("evor-forge", "Write", { file_path: "/w/.evor/runs/m1/r1/run-state.json", content: "{}" }),
    );
    expect(d.decision).toBe("deny");
    expect(d.reason, "must name the tool that owns this file").toMatch(/evor_/);
  });

  it("denies shelling out to the evor CLI", () => {
    const d = callGovernor(as("evor-forge", "Bash", { command: "python -m evor run --tick 1" }));
    expect(d.decision).toBe("deny");
  });

  it("allows writes to a candidate worktree — that is Forge's own surface", () => {
    const d = callGovernor(
      as("evor-forge-junior", "Write", { file_path: "/w/.evor/worktrees/node-a/model.py", content: "x" }),
    );
    expect(d.decision).not.toBe("deny");
  });
});

describe("the governor permits every artifact read the system itself instructs", () => {
  // The general form of the S2 defect, and the reason enumerating grants is not
  // enough. agents/evor-forge.md spawns its sub-agents with prompts that name the
  // artifact each one must read. When the governor denies one of those reads, the
  // system has told an agent to do something it then blocks — 28 of one measured
  // run's 44 EVOR GUARD denials came from exactly that, and the agents responded
  // by reading files off disk and relaying findings through SendMessage, which
  // puts artifact content back into the context the boundary exists to keep out.
  //
  // Same shape as session-start recommending evor_state_read to main. Both are
  // "the instructions and the enforcement disagree", and only one of them is
  // discoverable by reading either file alone.
  const forge = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../agents/evor-forge.md"),
    "utf8",
  );

  /** (spawned role, slot it is told to read) pairs, harvested from spawn prompts. */
  const instructed: Array<[string, string]> = [];
  const SPAWN =
    /subagent_type="oh-my-evor:(evor-[a-z-]+)"[\s\S]{0,80}?prompt=\(([\s\S]*?)\n\s*\)\)/g;
  for (const [, role, body] of forge.matchAll(SPAWN)) {
    for (const [, slot] of body.matchAll(/evor_read_artifact\(agent=['"]([a-z-]+)['"]\)/g)) {
      if (!instructed.some(([r, s]) => r === role && s === slot)) instructed.push([role, slot]);
    }
  }

  it("harvests spawn prompts — a stale regex here would make every case below vacuous", () => {
    expect(instructed.length, "no (role, slot) pairs harvested from evor-forge.md").toBeGreaterThan(2);
  });

  for (const [role, slot] of instructed) {
    it(`${role} may read ${slot}, because its own spawn prompt says to`, () => {
      const d = callGovernor(
        as(role, "mcp__plugin_oh-my-evor_evor__evor_read_artifact", { run_id: "r1", tick: 1, agent: slot }),
      );
      expect(
        d.decision,
        `evor-forge.md tells ${role} to read '${slot}', but the governor denies it: ${d.reason ?? ""}`,
      ).not.toBe("deny");
    });
  }
});
