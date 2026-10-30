/**
 * mcp/tests/subagent-foreground-spawn.test.ts
 *
 * A sub-agent may not spawn in the background. A foreground Agent/Task call
 * blocks until the child returns — the wait primitive — and several in one
 * message are all awaited. A background spawn ends the caller's turn, and
 * nothing wakes a sub-agent when its child finishes: the notice goes to main.
 *
 * Same seed, same CLI (2.1.312): 13 foreground / 0 background spawns ran the whole
 * tick (1 node); 3 foreground / 4 background stalled at Sage and exited 0 nodes.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks/pre-tool-use.mjs");

function decide(payload: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "evor-fg-"));
  mkdirSync(join(root, ".evor", "runs", "m1", "r1"), { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", ...payload }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOK, "../..") },
    cwd: root,
  });
  rmSync(root, { recursive: true, force: true });
  try {
    return JSON.parse((r.stdout ?? "").trim().split("\n").pop() || "{}")?.hookSpecificOutput ?? {};
  } catch {
    return {};
  }
}

const juniorSpawn = (background: boolean) => ({
  tool_name: "Agent",
  tool_input: {
    subagent_type: "oh-my-evor:evor-sage-junior",
    description: "Research angle: x",
    prompt: "research",
    ...(background ? { run_in_background: true } : {}),
  },
});

describe("sub-agents spawn in the foreground", () => {
  it("denies a background spawn from a sub-agent — Sage fanning out to juniors", () => {
    const d = decide({ agent_type: "oh-my-evor:evor-sage", ...juniorSpawn(true) });
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/FOREGROUND/);
    expect(d.permissionDecisionReason).toMatch(/ONE message/);
  });

  it("allows the same spawn in the foreground", () => {
    const d = decide({ agent_type: "oh-my-evor:evor-sage", ...juniorSpawn(false) });
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("does not restrict main, which is woken by completion notices", () => {
    const d = decide({
      tool_name: "Agent",
      tool_input: { subagent_type: "oh-my-evor:evor-tick", description: "Tick 1", prompt: "x", run_in_background: true },
    });
    expect(d.permissionDecisionReason ?? "").not.toMatch(/may not spawn a sub-agent in the background/);
  });
});
