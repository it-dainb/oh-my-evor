/**
 * tree-store.ts — atomic read/write for tree.json
 *
 * Writes use a rename-swap (write to .tree.json.tmp then rename) to prevent
 * partial-write corruption. Mirrors the refcount write pattern in store.py.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { TreeNode, TreeNodeSchema } from "./contracts.js";
import { resolveRunPaths } from "./run-store.js";
import { z } from "zod";

const TreeFileSchema = z.object({
  nodes: z.record(z.string(), TreeNodeSchema),
  updated_at: z.string(),
});
type TreeFile = z.infer<typeof TreeFileSchema>;

/**
 * Read tree.json for the given run. Returns an empty node map if the file
 * does not exist yet (first write scenario).
 */
export function readTree(runId: string): Record<string, TreeNode> {
  const paths = resolveRunPaths(runId);
  const treePath = paths.treePath;

  if (!existsSync(treePath)) {
    return {};
  }

  const raw = readFileSync(treePath, "utf8");
  const parsed = TreeFileSchema.parse(JSON.parse(raw));
  return parsed.nodes;
}

/**
 * Write tree.json atomically using write-to-tmp + rename.
 *
 * 1. Serialise nodes to JSON and write to `<tree>.tmp`
 * 2. Call renameSync — on POSIX this is atomic within the same filesystem
 * 3. Any crash between steps 1 and 2 leaves a `.tmp` file; the next call
 *    to writeTree (or a startup GC pass) will overwrite it harmlessly.
 */
export function writeTree(runId: string, nodes: Record<string, TreeNode>): void {
  const paths = resolveRunPaths(runId);
  const treePath = paths.treePath;
  const tmpPath = paths.treeTmpPath;

  // Ensure the run directory exists before writing
  const dir = dirname(treePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const treeFile: TreeFile = {
    nodes,
    updated_at: new Date().toISOString(),
  };

  writeFileSync(tmpPath, JSON.stringify(treeFile, null, 2), "utf8");
  renameSync(tmpPath, treePath);
}

/**
 * Upsert a single TreeNode into tree.json atomically.
 * Reads current tree, merges the node, writes back.
 */
export function upsertNode(runId: string, node: TreeNode): void {
  const current = readTree(runId);
  current[node.id] = node;
  writeTree(runId, current);
}
