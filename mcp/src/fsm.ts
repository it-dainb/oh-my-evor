/**
 * Reader over `contracts/state-machines.json` — plan item 3.1, TypeScript half,
 * and the ONLY half that refuses anything.
 *
 * AF3 §4.3's layering, made concrete:
 *
 *   Definition      contracts/state-machines.json — versioned, diffable, shipped
 *   Enforcement     here, on the MCP write path — the single writer
 *   Interpretation  a small reader in each of Python / TS / JS, one table
 *   Audit           append-only transitions.jsonl, written by the write path
 *
 * Guards are enforced at the WRITER and advisory at the readers. `stop.mjs` has
 * five deliberate fail-open catches, so a guard evaluated in a hook is a
 * suggestion — AF3 risk 2 is that not saying so lets the two drift, exactly as
 * `stop.mjs:249` and `evor-run/SKILL.md` already had.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export type Edge = { to: string; guard?: string };
export type StateDef = { max_dwell_s: number | null; on: Record<string, Edge> };
export type Machine = { initial: string; terminal: string[]; states: Record<string, StateDef> };

const TABLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "state-machines.json");

let cached: { version: number; machines: Record<string, Machine> } | null = null;

export function loadTable(): { version: number; machines: Record<string, Machine> } {
  if (!cached) cached = JSON.parse(readFileSync(TABLE_PATH, "utf8"));
  return cached!;
}

function machine(entity: string): Machine {
  const m = loadTable().machines[entity];
  if (!m) throw new Error(`no state machine for '${entity}'; known: ${Object.keys(loadTable().machines).join(", ")}`);
  return m;
}

export function initialState(entity: string): string {
  return machine(entity).initial;
}

export function isTerminal(entity: string, state: string): boolean {
  return machine(entity).terminal.includes(state);
}

export function legalEvents(entity: string, state: string): string[] {
  return Object.keys(machine(entity).states[state]?.on ?? {}).sort();
}

export function nextState(entity: string, state: string, event: string): string | undefined {
  return machine(entity).states[state]?.on?.[event]?.to;
}

export function guardFor(entity: string, state: string, event: string): string | undefined {
  return machine(entity).states[state]?.on?.[event]?.guard;
}

/** All states reachable from `state` in one step, whatever the event. */
export function reachableFrom(entity: string, state: string): string[] {
  return [...new Set(Object.values(machine(entity).states[state]?.on ?? {}).map((e) => e.to))].sort();
}

export class IllegalTransition extends Error {}

/**
 * Return the destination state, or throw.
 *
 * The error names what WAS legal, because the failure this replaces was silent:
 * a writer set the field to whatever it liked and no reader could tell whether
 * the value was even reachable. Three status fields disagreed in the field
 * simultaneously and nothing reported it.
 */
export function assertTransition(entity: string, state: string, event: string): string {
  const to = nextState(entity, state, event);
  if (to === undefined) {
    throw new IllegalTransition(
      `${entity}: '${state}' --${event}--> is not a legal transition. ` +
        `Legal from '${state}': ${legalEvents(entity, state).join(", ") || "(terminal)"}`,
    );
  }
  return to;
}

/**
 * Is this a legal DESTINATION for `from`, whatever event gets there?
 *
 * `evor_state_write` patches a status directly rather than naming an event, so
 * this is the check the write path can actually apply today. Event-level
 * transitions arrive with `evor_transition`; until then this still refuses every
 * edge the table does not contain, which is the property that matters.
 */
export function assertReachable(entity: string, from: string, to: string): void {
  if (from === to) return;
  if (!machine(entity).states[to]) {
    throw new IllegalTransition(
      `${entity}: '${to}' is not a state. Known: ${Object.keys(machine(entity).states).join(", ")}`,
    );
  }
  const allowed = reachableFrom(entity, from);
  if (!allowed.includes(to)) {
    throw new IllegalTransition(
      `${entity}: '${from}' -> '${to}' is not a legal transition. ` +
        `From '${from}' you may reach: ${allowed.join(", ") || "(terminal — nothing)"}`,
    );
  }
}

export function maxDwellSeconds(entity: string, state: string): number | null {
  const v = machine(entity).states[state]?.max_dwell_s;
  return v === undefined ? null : v;
}

/**
 * Has this entity sat in `state` past its `max_dwell_s`? (Item 3.3.)
 *
 * A missing `entered_at` is NOT stale — an unknown age is not evidence of death,
 * which is A6's mistake with the sign flipped.
 */
export function isStale(entity: string, state: string, enteredAt: string | null | undefined, now = Date.now()): boolean {
  const limit = maxDwellSeconds(entity, state);
  if (limit === null || !enteredAt) return false;
  const started = Date.parse(enteredAt);
  if (Number.isNaN(started)) return false;
  return (now - started) / 1000 > limit;
}

/** Mermaid source generated FROM the table (item 3.5), so it cannot disagree with it. */
export function toMermaid(entity: string): string {
  const m = machine(entity);
  const lines = ["stateDiagram-v2", `  [*] --> ${m.initial}`];
  for (const [state, def] of Object.entries(m.states)) {
    for (const [event, edge] of Object.entries(def.on)) {
      lines.push(`  ${state} --> ${edge.to}: ${event}${edge.guard ? ` [${edge.guard}]` : ""}`);
    }
  }
  for (const t of m.terminal) lines.push(`  ${t} --> [*]`);
  return lines.join("\n");
}
