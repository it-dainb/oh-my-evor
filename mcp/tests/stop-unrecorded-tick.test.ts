/**
 * mcp/tests/stop-unrecorded-tick.test.ts
 *
 * A finished tick with no `tick_record` is debt the orchestrator can pay in one
 * call, and the circuit breaker and plateau window cannot see it otherwise.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../hooks");

function run(runState: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "evor-unrec-"));
  const runDir = join(root, ".evor", "runs", "m1", "r1");
  for (const a of ["mutagen", "selector"]) mkdirSync(join(runDir, "ticks", "1", a), { recursive: true });
  // Tick 1's roster artifacts exist, so only the record question is in play.
  writeFileSync(join(runDir, "ticks", "1", "mutagen", "proposals.json"), "{}");
  writeFileSync(join(runDir, "ticks", "1", "selector", "verdict.json"), "{}");
  writeFileSync(join(root, ".evor", "active-run.json"), JSON.stringify({ run_id: "r1", mission_id: "m1" }));
  writeFileSync(join(runDir, "mission-state.json"), JSON.stringify({ status: "running" }));
  writeFileSync(join(runDir, "tick-state.json"), JSON.stringify({ tick: 1, current_step: 9, step_status: "done" }));
  writeFileSync(join(runDir, "run-state.json"), JSON.stringify({ pending_node_ids: [], ...runState }));
  const transcript = join(root, "s.jsonl");
  writeFileSync(transcript, "");
  mkdirSync(join(root, "s", "subagents"), { recursive: true }); // nothing live
  const r = spawnSync("node", [join(HOOKS, "stop.mjs")], {
    input: JSON.stringify({ stop_hook_active: false, session_id: "s", transcript_path: transcript }),
    encoding: "utf8",
    env: { ...process.env, EVOR_ROOT: join(root, ".evor"), CLAUDE_PLUGIN_ROOT: resolve(HOOKS, "..") },
  });
  rmSync(root, { recursive: true, force: true });
  let reason = "";
  try {
    const p = JSON.parse((r.stdout ?? "").trim());
    if (p?.decision === "block") reason = String(p.reason ?? "");
  } catch { /* not a block */ }
  return reason;
}

describe("a finished tick must be recorded", () => {
  it("blocks when tick 1 finished and has no tick_record", () => {
    const reason = run({ tick_count: 1 });
    expect(reason).toMatch(/tick\(s\) 1 finished with no tick_record/);
  });

  it("is silent once the tick is recorded", () => {
    const reason = run({ tick_count: 1, tick_records: [{ tick: 1, outcome: "scored", score: 0.4 }] });
    expect(reason).not.toMatch(/tick_record/);
  });

  it("still catches an earlier tick after main has moved on", () => {
    const reason = run({ tick_count: 3, tick_records: [{ tick: 1, outcome: "scored" }, { tick: 3, outcome: "failed" }] });
    expect(reason).toMatch(/tick\(s\) 2 finished/);
  });
});

describe("a run that predates tick records", () => {
  it("is asked for its latest tick only, not for history it cannot reconstruct", () => {
    const reason = run({ tick_count: 7 });
    expect(reason).toMatch(/tick\(s\) 7 finished with no tick_record/);
    expect(reason).not.toMatch(/tick\(s\) 1/);
  });
});
