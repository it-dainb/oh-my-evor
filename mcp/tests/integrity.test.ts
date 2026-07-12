/**
 * tests/integrity.test.ts
 * Unit tests for tools/integrity.ts: integrityCheck
 *
 * The Python bridge is not available in the test environment (no harness on
 * PYTHONPATH), so these tests verify that the tool degrades gracefully and
 * returns a structured error rather than throwing.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { integrityCheck, resolveIntegrityPaths, frozenSplitHashCache, getCachedSplitHash } from "../src/tools/integrity.js";

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-integrity-test-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
  frozenSplitHashCache.clear();
});

afterEach(() => {
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  frozenSplitHashCache.clear();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("integrityCheck", () => {
  it("returns ok:false when bridge subprocess is unavailable", () => {
    const result = integrityCheck("run-int-001", randomUUID(), "test-mission");
    // Python harness not on path in test env → bridge fails → structured error
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("does not throw even when run directory is missing", () => {
    expect(() => {
      integrityCheck("run-int-002", randomUUID(), "test-mission");
    }).not.toThrow();
  });

  it("returns error field as a string", () => {
    const result = integrityCheck("run-int-003", randomUUID(), "test-mission");
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
    }
  });

  it("passes run_dir to the bridge so no file-system scanning needed", () => {
    // Even with a non-existent run, the call must complete synchronously
    const start = Date.now();
    integrityCheck("run-int-004", randomUUID(), "test-mission");
    const elapsed = Date.now() - start;
    // Must complete in < 10 s (bridge times out or fails fast)
    expect(elapsed).toBeLessThan(10_000);
  });
});

// ── P1-11: resolveIntegrityPaths ────────────────────────────────────────────

describe("resolveIntegrityPaths (P1-11)", () => {
  it("derives eval_script from runDir + eval_version", () => {
    const paths = resolveIntegrityPaths("/runs/r1", { eval_version: "v1" } as never);
    expect(paths.evalScript).toBe("/runs/r1/eval-suites/v1.py");
  });

  it("uses eval_version when deriving frozen-split path", () => {
    const paths = resolveIntegrityPaths("/runs/r1", { eval_version: "v2" } as never);
    expect(paths.splitPath).toBe("/runs/r1/frozen-splits/v2.json");
  });

  it("is a pure function — same inputs produce same outputs", () => {
    const a = resolveIntegrityPaths("/a", { eval_version: "v3" } as never);
    const b = resolveIntegrityPaths("/a", { eval_version: "v3" } as never);
    expect(a).toEqual(b);
  });

  it("handles arbitrary eval_version strings", () => {
    const paths = resolveIntegrityPaths("/base", { eval_version: "v99-alpha" } as never);
    expect(paths.evalScript).toBe("/base/eval-suites/v99-alpha.py");
    expect(paths.splitPath).toBe("/base/frozen-splits/v99-alpha.json");
  });
});

// ── P2-2: frozenSplitHashCache ──────────────────────────────────────────────

describe("getCachedSplitHash / frozenSplitHashCache (P2-2)", () => {
  it("returns undefined when goal-contract.json does not exist", () => {
    const hash = getCachedSplitHash("run-no-contract", tmpRoot);
    expect(hash).toBeUndefined();
  });

  it("reads and caches locked_split_hash from goal-contract.json on first call", () => {
    const runDir = join(tmpRoot, "runs", "test-mission", "run-hash-001");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "goal-contract.json"),
      JSON.stringify({ locked_split_hash: "abc123deadbeef" })
    );
    const hash = getCachedSplitHash("run-hash-001", runDir);
    expect(hash).toBe("abc123deadbeef");
    expect(frozenSplitHashCache.get("run-hash-001")).toBe("abc123deadbeef");
  });

  it("returns cached value without reading goal-contract.json on second call", () => {
    // Pre-populate cache — no goal-contract.json in tmpRoot
    frozenSplitHashCache.set("run-cached-only", "pre-cached-hash");
    const hash = getCachedSplitHash("run-cached-only", tmpRoot);
    expect(hash).toBe("pre-cached-hash");
  });

  it("cache is isolated between tests (cleared in beforeEach/afterEach)", () => {
    // This test assumes the cache was cleared in beforeEach
    expect(frozenSplitHashCache.has("run-hash-001")).toBe(false);
  });
});
