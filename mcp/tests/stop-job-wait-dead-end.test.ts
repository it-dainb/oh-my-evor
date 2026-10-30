/**
 * mcp/tests/stop-job-wait-dead-end.test.ts
 *
 * A stop that leaves a recorded JOB wait is not a yield: no host task tracks an
 * evor_run_start job, so nothing will wake the session when it finishes. In the
 * 2026-10-30 binarization mission tick 2 yielded on job 91898813, main stopped,
 * and the mission sat parked after the job had succeeded. Artifact waits and
 * live children keep their yield semantics.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks/stop.mjs");

function stop(tickState: Record<string, unknown>, jobState?: string, liveTick = false) {
  const root = mkdtempSync(join(tmpdir(), "evor-jobwait-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ mission_id: "m1", status: "running" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ run_id: "r1", tick_count: 1, pending_node_ids: [] }));
  writeFileSync(join(runDir, "tick-state.json"), JSON.stringify(tickState));
  if (jobState) {
    mkdirSync(join(runDir, "jobs", "j1"), { recursive: true });
    writeFileSync(join(runDir, "jobs", "j1", "status.json"), JSON.stringify({ state: jobState, job_id: "j1" }));
  }
  const session = join(root, "proj", "sess");
  if (liveTick) {
    mkdirSync(join(session, "subagents"), { recursive: true });
    writeFileSync(join(session, "subagents", "agent-t.meta.json"), JSON.stringify({ agentType: "oh-my-evor:evor-tick" }));
    writeFileSync(join(session, "subagents", "agent-t.jsonl"),
      JSON.stringify({ type: "assistant", message: { stop_reason: "tool_use", content: [] } }) + "\n");
  }
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "s-jobwait", transcript_path: `${session}.jsonl` }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOK, "../..") },
    cwd: root,
  });
  rmSync(root, { recursive: true, force: true });
  const line = (r.stdout ?? "").trim().split("\n").pop() || "{}";
  try { return { ...JSON.parse(line), stderr: r.stderr }; } catch { return { stderr: r.stderr }; }
}

const mid = { tick: 2, current_step: 6, step_status: "running" };

describe("a stop on a job wait is a dead end, not a yield", () => {
  it("blocks while the job runs, and names evor_wait", () => {
    const r = stop({ ...mid, blocked: { on: "job:j1", since: "x" } }, "running");
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/evor_wait\(\{ job_id: "j1" \}\)/);
  });

  it("blocks after the job finished too, and says to finish the tick", () => {
    const r = stop({ ...mid, blocked: { on: "job:j1", since: "x" } }, "succeeded");
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/no longer running/);
    expect(r.reason).toMatch(/resume the evor-tick agent/);
  });

  it("still treats an artifact wait as a yield", () => {
    const r = stop({ ...mid, blocked: { on: "artifact:forge@tick2", since: "x" } });
    expect(r.decision).toBeUndefined();
    expect(r.stderr).toMatch(/yielding, not ending/);
  });

  it("does not act on a job wait left behind by a finished tick", () => {
    const r = stop({ tick: 2, current_step: 9, step_status: "done", blocked: { on: "job:j1", since: "x" } }, "succeeded");
    expect(r.reason ?? "").not.toMatch(/waiting on job/);
  });

  it("does not block main while the tick itself is still live and waiting", () => {
    const r = stop({ ...mid, blocked: { on: "job:j1", since: "x" } }, "running", true);
    expect(r.decision).toBeUndefined();
  });
});
