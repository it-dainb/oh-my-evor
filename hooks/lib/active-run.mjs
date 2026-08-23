/**
 * hooks/lib/active-run.mjs — shared active-run resolution for evor hooks.
 *
 * Why this exists: `hooks/session-start.mjs` assigns EVOR_ACTIVE_RUN_ID to its
 * OWN `process.env`. Each Claude Code hook runs in a separate subprocess, so that
 * assignment reaches nobody — every hook gating on the env var alone is inert for
 * the entire session. In run 29d17abc that silenced the whole enforcement layer
 * (SubagentStop 0/10 fires, PreToolUse 0 denials).
 *
 * `<EVOR_ROOT>/active-run.json` is the durable record session-start writes, so it
 * is the authority a sibling subprocess can actually read. The env var is kept as
 * the fast path and as the override an orchestrator can set explicitly.
 *
 * Every resolution failure is silent and empty. A hook that cannot identify the
 * run must go inert, never crash: these run on every tool call in the user's
 * session, including sessions that have nothing to do with evor.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Resolve the evor root the same way every hook does.
 * @param {string} [evorRoot] explicit override, else EVOR_ROOT, else <plugin>/.evor
 */
export function resolveEvorRoot(evorRoot) {
  if (evorRoot) return evorRoot;
  if (process.env.EVOR_ROOT) return process.env.EVOR_ROOT;
  return join(process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd(), '.evor');
}

/**
 * Resolve the active run id and mission id.
 *
 * Precedence is per-field, not all-or-nothing: an orchestrator may export the run
 * id without the mission id, and the file still supplies the missing half.
 *
 * @param {string} [evorRoot]
 * @returns {{ runId: string, missionId: string }} empty strings when unresolvable
 */
export function resolveActiveRun(evorRoot) {
  let runId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
  let missionId = process.env.EVOR_MISSION_ID ?? '';

  if (runId && missionId) return { runId, missionId };

  try {
    const file = join(resolveEvorRoot(evorRoot), 'active-run.json');
    if (existsSync(file)) {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (!runId) runId = String(record?.run_id ?? '');
      if (!missionId) missionId = String(record?.mission_id ?? '');
    }
  } catch {
    // Missing, unreadable, or corrupt — fall through with whatever the env gave us.
  }

  return { runId, missionId };
}

/**
 * Directory holding a run's state files. Runs nest under the mission when one is
 * known and sit flat under `runs/` when it is not.
 *
 * @returns {string} '' when there is no active run
 */
export function resolveRunDir(evorRoot) {
  const root = resolveEvorRoot(evorRoot);
  const { runId, missionId } = resolveActiveRun(root);
  if (!runId) return '';
  return missionId ? join(root, 'runs', missionId, runId) : join(root, 'runs', runId);
}
