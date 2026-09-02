/**
 * mcp/src/tool-result.ts — the single result envelope for every evor_* tool.
 *
 * Every tool answers in exactly one shape:
 *   success -> { ok: true,  ...payload }
 *   failure -> { ok: false, error: string }
 *
 * WHY THIS EXISTS. `ok()`/`err()` previously lived un-exported inside
 * `tools/compute.ts`, so the other 16 tool files each invented their own shape.
 * Three incompatible envelopes resulted, and two of them are silently wrong for
 * any caller doing a boolean check:
 *
 *   - `{ error: msg }` with no `ok` field — a caller testing `ok === false`
 *     reads a FAILURE as success. This is what let a failed
 *     `evor_seal_eval_script` report a tick in `scripts/bench-seed-mission.mjs`.
 *   - raw unwrapped data on success (`evor_read_result`) — a caller testing
 *     `ok === true` reads a SUCCESS as failure. Neither check worked.
 *
 * Callers cannot defend against this: there was no shape to check against. The
 * envelope is a contract, and a contract has to live in one place.
 *
 * Note the deliberate asymmetry with the old helper: `ok()` now injects
 * `ok: true` itself rather than trusting each call site to remember it. Trusting
 * call sites is precisely how the drift happened.
 */

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function wrap(payload: unknown, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
  // `isError` is the MCP protocol's own failure signal, and it is the only one a
  // host reads without parsing our text. Until this, `err()` returned a
  // SUCCESSFUL tool call whose body happened to say `ok: false` — so a failure
  // and a success were indistinguishable at the protocol layer, and every caller
  // that did not parse and inspect our JSON saw them as identical.
  if (isError) result.isError = true;
  return result;
}

/**
 * Success. Object payloads are spread so `ok: true` sits alongside the fields
 * callers already read; non-object payloads (arrays, scalars) are nested under
 * `data` because they cannot carry a flag otherwise.
 */
export function ok(data?: unknown): ToolResult {
  if (data === undefined || data === null) return wrap({ ok: true });
  if (typeof data === "object" && !Array.isArray(data)) {
    const payload = data as Record<string, unknown>;

    // A FAILURE MAY NOT BE LAUNDERED INTO A SUCCESS BY ITS WRAPPER (item 1.7).
    //
    // 54 internal helpers across the tool modules return `{ ok: false, error }`
    // as a plain object, and the tool that calls one wraps the result with
    // `ok()`. The spread then puts `ok: true` first and the payload's `ok: false`
    // second, so the body was right by accident — but `isError` stayed unset, and
    // the host saw a successful call. Whether a failure was reported as one
    // depended on the order of two keys in a spread.
    //
    // Detecting it here rather than fixing 54 call sites is deliberate: this is
    // the one place every result passes through, so the invariant gets a WRITER
    // instead of 54 obligations. `record.ts:162` — "Absence of a failure verdict
    // is not evidence of integrity" — is the same move, and was the only correct
    // instance of it in the codebase.
    if (payload.ok === false) {
      return wrap(payload, true);
    }

    return wrap({ ok: true, ...payload });
  }
  return wrap({ ok: true, data });
}

/**
 * Failure. Always carries `ok: false` in the body AND `isError: true` on the
 * envelope — the body for callers that parse it, the flag for the host and for
 * every caller that does not.
 */
export function err(message: string): ToolResult {
  return wrap({ ok: false, error: message }, true);
}
