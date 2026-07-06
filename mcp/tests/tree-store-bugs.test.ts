/**
 * tests/tree-store-bugs.test.ts
 *
 * Proves three concrete bugs found by sibling-class analysis of the upsertNode fix:
 *
 * Bug A (CRITICAL): upsertNode silently returns after MAX_ATTEMPTS exhaustion.
 *   The caller (recordNode, addCitation) receives void/ok even though the node
 *   was never written to tree.json. Silent data loss under concurrent clobber.
 *
 * Bug B (HIGH): readTree propagates a raw SyntaxError / ZodError on corrupt
 *   tree.json — the error message contains no file path, making production
 *   diagnosis nearly impossible.  All callers (upsertNode, treeRead, addCitation)
 *   lack try/catch on the first readTree call.
 *
 * Bug C (MED): writeRunState uses plain writeFileSync (no tmp+rename).
 *   A process crash mid-write corrupts run-state.json; readRunState then
 *   silently discards the corrupt file and returns a fresh-default state,
 *   losing tick_count, frontier_ids, best_score, etc.
 *
 * Each describe block contains tests that FAIL before the corresponding fix
 * and PASS after it.
 */

import { vi } from "vitest";

// ── vi.hoisted flags — must be created before vi.mock is evaluated ────────────

const flags = vi.hoisted(() => ({
  blockTreeJsonRename: false,
  blockRunStateRename: false,
}));

// vi.mock is hoisted to the top of the file by vitest; the factory runs the first
// time 'fs' is imported (before any test code).  Using flags.* here is safe because
// the hoisted object is initialised in the same hoisting pass.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    renameSync: (src: string, dest: string) => {
      if (flags.blockTreeJsonRename && typeof dest === "string" && dest.endsWith("tree.json")) {
        // No-op: simulate a concurrent writer clobbering tree.json after each write,
        // so the verify readTree always sees a stale (node-missing) file.
        return;
      }
      if (flags.blockRunStateRename && typeof dest === "string" && dest.endsWith("run-state.json")) {
        // No-op: simulate a crash between writeFileSync(.tmp) and renameSync(.tmp, real).
        return;
      }
      actual.renameSync(src, dest);
    },
  };
});

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { upsertNode, readTree } from "../src/tree-store.js";
import { ensureRunDirs } from "../src/run-store.js";
import { readRunState, writeRunState } from "../src/tools/record.js";
import type { TreeNode } from "../src/contracts.js";

// ── Shared fixture ────────────────────────────────────────────────────────────

function makeNode(overrides?: Partial<TreeNode>): TreeNode {
  return {
    id: randomUUID(),
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
    ...overrides,
  };
}

let tmpRoot: string;
let savedEvorRoot: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-ts-bugs-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
});

afterEach(() => {
  // Always reset flags so leaked state doesn't bleed into other tests.
  flags.blockTreeJsonRename = false;
  flags.blockRunStateRename = false;

  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Bug A — upsertNode silent data loss after MAX_ATTEMPTS
// ════════════════════════════════════════════════════════════════════════════

describe("Bug A: upsertNode silent data loss after MAX_ATTEMPTS exhaustion", () => {
  it("throws after MAX_ATTEMPTS when all tree.json renames are blocked (concurrent clobber)", () => {
    // Arrange: run directory exists; blocking tree.json renames simulates a concurrent
    // writer that always overwrites tree.json to remove our node after every writeTree.
    const runId = "run-upsert-silent-001";
    ensureRunDirs(runId);

    flags.blockTreeJsonRename = true;

    const node = makeNode();

    // BUG (before fix): upsertNode returns void without throwing — the caller
    //   has no way to know the node was not persisted (silent data loss).
    // AFTER FIX: upsertNode throws after exhausting MAX_ATTEMPTS.
    expect(() => upsertNode(runId, node)).toThrow(
      /failed to persist.*after 3 attempts/i,
    );
  });

  it("node is absent from tree.json after all MAX_ATTEMPTS are blocked", () => {
    // Additional evidence: the node really is missing, confirming the data loss.
    const runId = "run-upsert-absent-001";
    ensureRunDirs(runId);

    flags.blockTreeJsonRename = true;

    const node = makeNode();
    try {
      upsertNode(runId, node);
    } catch {
      // after fix: expected throw
    }

    // tree.json was never updated (renames blocked) — node must not be present.
    const persisted = readTree(runId);
    expect(persisted[node.id]).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Bug B — readTree non-descriptive error on corrupt tree.json
// ════════════════════════════════════════════════════════════════════════════

describe("Bug B: readTree error on corrupt tree.json lacks actionable context", () => {
  it("readTree error message contains the file path when tree.json is corrupt", () => {
    const runId = "run-corrupt-B-001";
    const paths = ensureRunDirs(runId);

    writeFileSync(paths.treePath, "NOT VALID JSON {{{", "utf8");

    // BUG (before fix): throws raw SyntaxError — message is e.g.
    //   "Unexpected token N in JSON at position 0"
    //   which gives no indication of WHICH file is corrupt.
    // AFTER FIX: throws Error with message containing the file path so the
    //   operator can find and repair the file immediately.
    try {
      readTree(runId);
      expect.fail("readTree should have thrown on corrupt JSON");
    } catch (err) {
      expect((err as Error).message).toMatch(/tree\.json/i);
    }
  });

  it("readTree error on corrupt ZodSchema (valid JSON, invalid schema) contains file path", () => {
    const runId = "run-corrupt-B-002";
    const paths = ensureRunDirs(runId);

    // Valid JSON but does NOT satisfy TreeFileSchema (missing `nodes` key).
    writeFileSync(paths.treePath, JSON.stringify({ wrong_key: {} }), "utf8");

    try {
      readTree(runId);
      expect.fail("readTree should have thrown on schema mismatch");
    } catch (err) {
      // BUG: ZodError message contains Zod internals, not the file path.
      // AFTER FIX: message should contain the file path.
      expect((err as Error).message).toMatch(/tree\.json/i);
    }
  });

  it("upsertNode propagates the readTree error when tree.json is corrupt (first read, no try/catch)", () => {
    const runId = "run-corrupt-B-003";
    const paths = ensureRunDirs(runId);

    writeFileSync(paths.treePath, "{corrupt", "utf8");

    // The FIRST readTree call inside upsertNode (get-current state) is NOT
    // wrapped in try/catch, so the raw parse error propagates to callers.
    // AFTER FIX: the error should at minimum carry the file path in its message.
    expect(() => upsertNode(runId, makeNode())).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Bug C — writeRunState non-atomic write (no tmp+rename)
// ════════════════════════════════════════════════════════════════════════════

describe("Bug C: writeRunState non-atomic write — original state lost when rename fails", () => {
  it("original run-state.json is preserved when renameSync is blocked (atomic-write contract)", () => {
    const runId = "run-atomic-state-001";
    const paths = ensureRunDirs(runId);

    // Write initial state that we care about preserving.
    writeRunState(paths.runStatePath, {
      run_id: runId,
      status: "running",
      tick_count: 42,
      best_score: 0.99,
      frontier_ids: ["node-A", "node-B"],
      current_eval_version: "v3",
      pending_node_ids: ["node-C"],
    });

    // Block the rename so the "new" state never lands atomically.
    // With atomic writes (tmp+rename) the original file should be untouched.
    flags.blockRunStateRename = true;

    writeRunState(paths.runStatePath, {
      run_id: runId,
      status: "running",
      tick_count: 99,
      best_score: 0.1,
      frontier_ids: [],
      current_eval_version: "v3",
      pending_node_ids: [],
    });

    flags.blockRunStateRename = false;

    // BUG (before fix): writeRunState uses writeFileSync directly — it overwrites
    //   run-state.json unconditionally, ignoring blockRunStateRename entirely.
    //   tick_count is now 99 (data clobbered), not 42 (original preserved).
    // AFTER FIX: writeRunState writes to .tmp first, then renames.  When rename
    //   is blocked the original file is unchanged — tick_count stays 42.
    const recovered = readRunState(paths.runStatePath, runId);
    expect(recovered.tick_count).toBe(42);
  });

  it("run-state.json.tmp is not present after a successful atomic write", () => {
    // Positive case: after a SUCCESSFUL write the .tmp file must be gone
    // (renamed to the real file).  Before the fix there is no .tmp at all;
    // after the fix there IS a .tmp during the write but it's renamed away.
    const runId = "run-atomic-state-002";
    const paths = ensureRunDirs(runId);

    writeRunState(paths.runStatePath, { run_id: runId, tick_count: 1 });

    const tmpPath = `${paths.runStatePath}.tmp`;
    // Both before and after fix: .tmp should not exist after a completed write.
    expect(existsSync(tmpPath)).toBe(false);
    // The real file should always have the correct data.
    const state = readRunState(paths.runStatePath, runId);
    expect(state.tick_count).toBe(1);
  });
});
