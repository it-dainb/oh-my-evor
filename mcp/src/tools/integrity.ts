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

// ── P2-2: frozen-split hash cache ────────────────────────────────────────────

/**
 * Module-level cache: runId → locked_split_hash loaded from goal-contract.json.
 * Prevents re-reading the contract on every integrity check within a run.
 * Exported so tests can clear it in beforeEach/afterEach.
 */
export const frozenSplitHashCache = new Map<string, string>();

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

  // P1-11: resolve eval paths from GoalContract (falls back gracefully if missing)
  const bridgeArgs: string[] = [
    "--run-id", runId,
    "--node-id", nodeId,
    "--run-dir", paths.runDir,
  ];

  // Attempt to resolve GoalContract paths; pass them only if the contract exists
  try {
    const contractPath = join(paths.runDir, "goal-contract.json");
    if (existsSync(contractPath)) {
      const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Partial<GoalContract>;
      if (contract.eval_version) {
        const intPaths = resolveIntegrityPaths(paths.runDir, { eval_version: contract.eval_version });
        bridgeArgs.push("--eval-script", intPaths.evalScript);
        bridgeArgs.push("--split-path", intPaths.splitPath);
        // P2-2: populate hash cache while we have the contract open
        if (contract.locked_split_hash && !frozenSplitHashCache.has(runId)) {
          frozenSplitHashCache.set(runId, contract.locked_split_hash);
        }
      }
    }
  } catch {
    // fail-open — bridge still works without explicit paths (Python uses its own defaults)
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
    + "Runs all 13 IntegrityGate checks via integrity_bridge.py and writes IntegrityReport to "
    + "evaluations/<node-id>.json. Checks: reward-hacking, split-purity, telemetry-sane, "
    + "acquisition-provenance, grad-norm-health, loss-monotonic, eval-consistency, "
    + "config-reproducibility, dataset-frozen, license-gate, leakage-probe, "
    + "performance-ceiling, and coverage-gap.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("Node to check"),
    },
    async ({ run_id, node_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = integrityCheck(run_id, node_id, missionId);
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
