/**
 * mcp/tests/hook-primer-consistency.test.ts — C5 Stage 7.1
 *
 * Two hooks injected the same three facts in different words:
 *   subagent-start.mjs COMMON_HEADER  (fires on every evor subagent spawn)
 *   session-start.mjs  LAW_PRIMER     (fires once per session, into MAIN)
 *
 * Duplication alone would be rubric rule 4. The real defect is that they had
 * DRIFTED — COMMON_HEADER's hot-path list names evor_tree_read and the signal
 * tools; LAW_PRIMER's names evor_run_start. An agent's guidance depended on which
 * hook happened to fire.
 *
 * And since §3b.0, LAW_PRIMER is actively wrong: it is injected into main, and it
 * recommends evor_state_read — which the governor now DENIES to main. A primer
 * that points the orchestrator at forbidden tools costs a denial round-trip on
 * every session, and teaches exactly the behaviour the boundary exists to stop.
 *
 * The two audiences differ, so the fix is not one shared string: main orchestrates
 * and must not read per-tick detail; subagents do the reading. They need different
 * primers — the bug was that both pretended to be the same advice.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");
const sessionStart = readFileSync(join(HOOKS, "session-start.mjs"), "utf8");
const subagentStart = readFileSync(join(HOOKS, "subagent-start.mjs"), "utf8");

/**
 * Everything main is actually told at session start.
 *
 * This used to extract the LAW_PRIMER string literal and assert on it. That test
 * was green while three OTHER concatenations into the same `output.message` — the
 * `[EVOR CONTEXT]` header, the `<evor-restore>` block, and the `[NEXT]` hint —
 * each still told main to call evor_state_read. A fix landed in one string, a test
 * locked that string down, and the adjacent code paths emitting the same forbidden
 * guidance to the same audience were uncovered.
 *
 * So: run the hook and read what it emits. The message is the contract, not any
 * one literal inside it.
 */
function sessionStartMessage(tick = 2, step = 4): string {
  const root = mkdtempSync(join(tmpdir(), "evor-primer-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick, current_step: step, step_status: "running" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ tick_count: tick }));
  const r = spawnSync("node", [join(HOOKS, "session-start.mjs")], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1" }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
  });
  rmSync(root, { recursive: true, force: true });
  return JSON.parse(r.stdout || "{}").message ?? "";
}

describe("session-start tells main nothing the governor will deny", () => {
  // §3b.0 denies these to main. Recommending them costs a denial round-trip on
  // every session and trains the exact behaviour the boundary exists to remove.
  const DENIED_TO_MAIN = ["evor_state_read", "evor_tree_read", "evor_read_artifact"];

  // Cover both branches of the step logic — mid-tick and tick-boundary — since
  // the [NEXT] hint differs between them.
  for (const [tick, step] of [[2, 4], [2, 9], [0, 0]] as const) {
    for (const tool of DENIED_TO_MAIN) {
      it(`tick ${tick} step ${step}: does not recommend ${tool}`, () => {
        expect(
          sessionStartMessage(tick, step),
          `session-start tells main to use ${tool}, which the governor denies it`,
        ).not.toMatch(new RegExp(tool));
      });
    }
  }

  it("is non-vacuous — the hook really did emit main's primer", () => {
    const msg = sessionStartMessage();
    expect(msg, "no message emitted; the assertions above would pass on empty string").toMatch(/EVOR LAW/);
    expect(msg).toMatch(/\[NEXT\]/);
  });

  it("points main at the boundary instead", () => {
    expect(sessionStartMessage()).toMatch(/evor-tick/);
  });
});

describe("the two primers do not silently disagree", () => {
  it("subagent-start remains the fuller, subagent-facing protocol", () => {
    // Subagents DO read artifacts — that guidance is correct for them and must
    // survive. This test exists so a future dedup does not delete the wrong copy.
    expect(subagentStart).toMatch(/READ-FIRST/);
    expect(subagentStart).toMatch(/evor_read_artifact/);
  });

  it("session-start does not restate the subagent protocol", () => {
    // One location per audience. Main's primer should not carry the subagent
    // read-first protocol, which is what made the two drift in the first place.
    expect(sessionStartMessage()).not.toMatch(/READ-FIRST/);
  });
});
