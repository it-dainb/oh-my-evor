/**
 * mcp/tests/tolerant-args.test.ts
 *
 * An object or array argument sent JSON-encoded is parsed before validation,
 * through the real SDK request path; other parameters keep their declared type
 * and the advertised schema is unchanged.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { acceptJsonStringArgs } from "../src/tolerant-args.js";

async function connect() {
  const server = new McpServer({ name: "t", version: "0" });
  acceptJsonStringArgs(server);
  server.tool(
    "echo",
    "echo",
    {
      result: z.object({ status: z.string() }),
      tags: z.array(z.string()).optional(),
      note: z.string().optional(),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(args) }] }),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

describe("JSON-string object and array arguments", () => {
  it("parses an object and an array sent as strings", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "echo", arguments: { result: '{"status":"ok"}', tags: '["a","b"]' } });
    expect(text(r)).toEqual({ result: { status: "ok" }, tags: ["a", "b"] });
  });

  it("leaves a string parameter a string, even when it looks like JSON", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "echo", arguments: { result: { status: "ok" }, note: '{"x":1}' } });
    expect(text(r).note).toBe('{"x":1}');
  });

  it("still advertises the declared object type and keeps optional parameters optional", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const schema = tools[0].inputSchema as { properties: Record<string, { type?: string }>; required?: string[] };
    expect(schema.properties.result.type).toBe("object");
    expect(schema.required).toEqual(["result"]);
  });
});
