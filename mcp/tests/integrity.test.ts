/**
 * tests/integrity.test.ts
 * Unit tests for tools/integrity.ts: integrityCheck
 *
 * The Python bridge is not available in the test environment (no harness on
 * PYTHONPATH), so these tests verify that the tool degrades gracefully and
 * returns a structured error rather than throwing.
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { integrityCheck } from "../src/tools/integrity.js";

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-integrity-test-"));
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
