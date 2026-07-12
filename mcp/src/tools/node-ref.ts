/**
 * node-ref.ts — slug-based node references (P2-1 real fix).
 *
 * The pain the auto-UUID fix left behind: the agent still had to CARRY an opaque
 * UUID through record_eval / run_start / integrity_check / read_result. Agents
 * already coin readable candidate slugs (e.g. "immune-memory-02") in the Mutagen
 * proposal — this layer lets every node tool accept EITHER the slug or the UUID,
 * so the agent never juggles a UUID again. UUIDs keep working (back-compat).
 *
 * Design decisions (locked):
 *   1. Collision → auto-suffix + echo back ("immune-memory-02" → "immune-memory-02-2").
 *      The caller uses whatever name is returned by evor_record_node.
 *   2. Sweep arms → sub-identity under the parent slug ("immune-memory-02:b80"),
 *      resolved to the parent node's id (arms are not first-class frontier nodes).
 *   3. Parents → explicit-always, by slug — resolved to ids at record time.
 */

import { readTree } from "../tree-store.js";
import type { TreeNode } from "../contracts.js";

/** A ref is a UUID if it matches the canonical 8-4-4-4-12 hex shape. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(ref: string): boolean {
  return UUID_RE.test(ref);
}

/**
 * Resolve a node reference (slug OR uuid OR "slug:arm") to a concrete node id.
 *
 * Resolution order:
 *   1. Exact id match in tree.json → return it (uuid fast-path).
 *   2. Exact name match → return that node's id.
 *   3. "slug:arm" → strip the arm suffix and resolve the parent slug/id.
 *   4. No match → return the ref UNCHANGED (fail-open): the node may not be
 *      recorded yet, or the caller passed a raw id; downstream tools emit their
 *      own "not found" error rather than this layer masking it.
 *
 * @returns the resolved node id, or the original ref when unresolvable.
 */
export function resolveNodeRef(runId: string, ref: string, missionId?: string): string {
  if (!ref) return ref;

  let nodes: Record<string, TreeNode>;
  try {
    nodes = readTree(runId, missionId);
  } catch {
    return ref; // tree unreadable — fail-open, let downstream report
  }

  // 1. Direct id hit
  if (nodes[ref]) return ref;

  // 2. Name hit
  for (const node of Object.values(nodes)) {
    if (node && node.name === ref) return node.id;
  }

  // 3. Sweep-arm sub-identity: "slug:arm" → resolve the parent portion
  const colon = ref.lastIndexOf(":");
  if (colon > 0) {
    const base = ref.slice(0, colon);
    if (nodes[base]) return base;
    for (const node of Object.values(nodes)) {
      if (node && node.name === base) return node.id;
    }
  }

  // 4. Unresolvable — fail-open
  return ref;
}

/**
 * Derive a readable node name when the agent didn't supply one, so the surface
 * NEVER has to expose a UUID. Uses the approach_family + a short ordinal
 * ("training-1", "arch-2"), uniquified against the tree.
 */
export function deriveName(
  runId: string,
  approachFamily: string,
  missionId?: string,
): string {
  const base = (approachFamily || "node").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  let nodes: Record<string, TreeNode> = {};
  try {
    nodes = readTree(runId, missionId);
  } catch {
    /* empty tree */
  }
  const count = Object.values(nodes).filter(
    (n) => n && typeof n.name === "string" && n.name.startsWith(`${base}-`),
  ).length;
  return assignUniqueNameIn(nodes, `${base}-${count + 1}`);
}

/** Uniquify a desired name against an already-loaded node map. */
function assignUniqueNameIn(nodes: Record<string, TreeNode>, desired: string): string {
  const taken = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node && node.name) taken.add(node.name);
  }
  if (!taken.has(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Given a desired human name and the current tree, return a unique name by
 * appending -2, -3, … on collision (decision #1). If `desired` is empty, returns "".
 */
export function assignUniqueName(
  runId: string,
  desired: string,
  missionId?: string,
): string {
  if (!desired) return "";
  let nodes: Record<string, TreeNode>;
  try {
    nodes = readTree(runId, missionId);
  } catch {
    return desired;
  }
  const taken = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node && node.name) taken.add(node.name);
  }
  if (!taken.has(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
