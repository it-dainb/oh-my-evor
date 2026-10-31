/**
 * mcp/tests/record-eval-from-evaluator.test.ts
 *
 * The evaluation job writes its own result; recording it must not require the agent
 * to paste the whole result back as JSON.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerRecordTools } from "../src/tools/record.js";

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let root = "";
afterEach(() => {
  delete process.env.EVOR_ROOT;
  delete process.env.EVOR_MISSION_ID;
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  root = mkdtempSync(join(tmpdir(), "evor-receval-"));
  process.env.EVOR_ROOT = root;
  process.env.EVOR_MISSION_ID = "m";
  const run = join(root, "runs", "m", "r");
  mkdirSync(join(run, "nodes", "n1"), { recursive: true });
  writeFileSync(join(run, "run-state.json"), JSON.stringify({ run_id: "r", tick_count: 1 }));
  const h = new Map<string, Handler>();
  registerRecordTools({ tool: (n: string, _d: string, _s: unknown, fn: Handler) => h.set(n, fn) } as never);
  return { run, call: (a: Record<string, unknown>) => h.get("evor_record_eval")!({ run_id: "r", ...a }) };
}

describe("evor_record_eval without result", () => {
  it("refuses when the evaluation job has not written its output", async () => {
    const { call } = setup();
    const r = await call({ node_id: "n1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/evor_run_start/);
  });

  it("records the evaluation job's own output", async () => {
    const { run, call } = setup();
    writeFileSync(join(run, "nodes", "n1", "results.evaluator.json"), JSON.stringify({
      node_id: "n1", run_id: "r", status: "regression", eval_version: "v1",
      timestamp: "2026-10-31T00:00:00Z", fitness_value: 0.009, metrics: { min_domain_ocr_faithful: 0.009 },
      per_domain: { d1: { fmeasure: 88.6, n: 2 } }, telemetry_summary: { total_steps: 0 },
      benchmark_raw: "evaluator stdout", worst_angle_coverage: 0, per_angle_vs_sota: {},
    }));
    const r = await call({ node_id: "n1" });
    expect(r.isError, r.content[0].text).not.toBe(true);
    const saved = JSON.parse(readFileSync(join(run, "nodes", "n1", "results.json"), "utf8"));
    expect(saved.fitness_value).toBe(0.009);
  }, 60_000);
});
