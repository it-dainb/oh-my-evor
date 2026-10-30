/**
 * mcp/tests/resume-hint-tick-boundary.test.ts
 *
 * The [EVOR RESUME] hint told main to call evor_state_read and evor_tree_read —
 * the two calls the governor denies main while a mission runs — so every resume
 * prompt on a running mission began with two denials (binarization, 2026-10-30).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks/user-prompt-submit.mjs");

function hint(missionStatus: string, prompt = "resume the evor mission") {
  const root = mkdtempSync(join(tmpdir(), "evor-hint-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ mission_id: "m1", status: missionStatus }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ run_id: "r1", tick_count: 2 }));
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, session_id: "s1" }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOK, "../..") },
    cwd: root,
  });
  rmSync(root, { recursive: true, force: true });
  return r.stdout;
}

describe("the resume hint respects the tick boundary", () => {
  it("on a running mission, sends main through the tick and names no denied call as a step", () => {
    const out = hint("running");
    expect(out).toMatch(/\[EVOR RESUME\]/);
    expect(out).toMatch(/evor-tick/);
    expect(out).not.toMatch(/Call evor_state_read/);
  });

  it("does not prescribe a blocking wait on an agent that will report by itself", () => {
    const out = hint("running");
    expect(out).not.toMatch(/evor_wait/);
    expect(out).toMatch(/end your turn/);
  });

  it("is silent on a background task's completion notice, which is not a person's prompt", () => {
    const notice = "<task-notification>\n<task-id>a1</task-id>\n<summary>Agent \"Tick 2\" finished</summary> resume the run";
    expect(hint("running", notice)).not.toMatch(/EVOR RESUME/);
  });

  it("on a paused mission, still points at evor_state_read, which main may then call", () => {
    expect(hint("paused")).toMatch(/Call evor_state_read/);
  });

  it("stays silent where there is no EVOR run", () => {
    const root = mkdtempSync(join(tmpdir(), "evor-hint-none-"));
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "resume the evor mission", session_id: "s2" }),
      encoding: "utf8",
      env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOK, "../..") },
      cwd: root,
    });
    rmSync(root, { recursive: true, force: true });
    expect(r.stdout).not.toMatch(/EVOR RESUME/);
  });
});
