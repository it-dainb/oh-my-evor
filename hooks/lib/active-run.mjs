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
import { dirname, join, resolve } from 'path';

/**
 * Walk up from `start` looking for a directory that contains `.evor/`.
 * @returns {string} the `.evor` path, or '' if none found before the filesystem root
 */
function findProjectEvor(start) {
  let dir = resolve(start);
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, '.evor');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

/**
 * Resolve the evor root the same way every hook does (plan item 1.3).
 *
 * FINDING Q-01, and it is the sharpest thing lane Q found. This was:
 *
 *     join(process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd(), '.evor')
 *
 * `CLAUDE_PLUGIN_ROOT` is set in every real session, so the `process.cwd()` arm
 * was dead code and the plugin's own `.evor/` always won. For 19 hours all 14
 * hooks read a leftover `.evor/` inside the plugin cache instead of the project
 * they were running in — and because that directory EXISTED and parsed, nothing
 * failed. The guards ran, found a stale run, and reported on it confidently.
 *
 * The plugin root is where the CODE lives. It is never where the mission lives,
 * and it is the one directory this function must never return, which is why the
 * check is explicit below rather than implied by the ordering.
 *
 * Resolution order:
 *   1. an explicit argument — a caller that already knows
 *   2. `EVOR_ROOT` — the override an orchestrator sets deliberately
 *   3. `CLAUDE_PROJECT_DIR/.evor` — the host's own name for the project
 *   4. the nearest `.evor/` walking up from cwd — how a human finds it
 *   5. `<cwd>/.evor`, which will not exist, so `resolveActiveRun` returns empty
 *      and every hook goes inert. Guessing a path that happens to exist is worse
 *      than resolving nothing: an inert hook is visibly doing nothing, while a
 *      confidently wrong one governs the wrong mission.
 *
 * @param {string} [evorRoot] explicit override
 */
export function resolveEvorRoot(evorRoot) {
  if (evorRoot) return evorRoot;
  if (process.env.EVOR_ROOT) return process.env.EVOR_ROOT;

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    const candidate = join(resolve(projectDir), '.evor');
    if (existsSync(candidate)) return candidate;
  }

  const found = findProjectEvor(process.cwd());
  if (found) {
    // Belt and braces: if cwd is itself inside the plugin install, the walk could
    // surface the plugin's own .evor. Refuse it explicitly rather than rely on
    // the ordering above staying correct as this function is edited.
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot || !resolve(found).startsWith(resolve(pluginRoot))) return found;
  }

  return join(process.cwd(), '.evor');
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
