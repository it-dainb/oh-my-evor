/**
 * mcp/tests/stop-yield-not-end.test.ts
 *
 * A stop with live children is a YIELD, not an end. Claude Code re-activates an
 * agent when a background agent it spawned reports back — the CLI shows
 * "Waiting for N background agents to finish" — so the session was never going
 * to end and the block only costs a turn of context.
 *
 * Two field failures were this same mistake:
 *   - 497 blocked stops against a pending node the orchestrator could not record.
 *   - The drift guard demanding tick 1's Mutagen artifact 16 SECONDS into tick 1,
 *     from the orchestrator — which is forbidden to produce it, the tick boundary
 *     owns that spawn. It could not comply without committing the exact violation
 *     the guard detects, so the operator disabled the hook with
 *     EVOR_SKIP_HOOKS=stop, disarming every legitimate guard too.
 *
 * The guards are for state DEBT the agent can discharge now, never for the
 * absence of an artifact somebody else still owes.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");

/** One assistant record that ended its turn — how a FINISHED agent's log ends. */
const FINISHED = JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn" } });
/** A tool result the agent has yet to act on — how a LIVE agent's log ends. */
const LIVE = JSON.stringify({ type: "user", message: { role: "user" } });

interface Opts {
  tickState?: Record<string, unknown> | null;
  /** agent transcripts to plant under the session's subagents/ dir */
  subagents?: string[];
  pendingNodeIds?: string[];
}

function runStop({ tickState, subagents = [], pendingNodeIds = [] }: Opts) {
  const root = mkdtempSync(join(tmpdir(), "evor-yield-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ tick_count: 1, pending_node_ids: pendingNodeIds }));
  if (tickState) writeFileSync(join(runDir, "tick-state.json"), JSON.stringify(tickState));

  // The hook locates subagents as a sibling of the transcript the payload names.
  const transcript = join(root, "session.jsonl");
  writeFileSync(transcript, "");
  const subDir = join(root, "session", "subagents");
  mkdirSync(subDir, { recursive: true });
  subagents.forEach((tail, i) => {
    const f = join(subDir, `agent-a${i}.jsonl`);
    writeFileSync(f, tail + "\n");
    writeFileSync(join(subDir, `agent-a${i}.meta.json`), JSON.stringify({ agentType: "oh-my-evor:evor-sage-junior" }));
    // A just-written transcript is "recently active" by design — the hook treats
    // the gap between a child finishing and its parent waking as still-live.
    // A chain that is genuinely over has to have gone quiet, so age it past the
    // window; otherwise these cases would assert against the recency rule
    // rather than against the finished/live distinction they are about.
    if (tail === FINISHED) {
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(f, old, old);
    }
  });

  const r = spawnSync("node", [join(HOOKS, "stop.mjs")], {
    input: JSON.stringify({ stop_hook_active: true, session_id: "s-none", transcript_path: transcript }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
  });
  rmSync(root, { recursive: true, force: true });

  const stdout = (r.stdout ?? "").trim();
  let reason = "";
  try {
    const p = JSON.parse(stdout);
    if (p?.decision === "block") reason = String(p.reason ?? "");
  } catch { /* not a block */ }
  return { code: r.status, blocked: reason !== "", reason, stderr: r.stderr ?? "" };
}

const MID_TICK = { tick: 1, current_step: 2, step_status: "running" };

describe("a yield is allowed", () => {
  it("allows the stop when the tick recorded what it is blocked on", () => {
    // Verbatim shape from the field run: evor_await_artifact wrote this and the
    // tick parked exactly as the skill instructs.
    const r = runStop({
      tickState: { ...MID_TICK, blocked: { on: "artifact:sage@tick1", since: "2026-09-14T07:15:07Z" } },
      pendingNodeIds: ["n1"],
    });
    expect(r.blocked, r.reason).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/yielding, not ending/);
    expect(r.stderr).toMatch(/artifact:sage@tick1/);
  });

  it("allows the stop when spawned agents are still live", () => {
    // evor-sage fanning out to five juniors records no wait of its own; the CLI
    // still says "Waiting for 5 background agents to finish".
    const r = runStop({ tickState: MID_TICK, subagents: [LIVE, LIVE, LIVE, LIVE, LIVE] });
    expect(r.blocked, r.reason).toBe(false);
    expect(r.stderr).toMatch(/5 live sub-agent/);
  });

  it("yields even with pending_node_ids — the strongest guard must not outrank it", () => {
    const r = runStop({ tickState: MID_TICK, subagents: [LIVE], pendingNodeIds: ["n1", "n2"] });
    expect(r.blocked, r.reason).toBe(false);
  });

  it("does not consume a block attempt", () => {
    // The counter runs after the yield gate; a yield that burned attempts would
    // exhaust the ceiling during a long, healthy tick.
    const r = runStop({ tickState: MID_TICK, subagents: [LIVE] });
    expect(r.reason).not.toMatch(/Attempt/);
  });
});

describe("a real abandonment is still caught", () => {
  it("blocks a mid-flight tick with nothing live and no recorded wait", () => {
    const r = runStop({ tickState: MID_TICK, subagents: [FINISHED] });
    expect(r.blocked, `stderr: ${r.stderr}`).toBe(true);
    expect(r.reason).toMatch(/EVOR CONTINUATION/);
  });

  it("blocks on pending_node_ids once the chain has gone quiet", () => {
    const r = runStop({
      tickState: { tick: 1, current_step: 9, step_status: "done" },
      subagents: [FINISHED],
      pendingNodeIds: ["n1"],
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/CONTINUATION GUARD/);
  });
});

describe("the drift guard no longer races the tick boundary", () => {
  it("does not demand a roster artifact from a tick still in flight", () => {
    // 16 seconds into tick 1 the Mutagen artifact is legitimately absent —
    // the boundary that owns that spawn has not reached it yet.
    const r = runStop({ tickState: MID_TICK, subagents: [FINISHED] });
    expect(r.reason).not.toMatch(/evor-mutagen output not found/);
  });

  it("still demands it once the tick claims to be finished", () => {
    const r = runStop({
      tickState: { tick: 1, current_step: 9, step_status: "done" },
      subagents: [FINISHED],
    });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/evor-mutagen output not found/);
  });
});
