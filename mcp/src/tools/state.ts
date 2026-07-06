/**
 * tools/state.ts
 * evor_state_read  — read run-state.json
 * evor_state_write — merge-patch run-state.json; append strategy delta to strategy.json
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StrategyStateSchema } from "../contracts.js";
import { resolveRunPaths, ensureRunDirs } from "../run-store.js";
import { readRunState, writeRunState } from "./record.js";

/** Minimal run-state fields tracked by the MCP server. */
const RunStatePatchSchema = z.object({
  status: z
    .enum(["initialized", "running", "paused", "completed", "failed"])
    .optional()
    .describe("Run lifecycle status"),
  tick_count: z.number().int().min(0).optional().describe("Number of completed ticks"),
  best_score: z.number().optional().describe("Best primary metric value achieved so far"),
  frontier_ids: z.array(z.string()).optional().describe("Node IDs currently on the frontier"),
  current_eval_version: z.string().optional().describe("Active EvalSuite version"),
  pending_node_ids: z
    .array(z.string())
    .optional()
    .describe("Node IDs started in this tick but not yet written to tree.json"),
  strategy: StrategyStateSchema.partial().optional().describe("Strategy delta to merge into strategy.json"),
});

// ── Core logic (exported for tests) ────────────────────────────────────────

/** Read run-state.json and return the parsed state object. */
export function stateRead(runId: string, missionId?: string): Record<string, unknown> {
  const paths = resolveRunPaths(runId, missionId);
  return readRunState(paths.runStatePath, runId);
}

/**
 * Merge patch fields into run-state.json.
 * If `patch.strategy` is provided, it is also shallow-merged into strategy.json.
 */
export function stateWrite(
  runId: string,
  patch: z.infer<typeof RunStatePatchSchema>,
  missionId?: string
): Record<string, unknown> {
  const paths = ensureRunDirs(runId, missionId);

  // Merge patch into current state (field-level replace)
  const current = readRunState(paths.runStatePath, runId);
  const { strategy: strategyDelta, ...statePatch } = patch;

  const updated: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(statePatch)) {
    if (v !== undefined) {
      updated[k] = v;
    }
  }
  writeRunState(paths.runStatePath, updated);

  // If a strategy delta is provided, shallow-merge it into strategy.json
  if (strategyDelta && Object.keys(strategyDelta).length > 0) {
    let currentStrategy: Record<string, unknown> = {};
    if (existsSync(paths.strategyPath)) {
      try {
        currentStrategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
      } catch {
        // corrupt strategy.json — start fresh
      }
    }
    const updatedStrategy = { ...currentStrategy, ...strategyDelta };
    const strategyTmpPath = `${paths.strategyPath}.tmp`;
    writeFileSync(strategyTmpPath, JSON.stringify(updatedStrategy, null, 2), "utf8");
    renameSync(strategyTmpPath, paths.strategyPath);
  }

  return updated;
}

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerStateTools(server: McpServer): void {
  // ── evor_state_read ────────────────────────────────────────────────────────
  server.tool(
    "evor_state_read",
    "Read .evor/runs/<mission>/<run-id>/run-state.json and return the current RunState.",
    {
      run_id: z.string().describe("Active run identifier"),
    },
    async ({ run_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const state = stateRead(run_id, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(state),
          },
        ],
      };
    }
  );

  // ── evor_state_write ───────────────────────────────────────────────────────
  server.tool(
    "evor_state_write",
    "Merge-patch run-state.json with the given fields; if strategy is provided, merge it into strategy.json.",
    {
      run_id: z.string().describe("Active run identifier"),
      patch: RunStatePatchSchema.describe("Fields to merge into run-state.json"),
    },
    async ({ run_id, patch }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const updated = stateWrite(run_id, patch, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, run_id, state: updated }),
          },
        ],
      };
    }
  );
}
