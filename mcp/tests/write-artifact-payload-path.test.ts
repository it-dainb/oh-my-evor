/**
 * mcp/tests/write-artifact-payload-path.test.ts
 *
 * A payload too large to send inline reliably is written to a JSON file and
 * passed by path.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerArtifactTools } from "../src/tools/artifact.js";
import { ensureRunDirs } from "../src/run-store.js";

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const saved = { root: process.env.EVOR_ROOT, mission: process.env.EVOR_MISSION_ID };
let root = "";
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["EVOR_ROOT", saved.root], ["EVOR_MISSION_ID", saved.mission]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function handlers() {
  const h = new Map<string, Handler>();
  registerArtifactTools({ tool: (n: string, _d: string, _s: unknown, f: Handler) => h.set(n, f) } as never);
  return h;
}

describe("evor_write_artifact payload_path", () => {
  it("writes the artifact from a JSON file", async () => {
    root = mkdtempSync(join(tmpdir(), "evor-pp-"));
    process.env.EVOR_ROOT = root;
    process.env.EVOR_MISSION_ID = "m";
    ensureRunDirs("r", "m");
    const f = join(root, "scratch", "probe.json");
    mkdirSync(join(root, "scratch"), { recursive: true });
    writeFileSync(f, JSON.stringify({ hypothesis_verdict: "confirmed", notes: "x".repeat(30000) }));
    const out = JSON.parse((await handlers().get("evor_write_artifact")!({ run_id: "r", tick: 1, agent: "probe", payload_path: f })).content[0].text);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const written = JSON.parse(readFileSync(join(root, "runs", "m", "r", "ticks", "1", "probe", "findings.json"), "utf8"));
    expect(written.notes).toHaveLength(30000);
  });

  it("refuses a payload file inside the run's own state", async () => {
    root = mkdtempSync(join(tmpdir(), "evor-pp-"));
    process.env.EVOR_ROOT = root;
    const out = JSON.parse((await handlers().get("evor_write_artifact")!({ run_id: "r", tick: 1, agent: "probe", payload_path: "/x/.evor/runs/m/r/a.json" })).content[0].text);
    expect(out.ok).toBe(false);
  });
});
