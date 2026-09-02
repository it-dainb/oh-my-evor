/**
 * Reader over `contracts/state-machines.json` — plan item 3.1, JavaScript half.
 *
 * This half is the reason the table is data rather than code. `stop.mjs` is the
 * component whose wrong predicate caused C-02, and it is in a third language: an
 * FSM implemented in Python or TypeScript would be invisible to it, which is the
 * `.tree.lock` mistake verbatim (RC3, AF3 §4.3).
 *
 * Hooks are READERS. They ask the table "is this terminal / stale?" instead of
 * hard-coding a list of state names. Enforcement is the MCP write path only —
 * `stop.mjs` has five deliberate fail-open catches, so a guard evaluated here is
 * a suggestion, and AF3 risk 2 is that pretending otherwise makes the two drift.
 *
 * Every failure is soft. These run on the user's stop path; a hook that throws
 * because a JSON file moved is worse than one that declines to answer.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const TABLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'state-machines.json');

let _table = null;
function table() {
  if (_table === null) {
    try {
      _table = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
    } catch {
      _table = { machines: {} };  // unreadable table — answer "don't know", never throw
    }
  }
  return _table;
}

function machine(entity) {
  return table().machines?.[entity] ?? null;
}

/** Is `state` terminal for `entity`? Unknown entity or state → false. */
export function isTerminal(entity, state) {
  return (machine(entity)?.terminal ?? []).includes(String(state));
}

/** The state `event` leads to, or undefined when the edge is not in the table. */
export function nextState(entity, state, event) {
  return machine(entity)?.states?.[state]?.on?.[event]?.to;
}

/** Is the edge in the table at all? */
export function isLegalTransition(entity, state, event) {
  return nextState(entity, state, event) !== undefined;
}

/** Seconds this entity may sit in `state`, or null for "indefinitely". */
export function maxDwellSeconds(entity, state) {
  const v = machine(entity)?.states?.[state]?.max_dwell_s;
  return v === undefined ? null : v;
}

/**
 * Has this entity sat in `state` past its `max_dwell_s`? (Item 3.3.)
 *
 * The predicate the system never had. C-01, K-09 and C-03 were unobservable
 * because "is this still alive?" needed an event nobody emitted; here it is
 * arithmetic over two fields that any reader in any language can do from the
 * file alone.
 *
 * A missing `entered_at` is NOT stale. An unknown age is not evidence of death,
 * and reading it as one is A6's mistake with the sign flipped.
 */
export function isStale(entity, state, enteredAt, now = Date.now()) {
  const limit = maxDwellSeconds(entity, state);
  if (limit === null || limit === undefined || !enteredAt) return false;
  const started = Date.parse(String(enteredAt));
  if (Number.isNaN(started)) return false;
  return (now - started) / 1000 > limit;
}
