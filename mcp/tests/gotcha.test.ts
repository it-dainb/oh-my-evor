/**
 * tests/gotcha.test.ts
 * Tests for tools/gotcha.ts: gotchaQuery, gotchaAdd, storeBlob.
 *
 * Bridge calls (Python) require the harness; tests that call Python are
 * integration tests and depend on a working harness install.
 * Pure-TS error paths are tested without Python.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

import { gotchaQuery, gotchaAdd, storeBlob } from "../src/tools/gotcha.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";

const HARNESS_DIR = resolve(process.cwd(), "../harness");
const BRIDGE_DIR = resolve(process.cwd(), "bridge");

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-gotcha-test-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
  process.env.EVOR_BRIDGE_DIR = BRIDGE_DIR;
  // Inject harness onto PYTHONPATH for bridge calls.
  const existing = process.env.PYTHONPATH;
  process.env.PYTHONPATH = existing ? `${HARNESS_DIR}:${existing}` : HARNESS_DIR;
});

afterEach(() => {
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  delete process.env.EVOR_BRIDGE_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── gotchaQuery ───────────────────────────────────────────────────────────────

describe("gotchaQuery", () => {
  it("returns empty list when no gotchas exist", () => {
    const result = gotchaQuery({ evorRoot: tmpRoot });
    expect(result.ok).toBe(true);
    expect(result.gotchas).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("returns empty list when filtered by kind with no matching entries", () => {
    const result = gotchaQuery({
      evorRoot: tmpRoot,
      kind: "hardware-constraint",
    });
    expect(result.ok).toBe(true);
    expect(result.total).toBe(0);
  });
});

describe("gotchaAdd + gotchaQuery round-trip", () => {
  it("adds a global gotcha and queries it back", () => {
    const runId = "run-ga-001";
    ensureRunDirs(runId);

    const addResult = gotchaAdd({
      runId,
      kind: "runtime-failure",
      signature: "cuda-oom-bs512",
      context: { batch_size: 512, gpu: "A100" },
      resolution: "Reduce batch size to 256",
      avoidance: "Never set batch_size > 256 on A100 with fp32",
      scope: "global",
      confidence: 0.8,
      evorRoot: tmpRoot,
    });

    expect(addResult.ok).toBe(true);
    const g = addResult.gotcha as Record<string, unknown>;
    expect(g.kind).toBe("runtime-failure");
    expect(g.signature).toBe("cuda-oom-bs512");
    expect(g.confidence).toBe(0.8);
    expect(g.occurrences).toBe(1);

    // Query it back.
    const queryResult = gotchaQuery({ evorRoot: tmpRoot });
    expect(queryResult.ok).toBe(true);
    expect(queryResult.total).toBeGreaterThan(0);
    const found = (queryResult.gotchas as Record<string, unknown>[]).find(
      (g) => g.signature === "cuda-oom-bs512",
    );
    expect(found).toBeTruthy();
    expect(found?.kind).toBe("runtime-failure");
  });

  it("deduplicates a repeated add (occurrences increments, confidence rises)", () => {
    const runId = "run-ga-002";
    ensureRunDirs(runId);

    const params = {
      runId,
      kind: "hardware-constraint" as const,
      signature: "vram-limit-8gb",
      context: { vram_gb: 8 },
      resolution: "Use gradient checkpointing",
      avoidance: "Check vram before setting model size",
      scope: "global",
      confidence: 0.5,
      evorRoot: tmpRoot,
    };

    gotchaAdd(params);
    const second = gotchaAdd(params);

    expect(second.ok).toBe(true);
    const g = second.gotcha as Record<string, unknown>;
    expect(g.occurrences).toBe(2);
    expect(g.confidence as number).toBeGreaterThan(0.5);
  });

  it("filters by kind correctly", () => {
    const runId = "run-ga-003";
    ensureRunDirs(runId);

    gotchaAdd({
      runId,
      kind: "runtime-failure",
      signature: "nan-loss-sig",
      context: {},
      resolution: "Use gradient clipping",
      avoidance: "Always clip gradients",
      scope: "global",
      confidence: 0.6,
      evorRoot: tmpRoot,
    });

    gotchaAdd({
      runId,
      kind: "approach-deadend",
      signature: "attention-only-deadend",
      context: {},
      resolution: "Add conv layers",
      avoidance: "Pure attention doesn't generalise on small datasets",
      scope: "global",
      confidence: 0.7,
      evorRoot: tmpRoot,
    });

    const rtOnly = gotchaQuery({ evorRoot: tmpRoot, kind: "runtime-failure" });
    expect(rtOnly.ok).toBe(true);
    expect(rtOnly.total).toBe(1);
    expect((rtOnly.gotchas as Record<string, unknown>[])[0].kind).toBe("runtime-failure");
  });
});

// ── storeBlob ────���─────────────────────────────���──────────────────────────────

describe("storeBlob", () => {
  it("stores text content and returns a sha256 content_ref", () => {
    const runId = "run-sb-001";
    ensureRunDirs(runId);

    const result = storeBlob({
      runId,
      content: "genome_config:\n  layers: 4\n  hidden: 256\n",
    });

    expect(result.ok).toBe(true);
    expect(result.content_ref).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the same content twice and returns the same content_ref (dedup)", () => {
    const runId = "run-sb-002";
    ensureRunDirs(runId);

    const content = "deterministic blob content for dedup test";
    const r1 = storeBlob({ runId, content });
    const r2 = storeBlob({ runId, content });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.content_ref).toBe(r2.content_ref);
  });

  it("stores a file by path", () => {
    const runId = "run-sb-003";
    ensureRunDirs(runId);

    // Write a temp file outside run dir.
    const srcPath = join(tmpRoot, "test-genome.yaml");
    writeFileSync(srcPath, "genome:\n  lr: 0.001\n", "utf8");

    const result = storeBlob({ runId, path: srcPath });
    expect(result.ok).toBe(true);
    expect(result.content_ref).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns error when neither path nor content is provided", () => {
    const runId = "run-sb-004";
    ensureRunDirs(runId);

    const result = storeBlob({ runId });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("returns error when path does not exist", () => {
    const runId = "run-sb-005";
    ensureRunDirs(runId);

    const result = storeBlob({ runId, path: "/tmp/nonexistent-evor-test-file-xyz.yaml" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("stores a blob and registers it under an acquisition_id", () => {
    const runId = "run-sb-006";
    ensureRunDirs(runId);

    const result = storeBlob({
      runId,
      content: "sample data row 1\nsample data row 2\n",
      acquisitionId: "acq-hf-dataset-001",
    });

    expect(result.ok).toBe(true);
    expect(result.content_ref).toBeTruthy();
  });
});
