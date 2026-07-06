/**
 * tests/signals-inbox-drain.test.ts
 * Proves that querySignals drains signals-inbox.jsonl before returning results
 * (parity fix §15B: Python SignalBus.query() drains inbox; TS path previously did not).
 *
 * Uses pure-TS drain — no Python subprocess required.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { querySignals, emitSignal, digestSignals } from "../src/tools/signals.js";
import { resolveRunPaths } from "../src/run-store.js";

// ── Lifecycle ───────��────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-inbox-drain-test-"));
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

// ── Helpers ──────────────────────────────────��───────────────────────────────

/** Write a minimal inbox entry directly (simulates a hook capture). */
function writeInboxEntry(runDir: string, entry: Record<string, unknown>): void {
  const inboxPath = join(runDir, "signals-inbox.jsonl");
  writeFileSync(inboxPath, JSON.stringify(entry) + "\n", { flag: "a", encoding: "utf8" });
}

// ── Tests ────────────────────────────────────��────────────────────────────────

describe("querySignals — inbox drain parity (§15B fix)", () => {
  it("drains signals-inbox.jsonl so a hook-appended signal is visible to querySignals", () => {
    const runId = "run-inbox-drain-001";
    const paths = resolveRunPaths(runId, "test-mission");
    mkdirSync(paths.runDir, { recursive: true });

    // Simulate a hook writing to the inbox (the pre-tool-use.mjs path).
    writeInboxEntry(paths.runDir, {
      kind: "cuda-oom",
      signature: "inbox-drain-test-sig",
      shapes: ["failure"],
      axes: ["memory"],
      severity: "high",
      evidence: { batch_size: 256 },
      source: "hook:post-tool-use",
      created_at: new Date().toISOString(),
    });

    // At this point signals.jsonl does NOT exist — the signal only lives in the inbox.
    expect(existsSync(paths.signalsPath)).toBe(false);

    // querySignals should drain the inbox first, making the signal visible.
    const results = querySignals(runId, {});

    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("cuda-oom");
    expect(results[0].signature).toBe("inbox-drain-test-sig");
    expect(results[0].severity).toBe("high");
    expect(results[0].occurrences).toBe(1);
  });

  it("inbox file is removed after drain (idempotent — second query returns same signal from signals.jsonl)", () => {
    const runId = "run-inbox-drain-002";
    const paths = resolveRunPaths(runId, "test-mission");
    mkdirSync(paths.runDir, { recursive: true });

    writeInboxEntry(paths.runDir, {
      kind: "plateau",
      signature: "inbox-idempotent-sig",
      shapes: ["trend"],
      axes: ["accuracy"],
      severity: "medium",
      evidence: { epochs_without_gain: 5 },
      source: "hook:post-tool-use",
      created_at: new Date().toISOString(),
    });

    // First query drains inbox → signal appears in signals.jsonl.
    const first = querySignals(runId, {});
    expect(first.length).toBe(1);

    // Inbox file should be gone now.
    expect(existsSync(join(paths.runDir, "signals-inbox.jsonl"))).toBe(false);

    // Second query with empty inbox returns same result (from signals.jsonl).
    const second = querySignals(runId, {});
    expect(second.length).toBe(1);
    expect(second[0].signature).toBe("inbox-idempotent-sig");
    // Second query should NOT increment occurrences (inbox is already empty).
    expect(second[0].occurrences).toBe(1);
  });

  it("deduplicates inbox signals by signature against signals already in the bus", () => {
    const runId = "run-inbox-drain-003";
    const paths = resolveRunPaths(runId, "test-mission");
    mkdirSync(paths.runDir, { recursive: true });

    // Pre-emit a signal directly into the bus.
    emitSignal(runId, {
      kind: "overfit",
      signature: "dedup-test-sig",
      shapes: ["trend"],
      axes: ["accuracy"],
      severity: "medium",
      evidence: { val_loss: 0.8 },
      source: "probe",
    });

    // Now write the same signature to the inbox.
    writeInboxEntry(paths.runDir, {
      kind: "overfit",
      signature: "dedup-test-sig",
      shapes: ["trend"],
      axes: ["accuracy", "generalization"],
      severity: "high",   // escalates
      evidence: { val_loss: 0.9 },
      source: "hook:post-tool-use",
      created_at: new Date().toISOString(),
    });

    // Query drains inbox (aggregates with existing signal).
    const results = querySignals(runId, {});

    expect(results.length).toBe(1);
    expect(results[0].occurrences).toBe(2);
    // Severity should escalate to MAX (high > medium).
    expect(results[0].severity).toBe("high");
  });

  it("skips malformed inbox lines and still returns valid signals", () => {
    const runId = "run-inbox-drain-004";
    const paths = resolveRunPaths(runId, "test-mission");
    mkdirSync(paths.runDir, { recursive: true });

    const inboxPath = join(paths.runDir, "signals-inbox.jsonl");
    // Write one valid line and two malformed lines.
    writeFileSync(
      inboxPath,
      [
        "{ this is not valid json {{",
        JSON.stringify({
          kind: "lr-schedule-misconfigured",
          signature: "skip-malformed-sig",
          shapes: ["limit"],
          axes: ["stability"],
          severity: "medium",
          evidence: {},
          source: "hook",
          created_at: new Date().toISOString(),
        }),
        "",
        "another bad line",
      ].join("\n"),
      "utf8",
    );

    const results = querySignals(runId, {});
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("lr-schedule-misconfigured");
  });

  it("querySignals is a no-op when inbox does not exist (no error)", () => {
    const runId = "run-inbox-drain-005";
    // Don't create any files — querySignals should return [] without error.
    const results = querySignals(runId, {}, "test-mission");
    expect(results).toEqual([]);
  });
});

describe("digestSignals — drains inbox and returns compact top-slice", () => {
  it("returns only severity>=medium signals by default and caps at max_items", () => {
    const runId = "run-digest-001";
    const paths = resolveRunPaths(runId, "test-mission");
    mkdirSync(paths.runDir, { recursive: true });

    // Emit a low-severity signal (should be excluded from digest).
    emitSignal(runId, {
      kind: "minor-thing",
      signature: "digest-low-sig",
      shapes: ["limit"],
      axes: ["compute"],
      severity: "low",
      evidence: {},
      source: "test",
    });

    // Write a medium-severity signal to the inbox.
    writeInboxEntry(paths.runDir, {
      kind: "throughput-collapse",
      signature: "digest-medium-sig",
      shapes: ["trend"],
      axes: ["compute", "memory"],
      severity: "high",
      evidence: { throughput_drop_pct: 60 },
      source: "hook",
      created_at: new Date().toISOString(),
    });

    const digest = digestSignals(runId, {});

    // Only high/medium signals should appear (not low).
    expect(digest.every((d) => ["medium", "high", "critical"].includes(d.severity as string))).toBe(true);
    // The inbox-drained signal should be in the digest.
    expect(digest.some((d) => d.kind === "throughput-collapse")).toBe(true);
  });

  it("respects max_items cap", () => {
    const runId = "run-digest-002";
    const paths = resolveRunPaths(runId, "test-mission");
    mkdirSync(paths.runDir, { recursive: true });

    // Emit 5 distinct high-severity signals.
    for (let i = 0; i < 5; i++) {
      emitSignal(runId, {
        kind: "gradient-explosion",
        signature: `digest-cap-sig-${i}`,
        shapes: ["failure"],
        axes: ["stability"],
        severity: "high",
        evidence: { step: i },
        source: "probe",
      });
    }

    const digest = digestSignals(runId, { max_items: 3 });
    expect(digest.length).toBe(3);
  });

  it("digest entries have the compact shape (no signal_id, first_seen, last_seen)", () => {
    const runId = "run-digest-003";
    const paths = resolveRunPaths(runId, "test-mission");
    mkdirSync(paths.runDir, { recursive: true });

    emitSignal(runId, {
      kind: "budget-burn",
      signature: "digest-shape-sig",
      shapes: ["trend"],
      axes: ["cost"],
      severity: "high",
      evidence: { usd_spent: 12 },
      source: "orchestrator",
    });

    const digest = digestSignals(runId, { min_severity: "low" });
    expect(digest.length).toBe(1);

    const entry = digest[0];
    // Compact fields present.
    expect(entry).toHaveProperty("kind");
    expect(entry).toHaveProperty("shapes");
    expect(entry).toHaveProperty("axes");
    expect(entry).toHaveProperty("severity");
    expect(entry).toHaveProperty("occurrences");
    expect(entry).toHaveProperty("evidence");
    // Full signal fields stripped.
    expect(entry).not.toHaveProperty("signal_id");
    expect(entry).not.toHaveProperty("first_seen");
    expect(entry).not.toHaveProperty("last_seen");
    expect(entry).not.toHaveProperty("confidence");
  });
});
