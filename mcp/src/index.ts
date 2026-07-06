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
import { registerArtifactTools } from "./tools/artifact.js";
import { registerLineageTools } from "./tools/lineage.js";
import { registerComputeTools } from "./tools/compute.js";
import { registerGotchaTools } from "./tools/gotcha.js";

/**
 * Server instructions — loaded upfront (<=2KB) even with MCP tool-search deferral,
 * so the model knows WHEN to search for evor_* tools. Keep critical info first; the
 * full catalog + schemas live in the `oh-my-evor:evor-mcp` skill (not duplicated here).
 */
const EVOR_INSTRUCTIONS =
  "Evor runs an autonomous ML-research evolution: it evolves a model+dataset by " +
  "mutation tree search under integrity gates. USE these evor_* tools whenever a mission " +
  "is being set up, run, resumed, or inspected — any time you change or read .evor state, " +
  "record a node/eval, launch or check a training run, write or read a tick artifact, cite " +
  "a paper, emit/query a signal, or manage the run. These evor_* tools are the only sanctioned " +
  "way to operate a run; do not author .evor state files by hand. Search for them " +
  "whenever an evor run is active. Core loop: evor_init_run -> evor_record_node -> " +
  "evor_run_start (async; watch with the native Monitor tool) -> evor_run_status -> " +
  "evor_record_eval -> evor_integrity_check -> evor_wiki_add. Read upstream tick artifacts " +
  "with evor_read_artifact before acting. Full catalog, lifecycle recipes, and artifact " +
  "schemas: invoke the `oh-my-evor:evor-mcp` skill.";

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: "evor",
      version: "1.0.1",
    },
    { instructions: EVOR_INSTRUCTIONS }
  );

  // Register all tools. WS-A/B/1.5 add artifact/lineage/compute modules.
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
  registerArtifactTools(server);  // evor_write_artifact, evor_read_artifact
  registerLineageTools(server);   // evor_store_patch, evor_write_handoff, evor_read_handoff, evor_drain_inbox
  registerComputeTools(server);   // evor_run_start/status + compute wrappers + wiki_summarize, gotchas_list
  registerGotchaTools(server);    // evor_gotcha_query, evor_gotcha_add, evor_store_blob

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
