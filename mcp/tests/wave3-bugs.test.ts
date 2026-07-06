/**
 * tests/wave3-bugs.test.ts
 *
 * Wave-3 bug-fix verification tests covering:
 *   - Cross-process lock (withRunLock) in upsertNode
 *   - New GoalContract fields: evolution_bounds, autonomy_charter
 *   - New GenomeConfig field: model_family
 *   - Atomic strategy.json write in stateWrite
 *   - addCitation missionId forwarding
 */

import { vi } from "vitest";

// ── vi.hoisted flags — must be created before vi.mock is evaluated ────────────

const flags = vi.hoisted(() => ({
  blockStrategyRename: false,
}));

// vi.mock is hoisted to the top of the file by vitest. The factory runs the first
// time 'fs' is imported. Using flags.* here is safe because the hoisted object is
// initialised in the same hoisting pass.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    renameSync: (src: string, dest: string) => {
      if (
        flags.blockStrategyRename &&
        typeof src === "string" &&
        src.endsWith("strategy.json.tmp")
      ) {
        // No-op: simulate a crash between writeFileSync(.tmp) and renameSync(.tmp, real).
        return;
      }
      actual.renameSync(src, dest);
    },
  };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoalContractSchema, GenomeConfigSchema } from "../src/contracts.js";
import type { TreeNode } from "../src/contracts.js";
import { ensureRunDirs, resolveRunPaths } from "../src/run-store.js";
import { upsertNode, readTree } from "../src/tree-store.js";
import { addCitation } from "../src/tools/cite.js";
import { stateWrite } from "../src/tools/state.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const __dirname_test = fileURLToPath(new URL(".", import.meta.url));
const viteNode = "/storages_local/research/oh-my-evor/node_modules/.bin/vite-node";

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
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-wave3-"));
  savedEvorRoot = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
});

afterEach(() => {
  flags.blockStrategyRename = false;

  if (savedEvorRoot === undefined) {
    delete process.env.EVOR_ROOT;
  } else {
    process.env.EVOR_ROOT = savedEvorRoot;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Lock mechanism — upsertNode
// ════════════════════════════════════════════════════════════════════════════

describe("Lock mechanism: upsertNode cross-process lock", () => {
  it("upsertNode clears .tree.lock after a successful write", () => {
    const runId = "run-lock-clear-001";
    const paths = ensureRunDirs(runId);
    const lockPath = join(paths.runDir, ".tree.lock");

    upsertNode(runId, makeNode());

    expect(existsSync(lockPath)).toBe(false);
  });

  it("stale .tree.lock (older than stale threshold) is broken and upsert proceeds", () => {
    const runId = "run-lock-stale-001";
    const paths = ensureRunDirs(runId);
    const lockPath = join(paths.runDir, ".tree.lock");

    // Create a stale lock file backdated by 11 seconds (> 10s stale threshold)
    writeFileSync(lockPath, "");
    utimesSync(lockPath, new Date(0), new Date(Date.now() - 11_000));

    const node = makeNode();
    // Should NOT throw — stale lock is broken automatically
    upsertNode(runId, node);

    // Node persisted and lock is gone
    const tree = readTree(runId);
    expect(tree[node.id]).toBeDefined();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fresh .tree.lock causes upsertNode to throw after spin exhaustion", () => {
    const runId = "run-lock-fresh-001";
    const paths = ensureRunDirs(runId);
    const lockPath = join(paths.runDir, ".tree.lock");

    // Create a fresh lock to simulate a hung concurrent process
    writeFileSync(lockPath, "");

    // withRunLock spins for 2s then throws "timeout acquiring"
    expect(() => upsertNode(runId, makeNode())).toThrow(/timeout acquiring/);
  }, 5_000);

  it("two concurrent upsertNode processes both persist (cross-process lock)", async () => {
    const runId = "run-lock-concurrent-001";
    const missionId = "mission-concurrent";
    const nodeId1 = randomUUID();
    const nodeId2 = randomUUID();
    const helperPath = join(__dirname_test, "helpers", "upsert-node.ts");

    function spawnHelper(nodeId: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          viteNode,
          [helperPath, tmpRoot, runId, missionId, nodeId],
          { env: { ...process.env, EVOR_ROOT: tmpRoot } },
        );
        child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`helper exited with code ${code} for node ${nodeId}`));
        });
      });
    }

    await Promise.all([spawnHelper(nodeId1), spawnHelper(nodeId2)]);

    // Read tree.json directly (bypass schema validation) to confirm both nodes landed
    const paths = resolveRunPaths(runId, missionId);
    const treeRaw = JSON.parse(readFileSync(paths.treePath, "utf8"));
    expect(treeRaw.nodes[nodeId1]).toBeDefined();
    expect(treeRaw.nodes[nodeId2]).toBeDefined();
  }, 20_000);
});

// ════════════════════════════════════════════════════════════════════════════
// Schema fields — GoalContractSchema + GenomeConfigSchema
// ════════════════════════════════════════════════════════════════════════════

describe("Schema fields: GoalContractSchema evolution_bounds / autonomy_charter", () => {
  const validGoalContractBase = {
    mission_id: "test-mission",
    mode: "from-scratch" as const,
    mission_type: "fixed" as const,
    task_description: "Test task",
    dataset_ref: "dataset-v1",
    metrics: [{ name: "accuracy", direction: "higher" as const, primary: true }],
    metric_specs: [],
    fitness_mode: "aggregate" as const,
    eval_version: "v1",
    baseline_value: 0.5,
    stop_condition: { type: "beat-baseline" as const },
    wildness: 0.5,
    budget: {
      max_iterations: 10,
      plateau_window: 3,
      circuit_breaker: 5,
      max_cost_usd: 100,
    },
    locked_split_hash: "abc123",
    eval_script_hash: "def456",
    allowed_licenses: ["MIT"],
    created_at: "2024-01-01T00:00:00.000Z",
  };

  it("GoalContractSchema accepts evolution_bounds field", () => {
    const result = GoalContractSchema.safeParse({
      ...validGoalContractBase,
      evolution_bounds: {
        benchmark_may_harden: true,
        metrics_may_add_tracked: true,
        budget_ceiling_extensions: 2,
        primary_metric_frozen: true,
        comparability_change_requires_consent: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it("GoalContractSchema accepts autonomy_charter field", () => {
    const result = GoalContractSchema.safeParse({
      ...validGoalContractBase,
      autonomy_charter: {
        posture: "aggressive-never-halt",
        invariant: "Never make the number look better than it is.",
        license_gate: false,
        data_acquisition_enabled: true,
        always_on_checks: ["no-test-leakage", "comparability-eval-version"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("GoalContractSchema remains valid without evolution_bounds/autonomy_charter (optional)", () => {
    const result = GoalContractSchema.safeParse(validGoalContractBase);
    expect(result.success).toBe(true);
  });
});

describe("Schema fields: GenomeConfigSchema model_family", () => {
  const validGenomeBase = {
    genome_version: "v1",
    optimizer: "adam",
    lr: 0.001,
    lr_schedule: "cosine",
    batch_size: 32,
    epochs: 10,
    loss: "cross-entropy",
    aug_set: [],
    acquired_datasets: [],
    regularization: {},
    schema_extensions: [],
    extra: {},
  };

  it("GenomeConfigSchema accepts model_family", () => {
    const result = GenomeConfigSchema.safeParse({ ...validGenomeBase, model_family: "cnn" });
    expect(result.success).toBe(true);
  });

  it("GenomeConfigSchema remains valid without model_family (optional)", () => {
    const result = GenomeConfigSchema.safeParse(validGenomeBase);
    expect(result.success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// stateWrite — strategy.json atomic write
// ════════════════════════════════════════════════════════════════════════════

describe("stateWrite: strategy.json write is atomic", () => {
  it("original strategy.json is preserved when renameSync is blocked", () => {
    const runId = "run-strategy-atomic-001";
    const paths = ensureRunDirs(runId);

    // Write original strategy content
    writeFileSync(
      paths.strategyPath,
      JSON.stringify({ marker: "original" }, null, 2),
      "utf8",
    );

    // Block strategy.json.tmp rename to simulate a crash mid-write
    flags.blockStrategyRename = true;

    stateWrite(runId, { strategy: { meta_iteration: 99 } as Parameters<typeof stateWrite>[1]["strategy"] });

    flags.blockStrategyRename = false;

    // AFTER FIX: atomic write (tmp+rename) — when rename is blocked the original is untouched
    const content = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
    expect(content.marker).toBe("original");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// addCitation — missionId forwarding
// ════════════════════════════════════════════════════════════════════════════

describe("addCitation: missionId forwarding to nested run layout", () => {
  it("addCitation forwards missionId to locate node in nested run layout", () => {
    const runId = "run-cite-nested-001";
    const missionId = "mission-cite";
    const nodeId = randomUUID();

    // Create nested tree.json at evorRoot/runs/missionId/runId/tree.json
    const runDir = join(tmpRoot, "runs", missionId, runId);
    mkdirSync(runDir, { recursive: true });
    const treePath = join(runDir, "tree.json");

    const node = makeNode({ id: nodeId });
    writeFileSync(
      treePath,
      JSON.stringify(
        { nodes: { [nodeId]: node }, updated_at: new Date().toISOString() },
        null,
        2,
      ),
      "utf8",
    );

    // addCitation must resolve the nested path via missionId
    const result = addCitation(runId, nodeId, "https://arxiv.org/abs/2401.00001", missionId);

    expect(result.ok).toBe(true);
    expect(result.citations).toContain("https://arxiv.org/abs/2401.00001");

    // Verify the citation was persisted in the nested path
    const treeRaw = JSON.parse(readFileSync(treePath, "utf8"));
    expect(treeRaw.nodes[nodeId].citations).toContain("https://arxiv.org/abs/2401.00001");
  });
});
