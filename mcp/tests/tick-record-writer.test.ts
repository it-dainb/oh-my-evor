/**
 * mcp/tests/tick-record-writer.test.ts
 *
 * `evor_state_write({tick_record})` is the only writer of `tick_records` and of
 * the derived `tick_history_scores`.
 *
 * Before it existed, `tick_history_scores` was READ by every history-based stop
 * check — plateau, regression, worst-angle-plateau — and written by nothing. The
 * patch schema is `.strict()` and did not accept the key, so an agent told to
 * maintain it could not have. Every one of those stops was unreachable, and the
 * circuit breaker had nothing to count: it was implemented as a tick cap instead.
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { stateRead, stateWrite, RunStatePatchSchema } from "../src/tools/state.js";

let tmpRoot: string;
let saved: string | undefined;
const RUN = "run-tickrec";
const MISSION = "m-tickrec";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "evor-tickrec-"));
  saved = process.env.EVOR_ROOT;
  process.env.EVOR_ROOT = tmpRoot;
});
afterEach(() => {
  if (saved === undefined) delete process.env.EVOR_ROOT;
  else process.env.EVOR_ROOT = saved;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const rec = (tick: number, outcome: "scored" | "rejected" | "skipped" | "failed", score?: number) =>
  stateWrite(RUN, { tick_record: { tick, outcome, ...(score !== undefined ? { score } : {}) } }, MISSION);

describe("tick_record", () => {
  it("appends one record per tick, in tick order", () => {
    rec(1, "scored", 0.4);
    rec(2, "failed");
    rec(3, "scored", 0.6);
    const state = stateRead(RUN, MISSION) as Record<string, unknown>;
    // A failed record also carries the server-stamped plugin_version when the
    // plugin root is resolvable; the order and the rest are what is asserted.
    const recs = (state.tick_records as Array<Record<string, unknown>>).map(({ plugin_version: _v, ...r }) => r);
    expect(recs).toEqual([
      // Each record carries the eval version it was scored under (the version in force).
      { tick: 1, outcome: "scored", score: 0.4, eval_version: "v1" },
      { tick: 2, outcome: "failed", eval_version: "v1" },
      { tick: 3, outcome: "scored", score: 0.6, eval_version: "v1" },
    ]);
  });

  it("upserts by tick, so recording a tick twice corrects it rather than duplicating it", () => {
    rec(1, "failed");
    rec(1, "scored", 0.5);
    const state = stateRead(RUN, MISSION) as Record<string, unknown>;
    expect(state.tick_records).toEqual([{ tick: 1, outcome: "scored", score: 0.5, eval_version: "v1" }]);
  });

  it("derives tick_history_scores from the records — the key the plateau checks read", () => {
    rec(1, "scored", 0.4);
    rec(2, "rejected");
    rec(3, "scored", 0.6);
    const state = stateRead(RUN, MISSION) as Record<string, unknown>;
    expect(state.tick_history_scores).toEqual([0.4, 0.6]);
  });

  it("reads a null optional field as absent", () => {
    const r = RunStatePatchSchema.safeParse({ tick_record: { tick: 3, outcome: "scored", score: 0.01, failure_kind: null, error: null } });
    expect(r.success).toBe(true);
    expect((r as { data: { tick_record: Record<string, unknown> } }).data.tick_record.failure_kind).toBeUndefined();
  });

  it("rejects `yielding` — a tick that has not finished has nothing to record", () => {
    expect(() =>
      RunStatePatchSchema.parse({ tick_record: { tick: 1, outcome: "yielding" } }),
    ).toThrow();
  });

  it("does not let tick_history_scores be written directly", () => {
    // Strict schema: the derived key has one writer, and it is not the caller.
    expect(() => RunStatePatchSchema.parse({ tick_history_scores: [0.9, 0.9, 0.9] })).toThrow();
    expect(() => RunStatePatchSchema.parse({ tick_records: [] })).toThrow();
  });
});

describe("resource_plan", () => {
  it("is accepted and read back — the value setup used to compute and discard", () => {
    stateWrite(RUN, { resource_plan: { concurrency: 2, reason: "27 GB free, ~10 GB per job" } }, MISSION);
    const state = stateRead(RUN, MISSION) as Record<string, unknown>;
    expect((state.resource_plan as Record<string, unknown>).concurrency).toBe(2);
  });

  it("rejects a concurrency below 1", () => {
    expect(() => RunStatePatchSchema.parse({ resource_plan: { concurrency: 0 } })).toThrow();
  });

  it("keeps failure_kind and error, which evor_check_stop reads to block a contract failure", () => {
    stateWrite(RUN, { tick_record: { tick: 1, outcome: "failed", failure_kind: "contract", error: "ids disagree" } }, MISSION);
    const state = stateRead(RUN, MISSION) as Record<string, unknown>;
    const recs = state.tick_records as Array<Record<string, unknown>>;
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ tick: 1, outcome: "failed", failure_kind: "contract", error: "ids disagree" });
  });

  it("refuses a failure_kind outside the three", () => {
    expect(RunStatePatchSchema.safeParse({ tick_record: { tick: 1, outcome: "failed", failure_kind: "bad-luck" } }).success).toBe(false);
  });
});
