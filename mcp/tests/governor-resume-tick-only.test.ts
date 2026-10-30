/**
 * mcp/tests/governor-resume-tick-only.test.ts
 *
 * While a mission is live, main resumes only the tick. In the 2026-10-30
 * binarization mission main resumed Forge directly (the tick had told it to),
 * and every later Forge wake-up — about 45 — became a turn in main.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks/pre-tool-use.mjs");

function decide(payload: Record<string, unknown>, missionStatus = "running", posture?: string, transcript = "") {
  const root = mkdtempSync(join(tmpdir(), "evor-resume-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ mission_id: "m1", status: missionStatus }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ run_id: "r1" }));
  if (posture) writeFileSync(join(runDir, "goal-contract.json"), JSON.stringify({ autonomy_charter: { posture } }));
  const sessionDir = join(root, "proj", "sess");
  mkdirSync(join(sessionDir, "subagents"), { recursive: true });
  for (const [id, type] of [["atick", "oh-my-evor:evor-tick"], ["aforge", "oh-my-evor:evor-forge"], ["agp", "general-purpose"]]) {
    writeFileSync(join(sessionDir, "subagents", `agent-${id}.meta.json`), JSON.stringify({ agentType: type }));
  }
  writeFileSync(`${sessionDir}.jsonl`, JSON.stringify({ type: "user", message: { content: transcript } }) + "\n");
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", transcript_path: `${sessionDir}.jsonl`, ...payload }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOK, "../..") },
    cwd: root,
  });
  rmSync(root, { recursive: true, force: true });
  try { return JSON.parse((r.stdout ?? "").trim().split("\n").pop() || "{}")?.hookSpecificOutput ?? {}; } catch { return {}; }
}

const send = (to: string) => ({ tool_name: "SendMessage", tool_input: { to, message: "resume" } });

describe("main resumes only the tick", () => {
  it("denies main resuming Forge during a live mission", () => {
    const d = decide(send("aforge"));
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/evor-tick agent that owns this tick/);
  });

  it("allows main resuming the tick", () => {
    expect(decide(send("atick")).permissionDecision).not.toBe("deny");
  });

  it("leaves non-evor agents and unknown addresses alone", () => {
    expect(decide(send("agp")).permissionDecision).not.toBe("deny");
    expect(decide(send("someone-named")).permissionDecision).not.toBe("deny");
  });

  it("does not restrict a sub-agent resuming its own child", () => {
    expect(decide({ agent_type: "oh-my-evor:evor-tick", ...send("aforge") }).permissionDecision).not.toBe("deny");
  });

  it("does not apply when no mission is live", () => {
    expect(decide(send("aforge"), "paused").permissionDecision).not.toBe("deny");
  });

  it("lets main call evor_wait", () => {
    const d = decide({ tool_name: "mcp__plugin_oh-my-evor_evor__evor_wait", tool_input: { job_id: "j1" } });
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("denies main AskUserQuestion on a running aggressive-never-halt mission", () => {
    const ask = { tool_name: "AskUserQuestion", tool_input: { questions: [] } };
    const d = decide(ask, "running", "aggressive-never-halt");
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/Monotonic-Honesty/);
    expect(decide(ask, "running", "conservative").permissionDecision).not.toBe("deny");
    // Paused is not an exception: main paused itself and asked anyway (2026-10-30).
    expect(decide(ask, "paused", "aggressive-never-halt").permissionDecision).toBe("deny");
  });

  it("lets setup ask: the session's latest slash command is evor-setup", () => {
    const ask = { tool_name: "AskUserQuestion", tool_input: { questions: [] } };
    const d = decide(ask, "paused", "aggressive-never-halt", "<command-name>/oh-my-evor:evor-setup</command-name>");
    expect(d.permissionDecision).not.toBe("deny");
    const r = decide(ask, "paused", "aggressive-never-halt", "<command-name>/oh-my-evor:evor-run</command-name>");
    expect(r.permissionDecision).toBe("deny");
  });
});
