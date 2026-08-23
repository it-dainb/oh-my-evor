/**
 * mcp/tests/artifact.test.ts
 * Tests for tools/artifact.ts — evor_write_artifact
 *
 * Core-logic tests use writeArtifact() directly with a real EVOR_ROOT tmp dir.
 * Bridge-dependent tests spawn artifact_bridge.py via a real Python subprocess.
 *
 * EVOR_PYTHON and PYTHONPATH are injected so the harness is importable without
 * a pip install — matching the pattern used in record.test.ts / state.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

import { writeArtifact, readArtifact } from "../src/tools/artifact.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";

// Harness directory: mcp/tests/ → mcp/ → repo root → harness/
const HARNESS_DIR = resolve(process.cwd(), "../harness");
const BRIDGE_DIR = resolve(process.cwd(), "bridge");

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;
let savedMissionId: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-artifact-test-"));
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function minimalProposal(): Record<string, unknown> {
  return {
    proposal_id: "p-001",
    parent_node_ids: ["root"],
    approach_family: "arch",
    idea: "Add a residual connection",
    hypothesis: {
      id: "h-001",
      statement: "Residuals improve gradient flow",
      prediction: "val_acc +2pp",
    },
    citations: [],
    wildness: 0.3,
    critic_approved: true,
    critic_review: {
      h001_one_hypothesis: "pass",
      h002_family_streak: "pass",
      h003_intra_tick_diversity: "pass",
      integrity_risk: "pass",
      instrumentation_check: "pass",
      schema_valid: "pass",
      verdict: "approved",
    },
  };
}

function minimalSelectorVerdict(): Record<string, unknown> {
  return {
    reviews: [
      {
        proposal_id: "p1",
        approach_family: "algo",
        critic_review: {
          h001_one_hypothesis: "pass",
          h002_family_streak: "pass",
          h003_intra_tick_diversity: "pass",
          h004_parent_diversity: "pass",
          integrity_risk: "pass",
          instrumentation_check: "pass",
          schema_valid: "pass",
          acquisition_contamination: null,
          gotcha_avoidance: "pass",
          verdict: "approved",
        },
        selected: true,
        selection_note: "best fit for this tick",
      },
    ],
    winner: "p1",
  };
}

function pythonEnv(): Record<string, string> {
  const existing = process.env.PYTHONPATH;
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    PYTHONPATH: existing ? `${HARNESS_DIR}:${existing}` : HARNESS_DIR,
    EVOR_ROOT: tmpRoot,
    EVOR_BRIDGE_DIR: BRIDGE_DIR,
  };
}

// ── writeArtifact: path resolution ───────────────────────────────────────────

describe("writeArtifact — path resolution", () => {
  it("writes selector artifact to canonical path", () => {
    const runId = "run-art-001";
    ensureRunDirs(runId, "test-mission");
    const result = writeArtifact(runId, 1, "selector", minimalSelectorVerdict());
    expect(result.ok).toBe(true);
    const paths = resolveRunPaths(runId);
    const target = join(paths.runDir, "ticks", "1", "selector", "verdict.json");
    expect(existsSync(target)).toBe(true);
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.winner).toBe("p1");
  });

  it("writes probe artifact to canonical path", () => {
    const runId = "run-art-002";
    ensureRunDirs(runId, "test-mission");
    const result = writeArtifact(runId, 3, "probe", { findings: [] });
    expect(result.ok).toBe(true);
    const paths = resolveRunPaths(runId);
    const target = join(paths.runDir, "ticks", "3", "probe", "findings.json");
    expect(existsSync(target)).toBe(true);
  });

  it("writes partial artifact with -partial.json suffix", () => {
    const runId = "run-art-003";
    ensureRunDirs(runId, "test-mission");
    const result = writeArtifact(runId, 2, "mutagen", { proposals: [] }, undefined, true);
    expect(result.ok).toBe(true);
    expect(result.path).toMatch(/-partial\.json$/);
  });

  it("creates intermediate tick directories automatically", () => {
    const runId = "run-art-004";
    ensureRunDirs(runId, "test-mission");
    writeArtifact(runId, 9, "forge", { summary: "done" });
    const paths = resolveRunPaths(runId);
    expect(existsSync(join(paths.runDir, "ticks", "9", "forge"))).toBe(true);
  });
});

// ── writeArtifact: pass-through agents (no Python validation) ────────────────

describe("writeArtifact — pass-through agents", () => {
  // These tests verify the TS layer works; the bridge call exercises Python.
  // We skip them when the Python bridge is unavailable to keep CI fast.
  const hasHarness = existsSync(join(HARNESS_DIR, "evor", "artifacts.py"));

  it.skipIf(!hasHarness)("forge-architect passes through", () => {
    const runId = "run-art-pt-002";
    ensureRunDirs(runId, "test-mission");
    const result = writeArtifact(runId, 1, "forge-architect", { plan: "..." });
    expect(result.ok).toBe(true);
  });
});

// ── writeArtifact: mutagen validation via Python bridge ──────────────────────

describe("writeArtifact — validation via bridge", () => {
  const hasHarness = existsSync(join(HARNESS_DIR, "evor", "artifacts.py"));

  it.skipIf(!hasHarness)("valid mutagen proposals pass", () => {
    const runId = "run-art-val-001";
    ensureRunDirs(runId, "test-mission");
    const result = writeArtifact(
      runId, 1, "mutagen",
      { proposals: [minimalProposal()] },
    );
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it.skipIf(!hasHarness)("invalid mutagen proposals return error", () => {
    const runId = "run-art-val-002";
    ensureRunDirs(runId, "test-mission");
    // Missing required 'idea' field
    const result = writeArtifact(
      runId, 1, "mutagen",
      { proposals: [{ proposal_id: "bad", approach_family: "arch" }] },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it.skipIf(!hasHarness)("valid selector verdict passes", () => {
    const runId = "run-art-val-003";
    ensureRunDirs(runId, "test-mission");
    const result = writeArtifact(runId, 1, "selector", minimalSelectorVerdict());
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it.skipIf(!hasHarness)("selector verdict with renamed container is rejected", () => {
    const runId = "run-art-val-004";
    ensureRunDirs(runId, "test-mission");
    // Real drift shape: "per_proposal_reviews" instead of "reviews".
    const result = writeArtifact(runId, 1, "selector", { per_proposal_reviews: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("reviews");
  });
});

// ── readArtifact ─────────────────────────────────────────────────────────────

describe("readArtifact — not found", () => {
  const hasHarness = existsSync(join(HARNESS_DIR, "evor", "artifacts.py"));

  it.skipIf(!hasHarness)("returns {error:'not found'} when artifact does not exist", () => {
    const runId = "run-read-001";
    ensureRunDirs(runId, "test-mission");
    const result = readArtifact(runId, 1, "selector");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not found");
  });

  it.skipIf(!hasHarness)("returns not-found for a tick that has no ticks/ dir yet", () => {
    const runId = "run-read-002";
    ensureRunDirs(runId, "test-mission");
    const result = readArtifact(runId, 99, "probe");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not found");
  });
});

describe("readArtifact — found", () => {
  const hasHarness = existsSync(join(HARNESS_DIR, "evor", "artifacts.py"));

  it.skipIf(!hasHarness)("reads back payload written by writeArtifact", () => {
    const runId = "run-read-003";
    ensureRunDirs(runId, "test-mission");
    writeArtifact(runId, 1, "selector", minimalSelectorVerdict());
    const result = readArtifact(runId, 1, "selector");
    expect(result.ok).toBe(true);
    expect((result.payload as Record<string, unknown>)?.winner).toBe("p1");
    expect(result.path).toBeTruthy();
  });

  it.skipIf(!hasHarness)("returns payload for probe pass-through agent", () => {
    const runId = "run-read-004";
    ensureRunDirs(runId, "test-mission");
    writeArtifact(runId, 2, "probe", { findings: [{ summary: "ok" }] });
    const result = readArtifact(runId, 2, "probe");
    expect(result.ok).toBe(true);
    const payload = result.payload as Record<string, unknown>;
    expect(Array.isArray(payload?.findings)).toBe(true);
  });

  it.skipIf(!hasHarness)("reads sage-junior artifact with kind", () => {
    const runId = "run-read-005";
    ensureRunDirs(runId, "test-mission");
    // Write a minimal valid CitationBackedFinding via the write path
    writeArtifact(runId, 3, "forge-analyst", { summary: "analysis" });
    const result = readArtifact(runId, 3, "forge-analyst");
    expect(result.ok).toBe(true);
  });
});

// ── artifact_bridge.py subprocess tests ──────────────────────────────────────

describe("artifact_bridge.py (subprocess)", () => {
  const hasHarness = existsSync(join(HARNESS_DIR, "evor", "artifacts.py"));
  const bridgeScript = join(BRIDGE_DIR, "artifact_bridge.py");
  const pythonBin = process.env.EVOR_PYTHON ?? "python3";

  it.skipIf(!hasHarness)("--help exits 0", () => {
    const result = spawnSync(pythonBin, [bridgeScript, "--help"], {
      encoding: "utf8",
      env: pythonEnv(),
    });
    expect(result.status).toBe(0);
  });

  it.skipIf(!hasHarness)("unknown agent produces {error} exit 1", () => {
    const tmpFile = join(tmpRoot, "payload.json");
    writeFileSync(tmpFile, JSON.stringify({ x: 1 }), "utf8");
    const result = spawnSync(
      pythonBin,
      [bridgeScript,
        "--run-dir", tmpRoot,
        "--tick", "1",
        "--agent", "nonexistent-agent",
        "--payload-file", tmpFile,
      ],
      { encoding: "utf8", env: pythonEnv() },
    );
    expect(result.status).toBe(1);
    const data = JSON.parse(result.stdout);
    expect(data.error).toBeTruthy();
  });

  it.skipIf(!hasHarness)("missing payload file produces {error} exit 1", () => {
    const result = spawnSync(
      pythonBin,
      [bridgeScript,
        "--run-dir", tmpRoot,
        "--tick", "1",
        "--agent", "selector",
        "--payload-file", "/nonexistent/payload.json",
      ],
      { encoding: "utf8", env: pythonEnv() },
    );
    expect(result.status).toBe(1);
    const data = JSON.parse(result.stdout);
    expect(data.error).toBeTruthy();
  });

  it.skipIf(!hasHarness)("selector artifact roundtrip succeeds", () => {
    const tmpFile = join(tmpRoot, "payload.json");
    writeFileSync(tmpFile, JSON.stringify(minimalSelectorVerdict()), "utf8");
    const runDir = join(tmpRoot, "runs", "run-bridge-art-001");
    mkdirSync(runDir, { recursive: true });

    const result = spawnSync(
      pythonBin,
      [bridgeScript,
        "--run-dir", runDir,
        "--tick", "2",
        "--agent", "selector",
        "--payload-file", tmpFile,
      ],
      { encoding: "utf8", env: pythonEnv() },
    );
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.ok).toBe(true);
    expect(existsSync(join(runDir, "ticks", "2", "selector", "verdict.json"))).toBe(true);
  });
});
