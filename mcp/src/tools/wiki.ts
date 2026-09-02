/**
 * tools/wiki.ts
 * evor_wiki_add          — persist LessonEntry to run wiki + cross-run index.
 *                          Dedup: exact lesson_id OR near-dup (same node +
 *                          approach_family + obs[:100]) replaces in-place.
 *                          Cap: corpus capped at EVOR_WIKI_MAX_ENTRIES (default 500)
 *                          most-recent entries — atomic write via tmp→rename.
 * evor_wiki_get_relevant — TF-IDF semantic slice with lazy corpus cache keyed
 *                          by (indexPath, mtime); invalidates on every write.
 * evor_wiki_query        — legacy keyword search (prefer get_relevant).
 *
 * Implemented in pure TypeScript to avoid a Python subprocess dependency
 * for simple file I/O + keyword scoring.  Mirrors CompoundingWiki in
 * harness/evor/wiki.py exactly (same layout, same ranking logic).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LessonEntry, LessonEntrySchema, ApproachFamilySchema } from "../contracts.js";
import { resolveRunPaths, getEvorRoot } from "../run-store.js";
import { ok } from "../tool-result.js";

// ── Markdown renderer (mirrors wiki.py._render_lesson) ────────────────────

function renderLesson(entry: LessonEntry): string {
  const lines: string[] = [
    `# Lesson: ${entry.lesson_id}`,
    "",
    `**Node:** ${entry.node_id}  |  **Run:** ${entry.run_id}  |  **Mission:** ${entry.mission_id}`,
    `**Family:** ${entry.approach_family}  |  **Verdict:** ${entry.hypothesis_verdict}`,
    `**Created:** ${entry.created_at}`,
    "",
    "## Observation",
    "",
    entry.observation,
    "",
  ];

  if (entry.root_cause) {
    lines.push("## Root Cause", "", entry.root_cause, "");
  }

  lines.push("## Actionable Lesson", "", entry.actionable_lesson, "");

  if (entry.telemetry_evidence) {
    lines.push("## Telemetry Evidence", "", entry.telemetry_evidence, "");
  }

  if (entry.citations.length > 0) {
    lines.push("## Citations", "");
    for (const cit of entry.citations) {
      lines.push(`- ${cit}`);
    }
    lines.push("");
  }

  if (entry.tags.length > 0) {
    lines.push(`**Tags:** ${entry.tags.join(", ")}`, "");
  }

  return lines.join("\n");
}

// ── Dedup / prune helpers ─────────────────────────────────────────────────

/** Max cross-run index entries. Override via EVOR_WIKI_MAX_ENTRIES env. */
function getWikiMaxEntries(): number {
  return parseInt(process.env.EVOR_WIKI_MAX_ENTRIES ?? "500", 10);
}

/**
 * Near-duplicate fingerprint.
 * Two entries are near-duplicates when the same experiment node emits
 * another lesson about the same approach family with the same observation
 * prefix (first 100 chars, lowercased) — a loop-artifact dedup guard.
 */
function nearDupKey(e: LessonEntry): string {
  return `${e.node_id}\0${e.approach_family}\0${e.observation.slice(0, 100).toLowerCase()}`;
}

/**
 * Read index.jsonl, apply dedup, cap, and write back atomically (tmp→rename).
 *
 * Dedup policy (first match wins — exact beats near-dup):
 *   - Exact:    same lesson_id     → replace in-place (idempotent re-run)
 *   - Near-dup: same node+family+obs[:100] → replace in-place (loop artifact)
 *
 * Cap policy: keep WIKI_MAX_ENTRIES most-recent entries by created_at (ISO sort).
 * Dropped entries lose their spot permanently; the MD files are left on disk.
 */
function pruneAndWrite(indexPath: string, newEntry: LessonEntry): void {
  const entries: LessonEntry[] = [];

  if (existsSync(indexPath)) {
    for (const line of readFileSync(indexPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(LessonEntrySchema.parse(JSON.parse(trimmed)));
      } catch {
        continue; // skip malformed lines
      }
    }
  }

  const ndKey = nearDupKey(newEntry);
  let replaced = false;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].lesson_id === newEntry.lesson_id || nearDupKey(entries[i]) === ndKey) {
      entries[i] = newEntry;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    entries.push(newEntry);
  }

  // Cap: keep most-recent N
  const max = getWikiMaxEntries();
  if (entries.length > max) {
    entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
    entries.splice(max);
  }

  // Atomic write: write to .tmp then rename (POSIX atomic)
  const tmp = `${indexPath}.tmp.${process.pid}`;
  writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  renameSync(tmp, indexPath);
  // Invalidate explicitly. mtime cannot be relied on: two writes inside the same
  // millisecond share a timestamp, and the reader would serve the pre-write corpus.
  bumpWikiGeneration();
}

// ── TF-IDF helpers ────────────────────────────────────────────────────────

/** Tokenize text: split on non-alpha chars, lowercase, drop tokens shorter than 2 chars. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2);
}

/** Build a term-frequency map from a token list. */
function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

/** Cosine similarity between two TF-IDF vectors (both represented as Map<term, weight>). */
function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, wa] of a) {
    const wb = b.get(term) ?? 0;
    dot += wa * wb;
    normA += wa * wa;
  }
  for (const wb of b.values()) {
    normB += wb * wb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── IDF corpus cache ──────────────────────────────────────────────────────

/**
 * Cached corpus for one index file.
 *
 * entryVecs: per-entry TF-IDF vectors pre-computed from the corpus IDF map.
 * These are IDF-dependent and do not change while the file is unchanged.
 * Query vectors are built per-call (cheap: just the query tokens × IDF lookup).
 *
 * Cache key: (indexPath → mtime + generation).
 *
 * mtime ALONE IS NOT SUFFICIENT, which the original design assumed: "a write via
 * pruneAndWrite (tmp→rename) always produces a fresh mtime". It does not. mtimeMs
 * is millisecond-resolution and the kernel's timestamp source is coarser still —
 * measured on this host, two immediate writes to the same file produced identical
 * `mtime_ns`. So a wikiAdd followed by a wikiGetRelevant inside the same tick
 * served the PREVIOUS corpus, silently missing the lesson just written.
 *
 * That is a data-loss path, not a performance detail: Sage writes a finding and
 * Mutagen queries the wiki in the same tick, so the reader can miss exactly the
 * lesson the writer just produced — with no error anywhere.
 *
 * The generation counter is bumped by every in-process write, so invalidation no
 * longer depends on clock resolution. mtime is retained as the secondary key so
 * writes from ANOTHER process still invalidate.
 */
interface WikiCache {
  mtime: number;
  generation: number;
  entries: LessonEntry[];
  entryVecs: Map<string, number>[];
  df: Map<string, number>;
  N: number;
}

const idfCache = new Map<string, WikiCache>();

/** Bumped on every in-process write; part of the cache key. See WikiCache. */
let wikiGeneration = 0;

/** Invalidate the corpus cache for a path after a write. */
function bumpWikiGeneration(): void {
  wikiGeneration++;
}

/** Hit/miss counters exposed for tests. */
export const _wikiCacheStats = { hits: 0, misses: 0 };

/**
 * Clear the in-process IDF cache and reset counters.
 * Call in test beforeEach to ensure each test starts from a clean state.
 */
export function _resetWikiCache(): void {
  idfCache.clear();
  _wikiCacheStats.hits = 0;
  _wikiCacheStats.misses = 0;
  wikiGeneration = 0;
}

/**
 * Load (or cache-hit) the parsed corpus, document-frequency map, and
 * pre-computed per-entry TF-IDF vectors for indexPath.
 *
 * Returns an empty cache object if the file does not exist.
 */
function loadCorpus(indexPath: string): WikiCache {
  let mtime = 0;
  try {
    mtime = statSync(indexPath).mtimeMs;
  } catch {
    return { mtime: 0, generation: wikiGeneration, entries: [], entryVecs: [], df: new Map(), N: 0 };
  }

  const cached = idfCache.get(indexPath);
  if (cached && cached.mtime === mtime && cached.generation === wikiGeneration) {
    _wikiCacheStats.hits++;
    return cached;
  }
  _wikiCacheStats.misses++;

  // Cold load
  const entries: LessonEntry[] = [];
  for (const line of readFileSync(indexPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(LessonEntrySchema.parse(JSON.parse(trimmed)));
    } catch {
      continue;
    }
  }

  const entryTokensList: string[][] = entries.map((e) =>
    tokenize(
      [e.observation, e.actionable_lesson, e.root_cause ?? "", e.tags.join(" ")].join(" ")
    )
  );

  // Document frequency
  const df = new Map<string, number>();
  for (const tokens of entryTokensList) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const N = entries.length;

  // Pre-compute per-entry TF-IDF vectors using the corpus IDF
  const entryVecs: Map<string, number>[] = entryTokensList.map((tokens) => {
    const tf = termFreq(tokens);
    const vec = new Map<string, number>();
    for (const [term, count] of tf) {
      const idf = Math.log((N + 1) / ((df.get(term) ?? 0) + 1)) + 1;
      vec.set(term, count * idf);
    }
    return vec;
  });

  const result: WikiCache = { mtime, generation: wikiGeneration, entries, entryVecs, df, N };
  idfCache.set(indexPath, result);
  return result;
}

// ── Core logic (exported for tests) ──────────────────────────────────────

/**
 * Persist a LessonEntry to:
 *   - `run_dir/wiki/<lesson_id>.md`      (per-run copy)
 *   - `evor_root/wiki/<lesson_id>.md`    (cross-run copy)
 *   - `evor_root/wiki/index.jsonl`       (cross-run searchable index — bounded)
 *
 * Dedup: same lesson_id or same (node_id + approach_family + obs[:100])
 * replaces the existing entry rather than appending.
 * Cap: at most EVOR_WIKI_MAX_ENTRIES (default 500) entries kept.
 */
/** What a citation resolver reports back about one identifier (item 5.4). */
export type CitationResolution = {
  resolved: boolean;
  title?: string;
  /** False when the resolved work does not support the claim it is cited for. */
  supports_claim?: boolean;
};

export function wikiAdd(
  runId: string,
  entry: LessonEntry,
  missionId?: string,
  opts?: { resolveCitation?: (citation: string) => CitationResolution }
): { lessonId: string; indexPath: string; citation_status?: Record<string, CitationResolution> } {
  const paths = resolveRunPaths(runId, missionId);
  const evorRoot = getEvorRoot();
  const wikiRoot = join(evorRoot, "wiki");

  // ── Item 5.4 (N-01/N-04): resolve citations BEFORE persisting ───────────
  //
  // The only signal of citation identity in the whole pipeline was the junior's
  // own `urls_verified: true`, asserted about its own work, checked by nothing.
  // Three of twenty sampled citations were misattributed: CBAM was credited to
  // arXiv 2006.05595, which is "Fitted Q-Learning for Relational Domains".
  //
  // The resolver is INJECTED rather than called directly, so this path is
  // testable without a network and so the server — not the agent — owns the
  // verdict. No resolver supplied means no verification was performed, and the
  // result says so rather than defaulting to verified: absence of a failure
  // verdict is not evidence of integrity.
  let citation_status: Record<string, CitationResolution> | undefined;
  if (opts?.resolveCitation) {
    citation_status = {};
    for (const citation of entry.citations ?? []) {
      try {
        citation_status[citation] = opts.resolveCitation(citation);
      } catch (err) {
        citation_status[citation] = { resolved: false, title: `resolver error: ${String(err)}` };
      }
    }
  }

  const rendered = renderLesson(entry);

  // Cross-run wiki
  mkdirSync(wikiRoot, { recursive: true });
  writeFileSync(join(wikiRoot, `${entry.lesson_id}.md`), rendered, "utf8");
  const indexPath = join(wikiRoot, "index.jsonl");
  pruneAndWrite(indexPath, entry);

  // Per-run wiki
  const runWikiDir = join(paths.runDir, "wiki");
  mkdirSync(runWikiDir, { recursive: true });
  writeFileSync(join(runWikiDir, `${entry.lesson_id}.md`), rendered, "utf8");

  return { lessonId: entry.lesson_id, indexPath , citation_status };
}

/**
 * Keyword search over `evor_root/wiki/index.jsonl`.
 *
 * Scoring (mirrors wiki.py.query):
 *   - Each keyword hit in observation + actionable_lesson + tags + root_cause
 *     counts once per occurrence.
 *   - Lessons with zero hits are excluded (unless query is empty).
 *   - Sort: most hits first, then newest created_at desc.
 *
 * Filters: `family` and `confirmedOnly` applied before scoring.
 *
 * Search is one tool: evor_wiki_query with mode=semantic|keyword.
 */
export function wikiQuery(
  query: string,
  opts?: {
    family?: z.infer<typeof ApproachFamilySchema>;
    confirmedOnly?: boolean;
    limit?: number;
  }
): LessonEntry[] {
  const evorRoot = getEvorRoot();
  const indexPath = join(evorRoot, "wiki", "index.jsonl");

  if (!existsSync(indexPath)) {
    return [];
  }

  const keywords = query.split(/\s+/).filter(Boolean).map((k) => k.toLowerCase());
  const limit = opts?.limit ?? 10;

  const scored: Array<{ hits: number; createdAt: string; entry: LessonEntry }> = [];

  for (const line of readFileSync(indexPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: LessonEntry;
    try {
      entry = LessonEntrySchema.parse(JSON.parse(trimmed));
    } catch {
      continue;
    }

    // Filters
    if (opts?.family && entry.approach_family !== opts.family) continue;
    if (opts?.confirmedOnly && entry.hypothesis_verdict !== "confirmed") continue;
    // Item 5.3: a superseded entry is not a confirmed lesson, whatever its
    // verdict field still says. The r1 latency claim was falsified twice and
    // then cited 23 times across the tree, because nothing on the retrieval path
    // could tell a refuted entry from a standing one.
    if (opts?.confirmedOnly && (entry as { superseded_by?: string }).superseded_by) continue;

    // Keyword scoring
    if (keywords.length === 0) {
      scored.push({ hits: 0, createdAt: entry.created_at, entry });
      continue;
    }

    const blob = [
      entry.observation,
      entry.actionable_lesson,
      entry.root_cause ?? "",
      entry.tags.join(" "),
    ]
      .join(" ")
      .toLowerCase();

    const hits = keywords.reduce((sum, kw) => {
      let count = 0;
      let pos = 0;
      while ((pos = blob.indexOf(kw, pos)) !== -1) {
        count++;
        pos += kw.length;
      }
      return sum + count;
    }, 0);

    if (hits > 0) {
      scored.push({ hits, createdAt: entry.created_at, entry });
    }
  }

  // Sort: most hits first, then newest first
  scored.sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * Retrieve the k most semantically-relevant wiki lessons for a given context string.
 *
 * Uses smooth TF-IDF (sklearn default: IDF = log((N+1)/(df+1)) + 1) and cosine
 * similarity to rank entries. Per-entry TF-IDF vectors are cached against the
 * index file's mtime — a write via wikiAdd always busts the cache.
 *
 * Entries with zero cosine similarity are excluded.
 * Sort order: highest similarity first; newest created_at as tiebreaker.
 */
export function wikiGetRelevant(context: string, k: number): LessonEntry[] {
  const evorRoot = getEvorRoot();
  const indexPath = join(evorRoot, "wiki", "index.jsonl");

  const { entries, entryVecs, df, N } = loadCorpus(indexPath);
  if (entries.length === 0) return [];

  // Build query TF-IDF vector using cached IDF values
  const queryTokens = tokenize(context);
  if (queryTokens.length === 0) return [];

  const queryTf = termFreq(queryTokens);
  const queryVec = new Map<string, number>();
  for (const [term, count] of queryTf) {
    const idf = Math.log((N + 1) / ((df.get(term) ?? 0) + 1)) + 1;
    queryVec.set(term, count * idf);
  }

  if (queryVec.size === 0) return [];

  // Score each entry using pre-computed entry vectors
  const scored: Array<{ sim: number; createdAt: string; entry: LessonEntry }> = [];
  for (let i = 0; i < entries.length; i++) {
    const sim = cosineSim(queryVec, entryVecs[i]);
    if (sim > 0) {
      scored.push({ sim, createdAt: entries[i].created_at, entry: entries[i] });
    }
  }

  // Sort: highest similarity first, then newest created_at as tiebreaker
  scored.sort((a, b) => {
    if (b.sim !== a.sim) return b.sim - a.sim;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return scored.slice(0, k).map((s) => s.entry);
}

// ── Tool registrations ────────────────────────────────────────────────────

export function registerWikiTools(server: McpServer): void {
  // ── evor_wiki_add ─────────────────────────────────────────────────────────
  server.tool(
    "evor_wiki_add",
    [
      "Write a LessonEntry to wiki/<lesson_id>.md and update .evor/wiki/index.jsonl.",
      "Dedup: same lesson_id OR same (node_id + approach_family + obs[:100]) replaces",
      "the existing entry instead of appending (prevents loop-duplicates).",
      "Cap: corpus is bounded at EVOR_WIKI_MAX_ENTRIES (default 500) most-recent entries.",
    ].join(" "),
    {
      run_id: z.string().describe("Active run identifier"),
      entry: LessonEntrySchema.describe("LessonEntry to persist"),
    },
    async ({ run_id, entry }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const { lessonId } = wikiAdd(run_id, entry, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, lesson_id: lessonId, run_id }),
          },
        ],
      };
    }
  );

  // ── evor_wiki_query ───────────────────────────────────────────────────────
  server.tool(
    "evor_wiki_query",
    [
      "Search wiki lessons across runs.",
      "mode=semantic ranks by TF-IDF relevance to a context string (approach, metric,",
      "error, architecture) and surfaces related concepts without exact keyword match;",
      "mode=keyword filters by exact phrase, approach_family and verdict.",
    ].join(" "),
    {
      // One tool, one enum, replacing two whose descriptions each told the caller
      // to use the other. Cross-recommendation in prose is a design smell: the
      // choice belongs in the interface, where it cannot drift from the behaviour
      // and costs no description bytes to restate (rubric rule 1).
      //
      // evor_wiki_get_relevant was folded in rather than the reverse because it
      // had ZERO references in agents/ or skills/, while evor_wiki_query is
      // referenced in six files — removing the referenced one would have broken
      // callers for a cosmetic gain.
      mode: z
        .enum(["semantic", "keyword"])
        .default("semantic")
        .describe("semantic = TF-IDF relevance ranking; keyword = exact filtering"),
      query: z.string().describe("Context string (semantic) or keyword/phrase (keyword)"),
      approach_family: ApproachFamilySchema.optional().describe("keyword mode: filter to an approach family"),
      confirmed_only: z.boolean().optional().describe("keyword mode: only hypothesis_verdict=confirmed"),
      limit: z.number().int().positive().optional().describe("Max results (semantic default 5, keyword default 10)"),
      // Accepted and ignored: never reached the query functions. Kept optional so
      // a caller still passing it is not rejected (PM3).
      run_id: z.string().optional().describe("Unused; accepted for backward compatibility"),
    },
    async ({ mode, run_id, query, approach_family, confirmed_only, limit }) => {
      const lessons =
        mode === "keyword"
          ? wikiQuery(query, { family: approach_family, confirmedOnly: confirmed_only, limit })
          : wikiGetRelevant(query, limit ?? 5);
      return ok({ run_id, mode, query, count: lessons.length, lessons });
    }
  );
}
