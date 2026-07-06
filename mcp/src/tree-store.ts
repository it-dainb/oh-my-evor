/**
 * tree-store.ts — atomic read/write for tree.json
 *
 * Writes use a rename-swap (write to .tree.json.tmp then rename) to prevent
 * partial-write corruption. Mirrors the refcount write pattern in store.py.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { TreeNode, TreeNodeSchema } from "./contracts.js";
import { resolveRunPaths } from "./run-store.js";
import { withRunLock } from "./lock.js";
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
export function readTree(runId: string, missionId?: string): Record<string, TreeNode> {
  const paths = resolveRunPaths(runId, missionId);
  const treePath = paths.treePath;

  if (!existsSync(treePath)) {
    return {};
  }

  const raw = readFileSync(treePath, "utf8");
  try {
    const parsed = TreeFileSchema.parse(JSON.parse(raw));
    return parsed.nodes;
  } catch (err) {
    throw new Error(`readTree: tree.json is corrupt at ${treePath}: ${err}`);
  }
}

/**
 * Write tree.json atomically using write-to-tmp + rename.
 *
 * 1. Serialise nodes to JSON and write to `<tree>.tmp`
 * 2. Call renameSync — on POSIX this is atomic within the same filesystem
 * 3. Any crash between steps 1 and 2 leaves a `.tmp` file; the next call
 *    to writeTree (or a startup GC pass) will overwrite it harmlessly.
 */
export function writeTree(runId: string, nodes: Record<string, TreeNode>, missionId?: string): void {
  const paths = resolveRunPaths(runId, missionId);
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
 * Upsert a single TreeNode into tree.json.
 *
 * `writeTree` is atomic (temp-file + rename), but the read-modify-write itself is
 * not locked, so a concurrent writer can clobber a just-recorded node. We defend
 * against that by re-reading after each write and retrying if the node did not
 * land — this is what caused a node to silently go missing from tree.json.
 */
export function upsertNode(runId: string, node: TreeNode, missionId?: string): void {
  const paths = resolveRunPaths(runId, missionId);
  withRunLock(paths.runDir, () => {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = readTree(runId, missionId);
      current[node.id] = node;
      writeTree(runId, current, missionId);
      // Verify the node actually persisted (guard against a concurrent clobber).
      try {
        if (readTree(runId, missionId)[node.id]) return;
      } catch {
        // tree momentarily unreadable — retry
      }
    }
    throw new Error(
      `upsertNode: node ${node.id} failed to persist in tree.json after ${MAX_ATTEMPTS} attempts (concurrent clobber detected)`,
    );
  });
}
