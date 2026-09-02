/**
 * §1.7 — a failure may not be laundered into a success by its wrapper.
 *
 * `err()` returned a SUCCESSFUL tool call whose body happened to say
 * `ok: false`. `isError` — the MCP protocol's own failure signal, and the only
 * one a host reads without parsing our text — was never set. So at the protocol
 * layer a failure and a success were indistinguishable, and only a caller that
 * parsed and inspected our JSON could tell them apart.
 *
 * The sharper case is the embedded one. 54 internal helpers return
 * `{ ok: false, error }` as a plain object and the calling tool wraps it with
 * `ok()`. The spread put `ok: true` first and the payload's `ok: false` second,
 * so the body came out right BY ACCIDENT — correct because of the order of two
 * keys in a spread — while `isError` stayed unset.
 */
import { describe, it, expect } from "vitest";
import { ok, err } from "../src/tool-result.js";

const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("§1.7 — the result envelope", () => {
  it("err() marks the envelope, not just the body", () => {
    const r = err("boom");
    expect(body(r)).toEqual({ ok: false, error: "boom" });
    expect(
      r.isError,
      "the body is for callers that parse it; `isError` is for the host and for " +
        "every caller that does not. Reporting only the body means a failed tool " +
        "call is a successful tool call as far as the protocol is concerned.",
    ).toBe(true);
  });

  it("ok() wrapping a helper's failure reports a failure", () => {
    // Exactly the shape the 54 helpers return.
    const r = ok({ ok: false, error: "handoff_bridge failed" });
    expect(body(r).ok).toBe(false);
    expect(
      r.isError,
      "this is the case that made correctness depend on spread order. The wrapper " +
        "must not be able to turn its payload's verdict into the opposite one.",
    ).toBe(true);
  });

  it("the error message survives the wrapper", () => {
    expect(body(ok({ ok: false, error: "handoff_bridge failed" })).error).toBe("handoff_bridge failed");
  });

  it("a genuine success is not marked", () => {
    const r = ok({ run_id: "r1", tick: 3 });
    expect(body(r)).toEqual({ ok: true, run_id: "r1", tick: 3 });
    expect(r.isError, "the fix must not mark every result an error").toBeUndefined();
  });

  it("empty and non-object payloads still succeed", () => {
    expect(body(ok())).toEqual({ ok: true });
    expect(body(ok([1, 2]))).toEqual({ ok: true, data: [1, 2] });
    expect(ok(undefined).isError).toBeUndefined();
    expect(ok([1, 2]).isError).toBeUndefined();
  });

  it("an explicit ok:true payload is untouched", () => {
    const r = ok({ ok: true, n: 1 });
    expect(body(r)).toEqual({ ok: true, n: 1 });
    expect(r.isError).toBeUndefined();
  });
});
