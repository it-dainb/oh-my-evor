/**
 * mcp/tests/governor-spawn-shape.test.ts — Phase 0.3 (RALPLAN-DR REV 5)
 *
 * Root cause of run 29d17abc's total enforcement failure: passing `name` to the
 * Agent/Task tool converts the spawn into an in-process teammate. That silently
 *
 *   - bypasses the `hooks.json` matchers (they match `^oh-my-evor:evor-.*`, while
 *     the teammate presents as `forge-t1`, `sage-t1`, …), and
 *   - forces the session model, overriding each agent's `model:` frontmatter —
 *     which is why all 10 agents ran sonnet despite the tiering.
 *
 * No file in this repo passes `name`; the previous run's orchestrator invented
 * those names at runtime. That is precisely why documenting the prohibition is
 * not enough (P2): the rule has to hold against an orchestrator that improvises.
 * A denial is also the only decision that survives `bypassPermissions`.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const PRE_TOOL_USE = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks"), "pre-tool-use.mjs");

function callGovernor(payload: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "evor-spawn-"));
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

describe("governor — spawns must not become teammates", () => {
  for (const tool of ["Task", "Agent"]) {
    it(`denies ${tool} that passes \`name\` for an evor agent`, () => {
      const d = callGovernor({
        tool_name: tool,
        tool_input: { subagent_type: "oh-my-evor:evor-sage", name: "sage-t1", prompt: "…" },
      });
      expect(d.decision).toBe("deny");
      expect(d.reason).toMatch(/name/i);
    });
  }

  it("explains the consequence, not just the rule", () => {
    const d = callGovernor({
      tool_name: "Agent",
      tool_input: { subagent_type: "oh-my-evor:evor-forge", name: "forge-t1", prompt: "…" },
    });
    // PM3: a denial the model cannot act on stalls the run. The reason has to say
    // what to do instead — drop the parameter — not merely that it was rejected.
    expect(d.reason).toMatch(/drop|remove|omit|without/i);
  });

  it("allows the same spawn once `name` is gone", () => {
    // evor-tick, not a lead: since §3b.0 main may not spawn leads directly, using
    // one here would pass for the wrong reason (boundary rule, not the name ban).
    const d = callGovernor({
      tool_name: "Agent",
      tool_input: { subagent_type: "oh-my-evor:evor-tick", prompt: "…" },
    });
    expect(d.decision).not.toBe("deny");
  });

  it("leaves non-evor spawns alone — this is evor's rule, not a global one", () => {
    const d = callGovernor({
      tool_name: "Agent",
      tool_input: { subagent_type: "general-purpose", name: "worker-1", prompt: "…" },
    });
    expect(d.decision).not.toBe("deny");
  });

  it("tolerates an empty `name` rather than denying on the key alone", () => {
    const d = callGovernor({
      tool_name: "Agent",
      tool_input: { subagent_type: "oh-my-evor:evor-tick", name: "", prompt: "…" },
    });
    expect(d.decision).not.toBe("deny");
  });
});
