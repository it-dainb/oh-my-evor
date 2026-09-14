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

  // FIXTURE COMPLETION (item 1.9d, not an assertion change).
  //
  // These cases are about the CONTINUATION guard — whether main may end its turn
  // with a tick in flight. They are not about the drift guard. The fixture used
  // to omit the tick's sub-agent artifacts and pass anyway, because the drift
  // gates keyed on `run-state.status === "running"` and this fixture's run-state
  // has no status at all, so those gates were silently inert.
  //
  // 1.9c re-homes them onto mission liveness, which this fixture DOES declare, so
  // they now evaluate and correctly object to a tick with no mutagen or selector
  // output. Supplying it keeps these cases measuring the guard they name.
  //
  // This is the SECOND suite whose fixture had drifted behind the same disarmed
  // gate — which is the argument for arming it, not against.
  const tickNo = (tickState as { tick?: number } | undefined)?.tick ?? 1;
  mkdirSync(join(runDir, "ticks", String(tickNo), "mutagen"), { recursive: true });
  mkdirSync(join(runDir, "ticks", String(tickNo), "selector"), { recursive: true });
  writeFileSync(join(runDir, "ticks", String(tickNo), "mutagen", "proposals.json"), JSON.stringify({ proposals: [] }));
  writeFileSync(join(runDir, "ticks", String(tickNo), "selector", "verdict.json"), JSON.stringify({ approved: [] }));
  const r = spawnSync("node", [join(HOOKS, "stop.mjs")], {
    input: JSON.stringify({ stop_hook_active: false, ...payload }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
  });
  rmSync(root, { recursive: true, force: true });
  return decode(r);
}

/**
 * A block is `{"decision":"block","reason":...}` on stdout with exit 0 — the JSON
 * hook protocol, not exit 2.
 *
 * These assertions used to read `code === 2`, which passed while the hook was
 * unusable in the field: Claude Code reads an exit-2 Stop hook reason from
 * STDERR, and stop.mjs wrote to stdout, so every real block reached the model as
 * "No stderr output" — blocked, with no stated reason. Asserting on the exit code
 * alone could not see that; asserting the reason is READABLE is the point.
 */
function decode(r: { status: number | null; stdout?: string }) {
  const stdout = r.stdout ?? "";
  let reason = "";
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.decision === "block") reason = String(parsed.reason ?? "");
  } catch { /* not a block */ }
  return { code: r.status, stdout, blocked: reason !== "", reason };
}

describe("main may not end its turn with a tick in flight", () => {
  it("blocks mid-tick, and says how to wait", () => {
    const r = runStop({ tick: 1, current_step: 2, step_status: "running" });
    expect(r.blocked, r.stdout).toBe(true);
    expect(r.code).toBe(0);
    expect(r.reason).toMatch(/EVOR CONTINUATION/);
    // The reason must name the recovery, since "you stopped early" alone is not
    // actionable — the observed failure was main having nothing left to await.
    expect(r.reason).toMatch(/TaskOutput|Monitor/);
  });

  it("blocks even when pending_node_ids is empty — that is the exact gap", () => {
    // The fixture writes pending_node_ids: [], so a pass here proves the new guard
    // fired rather than the old one.
    expect(runStop({ tick: 1, current_step: 5, step_status: "running" }).blocked).toBe(true);
  });

  it("allows the stop once the tick is genuinely complete", () => {
    expect(runStop({ tick: 1, current_step: 9, step_status: "done" }).blocked).toBe(false);
  });

  it("treats step 9 as complete even without step_status — no false-stop", () => {
    // Much of the existing tick-state on disk carries no step_status. Requiring it
    // would block those runs forever, which is a worse bug than the one being fixed.
    expect(runStop({ tick: 4, current_step: 9 }).blocked).toBe(false);
  });

  it("allows the stop before any tick has started", () => {
    expect(runStop({ tick: 0, current_step: 0, step_status: "pending" }).blocked).toBe(false);
  });

  it("fails open when tick-state is absent", () => {
    expect(runStop(undefined).blocked).toBe(false);
  });

  it("fails open when tick-state is corrupt", () => {
    expect(runStop("{not json" as unknown).blocked).toBe(false);
  });
});

describe("the guard is scoped to the orchestrator", () => {
  // Subagents stop constantly and legitimately; only main owns tick completion.
  for (const agent of ["oh-my-evor:evor-tick", "oh-my-evor:evor-mutagen", "general-purpose"]) {
    it(`does not block ${agent}`, () => {
      const r = runStop({ tick: 1, current_step: 2, step_status: "running" }, { agent_type: agent });
      expect(r.blocked, r.stdout).toBe(false);
      expect(r.code).toBe(0);
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
    // With the JSON protocol a block also exits 0, so the exit code alone no
    // longer proves the hook stood down. Silence does.
    expect(decode(r).blocked).toBe(false);
  });

  it("stops blocking at the hard ceiling, even with pending_node_ids", () => {
    // The livelock this fixes: pending_node_ids was treated as an invariant that
    // could never be released, so the hook blocked 497 consecutive stops in the
    // binarization-worldmodel-recall-2026-09 run. The debt is still recorded in
    // run-state.json after release — blocking forever never discharged it, it
    // only consumed the turns that might have.
    const root = mkdtempSync(join(tmpdir(), "evor-stop-ceil-"));
    const runDir = join(root, ".evor", "runs", "m1", "r1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
    writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running" }));
    writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ tick_count: 1, pending_node_ids: ["n1"] }));

    const fire = () =>
      decode(
        spawnSync("node", [join(HOOKS, "stop.mjs")], {
          input: JSON.stringify({ stop_hook_active: true, session_id: "s1" }),
          encoding: "utf8",
          env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
        }),
      );

    const HARD_CEILING = 25;
    for (let i = 1; i <= HARD_CEILING; i++) {
      const r = fire();
      expect(r.blocked, `attempt ${i} should still block`).toBe(true);
      expect(r.reason).toMatch(/EVOR CONTINUATION GUARD/);
    }
    const released = fire();
    rmSync(root, { recursive: true, force: true });
    expect(released.blocked).toBe(false);
    expect(released.code).toBe(0);
  });
});
