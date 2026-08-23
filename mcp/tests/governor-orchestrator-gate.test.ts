/**
 * mcp/tests/governor-orchestrator-gate.test.ts — Phase 1.3 (RALPLAN-DR REV 5)
 *
 * AC2 requires orchestrator Bash/Write/Edit per tick = 0. Run 29d17abc recorded
 * 120 Bash / 18 Write / 14 Edit from main.
 *
 * The pre-existing gate only denied main's Bash when the command looked like
 * training (`python ... train`) and its Write/Edit when the path was `.py` or a
 * per-role artifact. Every one of those 120 Bash calls was ordinary exploration —
 * git, ls, cat, grep — so the gate was never even consulted. The rule "Evor is
 * orchestrator-only" existed as prose, and prose is what P2 says does not exist.
 *
 * `permissionDecision: "deny"` is load-bearing here: the failed run used
 * `bypassPermissions` throughout, and deny is the only decision that survives it.
 * A hook that merely emits advisory context would have changed nothing.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const PRE_TOOL_USE = join(HOOKS_DIR, "pre-tool-use.mjs");

/** A live run must exist, or the governor is correctly inert. */
function withActiveRun<T>(fn: (evorRoot: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "evor-gov-"));
  try {
    const evorRoot = join(dir, ".evor");
    mkdirSync(join(evorRoot, "runs", "m1", "r1"), { recursive: true });
    writeFileSync(
      join(evorRoot, "active-run.json"),
      JSON.stringify({ run_id: "r1", mission_id: "m1" }),
    );
    return fn(evorRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Decision = { decision?: string; reason?: string };

function callGovernor(payload: Record<string, unknown>): Decision {
  return withActiveRun((evorRoot) => {
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
  });
}

/** No `agent_type` on the payload is what identifies the main orchestrator. */
const asMain = (tool: string, input: Record<string, unknown>) => ({ tool_name: tool, tool_input: input });
const asAgent = (agent: string, tool: string, input: Record<string, unknown>) => ({
  tool_name: tool,
  tool_input: input,
  agent_type: `oh-my-evor:${agent}`,
});

describe("governor — orchestrator may not do leaf work", () => {
  const ORCHESTRATOR_BASH = [
    "ls -la",
    "git log --oneline -20",
    "cat .evor/runs/m1/r1/run-state.json",
    "grep -rn 'val_score' nodes/",
    "find . -name '*.json'",
  ];

  for (const command of ORCHESTRATOR_BASH) {
    it(`denies main's Bash: ${command.slice(0, 32)}`, () => {
      const d = callGovernor(asMain("Bash", { command }));
      expect(d.decision, `main ran 120 of these; each one must be denied`).toBe("deny");
      expect(d.reason, "deny must carry a corrective reason — the model sees it (PM3)").toBeTruthy();
    });
  }

  it("denies main's Write even to an innocuous path", () => {
    const d = callGovernor(asMain("Write", { file_path: "/tmp/notes.md", content: "x" }));
    expect(d.decision).toBe("deny");
  });

  it("denies main's Edit", () => {
    const d = callGovernor(asMain("Edit", { file_path: "/tmp/notes.md", old_string: "a", new_string: "b" }));
    expect(d.decision).toBe("deny");
  });

  it("names the delegation target in its reason, so the model can recover", () => {
    const d = callGovernor(asMain("Bash", { command: "ls -la" }));
    expect(d.reason).toMatch(/Task|subagent_type|delegate/i);
  });

  // PM3 (enforcement lockout), found by replaying the recorded session through
  // this gate: all 10 files in commands/ dispatch with
  // `cat "${EVOR_PLUGIN_ROOT}/skills/<name>/SKILL.md"`. A blanket Bash denial
  // therefore blocks /evor-run and /evor-resume during an active run — the
  // orchestrator would deny its own dispatch and the run could not be resumed.
  // Reading a skill definition is dispatch, not leaf work.
  describe("skill dispatch is not leaf work", () => {
    const DISPATCH = [
      'cat "${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/evor/SKILL.md"',
      'cat "$CLAUDE_PLUGIN_ROOT/skills/evor-run/SKILL.md"',
      'cat "${EVOR_PLUGIN_ROOT}/skills/evor-resume/SKILL.md"',
    ];
    for (const command of DISPATCH) {
      it(`allows: ${command.slice(0, 44)}`, () => {
        expect(callGovernor(asMain("Bash", { command })).decision).not.toBe("deny");
      });
    }

    it("does not let the exemption smuggle in other work", () => {
      // A compound command that merely mentions a SKILL.md path must not ride
      // the exemption — otherwise the gate is trivially bypassable.
      const d = callGovernor(asMain("Bash", {
        command: 'cat "$CLAUDE_PLUGIN_ROOT/skills/evor/SKILL.md" && rm -rf nodes/',
      }));
      expect(d.decision).toBe("deny");
    });

    it("does not exempt reading arbitrary files under a skills-like path", () => {
      const d = callGovernor(asMain("Bash", { command: 'cat /workspace/skills/notes.md' }));
      expect(d.decision).toBe("deny");
    });
  });

  it("still allows main to spawn agents", () => {
    // Delegation itself must survive the orchestrator-only rule. The target is the
    // tick boundary: §3b.0 routes lead spawns through it, so main delegates the
    // whole tick rather than each lead.
    const d = callGovernor(asMain("Agent", { subagent_type: "oh-my-evor:evor-tick" }));
    expect(d.decision).not.toBe("deny");
  });

  it("still allows main to call evor MCP tools", () => {
    const d = callGovernor(asMain("mcp__plugin_oh-my-evor_evor__record_node", { node_id: "n1" }));
    expect(d.decision).not.toBe("deny");
  });
});

describe("governor — subagents keep the tools their role needs", () => {
  it("lets evor-forge-junior run training", () => {
    const d = callGovernor(asAgent("evor-forge-junior", "Bash", { command: "python train.py" }));
    expect(d.decision).not.toBe("deny");
  });

  it("lets evor-forge-junior write candidate code", () => {
    const d = callGovernor(asAgent("evor-forge-junior", "Write", { file_path: "/w/model.py", content: "x" }));
    expect(d.decision).not.toBe("deny");
  });

  it("lets a lead run ordinary Bash (only main is orchestrator-only)", () => {
    const d = callGovernor(asAgent("evor-sage", "Bash", { command: "ls -la" }));
    expect(d.decision).not.toBe("deny");
  });
});

describe("governor — inert outside a run", () => {
  it("does not deny when there is no active run", () => {
    const dir = mkdtempSync(join(tmpdir(), "evor-gov-norun-"));
    try {
      const evorRoot = join(dir, ".evor");
      mkdirSync(evorRoot, { recursive: true });
      const r = spawnSync(process.execPath, [PRE_TOOL_USE], {
        input: JSON.stringify(asMain("Bash", { command: "ls -la" })),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EVOR_ROOT: evorRoot },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect((r.stdout ?? "").trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
