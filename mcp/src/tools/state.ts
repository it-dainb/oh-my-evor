/**
 * tools/state.ts
 * evor_state_read        — read run-state.json (+ tick-state.json when present)
 * evor_state_write       — merge-patch run-state.json; strategy delta; tick-state; active-run
 * evor_read_goal_contract — read and validate goal-contract.json → GoalContract
 * evor_check_plateau     — read tick history scores and detect plateau / consecutive regression
 * evor_lock_mission      — validate-then-lock atomically (Area 1)
 * evor_check_stop        — server-side stop verdict by StopCondition type (Area 4)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoalContractSchema, StrategyStateSchema } from "../contracts.js";
import { resolveRunPaths, ensureRunDirs, getActiveRunPath, getEvorRoot } from "../run-store.js";
import { readRunState, writeRunState } from "./record.js";
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
});

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

  return state;
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
export function stateWrite(
  runId: string,
  patch: z.infer<typeof RunStatePatchSchema>,
  missionId?: string
): Record<string, unknown> {
  const paths = ensureRunDirs(runId, missionId);

  // Destructure extended fields so they don't pollute run-state.json.
  const {
    strategy: strategyDelta,
    mission_status: missionStatus,
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
    ms.status = missionStatus;
    ms.updated_at = new Date().toISOString();
    const msTmp = `${missionStatePath}.tmp`;
    writeFileSync(msTmp, JSON.stringify(ms, null, 2), "utf8");
    renameSync(msTmp, missionStatePath);
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
