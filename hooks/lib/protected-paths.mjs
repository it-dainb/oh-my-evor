/**
 * hooks/lib/protected-paths.mjs — which absolute paths are not a work surface.
 *
 * Plan items 0.2 and 0.3. The companion to `write-targets.mjs`: that module says
 * WHAT a call writes, this one says whether writing there is allowed. The split
 * matters because it is what lets the decision be made on a resolved path and be
 * identical for every caller — H-01 measured the alternative, where a rule keyed
 * on agent type was nullified 51 seconds later by re-issuing the identical edit
 * as `subagent_type: "claude"`, and that became the standing pattern.
 *
 * Three zones, each for a different reason:
 *
 *   plugin       The installed plugin is the code that governs the run. An agent
 *                that can edit its own governor has no governor. 17 files and
 *                ~1500 net added lines went into it during the measured run,
 *                including a rewrite of `hooks/stop.mjs` and an in-place rebuild
 *                of the shipped bundle — all allowed, none recorded.
 *   enforcement  The same argument applied to the project checkout, so the grant
 *                that lets forge-junior author candidate code does not extend to
 *                the interpreter of its own gates.
 *   run-state    Run artifacts have owning tools (`evor_state_write`,
 *                `evor_record_node`, …). A direct write bypasses their invariants.
 *                `worktrees/**` is excluded: that IS the candidate work surface.
 */

import { homedir } from 'os';
import { join, resolve, sep } from 'path';
import { resolveEvorRoot } from './active-run.mjs';

const norm = (p) => resolve(String(p ?? ''));
const within = (child, parent) => {
  if (!parent) return false;
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/** Roots of the plugin install, from every signal that can name one. */
function pluginRoots() {
  const roots = [
    join(homedir(), '.claude', 'plugins', 'cache'),
    join(homedir(), '.claude', 'plugins', 'marketplaces'),
    process.env.CLAUDE_PLUGIN_ROOT,
    process.env.EVOR_PLUGIN_ROOT,
  ];
  return roots.filter(Boolean).map(norm);
}

/** Markers and caches that legitimately live beside run state. */
const ALLOW_MARKER =
  /[/\\]\.evor[/\\]\.[^/\\]+$|[/\\]\.evor[/\\][^/\\]+-throttle\.json$/;

/**
 * @param {string} absPath an already-resolved absolute path
 * @returns {{zone: string, reason: string} | null} null when writing is allowed
 */
export function classifyWriteTarget(absPath) {
  const p = norm(absPath);

  for (const root of pluginRoots()) {
    if (within(p, root)) {
      return {
        zone: 'plugin',
        reason:
          `the plugin's own installation directory is not a work surface (${root}). ` +
          `Mission work never writes there — an agent that can edit the code that governs ` +
          `it is not governed. If this is a deliberate release action, the human running ` +
          `the release sets EVOR_ALLOW_SELF_PATCH=1; an agent must not set it for itself.`,
      };
    }
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir && within(p, join(norm(projectDir), 'hooks'))) {
    return {
      zone: 'enforcement',
      reason:
        `this is the enforcement layer itself (${join(norm(projectDir), 'hooks')}). The grant ` +
        `that lets candidate code be authored in the project tree does not extend to the ` +
        `interpreter of its own gates.`,
    };
  }

  const evorRoot = norm(resolveEvorRoot());
  if (within(p, join(evorRoot, 'worktrees'))) return null;
  if (ALLOW_MARKER.test(p)) return null;
  if (within(p, join(evorRoot, 'runs')) || (within(p, evorRoot) && /[/\\][^/\\]+\.json$/.test(p))) {
    return {
      zone: 'run-state',
      reason:
        `run artifacts are written through their owning tool, not by hand — a direct write ` +
        `bypasses the invariants that tool enforces. Use evor_state_write / evor_record_node / ` +
        `evor_record_eval / evor_write_artifact / evor_store_patch as appropriate.`,
    };
  }

  return null;
}

/** The self-patch escape. Set by a human running a release, never by an agent. */
export function selfPatchAllowed() {
  return process.env.EVOR_ALLOW_SELF_PATCH === '1';
}
