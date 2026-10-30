/**
 * mcp/tests/record-node-telemetry-dir.test.ts
 *
 * evor_record_node hands out the node's telemetry_path, and `.evor/` is closed to
 * hand writes, so the directory must exist before the trainer appends to it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { registerRecordTools } from "../src/tools/record.js";
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

describe("evor_record_node's telemetry_path", () => {
  it("names a directory that already exists", async () => {
    root = mkdtempSync(join(tmpdir(), "evor-rn-"));
    process.env.EVOR_ROOT = root;
    process.env.EVOR_MISSION_ID = "m";
    ensureRunDirs("r", "m");
    const h = new Map<string, Handler>();
    registerRecordTools({ tool: (n: string, _d: string, _s: unknown, f: Handler) => h.set(n, f) } as never);
    const res = await h.get("evor_record_node")!({
      run_id: "r",
      node: {
        name: "cosine-lr-01", parent_ids: [], approach_family: "arch", hypothesis_id: "h-1",
        code_ref: "sha:abc", genome_ref: "sha:g", data_version_ref: "sha:d", config: {}, metrics: {},
        eval_version: "v1", lesson_ids: [], citations: [], integrity_status: "pending", status: "pending",
        is_crossover: false, visit_count: 0, depth: 0, created_at: new Date().toISOString(),
      },
    });
    const out = JSON.parse(res.content[0].text);
    expect(out.ok).toBe(true);
    expect(existsSync(dirname(out.telemetry_path))).toBe(true);
  });
});
