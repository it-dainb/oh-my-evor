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

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function wrap(payload: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Success. Object payloads are spread so `ok: true` sits alongside the fields
 * callers already read; non-object payloads (arrays, scalars) are nested under
 * `data` because they cannot carry a flag otherwise.
 */
export function ok(data?: unknown): ToolResult {
  if (data === undefined || data === null) return wrap({ ok: true });
  if (typeof data === "object" && !Array.isArray(data)) {
    return wrap({ ok: true, ...(data as Record<string, unknown>) });
  }
  return wrap({ ok: true, data });
}

/** Failure. Always carries `ok: false` — that is the whole point of this module. */
export function err(message: string): ToolResult {
  return wrap({ ok: false, error: message });
}
