/**
 * tests/tree.test.ts
 * Unit tests for tools/tree.ts: treeRead (DFS filter)
 *
 * treeSelect is subprocess-gated (python -m evor.tree) — tested for
 * graceful error handling only (no live Python in test env).
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { treeRead, treeSelect, type NamedTreeNode } from "../src/tools/tree.js";
import { writeTree } from "../src/tree-store.js";
import type { TreeNode } from "../src/contracts.js";

// ── Fixture ──────────────────────────────────────────────────────────────────

function makeNode(id: string, parentIds: string[], depth: number): TreeNode {
  return {
    id,
    parent_ids: parentIds,
    approach_family: "arch",
    hypothesis_id: "h-1",
    code_ref: "sha:abc",
    genome_ref: "sha:genome",
    data_version_ref: "sha:data",
    config: {},
    metrics: {},
    eval_version: "v1",
    lesson_ids: [],
    citations: [],
    integrity_status: "pending",
    status: "pending",
    is_crossover: false,
    visit_count: 0,
    depth,
    created_at: new Date().toISOString(),
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-tree-test-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
});

afterEach(() => {
  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── treeRead — full tree ─────────────────────────────────────────────────────

describe("treeRead — full tree", () => {
  it("returns empty array when tree.json absent", () => {
    expect(treeRead("run-no-tree", undefined, undefined, "test-mission")).toEqual([]);
  });

  it("returns all nodes when no filter specified", () => {
    const runId = "run-read-001";
    const rootId = randomUUID();
    const child1Id = randomUUID();
    const child2Id = randomUUID();
    const root = { ...makeNode(rootId, [], 0), name: "root-01" };
    const child1 = { ...makeNode(child1Id, [rootId], 1), name: "child-01" };
    const child2 = { ...makeNode(child2Id, [rootId], 1), name: "child-02" };
    writeTree(runId, { [rootId]: root, [child1Id]: child1, [child2Id]: child2 }, "test-mission");

    const nodes = treeRead(runId);
    expect(nodes).toHaveLength(3);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(["child-01", "child-02", "root-01"]);
  });

  it("filters by absolute depth when no subtree_root given", () => {
    const runId = "run-read-002";
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const root = { ...makeNode(rootId, [], 0), name: "root-01" };
    const child = { ...makeNode(childId, [rootId], 1), name: "child-01" };
    const grandchild = { ...makeNode(grandchildId, [childId], 2), name: "grandchild-01" };
    writeTree(runId, { [rootId]: root, [childId]: child, [grandchildId]: grandchild }, "test-mission");

    const nodes = treeRead(runId, undefined, 1);
    expect(nodes).toHaveLength(2);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(["child-01", "root-01"]);
  });
});

// ── treeRead — subtree filter ────────────────────────────────────────────────

describe("treeRead — subtree filter", () => {
  it("returns only the subtree rooted at the given node", () => {
    const runId = "run-subtree-001";
    // Tree: root → child1 → gc1
    //            → child2
    const rootId = randomUUID();
    const child1Id = randomUUID();
    const child2Id = randomUUID();
    const gc1Id = randomUUID();
    const root = { ...makeNode(rootId, [], 0), name: "root-01" };
    const child1 = { ...makeNode(child1Id, [rootId], 1), name: "child-01" };
    const child2 = { ...makeNode(child2Id, [rootId], 1), name: "child-02" };
    const gc1 = { ...makeNode(gc1Id, [child1Id], 2), name: "grandchild-01" };
    writeTree(runId, {
      [rootId]: root, [child1Id]: child1, [child2Id]: child2, [gc1Id]: gc1,
    }, "test-mission");

    const nodes = treeRead(runId, child1Id);
    expect(nodes).toHaveLength(2);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(["child-01", "grandchild-01"]);
  });

  it("returns empty when subtree_root does not exist", () => {
    const runId = "run-subtree-002";
    const rootId = randomUUID();
    writeTree(runId, { [rootId]: makeNode(rootId, [], 0) }, "test-mission");
    expect(treeRead(runId, randomUUID())).toEqual([]);
  });

  it("respects relative depth cap within subtree", () => {
    const runId = "run-subtree-003";
    const rootId = randomUUID();
    const childId = randomUUID();
    const gcId = randomUUID();
    const ggcId = randomUUID();
    writeTree(runId, {
      [rootId]: { ...makeNode(rootId, [], 0), name: "root-01" },
      [childId]: { ...makeNode(childId, [rootId], 1), name: "child-01" },
      [gcId]: { ...makeNode(gcId, [childId], 2), name: "grandchild-01" },
      [ggcId]: { ...makeNode(ggcId, [gcId], 3), name: "greatgrandchild-01" },
    }, "test-mission");

    // subtree from root, depth 1 → root + child only
    const nodes = treeRead(runId, rootId, 1);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(["child-01", "root-01"]);
  });

  it("returns single node when depth = 0", () => {
    const runId = "run-subtree-004";
    const rootId = randomUUID();
    const childId = randomUUID();
    writeTree(runId, {
      [rootId]: { ...makeNode(rootId, [], 0), name: "root-01" },
      [childId]: { ...makeNode(childId, [rootId], 1), name: "child-01" },
    }, "test-mission");

    const nodes = treeRead(runId, rootId, 0);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("root-01");
  });

  it("handles multiple parents (DAG crossover node)", () => {
    const runId = "run-subtree-005";
    const aId = randomUUID();
    const bId = randomUUID();
    const cId = randomUUID(); // crossover: parents = [a, b]
    writeTree(runId, {
      [aId]: { ...makeNode(aId, [], 0), name: "node-a" },
      [bId]: { ...makeNode(bId, [], 0), name: "node-b" },
      [cId]: { ...makeNode(cId, [aId, bId], 1), name: "crossover-c" },
    }, "test-mission");

    const fromA = treeRead(runId, aId);
    expect(fromA.map((n) => n.name).sort()).toEqual(["crossover-c", "node-a"]);

    const fromB = treeRead(runId, bId);
    expect(fromB.map((n) => n.name).sort()).toEqual(["crossover-c", "node-b"]);
  });
});

// ── treeSelect — error handling ──────────────────────────────────────────────

describe("treeSelect — subprocess error handling", () => {
  it("returns empty selected_names[] and error string when python unavailable", () => {
    // python -m evor.tree will fail (no harness on PYTHONPATH in test env)
    const result = treeSelect("run-sel-001", undefined, 1, "test-mission");
    expect(Array.isArray(result.selected_names)).toBe(true);
    expect(typeof result.scores).toBe("object");
    expect(result.error).toBeDefined();
  });
});
