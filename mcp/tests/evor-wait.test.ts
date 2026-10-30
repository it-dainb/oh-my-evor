/**
 * mcp/tests/evor-wait.test.ts
 *
 * evor_wait holds the caller's turn until a condition holds. The 2026-10-30
 * binarization mission lost 80 minutes to a queued notice and then stalled for
 * good on a job nothing tracked; a wait that blocks needs no notice.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { registerWaitTools, waitFor, pidAlive, MAX_WAIT_S } from "../src/tools/wait.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";

const RUN = "run-wait-01";
const MISSION = "m-wait";

let tmpRoot: string;
let saved: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-wait-"));
  saved = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
  ensureRunDirs(RUN, MISSION);
});
afterEach(() => {
  if (saved === undefined) delete process.env.EVOR_ROOT; else process.env.EVOR_ROOT = saved;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function call(args: Record<string, unknown>) {
  let h: ((a: never) => Promise<{ content: { text: string }[]; isError?: boolean }>) | undefined;
  registerWaitTools({ tool: (_n: string, _d: string, _s: unknown, fn: never) => { h = fn; } } as never);
  return h!(args as never).then((r) => ({ ...JSON.parse(r.content[0].text), isError: r.isError }));
}

describe("waitFor", () => {
  it("returns done as soon as the probe holds", async () => {
    let n = 0;
    const r = await waitFor(() => ({ done: ++n >= 3 }), 5, 10);
    expect(r.done).toBe(true);
    expect(n).toBe(3);
  });

  it("returns done:false when the time runs out, without waiting past it", async () => {
    const t0 = Date.now();
    const r = await waitFor(() => ({ done: false }), 0, 10);
    expect(r.done).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("stops on a probe error instead of waiting it out", async () => {
    const r = await waitFor(() => ({ done: false, error: "boom" }), 60, 10);
    expect(r).toMatchObject({ done: false, error: "boom" });
  });
});

describe("pidAlive", () => {
  it("tracks a child from running to exited", async () => {
    const child = spawn("sleep", ["0.3"]);
    expect(pidAlive(child.pid!)).toBe(true);
    await new Promise((r) => child.on("exit", r));
    expect(pidAlive(child.pid!)).toBe(false);
  });
});

describe("evor_wait", () => {
  it("caps a single call below ten minutes", () => {
    expect(MAX_WAIT_S).toBeLessThan(600);
  });

  it("refuses zero or several conditions", async () => {
    expect((await call({ run_id: RUN, wait_s: 0 })).isError).toBe(true);
    expect((await call({ run_id: RUN, pid: 1, job_id: "j", wait_s: 0 })).isError).toBe(true);
  });

  it("returns done for an artifact that is already written", async () => {
    const dir = join(resolveRunPaths(RUN, MISSION).runDir, "ticks", "2", "forge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "forge-report.json"), "{}");
    const r = await call({ run_id: RUN, mission_id: MISSION, artifact: { tick: 2, agent: "forge" }, wait_s: 0 });
    expect(r).toMatchObject({ done: true, condition: "artifact:forge@tick2" });
  });

  it("tells the caller to call again, not to end its turn, when the time runs out", async () => {
    const r = await call({ run_id: RUN, mission_id: MISSION, artifact: { tick: 3, agent: "forge" }, wait_s: 0 });
    expect(r.done).toBe(false);
    expect(r.next).toMatch(/call evor_wait again/);
  });

  it("returns done when a pid exits", async () => {
    const child = spawn("sleep", ["0.2"]);
    await new Promise((r) => child.on("exit", r));
    const r = await call({ pid: child.pid, wait_s: 0 });
    expect(r).toMatchObject({ done: true, condition: `pid:${child.pid}` });
  });

  it("errors at once on a job that does not exist, rather than waiting out wait_s", async () => {
    const t0 = Date.now();
    const r = await call({ run_id: RUN, mission_id: MISSION, job_id: "no-such-job", wait_s: 60 });
    expect(r.isError).toBe(true);
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it("refuses to wait with no run, instead of waiting forever on the mission directory", async () => {
    const saved = process.env.EVOR_ACTIVE_RUN_ID;
    delete process.env.EVOR_ACTIVE_RUN_ID;
    const r = await call({ artifact: { tick: 1, agent: "forge" }, wait_s: 0 });
    if (saved !== undefined) process.env.EVOR_ACTIVE_RUN_ID = saved;
    expect(r.isError).toBe(true);
  });

  it("refuses an agent no writer produces, and a per-kind agent without its kind", async () => {
    expect((await call({ run_id: RUN, mission_id: MISSION, artifact: { tick: 1, agent: "nobody" }, wait_s: 0 })).isError).toBe(true);
    expect((await call({ run_id: RUN, mission_id: MISSION, artifact: { tick: 1, agent: "sage-junior" }, wait_s: 0 })).isError).toBe(true);
  });

  it("accepts an agent named by its full type", async () => {
    const r = await call({ run_id: RUN, mission_id: MISSION, artifact: { tick: 1, agent: "oh-my-evor:evor-forge" }, wait_s: 0 });
    expect(r).toMatchObject({ done: false, condition: "artifact:forge@tick1" });
  });
});
