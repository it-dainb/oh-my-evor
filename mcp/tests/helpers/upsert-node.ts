/**
 * Minimal helper script for the cross-process lock test.
 *
 * Usage:
 *   vite-node tests/helpers/upsert-node.ts <evorRoot> <runId> <missionId> <nodeId>
 *
 * Writes a minimal TreeNode via upsertNode so that the cross-process lock
 * serialises concurrent invocations, proving both nodes survive.
 */

import { upsertNode } from "../../src/tree-store.js";

const [, , evorRoot, runId, missionId, nodeId] = process.argv;

if (!evorRoot || !runId || !missionId || !nodeId) {
  process.stderr.write("usage: upsert-node.ts <evorRoot> <runId> <missionId> <nodeId>\n");
  process.exit(1);
}

process.env.EVOR_ROOT = evorRoot;

upsertNode(
  runId,
  {
    id: nodeId,
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
  },
  missionId,
);
