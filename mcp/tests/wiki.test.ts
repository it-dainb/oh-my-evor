/**
 * tests/wiki.test.ts
 * Unit tests for tools/wiki.ts: wikiAdd + wikiQuery + wikiGetRelevant
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  wikiAdd,
  wikiQuery,
  wikiGetRelevant,
  _wikiCacheStats,
  _resetWikiCache,
} from "../src/tools/wiki.js";
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
  _resetWikiCache(); // clear IDF cache + stats before each test
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

// ── wikiAdd dedup / cap ───────────────────────────────────────────────────────

describe("wikiAdd dedup and corpus cap", () => {
  it("re-adding the same lesson_id replaces entry, does not append", () => {
    const runId = "run-dedup-001";
    const entry = makeEntry();
    wikiAdd(runId, entry, "test-mission");
    wikiAdd(runId, { ...entry, observation: "Updated observation after rerun." }, "test-mission");

    const indexPath = join(tmpRoot, "wiki", "index.jsonl");
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).observation).toBe("Updated observation after rerun.");
  });

  it("near-dup (same node+approach+obs prefix) replaces, does not append", () => {
    const runId = "run-neardup-001";
    // All entries share node_id, approach_family, and the same observation prefix
    const baseObs = "Binarization threshold tuning is critical for binary classification tasks here.";
    for (let i = 0; i < 4; i++) {
      const base = makeEntry({
        node_id: "same-node",
        approach_family: "arch",
        observation: baseObs,
      });
      wikiAdd(runId, { ...base, lesson_id: `neardup-${i}` }, "test-mission");
    }

    const indexPath = join(tmpRoot, "wiki", "index.jsonl");
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    // Only the most recent survives — each add replaced the previous
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).lesson_id).toBe("neardup-3");
  });

  it("distinct observations from same node+approach are NOT deduped (genuinely different lessons)", () => {
    const runId = "run-neardup-002";
    wikiAdd(runId, makeEntry({ node_id: "nodeA", approach_family: "arch", observation: "Wider heads help spatial tasks." }), "test-mission");
    wikiAdd(runId, makeEntry({ node_id: "nodeA", approach_family: "arch", observation: "Dropout after attention reduces overfitting." }), "test-mission");

    const indexPath = join(tmpRoot, "wiki", "index.jsonl");
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    // Different observation prefixes → two distinct entries preserved
    expect(lines).toHaveLength(2);
  });

  it("corpus stays bounded at EVOR_WIKI_MAX_ENTRIES cap", () => {
    const origMax = process.env.EVOR_WIKI_MAX_ENTRIES;
    process.env.EVOR_WIKI_MAX_ENTRIES = "5";
    try {
      const runId = "run-cap-001";
      for (let i = 0; i < 10; i++) {
        wikiAdd(
          runId,
          makeEntry({ node_id: `cap-node-${i}`, lesson_id: `cap-lesson-${i}` }),
          "test-mission"
        );
      }
      const indexPath = join(tmpRoot, "wiki", "index.jsonl");
      const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(5);
    } finally {
      if (origMax === undefined) {
        delete process.env.EVOR_WIKI_MAX_ENTRIES;
      } else {
        process.env.EVOR_WIKI_MAX_ENTRIES = origMax;
      }
    }
  });

  it("cap retains the most-recent entries (by created_at)", () => {
    const origMax = process.env.EVOR_WIKI_MAX_ENTRIES;
    process.env.EVOR_WIKI_MAX_ENTRIES = "3";
    try {
      const runId = "run-cap-002";
      const base = new Date("2024-01-01T00:00:00Z").getTime();
      for (let i = 0; i < 5; i++) {
        wikiAdd(
          runId,
          makeEntry({
            node_id: `capn-${i}`,
            lesson_id: `capl-${i}`,
            created_at: new Date(base + i * 60_000).toISOString(), // i minutes apart
          }),
          "test-mission"
        );
      }
      const indexPath = join(tmpRoot, "wiki", "index.jsonl");
      const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
      expect(lines.length).toBe(3);
      const ids = lines.map((l) => JSON.parse(l).lesson_id);
      // Most recent 3 are capl-2, capl-3, capl-4
      expect(ids).toContain("capl-2");
      expect(ids).toContain("capl-3");
      expect(ids).toContain("capl-4");
    } finally {
      if (origMax === undefined) {
        delete process.env.EVOR_WIKI_MAX_ENTRIES;
      } else {
        process.env.EVOR_WIKI_MAX_ENTRIES = origMax;
      }
    }
  });
});

// ── wikiQuery ─────────────────────────────────────────────────────────────────

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

// ── wikiGetRelevant ───────────────────────────────────────────────────────────

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

// ── wikiGetRelevant IDF cache ─────────────────────────────────────────────────

describe("wikiGetRelevant IDF cache", () => {
  it("second call with different query hits cache (1 miss, 1 hit)", () => {
    const runId = "run-cache-001";
    wikiAdd(runId, makeEntry({ observation: "dropout regularization reduces overfitting", tags: ["dropout"] }), "test-mission");

    // Cache is already reset by global beforeEach, but ensure clean state
    _resetWikiCache();

    wikiGetRelevant("dropout regularization", 5);  // cold load → 1 miss
    wikiGetRelevant("attention heads spatial", 5); // same file, same mtime → cache hit

    expect(_wikiCacheStats.misses).toBe(1);
    expect(_wikiCacheStats.hits).toBe(1);
  });

  it("cache invalidates after wikiAdd (mtime changes → new miss)", () => {
    const runId = "run-cache-002";
    wikiAdd(runId, makeEntry({ observation: "cosine annealing schedule" }), "test-mission");

    _resetWikiCache();
    wikiGetRelevant("cosine", 5);   // miss 1
    wikiGetRelevant("cosine", 5);   // hit 1 (file unchanged)
    expect(_wikiCacheStats.misses).toBe(1);
    expect(_wikiCacheStats.hits).toBe(1);

    // New write changes mtime
    wikiAdd(runId, makeEntry({ observation: "dropout regularization separate entry" }), "test-mission");
    wikiGetRelevant("dropout", 5);  // miss 2 (mtime changed)

    expect(_wikiCacheStats.misses).toBe(2);
    expect(_wikiCacheStats.hits).toBe(1);
  });

  it("returns correct results from cached corpus", () => {
    const runId = "run-cache-003";
    const target = makeEntry({
      observation: "binarization threshold critical for binary tasks",
      tags: ["binarization"],
    });
    const noise = makeEntry({ observation: "unrelated batch experiment" });
    wikiAdd(runId, target, "test-mission");
    wikiAdd(runId, noise, "test-mission");

    _resetWikiCache();
    const r1 = wikiGetRelevant("binarization binary", 5);  // cold
    const r2 = wikiGetRelevant("binarization binary", 5);  // warm

    // Both calls return the same result
    expect(r1.length).toBeGreaterThan(0);
    expect(r2.length).toBe(r1.length);
    expect(r2[0].lesson_id).toBe(r1[0].lesson_id);
    expect(_wikiCacheStats.misses).toBe(1);
    expect(_wikiCacheStats.hits).toBe(1);
  });
});
