/**
 * tools/state.ts
 * evor_state_read        — read run-state.json (+ tick-state.json when present)
 * evor_state_write       — merge-patch run-state.json; strategy delta; tick-state; active-run
 * evor_read_goal_contract — read and validate goal-contract.json → GoalContract
 * evor_check_plateau     — read tick history scores and detect plateau / consecutive regression
 * evor_lock_mission      — validate-then-lock atomically (Area 1)
 * evor_check_stop        — server-side stop verdict by StopCondition type (Area 4)
 */

import { homedir } from "os";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoalContractSchema, StrategyStateSchema } from "../contracts.js";
import { resolveRunPaths, ensureRunDirs, getActiveRunPath, getEvorRoot } from "../run-store.js";
import { readRunState, writeRunState } from "./record.js";
import { assertReachable, initialState, isStale, isTerminal, maxDwellSeconds } from "../fsm.js";
import { callPythonModule } from "../subprocess-bridge.js";

// ── Tick-state schema (spec §15B) ──────────────────────────────────────────

const TickStateSchema = z.object({
  tick: z.number().int().min(0).describe("Current tick number"),
  current_step: z.number().int().min(0).describe("Step within the tick (0-indexed)"),
  step_status: z
    .enum(["pending", "running", "done", "failed"])
    .describe("Status of current_step"),
  step_outputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Keyed outputs produced by completed steps"),
  updated_at: z.string().optional().describe("ISO 8601 timestamp of last update"),
});

/** Minimal run-state fields tracked by the MCP server. (exported for tests) */
export const RunStatePatchSchema = z.object({
  status: z
    .enum(["initialized", "running", "paused", "completed", "failed"])
    .optional()
    .describe("Run lifecycle status"),
  tick_count: z.number().int().min(0).optional().describe("Number of completed ticks"),
  best_score: z.number().optional().describe("Best primary metric value achieved so far"),
  frontier_ids: z.array(z.string()).optional().describe("Node IDs currently on the frontier"),
  current_eval_version: z.string().optional().describe("Active EvalSuite version"),
  pending_node_ids: z
    .array(z.string())
    .optional()
    .describe("Node names started in this tick but not yet recorded to the tree"),
  strategy: StrategyStateSchema.partial().optional().describe("Strategy fields to update"),
  // ── Extended fields (spec §1 evor_state_write extension) ─────────────────
  mission_status: z
    .preprocess(
      // The run lifecycle uses "initialized"; the mission lifecycle's equivalent
      // opening state is "draft". Coerce that common mix-up instead of rejecting it.
      (v) => (v === "initialized" ? "draft" : v),
      // "locked" is deliberately absent: it is reachable only through
      // evor_lock_mission, which validates first and then flips mission-state
      // directly. Leaving it here made the tool description's "always call
      // evor_lock_mission instead" a request rather than a constraint.
      z.enum(["draft", "running", "paused", "completed", "failed"]),
    )
    .optional()
    .describe(
      "Mission lifecycle state (draft, locked, running, paused, completed, failed). " +
      "If set, patches the mission's status (gate: draft→locked requires contract validation).",
    ),
  mission_status_reason: z
    .string()
    .optional()
    .describe(
      "Why a mission reached this status. Recorded with the transition. The field " +
      "run's reason was typed into the artifact by hand 14h39m later, because the " +
      "tool surface had no way to express it (I-11).",
    ),
  superseded_by: z
    .string()
    .optional()
    .describe(
      "Mission id that supersedes this one. r1 -> r2 -> r3 were three attempts at " +
      "one goal and there was no supported way to link them, so the link was " +
      "hand-written into the state file after the fact.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Why this transition is being made. Recorded in transitions.jsonl at the moment " +
      "of the write, never backfilled. K-08's supersession reason had to be reconstructed " +
      "afterwards by a human editing JSON in vim, because nothing captured it when it happened.",
    ),
  active_run: z
    .object({
      mission_id: z.string(),
      run_id: z.string(),
      run_dir: z.string(),
      job_id: z.string().optional().describe("Job identifier from evor_run_start; enables monitor lookup"),
      status: z.string().optional(),
      started_at: z.string().optional(),
    })
    .optional()
    .describe("If set, records the active run pointer"),
  // ── Tick-state extension (spec §15B) ──────────────────────────────────────
  tick_state: TickStateSchema.optional().describe(
    "If set, atomically writes tick-state.json in the run directory; " +
    "read by all agents to determine current tick and step progress",
  ),
  // ── P2-8: Forge attempt tracking ──────────────────────────────────────────
  forge_attempt: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Number of Forge attempts made for the current node in this tick. " +
      "Increment on each attempt; check with shouldAbortForge() before spawning a new one. " +
      "Reset to 0 at the start of each new tick/node.",
    ),
  // ── Area 4 prereq: cost tracking ──────────────────────────────────────────
  total_cost_usd: z
    .number()
    .min(0)
    .optional()
    .describe(
      "Cumulative cost in USD for this run so far. " +
      "Used by evor_check_stop to evaluate budget-based stop conditions.",
    ),
  // ── Area 3: prediction bias sample (server-side rolling avg) ──────────────
  prediction_bias_sample: z
    .object({
      predicted_gain: z.number().describe("Predicted gain from the mutation proposal"),
      actual_gain: z.number().describe("Actual gain observed after evaluation"),
    })
    .optional()
    .describe(
      "When present, compute bias=(predicted-actual)/(predicted+1e-9) and accumulate " +
      "into prediction_bias_history (rolling avg_bias + n_samples) server-side. " +
      "Must not be set together with a direct prediction_bias_history write.",
    ),
})
  // 1.2 — the merge patch stops accepting arbitrary keys.
  //
  // A zod object STRIPS unknown keys by default, so `evor_state_write({bogus: 1})`
  // returned success and wrote nothing: the agent was told the write happened and
  // the field simply was not there afterwards. That is the same silent-drop defect
  // 1.6 fixed on the Python contracts, reached through the other language, and it
  // is worse here because run-state is the thing the whole governance layer reads.
  //
  // `.strict()` makes the rejection loud. It is the enforcement half of "one
  // server-side writer per state variable": a writer that accepts any key is not
  // an owner of anything.
  .strict();

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Read run-state.json and return the parsed state object.
 *
 * When tick-state.json is present in the run directory it is merged into the
 * response under the `tick_state` key so agents have a single call to get
 * the complete current state.
 */
export function stateRead(runId: string, missionId?: string): Record<string, unknown> {
  const paths = resolveRunPaths(runId, missionId);
  const state = readRunState(paths.runStatePath, runId) as Record<string, unknown>;

  // Merge tick-state.json if present.
  const tickStatePath = join(paths.runDir, "tick-state.json");
  if (existsSync(tickStatePath)) {
    try {
      state.tick_state = JSON.parse(readFileSync(tickStatePath, "utf8"));
    } catch {
      // corrupt tick-state.json — omit from response rather than crashing
    }
  }

  // ── K-09 / C-03: report staleness (items 3.3, 3.4) ─────────────────────────
  //
  // The field run sat at ONE step for 8h16m and nothing anywhere was asking
  // whether it was still alive. That was not a missing alarm, it was a missing
  // PREDICATE: liveness required an event nobody emitted. With 3.3's dwell limits
  // it is arithmetic over two fields, so any reader can compute it — and this is
  // the reader every agent already calls.
  //
  // Reported, not enforced. `stateRead` answers questions; refusing to return
  // state because it looks stale would make the system least observable exactly
  // when observation matters most.
  const tick = state.tick_state as Record<string, unknown> | undefined;
  if (tick) {
    const stepStatus = String(tick.step_status ?? "");
    const enteredAt = (tick.entered_at ?? tick.updated_at ?? tick.started_at) as string | undefined;
    if (stepStatus && enteredAt && isStale("tick", stepStatus, enteredAt)) {
      state.stalled = true;
      const limit = maxDwellSeconds("tick", stepStatus);
      const ageS = Math.round((Date.now() - Date.parse(enteredAt)) / 1000);
      // Name the step, because a stall report that does not say WHERE is not
      // actionable — and "which step" is the first question anyone asks.
      state.stall_reason =
        `tick ${tick.tick ?? "?"} has been at step ${tick.current_step ?? "?"} ` +
        `(step_status="${stepStatus}") for ${Math.round(ageS / 60)} min, past its ` +
        `${limit}s limit for that state`;
    } else {
      state.stalled = false;
    }
  }

  return state;
}

/**
 * Take the root's exclusive "running" claim for `missionId` (O-09, item 1.9).
 *
 * THREE missions read status "running" concurrently for 15.6 hours. Nothing in
 * the writer referred to any other mission in the root, so "only one at a time"
 * was true of nothing.
 *
 * A CLAIM RECORD rather than a scan of sibling `mission-state.json` files. The
 * scan was written first and is the wrong shape: those files are ordinary state
 * that anything can write, so a scan cannot tell the mission legitimately
 * holding the claim from one that merely says it does — which is exactly the
 * failure, three missions each asserting `running` and every assertion equally
 * unbacked. A claim has an owner, and the owner is this writer.
 *
 * Stale claims self-heal: if the holder's own state no longer says running, its
 * claim is void and reclaimable. A crashed run must not lock the root forever —
 * that would be F6's un-drawn edge with a different name.
 */
function claimRunningMission(runDir: string, missionId: string): void {
  const runsRoot = dirname(dirname(runDir));
  const claimPath = join(runsRoot, "running-mission.json");

  let holder: string | null = null;
  if (existsSync(claimPath)) {
    try { holder = String(JSON.parse(readFileSync(claimPath, "utf8"))?.mission_id ?? "") || null; }
    catch { holder = null; }
  }

  if (holder && holder !== missionId && missionStillRunning(runsRoot, holder)) {
    throw new Error(
      `refusing to mark '${missionId}' running: '${holder}' already holds the running ` +
      `claim in this .evor/ root. Two missions advancing concurrently each compute a ` +
      `frontier the other invalidates. Complete, fail or pause '${holder}' first.`,
    );
  }

  try {
    writeFileSync(
      claimPath,
      JSON.stringify({ mission_id: missionId, claimed_at: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch { /* unwritable root — the state write itself still stands */ }
}

/** Release the claim when a mission stops running, so the next one can take it. */
function releaseRunningMission(runDir: string, missionId: string): void {
  const claimPath = join(dirname(dirname(runDir)), "running-mission.json");
  try {
    if (!existsSync(claimPath)) return;
    if (String(JSON.parse(readFileSync(claimPath, "utf8"))?.mission_id ?? "") !== missionId) return;
    unlinkSync(claimPath);
  } catch { /* best effort */ }
}

/** Does the claimed holder's own state still say running? */
function missionStillRunning(runsRoot: string, missionId: string): boolean {
  try {
    const missionDir = join(runsRoot, missionId);
    for (const run of readdirSync(missionDir, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      const msPath = join(missionDir, run.name, "mission-state.json");
      if (!existsSync(msPath)) continue;
      try {
        if (String(JSON.parse(readFileSync(msPath, "utf8"))?.status ?? "") === "running") return true;
      } catch { /* unreadable — not evidence the holder is alive */ }
    }
  } catch { /* the holder's directory is gone; the claim is void */ }
  return false;
}


/**
 * Append one line to `decision-log.md` — item I-01.
 *
 * Four classes of materially significant action never reached this file, and a
 * mission transition is the largest single event a run can record. It survived
 * only as a mutated field with no history: the log is what a human reads to
 * reconstruct what a 19-hour run did, and it said nothing about the run ending.
 *
 * Best-effort. An unwritable log must not fail the write it describes — the log
 * is evidence, not a gate.
 */
function appendDecision(runDir: string, what: string, why: string): void {
  try {
    const line = `- \`${new Date().toISOString()}\` **${what}** — ${why}\n`;
    appendFileSync(join(runDir, "decision-log.md"), line);
  } catch {
    // best-effort by design — see above
  }
}

/**
 * Append one transition to `<runDir>/transitions.jsonl` — the audit layer of 3.1.
 *
 * Best-effort: an unwritable audit log must not fail the write it describes. The
 * log is evidence, not a gate, and turning it into one would make the state
 * machine less available than the thing it governs.
 */
function appendTransition(runDir: string, record: Record<string, unknown>): void {
  try {
    appendFileSync(
      join(runDir, "transitions.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n",
    );
  } catch {
    // best-effort by design — see above
  }
}

/**
 * Merge patch fields into run-state.json.
 *
 * Extended side-effects (each conditional):
 *   - strategy  → shallow-merge into strategy.json
 *   - mission_status → patch mission-state.json
 *   - active_run     → write active-run.json atomically
 *   - tick_state     → write tick-state.json atomically
 */
/**
 * Refuse to write run state into the plugin's own install tree (item 1.3 / P-02).
 *
 * The field run wrote `active-run.json` and a whole
 * `runs/frontier-1ms/run-live-01/` into BOTH the plugin cache and the
 * marketplace clone. A run recorded there is destroyed by the next
 * `claude plugin update`, and it leaks into every future project that installs
 * the plugin — which is exactly how Q-01's decoy `.evor/` came to exist for the
 * hooks to find.
 *
 * The hook-side resolver stopped RESOLVING there; this stops the MCP side
 * WRITING there. Both were needed: fixing only the reader leaves the writer
 * free to keep creating the thing the reader must now avoid.
 */
function assertStateRootOutsidePlugin(runDir: string): void {
  const resolved = resolve(runDir);

  // Structural first: a plugin install is recognised by the SHAPE of its path,
  // `.../plugins/cache/...` or `.../plugins/marketplaces/...`, wherever it is
  // rooted. Keying on `homedir()` alone would miss a plugin tree anywhere else —
  // and the shape is the thing that makes it a plugin tree.
  const parts = resolved.split(sep);
  const pluginsAt = parts.lastIndexOf("plugins");
  if (pluginsAt >= 0 && ["cache", "marketplaces"].includes(parts[pluginsAt + 1] ?? "")) {
    throw new Error(
      `refusing to write run state inside the plugin install (${parts.slice(0, pluginsAt + 2).join(sep)}). ` +
      `A run recorded there is destroyed by the next plugin update and leaks into ` +
      `every project that installs the plugin — which is how the decoy .evor/ that ` +
      `Q-01's hooks read for 19 hours came to exist. Set EVOR_ROOT to a directory in ` +
      `the PROJECT, or run from the project directory.`,
    );
  }

  // Then the roots we are explicitly told about.
  for (const root of [process.env.CLAUDE_PLUGIN_ROOT, process.env.EVOR_PLUGIN_ROOT].filter(Boolean) as string[]) {
    const r = resolve(root);
    if (resolved === r || resolved.startsWith(r + sep)) {
      throw new Error(
        `refusing to write run state inside the plugin install (${r}). ` +
        `Set EVOR_ROOT to a directory in the PROJECT, or run from the project directory.`,
      );
    }
  }
}

export function stateWrite(
  runId: string,
  patch: z.infer<typeof RunStatePatchSchema>,
  missionId?: string
): Record<string, unknown> {
  const paths = ensureRunDirs(runId, missionId);
  assertStateRootOutsidePlugin(paths.runDir);

  // Destructure extended fields so they don't pollute run-state.json.
  const {
    strategy: strategyDelta,
    mission_status: missionStatus,
    // Destructured so the reason lands in transitions.jsonl and NOT in
    // run-state.json — it explains one edge, it is not run state.
    reason: patchReason,
    mission_status_reason: missionStatusReason,
    superseded_by: supersededBy,
    active_run: activeRun,
    tick_state: tickState,
    prediction_bias_sample: biasSample,
    ...statePatch
  } = patch;

  // Merge remaining patch into run-state.json (field-level replace).
  const current = readRunState(paths.runStatePath, runId);
  const updated: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(statePatch)) {
    if (v !== undefined) {
      updated[k] = v;
    }
  }
  // Area 3: when prediction_bias_sample is present, compute and accumulate
  // the rolling bias into run-state.json before the final write.
  // This must not conflict with callers that write prediction_bias_history directly.
  if (biasSample !== undefined) {
    const bias = (biasSample.predicted_gain - biasSample.actual_gain)
      / (biasSample.predicted_gain + 1e-9);
    // Read existing bias history from the pre-patch state (current, not disk-re-read).
    const prevHistory = typeof current.prediction_bias_history === "object"
      && current.prediction_bias_history !== null
      ? current.prediction_bias_history as Record<string, unknown>
      : {};
    const prevAvg = typeof prevHistory.avg_bias === "number" ? prevHistory.avg_bias : 0;
    const prevN = typeof prevHistory.n_samples === "number" ? prevHistory.n_samples : 0;
    const newN = prevN + 1;
    const newAvg = (prevAvg * prevN + bias) / newN;
    const newHistory = { avg_bias: newAvg, n_samples: newN };
    // Only set if the caller did NOT also set prediction_bias_history directly.
    if (updated.prediction_bias_history === prevHistory || updated.prediction_bias_history === undefined) {
      updated.prediction_bias_history = newHistory;
    }
  }
  writeRunState(paths.runStatePath, updated);

  // If a strategy delta is provided, shallow-merge it into strategy.json.
  if (strategyDelta && Object.keys(strategyDelta).length > 0) {
    let currentStrategy: Record<string, unknown> = {};
    if (existsSync(paths.strategyPath)) {
      try {
        currentStrategy = JSON.parse(readFileSync(paths.strategyPath, "utf8"));
      } catch {
        // corrupt strategy.json — start fresh
      }
    }
    const updatedStrategy = { ...currentStrategy, ...strategyDelta };
    const strategyTmpPath = `${paths.strategyPath}.tmp`;
    writeFileSync(strategyTmpPath, JSON.stringify(updatedStrategy, null, 2), "utf8");
    renameSync(strategyTmpPath, paths.strategyPath);
  }

  // If mission_status is provided, patch mission-state.json in the run dir.
  if (missionStatus !== undefined) {
    const missionStatePath = join(paths.runDir, "mission-state.json");
    let ms: Record<string, unknown> = {};
    if (existsSync(missionStatePath)) {
      try {
        ms = JSON.parse(readFileSync(missionStatePath, "utf8"));
      } catch {
        // corrupt mission-state.json — start fresh
      }
    }
    // ── 3.1: ENFORCEMENT. The MCP write path is the single writer, and this
    // is where an illegal edge is refused. Readers (hooks) interpret the same
    // table but never police it: `stop.mjs` has five deliberate fail-open
    // catches, so a guard evaluated there is a suggestion, and AF3 risk 2 is
    // that not saying so lets the two drift.
    //
    // Before this, a writer set `status` to whatever it liked. Three status
    // fields disagreed in the field simultaneously (O-05) and nothing reported
    // it, because there was nothing to disagree WITH — no table said which
    // values were reachable from which.
    const from = String(ms.status ?? initialState("mission"));
    assertReachable("mission", from, missionStatus);

    // ── O-09 (item 1.9): runs of one mission do not overlap, and neither do
    // missions of one campaign. THREE missions read status "running"
    // concurrently for 15.6 hours: nothing in the writer referred to any other
    // mission in the root, so "only one at a time" was true of nothing.
    //
    // 1.9 decided the semantics; this is the writer enforcing them, which is
    // where AF3 risk 2 says enforcement has to live.
    const thisMission = missionId ?? String(ms.mission_id ?? "");
    if (missionStatus === "running") {
      claimRunningMission(paths.runDir, thisMission);
    } else if (isTerminal("mission", missionStatus) || missionStatus === "paused") {
      releaseRunningMission(paths.runDir, thisMission);
    }

    // ── I-11: an APPEND-ONLY trail on the entity itself ──────────────────
    //
    // `mission-state.json` recorded only the CURRENT status, so a running→paused
    // transition was overwritten by paused→failed and simply gone. Two writes,
    // zero surviving history. `transitions.jsonl` (3.1) is the run-level audit;
    // this is the same fact carried by the object a reader already has open,
    // which is what makes it survive being copied, archived or inspected alone.
    const now = new Date().toISOString();
    const history = Array.isArray(ms.status_history) ? ms.status_history : [];
    history.push({
      at: now,
      from,
      to: missionStatus,
      actor: "evor_state_write",
      reason: (missionStatusReason ?? patchReason) ?? null,
    });
    ms.status_history = history;

    ms.status = missionStatus;
    ms.updated_at = now;
    if (missionStatusReason !== undefined) ms.status_reason = missionStatusReason;
    if (supersededBy !== undefined) ms.superseded_by = supersededBy;
    // 3.3: every state carries when it was entered, so "is this still alive?"
    // becomes arithmetic any reader in any language can do from the file alone.
    // That one field is what makes C-01, K-09 and C-03 observable at all.
    ms.entered_at = now;
    const msTmp = `${missionStatePath}.tmp`;
    writeFileSync(msTmp, JSON.stringify(ms, null, 2), "utf8");
    renameSync(msTmp, missionStatePath);

    // 3.1 audit: append-only, with a CONTEMPORANEOUS reason. K-08's supersession
    // reason had to be reconstructed afterwards by a human editing JSON in vim,
    // because nothing recorded why a transition happened when it happened.
    appendDecision(paths.runDir, `mission ${from} -> ${missionStatus}`,
      String(missionStatusReason ?? patchReason ?? "(no reason given)"));
    appendTransition(paths.runDir, {
      entity: "mission",
      entity_id: missionId ?? String(ms.mission_id ?? ""),
      from,
      to: missionStatus,
      actor: "evor_state_write",
      reason: typeof patchReason === "string" ? patchReason : null,
    });
  }

  // If active_run is provided, write <evor_root>/active-run.json atomically.
  if (activeRun !== undefined) {
    const evorRoot = getEvorRoot();
    mkdirSync(evorRoot, { recursive: true });
    const arPath = getActiveRunPath();
    const arTmp = `${arPath}.tmp`;
    writeFileSync(arTmp, JSON.stringify(activeRun, null, 2), "utf8");
    renameSync(arTmp, arPath);
  }

  // If tick_state is provided, write tick-state.json atomically in the run dir.
  if (tickState !== undefined) {
    const tickStatePath = join(paths.runDir, "tick-state.json");
    const tsData = {
      ...tickState,
      updated_at: tickState.updated_at ?? new Date().toISOString(),
    };
    const tsTmp = `${tickStatePath}.tmp`;
    writeFileSync(tsTmp, JSON.stringify(tsData, null, 2), "utf8");
    renameSync(tsTmp, tickStatePath);
  }

  return updated;
}

// ── Plateau detection (P1-3 — adaptive meta-trigger) ───────────────────────

/** Result shape for checkPlateauCondition */
export interface PlateauResult {
  plateau: boolean;
  consecutive_regression: boolean;
  ticks_checked: number;
  scores: number[];
}

/**
 * Read `tick_history_scores` from run-state.json and detect:
 *   - plateau: last 3 scores all within 0.5% relative spread of each other
 *   - consecutive_regression: last 2 scores each lower than the one before them
 *
 * Returns {plateau:false, consecutive_regression:false, ticks_checked:0, scores:[]}
 * when no history exists or fewer than the required ticks are available.
 */
export function checkPlateauCondition(runId: string, missionId?: string): PlateauResult {
  const state = stateRead(runId, missionId);
  const rawScores = state.tick_history_scores;

  if (!Array.isArray(rawScores) || rawScores.length === 0) {
    return { plateau: false, consecutive_regression: false, ticks_checked: 0, scores: [] };
  }

  const scores = rawScores as number[];
  const ticks_checked = scores.length;

  // Plateau: last 3 scores within 0.5% relative spread (need at least 3)
  let plateau = false;
  if (scores.length >= 3) {
    const last3 = scores.slice(-3);
    const maxVal = Math.max(...last3);
    const minVal = Math.min(...last3);
    // relative spread = (max - min) / max
    const spread = maxVal > 0 ? (maxVal - minVal) / maxVal : 0;
    plateau = spread <= 0.005; // 0.5%
  }

  // Consecutive regression: last 2 scores each lower than the tick before them (need at least 3)
  let consecutive_regression = false;
  if (scores.length >= 3) {
    const n = scores.length;
    const reg1 = scores[n - 1] < scores[n - 2]; // most recent tick regressed
    const reg2 = scores[n - 2] < scores[n - 3]; // tick before that also regressed
    consecutive_regression = reg1 && reg2;
    // A plateau and regression are mutually exclusive in definition but we keep them separate
    if (consecutive_regression) {
      plateau = false;
    }
  }

  return { plateau, consecutive_regression, ticks_checked, scores };
}

/**
 * Read and validate goal-contract.json from the run directory.
 *
 * Returns the parsed GoalContract or an error. The contract is validated
 * against GoalContractSchema (Zod); unknown/extra fields are stripped.
 */
export function readGoalContract(
  runId: string,
  missionId?: string,
): { ok: boolean; contract?: z.infer<typeof GoalContractSchema>; error?: string } {
  const paths = resolveRunPaths(runId, missionId);
  const contractPath = join(paths.runDir, "goal-contract.json");

  if (!existsSync(contractPath)) {
    return {
      ok: false,
      error: "no goal contract for this run — initialize the run with evor_init_run first.",
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch {
    return {
      ok: false,
      error: "the run's goal contract is present but could not be parsed.",
    };
  }

  const parsed = GoalContractSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `the run's goal contract failed validation: ${parsed.error.message}`,
    };
  }

  return { ok: true, contract: parsed.data };
}

// ── P2-8: Forge attempt bound helper ─────────────────────────────────────────

/**
 * Returns true when the Forge agent should be aborted because it has already
 * attempted `forge_attempt` times and the configured maximum has been reached.
 *
 * Usage (in Forge or the stop-hook):
 *   const state = stateRead(runId);
 *   if (shouldAbortForge(state.forge_attempt as number ?? 0)) {
 *     // escalate to Evor rather than spawning another attempt
 *   }
 *
 * @param forge_attempt Number of attempts already made (from run-state).
 * @param max           Maximum allowed attempts (default: 2).
 */
export function shouldAbortForge(forge_attempt: number, max = 2): boolean {
  return forge_attempt >= max;
}

// ── Area 1: evor_lock_mission core logic ───────────────────────────────────

/** Result shape for lockMission */
export interface LockMissionResult {
  ok: boolean;
  run_id?: string;
  mission_status?: string;
  validation_report?: unknown;
  error?: string;
}

/**
 * Validate the run's contracts via `python -m evor validate --run-id <runDir>`,
 * then atomically flip mission-state.json status to "locked" on pass.
 *
 * Returns { ok: true, mission_status: "locked", validation_report } on success,
 * or { ok: false, error, validation_report } on validation failure.
 */
export function lockMission(runId: string, missionId?: string): LockMissionResult {
  const paths = resolveRunPaths(runId, missionId);

  // Run validation via subprocess (same pattern as evor_validate).
  const pyResult = callPythonModule("evor", ["validate", "--run-id", paths.runDir]);
  const validationReport = pyResult.data ?? null;

  if (!pyResult.ok) {
    return {
      ok: false,
      error: pyResult.error ?? "validation failed",
      validation_report: validationReport,
    };
  }

  // Check that the report itself says ok=true.
  if (
    validationReport === null ||
    typeof validationReport !== "object" ||
    !(validationReport as Record<string, unknown>).ok
  ) {
    return {
      ok: false,
      error: "validation report returned ok=false",
      validation_report: validationReport,
    };
  }

  // Atomically flip mission-state.json status to "locked".
  const missionStatePath = join(paths.runDir, "mission-state.json");
  let ms: Record<string, unknown> = {};
  if (existsSync(missionStatePath)) {
    try {
      ms = JSON.parse(readFileSync(missionStatePath, "utf8"));
    } catch {
      // corrupt mission-state.json — start fresh
    }
  }
  ms.status = "locked";
  ms.updated_at = new Date().toISOString();
  const msTmp = `${missionStatePath}.tmp`;
  writeFileSync(msTmp, JSON.stringify(ms, null, 2), "utf8");
  renameSync(msTmp, missionStatePath);

  return {
    ok: true,
    run_id: runId,
    mission_status: "locked",
    validation_report: validationReport,
  };
}

// ── Area 4: evor_check_stop core logic ─────────────────────────────────────

/** Result shape for checkStop */
export interface StopVerdictResult {
  ok: boolean;
  should_stop: boolean;
  reason: string;
  tick_count: number;
  best_score: number;
  frontier_count: number;
  budget_remaining?: Record<string, unknown>;
  error?: string;
}

/**
 * Evaluate all stop conditions for the run by calling
 * `python -m evor.tree check-stop --run-id <runDir>`.
 *
 * Returns a StopVerdict with should_stop + reason + run metrics.
 */
export function checkStop(runId: string, missionId?: string): StopVerdictResult {
  const paths = resolveRunPaths(runId, missionId);

  const pyResult = callPythonModule("evor.tree", ["check-stop", "--run-id", paths.runDir]);

  if (!pyResult.ok || pyResult.data == null) {
    return {
      ok: false,
      should_stop: false,
      reason: pyResult.error ?? "evor_check_stop failed",
      tick_count: 0,
      best_score: 0,
      frontier_count: 0,
      error: pyResult.error ?? "evor_check_stop failed",
    };
  }

  const data = pyResult.data as Record<string, unknown>;
  return {
    ok: true,
    should_stop: Boolean(data.should_stop),
    reason: String(data.reason ?? ""),
    tick_count: typeof data.tick_count === "number" ? data.tick_count : 0,
    best_score: typeof data.best_score === "number" ? data.best_score : 0,
    frontier_count: typeof data.frontier_count === "number" ? data.frontier_count : 0,
    budget_remaining: typeof data.budget_remaining === "object" && data.budget_remaining !== null
      ? data.budget_remaining as Record<string, unknown>
      : undefined,
  };
}

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerStateTools(server: McpServer): void {
  // ── evor_state_read ────────────────────────────────────────────────────────
  server.tool(
    "evor_state_read",
    "Return the current RunState for the run (including tick state when present). " +
    "tick_state is merged into the response when tick-state.json exists.",
    {
      run_id: z.string().describe("Active run identifier"),
    },
    async ({ run_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const state = stateRead(run_id, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(state),
          },
        ],
      };
    }
  );

  // ── evor_state_write ───────────────────────────────────────────────────────
  server.tool(
    "evor_state_write",
    "Merge-patch the run's RunState with the given fields. " +
    "Optional side-effects: strategy→strategy.json, mission_status→mission-state.json, " +
    "active_run→active-run.json (include job_id to enable monitor lookup), " +
    "tick_state→tick-state.json (atomic; 10 read sites per tick).",
    {
      run_id: z.string().describe("Active run identifier"),
      patch: RunStatePatchSchema.describe("Fields to merge into the RunState"),
    },
    async ({ run_id, patch }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const updated = stateWrite(run_id, patch, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, run_id, state: updated }),
          },
        ],
      };
    }
  );

  // ── evor_check_plateau ─────────────────────────────────────────────────────
  server.tool(
    "evor_check_plateau",
    "Read the run's tick-history scores and detect plateau or consecutive regression. " +
    "Returns {plateau, consecutive_regression, ticks_checked, scores[]}. " +
    "plateau=true when last 3 scores are within 0.5% of each other (no meaningful improvement). " +
    "consecutive_regression=true when last 2 ticks both regressed below their predecessor. " +
    "Returns plateau=false when fewer than 3 ticks are available (insufficient data).",
    {
      run_id: z.string().describe("Active run identifier"),
    },
    async ({ run_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = checkPlateauCondition(run_id, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, run_id, ...result }),
          },
        ],
      };
    }
  );

  // ── evor_read_goal_contract ────────────────────────────────────────────────
  server.tool(
    "evor_read_goal_contract",
    "Read the run's validated GoalContract. " +
    "Returns {ok:true,...contract}, or {ok:false,error} when it is missing or invalid.",
    {
      run_id: z.string().describe("Active run identifier"),
    },
    async ({ run_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = readGoalContract(run_id, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              result.ok
                ? { ok: true, run_id, contract: result.contract }
                : { ok: false, error: result.error }
            ),
          },
        ],
      };
    }
  );

  // ── evor_lock_mission (Area 1) ─────────────────────────────────────────────
  server.tool(
    "evor_lock_mission",
    "Validate the run's goal-contract, frozen splits, tree, and run-state via the harness, " +
    "then atomically flip mission-state.json status to 'locked' on pass. " +
    "Returns { ok, mission_status, validation_report } on success; " +
    "{ ok:false, error, validation_report } when validation fails (status stays draft). " +
    "Replaces agent self-lock — always call this instead of writing mission_status='locked' directly.",
    {
      run_id: z.string().describe("Active run identifier"),
      mission_id: z.string().optional().describe("Mission identifier (inferred when omitted)"),
    },
    async ({ run_id, mission_id }) => {
      const missionId = mission_id ?? process.env.EVOR_MISSION_ID;
      const result = lockMission(run_id, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );

  // ── evor_check_stop (Area 4) ───────────────────────────────────────────────
  server.tool(
    "evor_check_stop",
    "Evaluate all stop conditions for the run (beat-baseline, target, evolve-n, " +
    "maximize-under-budget, evolve-until-plateau, evolve-until-regression, " +
    "worst-angle-plateau, coverage-target) plus the circuit-breaker override. " +
    "Returns { should_stop, reason, tick_count, best_score, frontier_count, budget_remaining }. " +
    "Replaces inline stop predicates in the evor skill; call once per tick before proposing.",
    {
      run_id: z.string().describe("Active run identifier"),
      mission_id: z.string().optional().describe("Mission identifier (inferred when omitted)"),
    },
    async ({ run_id, mission_id }) => {
      const missionId = mission_id ?? process.env.EVOR_MISSION_ID;
      const result = checkStop(run_id, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );
}
