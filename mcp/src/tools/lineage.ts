/**
 * tools/lineage.ts
 * evor_store_patch   — write nodes/<node_id>/parent.patch atomically (pure TS)
 * evor_write_handoff — write handoffs/<tick>-<seq>.json atomically (bridge)
 * evor_read_handoff  — read within-tick or tick-markdown handoff (bridge)
 * evor_drain_inbox   — drain remember-inbox or signals-inbox (bridge)
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths } from "../run-store.js";
import { callBridge } from "../subprocess-bridge.js";

// ── evor_store_patch ──────────────────────────────────────────────────────────

/**
 * Write patch_content to nodes/<node_id>/parent.patch atomically.
 *
 * Pure TS — no Python bridge needed for a plain text atomic write.
 */
export function storePatch(
  runId: string,
  nodeId: string,
  patchContent: string,
  missionId?: string,
): { ok: boolean; patchPath?: string; error?: string } {
  const paths = resolveRunPaths(runId, missionId);
  const nodeDir = join(paths.nodesDir, nodeId);

  try {
    if (!existsSync(nodeDir)) {
      mkdirSync(nodeDir, { recursive: true });
    }
    const patchPath = join(nodeDir, "parent.patch");
    const tmpPath = `${patchPath}.tmp`;
    writeFileSync(tmpPath, patchContent, "utf8");
    renameSync(tmpPath, patchPath);
    return { ok: true, patchPath };
  } catch (err) {
    return {
      ok: false,
      error: `storePatch failed: ${(err as Error).message}`,
    };
  }
}

// ── evor_write_handoff ────────────────────────────────────────────────────────

/**
 * Write a tick handoff to handoffs/<tick>-<seq>.json atomically.
 *
 * The bridge handles sequential numbering so existing handoffs for the same
 * tick are never overwritten.
 */
export function writeHandoff(
  runId: string,
  tick: number,
  data: unknown,
  missionId?: string,
): { ok: boolean; path?: string; seq?: number; error?: string } {
  const paths = resolveRunPaths(runId, missionId);

  let tmpDir: string | null = null;
  let payloadFile: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-handoff-"));
    payloadFile = join(tmpDir, "payload.json");
    writeFileSync(payloadFile, JSON.stringify(data), "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `failed to write temp payload: ${(err as Error).message}`,
    };
  }

  let result;
  try {
    result = callBridge("handoff_bridge.py", [
      "--run-dir", paths.runDir,
      "--tick", String(tick),
      "--payload-file", payloadFile,
    ]);
  } finally {
    try { if (payloadFile) unlinkSync(payloadFile); } catch { /* ignore */ }
    try { if (tmpDir) rmdirSync(tmpDir); } catch { /* ignore */ }
  }

  if (!result.ok) {
    return { ok: false, error: result.error ?? "handoff_bridge failed" };
  }

  const d = result.data as Record<string, unknown>;
  if (d?.ok === true) {
    return {
      ok: true,
      path: String(d.path),
      seq: typeof d.seq === "number" ? d.seq : undefined,
    };
  }
  return {
    ok: false,
    error: String(d?.error ?? "unknown error from handoff_bridge"),
  };
}

// ── evor_read_handoff ─────────────────────────────────────────────────────────

/**
 * Read a handoff written by a prior agent.
 *
 * Three routing modes (mirrors Python handoff.py):
 *   - fromAgent + toAgent → within-tick JSON handoff (<from>_to_<to>.json)
 *   - tick (number)       → tick-N.md markdown handoff
 *   - neither             → latest tick handoff (highest tick number)
 *
 * Returns null (not an error) when the requested handoff does not exist yet —
 * callers should surface the gap rather than proceeding on missing context.
 */
export function readHandoff(
  runId: string,
  opts: { fromAgent?: string; toAgent?: string; tick?: number } = {},
  missionId?: string,
): { ok: boolean; handoff?: unknown; tick?: number; error?: string } {
  const paths = resolveRunPaths(runId, missionId);

  const bridgeArgs = ["--run-dir", paths.runDir];
  if (opts.fromAgent) bridgeArgs.push("--from-agent", opts.fromAgent);
  if (opts.toAgent) bridgeArgs.push("--to-agent", opts.toAgent);
  if (opts.tick !== undefined) bridgeArgs.push("--tick", String(opts.tick));

  const result = callBridge("read_handoff_bridge.py", bridgeArgs);

  if (!result.ok) {
    return { ok: false, error: result.error ?? "read_handoff_bridge failed" };
  }

  const d = result.data as Record<string, unknown>;
  if (d?.ok === true) {
    return {
      ok: true,
      handoff: d.handoff,
      tick: typeof d.tick === "number" ? d.tick : undefined,
    };
  }
  // Bridge returns {"error": "not found"} on a missing handoff (exit 0).
  return {
    ok: false,
    error: String(d?.error ?? "unknown error from read_handoff_bridge"),
  };
}

// ── evor_drain_inbox ──────────────────────────────────────────────────────────

/**
 * Drain the given inbox kind into its target store; return the count drained.
 */
export function drainInbox(
  runId: string,
  kind: "remember" | "signals",
  missionId?: string,
): { ok: boolean; drained?: number; error?: string } {
  const paths = resolveRunPaths(runId, missionId);

  const result = callBridge("inbox_bridge.py", [
    "--run-dir", paths.runDir,
    "--kind", kind,
  ]);

  if (!result.ok) {
    return { ok: false, error: result.error ?? "inbox_bridge failed" };
  }

  const d = result.data as Record<string, unknown>;
  if (d?.ok === true) {
    return {
      ok: true,
      drained: typeof d.drained === "number" ? d.drained : 0,
    };
  }
  return {
    ok: false,
    error: String(d?.error ?? "unknown error from inbox_bridge"),
  };
}

// ── Tool registrations ────────────────────────────────────────────────────────

export function registerLineageTools(server: McpServer): void {
  // ── evor_store_patch ───────────────────────────────────────────────────────
  server.tool(
    "evor_store_patch",
    "Write a unified-diff parent patch to nodes/<node_id>/parent.patch atomically.",
    {
      run_id: z.string().describe("Active run identifier"),
      node_id: z.string().describe("Node whose parent patch to store"),
      patch_content: z
        .string()
        .describe("Unified-diff patch content (e.g. git format-patch output)"),
    },
    async ({ run_id, node_id, patch_content }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = storePatch(run_id, node_id, patch_content, missionId);
      if (!result.ok) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: result.error }) },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              run_id,
              node_id,
              patch_path: result.patchPath,
            }),
          },
        ],
      };
    }
  );

  // ── evor_write_handoff ─────────────────────────────────────────────────────
  server.tool(
    "evor_write_handoff",
    [
      "Write a tick handoff payload to handoffs/<tick>-<seq>.json atomically.",
      "Sequence numbers are auto-incremented so multiple handoffs per tick are supported.",
    ].join(" "),
    {
      run_id: z.string().describe("Active run identifier"),
      tick: z.number().int().min(0).describe("Tick number for this handoff"),
      data: z.record(z.unknown()).describe("Handoff payload object"),
    },
    async ({ run_id, tick, data }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = writeHandoff(run_id, tick, data, missionId);
      if (!result.ok) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: result.error }) },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              run_id,
              tick,
              path: result.path,
              seq: result.seq,
            }),
          },
        ],
      };
    }
  );

  // ── evor_read_handoff ──────────────────────────────────────────────────────
  server.tool(
    "evor_read_handoff",
    [
      "Read a handoff written by a prior agent. Three routing modes:",
      "from_agent+to_agent → within-tick JSON handoff (handoffs/<from>_to_<to>.json);",
      "tick → tick-N.md markdown handoff;",
      "neither → latest tick handoff (highest tick number found).",
      "Returns {error:'not found'} when the handoff does not exist — surface the gap, do not fabricate.",
    ].join(" "),
    {
      run_id: z.string().describe("Active run identifier"),
      from_agent: z.string().optional().describe(
        "Source agent name for within-tick handoff (e.g. 'evor', 'selector'). Requires to_agent.",
      ),
      to_agent: z.string().optional().describe(
        "Destination agent name for within-tick handoff. Requires from_agent.",
      ),
      tick: z.number().int().min(0).optional().describe(
        "Tick number for tick-markdown handoff; omit for latest tick (when from/to also omitted)",
      ),
    },
    async ({ run_id, from_agent, to_agent, tick }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = readHandoff(run_id, { fromAgent: from_agent, toAgent: to_agent, tick }, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              result.ok
                ? { ok: true, run_id, handoff: result.handoff, ...(result.tick !== undefined ? { tick: result.tick } : {}) }
                : { error: result.error }
            ),
          },
        ],
      };
    },
  );

  // ── evor_drain_inbox ───────────────────────────────────────────────────────
  server.tool(
    "evor_drain_inbox",
    [
      "Drain the run's remember-inbox or signals-inbox into its target store, then truncate atomically.",
      "kind='remember' drains remember-inbox.jsonl into wiki notes (LessonEntry).",
      "kind='signals'  drains signals-inbox.jsonl into the SignalBus (deduped by signature).",
      "Returns the count of successfully processed entries.",
    ].join(" "),
    {
      run_id: z.string().describe("Active run identifier"),
      kind: z
        .enum(["remember", "signals"])
        .describe("Inbox to drain: 'remember' (→ wiki) or 'signals' (→ SignalBus)"),
    },
    async ({ run_id, kind }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = drainInbox(run_id, kind, missionId);
      if (!result.ok) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: result.error }) },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              run_id,
              kind,
              drained: result.drained,
            }),
          },
        ],
      };
    }
  );
}
