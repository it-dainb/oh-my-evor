/**
 * §2b.3 — naming the wait.
 *
 * `ARCHITECTURE.md:134` and `skills/evor/SKILL.md` told agents to idle on
 * `job_complete` / `self_heal_event` signals. Those events have **zero
 * producers** anywhere in the codebase — an agent following the instruction
 * could only poll or guess, and the field run did both.
 *
 * Blocking stays a HOST affordance: `Monitor` and `TaskOutput(block:true)`
 * already do it properly. What was ours to provide is a durable statement of
 * WHAT is awaited, so a waiting tick is distinguishable from a stalled one —
 * the distinction C-05 needed and 3.3's `max_dwell_s` computes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { registerArtifactTools } from "../src/tools/artifact.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN = "run-await-01";
const MISSION = "m-await";

let tmpRoot: string;
let saved: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-await-"));
  saved = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
  ensureRunDirs(RUN, MISSION);
});
afterEach(() => {
  if (saved === undefined) delete process.env.EVOR_ROOT; else process.env.EVOR_ROOT = saved;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function handler(name: string) {
  const handlers = new Map<string, (a: never) => Promise<{ content: { text: string }[] }>>();
  registerArtifactTools({
    tool: (n: string, _d: string, _s: unknown, h: never) => { handlers.set(n, h as never); },
  } as never);
  const h = handlers.get(name);
  if (!h) throw new Error(`${name} was not registered`);
  return h;
}

const call = async (args: Record<string, unknown>) =>
  JSON.parse((await handler("evor_await_artifact")(args as never)).content[0].text);

const tickState = () => {
  const p = join(resolveRunPaths(RUN, MISSION).runDir, "tick-state.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
};

describe("§2b.3 — evor_await_artifact", () => {
  it("is registered — the tool the corrected prose now points at", () => {
    expect(() => handler("evor_await_artifact")).not.toThrow();
  });

  it("records WHAT is awaited when the artifact is absent", async () => {
    const res = await call({ run_id: RUN, tick: 3, agent: "forge", mission_id: MISSION });
    expect(res.arrived).toBe(false);
    expect(res.waiting_on).toBe("artifact:forge@tick3");
    expect(tickState().blocked).toMatchObject({ on: "artifact:forge@tick3" });
    expect(tickState().blocked.since, "without a timestamp the wait cannot go stale").toBeTruthy();
  });

  it("reports arrival and clears the wait", async () => {
    const runDir = resolveRunPaths(RUN, MISSION).runDir;
    await call({ run_id: RUN, tick: 3, agent: "forge", mission_id: MISSION });
    mkdirSync(join(runDir, "ticks", "3", "forge"), { recursive: true });
    writeFileSync(join(runDir, "ticks", "3", "forge", "forge-report.json"), "{}");

    const res = await call({ run_id: RUN, tick: 3, agent: "forge", mission_id: MISSION });
    expect(res.arrived).toBe(true);
    expect(tickState().blocked, "a tick that is no longer waiting must say so").toBeNull();
  });

  it("keeps `since` stable across repeated calls", async () => {
    const first = await call({ run_id: RUN, tick: 1, agent: "probe", mission_id: MISSION });
    await new Promise((r) => setTimeout(r, 8));
    const second = await call({ run_id: RUN, tick: 1, agent: "probe", mission_id: MISSION });
    // A wait that restarts its own clock on every poll can never be found stale,
    // which would make the field's 8h16m stall invisible all over again.
    expect(second.waiting_since).toBe(first.waiting_since);
  });

  it("a different wait restarts the clock", async () => {
    const first = await call({ run_id: RUN, tick: 1, agent: "probe", mission_id: MISSION });
    await new Promise((r) => setTimeout(r, 8));
    const other = await call({ run_id: RUN, tick: 1, agent: "sage", mission_id: MISSION });
    expect(other.waiting_since).not.toBe(first.waiting_since);
  });

  it("release clears the wait without the artifact arriving", async () => {
    await call({ run_id: RUN, tick: 2, agent: "sage", mission_id: MISSION });
    expect(tickState().blocked).not.toBeNull();
    await call({ run_id: RUN, tick: 2, agent: "sage", mission_id: MISSION, release: true });
    expect(tickState().blocked).toBeNull();
  });

  it("tells the caller how to actually block, since the old instruction named nothing real", async () => {
    const res = await call({ run_id: RUN, tick: 1, agent: "forge", mission_id: MISSION });
    expect(res.next).toMatch(/TaskOutput|Monitor/);
    expect(res.next, "polling is what agents did when told to wait on a non-existent event").toMatch(/do not poll/i);
  });
});

describe("§2b.3 — the prose no longer names events with no producers", () => {
  const files = ["skills/evor/SKILL.md", "docs/ARCHITECTURE.md"];

  it.each(files)("%s does not instruct waiting on job_complete/self_heal_event", (rel) => {
    const text = readFileSync(join(REPO, rel), "utf8");
    const offenders = text
      .split("\n")
      .filter((l) => /job_complete|self_heal_event/.test(l))
      .filter((l) => !/zero producers|no producers|nothing emits|There is no|Not `job_complete|not by waiting/i.test(l));
    expect(
      offenders,
      "these events have no producers anywhere in the codebase; an agent told to " +
        "wait on them can only poll or guess (§5.10 — a prose reader is still a reader)",
    ).toEqual([]);
  });
});
