/**
 * mcp/tests/stop-incomplete-tick.test.ts
 *
 * The orchestrator's dominant failure is stopping too EARLY, not doing too much.
 *
 * Observed twice, identically: main spawns evor-tick; the tick reports failure;
 * main resumes it in the BACKGROUND via SendMessage; main then ends its turn —
 * which ends the whole `-p` session. Result: 10 turns, 0 tree nodes, a run that
 * reads as cheap ($1.36) because it did almost nothing.
 *
 * The pre-existing continuation guard cannot catch this: it keys on
 * `pending_node_ids`, and a tick that dies before recording a node leaves that
 * list empty.
 *
 * Prose cannot fix it either. Main was told "spawn evor-tick, record the outcome,
 * decide continue/stop" and did exactly that — no sentence in it says the waiting
 * is main's job. That primer wording caused this stall once already, was rewritten,
 * and reintroduced the same stall. Hence: enforce the invariant, don't describe it.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");

function runStop(tickState: unknown, payload: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "evor-stop-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ run_id: "r1", tick: 1, pending_node_ids: [] }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running", tick: 1 }));
  if (tickState !== undefined) writeFileSync(join(runDir, "tick-state.json"), JSON.stringify(tickState));
  const r = spawnSync("node", [join(HOOKS, "stop.mjs")], {
    input: JSON.stringify({ stop_hook_active: false, ...payload }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
  });
  rmSync(root, { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout ?? "" };
}

/** exit 2 is how a Stop hook blocks; 0 lets the turn end. */
const BLOCKED = 2;

describe("main may not end its turn with a tick in flight", () => {
  it("blocks mid-tick, and says how to wait", () => {
    const r = runStop({ tick: 1, current_step: 2, step_status: "running" });
    expect(r.code).toBe(BLOCKED);
    expect(r.stdout).toMatch(/EVOR CONTINUATION/);
    // The reason must name the recovery, since "you stopped early" alone is not
    // actionable — the observed failure was main having nothing left to await.
    expect(r.stdout).toMatch(/TaskOutput|Monitor/);
  });

  it("blocks even when pending_node_ids is empty — that is the exact gap", () => {
    // The fixture writes pending_node_ids: [], so a pass here proves the new guard
    // fired rather than the old one.
    expect(runStop({ tick: 1, current_step: 5, step_status: "running" }).code).toBe(BLOCKED);
  });

  it("allows the stop once the tick is genuinely complete", () => {
    expect(runStop({ tick: 1, current_step: 9, step_status: "done" }).code).toBe(0);
  });

  it("treats step 9 as complete even without step_status — no false-stop", () => {
    // Much of the existing tick-state on disk carries no step_status. Requiring it
    // would block those runs forever, which is a worse bug than the one being fixed.
    expect(runStop({ tick: 4, current_step: 9 }).code).toBe(0);
  });

  it("allows the stop before any tick has started", () => {
    expect(runStop({ tick: 0, current_step: 0, step_status: "pending" }).code).toBe(0);
  });

  it("fails open when tick-state is absent", () => {
    expect(runStop(undefined).code).toBe(0);
  });

  it("fails open when tick-state is corrupt", () => {
    expect(runStop("{not json" as unknown).code).toBe(0);
  });
});

describe("the guard is scoped to the orchestrator", () => {
  // Subagents stop constantly and legitimately; only main owns tick completion.
  for (const agent of ["oh-my-evor:evor-tick", "oh-my-evor:evor-mutagen", "general-purpose"]) {
    it(`does not block ${agent}`, () => {
      const r = runStop({ tick: 1, current_step: 2, step_status: "running" }, { agent_type: agent });
      expect(r.code, r.stdout).toBe(0);
    });
  }
});

describe("the guard is escapable", () => {
  it("honours EVOR_SKIP_HOOKS, so a wedged run can always be exited", () => {
    const root = mkdtempSync(join(tmpdir(), "evor-stop-esc-"));
    const runDir = join(root, ".evor", "runs", "m1", "r1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
    writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick: 1, current_step: 2, step_status: "running" }));
    const r = spawnSync("node", [join(HOOKS, "stop.mjs")], {
      input: JSON.stringify({ stop_hook_active: false }),
      encoding: "utf8",
      env: {
        ...process.env,
        EVOR_ROOT: join(root, ".evor"),
        CLAUDE_PLUGIN_ROOT: resolve(HOOKS, ".."),
        EVOR_SKIP_HOOKS: "stop",
      },
    });
    rmSync(root, { recursive: true, force: true });
    expect(r.status).toBe(0);
  });
});
