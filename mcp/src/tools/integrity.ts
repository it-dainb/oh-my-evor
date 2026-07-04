/**
 * tools/integrity.ts
 * evor_integrity_check — run integrity_bridge.py (wraps Python IntegrityGate);
 *                        parse IntegrityReport JSON from stdout.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths } from "../run-store.js";
import { callBridge } from "../subprocess-bridge.js";

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Run all 13 IntegrityGate checks via `integrity_bridge.py`.
 * The bridge writes `evaluations/<node_id>.json` on success.
 *
 * Returns the parsed IntegrityReport on success, or an error payload if
 * the bridge subprocess failed (e.g. missing Python harness).
 */
export function integrityCheck(
  runId: string,
  nodeId: string,
  missionId?: string
): { ok: boolean; report?: unknown; error?: string; stderr?: string } {
  const paths = resolveRunPaths(runId, missionId);

  const result = callBridge("integrity_bridge.py", [
    "--run-id", runId,
    "--node-id", nodeId,
    "--run-dir", paths.runDir,
  ]);

  if (!result.ok) {
    return { ok: false, error: result.error, stderr: result.stderr };
  }
  return { ok: true, report: result.data };
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerIntegrityTools(server: McpServer): void {
  server.tool(
    "evor_integrity_check",
    "Run all 13 IntegrityGate checks via the MCP subprocess bridge (integrity_bridge.py); write IntegrityReport to evaluations/<node-id>.json.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("Node to check"),
    },
    async ({ run_id, node_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = integrityCheck(run_id, node_id, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.ok ? result.report : result),
          },
        ],
      };
    }
  );
}
