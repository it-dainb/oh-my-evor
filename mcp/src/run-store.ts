/**
 * run-store.ts — path resolver for .evor/runs/<mission>/<run-id>/ layout
 *
 * All paths are derived from a canonical run directory so tooling never
 * hard-codes paths. `ensureRunDirs()` creates the directory skeleton on
 * first use.
 */

import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// ────────────────────────────────────────────────────────────────────────────
// State root
// ────────────────────────────────────────────────────────────────────────────

/** Resolve the .evor/ root directory: env override > cwd-relative */
export function getEvorRoot(): string {
  return process.env.EVOR_ROOT ?? join(process.cwd(), ".evor");
}

// ────────────────────────────────────────────────────────────────────────────
// Run path struct
// ────────────────────────────────────────────────────────────────────────────

export interface RunPaths {
  /** .evor/runs/<mission>/<run-id>/ */
  runDir: string;
  /** run-state.json */
  runStatePath: string;
  /** strategy.json */
  strategyPath: string;
  /** decision-log.md */
  decisionLogPath: string;
  /** tree.json (atomic-written) */
  treePath: string;
  /** tree.json.tmp (write target before rename) */
  treeTmpPath: string;
  /** angle-registry.json */
  angleRegistryPath: string;
  /** genome-seed-adapter-report.json */
  genomeSeedAdapterReportPath: string;
  /** nodes/<node-id>/ base */
  nodesDir: string;
  /** evaluations/ */
  evaluationsDir: string;
  /** artifacts/<sha[:2]>/<sha[2:]> base */
  artifactsDir: string;
  /** wiki/ */
  wikiDir: string;
  /** eval-suites/ */
  evalSuitesDir: string;
  /** frozen-splits/ */
  frozenSplitsDir: string;
}

/**
 * Derive all canonical paths for a run.
 *
 * `missionId` is optional: when omitted, `runId` is treated as a bare
 * directory name directly under `.evor/runs/` (for tooling that only has
 * the run-id and looks up the mission from run-state.json).
 */
export function resolveRunPaths(runId: string, missionId?: string): RunPaths {
  const evorRoot = getEvorRoot();
  const runDir = missionId
    ? join(evorRoot, "runs", missionId, runId)
    : join(evorRoot, "runs", runId);

  return {
    runDir,
    runStatePath: join(runDir, "run-state.json"),
    strategyPath: join(runDir, "strategy.json"),
    decisionLogPath: join(runDir, "decision-log.md"),
    treePath: join(runDir, "tree.json"),
    treeTmpPath: join(runDir, ".tree.json.tmp"),
    angleRegistryPath: join(runDir, "angle-registry.json"),
    genomeSeedAdapterReportPath: join(runDir, "genome-seed-adapter-report.json"),
    nodesDir: join(runDir, "nodes"),
    evaluationsDir: join(runDir, "evaluations"),
    artifactsDir: join(runDir, "artifacts"),
    wikiDir: join(runDir, "wiki"),
    evalSuitesDir: join(runDir, "eval-suites"),
    frozenSplitsDir: join(runDir, "frozen-splits"),
  };
}

/**
 * Resolve the path for a specific node's directory.
 */
export function resolveNodeDir(runId: string, nodeId: string, missionId?: string): string {
  const paths = resolveRunPaths(runId, missionId);
  return join(paths.nodesDir, nodeId);
}

/**
 * Create all standard subdirectories for a run on first use.
 * Idempotent — safe to call multiple times.
 */
export function ensureRunDirs(runId: string, missionId?: string): RunPaths {
  const paths = resolveRunPaths(runId, missionId);

  const dirs = [
    paths.runDir,
    paths.nodesDir,
    paths.evaluationsDir,
    paths.artifactsDir,
    paths.wikiDir,
    paths.evalSuitesDir,
    paths.frozenSplitsDir,
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  return paths;
}

/** Cross-run wiki directory (outside any single run-id) */
export function getWikiRoot(): string {
  return join(getEvorRoot(), "wiki");
}

/** Path for the active-run marker file */
export function getActiveRunPath(): string {
  return join(getEvorRoot(), "active-run.json");
}
