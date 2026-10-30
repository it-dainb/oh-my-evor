/**
 * mcp/src/tolerant-args.ts — accept object and array arguments sent as JSON strings.
 *
 * Models sometimes send a nested argument JSON-encoded (`"result": "{\"status\":…}"`,
 * `"shapes": "[\"failure\"]"`). The schema then rejects a call whose content is
 * right. Every top-level parameter whose type is an object, array or record is
 * parsed from a string first; anything else is left exactly as declared.
 */
import { z, ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function baseType(t: ZodTypeAny): ZodTypeAny {
  let cur: ZodTypeAny = t;
  for (;;) {
    const def = (cur as { _def?: { innerType?: ZodTypeAny; schema?: ZodTypeAny; typeName?: string } })._def;
    if (def?.innerType) cur = def.innerType;
    else if (def?.typeName === "ZodEffects" && def.schema) cur = def.schema;
    else return cur;
  }
}

function tolerant(t: ZodTypeAny): ZodTypeAny {
  const b = baseType(t);
  if (!(b instanceof z.ZodObject || b instanceof z.ZodArray || b instanceof z.ZodRecord)) return t;
  return z.preprocess((v) => {
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch { return v; }
  }, t);
}

/** Wrap `server.tool` so every registration gets tolerant object/array parameters. */
export function acceptJsonStringArgs(server: McpServer): void {
  const original = server.tool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const i = args.findIndex((a, k) => k > 0 && a && typeof a === "object" && !Array.isArray(a) && typeof a !== "function"
      && Object.values(a as object).every((v) => v instanceof z.ZodType));
    if (i > 0) {
      const shape = args[i] as Record<string, ZodTypeAny>;
      args[i] = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, tolerant(v)]));
    }
    return original(...args);
  };
}
