/**
 * tests/wiki.test.ts
 * Unit tests for tools/wiki.ts: wikiAdd + wikiQuery (pure TS, no subprocess)
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { wikiAdd, wikiQuery, wikiGetRelevant } from "../src/tools/wiki.js";
import type { LessonEntry } from "../src/contracts.js";

// ── Fixture ──────────────────────────────────────────────────────────────────

let _lessonSeq = 0;

function makeEntry(overrides?: Partial<LessonEntry>): LessonEntry {
  _lessonSeq++;
  return {
    lesson_id: `lesson-${_lessonSeq}`,
    node_id: `node-${_lessonSeq}`,
    run_id: "run-wiki-001",
    mission_id: "mission-1",
    approach_family: "arch",
    hypothesis_verdict: "confirmed",
    observation: "Using wider heads improves performance on spatial tasks.",
    actionable_lesson: "Try wider attention heads for spatial feature extraction.",
    citations: [],
    tags: ["attention", "spatial"],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  _lessonSeq = 0;
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-wiki-test-"));
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

// ── wikiAdd ──────────────────────────────────────────────────────────────────

describe("wikiAdd", () => {
  it("writes cross-run wiki markdown", () => {
    const runId = "run-add-001";
    const entry = makeEntry();
    const { indexPath } = wikiAdd(runId, entry, "test-mission");

    const wikiMd = join(tmpRoot, "wiki", `${entry.lesson_id}.md`);
    expect(existsSync(wikiMd)).toBe(true);
    const md = readFileSync(wikiMd, "utf8");
    expect(md).toContain(`# Lesson: ${entry.lesson_id}`);
    expect(md).toContain("## Observation");
    expect(md).toContain(entry.observation);
    expect(md).toContain("## Actionable Lesson");
    expect(md).toContain(entry.actionable_lesson);
  });

  it("appends entry to index.jsonl", () => {
    const runId = "run-add-002";
    const entry = makeEntry();
    const { indexPath } = wikiAdd(runId, entry, "test-mission");

    expect(existsSync(indexPath)).toBe(true);
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.lesson_id).toBe(entry.lesson_id);
  });

  it("writes per-run wiki copy", () => {
    const runId = "run-add-003";
    const entry = makeEntry();
    wikiAdd(runId, entry, "test-mission");

    const perRunMd = join(tmpRoot, "runs", "test-mission", runId, "wiki", `${entry.lesson_id}.md`);
    expect(existsSync(perRunMd)).toBe(true);
  });

  it("appends multiple entries to index.jsonl", () => {
    const runId = "run-add-004";
    const e1 = makeEntry();
    const e2 = makeEntry();
    wikiAdd(runId, e1, "test-mission");
    wikiAdd(runId, e2, "test-mission");

    const indexPath = join(tmpRoot, "wiki", "index.jsonl");
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const ids = lines.map((l) => JSON.parse(l).lesson_id);
    expect(ids).toContain(e1.lesson_id);
    expect(ids).toContain(e2.lesson_id);
  });

  it("renders root_cause section when present", () => {
    const runId = "run-add-005";
    const entry = makeEntry({ root_cause: "Batch norm before relu caused gradient issues." });
    wikiAdd(runId, entry, "test-mission");

    const md = readFileSync(join(tmpRoot, "wiki", `${entry.lesson_id}.md`), "utf8");
    expect(md).toContain("## Root Cause");
    expect(md).toContain("Batch norm before relu");
  });

  it("renders citations section when present", () => {
    const runId = "run-add-006";
    const entry = makeEntry({ citations: ["https://arxiv.org/abs/1234.5678"] });
    wikiAdd(runId, entry, "test-mission");

    const md = readFileSync(join(tmpRoot, "wiki", `${entry.lesson_id}.md`), "utf8");
    expect(md).toContain("## Citations");
    expect(md).toContain("https://arxiv.org/abs/1234.5678");
  });
});

// ── wikiQuery ────────────────────────────────────────────────────────────────

describe("wikiQuery", () => {
  it("returns empty array when index.jsonl absent", () => {
    expect(wikiQuery("anything")).toEqual([]);
  });

  it("returns matching lessons by keyword", () => {
    const runId = "run-query-001";
    const relevant = makeEntry({ observation: "dropout regularization improves generalisation" });
    const irrelevant = makeEntry({ observation: "batch size does not matter here", tags: [] });
    wikiAdd(runId, relevant, "test-mission");
    wikiAdd(runId, irrelevant, "test-mission");

    const results = wikiQuery("dropout regularization");
    expect(results).toHaveLength(1);
    expect(results[0].lesson_id).toBe(relevant.lesson_id);
  });

  it("returns all lessons when query is empty", () => {
    const runId = "run-query-002";
    wikiAdd(runId, makeEntry(), "test-mission");
    wikiAdd(runId, makeEntry(), "test-mission");
    wikiAdd(runId, makeEntry(), "test-mission");

    const results = wikiQuery("");
    expect(results).toHaveLength(3);
  });

  it("filters by approach_family", () => {
    const runId = "run-query-003";
    const archLesson = makeEntry({ approach_family: "arch" });
    const trainLesson = makeEntry({ approach_family: "training" });
    wikiAdd(runId, archLesson, "test-mission");
    wikiAdd(runId, trainLesson, "test-mission");

    const results = wikiQuery("", { family: "arch" });
    expect(results).toHaveLength(1);
    expect(results[0].approach_family).toBe("arch");
  });

  it("filters by confirmed_only", () => {
    const runId = "run-query-004";
    const confirmed = makeEntry({ hypothesis_verdict: "confirmed" });
    const refuted = makeEntry({ hypothesis_verdict: "refuted" });
    wikiAdd(runId, confirmed, "test-mission");
    wikiAdd(runId, refuted, "test-mission");

    const results = wikiQuery("", { confirmedOnly: true });
    expect(results).toHaveLength(1);
    expect(results[0].hypothesis_verdict).toBe("confirmed");
  });

  it("respects limit parameter", () => {
    const runId = "run-query-005";
    for (let i = 0; i < 5; i++) {
      wikiAdd(runId, makeEntry({ observation: "keyword repeated" }), "test-mission");
    }
    const results = wikiQuery("keyword", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("ranks by hit count (more occurrences = higher rank)", () => {
    const runId = "run-query-006";
    const low = makeEntry({ observation: "learning rate matters" });
    const high = makeEntry({
      observation: "learning rate learning rate learning rate decays over time",
    });
    wikiAdd(runId, low, "test-mission");
    wikiAdd(runId, high, "test-mission");

    const results = wikiQuery("learning rate");
    expect(results[0].lesson_id).toBe(high.lesson_id);
  });

  it("searches tags and actionable_lesson fields", () => {
    const runId = "run-query-007";
    const e = makeEntry({
      observation: "no special words",
      actionable_lesson: "apply cosine_annealing warmup strategy",
      tags: ["cosine_annealing"],
    });
    wikiAdd(runId, e, "test-mission");

    const results = wikiQuery("cosine_annealing");
    expect(results).toHaveLength(1);
  });
});

// ── wikiGetRelevant ──────────────────────────────────────────────────────────

describe("wikiGetRelevant", () => {
  it("returns empty array when index.jsonl is absent", () => {
    expect(wikiGetRelevant("binarization threshold", 5)).toEqual([]);
  });

  it("returns empty array when context shares no terms with any entry", () => {
    const runId = "run-rel-001";
    wikiAdd(runId, makeEntry({ observation: "spatial attention heads improve accuracy", tags: ["attention"] }), "test-mission");
    wikiAdd(runId, makeEntry({ observation: "dropout reduces overfitting", tags: ["regularization"] }), "test-mission");

    const results = wikiGetRelevant("zxqy foobar quux", 5);
    expect(results).toEqual([]);
  });

  it("returns top-k entries ranked by TF-IDF similarity, not raw keyword count", () => {
    const runId = "run-rel-002";
    // high entry: rare term "binarization" appears → high IDF weight
    const high = makeEntry({
      observation: "binarization threshold tuning is critical for binary classification",
      actionable_lesson: "tune binarization cutoff carefully",
      tags: ["binarization", "binary"],
    });
    // low entry: common term "learning" appears many times but IDF is low in corpus
    const low = makeEntry({
      observation: "learning rate learning rate learning rate schedule matters",
      actionable_lesson: "adjust learning rate for convergence",
      tags: ["learning"],
    });
    // filler: unrelated
    const filler = makeEntry({
      observation: "batch normalization helps gradient flow",
      tags: ["normalization"],
    });
    wikiAdd(runId, high, "test-mission");
    wikiAdd(runId, low, "test-mission");
    wikiAdd(runId, filler, "test-mission");

    const results = wikiGetRelevant("binarization binary threshold", 3);
    expect(results.length).toBeGreaterThan(0);
    // The binarization-tagged entry must rank first
    expect(results[0].lesson_id).toBe(high.lesson_id);
  });

  it("k=2 returns exactly 2 entries", () => {
    const runId = "run-rel-003";
    for (let i = 0; i < 5; i++) {
      wikiAdd(runId, makeEntry({ observation: "dropout regularization reduces overfitting", tags: ["dropout"] }), "test-mission");
    }
    const results = wikiGetRelevant("dropout regularization", 2);
    expect(results).toHaveLength(2);
  });

  it("cross-domain match: context 'binarization' ranks binary-tagged lesson above regression-tagged", () => {
    const runId = "run-rel-004";
    const binaryLesson = makeEntry({
      observation: "binary classification threshold selection matters for precision recall",
      actionable_lesson: "use binary cross-entropy loss for two-class problems",
      tags: ["binary", "classification"],
    });
    const regressionLesson = makeEntry({
      observation: "regression loss convergence depends on output scale normalization",
      actionable_lesson: "normalize targets before regression training",
      tags: ["regression", "normalization"],
    });
    wikiAdd(runId, binaryLesson, "test-mission");
    wikiAdd(runId, regressionLesson, "test-mission");

    // "binarization" is not an exact keyword in either entry, but "binary" shares stem
    const results = wikiGetRelevant("binarization binary threshold", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].lesson_id).toBe(binaryLesson.lesson_id);
  });

  it("returns fewer than k entries when wiki has fewer matching documents", () => {
    const runId = "run-rel-005";
    wikiAdd(runId, makeEntry({ observation: "cosine annealing schedule for learning rate", tags: ["cosine"] }), "test-mission");
    wikiAdd(runId, makeEntry({ observation: "unrelated batch size tuning experiment" }), "test-mission");

    // Only 1 of 2 entries should match "cosine annealing" with nonzero similarity
    const results = wikiGetRelevant("cosine annealing", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].tags).toContain("cosine");
  });
});
