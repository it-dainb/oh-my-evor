/**
 * tools/state.ts
 * evor_state_read        — read run-state.json (+ tick-state.json when present)
 * evor_state_write       — merge-patch run-state.json; strategy delta; tick-state; active-run
 * evor_read_goal_contract — read and validate goal-contract.json → GoalContract
 * evor_check_plateau     — read tick history scores and detect plateau / consecutive regression
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoalContractSchema, StrategyStateSchema } from "../contracts.js";
import { resolveRunPaths, ensureRunDirs, getActiveRunPath, getEvorRoot } from "../run-store.js";
import { readRunState, writeRunState } from "./record.js";

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

/** Minimal run-state fields tracked by the MCP server. */
const RunStatePatchSchema = z.object({
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
    .describe("Node IDs started in this tick but not yet written to tree.json"),
  strategy: StrategyStateSchema.partial().optional().describe("Strategy delta to merge into strategy.json"),
  // ── Extended fields (spec §1 evor_state_write extension) ─────────────────
  mission_status: z
    .enum(["draft", "locked", "running", "paused", "completed", "failed"])
    .optional()
    .describe("If set, patches mission-state.json .status (gate: draft→locked requires contract validation)"),
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
    .describe("If set, writes <evor_root>/active-run.json atomically"),
  // ── Tick-state extension (spec §15B) ──────────────────────────────────────
  tick_state: TickStateSchema.optional().describe(
    "If set, atomically writes tick-state.json in the run directory; " +
    "read by all agents to determine current tick and step progress",
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
      error: `goal-contract.json not found at ${contractPath}`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse goal-contract.json: ${(err as Error).message}`,
    };
  }

  const parsed = GoalContractSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `goal-contract.json validation failed: ${parsed.error.message}`,
    };
  }

  return { ok: true, contract: parsed.data };
}

// ── Tool registrations ──────────────────────────────────────────────────────

export function registerStateTools(server: McpServer): void {
  // ── evor_state_read ────────────────────────────────────────────────────────
  server.tool(
    "evor_state_read",
    "Read run-state.json (+ tick-state.json when present) and return the current RunState. " +
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
    "Merge-patch run-state.json with the given fields. " +
    "Optional side-effects: strategy→strategy.json, mission_status→mission-state.json, " +
    "active_run→active-run.json (include job_id to enable monitor lookup), " +
    "tick_state→tick-state.json (atomic; 10 read sites per tick).",
    {
      run_id: z.string().describe("Active run identifier"),
      patch: RunStatePatchSchema.describe("Fields to merge into run-state.json"),
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
    "Read tick history scores from run-state.json and detect plateau or consecutive regression. " +
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
    "Read and validate goal-contract.json from the run directory. " +
    "Returns the parsed GoalContract or {error:'...'} when missing or invalid. " +
    "The contract is validated against the GoalContractSchema (Zod).",
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
                : { error: result.error }
            ),
          },
        ],
      };
    }
  );
}
