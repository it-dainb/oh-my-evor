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
      updatedInput: parsed?.hookSpecificOutput?.updatedInput,
      systemMessage: parsed?.hookSpecificOutput?.systemMessage,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("governor — spawns must not become teammates", () => {
  // ITEM 4.4 CHANGED THE INSTRUMENT, NOT THE RULE.
  //
  // These three cases asserted `deny`. Denying was measured: 19 of 26 spawn
  // denials in the field run were this rule, the most-fired of any, and it
  // collides with `SendMessage` addressing — wanting to be addressable is a
  // reasonable thing to want. The orchestrator did not comply, it retried.
  //
  // The GUARANTEE this file exists for is unchanged and is now stronger: a spawn
  // still never becomes a teammate, because `name` is REMOVED rather than the
  // call refused. `updatedInput` does that; AF5 §0 records that it was available
  // all along and unused. Each case now spawns from `evor-tick` so the name rule
  // is what is exercised — spawning a lead from main is denied by the §3b.0
  // boundary guard, which would make these pass for the wrong reason.
  for (const tool of ["Task", "Agent"]) {
    it(`strips \`name\` from ${tool} rather than refusing the spawn`, () => {
      const d = callGovernor({
        tool_name: tool,
        agent_type: "oh-my-evor:evor-tick",
        tool_input: { subagent_type: "oh-my-evor:evor-sage", name: "sage-t1", prompt: "…" },
      });
      expect(d.decision).not.toBe("deny");
      expect(d.updatedInput, "the spawn must proceed, without the parameter").toBeDefined();
      expect("name" in (d.updatedInput ?? {})).toBe(false);
      expect(d.updatedInput.subagent_type).toBe("oh-my-evor:evor-sage");
    });
  }

  it("explains the consequence, not just the rule", () => {
    const d = callGovernor({
      tool_name: "Agent",
      agent_type: "oh-my-evor:evor-tick",
      tool_input: { subagent_type: "oh-my-evor:evor-forge", name: "forge-t1", prompt: "…" },
    });
    // PM3: a decision the model cannot act on stalls the run. It now does not
    // have to act at all — the call was repaired — but it is still told what
    // happened and why, so the next spawn is written correctly.
    expect(d.systemMessage).toMatch(/name/i);
    expect(d.systemMessage).toMatch(/drop|remove|omit|without/i);
    expect(d.systemMessage).toMatch(/model|tier|frontmatter/i);
  });

  it("a spawn that is denied for another reason stays denied", () => {
    // The repair must not become a bypass: main spawning a lead is a §3b.0
    // violation whatever `name` says, so the strip is applied only after every
    // deny rule has had its chance.
    const d = callGovernor({
      tool_name: "Task",
      tool_input: { subagent_type: "oh-my-evor:evor-forge", name: "forge-t1", prompt: "…" },
    });
    expect(d.decision).toBe("deny");
    expect(d.updatedInput).toBeUndefined();
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
