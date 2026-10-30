/**
 * mcp/tests/governor-mission-liveness.test.ts
 *
 * Main's orchestration rules (no Bash/authoring, spawn only the tick, no direct
 * state reads at the tick boundary) exist to keep a RUNNING mission's ticks in
 * evor-tick. An active-run pointer at a paused or terminal mission is not a run:
 * /evor-setup in such a workspace was denied Bash, evor_state_read, an evor-probe
 * spawn and a memory write, and stopped. State guards stay on regardless.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks/pre-tool-use.mjs");

function decide(missionStatus: string | null, payload: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "evor-live-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  if (missionStatus !== null) {
    writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ mission_id: "m1", status: missionStatus }));
    writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ run_id: "r1", mission_id: "m1", status: missionStatus }));
  }
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

const bash = { tool_name: "Bash", tool_input: { command: "ls" } };
const stateRead = { tool_name: "mcp__plugin_oh-my-evor_evor__evor_state_read", tool_input: {} };
const probe = { tool_name: "Agent", tool_input: { subagent_type: "oh-my-evor:evor-probe", description: "Probe", prompt: "x" } };
const memory = {
  tool_name: "Write",
  tool_input: { file_path: "/home/u/.claude/projects/-home-u-ws/memory/note.md", content: "x" },
};
const handEdit = (status: string) => ({
  tool_name: "Write",
  tool_input: { file_path: ".evor/runs/m1/r1/run-state.json", content: JSON.stringify({ status }) },
});

const denied = (d: Record<string, unknown>) => d.permissionDecision === "deny";

describe("main's orchestration rules apply only while a mission is live", () => {
  for (const status of ["paused", "completed", "failed", "superseded"]) {
    it(`${status}: main may use Bash, read state, spawn evor-probe and write memory`, () => {
      expect(denied(decide(status, bash))).toBe(false);
      expect(denied(decide(status, stateRead))).toBe(false);
      expect(denied(decide(status, probe))).toBe(false);
      expect(denied(decide(status, memory))).toBe(false);
    });

    it(`${status}: the state guard still refuses a hand-edit of run-state.json`, () => {
      expect(denied(decide(status, handEdit("running")))).toBe(true);
    });
  }

  it("running: main is held to the tick boundary", () => {
    expect(denied(decide("running", bash))).toBe(true);
    expect(denied(decide("running", stateRead))).toBe(true);
    expect(denied(decide("running", probe))).toBe(true);
  });

  it("running: main may still write its own memory", () => {
    expect(denied(decide("running", memory))).toBe(false);
  });

  it("running: the state guard refuses a hand-edit of run-state.json", () => {
    expect(denied(decide("running", handEdit("paused")))).toBe(true);
  });

  it("no state files yet: the pointer alone keeps the rules on", () => {
    expect(denied(decide(null, bash))).toBe(true);
    expect(denied(decide(null, probe))).toBe(true);
  });
});
