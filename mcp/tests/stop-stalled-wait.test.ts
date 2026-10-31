/**
 * mcp/tests/stop-stalled-wait.test.ts
 *
 * A sub-agent that ends its turn is marked finished by the CLI and is not woken
 * again on its own; a child's completion then goes to main. A wait recorded on
 * that agent's artifact, with nothing running, is a stall: main must resume the
 * tick, not park on it.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const END = JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn" } });
const HOOK_ATTACHMENT = JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookEvent: "SubagentStop" } });

function stopMain(agent: { finishedFlag: boolean; tail: string[] }) {
  const root = mkdtempSync(join(tmpdir(), "evor-stall-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ tick_count: 0, pending_node_ids: [] }));
  writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({
    tick: 1, current_step: 5, step_status: "running", blocked: { on: "artifact:forge/c1@tick1", since: "x" },
  }));
  const transcript = join(root, "session.jsonl");
  writeFileSync(transcript, "");
  const sub = join(root, "session", "subagents");
  mkdirSync(sub, { recursive: true });
  const f = join(sub, "agent-aforge.jsonl");
  writeFileSync(f, agent.tail.join("\n") + "\n");
  writeFileSync(join(sub, "agent-aforge.meta.json"), JSON.stringify({ agentType: "oh-my-evor:evor-forge", finished: agent.finishedFlag }));
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(f, old, old);

  const r = spawnSync("node", [join(HOOKS, "stop.mjs")], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcript, stop_hook_active: false }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, ".."), EVOR_STATE_DIR: root },
    cwd: root,
  });
  rmSync(root, { recursive: true, force: true });
  let reason = "";
  try { const p = JSON.parse((r.stdout ?? "").trim()); if (p?.decision === "block") reason = String(p.reason ?? ""); } catch { /* no block */ }
  return { reason, stderr: r.stderr ?? "" };
}

describe("main stopping on a wait nothing will deliver", () => {
  it("an agent the CLI marked finished is not live, even with a hook attachment after its last message", () => {
    const r = stopMain({ finishedFlag: true, tail: [END, HOOK_ATTACHMENT] });
    expect(r.stderr).not.toMatch(/yielding, not ending/);
    expect(r.reason).toMatch(/no agent is running/);
    // The finished agent is Forge, the tick's child; no tick agent exists, so
    // main hands the wait to a new evor-tick for the tick.
    expect(r.reason).toMatch(/spawn Task\(subagent_type="oh-my-evor:evor-tick"\) for tick 1/i);
  });

  it("without the flag, the last message still decides, not the trailing attachment", () => {
    const r = stopMain({ finishedFlag: false, tail: [END, HOOK_ATTACHMENT] });
    expect(r.reason).toMatch(/no agent is running/);
  });
});
