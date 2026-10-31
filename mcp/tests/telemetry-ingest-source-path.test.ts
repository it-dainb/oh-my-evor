/**
 * mcp/tests/telemetry-ingest-source-path.test.ts
 *
 * A trainer that logged into its worktree instead of the node's telemetry_path
 * is repaired by ingesting that file whole, into the node's canonical directory.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerTelemetryTools } from "../src/tools/telemetry.js";
import { ensureRunDirs } from "../src/run-store.js";
import { writeTree } from "../src/tree-store.js";

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const saved = { root: process.env.EVOR_ROOT, mission: process.env.EVOR_MISSION_ID };
let root = "";
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["EVOR_ROOT", saved.root], ["EVOR_MISSION_ID", saved.mission]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("evor_telemetry_ingest from a trainer's file", () => {
  it("ingests a worktree telemetry.jsonl into the node's directory", async () => {
    root = mkdtempSync(join(tmpdir(), "evor-tel-"));
    process.env.EVOR_ROOT = root;
    process.env.EVOR_MISSION_ID = "m";
    ensureRunDirs("r", "m");
    const id = "8522cd01-ca87-4a9a-8446-92e46305f528";
    writeTree("r", { [id]: {
      id, name: "ckptfloor-s42-01", parent_ids: [], approach_family: "arch", hypothesis_id: "h-1",
      code_ref: "sha:a", genome_ref: "sha:g", data_version_ref: "sha:d", config: {}, metrics: {},
      eval_version: "v1", lesson_ids: [], citations: [], integrity_status: "pending", status: "pending",
      is_crossover: false, visit_count: 0, depth: 0, created_at: new Date().toISOString(),
    } as never }, "m");
    const wt = join(root, "worktrees", "ckptfloor-s42-01");
    mkdirSync(wt, { recursive: true });
    const src = join(wt, "telemetry.jsonl");
    writeFileSync(src, [
      JSON.stringify({ step: 0, train_loss: 1.5 }),
      "not json",
      JSON.stringify({ step: 1, train_loss: 1.2 }),
    ].join("\n") + "\n");
    const h = new Map<string, Handler>();
    registerTelemetryTools({ tool: (n: string, _d: string, _s: unknown, f: Handler) => h.set(n, f) } as never);
    const out = JSON.parse((await h.get("evor_telemetry_ingest")!({ run_id: "r", node_id: "ckptfloor-s42-01", source_path: src })).content[0].text);
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.skipped_lines).toBe(1);
    const lines = readFileSync(join(root, "runs", "m", "r", "nodes", id, "telemetry.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
