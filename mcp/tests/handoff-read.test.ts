/**
 * tests/handoff-read.test.ts
 * Tests for readHandoff (evor_read_handoff) in tools/lineage.ts.
 *
 * The pure-TS logic (resolving the run dir) is tested directly.
 * Bridge calls (Python) are tested when the harness is available.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

import { readHandoff } from "../src/tools/lineage.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";

const HARNESS_DIR = resolve(process.cwd(), "../harness");
const BRIDGE_DIR = resolve(process.cwd(), "bridge");

// ── Lifecycle ────────────────────────────────���───────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;
let savedMissionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-handoff-read-test-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  savedMissionId = process.env.EVOR_MISSION_ID;
  process.env.EVOR_ROOT = tmpRoot;
  process.env.EVOR_BRIDGE_DIR = BRIDGE_DIR;
  delete process.env.EVOR_MISSION_ID;
});

afterEach(() => {
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  if (savedMissionId === undefined) {
    delete process.env.EVOR_MISSION_ID;
  } else {
    process.env.EVOR_MISSION_ID = savedMissionId;
  }
  delete process.env.EVOR_BRIDGE_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function pythonEnv(): Record<string, string> {
  const existing = process.env.PYTHONPATH;
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PYTHONPATH: existing ? `${HARNESS_DIR}:${existing}` : HARNESS_DIR,
    EVOR_ROOT: tmpRoot,
    EVOR_BRIDGE_DIR: BRIDGE_DIR,
  };
}

// ── Tests ──────��──────────────────────────────────────────────────────────────

describe("readHandoff — not found cases", () => {
  it("returns {error:'not found'} when no handoffs exist (latest-tick route)", () => {
    const runId = "run-rh-001";
    ensureRunDirs(runId);

    const result = readHandoff(runId, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns {error:'not found'} for a missing within-tick pair", () => {
    const runId = "run-rh-002";
    ensureRunDirs(runId);
    // Create handoffs dir but no specific pair file.
    const paths = resolveRunPaths(runId);
    mkdirSync(join(paths.runDir, "handoffs"), { recursive: true });

    const result = readHandoff(runId, { fromAgent: "evor", toAgent: "forge" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns {error:'not found'} for a missing tick markdown", () => {
    const runId = "run-rh-003";
    ensureRunDirs(runId);

    const result = readHandoff(runId, { tick: 99 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("readHandoff — successful reads (Python harness required)", () => {
  it("reads a within-tick JSON handoff written by evor.handoff.write_handoff", () => {
    const runId = "run-rh-pair-001";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    // Write the handoff file directly (mirrors write_handoff output format).
    const handoffsDir = join(paths.runDir, "handoffs");
    mkdirSync(handoffsDir, { recursive: true });
    const handoffData = {
      from_agent: "evor",
      to_agent: "selector",
      written_at: "2025-01-01T00:00:00.000Z",
      payload: { frontier_ids: ["node-a", "node-b"], tick: 3 },
    };
    writeFileSync(
      join(handoffsDir, "evor_to_selector.json"),
      JSON.stringify(handoffData, null, 2),
      "utf8",
    );

    const result = readHandoff(runId, { fromAgent: "evor", toAgent: "selector" });
    expect(result.ok).toBe(true);
    const h = result.handoff as Record<string, unknown>;
    expect(h.from_agent).toBe("evor");
    expect(h.to_agent).toBe("selector");
    const payload = h.payload as Record<string, unknown>;
    expect(payload.tick).toBe(3);
  });

  it("reads the latest tick markdown handoff", () => {
    const runId = "run-rh-latest-001";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    const handoffsDir = join(paths.runDir, "handoffs");
    mkdirSync(handoffsDir, { recursive: true });

    // Write two tick handoffs — bridge should return the higher-numbered one.
    writeFileSync(join(handoffsDir, "tick-0.md"), "# Tick 0 Handoff\nOld content", "utf8");
    writeFileSync(join(handoffsDir, "tick-3.md"), "# Tick 3 Handoff\nLatest content", "utf8");

    const result = readHandoff(runId, {});
    expect(result.ok).toBe(true);
    expect(result.tick).toBe(3);
    expect(result.handoff as string).toContain("Tick 3 Handoff");
  });

  it("reads a specific tick markdown handoff by tick number", () => {
    const runId = "run-rh-tick-001";
    ensureRunDirs(runId);
    const paths = resolveRunPaths(runId);

    const handoffsDir = join(paths.runDir, "handoffs");
    mkdirSync(handoffsDir, { recursive: true });
    writeFileSync(join(handoffsDir, "tick-2.md"), "# Tick 2 Handoff\nSpecific tick", "utf8");

    const result = readHandoff(runId, { tick: 2 });
    expect(result.ok).toBe(true);
    expect(result.tick).toBe(2);
    expect(result.handoff as string).toContain("Tick 2");
  });
});
