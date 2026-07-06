/**
 * oh-my-evor MCP server — stdio transport
 *
 * Registers all 12 evor tools. Stub implementations validate input schemas
 * via McpServer's built-in Zod integration and return placeholder responses.
 * Full logic is wired in later milestones (M5, M6, M7).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerRecordTools } from "./tools/record.js";
import { registerTreeTools } from "./tools/tree.js";
import { registerScheduleTools } from "./tools/schedule.js";
import { registerWikiTools } from "./tools/wiki.js";
import { registerStateTools } from "./tools/state.js";
import { registerIntegrityTools } from "./tools/integrity.js";
import { registerCiteTools } from "./tools/cite.js";
import { registerTelemetryTools } from "./tools/telemetry.js";
import { registerSignalTools } from "./tools/signals.js";
import { registerInitTools } from "./tools/init.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "evor",
    version: "0.5.0",
  });

  // Register all 15 tools across 10 tool modules
  registerInitTools(server);      // evor_init_run
  registerRecordTools(server);    // evor_record_node, evor_record_eval
  registerTreeTools(server);      // evor_tree_read, evor_select
  registerScheduleTools(server);  // evor_schedule
  registerWikiTools(server);      // evor_wiki_add, evor_wiki_query
  registerStateTools(server);     // evor_state_read, evor_state_write
  registerIntegrityTools(server); // evor_integrity_check
  registerCiteTools(server);      // evor_cite
  registerTelemetryTools(server); // evor_telemetry_ingest
  registerSignalTools(server);    // evor_signal_emit, evor_signal_query

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[evor-mcp] fatal: ${err}\n`);
  process.exit(1);
});
