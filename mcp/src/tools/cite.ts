/**
 * tools/cite.ts
 * evor_cite — append a citation string to the TreeNode's citations[] field
 *             in tree.json (enforces the citation-backed mandate).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTree } from "../tree-store.js";
import { upsertNode } from "../tree-store.js";
import { resolveNodeRef } from "./node-ref.js";

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Append `citation` to `node.citations[]` in tree.json for the given node.
 * Accepts a node name or UUID; resolves to the node's id via resolveNodeRef.
 * Returns the updated citations array, or an error if the node is not found.
 */
export function addCitation(
  runId: string,
  nodeId: string,
  citation: string,
  missionId?: string
): { ok: boolean; citations?: string[]; error?: string } {
  const resolvedId = resolveNodeRef(runId, nodeId, missionId);
  const nodes = readTree(runId, missionId);
  const node = nodes[resolvedId];

  if (!node) {
    return { ok: false, error: `node '${nodeId}' not found in this run's tree — check the name with evor_tree_read.` };
  }

  // Deduplicate: only append if not already present
  if (node.citations.includes(citation)) {
    return { ok: true, citations: node.citations };
  }

  const updated = { ...node, citations: [...node.citations, citation] };
  upsertNode(runId, updated, missionId);

  return { ok: true, citations: updated.citations };
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerCiteTools(server: McpServer): void {
  server.tool(
    "evor_cite",
    "Append a citation (bib entry, arXiv URL, or dataset URL) to a node's citations. Identify the node by name.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("The node's name (e.g. 'immune-memory-02')"),
      citation: z.string().min(1).describe("Citation string: bib entry, arXiv URL, or dataset URL"),
    },
    async ({ run_id, node_id, citation }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = addCitation(run_id, node_id, citation, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ run_id, node_id, citation, ...result }),
          },
        ],
      };
    }
  );
}
