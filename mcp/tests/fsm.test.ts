/**
 * §3.1–3.5 — the lifecycle state machine.
 *
 * The table is `contracts/state-machines.json` and three languages read it.
 * That shape is the whole point: AF3 §4.3, following RC3, is that an FSM
 * implemented in one language is invisible to the others, and `stop.mjs` — the
 * component whose wrong predicate caused C-02 — is in a third. Implementing it
 * in TypeScript and letting Python and JS re-derive would be the `.tree.lock`
 * mistake verbatim.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import {
  assertReachable,
  assertTransition,
  IllegalTransition,
  initialState,
  isStale,
  isTerminal,
  legalEvents,
  loadTable,
  maxDwellSeconds,
  nextState,
  toMermaid,
} from "../src/fsm.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("§3.1 — the table is the authority", () => {
  it("ships as data, versioned", () => {
    const t = loadTable();
    expect(t.version).toBeGreaterThanOrEqual(1);
    expect(Object.keys(t.machines).sort()).toEqual(["mission", "run", "tick"]);
  });

  it("every edge points at a state that exists", () => {
    const t = loadTable();
    const dangling: string[] = [];
    for (const [name, m] of Object.entries(t.machines)) {
      for (const [state, def] of Object.entries(m.states)) {
        for (const [event, edge] of Object.entries(def.on)) {
          if (!m.states[edge.to]) dangling.push(`${name}: ${state} --${event}--> ${edge.to}`);
        }
      }
      if (!m.states[m.initial]) dangling.push(`${name}: initial '${m.initial}' does not exist`);
      for (const term of m.terminal) if (!m.states[term]) dangling.push(`${name}: terminal '${term}' does not exist`);
    }
    expect(dangling, "an edge to a non-existent state is a transition nothing can complete").toEqual([]);
  });

  it("every non-terminal state can be left, and every terminal state cannot", () => {
    const t = loadTable();
    for (const [name, m] of Object.entries(t.machines)) {
      for (const [state, def] of Object.entries(m.states)) {
        const isTerm = m.terminal.includes(state);
        const edges = Object.keys(def.on).length;
        if (isTerm) {
          expect(edges, `${name}.${state} is terminal but has outgoing edges`).toBe(0);
        } else {
          // F6 is the shipped demonstration of the alternative: one un-drawn
          // edge made every paused run unresumable AND silenced enforcement.
          expect(edges, `${name}.${state} is a dead end that is not marked terminal`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("every state is reachable from the initial state", () => {
    const t = loadTable();
    for (const [name, m] of Object.entries(t.machines)) {
      const seen = new Set([m.initial]);
      const queue = [m.initial];
      while (queue.length) {
        for (const edge of Object.values(m.states[queue.shift()!]?.on ?? {})) {
          if (!seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
        }
      }
      const orphans = Object.keys(m.states).filter((s) => !seen.has(s));
      expect(orphans, `${name}: unreachable states describe a lifecycle nothing can enter`).toEqual([]);
    }
  });

  it("assertTransition names what WAS legal", () => {
    expect(assertTransition("mission", "locked", "pause")).toBe("paused");
    try {
      assertTransition("mission", "completed", "pause");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalTransition);
      expect(String(e)).toMatch(/Legal from 'completed'/);
    }
  });
});

describe("§0.7 — the recovery edge survives Phase 3 rebuilding the machine", () => {
  // The plan requires this assertion by name: "Must contain 0.7's locked -> paused
  // recovery edge — assert it in a test, or the Phase 0 fix is silently dropped
  // when Phase 3 rebuilds the machine."
  it("locked -> paused exists", () => {
    expect(nextState("mission", "locked", "pause")).toBe("paused");
  });

  it("paused -> locked exists — the edge that was missing", () => {
    expect(
      nextState("mission", "paused", "resume_locked"),
      "`paused` had an edge in and no edge out, and stop.mjs exits 0 on it, so one " +
        "session ending disabled the drift guard for the mission's whole life",
    ).toBe("locked");
  });

  it("paused -> running exists too", () => {
    expect(nextState("mission", "paused", "resume_running")).toBe("running");
  });

  it("paused is not terminal", () => {
    expect(isTerminal("mission", "paused")).toBe(false);
  });
});

describe("§3.3 — states are timed", () => {
  it("the states that can hang carry a dwell limit", () => {
    // K-09: the final r3 tick sat at step 9 for hours and nothing could say so.
    expect(maxDwellSeconds("tick", "running")).toBeGreaterThan(0);
    expect(maxDwellSeconds("run", "running")).toBeGreaterThan(0);
    expect(maxDwellSeconds("mission", "running")).toBeGreaterThan(0);
  });

  it("terminal states have no limit — they are supposed to sit there", () => {
    expect(maxDwellSeconds("mission", "completed")).toBeNull();
    expect(maxDwellSeconds("run", "failed")).toBeNull();
  });

  it("staleness is arithmetic over two fields, no event required", () => {
    const limit = maxDwellSeconds("tick", "running")!;
    const now = Date.parse("2026-08-24T00:00:00Z");
    const old = new Date(now - (limit + 60) * 1000).toISOString();
    const fresh = new Date(now - 60 * 1000).toISOString();
    expect(isStale("tick", "running", old, now)).toBe(true);
    expect(isStale("tick", "running", fresh, now)).toBe(false);
  });

  it("an unknown age is not evidence of death", () => {
    // A6's mistake with the sign flipped: absence read as a verdict.
    expect(isStale("tick", "running", null)).toBe(false);
    expect(isStale("tick", "running", "not-a-date")).toBe(false);
  });
});

describe("§3.4 — supersession and terminality", () => {
  it("superseded is a legal mission state with an edge into it", () => {
    expect(nextState("mission", "running", "supersede")).toBe("superseded");
    expect(nextState("mission", "locked", "supersede")).toBe("superseded");
    expect(isTerminal("mission", "superseded")).toBe(true);
  });

  it("a mission can be ended from running — session end has somewhere to go", () => {
    expect(legalEvents("mission", "running")).toContain("fail");
    expect(legalEvents("mission", "running")).toContain("complete");
  });

  it("a terminal mission cannot be revived", () => {
    for (const term of ["completed", "failed", "superseded"]) {
      expect(() => assertReachable("mission", term, "running")).toThrow(IllegalTransition);
    }
  });
});

describe("§3.1 — enforcement refuses what the table does not contain", () => {
  it("rejects an unknown state outright", () => {
    expect(() => assertReachable("mission", "locked", "banana")).toThrow(/is not a state/);
  });

  it("rejects a legal-looking but unreachable edge", () => {
    expect(() => assertReachable("mission", "draft", "completed")).toThrow(IllegalTransition);
  });

  it("a no-op patch is not a transition", () => {
    expect(() => assertReachable("mission", "running", "running")).not.toThrow();
  });

  it("draft -> locked is allowed (and carries its guard)", () => {
    expect(() => assertReachable("mission", "draft", "locked")).not.toThrow();
    expect(loadTable().machines.mission.states.draft.on.lock.guard).toBe("contract_validated");
  });
});

describe("§3.5 — the diagram is generated FROM the table", () => {
  it("renders every edge, so it cannot disagree with enforcement", () => {
    const src = toMermaid("mission");
    expect(src.startsWith("stateDiagram-v2")).toBe(true);
    const m = loadTable().machines.mission;
    for (const [state, def] of Object.entries(m.states)) {
      for (const [event, edge] of Object.entries(def.on)) {
        expect(src, `${state} --${event}--> ${edge.to} missing from the diagram`).toContain(
          `${state} --> ${edge.to}: ${event}`,
        );
      }
    }
  });
});

describe("all three readers agree", () => {
  it("the JS hook reader returns the same answers as the TS one", async () => {
    const js: any = await import(join(REPO, "hooks", "lib", "fsm.mjs"));
    const cases: Array<[string, string, string]> = [
      ["mission", "locked", "pause"],
      ["mission", "paused", "resume_locked"],
      ["mission", "running", "supersede"],
      ["run", "initialized", "start"],
      ["tick", "running", "finish"],
      ["tick", "running", "block"],
    ];
    for (const [entity, state, event] of cases) {
      expect(js.nextState(entity, state, event), `${entity}.${state}.${event}`).toBe(
        nextState(entity, state, event),
      );
    }
    for (const t of ["completed", "failed", "superseded", "running", "paused"]) {
      expect(js.isTerminal("mission", t)).toBe(isTerminal("mission", t));
    }
    expect(js.maxDwellSeconds("tick", "running")).toBe(maxDwellSeconds("tick", "running"));
  });
});
