/**
 * tools/telemetry.ts
 * evor_telemetry_ingest — validate + append TelemetryRecord[] to nodes/<id>/telemetry.jsonl
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TelemetryRecord, TelemetryRecordSchema } from "../contracts.js";
import { resolveRunPaths } from "../run-store.js";

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Append validated TelemetryRecord objects as JSONL lines to
 * `nodes/<nodeId>/telemetry.jsonl`.  Each record is written as a single
 * JSON line terminated with `\n`.
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
  const nodeDir = join(paths.nodesDir, nodeId);

  if (!existsSync(nodeDir)) {
    mkdirSync(nodeDir, { recursive: true });
  }

  const telemetryPath = join(nodeDir, "telemetry.jsonl");
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  appendFileSync(telemetryPath, lines, "utf8");

  return { telemetryPath, count: records.length };
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerTelemetryTools(server: McpServer): void {
  server.tool(
    "evor_telemetry_ingest",
    "Validate each TelemetryRecord against schema and append JSONL lines to nodes/<node_id>/telemetry.jsonl.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("Node emitting telemetry"),
      records: z
        .array(TelemetryRecordSchema)
        .min(1)
        .describe("Batch of TelemetryRecord objects to ingest"),
    },
    async ({ run_id, node_id, records }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const { telemetryPath, count } = telemetryIngest(run_id, node_id, records, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, count, run_id, node_id, telemetry_path: telemetryPath }),
          },
        ],
      };
    }
  );
}
