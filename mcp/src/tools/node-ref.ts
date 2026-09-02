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
/**
 * Resolve a ref, or return null when no node claims it.
 *
 * Two different questions hide behind one function name, and conflating them is
 * how the strict version broke five reporting tests:
 *
 *   "What is the canonical id for this ref?"  — an unregistered ref has NO
 *     answer, and returning `ref` mints a second identity. That is O-01, and
 *     `resolveNodeRef` throws.
 *
 *   "Does this node have artifacts?"          — for a ref no node claims, the
 *     honest answer is "no results, no telemetry", not an exception. A reporting
 *     function that crashes on an unknown node is less useful than one that says
 *     it found nothing.
 *
 * Readers use this; writers use `resolveNodeRef`.
 */
export function tryResolveNodeRef(runId: string, ref: string, missionId?: string): string | null {
  try {
    return resolveNodeRef(runId, ref, missionId);
  } catch {
    return null;
  }
}

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

  // ── 4. Unresolvable — REFUSE (item 1.5, finding O-01) ────────────────────
  //
  // This returned `ref` unchanged. That fail-open is how a second node identity
  // gets minted: an unregistered slug resolves "successfully" to itself, a
  // writer then creates `nodes/<slug>/`, and the node now exists under two names
  // with no registry entry tying them together. Integrity check 5 looked under
  // the UUID, found nothing, and failed a node with 12,000 well-formed telemetry
  // records — a verdict that stood as the run's final word.
  //
  // Failing loudly here is the difference between "I do not know this node" and
  // "this node is bad". Callers that legitimately handle an unknown ref catch
  // this — `addCitation` records a pending citation rather than inventing a node.
  // An EMPTY tree is not a registry that excludes this ref — it is the absence of
  // a registry. Setup and pre-first-node flows legitimately resolve a name before
  // any node is recorded, and refusing there would turn "nothing has happened
  // yet" into an error. Absence is not a verdict, which is 1.4's rule pointed at
  // identity instead of liveness.
  if (Object.keys(nodes).length === 0) return ref;

  throw new Error(
    `node '${ref}' is not in this run's tree. Check the name with evor_tree_read. ` +
    `The tree lists ${Object.keys(nodes).length} node(s) and none of them claims this ` +
    `reference; resolving it to itself would mint a second identity for a node that ` +
    `already has one, which is how a node's telemetry becomes invisible to the gate ` +
    `that scores it.`,
  );
}

/**
 * Reverse-resolve a node id to its readable name.
 *
 * Resolution order:
 *   1. Node exists and has a `name` set → return it.
 *   2. Node exists but has no name → derive a readable fallback from
 *      approach_family + 1-based ordinal within the same family (never
 *      surfaces the UUID).
 *   3. Node not found / tree unreadable → return `id` unchanged (fail-open).
 *
 * @returns a human-readable name, or the original id when unresolvable.
 */
export function nameForId(runId: string, id: string, missionId?: string): string {
  if (!id) return id;

  let nodes: Record<string, TreeNode>;
  try {
    nodes = readTree(runId, missionId);
  } catch {
    return id; // fail-open
  }

  const node = nodes[id];
  if (!node) return id; // not found — fail-open

  if (node.name) return node.name;

  // Derive readable fallback: approach_family + 1-based ordinal within family
  const base = (node.approach_family || "node").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const sameFamily = Object.values(nodes).filter(
    (n) => n && n.approach_family === node.approach_family,
  );
  const pos = sameFamily.findIndex((n) => n && n.id === id);
  return `${base}-${pos + 1}`;
}

/**
 * Batch reverse-resolution: maps an array of node ids to readable names.
 * Loads the tree once and resolves each id. Same fail-open contract as nameForId.
 *
 * @returns array of names in the same order as the input ids.
 */
export function namesForIds(runId: string, ids: string[], missionId?: string): string[] {
  if (ids.length === 0) return [];

  let nodes: Record<string, TreeNode>;
  try {
    nodes = readTree(runId, missionId);
  } catch {
    return ids.slice(); // fail-open: return ids unchanged
  }

  return ids.map((id) => {
    const node = nodes[id];
    if (!node) return id; // not found — fail-open
    if (node.name) return node.name;
    const base = (node.approach_family || "node").toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const sameFamily = Object.values(nodes).filter(
      (n) => n && n.approach_family === node.approach_family,
    );
    const pos = sameFamily.findIndex((n) => n && n.id === id);
    return `${base}-${pos + 1}`;
  });
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
