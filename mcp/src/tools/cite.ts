/**
 * tools/cite.ts
 * evor_cite — append a citation string to the TreeNode's citations[] field
 *             in tree.json (enforces the citation-backed mandate).
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTree } from "../tree-store.js";
import { upsertNode } from "../tree-store.js";
import { resolveNodeRef } from "./node-ref.js";
import { resolveRunId } from "../active-run.js";
import { err } from "../tool-result.js";
import { ensureRunDirs } from "../run-store.js";

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Append `citation` to `node.citations[]` in tree.json for the given node.
 * Accepts a node name or UUID; resolves to the node's id via resolveNodeRef.
 * Returns the updated citations array, or an error if the node is not found.
 */
/**
 * Citations recorded against a reference that has no node yet (item 5.1).
 *
 * Written to `<runDir>/pending-citations.json`, keyed by the reference the agent
 * used — an angle slug for Sage, which is the only role the mandate ever bound.
 * They accumulate rather than overwrite, because a research angle collects
 * several sources and a citation that evaporates records nothing.
 */
function appendPendingCitation(
  runId: string,
  ref: string,
  citation: string,
  missionId?: string,
): { ok: boolean; citations?: string[]; pending?: boolean; error?: string } {
  try {
    const paths = ensureRunDirs(runId, missionId);
    const file = join(paths.runDir, "pending-citations.json");
    let store: Record<string, string[]> = {};
    if (existsSync(file)) {
      try { store = JSON.parse(readFileSync(file, "utf8")); } catch { store = {}; }
    }
    const existing = Array.isArray(store[ref]) ? store[ref] : [];
    const citations = existing.includes(citation) ? existing : [...existing, citation];
    store[ref] = citations;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    renameSync(tmp, file);
    return { ok: true, citations, pending: true };
  } catch (err) {
    return { ok: false, error: `could not record a pending citation for '${ref}': ${String(err)}` };
  }
}

/** Citations recorded against a reference before its node existed. */
export function readPendingCitations(runId: string, missionId?: string): Record<string, string[]> {
  try {
    const file = join(ensureRunDirs(runId, missionId).runDir, "pending-citations.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  } catch {
    return {};
  }
}

export function addCitation(
  runId: string,
  nodeId: string,
  citation: string,
  missionId?: string
): { ok: boolean; citations?: string[]; error?: string } {
  // `resolveNodeRef` now THROWS for a reference no node claims (O-01), rather
  // than resolving it to itself and minting a second identity. That is exactly
  // the case this tool must handle gracefully: Sage cites an angle slug before
  // any node exists, which is not an error — it is the normal shape of the only
  // role the citation mandate binds.
  let resolvedId: string;
  try {
    resolvedId = resolveNodeRef(runId, nodeId, missionId);
  } catch {
    return appendPendingCitation(runId, nodeId, citation, missionId);
  }
  const nodes = readTree(runId, missionId);
  const node = nodes[resolvedId];

  if (!node) {
    // ── N-03a (item 5.1): cite what does not exist yet ────────────────────
    //
    // ALL 18 evor_cite calls in the field run failed, and all 18 came from
    // Sage/Sage-junior. That role runs BEFORE any node exists — r3's tree had
    // zero nodes at the time — and cites its own ANGLE SLUG, not a node. A
    // mandate its only caller can never satisfy is not a mandate; it is dead
    // code that looks enforced, and the citation-backed research requirement
    // recorded nothing at all for a whole mission.
    //
    // So a reference that resolves to no node is recorded as a PENDING citation
    // against that reference, and accumulates. It is deliberately kept separate
    // from node citations rather than inventing a node: a citation about an
    // angle is not a claim about a candidate, and conflating them would put
    // unreviewed research into the tree.
    return appendPendingCitation(runId, nodeId, citation, missionId);
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
      // Optional with an active-run fallback. Required-with-no-default is what
      // produced three identical evor_cite failures in run 29d17abc: the schema
      // gave the model no signal about what was wrong, so it repeated the same
      // bad call. Format hints would only make that more diagnosable; resolving
      // from the active run removes the failure mode entirely (rubric rule 1).
      run_id: z.string().optional().describe("Active run identifier"),
      node_id: z.string().describe("The node's name (e.g. 'immune-memory-02')"),
      citation: z.string().min(1).describe("Citation string: bib entry, arXiv URL, or dataset URL"),
    },
    async ({ run_id: run_id_in, node_id, citation }) => {
      const run_id = resolveRunId(run_id_in);
      if (!run_id) return err("no run_id given and no active run found — start a run or pass run_id explicitly");
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
