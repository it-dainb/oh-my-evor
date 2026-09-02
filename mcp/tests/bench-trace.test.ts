/**
 * mcp/tests/bench-trace.test.ts — phase indexing, offline.
 *
 * The live half (session resume across turns) was verified by running it: two
 * turns, one session id, events tagged 0 and 1. What is tested here is the part
 * that can regress silently — that a call made in phase 0 is never reported as
 * phase 1, because that is the whole reason phase exists.
 *
 * A3's canonical field instance is `critic_approved: true` written at 00:21 by a
 * helper agent, eleven minutes before `evor-selector` — the only role carrying
 * that field's authority — was spawned. Right-shaped, and early. A flat trace
 * scores it correct.
 */
import { describe, it, expect } from "vitest";
import { phasedCalls } from "../../ci/bench-trace.mjs";

const ev = (phase: number, blocks: object[]) => ({ phase, message: { content: blocks } });
const use = (id: string, name: string, input: object = {}) => ({ type: "tool_use", id, name, input });
const res = (id: string, isError = false) => ({ type: "tool_result", tool_use_id: id, is_error: isError });

describe("phase indexing", () => {
  it("attributes each call to the turn that was active", () => {
    const calls = phasedCalls([
      ev(0, [use("a", "mcp__evor__evor_state_write", { patch: { critic_approved: true } })]),
      ev(0, [res("a")]),
      ev(1, [use("b", "mcp__evor__evor_select")]),
      ev(1, [res("b")]),
    ]);
    expect(calls.map((c) => [c.tool.replace(/^mcp__evor__/, ""), c.phase])).toEqual([
      ["evor_state_write", 0],
      ["evor_select", 1],
    ]);
  });

  it("separates a pre-authorisation write from a post-authorisation one", () => {
    // The same call, in the two phases. If these collapse to one bucket the
    // A2/A3 ordering angles cannot distinguish authorised from premature.
    const early = phasedCalls([ev(0, [use("x", "evor_state_write", { patch: { critic_approved: true } })])]);
    const late = phasedCalls([ev(1, [use("x", "evor_state_write", { patch: { critic_approved: true } })])]);
    expect(early[0].phase).toBe(0);
    expect(late[0].phase).toBe(1);
    expect(early[0].phase).not.toBe(late[0].phase);
  });

  it("records a tool error without calling it a denial", () => {
    // A failing tool is angle T3's subject. Conflating it with a permission
    // denial voided a run where the agent behaved correctly, because the
    // fixture's deliberately malformed tree.json made evor_tree_read fail.
    const calls = phasedCalls([ev(0, [use("e", "evor_tree_read")]), ev(0, [res("e", true)])]);
    expect(calls[0].errored).toBe(true);
    expect(calls[0]).not.toHaveProperty("denied");
  });

  it("defaults untagged events to phase 0 rather than dropping them", () => {
    const calls = phasedCalls([{ message: { content: [use("u", "evor_doctor")] } } as never]);
    expect(calls).toHaveLength(1);
    expect(calls[0].phase).toBe(0);
  });
});
