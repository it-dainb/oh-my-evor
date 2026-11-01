/**
 * A "not found" read names the ticks that do hold the artifact, so an agent that asked
 * the wrong tick reads the right one instead of trying ticks one by one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { registerArtifactTools, artifactPathFor } from "../src/tools/artifact.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";

const RUN = "run-elsewhere-01";
const MISSION = "m-elsewhere";
let tmpRoot: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-elsewhere-"));
  for (const k of ["EVOR_ROOT", "EVOR_MISSION_ID"]) saved[k] = process.env[k];
  process.env.EVOR_ROOT = tmpRoot;
  process.env.EVOR_MISSION_ID = MISSION;
  ensureRunDirs(RUN, MISSION);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function read(args: Record<string, unknown>) {
  let h: ((a: never) => Promise<{ content: { text: string }[] }>) | undefined;
  registerArtifactTools({
    tool: (n: string, _d: string, _s: unknown, fn: never) => { if (n === "evor_read_artifact") h = fn; },
  } as never);
  return JSON.parse((await h!(args as never)).content[0].text);
}

function put(tick: number, agent: string, kind?: string) {
  const p = artifactPathFor(resolveRunPaths(RUN, MISSION).runDir, tick, agent, kind);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ node_id: kind ?? agent }));
}

describe("evor_read_artifact not found", () => {
  it("names the ticks that hold the same agent and kind, newest first", async () => {
    put(15, "forge", "alpha025-s31-01");
    put(19, "forge", "alpha025-s31-01");
    put(18, "forge", "other-01");
    const res = await read({ run_id: RUN, tick: 17, agent: "forge", kind: "alpha025-s31-01" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not found");
    expect(res.found_at_ticks).toEqual([19, 15]);
    expect(res.next).toMatch(/tick 19, 15/);
  });

  it("adds nothing when no tick holds it", async () => {
    const res = await read({ run_id: RUN, tick: 19, agent: "selector" });
    expect(res).toEqual({ ok: false, error: "not found" });
  });
});
