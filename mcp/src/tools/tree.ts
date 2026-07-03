/**
 * tools/tree.ts
 * evor_tree_read — read tree.json and return filtered TreeNode list
 * evor_select    — UCB1 selection via python -m evor.tree select subprocess
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TreeNode, StrategyStateSchema } from "../contracts.js";
import { readTree } from "../tree-store.js";
import { resolveRunPaths } from "../run-store.js";
import { callPythonModule } from "../subprocess-bridge.js";
import { readRunState, writeRunState } from "./record.js";

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

/**
 * Read tree.json for `runId` and return a filtered list of TreeNode objects.
 *
 * If `subtreeRoot` is provided, only nodes reachable from that root are
 * returned.  `depth` limits the relative depth below the root (or the
 * absolute `node.depth` when no subtree root is given).
 */
export function treeRead(
  runId: string,
  subtreeRoot?: string,
  depth?: number,
  missionId?: string
): TreeNode[] {
  const nodes = readTree(runId);

  if (subtreeRoot !== undefined) {
    if (!(subtreeRoot in nodes)) {
      return [];
    }
    const childrenMap = buildChildrenMap(nodes);
    const collected = dfsCollect(subtreeRoot, childrenMap, depth);
    return [...collected].map((id) => nodes[id]).filter(Boolean);
  }

  // No subtree root — return all nodes, optionally depth-capped
  const all = Object.values(nodes);
  if (depth === undefined) {
    return all;
  }
  return all.filter((n) => n.depth <= depth);
}

/**
 * Run UCB1 selection via `python -m evor.tree select`.
 * Passes the resolved run directory path (not just the run-id) so tree.py
 * picks it up as a pre-existing directory.
 * Also adds selected IDs to `pending_node_ids` in run-state.json.
 *
 * Returns the selected node IDs plus any UCB1 scores emitted by Python.
 */
export function treeSelect(
  runId: string,
  strategy?: Partial<z.infer<typeof StrategyStateSchema>>,
  count?: number,
  missionId?: string
): { selected: string[]; scores: Record<string, number>; error?: string } {
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
      selected: [],
      scores: {},
      error: pyResult.error ?? "python -m evor.tree select failed",
    };
  }

  const data = pyResult.data as { selected?: string[]; scores?: Record<string, number> };
  const selected = Array.isArray(data.selected) ? data.selected : [];
  const scores = (data.scores && typeof data.scores === "object") ? data.scores : {};

  // Mark selected IDs as pending in run-state.json
  if (selected.length > 0) {
    const state = readRunState(paths.runStatePath, runId);
    const current = Array.isArray(state.pending_node_ids)
      ? (state.pending_node_ids as string[])
      : [];
    const merged = Array.from(new Set([...current, ...selected]));
    state.pending_node_ids = merged;
    writeRunState(paths.runStatePath, state);
  }

  return { selected, scores };
}

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerTreeTools(server: McpServer): void {
  // ── evor_tree_read ─────────────────────────────────────────────────────────
  server.tool(
    "evor_tree_read",
    "Read tree.json for a run, optionally filtered to a subtree rooted at subtree_root up to depth levels.",
    {
      run_id: z.string().describe("Active run identifier"),
      subtree_root: z.string().optional().describe("Node ID to root the subtree at; omit for full tree"),
      depth: z.number().int().positive().optional().describe("Maximum depth to return (omit = unlimited)"),
    },
    async ({ run_id, subtree_root, depth }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const nodes = treeRead(run_id, subtree_root, depth, missionId);
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
    "Run UCB1 (or current strategy) selection: exec `python -m evor.tree select` and return ranked parent node IDs.",
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
