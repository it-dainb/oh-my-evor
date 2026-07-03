/**
 * tests/wiki.test.ts
 * Unit tests for tools/wiki.ts: wikiAdd + wikiQuery (pure TS, no subprocess)
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { wikiAdd, wikiQuery } from "../src/tools/wiki.js";
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
    const { indexPath } = wikiAdd(runId, entry);

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
    const { indexPath } = wikiAdd(runId, entry);

    expect(existsSync(indexPath)).toBe(true);
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.lesson_id).toBe(entry.lesson_id);
  });

  it("writes per-run wiki copy", () => {
    const runId = "run-add-003";
    const entry = makeEntry();
    wikiAdd(runId, entry);

    const perRunMd = join(tmpRoot, "runs", runId, "wiki", `${entry.lesson_id}.md`);
    expect(existsSync(perRunMd)).toBe(true);
  });

  it("appends multiple entries to index.jsonl", () => {
    const runId = "run-add-004";
    const e1 = makeEntry();
    const e2 = makeEntry();
    wikiAdd(runId, e1);
    wikiAdd(runId, e2);

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
    wikiAdd(runId, entry);

    const md = readFileSync(join(tmpRoot, "wiki", `${entry.lesson_id}.md`), "utf8");
    expect(md).toContain("## Root Cause");
    expect(md).toContain("Batch norm before relu");
  });

  it("renders citations section when present", () => {
    const runId = "run-add-006";
    const entry = makeEntry({ citations: ["https://arxiv.org/abs/1234.5678"] });
    wikiAdd(runId, entry);

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
    wikiAdd(runId, relevant);
    wikiAdd(runId, irrelevant);

    const results = wikiQuery("dropout regularization");
    expect(results).toHaveLength(1);
    expect(results[0].lesson_id).toBe(relevant.lesson_id);
  });

  it("returns all lessons when query is empty", () => {
    const runId = "run-query-002";
    wikiAdd(runId, makeEntry());
    wikiAdd(runId, makeEntry());
    wikiAdd(runId, makeEntry());

    const results = wikiQuery("");
    expect(results).toHaveLength(3);
  });

  it("filters by approach_family", () => {
    const runId = "run-query-003";
    const archLesson = makeEntry({ approach_family: "arch" });
    const trainLesson = makeEntry({ approach_family: "training" });
    wikiAdd(runId, archLesson);
    wikiAdd(runId, trainLesson);

    const results = wikiQuery("", { family: "arch" });
    expect(results).toHaveLength(1);
    expect(results[0].approach_family).toBe("arch");
  });

  it("filters by confirmed_only", () => {
    const runId = "run-query-004";
    const confirmed = makeEntry({ hypothesis_verdict: "confirmed" });
    const refuted = makeEntry({ hypothesis_verdict: "refuted" });
    wikiAdd(runId, confirmed);
    wikiAdd(runId, refuted);

    const results = wikiQuery("", { confirmedOnly: true });
    expect(results).toHaveLength(1);
    expect(results[0].hypothesis_verdict).toBe("confirmed");
  });

  it("respects limit parameter", () => {
    const runId = "run-query-005";
    for (let i = 0; i < 5; i++) {
      wikiAdd(runId, makeEntry({ observation: "keyword repeated" }));
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
    wikiAdd(runId, low);
    wikiAdd(runId, high);

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
    wikiAdd(runId, e);

    const results = wikiQuery("cosine_annealing");
    expect(results).toHaveLength(1);
  });
});
