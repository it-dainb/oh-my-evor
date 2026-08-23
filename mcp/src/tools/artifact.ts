/**
 * tools/artifact.ts
 * evor_write_artifact — validate and atomically write a tick artifact.
 *
 * One tool, many agent kinds. Path mapping per spec §1:
 *   mutagen         → ticks/<tick>/mutagen/proposals.json
 *   selector        → ticks/<tick>/selector/verdict.json
 *   probe           → ticks/<tick>/probe/findings.json
 *   sage            → ticks/<tick>/sage/findings.json
 *   sage-junior     → ticks/<tick>/sage/juniors/<kind-slug>.json
 *   forge           → ticks/<tick>/forge/forge-report.json
 *   forge-architect → ticks/<tick>/forge/architect.json
 *   forge-critic    → ticks/<tick>/forge/critic.json
 *   forge-analyst   → ticks/<tick>/forge/analyst.json
 *   acquirer        → ticks/<tick>/acquirer/<kind-slug>.json
 *
 * Payload validation is delegated to the Python harness (evor.artifacts) which
 * validates against Pydantic contracts where one exists (mutagen, selector,
 * sage, sage-junior, acquirer); all other agents pass through as plain JSON.
 */

import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRunPaths } from "../run-store.js";
import { callBridge } from "../subprocess-bridge.js";
import { resolveRunId } from "../active-run.js";
import { err } from "../tool-result.js";

/**
 * Agent kinds whose artifacts are validated against a Pydantic contract at write
 * time. Every other kind is persisted as unchecked JSON — see the module notes.
 * Keep this in sync with the harness contracts; an entry here is a promise.
 */
const CONTRACT_VALIDATED_AGENTS = new Set<string>([
  "mutagen",
  "selector",
  "sage",
  "sage-junior",
  "acquirer",
]);

const VALID_AGENTS = [
  "mutagen",
  "selector",
  "probe",
  "sage",
  "sage-junior",
  "forge",
  "forge-architect",
  "forge-critic",
  "forge-analyst",
  "acquirer",
] as const;

// ── Core logic (exported for tests) ──────────────────────────────────────────

export function writeArtifact(
  runId: string,
  tick: number,
  agent: (typeof VALID_AGENTS)[number],
  payload: unknown,
  kind?: string,
  partial?: boolean,
  missionId?: string,
): { ok: boolean; path?: string; error?: string } {
  const paths = resolveRunPaths(runId, missionId);

  // Write payload to a temp file so the bridge can read it without hitting
  // OS arg-length limits for large proposal or findings payloads.
  let tmpDir: string | null = null;
  let payloadFile: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-artifact-"));
    payloadFile = join(tmpDir, "payload.json");
    writeFileSync(payloadFile, JSON.stringify(payload), "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `failed to write temp payload: ${(err as Error).message}`,
    };
  }

  const bridgeArgs = [
    "--run-dir", paths.runDir,
    "--tick", String(tick),
    "--agent", agent,
    "--payload-file", payloadFile,
    ...(kind ? ["--kind", kind] : []),
    ...(partial ? ["--partial"] : []),
  ];

  let result;
  try {
    result = callBridge("artifact_bridge.py", bridgeArgs);
  } finally {
    // Clean up temp files regardless of bridge outcome.
    try { if (payloadFile) unlinkSync(payloadFile); } catch { /* ignore */ }
    try { if (tmpDir) rmdirSync(tmpDir); } catch { /* ignore */ }
  }

  if (!result.ok) {
    // Prefer the structured error from bridge stdout over raw stderr.
    const structuredError =
      result.data &&
      typeof result.data === "object" &&
      "error" in (result.data as Record<string, unknown>)
        ? String((result.data as Record<string, unknown>).error)
        : result.error ?? "artifact_bridge failed";
    return { ok: false, error: structuredError };
  }

  const data = result.data as Record<string, unknown>;
  if (data?.ok === true) {
    return { ok: true, path: String(data.path) };
  }
  return {
    ok: false,
    error: String(data?.error ?? "unknown error from artifact_bridge"),
  };
}

// ── Read logic (exported for tests) ──────────────────────────────────────────

export function readArtifact(
  runId: string,
  tick: number,
  agent: (typeof VALID_AGENTS)[number],
  kind?: string,
  partial?: boolean,
  missionId?: string,
): { ok: boolean; payload?: unknown; path?: string; error?: string } {
  const paths = resolveRunPaths(runId, missionId);

  const bridgeArgs = [
    "--run-dir", paths.runDir,
    "--tick", String(tick),
    "--agent", agent,
    ...(kind ? ["--kind", kind] : []),
    ...(partial ? ["--partial"] : []),
  ];

  const result = callBridge("read_artifact_bridge.py", bridgeArgs);

  if (!result.ok) {
    // Real failure: invalid agent name, bridge crash, I/O error on existing file.
    const structuredError =
      result.data &&
      typeof result.data === "object" &&
      "error" in (result.data as Record<string, unknown>)
        ? String((result.data as Record<string, unknown>).error)
        : result.error ?? "read_artifact_bridge failed";
    return { ok: false, error: structuredError };
  }

  const data = result.data as Record<string, unknown>;
  if (data?.ok === true) {
    return { ok: true, payload: data.payload, path: String(data.path) };
  }
  // "not found" and other non-ok responses from bridge exit-0 path.
  return {
    ok: false,
    error: String(data?.error ?? "unknown error from read_artifact_bridge"),
  };
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerArtifactTools(server: McpServer): void {
  server.tool(
    "evor_write_artifact",
    [
      "Validate and atomically write a tick artifact for the given agent kind.",
      "The destination is derived automatically from the agent and tick.",
      "Payload is validated against the contract for that agent kind where one exists;",
      "unknown/loose agents pass through as plain JSON.",
    ].join(" "),
    {
      // Optional with an active-run fallback. Required-with-no-default is what
      // produced three identical evor_cite failures in run 29d17abc: the schema
      // gave the model no signal about what was wrong, so it repeated the same
      // bad call. Format hints would only make that more diagnosable; resolving
      // from the active run removes the failure mode entirely (rubric rule 1).
      run_id: z.string().optional().describe("Active run identifier"),
      tick: z.number().int().min(0).describe("Current tick number"),
      agent: z
        .enum(VALID_AGENTS)
        .describe("Agent writing the artifact (determines path and validation schema)"),
      kind: z
        .string()
        .optional()
        .describe(
          "Kind slug: required for sage-junior (finding kind) and acquirer (source slug)"
        ),
      payload: z
        .record(z.unknown())
        .describe("Artifact payload object to write"),
      partial: z
        .boolean()
        .optional()
        .describe("If true, write as an in-progress (partial) artifact"),
    },
    async ({ run_id: run_id_in, tick, agent, kind, payload, partial }) => {
      const run_id = resolveRunId(run_id_in);
      if (!run_id) return err("no run_id given and no active run found — start a run or pass run_id explicitly");
      const missionId = process.env.EVOR_MISSION_ID;
      const result = writeArtifact(run_id, tick, agent, payload, kind, partial, missionId);
      if (!result.ok) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ok: false, error: result.error }) },
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
              agent,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "evor_read_artifact",
    [
      "Read and validate a tick artifact written by an upstream agent.",
      "Returns {ok:true,validated,payload}, or {ok:false,error:'not found'} when the upstream",
      "agent hasn't produced it yet — a strong signal to stop and surface the gap,",
      "not proceed on assumptions. Path mapping is identical to evor_write_artifact.",
    ].join(" "),
    {
      run_id: z.string().describe("Active run identifier"),
      tick: z.number().int().min(0).describe("Tick whose artifact to read"),
      agent: z
        .enum(VALID_AGENTS)
        .describe("Agent that wrote the artifact (determines path and validation schema)"),
      kind: z
        .string()
        .optional()
        .describe(
          "Kind slug: required for sage-junior (finding kind) and acquirer (source slug)"
        ),
      partial: z
        .boolean()
        .optional()
        .describe("If true, read the in-progress (partial) variant"),
    },
    async ({ run_id, tick, agent, kind, partial }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = readArtifact(run_id, tick, agent, kind, partial, missionId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              result.ok
                ? {
                    ok: true,
                    run_id,
                    tick,
                    agent,
                    // `ok:true` means "some JSON was read", never "this payload is
                    // trustworthy" — that conflation is what let the stub artifact
                    // `{finding:"test", quorum_met:true}` clear a review gate in run
                    // 29d17abc. Pydantic contracts cover only the kinds below; the
                    // rest pass through as plain JSON with no write-time validation
                    // at all, so the caller is told which it got rather than left to
                    // assume.
                    validated: CONTRACT_VALIDATED_AGENTS.has(agent),
                    payload: result.payload,
                  }
                : { ok: false, error: result.error }
            ),
          },
        ],
      };
    }
  );
}
