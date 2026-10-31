/**
 * mcp/tests/hook-audit-routing.test.ts
 *
 * Hook text must reach the model through a field the CLI actually delivers, and
 * must never tell main to do what the governor refuses it. Main hands tick work
 * to the tick's agent (SendMessage by id), or spawns evor-tick when the tick has
 * none; it does not spawn leads, record nodes, or run a second tick agent.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const MID = { tick: 14, current_step: 5, step_status: "running" };

type Owner = "none" | "working" | "idle";

/** A live mission at the given tick, with (optionally) an evor-tick agent a1b2c3 for tick 14. */
function fixture(tickState: Record<string, unknown>, owner: Owner, extra: (runDir: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "evor-audit-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(root, ".evor", ".deps-ok"), "cached");
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ mission_id: "m1", status: "running" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ run_id: "r1", tick_count: 13, pending_node_ids: [], tick_records: [{ tick: 13, outcome: "scored" }] }));
  writeFileSync(join(runDir, "tick-state.json"), JSON.stringify(tickState));
  extra(runDir);
  const session = join(root, "proj", "sess");
  mkdirSync(join(session, "subagents"), { recursive: true });
  if (owner !== "none") {
    const meta = join(session, "subagents", "agent-a1b2c3.meta.json");
    const tr = join(session, "subagents", "agent-a1b2c3.jsonl");
    writeFileSync(meta, JSON.stringify({ agentType: "oh-my-evor:evor-tick", description: "Tick 14", finished: owner === "idle" }));
    writeFileSync(tr, JSON.stringify({
      type: "assistant",
      message: { stop_reason: owner === "idle" ? "end_turn" : "tool_use", content: [] },
    }) + "\n");
    // An idle owner wrote nothing recently, so no hook mistakes it for a live chain.
    if (owner === "idle") {
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(tr, old, old);
    }
  }
  return { root, runDir, transcript: `${session}.jsonl` };
}

function run(name: string, root: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, name)], {
    input: JSON.stringify({ session_id: "s-audit", ...payload }),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      EVOR_ROOT: join(root, ".evor"),
      EVOR_STATE_DIR: root,
      CLAUDE_PLUGIN_ROOT: resolve(HOOKS, ".."),
      ...env,
    },
    cwd: root,
    timeout: 15_000,
  });
  let out: Record<string, any> = {};
  try { out = JSON.parse((r.stdout ?? "").trim() || "{}"); } catch { out = { unparsed: r.stdout }; }
  return { out, stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

const withFixture = <T>(f: ReturnType<typeof fixture>, fn: (f: ReturnType<typeof fixture>) => T): T => {
  try { return fn(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
};

// ── 1/2: SessionStart is the model-visible restore ───────────────────────────

describe("session-start speaks through additionalContext", () => {
  const ctx = (source: string, owner: Owner, ts = MID) =>
    withFixture(fixture(ts, owner), ({ root, transcript }) => {
      const { out } = run("session-start.mjs", root, { hook_event_name: "SessionStart", source, transcript_path: transcript });
      expect(out.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(out.env, "top-level env is dropped by the CLI").toBeUndefined();
      expect(out.message, "top-level message is dropped by the CLI").toBeUndefined();
      expect(out.watchPaths).toBeUndefined();
      return String(out.hookSpecificOutput?.additionalContext ?? "");
    });

  it("after compaction, a working tick agent is named, the heartbeat armed, and no spawn suggested", () => {
    const c = ctx("compact", "working");
    expect(c).toMatch(/<evor-restore>/);
    expect(c).toMatch(/Tick 14 is run by agent a1b2c3/);
    expect(c).toMatch(/evor_wait\(\{ heartbeat: true \}\)/);
    expect(c).not.toMatch(/spawn oh-my-evor:evor-tick|Spawn evor-tick/);
  });

  it("on resume, an idle tick agent is resumed by SendMessage, not respawned", () => {
    const c = ctx("resume", "idle");
    expect(c).toMatch(/SendMessage\(\{ to: "a1b2c3"/);
    expect(c).not.toMatch(/spawn oh-my-evor:evor-tick/);
  });

  it("with no tick agent, the unfinished tick is spawned through evor-tick", () => {
    expect(ctx("compact", "none")).toMatch(/Tick 14 is unfinished: spawn oh-my-evor:evor-tick/);
  });

  it("startup orientation never says spawn while the tick has its agent", () => {
    const c = ctx("startup", "idle");
    expect(c).toMatch(/EVOR LAW/);
    expect(c).toMatch(/SendMessage\(\{ to: "a1b2c3"/);
    expect(c).not.toMatch(/spawn oh-my-evor:evor-tick for it/);
  });

  it("a sub-agent's session start gets no mission orientation", () => {
    withFixture(fixture(MID, "idle"), ({ root, transcript }) => {
      const { out } = run("session-start.mjs", root, { source: "compact", transcript_path: transcript, agent_type: "oh-my-evor:evor-forge" });
      expect(out.hookSpecificOutput?.additionalContext ?? "").not.toMatch(/evor-restore|\[NEXT\]/);
    });
  });

  it("post-compact stays user-only, so the restore reaches the model once", () => {
    withFixture(fixture(MID, "idle"), ({ root, transcript }) => {
      const { out } = run("post-compact.mjs", root, { transcript_path: transcript, trigger: "auto" });
      expect(out.hookSpecificOutput).toBeUndefined();
      expect(String(out.systemMessage ?? "")).toMatch(/a1b2c3/);
    });
  });
});

// ── 3/4: the stop guards hand tick debt to the tick ──────────────────────────

describe("stop routes main's tick debt to the tick agent", () => {
  const stop = (ts: Record<string, unknown>, owner: Owner, extra?: (d: string) => void, payload: Record<string, unknown> = {}) =>
    withFixture(fixture(ts, owner, extra), ({ root, transcript }) =>
      run("stop.mjs", root, { hook_event_name: "Stop", transcript_path: transcript, ...payload }));

  it("an unfinished tick with an idle agent: SendMessage it, never a second evor-tick", () => {
    const { out } = stop(MID, "idle");
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/resume the tick agent a1b2c3 with SendMessage\(\{ to: "a1b2c3"/i);
    expect(out.reason).toMatch(/evor_wait\(\{ heartbeat: true \}\)/);
    expect(out.reason).not.toMatch(/TaskOutput|Monitor|spawn Task\(subagent_type="oh-my-evor:evor-tick"\)/i);
    expect(out.reason).not.toMatch(/EVOR_SKIP_HOOKS/);
  });

  it("an unfinished tick with no agent: spawn evor-tick for that tick", () => {
    const { out } = stop(MID, "none");
    expect(out.reason).toMatch(/Spawn Task\(subagent_type="oh-my-evor:evor-tick"\) for tick 14/);
  });

  it("pending nodes: main hands them to the tick; the tick itself is told to record them", () => {
    const pending = (d: string) =>
      writeFileSync(join(d, "run-state.json"), JSON.stringify({ run_id: "r1", tick_count: 14, pending_node_ids: ["n-1"], tick_records: [{ tick: 14, outcome: "scored" }] }));
    const main = stop({ tick: 14, current_step: 9, step_status: "done" }, "idle", pending).out;
    expect(main.reason).toMatch(/Resume the tick agent a1b2c3/);
    const sub = stop({ tick: 14, current_step: 9, step_status: "done" }, "idle", pending, { agent_type: "oh-my-evor:evor-tick", agent_id: "a1b2c3" }).out;
    expect(sub.reason).toMatch(/Call evor_record_node for:/);
  });

  it("a finished tick missing roster output asks the tick, not main, to run the roster", () => {
    const { out } = stop({ tick: 14, current_step: 9, step_status: "done" }, "idle", (d) =>
      writeFileSync(join(d, "run-state.json"), JSON.stringify({
        run_id: "r1", tick_count: 14, pending_node_ids: [], tick_records: [{ tick: 14, outcome: "scored" }],
      })));
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/evor-mutagen output not found/);
    expect(out.reason).toMatch(/The tick owes these, not you: resume the tick agent a1b2c3/);
    expect(out.reason).not.toMatch(/Spawn evor-mutagen|Spawn evor-selector/);
  });

  it("the block is bounded: the ceiling releases a repeated drift-only stop", () => {
    const f = fixture({ tick: 14, current_step: 9, step_status: "done" }, "idle", (d) =>
      writeFileSync(join(d, "stop-blocks-s-audit.json"), JSON.stringify({ count: 8 })));
    withFixture(f, ({ root, transcript }) => {
      const { out, status } = run("stop.mjs", root, { transcript_path: transcript });
      expect(status).toBe(0);
      expect(out.decision).toBeUndefined();
    });
  });
});

// ── 5: governor denials point main at the tick ───────────────────────────────

describe("governor denials tell main to use the tick agent", () => {
  const deny = (owner: Owner, payload: Record<string, unknown>) =>
    withFixture(fixture(MID, owner), ({ root, transcript }) =>
      String(run("pre-tool-use.mjs", root, { transcript_path: transcript, ...payload }).out.hookSpecificOutput?.permissionDecisionReason ?? ""));

  it("main's Bash names the tick agent", () => {
    const r = deny("idle", { tool_name: "Bash", tool_input: { command: "ls -la" } });
    expect(r).toMatch(/Resume the tick agent a1b2c3/);
    expect(r).not.toMatch(/evor-probe|evor-forge|evor-sage/);
  });

  it("main's training command names the tick agent, not Forge", () => {
    const r = deny("idle", { tool_name: "Bash", tool_input: { command: "python train.py --epochs 3" } });
    expect(r).toMatch(/a1b2c3/);
    expect(r).not.toMatch(/Spawn\s+Task\(subagent_type="oh-my-evor:evor-forge"/);
  });

  it("main spawning a lead is told to resume the tick agent", () => {
    const r = deny("idle", { tool_name: "Agent", tool_input: { subagent_type: "oh-my-evor:evor-forge", prompt: "x" } });
    expect(r).toMatch(/Resume the tick agent a1b2c3/);
  });

  it("main spawning forge-junior is pointed at the tick, not at evor-forge", () => {
    const r = deny("idle", { tool_name: "Agent", tool_input: { subagent_type: "oh-my-evor:evor-forge-junior", prompt: "x" } });
    expect(r).toMatch(/Resume the tick agent a1b2c3/);
    expect(r).not.toMatch(/delegate the work to evor-forge/);
  });

  it("with no tick agent, main is told to spawn evor-tick", () => {
    const r = deny("none", { tool_name: "mcp__plugin_oh-my-evor_evor__evor_state_read", tool_input: {} });
    expect(r).toMatch(/Spawn Task\(subagent_type="oh-my-evor:evor-tick"\) for tick 14/);
  });

  it("a sub-agent caller keeps its own advice", () => {
    const r = deny("idle", { tool_name: "Agent", agent_type: "oh-my-evor:evor-tick", tool_input: { subagent_type: "oh-my-evor:evor-forge-junior", prompt: "x" } });
    expect(r).toMatch(/delegate the work to evor-forge/);
    expect(r).not.toMatch(/a1b2c3/);
  });
});

// ── 6/7/8: the job wait rule, and no dead hook registrations ─────────────────

describe("one waiting rule, and only live hook registrations", () => {
  const hooksJson = JSON.parse(readFileSync(join(HOOKS, "hooks.json"), "utf8"));

  it("registers no FileChanged watcher and no PostToolBatch gate", () => {
    expect(hooksJson.hooks.FileChanged).toBeUndefined();
    expect(hooksJson.hooks.PostToolBatch).toBeUndefined();
  });

  it("every registered command points at a script that exists", () => {
    for (const groups of Object.values(hooksJson.hooks) as any[]) {
      for (const g of groups) {
        for (const h of g.hooks) {
          const m = String(h.command).match(/hooks\/([\w-]+\.mjs)/);
          expect(m && existsSync(join(HOOKS, m[1])), h.command).toBeTruthy();
        }
      }
    }
  });

  it("Forge is told to wait with one background Bash task, never a Monitor", () => {
    withFixture(fixture(MID, "none"), ({ root }) => {
      const { out } = run("subagent-start.mjs", root, { agent_type: "oh-my-evor:evor-forge" });
      const c = String(out.hookSpecificOutput?.additionalContext ?? "");
      expect(c).toMatch(/ONE background Bash task/);
      expect(c).not.toMatch(/Watch the launched run with the native Monitor/);
    });
  });
});

// ── 9: PermissionDenied ──────────────────────────────────────────────────────

describe("permission-denied output shape", () => {
  it("puts systemMessage at the top level, with nothing the CLI drops", () => {
    withFixture(fixture(MID, "none"), ({ root }) => {
      const { out } = run("permission-denied.mjs", root, { tool_name: "Bash", reason: "classifier" });
      expect(String(out.systemMessage)).toMatch(/EVOR BLOCKED/);
      expect(out.hookSpecificOutput).toBeUndefined();
    });
  });
});

// ── 10: UserPromptSubmit ─────────────────────────────────────────────────────

describe("user-prompt-submit", () => {
  const ups = (owner: Owner, prompt: string) =>
    withFixture(fixture(MID, owner), ({ root, transcript }) =>
      String(run("user-prompt-submit.mjs", root, { prompt, transcript_path: transcript }).out.hookSpecificOutput?.additionalContext ?? ""));

  it("ignores a task notification that is not at the start", () => {
    expect(ups("idle", "note\n<task-notification><status>completed</status></task-notification>")).toBe("");
  });

  it("ignores a system-reminder-wrapped notice", () => {
    expect(ups("idle", "<system-reminder>Agent finished; resume the evor run</system-reminder>")).toBe("");
  });

  it("a live resume names the working tick agent and arms the heartbeat before ending the turn", () => {
    const c = ups("working", "resume the evor run");
    expect(c).toMatch(/a1b2c3/);
    expect(c).toMatch(/evor_wait\(\{ heartbeat: true \}\)/);
    expect(c).not.toMatch(/spawn oh-my-evor:evor-tick/);
  });
});

// ── 11/13: PostToolUse ───────────────────────────────────────────────────────

describe("post-tool-use", () => {
  const ptu = (payload: Record<string, unknown>) =>
    withFixture(fixture(MID, "none"), ({ root }) => run("post-tool-use.mjs", root, payload));

  it("asks for one Forge per selected proposal, not one winner", () => {
    const { out } = ptu({
      tool_name: "mcp__plugin_oh-my-evor_evor__evor_select",
      tool_input: {}, tool_response: { selected_names: ["h001", "h003"] },
    });
    const c = String(out.hookSpecificOutput?.additionalContext ?? "");
    expect(c).toMatch(/one Forge per selected proposal/);
    expect(c).not.toMatch(/winning proposal/);
  });

  it("delivers warnings and the reflex nudge as one additionalContext object", () => {
    const { out, stdout } = ptu({
      tool_name: "mcp__plugin_oh-my-evor_evor__evor_record_eval",
      tool_input: { node_id: "missing-node" }, tool_response: { ok: true },
    });
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const c = String(out.hookSpecificOutput?.additionalContext ?? "");
    expect(c).toMatch(/\[EVOR WARNING\] results\.json missing/);
    expect(c).toMatch(/\[EVOR REFLEX\] Eval recorded/);
  });
});

// ── 12: SubagentStop return cap ──────────────────────────────────────────────

describe("subagent-stop return cap applies to evor agents only", () => {
  const stopSub = (agentType: string) =>
    withFixture(fixture(MID, "none"), ({ root }) =>
      run("subagent-stop.mjs", root, { agent_type: agentType, agent_id: `id-${agentType}`, last_assistant_message: "x".repeat(5000) }).out);

  it("does not block a non-evor agent's long return", () => {
    expect(stopSub("oh-my-claudecode:architect").decision).toBeUndefined();
    expect(stopSub("general-purpose").decision).toBeUndefined();
  });

  it("still bounds an evor agent's return", () => {
    expect(stopSub("oh-my-evor:evor-sage").decision).toBe("block");
  });
});

// ── 13: SessionEnd writes only a real status ─────────────────────────────────

describe("session-end", () => {
  const end = (missionState: Record<string, unknown> | null) =>
    withFixture(fixture(MID, "none", (d) => {
      if (missionState === null) rmSync(join(d, "mission-state.json"));
      else writeFileSync(join(d, "mission-state.json"), JSON.stringify(missionState));
    }), ({ root, runDir }) => {
      run("session-end.mjs", root, { reason: "other" });
      const p = join(runDir, "mission-state.json");
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    });

  it("does not invent a mission state when there is none", () => {
    expect(end(null)).toBeNull();
  });

  it("does not pause a draft or status-less mission", () => {
    expect(end({ status: "draft" }).status).toBe("draft");
    expect(end({ name: "m" }).status).toBeUndefined();
  });

  it("pauses a running mission from its real status", () => {
    const after = end({ status: "running" });
    expect(after.status).toBe("paused");
    expect(after.paused_from).toBe("running");
  });
});

// ── Selector reads Probe (seed budget) ───────────────────────────────────────

describe("artifact read grants", () => {
  const read = (agent: string) =>
    withFixture(fixture(MID, "none"), ({ root }) =>
      run("pre-tool-use.mjs", root, {
        tool_name: "mcp__plugin_oh-my-evor_evor__evor_read_artifact",
        agent_type: "oh-my-evor:evor-selector",
        tool_input: { run_id: "r1", tick: 14, agent },
      }).out.hookSpecificOutput ?? {});

  it("lets Selector read the previous tick's Probe verdict", () => {
    expect(read("probe").permissionDecision).not.toBe("deny");
  });

  it("still denies Selector a reviewer slot, and names the slots it can read", () => {
    const d = read("forge-critic");
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/Your role reads: selector, sage, mutagen, probe\./);
  });
});
