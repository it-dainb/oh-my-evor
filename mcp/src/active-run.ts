/**
 * mcp/src/active-run.ts — resolve the active run id when a caller omits it.
 *
 * `run_id` was a bare required `z.string()` on most tools, with no default and no
 * format hint. A model that got it wrong once had no signal telling it what was
 * wrong, so it repeated the same bad call — `evor_cite` failed three times
 * identically in run 29d17abc, with no adaptation between attempts.
 *
 * A PreToolUse hook was later bolted on to patch `tool_input.run_id` before the
 * schema saw it (`hooks/pre-tool-use.mjs`). That works, but it lives outside the
 * interface, and it only fires when the value is MISSING — a hallucinated run id
 * passes straight through. Rubric rule 1 says the constraint belongs in the tool
 * interface itself.
 *
 * The pattern already exists in this codebase: `evor_run_status` resolves
 * `job_id` from active-run.json, and `evor_signal_emit` gives `mission_id` the
 * optional-with-env-fallback treatment while `run_id` sits beside it without one.
 * This module makes that treatment uniform rather than per-tool folklore.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getEvorRoot } from "./run-store.js";

/**
 * The caller's run id, or the active run when omitted.
 *
 * @param provided the caller-supplied `run_id`, if any
 * @returns the resolved run id, or "" when there is no active run — callers
 *          surface that as a normal `ok:false`, never a schema rejection.
 */
export function resolveRunId(provided?: string): string {
  const given = (provided ?? "").trim();
  if (given) return given;

  if (process.env.EVOR_ACTIVE_RUN_ID) return process.env.EVOR_ACTIVE_RUN_ID;

  try {
    const file = join(getEvorRoot(), "active-run.json");
    if (!existsSync(file)) return "";
    const record = JSON.parse(readFileSync(file, "utf8"));
    return String(record?.run_id ?? "");
  } catch {
    // Missing, unreadable, or corrupt — the caller reports "no active run"
    // rather than the schema rejecting a field the caller could not have known.
    return "";
  }
}
