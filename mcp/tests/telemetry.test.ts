/**
 * tests/telemetry.test.ts
 * Unit tests for tools/telemetry.ts: telemetryIngest
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { telemetryIngest } from "../src/tools/telemetry.js";
import type { TelemetryRecord } from "../src/contracts.js";

// ── Fixture ─────────────────────────────────────────────────────────────────

function makeRecord(step: number): TelemetryRecord {
  return {
    step,
    epoch: 1,
    train_loss: 2.5 - step * 0.01,
    grad_norm: 1.2,
    samples_per_sec: 100,
    timestamp: new Date().toISOString(),
    node_id: "node-test",
    run_id: "run-test",
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-telemetry-test-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
});

afterEach(() => {
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("telemetryIngest", () => {
  it("writes JSONL lines to nodes/<nodeId>/telemetry.jsonl", () => {
    const runId = "run-tel-001";
    const nodeId = randomUUID();
    const records = [makeRecord(1), makeRecord(2), makeRecord(3)];

    const { telemetryPath, count } = telemetryIngest(runId, nodeId, records);

    expect(count).toBe(3);
    expect(existsSync(telemetryPath)).toBe(true);

    const lines = readFileSync(telemetryPath, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].step).toBe(1);
    expect(parsed[1].step).toBe(2);
    expect(parsed[2].step).toBe(3);
  });

  it("appends on multiple calls (JSONL grows)", () => {
    const runId = "run-tel-002";
    const nodeId = randomUUID();

    telemetryIngest(runId, nodeId, [makeRecord(1)]);
    telemetryIngest(runId, nodeId, [makeRecord(2), makeRecord(3)]);

    const { telemetryPath } = telemetryIngest(runId, nodeId, [makeRecord(4)]);
    const lines = readFileSync(telemetryPath, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(4);
  });

  it("creates node directory if absent", () => {
    const runId = "run-tel-003";
    const nodeId = randomUUID();
    const { telemetryPath } = telemetryIngest(runId, nodeId, [makeRecord(1)]);
    expect(existsSync(telemetryPath)).toBe(true);
  });

  it("each line is valid JSON with expected fields", () => {
    const runId = "run-tel-004";
    const nodeId = randomUUID();
    const { telemetryPath } = telemetryIngest(runId, nodeId, [makeRecord(5)]);

    const line = readFileSync(telemetryPath, "utf8").trim();
    const rec = JSON.parse(line);
    expect(rec.step).toBe(5);
    expect(typeof rec.train_loss).toBe("number");
    expect(typeof rec.timestamp).toBe("string");
  });
});
