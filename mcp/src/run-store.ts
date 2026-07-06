/**
 * run-store.ts — path resolver for .evor/runs/<mission>/<run-id>/ layout
 *
 * All paths are derived from a canonical run directory so tooling never
 * hard-codes paths. `ensureRunDirs()` creates the directory skeleton on
 * first use.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
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
  /** signals.jsonl — append/dedup signal bus */
  signalsPath: string;
}

/**
 * Look up the mission id for a run when the caller did not supply one, so the
 * MCP tools resolve the SAME canonical nested layout (runs/<mission>/<run-id>/)
 * that setup and the harness write to — never a divergent flat runs/<run-id>/.
 *
 * Resolution order: active-run.json (authoritative) → scan runs/<mission>/<runId>/.
 * Returns null when no nested match is found; callers must treat null as an error.
 */
export function lookupMissionId(evorRoot: string, runId: string): string | null {
  // 1. active-run.json — authoritative when it names this run.
  try {
    const ar = JSON.parse(readFileSync(join(evorRoot, "active-run.json"), "utf8"));
    if (ar?.run_id === runId && ar?.mission_id) return String(ar.mission_id);
  } catch {
    /* no/invalid active-run.json — fall through to scan */
  }
  // 2. Scan runs/<mission>/<runId>/ for a nested directory that contains this run.
  try {
    for (const entry of readdirSync(join(evorRoot, "runs"), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(evorRoot, "runs", entry.name, runId))) {
        return entry.name;
      }
    }
  } catch {
    /* no runs/ dir yet */
  }
  return null;
}

/**
 * Derive all canonical paths for a run.
 *
 * `missionId` is optional: when omitted it is resolved via `lookupMissionId`
 * (active-run.json → directory scan) so tools that only hold the run-id still
 * hit the canonical nested layout. A missing nested match is an error — pass
 * `missionId` explicitly if the directory does not exist yet (e.g. first use).
 */
export function resolveRunPaths(runId: string, missionId?: string): RunPaths {
  const evorRoot = getEvorRoot();
  const mission = missionId ?? lookupMissionId(evorRoot, runId);
  if (mission === null) {
    throw new Error(
      `resolveRunPaths: run "${runId}" not found under runs/<mission>/<run-id>/ layout` +
        ` — pass missionId explicitly or ensure active-run.json is present`
    );
  }
  const runDir = join(evorRoot, "runs", mission, runId);

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
    signalsPath: join(runDir, "signals.jsonl"),
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
