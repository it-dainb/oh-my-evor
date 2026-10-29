/**
 * A node's identities, for JS readers — the counterpart of
 * `harness/evor/node_identity.py`, which holds the same rule for Python.
 *
 * FINDING O-01. A node has two identities: a uuid (`node.id`) and a readable
 * slug (`node.name`). The agent surface is name-keyed on purpose —
 * `evor_record_node` "Returns {ok, name} … you never handle an internal id" —
 * while the server surface is uuid-keyed. Both wrote `nodes/<identity>/`, so one
 * node got two directories in the same run, and integrity check 5 once failed a
 * candidate holding 12,000 well-formed telemetry records because it looked under
 * the other one. Nothing was wrong with either writer; the defect was that no
 * component owned the mapping, so every reader guessed — and a guess that
 * resolves to a missing path fails silently toward "the candidate is bad".
 *
 * v1.2.8 closes it at the write side: `telemetryIngest` canonicalizes a name to
 * the uuid, and `evor_record_node` grants the canonical `telemetry_path` so Forge
 * no longer constructs one. This module is for the runs already on disk, and for
 * readers that hold only a string.
 *
 * Like the Python owner, it NEVER invents a path: it returns only paths that
 * exist, so resolution can rescue a misfiled artifact and can never manufacture
 * one. `mcp/tests/node-identity-parity.test.ts` pins the two implementations
 * together over one fixture, because a mirror without that test is just a second
 * opinion about the same fact.
 */

import { existsSync, readFileSync } from 'fs';
import { join, basename, dirname } from 'path';

/** Every directory name a writer may legitimately have used, uuid first. */
export function nodeAliases(node) {
  const out = [];
  for (const candidate of [node?.id, node?.name]) {
    if (candidate && !out.includes(String(candidate))) out.push(String(candidate));
  }
  return out;
}

/** Every identity of the node `ref` names, given a parsed tree. `[ref]` if unknown. */
export function aliasesFromTree(tree, ref) {
  const raw = tree?.nodes ?? {};
  const entries = Array.isArray(raw) ? raw : Object.values(raw);
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (ref === e.id || ref === e.name) {
      return [e.id, e.name].filter(Boolean).map(String);
    }
  }
  return [ref];
}

/**
 * Resolve `<...>/nodes/<identity>/<artifact>` written under either identity.
 * Returns null when it exists under none — that absence is the safety property.
 */
export function resolveNodeArtifact(path, node, extraAliases = []) {
  if (existsSync(path)) return path;
  const artifact = basename(path);
  const parent = dirname(path);
  const container = dirname(parent);
  const seen = new Set([basename(parent)]);
  for (const alias of [...nodeAliases(node), ...extraAliases]) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    const candidate = join(container, alias, artifact);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** As above, from a run dir and a bare ref. Reads tree.json for the aliases. */
export function resolveNodeArtifactByRef(runDir, ref, artifact, tree = null) {
  const direct = join(runDir, 'nodes', ref, artifact);
  if (existsSync(direct)) return direct;
  let parsed = tree;
  if (!parsed) {
    try {
      parsed = JSON.parse(readFileSync(join(runDir, 'tree.json'), 'utf8'));
    } catch {
      return null;
    }
  }
  for (const alias of aliasesFromTree(parsed, ref)) {
    const candidate = join(runDir, 'nodes', alias, artifact);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
