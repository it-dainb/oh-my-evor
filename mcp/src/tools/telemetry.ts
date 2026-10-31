/**
 * tools/telemetry.ts
 * evor_telemetry_ingest — validate + append TelemetryRecord[] to nodes/<id>/telemetry.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TelemetryRecord, TelemetryRecordSchema } from "../contracts.js";
import { resolveRunPaths } from "../run-store.js";
import { resolveNodeRef } from "./node-ref.js";

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Append validated TelemetryRecord objects as JSONL lines to
 * `nodes/<canonical node id>/telemetry.jsonl`. A `nodeId` given as a NAME is
 * resolved to the node's uuid first, so this can never mint a second directory
 * for one node — see the note in the body.  Each record is written as a single
 * JSON line terminated with `\n`.
 *
 * Optional fields (node_id, run_id, timestamp) are filled server-side from
 * tool args + now() before persisting, so the agent need not supply them.
 *
 * Returns the path of the telemetry file and the count of records written.
 */
export function telemetryIngest(
  runId: string,
  nodeId: string,
  records: TelemetryRecord[],
  missionId?: string
): { telemetryPath: string; count: number } {
  const paths = resolveRunPaths(runId, missionId);

  // ── O-01, closed at the write side (was: closed only at the read side) ────
  //
  // This joined `nodesDir` with whatever key it was handed, so one node got TWO
  // directories in the same run: the agent surface is name-keyed on purpose
  // ("Returns {ok, name} — you never handle an internal id"), the server surface
  // is uuid-keyed, and both wrote here. A real run ended up holding
  // `nodes/cf9f0020-…/results.json` beside `nodes/n001-depthwise-unet/telemetry.jsonl`,
  // and integrity check 5 once failed a node with 12,000 well-formed telemetry
  // records because it looked under the other one.
  //
  // `node_identity.py` made every READER tolerant of both. That was the right
  // rescue and it is not a fix: as long as this function can mint a second
  // directory, the split keeps being created and every reader forever needs the
  // rescue. The uuid is the canonical key (node_identity's own docstring says
  // so), so a name is resolved to it here. Callers may still pass either.
  // `resolveNodeRef`, not `tryResolveNodeRef`: node-ref.ts states the rule —
  // "Readers use this; writers use resolveNodeRef". This is a writer. The strict
  // form returns the ref unchanged for an unreadable or EMPTY tree (the
  // legitimate pre-first-node case) and THROWS when the tree is populated and
  // nothing claims the ref — which is the loud failure O-01 needs, because
  // resolving an unknown ref to itself is exactly what mints the second
  // directory. Using the reader's tolerant form here would silently keep doing
  // that.
  const canonicalId = resolveNodeRef(runId, nodeId, missionId);
  const nodeDir = join(paths.nodesDir, canonicalId);

  if (!existsSync(nodeDir)) {
    mkdirSync(nodeDir, { recursive: true });
  }

  const now = new Date().toISOString();
  const filled = records.map((r) => ({
    ...r,
    node_id: r.node_id || canonicalId,
    run_id: r.run_id || runId,
    timestamp: r.timestamp || now,
  }));

  const telemetryPath = join(nodeDir, "telemetry.jsonl");
  const lines = filled.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(telemetryPath, lines, "utf8");

  return { telemetryPath, count: records.length };
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerTelemetryTools(server: McpServer): void {
  server.tool(
    "evor_telemetry_ingest",
    "Validate each TelemetryRecord and append it to the node's telemetry stream. Identify the node by name. " +
      "Give `records`, or `source_path`: a JSONL telemetry file a trainer wrote somewhere other than the " +
      "node's telemetry_path (e.g. inside its worktree), which is read and ingested whole.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("Node emitting telemetry"),
      records: z
        .array(TelemetryRecordSchema)
        .min(1)
        .optional()
        .describe("Batch of TelemetryRecord objects to ingest"),
      source_path: z.string().optional().describe(
        "Absolute path of a JSONL telemetry file to ingest instead of `records`",
      ),
    },
    async ({ run_id, node_id, records: given, source_path }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const fail = (error: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error }) }] });
      let records = given;
      let skipped = 0;
      if (!records && source_path) {
        if (/[/\\]\.evor[/\\]runs[/\\]/.test(source_path)) return fail("source_path is inside the run's own state: that file is the node's ingested stream already, so there is nothing to ingest from it. To ingest what a trainer wrote, give that file, e.g. <worktree>/telemetry.jsonl");
        if (!existsSync(source_path)) return fail(`no file at ${source_path}`);
        records = [];
        for (const line of readFileSync(source_path, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = TelemetryRecordSchema.safeParse(JSON.parse(line));
            if (parsed.success) records.push(parsed.data); else skipped++;
          } catch { skipped++; }
        }
        if (!records.length) return fail(`no valid telemetry records in ${source_path} (${skipped} skipped)`);
      }
      if (!records?.length) return fail("give records or source_path");
      const { count } = telemetryIngest(run_id, node_id, records, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, count, run_id, node_id, ...(skipped ? { skipped_lines: skipped } : {}) }),
          },
        ],
      };
    }
  );
}
