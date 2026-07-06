/**
 * mcp/tests/lineage.test.ts
 * Tests for tools/lineage.ts — evor_store_patch, evor_write_handoff, evor_drain_inbox
 *
 * storePatch is pure TS (no bridge) — tested directly.
 * writeHandoff and drainInbox delegate to Python bridges — tested via subprocess
 * when the harness is available (skipped otherwise to keep CI fast).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

import { storePatch, writeHandoff, drainInbox } from "../src/tools/lineage.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";

const HARNESS_DIR = resolve(process.cwd(), "../harness");
const BRIDGE_DIR = resolve(process.cwd(), "bridge");

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;
let savedMissionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-lineage-test-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  savedMissionId = process.env.EVOR_MISSION_ID;
  process.env.EVOR_ROOT = tmpRoot;
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

// ── storePatch ────────────────────────────────────────────────────────────────

describe("storePatch", () => {
  it("writes patch content to nodes/<node_id>/parent.patch", () => {
    const runId = "run-lp-001";
    ensureRunDirs(runId);
    const nodeId = "node-abc";
    const patchContent = "diff --git a/model.py b/model.py\n--- a/model.py\n+++ b/model.py\n@@ -1 +1 @@\n-old\n+new\n";

    const result = storePatch(runId, nodeId, patchContent);
    expect(result.ok).toBe(true);
    expect(result.patchPath).toBeTruthy();

    const paths = resolveRunPaths(runId);
    const patchFile = join(paths.nodesDir, nodeId, "parent.patch");
    expect(existsSync(patchFile)).toBe(true);
    expect(readFileSync(patchFile, "utf8")).toBe(patchContent);
  });

  it("creates node directory when it does not exist", () => {
    const runId = "run-lp-002";
    ensureRunDirs(runId);
    const nodeId = "node-new-xyz";

    const result = storePatch(runId, nodeId, "--- /dev/null\n+++ b/foo.py\n");
    expect(result.ok).toBe(true);

    const paths = resolveRunPaths(runId);
    expect(existsSync(join(paths.nodesDir, nodeId))).toBe(true);
  });

  it("overwrites an existing parent.patch", () => {
    const runId = "run-lp-003";
    ensureRunDirs(runId);
    const nodeId = "node-overwrite";

    storePatch(runId, nodeId, "first content");
    storePatch(runId, nodeId, "second content");

    const paths = resolveRunPaths(runId);
    const content = readFileSync(join(paths.nodesDir, nodeId, "parent.patch"), "utf8");
    expect(content).toBe("second content");
  });

  it("writes empty patch content without error", () => {
    const runId = "run-lp-004";
    ensureRunDirs(runId);
    const result = storePatch(runId, "node-empty", "");
    expect(result.ok).toBe(true);
  });

  it("returns patchPath in the result", () => {
    const runId = "run-lp-005";
    ensureRunDirs(runId);
    const result = storePatch(runId, "node-path-check", "patch");
    expect(result.patchPath).toMatch(/parent\.patch$/);
  });
});

// ── writeHandoff (bridge) ────────────────────────────────────────────────────

describe("writeHandoff", () => {
  const hasHarness = existsSync(join(HARNESS_DIR, "evor"));

  it.skipIf(!hasHarness)("writes handoffs/<tick>-0.json for first handoff", () => {
    const runId = "run-hf-001";
    ensureRunDirs(runId);
    const result = writeHandoff(runId, 3, { summary: "tick 3 done", best_score: 0.91 });
    expect(result.ok).toBe(true);
    expect(result.seq).toBe(0);
    const paths = resolveRunPaths(runId);
    const target = join(paths.runDir, "handoffs", "3-0.json");
    expect(existsSync(target)).toBe(true);
    const data = JSON.parse(readFileSync(target, "utf8"));
    expect(data.summary).toBe("tick 3 done");
  });

  it.skipIf(!hasHarness)("auto-increments seq for the same tick", () => {
    const runId = "run-hf-002";
    ensureRunDirs(runId);
    const r1 = writeHandoff(runId, 1, { part: "a" });
    const r2 = writeHandoff(runId, 1, { part: "b" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.seq).toBe(0);
    expect(r2.seq).toBe(1);
  });

  it.skipIf(!hasHarness)("different ticks get independent seq counters", () => {
    const runId = "run-hf-003";
    ensureRunDirs(runId);
    const r1 = writeHandoff(runId, 1, { tick: 1 });
    const r2 = writeHandoff(runId, 2, { tick: 2 });
    expect(r1.seq).toBe(0);
    expect(r2.seq).toBe(0);
  });

  it.skipIf(!hasHarness)("path contains tick and seq", () => {
    const runId = "run-hf-004";
    ensureRunDirs(runId);
    const result = writeHandoff(runId, 7, { msg: "hello" });
    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/handoffs[/\\]7-0\.json$/);
  });
});

// ── drainInbox (bridge) ───────────────────────────────────────────────────────

describe("drainInbox", () => {
  const hasHarness = existsSync(join(HARNESS_DIR, "evor"));
  const pythonBin = process.env.EVOR_PYTHON ?? "python3";

  it.skipIf(!hasHarness)("returns drained=0 when signals-inbox is absent", () => {
    const runId = "run-di-001";
    ensureRunDirs(runId);
    const result = drainInbox(runId, "signals");
    expect(result.ok).toBe(true);
    expect(result.drained).toBe(0);
  });

  it.skipIf(!hasHarness)("returns drained=0 when remember-inbox is absent", () => {
    const runId = "run-di-002";
    ensureRunDirs(runId);
    const result = drainInbox(runId, "remember");
    expect(result.ok).toBe(true);
    expect(result.drained).toBe(0);
  });

  it.skipIf(!hasHarness)("drains a signals-inbox entry", () => {
    const runId = "run-di-003";
    const paths = ensureRunDirs(runId);
    const inbox = join(paths.runDir, "signals-inbox.jsonl");
    writeFileSync(inbox, JSON.stringify({
      kind: "cuda-oom",
      signature: "cuda-oom-bs256",
      shapes: ["limit"],
      axes: ["memory"],
      severity: "high",
      evidence: { batch: 256 },
      source: "test",
      created_at: new Date().toISOString(),
    }) + "\n", "utf8");

    const result = drainInbox(runId, "signals");
    expect(result.ok).toBe(true);
    expect(result.drained).toBe(1);
    expect(existsSync(inbox)).toBe(false); // consumed
  });
});

// ── handoff_bridge.py subprocess tests ───────────────────────────────────────

describe("handoff_bridge.py (subprocess)", () => {
  const hasHarness = existsSync(join(HARNESS_DIR, "evor"));
  const bridgeScript = join(BRIDGE_DIR, "handoff_bridge.py");
  const pythonBin = process.env.EVOR_PYTHON ?? "python3";

  it.skipIf(!hasHarness)("--help exits 0", () => {
    const result = spawnSync(pythonBin, [bridgeScript, "--help"], {
      encoding: "utf8",
      env: pythonEnv(),
    });
    expect(result.status).toBe(0);
  });

  it.skipIf(!hasHarness)("writes handoff and returns ok+path+seq", () => {
    const runDir = join(tmpRoot, "run-hb-001");
    mkdirSync(runDir, { recursive: true });
    const payloadFile = join(tmpRoot, "hf-payload.json");
    writeFileSync(payloadFile, JSON.stringify({ msg: "test handoff" }), "utf8");

    const result = spawnSync(
      pythonBin,
      [bridgeScript, "--run-dir", runDir, "--tick", "4", "--payload-file", payloadFile],
      { encoding: "utf8", env: pythonEnv() },
    );
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(true);
    expect(data.seq).toBe(0);
    expect(existsSync(join(runDir, "handoffs", "4-0.json"))).toBe(true);
  });

  it.skipIf(!hasHarness)("missing payload file produces {error} exit 1", () => {
    const result = spawnSync(
      pythonBin,
      [bridgeScript, "--run-dir", tmpRoot, "--tick", "1",
        "--payload-file", "/nonexistent/payload.json"],
      { encoding: "utf8", env: pythonEnv() },
    );
    expect(result.status).toBe(1);
    const data = JSON.parse(result.stdout);
    expect(data.error).toBeTruthy();
  });
});

// ── inbox_bridge.py subprocess tests ─────────────────────────────────────────

describe("inbox_bridge.py (subprocess)", () => {
  const hasHarness = existsSync(join(HARNESS_DIR, "evor"));
  const bridgeScript = join(BRIDGE_DIR, "inbox_bridge.py");
  const pythonBin = process.env.EVOR_PYTHON ?? "python3";

  it.skipIf(!hasHarness)("--help exits 0", () => {
    const result = spawnSync(pythonBin, [bridgeScript, "--help"], {
      encoding: "utf8",
      env: pythonEnv(),
    });
    expect(result.status).toBe(0);
  });

  it.skipIf(!hasHarness)("drains absent signals inbox (drained=0)", () => {
    const runDir = join(tmpRoot, "run-ib-001");
    mkdirSync(runDir, { recursive: true });

    const result = spawnSync(
      pythonBin,
      [bridgeScript, "--run-dir", runDir, "--kind", "signals"],
      { encoding: "utf8", env: pythonEnv() },
    );
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(true);
    expect(data.drained).toBe(0);
  });
});
