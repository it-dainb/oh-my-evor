/**
 * tests/signals.test.ts
 * Unit tests for tools/signals.ts: emitSignal + querySignals
 *
 * Isolated via EVOR_ROOT pointing to a per-test tmpdir.
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { emitSignal, querySignals } from "../src/tools/signals.js";

// ── Test lifecycle ───────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-signals-test-"));
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

// ── emit-new ─────────────────────────────────────────────────────────────────

describe("emitSignal — new signal", () => {
  it("creates a new signal with correct defaults", () => {
    const signal = emitSignal("run-001", {
      kind: "cuda-oom",
      signature: "cuda-oom-bs256",
      shapes: ["failure"],
      axes: ["memory"],
      severity: "high",
      evidence: { batch_size: 256 },
      source: "evor-forge-analyst",
    }, "test-mission");

    expect(signal.signal_id).toMatch(/^sig-[0-9a-f]{12}$/);
    expect(signal.kind).toBe("cuda-oom");
    expect(signal.signature).toBe("cuda-oom-bs256");
    expect(signal.shapes).toEqual(["failure"]);
    expect(signal.axes).toEqual(["memory"]);
    expect(signal.severity).toBe("high");
    expect(signal.confidence).toBe(0.5);
    expect(signal.occurrences).toBe(1);
    expect(signal.first_seen).toBe(signal.last_seen);
    expect(signal.evidence).toEqual({ batch_size: 256 });
  });

  it("derives signal_id as sha256(kind:signature).slice(0,12) prefixed sig-", () => {
    const s1 = emitSignal("run-id-sha", {
      kind: "myKind",
      signature: "mySig",
      shapes: ["trend"],
      axes: ["compute"],
      severity: "low",
      evidence: {},
      source: "test",
    }, "test-mission");
    // same kind+signature on a fresh run should produce the same id
    process.env.EVOR_ROOT = mkdtempSync(join(tmpdir(), "evor-signals-sha-"));
    const s2 = emitSignal("run-id-sha", {
      kind: "myKind",
      signature: "mySig",
      shapes: ["trend"],
      axes: ["compute"],
      severity: "low",
      evidence: {},
      source: "test",
    }, "test-mission");
    rmSync(process.env.EVOR_ROOT, { recursive: true, force: true });
    process.env.EVOR_ROOT = tmpRoot;

    expect(s1.signal_id).toBe(s2.signal_id);
  });
});

// ── emit-dedup-aggregates ────────────────────────────────────────────────────

describe("emitSignal — dedup aggregation", () => {
  it("occurrences increments to 2 on second emit with same signature", () => {
    const runId = "run-dedup-001";
    emitSignal(runId, {
      kind: "training-slow",
      signature: "slow-train-cand-A",
      shapes: ["limit"],
      axes: ["compute"],
      severity: "low",
      evidence: { throughput: 100 },
      source: "probe",
    }, "test-mission");
    const second = emitSignal(runId, {
      kind: "training-slow",
      signature: "slow-train-cand-A",
      shapes: ["limit"],
      axes: ["compute"],
      severity: "low",
      evidence: { throughput: 80 },
      source: "probe",
    }, "test-mission");

    expect(second.occurrences).toBe(2);
  });

  it("severity escalates to MAX of old and new", () => {
    const runId = "run-dedup-002";
    emitSignal(runId, {
      kind: "accuracy-drop",
      signature: "acc-drop-v1",
      shapes: ["failure"],
      axes: ["accuracy"],
      severity: "low",
      evidence: {},
      source: "evor",
    }, "test-mission");
    const escalated = emitSignal(runId, {
      kind: "accuracy-drop",
      signature: "acc-drop-v1",
      shapes: ["failure"],
      axes: ["accuracy"],
      severity: "high",
      evidence: {},
      source: "evor",
    }, "test-mission");

    expect(escalated.severity).toBe("high");

    // Severity must not de-escalate on subsequent low-severity emit
    const third = emitSignal(runId, {
      kind: "accuracy-drop",
      signature: "acc-drop-v1",
      shapes: ["failure"],
      axes: ["accuracy"],
      severity: "low",
      evidence: {},
      source: "evor",
    }, "test-mission");
    expect(third.severity).toBe("high");
  });

  it("confidence rises toward 1.0 by (1-confidence)*0.4 on each dedup", () => {
    const runId = "run-dedup-003";
    emitSignal(runId, {
      kind: "mem-pressure",
      signature: "mem-pressure-v1",
      shapes: ["limit"],
      axes: ["memory"],
      severity: "medium",
      evidence: {},
      source: "monitor",
    }, "test-mission");
    const second = emitSignal(runId, {
      kind: "mem-pressure",
      signature: "mem-pressure-v1",
      shapes: ["limit"],
      axes: ["memory"],
      severity: "medium",
      evidence: {},
      source: "monitor",
    }, "test-mission");

    // 0.5 + (1.0 - 0.5) * 0.4 = 0.5 + 0.2 = 0.7
    expect(second.confidence).toBeCloseTo(0.7, 4);
  });

  it("shapes and axes are unioned across emits", () => {
    const runId = "run-dedup-004";
    emitSignal(runId, {
      kind: "multi-facet",
      signature: "multi-v1",
      shapes: ["limit"],
      axes: ["memory"],
      severity: "low",
      evidence: {},
      source: "test",
    }, "test-mission");
    const merged = emitSignal(runId, {
      kind: "multi-facet",
      signature: "multi-v1",
      shapes: ["opportunity"],
      axes: ["compute"],
      severity: "low",
      evidence: {},
      source: "test",
    }, "test-mission");

    expect(merged.shapes).toContain("limit");
    expect(merged.shapes).toContain("opportunity");
    expect(merged.axes).toContain("memory");
    expect(merged.axes).toContain("compute");
  });

  it("evidence is merged (incoming keys win on collision)", () => {
    const runId = "run-dedup-005";
    emitSignal(runId, {
      kind: "ev-merge",
      signature: "ev-merge-v1",
      shapes: ["trend"],
      axes: ["data"],
      severity: "low",
      evidence: { a: 1, b: 2 },
      source: "test",
    }, "test-mission");
    const merged = emitSignal(runId, {
      kind: "ev-merge",
      signature: "ev-merge-v1",
      shapes: ["trend"],
      axes: ["data"],
      severity: "low",
      evidence: { b: 99, c: 3 },
      source: "test",
    }, "test-mission");

    expect(merged.evidence).toMatchObject({ a: 1, b: 99, c: 3 });
  });

  it("first_seen is preserved from original; last_seen is updated", async () => {
    const runId = "run-dedup-006";
    const first = emitSignal(runId, {
      kind: "time-check",
      signature: "time-v1",
      shapes: ["trend"],
      axes: ["stability"],
      severity: "low",
      evidence: {},
      source: "test",
    }, "test-mission");
    // Small delay to ensure last_seen changes
    await new Promise((r) => setTimeout(r, 10));
    const second = emitSignal(runId, {
      kind: "time-check",
      signature: "time-v1",
      shapes: ["trend"],
      axes: ["stability"],
      severity: "low",
      evidence: {},
      source: "test",
    }, "test-mission");

    expect(second.first_seen).toBe(first.first_seen);
    expect(second.last_seen >= first.last_seen).toBe(true);
  });
});

// ── query-by-facet ────────────────────────────────────────────────────────────

describe("querySignals — facet filtering", () => {
  const runId = "run-query-001";

  beforeEach(() => {
    // Emit three signals with distinct facets
    emitSignal(runId, {
      kind: "oom",
      signature: "sig-oom",
      shapes: ["failure"],
      axes: ["memory"],
      severity: "high",
      evidence: {},
      source: "test",
    }, "test-mission");
    emitSignal(runId, {
      kind: "slow-train",
      signature: "sig-slow",
      shapes: ["limit"],
      axes: ["compute"],
      severity: "medium",
      evidence: {},
      source: "test",
    }, "test-mission");
    emitSignal(runId, {
      kind: "data-gap",
      signature: "sig-data",
      shapes: ["opportunity"],
      axes: ["data", "generalization"],
      severity: "low",
      evidence: {},
      source: "test",
    }, "test-mission");
  });

  it("no filters returns all signals sorted by (severity, confidence, last_seen) desc", () => {
    const results = querySignals(runId, {}, "test-mission");
    expect(results).toHaveLength(3);
    // high > medium > low
    expect(results[0].severity).toBe("high");
    expect(results[1].severity).toBe("medium");
    expect(results[2].severity).toBe("low");
  });

  it("shape filter is ANY-overlap — matches signals sharing >=1 shape", () => {
    const results = querySignals(runId, { shapes: ["failure", "opportunity"] }, "test-mission");
    expect(results).toHaveLength(2);
    const sigs = results.map((r) => r.signature);
    expect(sigs).toContain("sig-oom");
    expect(sigs).toContain("sig-data");
    expect(sigs).not.toContain("sig-slow");
  });

  it("axis filter is ANY-overlap — matches signals sharing >=1 axis", () => {
    const results = querySignals(runId, { axes: ["generalization"] }, "test-mission");
    expect(results).toHaveLength(1);
    expect(results[0].signature).toBe("sig-data");
  });

  it("kind exact filter narrows to matching kind only", () => {
    const results = querySignals(runId, { kind: "slow-train" }, "test-mission");
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe("slow-train");
  });

  it("combined shapes+axes filter requires both ANY-overlaps (AND logic)", () => {
    // Only sig-data has shape=opportunity AND axis=generalization
    const results = querySignals(runId, {
      shapes: ["opportunity"],
      axes: ["generalization"],
    }, "test-mission");
    expect(results).toHaveLength(1);
    expect(results[0].signature).toBe("sig-data");
  });

  it("returns empty list when nothing matches", () => {
    const results = querySignals(runId, { kind: "nonexistent" }, "test-mission");
    expect(results).toHaveLength(0);
  });
});

// ── severity-floor ────────────────────────────────────────────────────────────

describe("querySignals — severity floor", () => {
  const runId = "run-sev-001";

  beforeEach(() => {
    emitSignal(runId, {
      kind: "low-sig",
      signature: "sev-low",
      shapes: ["trend"],
      axes: ["cost"],
      severity: "low",
      evidence: {},
      source: "test",
    }, "test-mission");
    emitSignal(runId, {
      kind: "medium-sig",
      signature: "sev-medium",
      shapes: ["limit"],
      axes: ["compute"],
      severity: "medium",
      evidence: {},
      source: "test",
    }, "test-mission");
    emitSignal(runId, {
      kind: "critical-sig",
      signature: "sev-critical",
      shapes: ["failure"],
      axes: ["stability"],
      severity: "critical",
      evidence: {},
      source: "test",
    }, "test-mission");
  });

  it("min_severity=low returns all three signals", () => {
    const results = querySignals(runId, { min_severity: "low" }, "test-mission");
    expect(results).toHaveLength(3);
  });

  it("min_severity=medium excludes low", () => {
    const results = querySignals(runId, { min_severity: "medium" }, "test-mission");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.severity)).not.toContain("low");
  });

  it("min_severity=high excludes low and medium", () => {
    const results = querySignals(runId, { min_severity: "high" }, "test-mission");
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("critical");
  });

  it("min_severity=critical returns only critical", () => {
    const results = querySignals(runId, { min_severity: "critical" }, "test-mission");
    expect(results).toHaveLength(1);
    expect(results[0].signature).toBe("sev-critical");
  });

  it("default min_severity is low (returns all)", () => {
    const results = querySignals(runId, {}, "test-mission");
    expect(results).toHaveLength(3);
  });
});

// ── since_tick filter ────────────────────────────────────────────────────────

describe("querySignals — since_tick filter", () => {
  it("excludes signals with no tick when since_tick is set", () => {
    const runId = "run-tick-001";
    emitSignal(runId, {
      kind: "tickless",
      signature: "no-tick",
      shapes: ["trend"],
      axes: ["compute"],
      severity: "medium",
      evidence: {},
      source: "test",
    }, "test-mission");
    emitSignal(runId, {
      kind: "ticked",
      signature: "with-tick",
      shapes: ["limit"],
      axes: ["memory"],
      severity: "medium",
      evidence: {},
      source: "test",
      tick: 5,
    }, "test-mission");

    const results = querySignals(runId, { since_tick: 3 }, "test-mission");
    expect(results).toHaveLength(1);
    expect(results[0].signature).toBe("with-tick");
  });

  it("excludes signals whose tick is below since_tick", () => {
    const runId = "run-tick-002";
    emitSignal(runId, {
      kind: "old",
      signature: "tick-old",
      shapes: ["trend"],
      axes: ["cost"],
      severity: "low",
      evidence: {},
      source: "test",
      tick: 2,
    }, "test-mission");
    emitSignal(runId, {
      kind: "recent",
      signature: "tick-recent",
      shapes: ["trend"],
      axes: ["cost"],
      severity: "low",
      evidence: {},
      source: "test",
      tick: 10,
    }, "test-mission");

    const results = querySignals(runId, { since_tick: 5 }, "test-mission");
    expect(results).toHaveLength(1);
    expect(results[0].signature).toBe("tick-recent");
  });
});

// ── P2-13: limit cap ─────────────────────────────────────────────────────────

describe("querySignals — limit cap (P2-13)", () => {
  it("caps results to limit param when fewer matches exist", () => {
    const runId = "run-limit-001";
    for (let i = 0; i < 5; i++) {
      emitSignal(runId, {
        kind: "test",
        signature: `sig-limit-${i}`,
        shapes: ["trend"],
        axes: ["compute"],
        severity: "medium",
        evidence: {},
        source: "test",
      }, "test-mission");
    }
    const results = querySignals(runId, { limit: 2 }, "test-mission");
    expect(results).toHaveLength(2);
  });

  it("returns highest-severity signals first within the limit", () => {
    const runId = "run-limit-002";
    emitSignal(runId, {
      kind: "a",
      signature: "sig-low",
      shapes: ["trend"],
      axes: ["compute"],
      severity: "low",
      evidence: {},
      source: "test",
    }, "test-mission");
    emitSignal(runId, {
      kind: "b",
      signature: "sig-high",
      shapes: ["failure"],
      axes: ["memory"],
      severity: "high",
      evidence: {},
      source: "test",
    }, "test-mission");
    const results = querySignals(runId, { limit: 1 }, "test-mission");
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("high");
  });

  it("returns all signals when limit exceeds count", () => {
    const runId = "run-limit-003";
    emitSignal(runId, {
      kind: "x",
      signature: "sig-only",
      shapes: ["trend"],
      axes: ["cost"],
      severity: "medium",
      evidence: {},
      source: "test",
    }, "test-mission");
    const results = querySignals(runId, { limit: 100 }, "test-mission");
    expect(results).toHaveLength(1);
  });

  it("default (no limit) returns all matching signals up to 100", () => {
    const runId = "run-limit-004";
    // Emit 3 signals — default cap of 100 should not truncate them
    for (let i = 0; i < 3; i++) {
      emitSignal(runId, {
        kind: "def",
        signature: `sig-def-${i}`,
        shapes: ["trend"],
        axes: ["cost"],
        severity: "low",
        evidence: {},
        source: "test",
      }, "test-mission");
    }
    const results = querySignals(runId, {}, "test-mission");
    expect(results).toHaveLength(3);
  });
});
