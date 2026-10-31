/**
 * mcp/tests/tick-owner-routing.test.ts
 *
 * One agent owns a tick. While the tick is unfinished, main resumes that agent
 * by id instead of spawning a second one, and a person's message names the id.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");

function fixture(tickState: Record<string, unknown>, tickDesc = "Tick 14") {
  const root = mkdtempSync(join(tmpdir(), "evor-owner-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ mission_id: "m1", status: "running" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ run_id: "r1", tick_count: 13 }));
  writeFileSync(join(runDir, "tick-state.json"), JSON.stringify(tickState));
  const session = join(root, "proj", "sess");
  mkdirSync(join(session, "subagents"), { recursive: true });
  writeFileSync(join(session, "subagents", "agent-a1b2c3.meta.json"),
    JSON.stringify({ agentType: "oh-my-evor:evor-tick", description: tickDesc, finished: true }));
  writeFileSync(join(session, "subagents", "agent-a1b2c3.jsonl"),
    JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [] } }) + "\n");
  return { root, transcript: `${session}.jsonl` };
}

function hook(name: string, root: string, payload: Record<string, unknown>) {
  const r = spawnSync("node", [join(HOOKS, name)], {
    input: JSON.stringify({ session_id: "s-owner", ...payload }),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? root, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
    cwd: root,
  });
  try { return JSON.parse((r.stdout ?? "").trim().split("\n").pop() || "{}")?.hookSpecificOutput ?? {}; } catch { return {}; }
}

const MID = { tick: 14, current_step: 5, step_status: "running" };
const spawnTick = (transcript: string) => ({
  tool_name: "Agent", transcript_path: transcript,
  tool_input: { subagent_type: "oh-my-evor:evor-tick", description: "Tick 14", prompt: "x" },
});

describe("a tick has one agent", () => {
  it("refuses a second tick agent for an unfinished tick, naming the one to resume", () => {
    const { root, transcript } = fixture(MID);
    const d = hook("pre-tool-use.mjs", root, spawnTick(transcript));
    rmSync(root, { recursive: true, force: true });
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/SendMessage\(\{ to: "a1b2c3"/);
  });

  it("allows the next tick once the current one is finished", () => {
    const { root, transcript } = fixture({ tick: 14, current_step: 9, step_status: "done" });
    const d = hook("pre-tool-use.mjs", root, spawnTick(transcript));
    rmSync(root, { recursive: true, force: true });
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("finds the agent that names the tick, even when an older tick's agent was active later", () => {
    const { root, transcript } = fixture(MID);
    const sub = join(transcript.slice(0, -".jsonl".length), "subagents");
    writeFileSync(join(sub, "agent-old13.meta.json"), JSON.stringify({ agentType: "oh-my-evor:evor-tick", description: "Tick 13" }));
    writeFileSync(join(sub, "agent-old13.jsonl"), JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [] } }) + "\n");
    const d = hook("pre-tool-use.mjs", root, spawnTick(transcript));
    rmSync(root, { recursive: true, force: true });
    expect(d.permissionDecisionReason).toMatch(/a1b2c3/);
  });

  it("refuses an evor-tick whose description names no tick", () => {
    const { root, transcript } = fixture({ tick: 14, current_step: 9, step_status: "done" });
    const d = hook("pre-tool-use.mjs", root, { ...spawnTick(transcript), tool_input: { subagent_type: "oh-my-evor:evor-tick", description: "next evolution step", prompt: "x" } });
    rmSync(root, { recursive: true, force: true });
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/Tick 15/);
  });

  it("allows a tick agent when the existing one ran a different tick", () => {
    const { root, transcript } = fixture(MID, "Tick 13");
    const d = hook("pre-tool-use.mjs", root, spawnTick(transcript));
    rmSync(root, { recursive: true, force: true });
    expect(d.permissionDecision).not.toBe("deny");
  });
});

describe("a person's message during a tick", () => {
  it("carries the tick agent's id", () => {
    const { root, transcript } = fixture(MID);
    const d = hook("user-prompt-submit.mjs", root, { prompt: "try thinner strokes", transcript_path: transcript });
    rmSync(root, { recursive: true, force: true });
    expect(d.additionalContext).toMatch(/Tick 14 is run by agent a1b2c3/);
  });

  it("adds nothing for a task notification", () => {
    const { root, transcript } = fixture(MID);
    const d = hook("user-prompt-submit.mjs", root, { prompt: "<task-notification>x</task-notification>", transcript_path: transcript });
    rmSync(root, { recursive: true, force: true });
    expect(d.additionalContext ?? "").not.toMatch(/EVOR TICK/);
  });
});

describe("after a compaction", () => {
  function postCompact(root: string, transcript: string) {
    const r = spawnSync("node", [join(HOOKS, "post-compact.mjs")], {
      input: JSON.stringify({ session_id: "s-owner", transcript_path: transcript, trigger: "auto" }),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? root, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
      cwd: root,
    });
    try { return String(JSON.parse((r.stdout ?? "").trim().split("\n").pop() || "{}")?.systemMessage ?? ""); } catch { return ""; }
  }
  const checkpoint = (root: string) => {
    const d = join(root, ".evor", "runs", "m1", "r1", "checkpoints");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "precompact-2026-01-01T00-00-00Z.json"), JSON.stringify({ current_tick: 14, current_step: 5, pending_node_ids: [] }));
  };

  it("names the tick agent to resume and never a lead or a denied read", () => {
    const { root, transcript } = fixture(MID);
    checkpoint(root);
    const msg = postCompact(root, transcript);
    rmSync(root, { recursive: true, force: true });
    expect(msg).toMatch(/Tick 14 is run by agent a1b2c3/);
    expect(msg).not.toMatch(/evor-mutagen|evor_state_read|evor_record_eval/);
  });

  it("starts the next tick through evor-tick once the tick is finished, with no checkpoint", () => {
    const { root, transcript } = fixture({ tick: 14, current_step: 9, step_status: "done" });
    const msg = postCompact(root, transcript);
    rmSync(root, { recursive: true, force: true });
    expect(msg).toMatch(/spawn oh-my-evor:evor-tick for tick 15/);
  });
});
