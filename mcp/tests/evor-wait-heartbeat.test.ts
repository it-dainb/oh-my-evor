/**
 * mcp/tests/evor-wait-heartbeat.test.ts
 *
 * A heartbeat reports a run as stalled when nothing in it has changed for
 * quiet_s, and as active otherwise, so a lost completion notice still leads
 * the orchestrator back to the tick.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerWaitTools, lastActivity } from "../src/tools/wait.js";

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const saved = { root: process.env.EVOR_ROOT, mission: process.env.EVOR_MISSION_ID };
let root = "";
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["EVOR_ROOT", saved.root], ["EVOR_MISSION_ID", saved.mission]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function setup(ageS: number) {
  root = mkdtempSync(join(tmpdir(), "evor-hb-"));
  process.env.EVOR_ROOT = root;
  process.env.EVOR_MISSION_ID = "m";
  const run = join(root, "runs", "m", "r");
  mkdirSync(join(run, "ticks", "1"), { recursive: true });
  const f = join(run, "tick-state.json");
  writeFileSync(f, "{}");
  const t = new Date(Date.now() - ageS * 1000);
  utimesSync(f, t, t);
  utimesSync(join(run, "ticks", "1"), t, t);
  const h = new Map<string, Handler>();
  registerWaitTools({ tool: (n: string, _d: string, _s: unknown, fn: Handler) => h.set(n, fn) } as never);
  return { run, call: (a: Record<string, unknown>) => h.get("evor_wait")!({ run_id: "r", ...a }).then((r) => JSON.parse(r.content[0].text)) };
}

describe("evor_wait heartbeat", () => {
  it("reports stalled when nothing changed for quiet_s", async () => {
    const { call } = setup(1200);
    const r = await call({ heartbeat: true, quiet_s: 600, wait_s: 1 });
    expect(r.stalled).toBe(true);
    expect(r.next).toMatch(/resume the evor-tick agent/);
  });

  it("reports active when the run changed recently", async () => {
    const { call } = setup(5);
    const r = await call({ heartbeat: true, quiet_s: 600, wait_s: 0 });
    expect(r.stalled).toBe(false);
  });

  it("counts a trainer log in a worktree as activity", () => {
    const { run } = setup(1200);
    const wt = join(root, "worktrees", "c1");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "train.log"), "step 10");
    expect(Date.now() - lastActivity(run)).toBeLessThan(10_000);
  });
});
