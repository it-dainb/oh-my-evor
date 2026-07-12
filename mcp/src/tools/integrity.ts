/**
 * tools/integrity.ts
 * evor_integrity_check — run integrity_bridge.py (wraps Python IntegrityGate);
 *                        parse IntegrityReport JSON from stdout.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoalContract } from "../contracts.js";
import { resolveRunPaths } from "../run-store.js";
import { callBridge } from "../subprocess-bridge.js";
import { resolveNodeRef } from "./node-ref.js";

// ── P2-2: frozen-split hash cache ────────────────────────────────────────────

/**
 * Module-level cache: runId → locked_split_hash loaded from goal-contract.json.
 * Prevents re-reading the contract on every integrity check within a run.
 * Exported so tests can clear it in beforeEach/afterEach.
 */
export const frozenSplitHashCache = new Map<string, string>();

/**
 * Module-level cache: runId → eval_version loaded from goal-contract.json.
 * Paired with frozenSplitHashCache to fully skip the contract file read on
 * subsequent integrityCheck calls within the same run (P2-2).
 * Exported so tests can clear it in beforeEach/afterEach.
 */
export const evalVersionCache = new Map<string, string>();

/**
 * Return the locked_split_hash for runId, loading from goal-contract.json on
 * the first call and caching for subsequent calls (P2-2).
 */
export function getCachedSplitHash(runId: string, runDir: string): string | undefined {
  if (frozenSplitHashCache.has(runId)) return frozenSplitHashCache.get(runId);
  try {
    const contractPath = join(runDir, "goal-contract.json");
    if (!existsSync(contractPath)) return undefined;
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Partial<GoalContract>;
    const hash = contract.locked_split_hash;
    if (hash) frozenSplitHashCache.set(runId, hash);
    return hash;
  } catch {
    return undefined;
  }
}

// ── P1-11: resolveIntegrityPaths ─────────────────────────────────────────────

export interface IntegrityPaths {
  /** Absolute path to the eval script: <runDir>/eval-suites/<eval_version>.py */
  evalScript: string;
  /** Absolute path to the frozen split: <runDir>/frozen-splits/<eval_version>.json */
  splitPath: string;
}

/**
 * Derive eval_script and frozen-split paths from the GoalContract's eval_version.
 * Pure function — no I/O. Replaces hardcoded `eval-suites/v1.py` and
 * `frozen-splits/test.json` in the integrity bridge call (P1-11).
 */
export function resolveIntegrityPaths(runDir: string, contract: Pick<GoalContract, "eval_version">): IntegrityPaths {
  return {
    evalScript: join(runDir, "eval-suites", `${contract.eval_version}.py`),
    splitPath: join(runDir, "frozen-splits", `${contract.eval_version}.json`),
  };
}

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Run all 13 IntegrityGate checks via `integrity_bridge.py`.
 * The bridge writes `evaluations/<node_id>.json` on success.
 *
 * Paths for eval-script and frozen-split are resolved from goal-contract.json
 * (P1-11) rather than hardcoded. The frozen-split hash is cached per-run to
 * avoid re-reading the contract on every call (P2-2).
 *
 * Returns the parsed IntegrityReport on success, or an error payload if
 * the bridge subprocess failed (e.g. missing Python harness).
 */
export function integrityCheck(
  runId: string,
  nodeId: string,
  missionId?: string
): { ok: boolean; report?: unknown; error?: string; stderr?: string } {
  const paths = resolveRunPaths(runId, missionId);

  const bridgeArgs: string[] = [
    "--run-id", runId,
    "--node-id", nodeId,
    "--run-dir", paths.runDir,
  ];

  // P2-2: check BOTH caches at the TOP — skip the contract file read entirely on cache hit.
  // evalVersionCache + frozenSplitHashCache are populated on the first call within a run.
  const cachedEvalVersion = evalVersionCache.get(runId);
  const cachedHash = frozenSplitHashCache.get(runId);

  if (cachedEvalVersion !== undefined) {
    // Cache hit: derive bridge paths from cached eval_version — no disk read needed.
    const intPaths = resolveIntegrityPaths(paths.runDir, { eval_version: cachedEvalVersion });
    bridgeArgs.push("--eval-script", intPaths.evalScript);
    bridgeArgs.push("--split-path", intPaths.splitPath);
    // cachedHash may be undefined if the contract lacked locked_split_hash; that's fine —
    // the bridge handles it via its own defaults.
    void cachedHash;
  } else {
    // P1-11 + P2-2 cache miss: read goal-contract.json once and populate both caches.
    try {
      const contractPath = join(paths.runDir, "goal-contract.json");
      if (existsSync(contractPath)) {
        const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Partial<GoalContract>;
        if (contract.eval_version) {
          evalVersionCache.set(runId, contract.eval_version);
          const intPaths = resolveIntegrityPaths(paths.runDir, { eval_version: contract.eval_version });
          bridgeArgs.push("--eval-script", intPaths.evalScript);
          bridgeArgs.push("--split-path", intPaths.splitPath);
        }
        if (contract.locked_split_hash && !frozenSplitHashCache.has(runId)) {
          frozenSplitHashCache.set(runId, contract.locked_split_hash);
        }
      }
    } catch {
      // fail-open — bridge still works without explicit paths (Python uses its own defaults)
    }
  }

  const result = callBridge("integrity_bridge.py", bridgeArgs);

  if (!result.ok) {
    return { ok: false, error: result.error, stderr: result.stderr };
  }
  return { ok: true, report: result.data };
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerIntegrityTools(server: McpServer): void {
  server.tool(
    "evor_integrity_check",
    "Auto-triggered by evor_record_eval; call explicitly only for re-checks or manual spot-checks. "
    + "Run all integrity checks for a node and return the IntegrityReport. "
    + "Checks: reward-hacking, split-purity, telemetry-sane, "
    + "acquisition-provenance, grad-norm-health, loss-monotonic, eval-consistency, "
    + "config-reproducibility, dataset-frozen, license-gate, leakage-probe, "
    + "performance-ceiling, and coverage-gap.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("The node's name (e.g. 'immune-memory-02')"),
    },
    async ({ run_id, node_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = integrityCheck(run_id, resolveNodeRef(run_id, node_id, missionId), missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.ok ? result.report : result),
          },
        ],
      };
    }
  );
}
