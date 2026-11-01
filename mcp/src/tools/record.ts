/**
 * tools/record.ts
 * evor_record_node — validate TreeNode + atomic-write tree.json
 * evor_record_eval — write EvaluationResult + auto-trigger integrity check
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { err } from "../tool-result.js";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TreeNode, TreeNodeSchema, EvaluationResultSchema } from "../contracts.js";
import { readTree, upsertNode } from "../tree-store.js";
import { ensureRunDirs, resolveRunPaths } from "../run-store.js";
import { integrityCheck } from "./integrity.js";
import { resolveNodeRef, assignUniqueName, deriveName } from "./node-ref.js";

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * The run-state a caller sees when the file is missing or unparseable.
 *
 * ONE place, deliberately (plan item 1.3a). This shape was duplicated across the
 * two branches of `readRunState`, so "what does absence mean" had two definitions
 * that had to be kept in step by hand — and the answer they gave, `status:
 * "running"`, is the A6 failure itself: **absence of state read as liveness**. A
 * run whose state file has never been written, or has been corrupted, reported
 * itself as live.
 *
 * 1.3a is a pure refactor and leaves that answer unchanged. 1.4 changes it, here,
 * at one site rather than two.
 */
export function defaultRunState(runId: string): Record<string, unknown> {
  return {
    run_id: runId,
    // 1.4 then 1.9b. This was `"running"` — a run whose state file had never
    // been written, or had been corrupted, reported itself as LIVE. That is A6:
    // absence of state read as liveness.
    //
    // 1.4 made it `"initialized"`; 1.9b retires the field entirely. AF3 §4.1: a
    // new FSM must REPLACE a field, never accompany it, and `run-state.status`
    // duplicated the mission's — it "was wrong in all three field runs". Mission
    // state is now the single lifecycle state, driven server-side by
    // `evor_run_start` and read by the three stop-hook gates (1.9c).
    //
    // Keeping the key here is what would make it a fifth status field, which AF3
    // names as the highest-probability failure mode of this whole redesign. The
    // key is OMITTED rather than set undefined, so `"status" in state` is false
    // and a reader cannot mistake "present but empty" for "declared".
    tick_count: 0,
    best_score: null,
    frontier_ids: [],
    current_eval_version: "v1",
    pending_node_ids: [],
  };
}

/**
 * The run's declared lifecycle status, or undefined when it declares none.
 *
 * Named so that retiring the field at 1.9b is a compile error rather than a grep.
 * Absence and liveness are different questions; `isRunLive` answers the second.
 */
export function readRunStatus(state: Record<string, unknown> | null | undefined): string | undefined {
  const raw = state?.status;
  return raw === undefined || raw === null ? undefined : String(raw);
}

/** Is this run live — may a check still hold on its behalf? */
export function isRunLive(state: Record<string, unknown> | null | undefined): boolean {
  return readRunStatus(state) === "running";
}

/** Read run-state.json; return parsed object or a fresh default. */
export function readRunState(runStatePath: string, runId: string): Record<string, unknown> {
  if (!existsSync(runStatePath)) return defaultRunState(runId);
  try {
    return JSON.parse(readFileSync(runStatePath, "utf8"));
  } catch (err) {
    // A corrupt state file is not a fresh run, and it is worth saying so. The old
    // code returned `status: "running"` here too, so a truncated write made the
    // run look live — the same defect as the missing-file branch, arriving by a
    // route nobody was watching. Defaulting stays (a governor must not crash a
    // session) but it no longer defaults toward liveness, and no longer silently.
    process.stderr.write(
      `[evor] run-state unreadable at ${runStatePath}: ${String(err)} — treating as uninitialized\n`,
    );
    return defaultRunState(runId);
  }
}

/** Write run-state.json atomically using write-to-tmp + rename. */
export function writeRunState(runStatePath: string, state: Record<string, unknown>): void {
  const tmpPath = `${runStatePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpPath, runStatePath);
}

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Fill node.id with a fresh UUID if the caller omitted it (P2-1).
 * The internal TreeNode type still requires id; callers that construct nodes
 * programmatically can skip the shell-out to `python -c "import uuid; …"`.
 */
export function fillNodeId(node: Partial<TreeNode> & Omit<TreeNode, "id">): TreeNode {
  if (!node.id) {
    return { ...node, id: randomUUID() } as TreeNode;
  }
  return node as TreeNode;
}

/**
 * Fill server-owned bookkeeping fields on a node before persisting.
 * These are fields the agent must never fabricate — server derives them from
 * context (parent tree, current time, parent count) and fills any missing values.
 *
 * Mutates the node in-place. Called by recordNode so the fill applies whether
 * the caller is the MCP tool handler or a test calling recordNode directly.
 */
export function fillNodeBookkeeping(node: TreeNode, runId: string, missionId?: string): void {
  if (!node.created_at) node.created_at = new Date().toISOString();
  if (node.visit_count === undefined || node.visit_count === null) node.visit_count = 0;
  if (node.integrity_status === undefined) node.integrity_status = "pending";
  if (node.status === undefined) node.status = "pending";
  if (!node.lesson_ids) node.lesson_ids = [];
  const parentCount = node.parent_ids.length;
  if (node.is_crossover === undefined) node.is_crossover = parentCount > 1;
  // depth: 0 for roots; parentDepth+1 for children (read parent from tree if possible).
  if (node.depth === undefined || node.depth === null) {
    if (parentCount === 0) {
      node.depth = 0;
    } else {
      try {
        const nodes = readTree(runId, missionId);
        const primaryParentId = node.parent_ids[0];
        const parentNode = primaryParentId ? nodes[primaryParentId] : undefined;
        node.depth = parentNode ? (parentNode.depth ?? 0) + 1 : 1;
      } catch {
        node.depth = 1;
      }
    }
  }
}

/**
 * Record a TreeNode into tree.json, clear it from pending_node_ids, and
 * append a one-liner to decision-log.md.
 */
export function recordNode(runId: string, node: TreeNode, missionId?: string): {
  pendingRemaining: number;
  treePath: string;
} {
  const paths = ensureRunDirs(runId, missionId);

  // Fill server-owned bookkeeping before persisting (agent must never fabricate these).
  fillNodeBookkeeping(node, runId, missionId);

  // 1. Atomically upsert node into tree.json
  upsertNode(runId, node, missionId);

  // 2. Append a brief record entry to decision-log.md
  const logLine = [
    `\n## record ${new Date().toISOString()}`,
    `- node_id: ${node.id}`,
    `- approach_family: ${node.approach_family}`,
    `- status: ${node.status}`,
    `- depth: ${node.depth}`,
    "",
  ].join("\n");
  appendFileSync(paths.decisionLogPath, logLine, "utf8");

  // 3. Remove the node from pending_node_ids, under its id or its name — agents
  //    mark a node pending by name before it has an id.
  const state = readRunState(paths.runStatePath, runId);
  const pending = Array.isArray(state.pending_node_ids)
    ? (state.pending_node_ids as string[]).filter((id) => id !== node.id && id !== node.name)
    : [];
  state.pending_node_ids = pending;
  writeRunState(paths.runStatePath, state);

  return { pendingRemaining: pending.length, treePath: paths.treePath };
}

/**
 * Write results.json for a node and atomically trigger the integrity bridge (P1-1).
 *
 * Uses integrityCheck() — the same path as evor_integrity_check — so P1-11 eval paths
 * are resolved and the P2-2 evalVersionCache is populated. Returns the full IntegrityReport
 * inline, so the orchestrator never needs a separate evor_integrity_check call for the
 * normal eval flow.
 */
/**
 * Propagate a completed evaluation's fitness into run-state's `best_score`.
 *
 * Nothing did this before, so `best_score` stayed at its initial null and
 * `harness/evor/tree.py:701` read it as 0.0 — making BOTH score-based stop
 * conditions unreachable:
 *   beat-baseline: 0.0 > baseline_value   never true
 *   target:        0.0 >= target_value    never true
 * An evolutionary search that cannot recognise success runs to max_iterations
 * regardless of what it finds.
 *
 * P3: only an integrity-PASSED node may move the score. A failed — or merely
 * unchecked — node setting best_score would let a cheating candidate define the
 * mission's own success criterion, which is exactly what the integrity gate
 * exists to prevent. Absence of a failure verdict is not evidence of integrity.
 */
export function updateBestScore(
  runId: string,
  nodeId: string,
  result: unknown,
  integrityVerdict: string | null,
  missionId?: string,
): void {
  if (integrityVerdict !== "passed") return;

  try {
    const paths = resolveRunPaths(runId, missionId);

    // The primary metric is declared in the contract; a secondary metric that
    // happens to score higher must never be mistaken for fitness.
    const contractPath = join(paths.runDir, "goal-contract.json");
    if (!existsSync(contractPath)) return;
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    const primary = (contract?.metric_specs ?? []).find(
      (m: Record<string, unknown>) => m?.role === "primary_fitness",
    );
    if (!primary?.metric_name) return;

    const metrics = (result as Record<string, unknown> | null)?.metrics as
      | Record<string, unknown>
      | undefined;
    const value = metrics?.[primary.metric_name as string];
    if (typeof value !== "number" || Number.isNaN(value)) return;

    const runStatePath = join(paths.runDir, "run-state.json");
    const state = readRunState(runStatePath, runId);
    // best_score is per eval version: a score under a version that is not in
    // force (the parent of a hardening, say) must not set the best of this one.
    const scoredUnder = (result as Record<string, unknown> | null)?.eval_version;
    const inForce = contract?.eval_version ?? state.current_eval_version;
    if (typeof scoredUnder === "string" && typeof inForce === "string" && scoredUnder !== inForce) return;
    const current = state.best_score;
    const lowerIsBetter = primary.direction === "lower";

    const improves =
      typeof current !== "number"
        ? true
        : lowerIsBetter
          ? value < current
          : value > current;
    if (!improves) return;

    state.best_score = value;
    state.best_node_id = nodeId;
    writeRunState(runStatePath, state);
  } catch {
    // Non-fatal: a bookkeeping failure must not sink a completed evaluation.
    // The score is recoverable from results.json; the eval is not.
  }
}

/** Fields only the sealed evaluator may set; a recording agent's copy never replaces them. */
const EVALUATOR_FIELDS = [
  "fitness_value", "metrics", "per_domain", "status", "benchmark_raw", "eval_version",
  // The parent evaluator's score under a metric hardening is measured by the
  // runner; a recording agent's copy must not be able to raise it.
  "parent_eval_version", "parent_fitness_value", "parent_metrics", "parent_inputs_match",
];

/** The only shape an eval version takes where it builds a path. */
const VERSION_RE = /^v\d+$/;

/**
 * Is a LOWER fitness better under this run's contract? Mirror of
 * `evor.benchmark.fitness_lower_is_better`: fitness is the primary metric's raw
 * value unless baseline→target normalisation applies.
 */
function fitnessLowerIsBetter(runDir: string): boolean {
  try {
    const c = JSON.parse(readFileSync(join(runDir, "goal-contract.json"), "utf8")) as Record<string, unknown>;
    const spec = ((c.metric_specs ?? []) as Record<string, unknown>[]).find((m) => m?.role === "primary_fitness");
    if (!spec || spec.direction !== "lower") return false;
    if ((c.fitness_mode === "worst-domain" || c.fitness_mode === "weighted") && !spec.fitness_formula) return true;
    return c.target_value === undefined || c.target_value === null;
  } catch {
    return false;
  }
}

/**
 * Re-score bookkeeping for a metric hardening. A node counts as re-scored only
 * when it evaluated AND passed integrity; one that did not is listed as failed,
 * and the record is "complete" only when every marked node succeeded. When the
 * last one lands, the frontier order under the new version is logged beside the
 * order under the parent — a stricter metric may reorder the frontier.
 * Best-effort — the record is evidence for a reader, not a gate.
 */
function markRescored(
  runId: string, runDir: string, nodeId: string, evalVersion: string | undefined,
  succeeded: boolean, missionId?: string,
): void {
  if (!evalVersion) return;
  const dir = join(runDir, "benchmark-upgrades");
  if (!existsSync(dir)) return;
  try {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const path = join(dir, f);
      const up = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const ids = Array.isArray(up.rescore_node_ids) ? (up.rescore_node_ids as string[]) : [];
      if (up.to_eval_version !== evalVersion || !ids.includes(nodeId)) continue;
      const done = new Set(Array.isArray(up.rescored_node_ids) ? (up.rescored_node_ids as string[]) : []);
      const failed = new Set(Array.isArray(up.rescore_failed_node_ids) ? (up.rescore_failed_node_ids as string[]) : []);
      if (succeeded) { done.add(nodeId); failed.delete(nodeId); } else { failed.add(nodeId); done.delete(nodeId); }
      up.rescored_node_ids = [...done];
      up.rescore_failed_node_ids = [...failed];
      const wasComplete = up.rescore_status === "complete";
      up.rescore_status = ids.every((i) => done.has(i)) ? "complete" : "partial";
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(up, null, 2), "utf8");
      renameSync(tmp, path);
      if (!wasComplete && ids.every((i) => done.has(i) || failed.has(i))) {
        const tree = readTree(runId, missionId);
        const sign = fitnessLowerIsBetter(runDir) ? 1 : -1;
        const order = ids
          .filter((i) => done.has(i) && typeof tree[i]?.scores_by_version?.[evalVersion] === "number")
          .sort((x, y) => sign * (tree[x]!.scores_by_version![evalVersion]! - tree[y]!.scores_by_version![evalVersion]!))
          .map((i) => tree[i]?.name ?? i);
        appendFileSync(
          join(runDir, "decision-log.md"),
          `- \`${new Date().toISOString()}\` **re-score under ${evalVersion} finished** — ` +
          `frontier order under ${evalVersion}: ${order.join(", ") || "(none)"}` +
          (failed.size ? `; failed: ${[...failed].map((i) => tree[i]?.name ?? i).join(", ")}` : "") + "\n",
        );
      }
    }
  } catch { /* best-effort by design */ }
}

export function recordEval(
  runId: string,
  nodeId: string,
  result: unknown,
  missionId?: string
): {
  resultsPath: string;
  integrityVerdict: string | null;
  integrityError: string | null;
  integrityReport: unknown | null;
  evaluatorValuesKept: string[];
} {
  const paths = resolveRunPaths(runId, missionId);
  const nodeDir = join(paths.nodesDir, nodeId);

  if (!existsSync(nodeDir)) {
    mkdirSync(nodeDir, { recursive: true });
  }

  // When the evaluation job wrote its own output, its numbers are the record: the
  // agent's transcription can add fields but cannot replace a score.
  const evaluatorKept: string[] = [];
  const evaluatorPath = join(nodeDir, "results.evaluator.json");
  if (existsSync(evaluatorPath) && result && typeof result === "object") {
    try {
      const ev = JSON.parse(readFileSync(evaluatorPath, "utf8")) as Record<string, unknown>;
      const given = result as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...given };
      for (const k of EVALUATOR_FIELDS) {
        if (!(k in ev)) continue;
        if (k in given && JSON.stringify(given[k]) !== JSON.stringify(ev[k])) evaluatorKept.push(k);
        merged[k] = ev[k];
      }
      result = merged;
    } catch { /* unreadable evaluator copy: record what was given */ }
  }

  const resultsPath = join(nodeDir, "results.json");
  // A version builds a file name here, so only v<N> is ever used as one.
  const rawVersion = (result as Record<string, unknown> | null)?.eval_version;
  const scoredUnder = typeof rawVersion === "string" && VERSION_RE.test(rawVersion) ? rawVersion : undefined;
  const r = result as Record<string, unknown> | null;
  const evaluated = r?.status === "success" || r?.status === "regression";

  // Evidence, not override: results.json is the CURRENT version's result, and a
  // result under any other version survives as results.<version>.json. A run
  // whose earlier results predate per-version files gets its copy made here,
  // before the re-score replaces results.json.
  if (scoredUnder) {
    try {
      const prior = JSON.parse(readFileSync(resultsPath, "utf8")) as Record<string, unknown>;
      const priorVersion = prior.eval_version;
      if (typeof priorVersion === "string" && VERSION_RE.test(priorVersion) && priorVersion !== scoredUnder) {
        const kept = join(nodeDir, `results.${priorVersion}.json`);
        if (!existsSync(kept)) writeFileSync(kept, JSON.stringify(prior, null, 2), "utf8");
      }
    } catch { /* no prior result */ }
  }
  writeFileSync(resultsPath, JSON.stringify(result, null, 2), "utf8");
  if (scoredUnder) {
    writeFileSync(join(nodeDir, `results.${scoredUnder}.json`), JSON.stringify(result, null, 2), "utf8");
  }

  // P1-1: atomic integrity check — same call path as evor_integrity_check tool.
  // Resolves eval-script/split-path via P1-11 and seeds P2-2 cache on first call.
  // Failures are non-fatal (best-effort); orchestrator can re-check explicitly.
  //
  // Check 10 judges the node as scored under THIS result's version; the tree
  // node moves to it only once the verdict passes (below).
  let integrityVerdict: string | null = null;
  let integrityError: string | null = null;
  let integrityReport: unknown | null = null;

  const integrityResult = integrityCheck(runId, nodeId, missionId, scoredUnder);
  if (integrityResult.ok && integrityResult.report != null) {
    const report = integrityResult.report as Record<string, unknown>;
    integrityVerdict = typeof report.verdict === "string" ? report.verdict : null;
    integrityReport = integrityResult.report;
  } else if (!integrityResult.ok) {
    // Surface WHY the bridge failed (e.g. "Node X not found in tree.json") so the
    // orchestrator can act (record the node first) instead of a silent, un-diagnosable
    // null. This is what turned a missing-node into a ~30-min manual debug detour.
    integrityError = integrityResult.error ?? "integrity bridge failed";
  }

  // Cascade status → "done" and write integrity_status back to tree.json.
  // Without this, tree nodes stay status="running" forever after Forge writes results —
  // the orchestrator had to call evor_record_node 4+ extra times per run to fix it (P0-5).
  //
  // A1: the tree node's own metrics/fitness_value are also cascaded here, from the
  // very `result` object this function just wrote to results.json. Before this, the
  // scoreboard lived only in nodes/<id>/results.json — tree.json kept whatever
  // (usually empty) metrics the node had at evor_record_node time, so evor_tree_read
  // (what evor-mutagen calls to pick a parent) returned a frontier with no fitness.
  //
  // A re-score under a NEW version replaces the node's record only when it
  // passed: a failed re-score leaves the node as it was under its old version
  // (marked failed), and its old score stays in scores_by_version either way.
  try {
    const nodes = readTree(runId, missionId);
    const node = nodes[nodeId];
    if (node) {
      const updates: Partial<TreeNode> = { status: "done" };
      if (integrityVerdict === "passed" || integrityVerdict === "failed") {
        updates.integrity_status = integrityVerdict as "passed" | "failed";
      }
      const moves = !!scoredUnder && node.eval_version !== scoredUnder;
      if (!moves || integrityVerdict === "passed") {
        if (r && typeof r.metrics === "object" && r.metrics !== null) {
          updates.metrics = r.metrics as Record<string, number>;
        }
        if (typeof r?.fitness_value === "number") updates.fitness_value = r.fitness_value;
        if (moves) updates.eval_version = scoredUnder;
      }
      const scores = { ...(node.scores_by_version ?? {}) };
      if (moves && typeof node.fitness_value === "number" && !(node.eval_version in scores)) {
        scores[node.eval_version] = node.fitness_value;
      }
      // Only a completed evaluation is a score; an errored run is not a 0.
      if (scoredUnder && evaluated && typeof r?.fitness_value === "number") {
        scores[scoredUnder] = r.fitness_value;
      }
      if (Object.keys(scores).length) updates.scores_by_version = scores;
      upsertNode(runId, { ...node, ...updates }, missionId);
    }
  } catch {
    // Non-fatal: if tree.json cannot be updated the run continues; the
    // orchestrator can re-check integrity explicitly via evor_integrity_check.
  }

  // Stage 1.7: propagate fitness so the score-based stop conditions can fire.
  updateBestScore(runId, nodeId, result, integrityVerdict, missionId);
  markRescored(runId, paths.runDir, nodeId, scoredUnder, evaluated && integrityVerdict === "passed", missionId);

  return { resultsPath, integrityVerdict, integrityError, integrityReport, evaluatorValuesKept: evaluatorKept };
}

/**
 * Read nodes/<nodeId>/results.json and return parsed JSON (P2-14).
 * Eliminates the orchestrator's "cat results.json" shell-out turn.
 * Call after evor_run_status shows state='done'.
 */
export function readResult(
  runId: string,
  nodeId: string,
  missionId?: string,
  evalVersion?: string,
): { ok: boolean; data?: unknown; error?: string } {
  const paths = resolveRunPaths(runId, missionId);
  if (evalVersion !== undefined && !VERSION_RE.test(evalVersion)) {
    return { ok: false, error: "eval_version must be a version name such as v1." };
  }
  const resultPath = join(paths.nodesDir, nodeId, evalVersion ? `results.${evalVersion}.json` : "results.json");
  if (!existsSync(resultPath)) {
    return {
      ok: false,
      error: "no evaluation result for this node yet — confirm it finished with evor_run_status (state='done') before reading.",
    };
  }
  try {
    const data = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    return { ok: true, data };
  } catch {
    return { ok: false, error: "the node's evaluation result is present but could not be parsed." };
  }
}

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerRecordTools(server: McpServer): void {
  // ── evor_record_node ───────────────────────────────────────────────────────
  // Name-only surface: the agent identifies nodes by a readable `name` it coins
  // (e.g. "immune-memory-02"). The server owns the internal id entirely — it is
  // never accepted from, nor returned to, the agent. This keeps opaque ids out of
  // the agent's context so it never fabricates or carries one.
  const RecordNodeInputSchema = TreeNodeSchema.omit({ id: true }).extend({
    name: z.string().optional().describe(
      "Readable node name you coin, e.g. 'immune-memory-02'. Reused in every later "
      + "call (evor_record_eval/run_start/read_result). Auto-derived from approach_family "
      + "if omitted. Name parents in `parent_ids` by their names too.",
    ),
  });
  server.tool(
    "evor_record_node",
    "Call BEFORE evor_record_eval. Record a candidate node in the evolution tree, "
    + "identified by a readable `name` you coin (e.g. 'immune-memory-02'). Reference its "
    + "parents in `parent_ids` by their names. Returns {ok, name} — use that name in every "
    + "later node call; you never handle an internal id.",
    {
      run_id: z.string().describe("Active run identifier"),
      node: RecordNodeInputSchema.describe("Candidate node; identify it by `name` (no id — the server owns that)"),
    },
    async ({ run_id, node }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      // Recording the same candidate twice returns the first record. An agent resumed
      // after a session ends repeats the call; a second record of one worktree would
      // split the node in two (`emactl-s1-01` and `emactl-s1-01-2` on one directory).
      const asked = (node as { name?: string; code_ref?: string });
      if (asked.name && asked.code_ref) {
        let existing: TreeNode | undefined;
        try {
          existing = Object.values(readTree(run_id, missionId)).find(
            (n) => n?.name === asked.name && n?.code_ref === asked.code_ref,
          );
        } catch { existing = undefined; }
        const evaluated = existing && existsSync(join(resolveRunPaths(run_id, missionId).nodesDir, existing.id, "results.json"));
        if (existing && !evaluated) {
          const telemetryPath = join(resolveRunPaths(run_id, missionId).nodesDir, existing.id, "telemetry.jsonl");
          try { mkdirSync(dirname(telemetryPath), { recursive: true }); } catch { /* reported by the trainer's open() */ }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                name: existing.name,
                run_id,
                already_recorded: true,
                telemetry_path: telemetryPath,
                telemetry_note:
                  "This candidate was already recorded under this name and worktree; this is its record. " +
                  "Export telemetry_path EXACTLY as EVOR_TELEMETRY_PATH for the training subprocess.",
              }),
            }],
          };
        }
      }
      // Server always mints the internal id — never accepted from the agent.
      const filledNode = fillNodeId(node as Partial<TreeNode> & Omit<TreeNode, "id">);
      // Name-only surface: ensure a readable, unique name so we never expose the id.
      //  - agent-supplied name → uniquify (auto-suffix on collision, decision #1)
      //  - omitted → derive from approach_family so the response is still name-based
      filledNode.name = filledNode.name
        ? assignUniqueName(run_id, filledNode.name, missionId)
        : deriveName(run_id, filledNode.approach_family, missionId);
      // Resolve parent refs (names) → internal ids (decision #3).
      if (Array.isArray(filledNode.parent_ids)) {
        filledNode.parent_ids = filledNode.parent_ids.map((p) =>
          resolveNodeRef(run_id, p, missionId),
        );
      }
      const { pendingRemaining } = recordNode(run_id, filledNode, missionId);
      // The ONE path the caller is given, and the reason it is given one.
      //
      // Forge must export EVOR_TELEMETRY_PATH to the training subprocess, and it
      // only ever holds the NAME — this tool's whole contract is that an agent
      // never handles an internal id. So it built the path from the name, which
      // is how a single node ended up with two directories: the agent surface
      // wrote `nodes/n001-depthwise-unet/telemetry.jsonl` while the server wrote
      // `nodes/cf9f0020-…/results.json`. Integrity check 5 then failed a node
      // that had 12,000 well-formed telemetry records, under the other name.
      //
      // Granting the canonical path removes the construction, and with it the
      // choice. No internal id is exposed: the uuid appears inside an opaque
      // path the caller is meant to pass through, not to parse or to rebuild.
      const telemetryPath = join(
        resolveRunPaths(run_id, missionId).nodesDir,
        filledNode.id,
        "telemetry.jsonl",
      );
      // The trainer appends to this path and `.evor/` is closed to hand writes,
      // so the directory has to exist before the path is handed out.
      try { mkdirSync(dirname(telemetryPath), { recursive: true }); } catch { /* reported by the trainer's open() */ }
      return {
        content: [
          {
            type: "text" as const,
            // The name is what identifies the node downstream — never the id. On
            // collision the name may differ from what was asked; the caller uses
            // THIS value.
            text: JSON.stringify({
              ok: true,
              name: filledNode.name,
              run_id,
              pending_remaining: pendingRemaining,
              telemetry_path: telemetryPath,
              telemetry_note:
                "Export this EXACTLY as EVOR_TELEMETRY_PATH for the training subprocess; its " +
                "directory already exists. " +
                "Do not rebuild it from the node name — a rebuilt path can split one node's " +
                "telemetry across two directories.",
            }),
          },
        ],
      };
    }
  );

  // ── evor_record_eval ───────────────────────────────────────────────────────
  server.tool(
    "evor_record_eval",
    "Record a node's EvaluationResult and auto-trigger the integrity check. Identify the "
    + "node by the `name` you gave evor_record_node. Always call evor_record_node first. "
    + "After an evor_run_start job, omit `result`: the evaluation job's own output is recorded. "
    + "Returns {ok, name, status, integrity_verdict, integrity_report}.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe(
        "The node's name (e.g. 'immune-memory-02'), as returned by evor_record_node",
      ),
      result: EvaluationResultSchema.optional().describe(
        "The evaluation result to record. Omit it after an evor_run_start job: the job's own output is read",
      ),
    },
    async ({ run_id, node_id, result: given }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const resolvedId = resolveNodeRef(run_id, node_id, missionId);
      let result = given;
      if (!result) {
        const evPath = join(resolveRunPaths(run_id, missionId).nodesDir, resolvedId, "results.evaluator.json");
        if (!existsSync(evPath)) {
          return err(`no evaluation output for '${node_id}' yet: run evor_run_start and wait for its job, or pass result`);
        }
        const parsed = EvaluationResultSchema.safeParse(JSON.parse(readFileSync(evPath, "utf8")));
        if (!parsed.success) return err(`the evaluation output for '${node_id}' is not a valid result: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
        result = parsed.data;
      }
      // Server-owned bookkeeping: fill node_id, run_id, eval_version, timestamp
      // so the agent never fabricates or carries these values.
      const filledResult = { ...result } as Record<string, unknown>;
      if (!filledResult.node_id) filledResult.node_id = resolvedId;
      if (!filledResult.run_id) filledResult.run_id = run_id;
      if (!filledResult.timestamp) filledResult.timestamp = new Date().toISOString();
      if (!filledResult.eval_version) {
        // Read eval_version from run-state cache; fall back to "v1".
        try {
          const paths = resolveRunPaths(run_id, missionId);
          const state = readRunState(paths.runStatePath, run_id);
          filledResult.eval_version = typeof state.current_eval_version === "string"
            ? state.current_eval_version
            : "v1";
        } catch {
          filledResult.eval_version = "v1";
        }
      }
      const { integrityVerdict, integrityError, integrityReport, evaluatorValuesKept } =
        recordEval(run_id, resolvedId, filledResult, missionId);
      return {
        content: [
          {
            type: "text" as const,
            // P1-1: integrity_report is the FULL IntegrityReport inline — the orchestrator
            // never needs a separate evor_integrity_check call for the normal flow.
            // Echo the NAME the caller used, never the internal id or filesystem path.
            text: JSON.stringify({
              ok: true,
              run_id,
              name: node_id,
              status: result.status,
              integrity_verdict: integrityVerdict,
              integrity_error: integrityError,
              integrity_report: integrityReport,
              ...(evaluatorValuesKept.length
                ? {
                    evaluator_values_kept: evaluatorValuesKept,
                    note: "these fields differed from the evaluation job's own output; its values were recorded",
                  }
                : {}),
            }),
          },
        ],
      };
    }
  );

  // ── evor_read_result (P2-14) ───────────────────────────────────────────────
  server.tool(
    "evor_read_result",
    "Return a node's full evaluation result. Identify the node by the `name` you gave it. "
    + "This is the only way to read a result — never read files by hand. "
    + "Call after evor_run_status shows state='done'. Returns the full EvaluationResult object.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().optional().describe(
        "The node's name (e.g. 'immune-memory-02'), as returned by evor_record_node",
      ),
      name: z.string().optional().describe("Same as node_id"),
      node: z.string().optional().describe("Same as node_id"),
      mission_id: z.string().optional().describe(
        "Mission identifier (resolved from EVOR_MISSION_ID env when omitted)",
      ),
      eval_version: z.string().optional().describe(
        "Read the result under this eval_version (e.g. the parent of a hardening); "
        + "omit for the current one",
      ),
    },
    async ({ run_id, node_id: given, name, node, mission_id, eval_version }) => {
      const node_id = given ?? name ?? node;
      if (!node_id) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "give the node's name as node_id" }) }] };
      }
      const missionId = mission_id ?? process.env.EVOR_MISSION_ID;
      const result = readResult(run_id, resolveNodeRef(run_id, node_id, missionId), missionId, eval_version);
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? JSON.stringify({ ok: true, ...(result.data as Record<string, unknown>) })
              : JSON.stringify({ ok: false, error: result.error }),
          },
        ],
      };
    }
  );
}
