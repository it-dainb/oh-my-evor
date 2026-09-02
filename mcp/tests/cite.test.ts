/**
 * tests/cite.test.ts
 * Unit tests for tools/cite.ts: addCitation
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { addCitation } from "../src/tools/cite.js";
import { writeTree, readTree } from "../src/tree-store.js";
import type { TreeNode } from "../src/contracts.js";

// ── Fixture ──────────────────────────────────────────────────────────────────

function makeNode(id: string): TreeNode {
  return {
    id,
    parent_ids: [],
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
    depth: 0,
    created_at: new Date().toISOString(),
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-cite-test-"));
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("addCitation", () => {
  it("appends citation to node.citations in tree.json", () => {
    const runId = "run-cite-001";
    const node = makeNode(randomUUID());
    writeTree(runId, { [node.id]: node }, "test-mission");

    const result = addCitation(runId, node.id, "https://arxiv.org/abs/1234.5678");

    expect(result.ok).toBe(true);
    expect(result.citations).toEqual(["https://arxiv.org/abs/1234.5678"]);

    const nodes = readTree(runId);
    expect(nodes[node.id].citations).toEqual(["https://arxiv.org/abs/1234.5678"]);
  });

  it("accumulates multiple citations", () => {
    const runId = "run-cite-002";
    const node = makeNode(randomUUID());
    writeTree(runId, { [node.id]: node }, "test-mission");

    addCitation(runId, node.id, "doi:10.1234/test.1");
    const result = addCitation(runId, node.id, "doi:10.1234/test.2");

    expect(result.citations).toHaveLength(2);
    const nodes = readTree(runId);
    expect(nodes[node.id].citations).toContain("doi:10.1234/test.1");
    expect(nodes[node.id].citations).toContain("doi:10.1234/test.2");
  });

  it("deduplicates identical citations", () => {
    const runId = "run-cite-003";
    const node = makeNode(randomUUID());
    writeTree(runId, { [node.id]: node }, "test-mission");

    addCitation(runId, node.id, "https://example.com/paper");
    const result = addCitation(runId, node.id, "https://example.com/paper");

    expect(result.citations).toHaveLength(1);
  });

  it("preserves existing citations on the node", () => {
    const runId = "run-cite-004";
    const node = makeNode(randomUUID());
    const nodeWithCitation = { ...node, citations: ["existing-bib-key"] };
    writeTree(runId, { [node.id]: nodeWithCitation }, "test-mission");

    const result = addCitation(runId, node.id, "new-bib-key");

    expect(result.citations).toEqual(["existing-bib-key", "new-bib-key"]);
  });

  it("records a citation for an unknown reference as PENDING, not as a node citation", () => {
    // ITEM 5.1 CHANGED THIS DELIBERATELY. It asserted `ok: false`, and that
    // rejection is why all 18 evor_cite calls in the field run failed: every one
    // came from Sage/Sage-junior, which runs BEFORE any node exists and cites its
    // own angle slug. A mandate its only caller can never satisfy is not a
    // mandate — the citation-backed research requirement recorded nothing for a
    // whole mission.
    //
    // This test's INTENT — an unknown reference must not be silently treated as a
    // node — is preserved and still asserted: the result is flagged `pending`,
    // and nothing is written into the tree.
    const runId = "run-cite-005";
    const fakeNodeId = randomUUID();
    // No tree.json written — node does not exist

    const result = addCitation(runId, fakeNodeId, "some-citation", "test-mission");

    expect(result.ok).toBe(true);
    expect(
      (result as { pending?: boolean }).pending,
      "the caller must be told this was NOT attached to a node",
    ).toBe(true);
    expect(result.citations).toEqual(["some-citation"]);
    expect(
      Object.keys(readTree(runId, "test-mission")),
      "a citation for an unknown reference must not invent a node",
    ).toEqual([]);
  });

  it("does not touch other nodes in the tree", () => {
    const runId = "run-cite-006";
    const node1 = makeNode(randomUUID());
    const node2 = makeNode(randomUUID());
    writeTree(runId, { [node1.id]: node1, [node2.id]: node2 }, "test-mission");

    addCitation(runId, node1.id, "bib:entry1");

    const nodes = readTree(runId);
    expect(nodes[node2.id].citations).toEqual([]);
  });
});
