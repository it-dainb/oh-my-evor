/**
 * mcp/tests/wiki-add-nulls.test.ts
 *
 * A null on an optional lesson field reads as absent, through the real SDK
 * request path where the schema is applied.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerWikiTools } from "../src/tools/wiki.js";
import { ensureRunDirs } from "../src/run-store.js";

const saved = { root: process.env.EVOR_ROOT, mission: process.env.EVOR_MISSION_ID };
let root = "";
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["EVOR_ROOT", saved.root], ["EVOR_MISSION_ID", saved.mission]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("evor_wiki_add with null optional fields", () => {
  it("accepts superseded_by, root_cause and telemetry_evidence as null", async () => {
    root = mkdtempSync(join(tmpdir(), "evor-wiki-"));
    process.env.EVOR_ROOT = root;
    process.env.EVOR_MISSION_ID = "m";
    ensureRunDirs("r", "m");
    const server = new McpServer({ name: "t", version: "0" });
    registerWikiTools(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: "evor_wiki_add", arguments: { run_id: "r", entry: {
      approach_family: "training", hypothesis_verdict: "refuted", observation: "o", actionable_lesson: "l",
      citations: [], tags: ["t"], superseded_by: null, root_cause: null, telemetry_evidence: null,
    } } });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/invalid_type|Expected string, received null/);
  });
});
