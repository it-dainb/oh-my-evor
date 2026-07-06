/**
 * tests/signals-race.test.ts
 *
 * Proves Bug D (HIGH): emitSignal has no verify-after-write step.
 *
 * emitSignal does a read-modify-write (loadSignals → modify → atomicWriteJsonl)
 * with no post-write verification.  Under concurrent MCP-server processes a
 * second writer can clobber the first writer's signals.jsonl between the
 * atomicWriteJsonl tmpfile write and the rename.  The first writer's signal
 * is silently lost — the function returns the Signal object as if it
 * succeeded, but the signal never appears in the file.
 *
 * This is the exact sibling-class bug to the original upsertNode clobber
 * (tree-store.ts) identified in the task brief.
 *
 * The test simulates the concurrent clobber by blocking signals.jsonl renames
 * via vi.mock('fs'), then asserts that emitSignal throws after MAX_ATTEMPTS
 * (the correct post-fix behaviour) rather than returning silently (bug).
 */

import { vi } from "vitest";

// ── vi.hoisted flag — must be in the same hoisting pass as vi.mock ────────────

const flags = vi.hoisted(() => ({
  blockSignalsRename: false,
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    renameSync: (src: string, dest: string) => {
      if (
        flags.blockSignalsRename &&
        typeof dest === "string" &&
        dest.endsWith("signals.jsonl")
      ) {
        // No-op: simulate a concurrent writer that keeps clobbering signals.jsonl.
        return;
      }
      actual.renameSync(src, dest);
    },
  };
});

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { emitSignal, querySignals } from "../src/tools/signals.js";

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-signals-race-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
});

afterEach(() => {
  flags.blockSignalsRename = false;
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Bug D — emitSignal: no verify step after atomicWriteJsonl
// ════════════════════════════════════════════════════════════════════════════

describe("Bug D: emitSignal has no verify-after-write (sibling of upsertNode clobber bug)", () => {
  it("throws after MAX_ATTEMPTS when all signals.jsonl renames are blocked", () => {
    // Arrange: block all signals.jsonl renames to simulate concurrent clobber.
    // Each atomicWriteJsonl call writes .tmp but never renames to signals.jsonl,
    // so a subsequent loadSignals (verify) finds no signal.
    const runId = "run-signals-race-001";
    flags.blockSignalsRename = true;

    // BUG (before fix): emitSignal returns a Signal object even though the
    //   signal was never persisted to disk (rename was blocked).  The caller
    //   believes the emit succeeded — silent data loss.
    // AFTER FIX: emitSignal retries up to MAX_ATTEMPTS and throws when the
    //   signal still cannot be verified in the file.
    expect(() =>
      emitSignal(runId, {
        kind: "cuda-oom",
        signature: "sig-race-001",
        shapes: ["failure"],
        axes: ["memory"],
        severity: "high",
        evidence: { batch_size: 512 },
        source: "evor-forge-analyst",
      }, "test-mission"),
    ).toThrow(/failed to persist.*after.*attempts/i);
  });

  it("signal is absent from signals.jsonl after all renames are blocked", () => {
    // Additional evidence: the file on disk does NOT contain our signal after
    // the (blocked) write, confirming the data loss path.
    const runId = "run-signals-race-002";
    flags.blockSignalsRename = true;

    try {
      emitSignal(runId, {
        kind: "training-slow",
        signature: "sig-race-002",
        shapes: ["limit"],
        axes: ["compute"],
        severity: "medium",
        evidence: {},
        source: "test",
      }, "test-mission");
    } catch {
      // expected after fix
    }

    const persisted = querySignals(runId, {});
    expect(persisted.find((s) => s.signature === "sig-race-002")).toBeUndefined();
  });

  it("normal (unblocked) emit still works after the fix (no regression)", () => {
    // Ensure the retry logic does not break the happy path.
    const runId = "run-signals-normal-001";

    const signal = emitSignal(runId, {
      kind: "mem-pressure",
      signature: "sig-normal-001",
      shapes: ["limit"],
      axes: ["memory"],
      severity: "medium",
      evidence: { usage_gb: 12 },
      source: "test",
    }, "test-mission");

    expect(signal.signal_id).toMatch(/^sig-[0-9a-f]{12}$/);
    expect(signal.occurrences).toBe(1);

    const persisted = querySignals(runId, {});
    expect(persisted).toHaveLength(1);
    expect(persisted[0].signature).toBe("sig-normal-001");
  });
});
