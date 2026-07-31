/**
 * tools/tree.ts
 * evor_tree_read — read tree.json and return filtered name-only node list
 * evor_select    — UCB1 selection via python -m evor.tree select subprocess
 *
 * Agent surface is UUID-free: node ids never appear in tool responses.
 * Internal pending_node_ids in run-state.json stays as ids — only the
 * agent-facing output is name-mapped via nameForId / namesForIds.
 *
 * Area 5: evor_tree_read accepts optional filters:
 *   status, integrity_status, approach_family
 * NamedTreeNode now includes integrity_status.
 *
 * A6: ucb1_score / min_score were removed from the agent-facing surface.
 * ucb1_score is a UCB1 selection-time value (a function of visit counts at
 * the instant of selection) that nothing ever populated on TreeNode, so
 * `score` was always undefined and `min_score` always filtered on nothing.
 * fitness_value (populated, stable) is the field agents should rank/filter
 * on instead. harness/evor/tree.py still computes UCB1 internally during
 * select() — that ranking logic is untouched.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TreeNode, StrategyStateSchema } from "../contracts.js";
import { readTree } from "../tree-store.js";
import { resolveRunPaths } from "../run-store.js";
import { callPythonModule } from "../subprocess-bridge.js";
import { readRunState, writeRunState } from "./record.js";
import { nameForId, namesForIds } from "./node-ref.js";

/**
 * Agent-facing node shape: readable names only, no internal UUIDs.
 * parent_names resolves parent_ids via nameForId so the agent can reference
 * parents by name in subsequent calls.
 * integrity_status surfaces the node's integrity gate result (Area 5).
 */
export type NamedTreeNode = {
  name: string;
  status: TreeNode["status"];
  integrity_status: TreeNode["integrity_status"];
  depth: number;
  approach_family: TreeNode["approach_family"];
  // A1: the node's own scoreboard. Undefined whenever integrity_status is
  // "failed" — a cheating candidate must never look like a scored, selectable
  // frontier node just because evor-mutagen forgot to pass the integrity filter.
  metrics?: TreeNode["metrics"];
  fitness_value?: number;
  parent_names: string[];
};

// ── DFS filter helpers ──────────────────────────────────────────────────────

/** Build a children map from parent_ids relationships. */
function buildChildrenMap(nodes: Record<string, TreeNode>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of Object.values(nodes)) {
    for (const parentId of node.parent_ids) {
      if (!children.has(parentId)) {
        children.set(parentId, []);
      }
      children.get(parentId)!.push(node.id);
    }
  }
  return children;
}

/**
 * Collect all node IDs reachable from `rootId` via DFS, up to `maxDepth`
 * levels below the root (0 = root only, undefined = unlimited).
 */
function dfsCollect(
  rootId: string,
  childrenMap: Map<string, string[]>,
  maxDepth: number | undefined
): Set<string> {
  const collected = new Set<string>();
  const queue: Array<{ id: string; relDepth: number }> = [{ id: rootId, relDepth: 0 }];
  while (queue.length > 0) {
    const { id, relDepth } = queue.shift()!;
    if (collected.has(id)) continue;
    collected.add(id);
    if (maxDepth === undefined || relDepth < maxDepth) {
      for (const childId of childrenMap.get(id) ?? []) {
        queue.push({ id: childId, relDepth: relDepth + 1 });
      }
    }
  }
  return collected;
}

// ── Core logic (exported for tests) ────────────────────────────────────────

/** Map a raw TreeNode to the agent-facing name-only shape. */
function toNamedNode(node: TreeNode, runId: string, missionId: string | undefined): NamedTreeNode {
  const scored = node.integrity_status !== "failed";
  return {
    name: nameForId(runId, node.id, missionId),
    status: node.status,
    integrity_status: node.integrity_status,
    depth: node.depth,
    approach_family: node.approach_family,
    metrics: scored ? node.metrics : undefined,
    fitness_value: scored ? node.fitness_value : undefined,
    parent_names: namesForIds(runId, node.parent_ids, missionId),
  };
}

/** Optional filters for treeRead (Area 5). */
export interface TreeReadFilters {
  status?: TreeNode["status"];
  integrity_status?: TreeNode["integrity_status"];
  approach_family?: TreeNode["approach_family"];
}

/**
 * Read tree.json for `runId` and return a filtered list of name-only node
 * objects (no UUIDs surfaced to the agent).
 *
 * If `subtreeRoot` is provided, only nodes reachable from that root are
 * returned.  `depth` limits the relative depth below the root (or the
 * absolute `node.depth` when no subtree root is given).
 *
 * Area 5: optional `filters` applied after depth/subtree filtering.
 */
export function treeRead(
  runId: string,
  subtreeRoot?: string,
  depth?: number,
  missionId?: string,
  filters?: TreeReadFilters
): NamedTreeNode[] {
  const nodes = readTree(runId, missionId);

  let raw: TreeNode[];

  if (subtreeRoot !== undefined) {
    if (!(subtreeRoot in nodes)) {
      return [];
    }
    const childrenMap = buildChildrenMap(nodes);
    const collected = dfsCollect(subtreeRoot, childrenMap, depth);
    raw = [...collected].map((id) => nodes[id]).filter(Boolean) as TreeNode[];
  } else {
    // No subtree root — return all nodes, optionally depth-capped
    const all = Object.values(nodes) as TreeNode[];
    raw = depth === undefined ? all : all.filter((n) => n.depth <= depth);
  }

  // Apply optional post-filters (Area 5)
  if (filters) {
    if (filters.status !== undefined) {
      raw = raw.filter((n) => n.status === filters.status);
    }
    if (filters.integrity_status !== undefined) {
      raw = raw.filter((n) => n.integrity_status === filters.integrity_status);
    }
    if (filters.approach_family !== undefined) {
      raw = raw.filter((n) => n.approach_family === filters.approach_family);
    }
  }

  return raw.map((n) => toNamedNode(n, runId, missionId));
}

/**
 * Run UCB1 selection via `python -m evor.tree select`.
 * Passes the resolved run directory path (not just the run-id) so tree.py
 * picks it up as a pre-existing directory.
 * Also adds selected IDs to `pending_node_ids` in run-state.json.
 *
 * Returns selected_names (readable, no UUIDs) plus any UCB1 scores emitted by
 * Python. Internal pending_node_ids remains stored as ids — only the
 * agent-facing response is name-mapped.
 */
export function treeSelect(
  runId: string,
  strategy?: Partial<z.infer<typeof StrategyStateSchema>>,
  count?: number,
  missionId?: string
): { selected_names: string[]; scores: Record<string, number>; error?: string } {
  const paths = resolveRunPaths(runId, missionId);

  const args = [
    "select",
    "--run-id", paths.runDir,
    "--count", String(count ?? 1),
  ];
  if (strategy && Object.keys(strategy).length > 0) {
    args.push("--strategy", JSON.stringify(strategy));
  }

  const pyResult = callPythonModule("evor.tree", args);
  if (!pyResult.ok || pyResult.data == null) {
    return {
      selected_names: [],
      scores: {},
      error: pyResult.error ?? "evor_select failed",
    };
  }

  const data = pyResult.data as { selected?: string[]; scores?: Record<string, number> };
  const selected = Array.isArray(data.selected) ? data.selected : [];
  const scores = (data.scores && typeof data.scores === "object") ? data.scores : {};

  // Mark selected IDs as pending in run-state.json (internal ids, not names)
  if (selected.length > 0) {
    const state = readRunState(paths.runStatePath, runId);
    const current = Array.isArray(state.pending_node_ids)
      ? (state.pending_node_ids as string[])
      : [];
    const merged = Array.from(new Set([...current, ...selected]));
    state.pending_node_ids = merged;
    writeRunState(paths.runStatePath, state);
  }

  // Map ids → readable names for the agent-facing response
  const selected_names = namesForIds(runId, selected, missionId);

  return { selected_names, scores };
}

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerTreeTools(server: McpServer): void {
  // ── evor_tree_read ─────────────────────────────────────────────────────────
  server.tool(
    "evor_tree_read",
    "Read the evolution tree for a run, optionally filtered to a subtree rooted at subtree_root up to depth levels. " +
    "Optional filters: status, integrity_status, approach_family (all applied after depth/subtree filter). " +
    "Each NamedTreeNode includes integrity_status for downstream gate checks and fitness_value/metrics for ranking.",
    {
      run_id: z.string().describe("Active run identifier"),
      subtree_root: z.string().optional().describe("Node ID to root the subtree at; omit for full tree"),
      depth: z.number().int().positive().optional().describe("Maximum depth to return (omit = unlimited)"),
      status: z.enum(["pending", "running", "done", "pruned", "failed"]).optional().describe(
        "Filter: only return nodes with this status"
      ),
      integrity_status: z.enum(["passed", "failed", "pending"]).optional().describe(
        "Filter: only return nodes with this integrity_status; nodes lacking integrity_status are excluded"
      ),
      approach_family: z.enum([
        "arch", "training", "data-curation", "data-augmentation",
        "data-acquisition", "algo", "other",
      ]).optional().describe(
        "Filter: only return nodes from this approach family"
      ),
    },
    async ({ run_id, subtree_root, depth, status, integrity_status, approach_family }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const filters: TreeReadFilters = {};
      if (status !== undefined) filters.status = status as TreeNode["status"];
      if (integrity_status !== undefined) filters.integrity_status = integrity_status as TreeNode["integrity_status"];
      if (approach_family !== undefined) filters.approach_family = approach_family as TreeNode["approach_family"];
      const nodes = treeRead(run_id, subtree_root, depth, missionId, filters);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ run_id, nodes, subtree_root, depth }),
          },
        ],
      };
    }
  );

  // ── evor_select ────────────────────────────────────────────────────────────
  server.tool(
    "evor_select",
    "Select the next parent node(s) to expand by the active policy (UCB1 by default); returns ranked parent node names.",
    {
      run_id: z.string().describe("Active run identifier"),
      strategy: StrategyStateSchema.partial().optional().describe("Strategy overrides for this selection"),
      count: z.number().int().positive().optional().describe("Number of parent nodes to select (default 1)"),
    },
    async ({ run_id, strategy, count }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = treeSelect(run_id, strategy, count, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ run_id, ...result }),
          },
        ],
      };
    }
  );
}
