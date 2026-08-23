/**
 * mcp/tests/governor-boundary-enforcement.test.ts — Phase 3b.0 (ralplan-evor-v2)
 *
 * Measured in 3a.2: shipping `evor-tick` as PROSE cut main's context slope 54%
 * but left main running 50 turns/tick — it spawned the boundary AND kept doing
 * the loop (45 evor_read_artifact, 28 evor_state_read, 11 evor_tree_read, plus
 * direct lead spawns). Recurring growth fell only 31%, against an AC5 target of
 * a ~15x reduction, and cost per tick ROSE $14.93 -> $18.59 because the mission
 * funded both the hop and the duplicated work. That is PM2's "we paid for a hop",
 * literally.
 *
 * Root cause is this plan's own P2: the boundary was an instruction in
 * `skills/evor/SKILL.md`, not a rule in the governor. Every other enforced rule
 * here is a deny, because prose already failed once in run 29d17abc — AC2 went
 * 152 -> 1 precisely because it was a deny.
 *
 * So: main may spawn the boundary and decide the mission. It may not read the
 * per-tick detail the boundary exists to absorb. `evor_tree_read` matters most —
 * the tree GROWS with node count, so leaving it in main makes per-tick cost rise
 * across ticks and merely moves the context wall instead of removing it.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const PRE_TOOL_USE = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks"),
  "pre-tool-use.mjs",
);

function callGovernor(payload: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "evor-boundary-"));
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

const MCP = "mcp__plugin_oh-my-evor_evor__";
const asMain = (tool: string, input: Record<string, unknown> = {}) => ({ tool_name: tool, tool_input: input });
const asTick = (tool: string, input: Record<string, unknown> = {}) => ({
  tool_name: tool,
  tool_input: input,
  agent_type: "oh-my-evor:evor-tick",
});

describe("boundary enforcement — main may not absorb per-tick detail", () => {
  const DENIED = [
    [`${MCP}evor_read_artifact`, "45 calls in 3 ticks — the largest single leak"],
    [`${MCP}evor_tree_read`, "the tree grows with node count, so this rises every tick"],
    [`${MCP}evor_state_read`, "28 calls in 3 ticks"],
  ] as const;

  for (const [tool, why] of DENIED) {
    it(`denies main ${tool.replace(MCP, "")} — ${why}`, () => {
      const d = callGovernor(asMain(tool, { run_id: "r1" }));
      expect(d.decision).toBe("deny");
      expect(d.reason, "a deny that does not say what to do instead stalls the run (PM3)").toBeTruthy();
    });
  }

  it("names the boundary in its reason so the orchestrator can recover", () => {
    const d = callGovernor(asMain(`${MCP}evor_read_artifact`, { run_id: "r1" }));
    expect(d.reason).toMatch(/evor-tick/);
  });

  it("denies main spawning a lead directly — that is the boundary's job", () => {
    const d = callGovernor(asMain("Agent", { subagent_type: "oh-my-evor:evor-probe" }));
    expect(d.decision).toBe("deny");
  });
});

describe("boundary enforcement — S2 read-grant change does not touch main's boundary", () => {
  // Pin: broadening sage-junior/forge-critic/forge-junior read grants (S2) must
  // never loosen the orchestrator boundary. Main stays denied on all three
  // boundary-absorbed tools regardless of which `agent` slot it names.
  for (const tool of ["evor_read_artifact", "evor_tree_read", "evor_state_read"]) {
    it(`main is still denied ${tool} even when claiming an in-grant agent slot`, () => {
      const d = callGovernor(asMain(`${MCP}${tool}`, { run_id: "r1", tick: 1, agent: "mutagen" }));
      expect(d.decision).toBe("deny");
    });
  }
});

describe("boundary enforcement — main keeps what it needs to run the mission", () => {
  const ALLOWED = [
    ["Agent", { subagent_type: "oh-my-evor:evor-tick" }, "spawning the boundary"],
    [`${MCP}evor_check_stop`, { run_id: "r1" }, "the stop decision is main's"],
    [`${MCP}evor_check_plateau`, { run_id: "r1" }, "plateau detection is mission-level"],
    [`${MCP}evor_read_goal_contract`, { run_id: "r1" }, "the mission's own contract"],
    [`${MCP}evor_write_handoff`, { run_id: "r1" }, "recording the tick outcome"],
    [`${MCP}evor_capability`, {}, "one-shot hardware probe"],
  ] as const;

  for (const [tool, input, why] of ALLOWED) {
    it(`allows main ${String(tool).replace(MCP, "")} — ${why}`, () => {
      const d = callGovernor(asMain(String(tool), input as Record<string, unknown>));
      expect(d.decision, `${tool} denied: ${d.reason ?? ""}`).not.toBe("deny");
    });
  }
});

describe("boundary enforcement — the boundary itself is unrestricted", () => {
  for (const tool of ["evor_read_artifact", "evor_tree_read", "evor_state_read"]) {
    it(`evor-tick may call ${tool}`, () => {
      const d = callGovernor(asTick(`${MCP}${tool}`, { run_id: "r1" }));
      expect(d.decision, `boundary denied ${tool}: ${d.reason ?? ""}`).not.toBe("deny");
    });
  }

  it("leads may still read artifacts — they are inside the boundary", () => {
    const d = callGovernor({
      tool_name: `${MCP}evor_read_artifact`,
      tool_input: { run_id: "r1" },
      agent_type: "oh-my-evor:evor-forge",
    });
    expect(d.decision).not.toBe("deny");
  });
});

describe("boundary enforcement — TaskOutput is NOT denied (reverted)", () => {
  // Denying TaskOutput removed main's only way to collect a background agent's
  // result. Measured consequence: the run stalled after tick 1 with 0 tree nodes
  // (PM3 enforcement lockout). The leak was the SIZE of the boundary's return,
  // not the act of reading it.
  //
  // The intended fix — a PostToolUse hook rewriting the result via
  // hookSpecificOutput.updatedToolOutput — is documented but INERT in CLI 2.1.220.
  // Probed directly: hook fired (side-effect confirmed, full payload incl.
  // tool_response), six candidate field shapes emitted, none took effect.
  it("allows main TaskOutput", () => {
    expect(callGovernor(asMain("TaskOutput", { task_id: "t1" })).decision).not.toBe("deny");
  });
});
