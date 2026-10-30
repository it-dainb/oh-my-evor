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

  it("lets main ask a person who has just typed, even on a never-halt mission", () => {
    const ask = { tool_name: "AskUserQuestion", tool_input: { questions: [] } };
    // The decide() helper writes the transcript as one user record with this content.
    expect(decide(ask, "running", "aggressive-never-halt", "Remove palmleaf_khmer; it is a leaf, not paper").permissionDecision).not.toBe("deny");
    expect(decide(ask, "running", "aggressive-never-halt", "<task-notification>tick 4 done</task-notification>").permissionDecision).toBe("deny");
  });

  it("finds the session's opening /evor-setup even after the transcript grows past any tail window", () => {
    const ask = { tool_name: "AskUserQuestion", tool_input: { questions: [] } };
    // The command opens the session; setup's tool results then add megabytes after it.
    const big = "<command-name>/oh-my-evor:evor-setup</command-name>" + "x".repeat(1_200_000);
    expect(decide(ask, "paused", "aggressive-never-halt", big).permissionDecision).not.toBe("deny");
  });
});

describe("what counts as running training code", () => {
  const bash = (command: string, agent_type?: string) =>
    ({ tool_name: "Bash", tool_input: { command }, ...(agent_type ? { agent_type } : {}) });

  it("a python -c read followed by a grep over a .py file runs nothing", () => {
    const d = decide(bash(`python3 -c "import json; print(1)"; grep -n v10 eval-suites/v1.py`, "oh-my-evor:evor-forge"));
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("a script after interpreter flags or inside a pipeline still runs training", () => {
    expect(decide(bash("python3 -u train.py", "oh-my-evor:evor-forge")).permissionDecision).toBe("deny");
    expect(decide(bash("cd x && python train.py | tee log", "oh-my-evor:evor-forge")).permissionDecision).toBe("deny");
  });

  it("main outside a live mission is not held to a sub-agent's role rules", () => {
    const d = decide(bash("python3 baseline_eval.py --weights w.pt"), "paused");
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("main during a live mission still delegates training", () => {
    expect(decide(bash("python3 baseline_eval.py --weights w.pt")).permissionDecision).toBe("deny");
  });
});

describe("the script an interpreter runs is read, not written", () => {
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
  const EV = ".evor/runs/m1/r1/eval-suites/v1.py";

  it("running the run's evaluator with its output redirected elsewhere writes only the output", () => {
    const d = decide(bash(`mkdir -p reports/s && python3 ${EV} > reports/s/b.json 2> reports/s/b.err`), "draft");
    expect(d.permissionDecision).not.toBe("deny");
  });

  it("a statement that writes the script is still a write to it", () => {
    expect(decide(bash(`echo x > ${EV}; python3 ${EV} > reports/b.json`), "draft").permissionDecision).toBe("deny");
    expect(decide(bash(`python3 ${EV} > ${EV}`), "draft").permissionDecision).toBe("deny");
  });
});

describe("sed -i edits the files after its script", () => {
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
  it("a sed script with slashes is not a path, and the file it edits is the target", () => {
    const ok = decide({ agent_type: "oh-my-evor:evor-forge", ...bash(
      `cd .evor/worktrees/c1; sed -i '72s/# a (b)/# c in data\\/builder.py/' genome.yaml`) });
    expect(ok.permissionDecision).not.toBe("deny");
    const guarded = decide(bash(`cd .evor/runs/m1/r1; sed -i 's/running/done/' mission-state.json`));
    expect(guarded.permissionDecision).toBe("deny");
  });
});

describe("a redirect writes only where it points", () => {
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
  it("diffing two worktrees into a scratch patch reads both and writes the patch", () => {
    const d = decide({ agent_type: "oh-my-evor:evor-forge", ...bash(
      "cd .evor/worktrees; diff -u a-01/train/trainer.py b-01/train/trainer.py > /tmp/p1.patch") });
    expect(d.permissionDecision).not.toBe("deny");
  });
  it("a redirect into run state is still a write to it", () => {
    expect(decide(bash("cd .evor/runs/m1/r1 && echo x > mission-state.json"), "draft").permissionDecision).toBe("deny");
  });
});
