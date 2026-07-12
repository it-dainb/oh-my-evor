/**
 * tools/record.ts
 * evor_record_node — validate TreeNode + atomic-write tree.json
 * evor_record_eval — write EvaluationResult + auto-trigger integrity check
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
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
 * Fill node.id with a fresh UUID if the caller omitted it (P2-1).
 * The internal TreeNode type still requires id; callers that construct nodes
 * programmatically can skip the shell-out to `python -c "import uuid; …"`.
 */
export function fillNodeId(node: Partial<TreeNode> & Omit<TreeNode, "id">): TreeNode {
  if (!node.id) {
    return { ...node, id: randomUUID() } as TreeNode;
  }
  return node as TreeNode;
}

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

  // Cascade status → "done" and write integrity_status back to tree.json.
  // Without this, tree nodes stay status="running" forever after Forge writes results —
  // the orchestrator had to call evor_record_node 4+ extra times per run to fix it (P0-5).
  try {
    const nodes = readTree(runId, missionId);
    const node = nodes[nodeId];
    if (node) {
      const updates: Partial<TreeNode> = { status: "done" };
      if (integrityVerdict === "passed" || integrityVerdict === "failed") {
        updates.integrity_status = integrityVerdict as "passed" | "failed";
      }
      upsertNode(runId, { ...node, ...updates }, missionId);
    }
  } catch {
    // Non-fatal: if tree.json cannot be updated the run continues; the
    // orchestrator can re-check integrity explicitly via evor_integrity_check.
  }

  return { resultsPath, integrityVerdict, integrityError };
}

/**
 * Read nodes/<nodeId>/results.json and return parsed JSON (P2-14).
 * Eliminates the orchestrator's "cat results.json" shell-out turn.
 * Call after evor_run_status shows state='done'.
 */
export function readResult(
  runId: string,
  nodeId: string,
  missionId?: string,
): { ok: boolean; data?: unknown; error?: string } {
  const paths = resolveRunPaths(runId, missionId);
  const resultPath = join(paths.nodesDir, nodeId, "results.json");
  if (!existsSync(resultPath)) {
    return { ok: false, error: `results.json not found at ${resultPath}` };
  }
  try {
    const data = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `Failed to parse results.json: ${String(e)}` };
  }
}

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerRecordTools(server: McpServer): void {
  // ── evor_record_node ───────────────────────────────────────────────────────
  // node.id is optional here so callers can omit it — fillNodeId auto-generates
  // a UUID (P2-1), saving the orchestrator a shell-out turn per node.
  const RecordNodeInputSchema = TreeNodeSchema.extend({
    id: z.string().uuid().optional().describe(
      "Node UUID; auto-generated if omitted (saves a shell-out to python -c 'import uuid; …')",
    ),
  });
  server.tool(
    "evor_record_node",
    "Call BEFORE evor_record_eval. Validate a TreeNode against the Zod schema and atomically "
    + "upsert it into tree.json. node.id is optional — a UUID is auto-generated when omitted "
    + "(no shell-out to python -c 'import uuid' needed). Returns {ok, node_id, pending_remaining}.",
    {
      run_id: z.string().describe("Active run identifier"),
      node: RecordNodeInputSchema.describe("TreeNode to record (id is optional; auto-generated if absent)"),
    },
    async ({ run_id, node }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      // Auto-fill id before passing to recordNode (which expects a full TreeNode)
      const filledNode = fillNodeId(node as Partial<TreeNode> & Omit<TreeNode, "id">);
      const { pendingRemaining, treePath } = recordNode(run_id, filledNode, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              node_id: filledNode.id,
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
    "Write an EvaluationResult to nodes/<node_id>/results.json and auto-trigger "
    + "evor_integrity_check. Always call evor_record_node first so the tree has the node. "
    + "Returns {ok, results_path, integrity_verdict, integrity_error}.",
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

  // ── evor_read_result (P2-14) ───────────────────────────────────────────────
  server.tool(
    "evor_read_result",
    "Read nodes/<node_id>/results.json and return parsed JSON. "
    + "Eliminates the need to shell out 'cat results.json' or read artifact paths manually. "
    + "Call after evor_run_status shows state='done'. Returns the full EvaluationResult object.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("Node identifier returned by evor_record_node"),
      mission_id: z.string().optional().describe(
        "Mission identifier (resolved from EVOR_MISSION_ID env when omitted)",
      ),
    },
    async ({ run_id, node_id, mission_id }) => {
      const missionId = mission_id ?? process.env.EVOR_MISSION_ID;
      const result = readResult(run_id, node_id, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? JSON.stringify(result.data)
              : JSON.stringify({ error: result.error }),
          },
        ],
      };
    }
  );
}
