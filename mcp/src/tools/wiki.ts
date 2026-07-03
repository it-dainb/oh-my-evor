/**
 * tools/wiki.ts
 * evor_wiki_add   — persist LessonEntry to run wiki + cross-run index
 * evor_wiki_query — keyword search over wiki index.jsonl
 *
 * Implemented in pure TypeScript to avoid a Python subprocess dependency
 * for simple file I/O + keyword scoring.  Mirrors CompoundingWiki in
 * harness/evor/wiki.py exactly (same layout, same ranking logic).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LessonEntry, LessonEntrySchema, ApproachFamilySchema } from "../contracts.js";
import { resolveRunPaths, getEvorRoot } from "../run-store.js";

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

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Persist a LessonEntry to:
 *   - `run_dir/wiki/<lesson_id>.md`      (per-run copy)
 *   - `evor_root/wiki/<lesson_id>.md`    (cross-run copy)
 *   - `evor_root/wiki/index.jsonl`       (cross-run searchable index)
 */
export function wikiAdd(
  runId: string,
  entry: LessonEntry,
  missionId?: string
): { lessonId: string; indexPath: string } {
  const paths = resolveRunPaths(runId, missionId);
  const evorRoot = getEvorRoot();
  const wikiRoot = join(evorRoot, "wiki");

  const rendered = renderLesson(entry);
  const entryJson = JSON.stringify(entry);

  // Cross-run wiki
  mkdirSync(wikiRoot, { recursive: true });
  writeFileSync(join(wikiRoot, `${entry.lesson_id}.md`), rendered, "utf8");
  const indexPath = join(wikiRoot, "index.jsonl");
  appendFileSync(indexPath, entryJson + "\n", "utf8");

  // Per-run wiki
  const runWikiDir = join(paths.runDir, "wiki");
  mkdirSync(runWikiDir, { recursive: true });
  writeFileSync(join(runWikiDir, `${entry.lesson_id}.md`), rendered, "utf8");

  return { lessonId: entry.lesson_id, indexPath };
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

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerWikiTools(server: McpServer): void {
  // ── evor_wiki_add ──────────────────────────────────────────────────────────
  server.tool(
    "evor_wiki_add",
    "Write a LessonEntry to wiki/<lesson_id>.md and append to .evor/wiki/index.jsonl (cross-run compounding wiki).",
    {
      run_id: z.string().describe("Active run identifier"),
      entry: LessonEntrySchema.describe("LessonEntry to persist"),
    },
    async ({ run_id, entry }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const { lessonId, indexPath } = wikiAdd(run_id, entry, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, lesson_id: lessonId, run_id, index_path: indexPath }),
          },
        ],
      };
    }
  );

  // ── evor_wiki_query ────────────────────────────────────────────────────────
  server.tool(
    "evor_wiki_query",
    "Keyword search over .evor/wiki/index.jsonl; filter by approach_family and/or confirmed_only; cross-run scope.",
    {
      run_id: z.string().describe("Active run identifier (sets cross-run scope)"),
      query: z.string().describe("Keyword or phrase to search"),
      approach_family: ApproachFamilySchema.optional().describe("Filter to a specific approach family"),
      confirmed_only: z.boolean().optional().describe("If true, return only hypothesis_verdict=confirmed entries"),
      limit: z.number().int().positive().optional().describe("Maximum results to return (default 10)"),
    },
    async ({ run_id, query, approach_family, confirmed_only, limit }) => {
      const lessons = wikiQuery(query, {
        family: approach_family,
        confirmedOnly: confirmed_only,
        limit,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ lessons, run_id, query, count: lessons.length }),
          },
        ],
      };
    }
  );
}
