/**
 * tools/gotcha.ts
 * evor_gotcha_query — query the GotchaStore for known failure patterns
 * evor_gotcha_add   — record a new gotcha (or dedup-update an existing one)
 * evor_store_blob   — store a file or text blob in the ContentAddressedStore
 *
 * gotcha_query and gotcha_add delegate to mcp/bridge/gotcha_bridge.py which
 * wraps GotchaStore. evor_store_blob delegates to store_blob_bridge.py which
 * wraps ContentAddressedStore.put() + optional register_acquired().
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GotchaEntrySchema } from "../contracts.js";
import { resolveRunPaths, getEvorRoot } from "../run-store.js";
import { callBridge } from "../subprocess-bridge.js";

// ── Core logic (exported for tests) ──────────────────────────────────────────

export interface GotchaQueryParams {
  evorRoot?: string;
  runId?: string;
  kind?: string;
  scope?: string;
  minConfidence?: number;
  missionId?: string;
}

/**
 * Query the GotchaStore for known failure patterns.
 *
 * Reads from global store (.evor/wiki/gotchas/global.jsonl) and optionally the
 * mission store (run_dir/gotchas/mission.jsonl) when a runId is given.
 */
export function gotchaQuery(
  params: GotchaQueryParams,
): { ok: boolean; gotchas?: unknown[]; total?: number; error?: string } {
  const evorRoot = params.evorRoot ?? getEvorRoot();
  const runDir = params.runId
    ? resolveRunPaths(params.runId, params.missionId).runDir
    : undefined;

  const bridgeArgs = [
    "--action", "query",
    "--evor-root", evorRoot,
  ];
  if (runDir) bridgeArgs.push("--run-dir", runDir);
  if (params.kind) bridgeArgs.push("--kind", params.kind);
  if (params.scope) bridgeArgs.push("--scope", params.scope);
  if (params.minConfidence !== undefined) {
    bridgeArgs.push("--min-confidence", String(params.minConfidence));
  }

  const result = callBridge("gotcha_bridge.py", bridgeArgs);
  if (!result.ok) {
    return { ok: false, error: result.error ?? "gotcha_bridge query failed" };
  }

  const data = result.data as Record<string, unknown>;
  if (data?.ok === true) {
    return {
      ok: true,
      gotchas: data.gotchas as unknown[],
      total: data.total as number,
    };
  }
  return {
    ok: false,
    error: String(data?.error ?? "unknown error from gotcha_bridge"),
  };
}

export interface GotchaAddParams {
  runId: string;
  kind: string;
  signature: string;
  context: Record<string, unknown>;
  resolution: string;
  avoidance: string;
  scope?: string;
  confidence?: number;
  evorRoot?: string;
  missionId?: string;
}

/**
 * Add or dedup-update a gotcha entry in the GotchaStore.
 *
 * Dedup key: (signature, scope). If an entry with the same key already exists,
 * occurrences increments and confidence rises toward 1.0.
 */
export function gotchaAdd(
  params: GotchaAddParams,
): { ok: boolean; gotcha?: unknown; error?: string } {
  const evorRoot = params.evorRoot ?? getEvorRoot();
  const runDir = resolveRunPaths(params.runId, params.missionId).runDir;

  // Write payload to a temp file — avoids OS arg-length limits for context dicts.
  let tmpDir: string | null = null;
  let payloadFile: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "evor-gotcha-"));
    payloadFile = join(tmpDir, "payload.json");
    writeFileSync(
      payloadFile,
      JSON.stringify({
        kind: params.kind,
        signature: params.signature,
        context: params.context,
        resolution: params.resolution,
        avoidance: params.avoidance,
        scope: params.scope ?? "global",
        confidence: params.confidence ?? 0.5,
      }),
      "utf8",
    );
  } catch (err) {
    return {
      ok: false,
      error: `failed to write temp payload: ${(err as Error).message}`,
    };
  }

  const bridgeArgs = [
    "--action", "add",
    "--evor-root", evorRoot,
    "--run-dir", runDir,
    "--payload-file", payloadFile,
  ];

  let result;
  try {
    result = callBridge("gotcha_bridge.py", bridgeArgs);
  } finally {
    try { if (payloadFile) unlinkSync(payloadFile); } catch { /* ignore */ }
    try { if (tmpDir) rmdirSync(tmpDir); } catch { /* ignore */ }
  }

  if (!result.ok) {
    return { ok: false, error: result.error ?? "gotcha_bridge add failed" };
  }

  const data = result.data as Record<string, unknown>;
  if (data?.ok === true) {
    return { ok: true, gotcha: data.gotcha };
  }
  return {
    ok: false,
    error: String(data?.error ?? "unknown error from gotcha_bridge"),
  };
}

export interface StoreBlobParams {
  runId: string;
  /** Absolute path to an existing file to store. Mutually exclusive with content. */
  path?: string;
  /** Text content to store as a blob. Mutually exclusive with path. */
  content?: string;
  /** Optional acquisition ID; if set, registers blob under the 'train' namespace. */
  acquisitionId?: string;
  missionId?: string;
}

/**
 * Store a file or text blob in the ContentAddressedStore.
 *
 * Returns the sha256 content reference on success. If `content` is provided
 * it is written to a temp file first. If `acquisitionId` is provided the blob
 * is registered under the 'train' namespace (enforces ADR-015).
 */
export function storeBlob(
  params: StoreBlobParams,
): { ok: boolean; content_ref?: string; error?: string } {
  const runDir = resolveRunPaths(params.runId, params.missionId).runDir;

  // Ensure run dir exists so the store can create artifacts/
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }

  let srcPath = params.path;
  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  if (!srcPath) {
    if (params.content === undefined) {
      return { ok: false, error: "one of 'path' or 'content' is required" };
    }
    // Write content to a temp file for the bridge to pick up.
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "evor-blob-"));
      tmpFile = join(tmpDir, "blob.bin");
      writeFileSync(tmpFile, params.content, "utf8");
      srcPath = tmpFile;
    } catch (err) {
      return {
        ok: false,
        error: `failed to write temp content file: ${(err as Error).message}`,
      };
    }
  }

  const bridgeArgs = [
    "--run-dir", runDir,
    "--src-path", srcPath,
  ];
  if (params.acquisitionId) {
    bridgeArgs.push("--acquisition-id", params.acquisitionId);
  }

  let result;
  try {
    result = callBridge("store_blob_bridge.py", bridgeArgs);
  } finally {
    try { if (tmpFile) unlinkSync(tmpFile); } catch { /* ignore */ }
    try { if (tmpDir) rmdirSync(tmpDir); } catch { /* ignore */ }
  }

  if (!result.ok) {
    return { ok: false, error: result.error ?? "store_blob_bridge failed" };
  }

  const data = result.data as Record<string, unknown>;
  if (data?.ok === true) {
    return { ok: true, content_ref: String(data.content_ref) };
  }
  return {
    ok: false,
    error: String(data?.error ?? "unknown error from store_blob_bridge"),
  };
}

// ── Tool registrations ────────────────────────────────────────────────────────

export function registerGotchaTools(server: McpServer): void {
  // ── evor_gotcha_query ──────────────────────────────────────────────────────
  server.tool(
    "evor_gotcha_query",
    [
      "Query the GotchaStore for known failure patterns, hardware constraints, and approach dead-ends.",
      "Reads from the global store (.evor/wiki/gotchas/global.jsonl) and optionally the",
      "mission-scoped store (run_dir/gotchas/mission.jsonl) when run_id is provided.",
      "Returns entries sorted by confidence descending, then last_seen descending.",
    ].join(" "),
    {
      run_id: z.string().optional().describe(
        "Active run identifier; if provided, also reads mission-scoped gotchas",
      ),
      evor_root: z.string().optional().describe(
        "Path to .evor/ root (default: EVOR_ROOT env or cwd/.evor)",
      ),
      kind: z
        .enum(["runtime-failure", "hardware-constraint", "approach-deadend"])
        .optional()
        .describe("Filter by gotcha kind; omit for all kinds"),
      scope: z
        .enum(["global", "mission"])
        .optional()
        .describe("Filter by scope; omit for all scopes"),
      min_confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum confidence threshold (0.0–1.0); default 0.0"),
    },
    async ({ run_id, evor_root, kind, scope, min_confidence }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = gotchaQuery({
        runId: run_id,
        evorRoot: evor_root,
        kind,
        scope,
        minConfidence: min_confidence,
        missionId,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: result.error }) }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, gotchas: result.gotchas, total: result.total }),
          },
        ],
      };
    },
  );

  // ── evor_gotcha_add ────────────────────────────────────────────────────────
  server.tool(
    "evor_gotcha_add",
    [
      "Record a new gotcha or dedup-update an existing one in the GotchaStore.",
      "Dedup key: (signature, scope). Repeat adds increment occurrences and raise confidence.",
      "Global-scoped gotchas persist across missions so later missions benefit from prior failures.",
    ].join(" "),
    {
      run_id: z.string().describe("Active run identifier"),
      kind: z
        .enum(["runtime-failure", "hardware-constraint", "approach-deadend"])
        .describe("Gotcha kind"),
      signature: z.string().describe("Dedup key — identical (signature, scope) pairs aggregate"),
      context: z
        .record(z.string(), z.unknown())
        .describe("Structured context dict (e.g. {batch_size: 256, gpu: 'A100'})"),
      resolution: z.string().describe("What resolved or worked around this gotcha"),
      avoidance: z.string().describe("How to avoid this gotcha in future attempts"),
      scope: z
        .enum(["global", "mission"])
        .default("global")
        .describe("'global' persists across missions; 'mission' is run-scoped (default: global)"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe("Initial confidence 0.0–1.0; raised toward 1.0 on repeat encounters"),
      evor_root: z.string().optional().describe(
        "Path to .evor/ root (default: EVOR_ROOT env or cwd/.evor)",
      ),
    },
    async ({ run_id, kind, signature, context, resolution, avoidance, scope, confidence, evor_root }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = gotchaAdd({
        runId: run_id,
        kind,
        signature,
        context,
        resolution,
        avoidance,
        scope,
        confidence,
        evorRoot: evor_root,
        missionId,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: result.error }) }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, run_id, gotcha: result.gotcha }),
          },
        ],
      };
    },
  );

  // ── evor_store_blob ────────────────────────────────────────────────────────
  server.tool(
    "evor_store_blob",
    [
      "Store a file or text blob durably so it can be referenced across nodes and runs.",
      "Identical blobs are stored only once (dedup). Returns acquisition_id as the logical handle",
      "to pass to evor_record_node or store in tree artifacts.",
      "If acquisition_id is provided, the blob is registered under the 'train' namespace (ADR-015 enforcement).",
    ].join(" "),
    {
      run_id: z.string().describe("Active run identifier"),
      path: z.string().optional().describe(
        "Absolute path to an existing file to store. Mutually exclusive with 'content'.",
      ),
      content: z.string().optional().describe(
        "Text content to store as a blob. Mutually exclusive with 'path'.",
      ),
      kind: z.string().optional().describe(
        "Informational kind label (e.g. 'genome', 'dataset-sample'); stored as metadata only",
      ),
      acquisition_id: z.string().optional().describe(
        "If provided, registers the blob under this acquisition ID in the train namespace",
      ),
    },
    async ({ run_id, path: srcPath, content, acquisition_id }) => {
      const missionId = process.env.EVOR_MISSION_ID;
      const result = storeBlob({
        runId: run_id,
        path: srcPath,
        content,
        acquisitionId: acquisition_id,
        missionId,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: result.error }) }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              // The server-computed content-addressed handle. Previously omitted, so a
              // caller that supplied no acquisition_id got back no handle whatsoever.
              content_ref: result.content_ref ?? null,
              acquisition_id: acquisition_id ?? null,
            }),
          },
        ],
      };
    },
  );
}
