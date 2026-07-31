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
import { integrityCheck } from "./integrity.js";
import { resolveNodeRef, assignUniqueName, deriveName } from "./node-ref.js";

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
 * Fill server-owned bookkeeping fields on a node before persisting.
 * These are fields the agent must never fabricate — server derives them from
 * context (parent tree, current time, parent count) and fills any missing values.
 *
 * Mutates the node in-place. Called by recordNode so the fill applies whether
 * the caller is the MCP tool handler or a test calling recordNode directly.
 */
export function fillNodeBookkeeping(node: TreeNode, runId: string, missionId?: string): void {
  if (!node.created_at) node.created_at = new Date().toISOString();
  if (node.visit_count === undefined || node.visit_count === null) node.visit_count = 0;
  if (node.integrity_status === undefined) node.integrity_status = "pending";
  if (node.status === undefined) node.status = "pending";
  if (!node.lesson_ids) node.lesson_ids = [];
  const parentCount = node.parent_ids.length;
  if (node.is_crossover === undefined) node.is_crossover = parentCount > 1;
  // depth: 0 for roots; parentDepth+1 for children (read parent from tree if possible).
  if (node.depth === undefined || node.depth === null) {
    if (parentCount === 0) {
      node.depth = 0;
    } else {
      try {
        const nodes = readTree(runId, missionId);
        const primaryParentId = node.parent_ids[0];
        const parentNode = primaryParentId ? nodes[primaryParentId] : undefined;
        node.depth = parentNode ? (parentNode.depth ?? 0) + 1 : 1;
      } catch {
        node.depth = 1;
      }
    }
  }
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

  // Fill server-owned bookkeeping before persisting (agent must never fabricate these).
  fillNodeBookkeeping(node, runId, missionId);

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
 * Write results.json for a node and atomically trigger the integrity bridge (P1-1).
 *
 * Uses integrityCheck() — the same path as evor_integrity_check — so P1-11 eval paths
 * are resolved and the P2-2 evalVersionCache is populated. Returns the full IntegrityReport
 * inline, so the orchestrator never needs a separate evor_integrity_check call for the
 * normal eval flow.
 */
/**
 * Propagate a completed evaluation's fitness into run-state's `best_score`.
 *
 * Nothing did this before, so `best_score` stayed at its initial null and
 * `harness/evor/tree.py:701` read it as 0.0 — making BOTH score-based stop
 * conditions unreachable:
 *   beat-baseline: 0.0 > baseline_value   never true
 *   target:        0.0 >= target_value    never true
 * An evolutionary search that cannot recognise success runs to max_iterations
 * regardless of what it finds.
 *
 * P3: only an integrity-PASSED node may move the score. A failed — or merely
 * unchecked — node setting best_score would let a cheating candidate define the
 * mission's own success criterion, which is exactly what the integrity gate
 * exists to prevent. Absence of a failure verdict is not evidence of integrity.
 */
export function updateBestScore(
  runId: string,
  nodeId: string,
  result: unknown,
  integrityVerdict: string | null,
  missionId?: string,
): void {
  if (integrityVerdict !== "passed") return;

  try {
    const paths = resolveRunPaths(runId, missionId);

    // The primary metric is declared in the contract; a secondary metric that
    // happens to score higher must never be mistaken for fitness.
    const contractPath = join(paths.runDir, "goal-contract.json");
    if (!existsSync(contractPath)) return;
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    const primary = (contract?.metric_specs ?? []).find(
      (m: Record<string, unknown>) => m?.role === "primary_fitness",
    );
    if (!primary?.metric_name) return;

    const metrics = (result as Record<string, unknown> | null)?.metrics as
      | Record<string, unknown>
      | undefined;
    const value = metrics?.[primary.metric_name as string];
    if (typeof value !== "number" || Number.isNaN(value)) return;

    const runStatePath = join(paths.runDir, "run-state.json");
    const state = readRunState(runStatePath, runId);
    const current = state.best_score;
    const lowerIsBetter = primary.direction === "lower";

    const improves =
      typeof current !== "number"
        ? true
        : lowerIsBetter
          ? value < current
          : value > current;
    if (!improves) return;

    state.best_score = value;
    state.best_node_id = nodeId;
    writeRunState(runStatePath, state);
  } catch {
    // Non-fatal: a bookkeeping failure must not sink a completed evaluation.
    // The score is recoverable from results.json; the eval is not.
  }
}

export function recordEval(
  runId: string,
  nodeId: string,
  result: unknown,
  missionId?: string
): {
  resultsPath: string;
  integrityVerdict: string | null;
  integrityError: string | null;
  integrityReport: unknown | null;
} {
  const paths = resolveRunPaths(runId, missionId);
  const nodeDir = join(paths.nodesDir, nodeId);

  if (!existsSync(nodeDir)) {
    mkdirSync(nodeDir, { recursive: true });
  }

  const resultsPath = join(nodeDir, "results.json");
  writeFileSync(resultsPath, JSON.stringify(result, null, 2), "utf8");

  // P1-1: atomic integrity check — same call path as evor_integrity_check tool.
  // Resolves eval-script/split-path via P1-11 and seeds P2-2 cache on first call.
  // Failures are non-fatal (best-effort); orchestrator can re-check explicitly.
  let integrityVerdict: string | null = null;
  let integrityError: string | null = null;
  let integrityReport: unknown | null = null;

  const integrityResult = integrityCheck(runId, nodeId, missionId);
  if (integrityResult.ok && integrityResult.report != null) {
    const report = integrityResult.report as Record<string, unknown>;
    integrityVerdict = typeof report.verdict === "string" ? report.verdict : null;
    integrityReport = integrityResult.report;
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

  // Stage 1.7: propagate fitness so the score-based stop conditions can fire.
  updateBestScore(runId, nodeId, result, integrityVerdict, missionId);

  return { resultsPath, integrityVerdict, integrityError, integrityReport };
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
    return {
      ok: false,
      error: "no evaluation result for this node yet — confirm it finished with evor_run_status (state='done') before reading.",
    };
  }
  try {
    const data = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    return { ok: true, data };
  } catch {
    return { ok: false, error: "the node's evaluation result is present but could not be parsed." };
  }
}

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerRecordTools(server: McpServer): void {
  // ── evor_record_node ───────────────────────────────────────────────────────
  // Name-only surface: the agent identifies nodes by a readable `name` it coins
  // (e.g. "immune-memory-02"). The server owns the internal id entirely — it is
  // never accepted from, nor returned to, the agent. This keeps opaque ids out of
  // the agent's context so it never fabricates or carries one.
  const RecordNodeInputSchema = TreeNodeSchema.omit({ id: true }).extend({
    name: z.string().optional().describe(
      "Readable node name you coin, e.g. 'immune-memory-02'. Reused in every later "
      + "call (evor_record_eval/run_start/read_result). Auto-derived from approach_family "
      + "if omitted. Name parents in `parent_ids` by their names too.",
    ),
  });
  server.tool(
    "evor_record_node",
    "Call BEFORE evor_record_eval. Record a candidate node in the evolution tree, "
    + "identified by a readable `name` you coin (e.g. 'immune-memory-02'). Reference its "
    + "parents in `parent_ids` by their names. Returns {ok, name} — use that name in every "
    + "later node call; you never handle an internal id.",
    {
      run_id: z.string().describe("Active run identifier"),
      node: RecordNodeInputSchema.describe("Candidate node; identify it by `name` (no id — the server owns that)"),
    },
    async ({ run_id, node }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      // Server always mints the internal id — never accepted from the agent.
      const filledNode = fillNodeId(node as Partial<TreeNode> & Omit<TreeNode, "id">);
      // Name-only surface: ensure a readable, unique name so we never expose the id.
      //  - agent-supplied name → uniquify (auto-suffix on collision, decision #1)
      //  - omitted → derive from approach_family so the response is still name-based
      filledNode.name = filledNode.name
        ? assignUniqueName(run_id, filledNode.name, missionId)
        : deriveName(run_id, filledNode.approach_family, missionId);
      // Resolve parent refs (names) → internal ids (decision #3).
      if (Array.isArray(filledNode.parent_ids)) {
        filledNode.parent_ids = filledNode.parent_ids.map((p) =>
          resolveNodeRef(run_id, p, missionId),
        );
      }
      const { pendingRemaining } = recordNode(run_id, filledNode, missionId);
      return {
        content: [
          {
            type: "text" as const,
            // Return ONLY the name — never the internal id or filesystem path. On
            // collision the name may differ from what was asked; the caller uses
            // THIS value downstream.
            text: JSON.stringify({
              ok: true,
              name: filledNode.name,
              run_id,
              pending_remaining: pendingRemaining,
            }),
          },
        ],
      };
    }
  );

  // ── evor_record_eval ───────────────────────────────────────────────────────
  server.tool(
    "evor_record_eval",
    "Record a node's EvaluationResult and auto-trigger the integrity check. Identify the "
    + "node by the `name` you gave evor_record_node. Always call evor_record_node first. "
    + "Returns {ok, name, status, integrity_verdict, integrity_report}.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe(
        "The node's name (e.g. 'immune-memory-02'), as returned by evor_record_node",
      ),
      result: EvaluationResultSchema.describe("The evaluation result to record"),
    },
    async ({ run_id, node_id, result }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const resolvedId = resolveNodeRef(run_id, node_id, missionId);
      // Server-owned bookkeeping: fill node_id, run_id, eval_version, timestamp
      // so the agent never fabricates or carries these values.
      const filledResult = { ...result } as Record<string, unknown>;
      if (!filledResult.node_id) filledResult.node_id = resolvedId;
      if (!filledResult.run_id) filledResult.run_id = run_id;
      if (!filledResult.timestamp) filledResult.timestamp = new Date().toISOString();
      if (!filledResult.eval_version) {
        // Read eval_version from run-state cache; fall back to "v1".
        try {
          const paths = resolveRunPaths(run_id, missionId);
          const state = readRunState(paths.runStatePath, run_id);
          filledResult.eval_version = typeof state.current_eval_version === "string"
            ? state.current_eval_version
            : "v1";
        } catch {
          filledResult.eval_version = "v1";
        }
      }
      const { integrityVerdict, integrityError, integrityReport } =
        recordEval(run_id, resolvedId, filledResult, missionId);
      return {
        content: [
          {
            type: "text" as const,
            // P1-1: integrity_report is the FULL IntegrityReport inline — the orchestrator
            // never needs a separate evor_integrity_check call for the normal flow.
            // Echo the NAME the caller used, never the internal id or filesystem path.
            text: JSON.stringify({
              ok: true,
              run_id,
              name: node_id,
              status: result.status,
              integrity_verdict: integrityVerdict,
              integrity_error: integrityError,
              integrity_report: integrityReport,
            }),
          },
        ],
      };
    }
  );

  // ── evor_read_result (P2-14) ───────────────────────────────────────────────
  server.tool(
    "evor_read_result",
    "Return a node's full evaluation result. Identify the node by the `name` you gave it. "
    + "This is the only way to read a result — never read files by hand. "
    + "Call after evor_run_status shows state='done'. Returns the full EvaluationResult object.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe(
        "The node's name (e.g. 'immune-memory-02'), as returned by evor_record_node",
      ),
      mission_id: z.string().optional().describe(
        "Mission identifier (resolved from EVOR_MISSION_ID env when omitted)",
      ),
    },
    async ({ run_id, node_id, mission_id }) => {
      const missionId = mission_id ?? process.env.EVOR_MISSION_ID;
      const result = readResult(run_id, resolveNodeRef(run_id, node_id, missionId), missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? JSON.stringify({ ok: true, ...(result.data as Record<string, unknown>) })
              : JSON.stringify({ ok: false, error: result.error }),
          },
        ],
      };
    }
  );
}
