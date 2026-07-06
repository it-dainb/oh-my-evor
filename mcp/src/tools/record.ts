/**
 * tools/record.ts
 * evor_record_node — validate TreeNode + atomic-write tree.json
 * evor_record_eval — write EvaluationResult + auto-trigger integrity check
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TreeNode, TreeNodeSchema, EvaluationResultSchema } from "../contracts.js";
import { readTree, upsertNode } from "../tree-store.js";
import { ensureRunDirs, resolveRunPaths } from "../run-store.js";
import { callBridge } from "../subprocess-bridge.js";

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Read run-state.json; return parsed object or a fresh default. */
export function readRunState(runStatePath: string, runId: string): Record<string, unknown> {
  if (!existsSync(runStatePath)) {
    return {
      run_id: runId,
      status: "running",
      tick_count: 0,
      best_score: null,
      frontier_ids: [],
      current_eval_version: "v1",
      pending_node_ids: [],
    };
  }
  try {
    return JSON.parse(readFileSync(runStatePath, "utf8"));
  } catch {
    return {
      run_id: runId,
      status: "running",
      tick_count: 0,
      best_score: null,
      frontier_ids: [],
      current_eval_version: "v1",
      pending_node_ids: [],
    };
  }
}

/** Write run-state.json atomically using write-to-tmp + rename. */
export function writeRunState(runStatePath: string, state: Record<string, unknown>): void {
  const tmpPath = `${runStatePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpPath, runStatePath);
}

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Record a TreeNode into tree.json, clear it from pending_node_ids, and
 * append a one-liner to decision-log.md.
 */
export function recordNode(runId: string, node: TreeNode, missionId?: string): {
  pendingRemaining: number;
  treePath: string;
} {
  const paths = ensureRunDirs(runId, missionId);

  // 1. Atomically upsert node into tree.json
  upsertNode(runId, node, missionId);

  // 2. Append a brief record entry to decision-log.md
  const logLine = [
    `\n## record ${new Date().toISOString()}`,
    `- node_id: ${node.id}`,
    `- approach_family: ${node.approach_family}`,
    `- status: ${node.status}`,
    `- depth: ${node.depth}`,
    "",
  ].join("\n");
  appendFileSync(paths.decisionLogPath, logLine, "utf8");

  // 3. Remove node.id from pending_node_ids
  const state = readRunState(paths.runStatePath, runId);
  const pending = Array.isArray(state.pending_node_ids)
    ? (state.pending_node_ids as string[]).filter((id) => id !== node.id)
    : [];
  state.pending_node_ids = pending;
  writeRunState(paths.runStatePath, state);

  return { pendingRemaining: pending.length, treePath: paths.treePath };
}

/**
 * Write results.json for a node and trigger the integrity bridge (best-effort).
 * Returns the integrity verdict if the bridge ran successfully, otherwise null.
 */
export function recordEval(
  runId: string,
  nodeId: string,
  result: unknown,
  missionId?: string
): { resultsPath: string; integrityVerdict: string | null; integrityError: string | null } {
  const paths = resolveRunPaths(runId, missionId);
  const nodeDir = join(paths.nodesDir, nodeId);

  if (!existsSync(nodeDir)) {
    mkdirSync(nodeDir, { recursive: true });
  }

  const resultsPath = join(nodeDir, "results.json");
  writeFileSync(resultsPath, JSON.stringify(result, null, 2), "utf8");

  // Auto-trigger integrity check; failures are non-fatal (best-effort)
  let integrityVerdict: string | null = null;
  const bridgeArgs = [
    "--run-id", runId,
    "--node-id", nodeId,
    "--run-dir", paths.runDir,
  ];
  let integrityError: string | null = null;
  const integrityResult = callBridge("integrity_bridge.py", bridgeArgs);
  if (integrityResult.ok && integrityResult.data != null) {
    const report = integrityResult.data as Record<string, unknown>;
    integrityVerdict = typeof report.verdict === "string" ? report.verdict : null;
  } else if (!integrityResult.ok) {
    // Surface WHY the bridge failed (e.g. "Node X not found in tree.json") so the
    // orchestrator can act (record the node first) instead of a silent, un-diagnosable
    // null. This is what turned a missing-node into a ~30-min manual debug detour.
    integrityError = integrityResult.error ?? "integrity bridge failed";
  }

  // Write the integrity verdict back to the node's integrity_status field in tree.json.
  // Without this, tree.json nodes stay "pending" forever even after the gate runs.
  if (integrityVerdict === "passed" || integrityVerdict === "failed") {
    try {
      const nodes = readTree(runId, missionId);
      const node = nodes[nodeId];
      if (node) {
        upsertNode(runId, {
          ...node,
          integrity_status: integrityVerdict as "passed" | "failed",
        }, missionId);
      }
    } catch {
      // Non-fatal: if tree.json cannot be updated the run continues; the
      // orchestrator can re-check integrity explicitly via evor_integrity_check.
    }
  }

  return { resultsPath, integrityVerdict, integrityError };
}

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerRecordTools(server: McpServer): void {
  // ── evor_record_node ───────────────────────────────────────────────────────
  server.tool(
    "evor_record_node",
    "Validate a TreeNode against the Zod schema and atomically write it into tree.json for the given run.",
    {
      run_id: z.string().describe("Active run identifier"),
      node: TreeNodeSchema.describe("TreeNode to record"),
    },
    async ({ run_id, node }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const { pendingRemaining, treePath } = recordNode(run_id, node, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              node_id: node.id,
              run_id,
              pending_remaining: pendingRemaining,
              tree_path: treePath,
            }),
          },
        ],
      };
    }
  );

  // ── evor_record_eval ───────────────────────────────────────────────────────
  server.tool(
    "evor_record_eval",
    "Write an EvaluationResult to nodes/<id>/results.json and auto-trigger evor_integrity_check.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("Node being evaluated"),
      result: EvaluationResultSchema.describe("EvaluationResult to record"),
    },
    async ({ run_id, node_id, result }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const { resultsPath, integrityVerdict, integrityError } = recordEval(run_id, node_id, result, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              run_id,
              node_id,
              status: result.status,
              results_path: resultsPath,
              integrity_verdict: integrityVerdict,
              integrity_error: integrityError,
            }),
          },
        ],
      };
    }
  );
}
