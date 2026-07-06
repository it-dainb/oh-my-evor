/**
 * tools/init.ts
 * evor_init_run — construct, validate, and atomically write all run artifacts.
 *
 * Delegates to `python -m evor init-run --answers <tmp.json>` which validates
 * the GoalContract via Pydantic, then writes:
 *   goal-contract.json, run-state.json, strategy.json, tree.json,
 *   mission-state.json, decision-log.md  (into run_dir)
 *   active-run.json                       (into evor_root)
 * …atomically (temp + os.replace) and prints a JSON summary to stdout.
 *
 * On validation failure the harness prints {"error":"..."} on stdout and
 * exits 1. _parseSpawnResult surfaces that reason here — it is never swallowed.
 */

import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callPythonModule } from "../subprocess-bridge.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface InitRunSummary {
  ok: true;
  mission_id: string;
  run_id: string;
  run_dir: string;
  goal_contract_path: string;
}

export interface InitRunFailure {
  ok: false;
  error: string;
}

export type InitRunOutcome = InitRunSummary | InitRunFailure;

// ── Core logic (exported for tests) ────────────────────────────────────────

/**
 * Write answers to a temp JSON file, invoke `python -m evor init-run`, clean
 * up the temp file (always, in finally), and return the parsed summary.
 *
 * Errors from the harness (GoalContract validation failures, missing fields,
 * bad literals) arrive as PyResult.error — already extracted from the JSON
 * {"error":"..."} on stdout by _parseSpawnResult — and are returned as
 * InitRunFailure. They are never swallowed.
 */
export function initRun(
  answers: Record<string, unknown>,
  opts?: { runId?: string; missionId?: string; runDir?: string }
): InitRunOutcome {
  const tmpFile = join(tmpdir(), `evor-init-answers-${randomUUID()}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(answers), "utf8");

    const args = ["init-run", "--answers", tmpFile];
    if (opts?.runId) args.push("--run-id", opts.runId);
    if (opts?.missionId) args.push("--mission-id", opts.missionId);
    if (opts?.runDir) args.push("--run-dir", opts.runDir);

    const result = callPythonModule("evor", args);

    if (!result.ok) {
      // error is already extracted from stdout {"error":"..."} by _parseSpawnResult;
      // fall back to a non-empty sentinel so the caller never sees null.
      return { ok: false, error: result.error ?? "evor init-run failed" };
    }
    if (result.data == null) {
      return { ok: false, error: "evor init-run produced no JSON output" };
    }
    return result.data as InitRunSummary;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* already gone or never written */ }
  }
}

// ── Tool registration ───────────────────────────────────────────────────────

export function registerInitTools(server: McpServer): void {
  server.tool(
    "evor_init_run",
    [
      "Construct, validate, and atomically write all run artifacts for a new mission run:",
      "goal-contract.json, run-state.json, strategy.json, tree.json, mission-state.json,",
      "decision-log.md (into run_dir) and active-run.json (into evor_root).",
      "Returns {ok:true, mission_id, run_id, run_dir, goal_contract_path} on success,",
      "or {ok:false, error:<validation message>} on GoalContract validation failure.",
      "Replaces the hand-authored python <<'PY' GoalContract heredoc in evor-setup.",
    ].join(" "),
    {
      answers: z
        .record(z.string(), z.unknown())
        .describe(
          "GoalContract fields as a plain JSON object (nested models as plain dicts). " +
          "See contracts.ts GoalContractSchema for required fields. " +
          "created_at is auto-set (UTC ISO) if absent; autonomy_charter defaults to aggressive-never-halt."
        ),
      run_id: z
        .string()
        .optional()
        .describe("Override the auto-generated run ID (default: <mission_id>-<UTC compact timestamp>)"),
      mission_id: z
        .string()
        .optional()
        .describe("Override the mission_id from answers (takes precedence over answers.mission_id)"),
      run_dir: z
        .string()
        .optional()
        .describe("Override the run directory path (default: <evor_root>/runs/<mission_id>/<run_id>)"),
    },
    async ({ answers, run_id, mission_id, run_dir }) => {
      const outcome = initRun(answers, {
        runId: run_id,
        missionId: mission_id,
        runDir: run_dir,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
      };
    }
  );
}
