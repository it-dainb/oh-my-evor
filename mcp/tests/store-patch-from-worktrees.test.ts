/**
 * mcp/tests/store-patch-from-worktrees.test.ts
 *
 * A patch typed by hand drifts from the code it describes. evor_store_patch computes
 * the diff from the node's worktree against its parent's when no patch is given.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { diffFromParent } from "../src/tools/lineage.js";

const P = "11111111-1111-4111-8111-111111111111";
const N = "22222222-2222-4222-8222-222222222222";
let root = "";

function node(id: string, name: string, code_ref: string, parent_ids: string[] = []) {
  return { id, name, parent_ids, approach_family: "training", hypothesis_id: "h1", code_ref, genome_ref: "g1",
    data_version_ref: "d1", config: {}, metrics: {}, eval_version: "v1", lesson_ids: [], citations: [],
    integrity_status: "pending", status: "running", is_crossover: false, visit_count: 0, depth: 0,
    created_at: "2026-01-01T00:00:00Z" };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evor-patchwt-"));
  process.env.EVOR_ROOT = root;
  process.env.EVOR_MISSION_ID = "m";
  const pw = join(root, "wt", "parent"), nw = join(root, "wt", "node");
  for (const w of [pw, nw]) mkdirSync(join(w, "train"), { recursive: true });
  writeFileSync(join(pw, "train", "trainer.py"), "lr = 1e-3\n");
  writeFileSync(join(nw, "train", "trainer.py"), "lr = 5e-4\n");
  writeFileSync(join(nw, "weights.pt"), "binary");
  writeFileSync(join(nw, "train.log"), "step 1");
  const run = join(root, "runs", "m", "r");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "tree.json"), JSON.stringify({
    nodes: { [P]: node(P, "parent-01", pw), [N]: node(N, "child-01", nw, [P]) }, updated_at: "2026-01-01T00:00:00Z",
  }));
});
afterEach(() => {
  delete process.env.EVOR_ROOT; delete process.env.EVOR_MISSION_ID;
  rmSync(root, { recursive: true, force: true });
});

describe("evor_store_patch from worktrees", () => {
  it("diffs the node against its parent and leaves outputs out", () => {
    const d = diffFromParent("r", "child-01", "m");
    expect(d.ok).toBe(true);
    const patch = (d as { patch: string }).patch;
    expect(patch).toMatch(/^-lr = 1e-3$/m);
    expect(patch).toMatch(/^\+lr = 5e-4$/m);
    expect(patch).not.toMatch(/^\+\+\+ .*(weights\.pt|train\.log)/m);
  });

  it("explains when a worktree is missing", () => {
    rmSync(join(root, "wt", "parent"), { recursive: true, force: true });
    const d = diffFromParent("r", "child-01", "m");
    expect(d.ok).toBe(false);
    expect((d as { error: string }).error).toMatch(/worktree is missing/);
  });
});
