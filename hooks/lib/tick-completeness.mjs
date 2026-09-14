/**
 * What a tick still owes, derived from disk.
 *
 * A tick owes a trained AND evaluated node for EVERY proposal the selector
 * selected — not just the winner. In the field the selector approved h001 and
 * h003, only h001 was forged, and h003 was parked in a `carry_forward` key that
 * is defined in no skill, no agent file and no contract. Nothing read it. The
 * hypothesis was silently dropped and the tick reported step 9 done.
 *
 * ONE owner, imported by both callers — `hooks/subagent-stop.mjs` and the
 * `evor_tick_completeness` MCP tool. Both are JS, so this needs no mirror and no
 * parity test; a second implementation is how `eval_contract`'s four
 * disagreeing beliefs happened.
 *
 * WHERE THIS MAY BE ASKED. At tick END only. Mid-tick the answer is
 * legitimately "everything", and blocking on it would forbid the only mechanism
 * a tick has for waiting across a multi-hour training — the same shape as the
 * drift guard demanding Mutagen's artifact 16 seconds into tick 1. Guards are
 * for debt the agent can discharge now.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Read a JSON file, or null. */
function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
}

/** Proposal ids the selector selected for this tick. [] when there is no verdict. */
export function selectedProposals(runDir, tick) {
  const verdict = readJson(join(runDir, 'ticks', String(tick), 'selector', 'verdict.json'));
  const reviews = Array.isArray(verdict?.reviews) ? verdict.reviews : [];
  return reviews.filter(r => r?.selected).map(r => String(r?.proposal_id ?? '')).filter(Boolean);
}

/** Every node in the tree, as an array. */
function treeNodes(runDir) {
  const tree = readJson(join(runDir, 'tree.json'));
  const raw = tree?.nodes ?? {};
  return Array.isArray(raw) ? raw : Object.values(raw);
}

/**
 * What each selected proposal is missing.
 *
 * A proposal is DISCHARGED when a node carries its `hypothesis_id` and that node
 * has both an integrity verdict on disk and a numeric fitness. "A node exists"
 * is not enough: forge records the node before training finishes, so a node
 * without a fitness is a candidate in flight, not a result.
 */
export function owed(runDir, tick) {
  const selected = selectedProposals(runDir, tick);
  if (selected.length === 0) return [];
  const nodes = treeNodes(runDir);
  const out = [];
  for (const proposalId of selected) {
    const node = nodes.find(n => n && String(n.hypothesis_id ?? '') === proposalId);
    if (!node) {
      out.push({ proposal_id: proposalId, missing: ['node'] });
      continue;
    }
    const missing = [];
    if (!existsSync(join(runDir, 'evaluations', `${node.id}.json`))) missing.push('integrity_verdict');
    if (typeof node.fitness_value !== 'number') missing.push('fitness');
    // Telemetry is looked up under the id AND the name, because both occur on
    // disk. `evaluator.py:184` declares `nodes/<node.id>/telemetry.jsonl`, and
    // in the field the run held BOTH `nodes/cf9f0020-…/results.json` and
    // `nodes/n001-depthwise-unet/telemetry.jsonl` — the node's own telemetry
    // filed under its name while everything else used its uuid.
    //
    // That split is a real defect and it is not this module's to fix. What
    // matters here is not repeating it: checking only the declared path reports
    // a trained node as owing telemetry, and a completeness gate that fires on
    // a finished candidate is worse than no gate, because the only way past it
    // is to stop believing it.
    const telCandidates = [node.id, node.name]
      .filter(Boolean)
      .map(key => join(runDir, 'nodes', String(key), 'telemetry.jsonl'));
    if (!telCandidates.some(existsSync)) missing.push('telemetry');
    if (missing.length) out.push({ proposal_id: proposalId, node_id: node.id, node_name: node.name, missing });
  }
  return out;
}

/** True when every selected proposal has a trained, evaluated, integrity-checked node. */
export function isTickComplete(runDir, tick) {
  return owed(runDir, tick).length === 0;
}

/** A one-line summary for a hook message or a tool result. */
export function describeOwed(list) {
  return list
    .map(o => `${o.proposal_id}${o.node_name ? ` (${o.node_name})` : ''}: missing ${o.missing.join(', ')}`)
    .join('; ');
}
