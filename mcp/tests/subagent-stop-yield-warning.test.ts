/**
 * mcp/tests/subagent-stop-yield-warning.test.ts
 *
 * A sub-agent that ends its turn while its own children run has yielded, not
 * finished: Sage fans out to its juniors and writes its artifact after they
 * report. The missing-artifact warning is for an agent that finished without one.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const FINISHED = JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn" } });
const RUNNING = JSON.stringify({ type: "user", message: { role: "user" } });

function stopSage(child: string | null, extra = "") {
  const root = mkdtempSync(join(tmpdir(), "evor-sagestop-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(join(runDir, "ticks", "1"), { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ tick_count: 0, pending_node_ids: [] }));
  writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick: 1, current_step: 2, step_status: "running" }));

  const subDir = join(root, "session", "subagents");
  mkdirSync(subDir, { recursive: true });
  const sage = join(subDir, "agent-asage.jsonl");
  const launch = child === null ? "" :
    JSON.stringify({ type: "user", toolUseResult: { isAsync: true, status: "async_launched", agentId: "ajun1" } }) + "\n";
  writeFileSync(sage, launch + extra + FINISHED + "\n");
  if (child !== null) {
    const f = join(subDir, "agent-ajun1.jsonl");
    writeFileSync(f, child + "\n");
    if (child === FINISHED) { const old = new Date(Date.now() - 10 * 60_000); utimesSync(f, old, old); }
  }
  writeFileSync(join(root, "session.jsonl"), "");

  const r = spawnSync("node", [join(HOOKS, "subagent-stop.mjs")], {
    input: JSON.stringify({
      hook_event_name: "SubagentStop",
      agent_type: "oh-my-evor:evor-sage",
      agent_id: `asage-${root.slice(-6)}`,
      stop_hook_active: false,
      session_id: "s1",
      transcript_path: join(root, "session.jsonl"),
      agent_transcript_path: sage,
    }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, ".."), EVOR_STATE_DIR: root },
  });
  rmSync(root, { recursive: true, force: true });
  return (r.stdout ?? "").trim();
}

describe("Sage stopping while its juniors run", () => {
  it("is a yield: no missing-artifact warning", () => {
    expect(stopSage(RUNNING)).not.toMatch(/artifact not confirmed/);
  });

  it("waiting on its own background task (a job watcher) is a yield too", () => {
    const task = JSON.stringify({ type: "user", toolUseResult: { backgroundTaskId: "bjob1" } }) + "\n";
    expect(stopSage(null, task)).not.toMatch(/artifact not confirmed/);
    const done = task + JSON.stringify({ type: "user", message: { content: "<task-notification>\n<task-id>bjob1</task-id>" } }) + "\n";
    expect(stopSage(null, done)).toMatch(/artifact not confirmed/);
  });

  it("finishing with no live child and no artifact still warns", () => {
    expect(stopSage(FINISHED)).toMatch(/artifact not confirmed/);
    expect(stopSage(null)).toMatch(/artifact not confirmed/);
  });
});
