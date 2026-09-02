/**
 * §0.7 — the `paused → prior` recovery edge.
 *
 * session-end writes `status: "paused"` when a session ends with an active run.
 * Until this edge existed nothing wrote it back, and `stop.mjs` exits 0 on
 * `paused` — so one session ending disabled the drift guard for the rest of the
 * mission's life. The mission stayed technically alive and completely
 * ungoverned. That transition was performed in this repo and never reversed.
 *
 * Plan item 3.1 requires the FSM it builds to contain this edge and to assert it,
 * "or the Phase 0 fix is silently dropped when Phase 3 rebuilds the machine".
 * This file is that assertion. When 3.1 lands, it should keep passing against the
 * transition table rather than being replaced.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir, homedir } from "os";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");

/** Run a hook against a scratch .evor with the given mission-state, return the state after. */
function cycle(hook: string, missionState: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "evor-pause-edge-"));
  try {
    const evorRoot = join(dir, ".evor");
    const runDir = join(evorRoot, "runs", "m1", "r1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(evorRoot, "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
    writeFileSync(join(runDir, "mission-state.json"), JSON.stringify(missionState, null, 2));
    const r = spawnSync(process.execPath, [join(HOOKS_DIR, hook)], {
      input: JSON.stringify({ session_id: "s1", hook_event_name: hook }),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: homedir(),
        EVOR_ROOT: evorRoot,
        EVOR_ACTIVE_RUN_ID: "r1",
        EVOR_MISSION_ID: "m1",
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    const after = JSON.parse(readFileSync(join(runDir, "mission-state.json"), "utf8"));
    return { after, status: r.status, stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("§0.7 — pausing a mission must be reversible", () => {
  it("session-end records what it paused FROM, so the edge can be walked back", () => {
    const { after } = cycle("session-end.mjs", { status: "locked", name: "m" });
    expect(after.status).toBe("paused");
    expect(
      after.paused_from,
      "without an origin, session-start cannot know whether to restore `locked` or " +
        "`running`, and the transition is one-way by construction",
    ).toBe("locked");
    expect(after.paused_by).toBe("session-end-hook");
  });

  it("session-start walks it back — locked → paused → locked", () => {
    const paused = cycle("session-end.mjs", { status: "locked", name: "m" }).after;
    const { after } = cycle("session-start.mjs", paused);
    expect(
      after.status,
      "`stop.mjs` exits 0 on `paused`. A mission that can never leave `paused` has " +
        "no drift guard for the rest of its life.",
    ).toBe("locked");
    expect(after.resumed_by).toBe("session-start-hook");
    expect(after.paused_from, "the origin is consumed, not left to go stale").toBeUndefined();
  });

  it("running → paused → running", () => {
    const paused = cycle("session-end.mjs", { status: "running", name: "m" }).after;
    expect(cycle("session-start.mjs", paused).after.status).toBe("running");
  });

  it("an operator pause is a decision and is NOT auto-resumed", () => {
    const { after } = cycle("session-start.mjs", {
      status: "paused",
      paused_from: "running",
      paused_by: "operator",
    });
    expect(
      after.status,
      "only a pause this hook pair wrote may be reversed by it; a human who paused " +
        "a mission deliberately must not have that undone on the next session",
    ).toBe("paused");
  });

  it("a terminal status is never resumed", () => {
    for (const status of ["completed", "failed"]) {
      expect(cycle("session-start.mjs", { status, paused_by: "session-end-hook" }).after.status).toBe(status);
    }
  });

  it("a pause with no recorded origin is left alone rather than guessed at", () => {
    const { after } = cycle("session-start.mjs", { status: "paused", paused_by: "session-end-hook" });
    expect(after.status).toBe("paused");
  });
});
