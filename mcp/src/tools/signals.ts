/**
 * tools/signals.ts
 * evor_signal_emit   — dedup-upsert a Signal onto the run's signal bus
 * evor_signal_query  — pull signals by facet/severity/kind/tick lens (drains inbox first)
 * evor_signal_digest — compact top-slice for spawn-prompt injection
 *
 * Disk layout: <run_dir>/signals.jsonl (one JSON object per line).
 * Dedup key: `signature`. Repeat emits aggregate: occurrences+1,
 * last_seen=now, confidence raised toward 1.0, severity = MAX(old,new),
 * shapes/axes union, evidence merged. Mirrors harness/evor/signals.py exactly.
 *
 * Inbox drain (fix §15B parity): querySignals drains signals-inbox.jsonl
 * before loading so hook-captured signals written since the last query are
 * visible immediately — matches Python SignalBus.query() drain_inbox() call.
 * Pure TS atomic-rename drain — no Python subprocess dependency.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  Signal,
  SignalAxisSchema,
  SignalSchema,
  SignalShapeSchema,
  SignalSeveritySchema,
} from "../contracts.js";
import { resolveRunPaths } from "../run-store.js";
import { withRunLock } from "../lock.js";

// ── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function signalId(kind: string, signature: string): string {
  const h = createHash("sha256").update(`${kind}:${signature}`).digest("hex").slice(0, 12);
  return `sig-${h}`;
}

function loadSignals(signalsPath: string): Signal[] {
  if (!existsSync(signalsPath)) return [];
  const out: Signal[] = [];
  for (const line of readFileSync(signalsPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(SignalSchema.parse(JSON.parse(t)));
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

function atomicWriteJsonl(signalsPath: string, records: Signal[]): void {
  const dir = dirname(signalsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${signalsPath}.tmp`;
  writeFileSync(tmpPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  renameSync(tmpPath, signalsPath);
}

/**
 * Drain <run_dir>/signals-inbox.jsonl into signals.jsonl.
 *
 * Mirrors Python SignalBus.drain_inbox(): atomically claims the inbox via
 * rename (crash-safe — a pre-existing .drain-tmp orphan is cleaned first),
 * then emits each line through emitSignal() (which dedups by signature).
 * Malformed lines are skipped silently.
 *
 * This is a pure-TS implementation so querySignals remains Python-free while
 * providing parity with the Python SignalBus.query() that calls drain_inbox()
 * before loading the bus.
 */
function drainSignalsInbox(runDir: string, runId: string, missionId?: string): void {
  const inboxPath = join(runDir, "signals-inbox.jsonl");
  if (!existsSync(inboxPath)) return;

  const tmpPath = `${inboxPath}.drain-tmp`;

  // Clean any orphaned .drain-tmp left by a prior crash
  if (existsSync(tmpPath)) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  // Atomically claim the inbox before reading so a concurrent drain doesn't
  // process the same lines twice.
  try {
    renameSync(inboxPath, tmpPath);
  } catch {
    return; // inbox vanished (race) or rename failed — skip drain
  }

  let lines: string[];
  try {
    lines = readFileSync(tmpPath, "utf8").split("\n");
  } catch {
    return; // couldn't read drain-tmp — skip
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const entry = JSON.parse(t) as Record<string, unknown>;
      emitSignal(
        runId,
        {
          kind: String(entry.kind ?? ""),
          signature: String(entry.signature ?? ""),
          shapes: Array.isArray(entry.shapes) ? (entry.shapes as string[]) : [],
          axes: Array.isArray(entry.axes) ? (entry.axes as string[]) : [],
          severity: String(entry.severity ?? "medium"),
          evidence: (entry.evidence as Record<string, unknown>) ?? {},
          source: String(entry.source ?? "hook:unknown"),
          tick: typeof entry.tick === "number" ? entry.tick : null,
          node_id: typeof entry.node_id === "string" ? entry.node_id : null,
          confidence: typeof entry.confidence === "number" ? entry.confidence : 0.5,
        },
        missionId,
      );
    } catch {
      /* skip malformed inbox lines */
    }
  }
}

// ── Core logic (exported for tests) ─────────────────────────────────────────

export interface EmitInput {
  kind: string;
  signature: string;
  shapes: string[];
  axes: string[];
  severity: string;
  evidence: Record<string, unknown>;
  source: string;
  tick?: number | null;
  node_id?: string | null;
  /** Initial confidence for new signals (0.0–1.0). Default 0.5. Mirrors make_signal() in signals.py. */
  confidence?: number;
}

/**
 * Persist or aggregate a signal on the run's bus. Dedup key = signature.
 *
 * Repeat emits: occurrences+1, last_seen=now, confidence raised toward 1.0
 * by (1-confidence)*0.4, severity = MAX(old, new), shapes/axes union,
 * evidence merged (incoming keys win on collision).
 *
 * `atomicWriteJsonl` is atomic per-file (tmp+rename), but the read-modify-write
 * is not locked, so a concurrent writer can clobber a just-written signal.
 * We defend against that by verifying the signal persisted after each write
 * and retrying — mirrors the upsertNode pattern in tree-store.ts.
 */
export function emitSignal(
  runId: string,
  input: EmitInput,
  missionId?: string,
): Signal {
  const paths = resolveRunPaths(runId, missionId);
  return withRunLock(paths.runDir, (): Signal => {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = loadSignals(paths.signalsPath);

      const idx = existing.findIndex((s) => s.signature === input.signature);
      let final: Signal;

      if (idx !== -1) {
        const old = existing[idx];
        const newConf = Math.min(1.0, old.confidence + (1.0 - old.confidence) * 0.4);
        const newSev =
          SEVERITY_ORDER[input.severity] > SEVERITY_ORDER[old.severity]
            ? (input.severity as Signal["severity"])
            : old.severity;

        // Union shapes and axes, sort for stable output (mirrors Python sorted())
        const mergedShapes = [...new Set([...old.shapes, ...input.shapes])].sort() as Signal["shapes"];
        const mergedAxes = [...new Set([...old.axes, ...input.axes])].sort() as Signal["axes"];

        final = {
          signal_id: old.signal_id,
          kind: old.kind,
          signature: old.signature,
          shapes: mergedShapes,
          axes: mergedAxes,
          severity: newSev,
          evidence: { ...old.evidence, ...input.evidence },
          source: input.source,
          tick: input.tick !== undefined && input.tick !== null ? input.tick : old.tick,
          node_id: input.node_id !== undefined && input.node_id !== null ? input.node_id : old.node_id,
          confidence: Math.round(newConf * 10000) / 10000,
          occurrences: old.occurrences + 1,
          first_seen: old.first_seen,
          last_seen: nowIso(),
        };
        existing[idx] = final;
      } else {
        const now = nowIso();
        final = {
          signal_id: signalId(input.kind, input.signature),
          kind: input.kind,
          signature: input.signature,
          shapes: [...input.shapes].sort() as Signal["shapes"],
          axes: [...input.axes].sort() as Signal["axes"],
          severity: input.severity as Signal["severity"],
          evidence: input.evidence,
          source: input.source,
          tick: input.tick ?? undefined,
          node_id: input.node_id ?? undefined,
          confidence: input.confidence ?? 0.5,
          occurrences: 1,
          first_seen: now,
          last_seen: now,
        };
        existing.push(final);
      }

      atomicWriteJsonl(paths.signalsPath, existing);

      // Verify the signal actually persisted (guard against concurrent clobber).
      try {
        if (loadSignals(paths.signalsPath).some((s) => s.signature === final.signature)) {
          return final;
        }
      } catch {
        // file momentarily unreadable, retry
      }
    }

    throw new Error(
      `emitSignal: signal "${input.signature}" failed to persist in signals.jsonl after 3 attempts (concurrent clobber detected)`,
    );
  });
}

export interface QueryParams {
  shapes?: string[];
  axes?: string[];
  kind?: string;
  min_severity?: string;
  since_tick?: number;
  /** Cap the number of results returned (default 100). Guards agents against pulling the full bus. */
  limit?: number;
}

/**
 * Return signals matching a lens's subscription.
 *
 * Drains signals-inbox.jsonl first (parity fix §15B) so any hook captures
 * written since the last query are visible immediately — matches Python
 * SignalBus.query() which calls drain_inbox() before loading.
 *
 * Facet match is ANY-overlap: a signal matches if it shares >=1 requested
 * shape (when shapes given) AND >=1 requested axis (when axes given).
 * Sorted by (severity, confidence, last_seen) descending — highest-priority
 * first so digests take the top slice.
 */
export function querySignals(
  runId: string,
  params: QueryParams,
  missionId?: string,
): Signal[] {
  const paths = resolveRunPaths(runId, missionId);

  // Drain inbox before loading — parity with Python SignalBus.query()
  drainSignalsInbox(paths.runDir, runId, missionId);

  const floor = SEVERITY_ORDER[params.min_severity ?? "low"] ?? 0;

  const out = loadSignals(paths.signalsPath).filter((s) => {
    if (SEVERITY_ORDER[s.severity] < floor) return false;
    if (params.kind !== undefined && s.kind !== params.kind) return false;
    if (
      params.since_tick !== undefined &&
      (s.tick === null || s.tick === undefined || s.tick < params.since_tick)
    )
      return false;
    if (params.shapes && params.shapes.length > 0) {
      if (!params.shapes.some((sh) => (s.shapes as string[]).includes(sh))) return false;
    }
    if (params.axes && params.axes.length > 0) {
      if (!params.axes.some((ax) => (s.axes as string[]).includes(ax))) return false;
    }
    return true;
  });

  out.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (sevDiff !== 0) return sevDiff;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.last_seen.localeCompare(a.last_seen);
  });

  // P2-13: cap to prevent agents from pulling the full bus in one call
  const cap = params.limit ?? 100;
  return out.slice(0, cap);
}

export interface DigestParams {
  shapes?: string[];
  axes?: string[];
  min_severity?: string;
  max_items?: number;
}

/**
 * Return a compact top-slice of the signal bus for spawn-prompt injection.
 *
 * Mirrors Python SignalBus.digest(): defaults to severity>=medium so
 * low-noise signals never flood a spawn digest. Drains inbox via querySignals.
 */
export function digestSignals(
  runId: string,
  params: DigestParams,
  missionId?: string,
): Array<Record<string, unknown>> {
  const rows = querySignals(
    runId,
    {
      shapes: params.shapes,
      axes: params.axes,
      min_severity: params.min_severity ?? "medium",
    },
    missionId,
  ).slice(0, params.max_items ?? 8);

  return rows.map((s) => ({
    kind: s.kind,
    shapes: s.shapes,
    axes: s.axes,
    severity: s.severity,
    occurrences: s.occurrences,
    evidence: s.evidence,
  }));
}

// ── Tool registrations ───────────────────────────────────────────────────────

export function registerSignalTools(server: McpServer): void {
  // ── evor_signal_emit ────────────────────────────────────────────────────────
  server.tool(
    "evor_signal_emit",
    "Emit (upsert/dedup by signature) a Signal onto the run's signal bus at <run_dir>/signals.jsonl. " +
    "Repeat emits with the same signature aggregate: occurrences+1, confidence raised toward 1.0, severity escalates to MAX seen.",
    {
      run_id: z.string().describe("Active run identifier"),
      mission_id: z.string().optional().describe("Mission identifier (resolved automatically when omitted)"),
      kind: z.string().describe("Free-text signal type (e.g. 'cuda-oom', 'training-too-slow')"),
      signature: z.string().describe("Dedup key — identical signatures aggregate"),
      shapes: z
        .array(SignalShapeSchema)
        .min(1)
        .describe("Closed facet set: limit | opportunity | failure | trend"),
      axes: z
        .array(SignalAxisSchema)
        .describe("Closed facet set: memory | compute | accuracy | stability | data | generalization | cost"),
      severity: SignalSeveritySchema.describe("low | medium | high | critical"),
      evidence: z.record(z.string(), z.unknown()).describe("Structured evidence dict"),
      source: z.string().describe("Emitting role (e.g. 'evor-forge-analyst')"),
      tick: z.number().int().optional().describe("Optional evolution tick"),
      node_id: z.string().optional().describe("Optional associated node id"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Initial confidence for new signals (0.0–1.0). Default 0.5. Ignored on dedup-aggregate."),
    },
    async ({ run_id, mission_id, kind, signature, shapes, axes, severity, evidence, source, tick, node_id, confidence }) => {
      const missionId = mission_id ?? process.env.EVOR_MISSION_ID;
      const signal = emitSignal(
        run_id,
        { kind, signature, shapes, axes, severity, evidence, source, tick, node_id, confidence },
        missionId,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(signal) }],
      };
    },
  );

  // ── evor_signal_query ───────────────────────────────────────────────────────
  server.tool(
    "evor_signal_query",
    "Pull signals from the run's signal bus filtered by facet lens (ANY-overlap), severity floor, optional kind, and optional since_tick. " +
    "Drains signals-inbox.jsonl first so hook-captured signals are always visible. " +
    "Returns list sorted by (severity, confidence, last_seen) descending.",
    {
      run_id: z.string().describe("Active run identifier"),
      mission_id: z.string().optional().describe("Mission identifier (resolved automatically when omitted)"),
      shapes: z
        .array(SignalShapeSchema)
        .optional()
        .describe("ANY-overlap shape filter; omit to match all shapes"),
      axes: z
        .array(SignalAxisSchema)
        .optional()
        .describe("ANY-overlap axis filter; omit to match all axes"),
      kind: z.string().optional().describe("Exact kind filter; omit for all kinds"),
      min_severity: SignalSeveritySchema.default("low").describe("Severity floor (inclusive). Default: low"),
      since_tick: z.number().int().optional().describe("Only include signals with tick >= this value"),
      limit: z.number().int().min(1).max(500).optional().describe(
        "Cap on returned signals sorted by (severity, confidence, recency) desc. Default 100. "
        + "Use a smaller value (e.g. 10) for spawn-prompt injection to avoid context bloat.",
      ),
    },
    async ({ run_id, mission_id, shapes, axes, kind, min_severity, since_tick, limit }) => {
      const missionId = mission_id ?? process.env.EVOR_MISSION_ID;
      const signals = querySignals(
        run_id,
        { shapes, axes, kind, min_severity, since_tick, limit },
        missionId,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(signals) }],
      };
    },
  );

  // ── evor_signal_digest ──────────────────────────────────────────────────────
  server.tool(
    "evor_signal_digest",
    "Return a compact top-slice of the signal bus for spawn-prompt injection. " +
    "Defaults to severity>=medium so low-noise signals never flood a digest. " +
    "Equivalent to Python SignalBus.digest(). Drains inbox first.",
    {
      run_id: z.string().describe("Active run identifier"),
      mission_id: z.string().optional().describe("Mission identifier (resolved automatically when omitted)"),
      shapes: z
        .array(SignalShapeSchema)
        .optional()
        .describe("ANY-overlap shape filter; omit to match all shapes"),
      axes: z
        .array(SignalAxisSchema)
        .optional()
        .describe("ANY-overlap axis filter; omit to match all axes"),
      min_severity: SignalSeveritySchema.default("medium").describe(
        "Severity floor (inclusive). Default: medium (low kept out of digests by default)",
      ),
      max_items: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(8)
        .describe("Maximum signals to return (default 8)"),
    },
    async ({ run_id, mission_id, shapes, axes, min_severity, max_items }) => {
      const missionId = mission_id ?? process.env.EVOR_MISSION_ID;
      const digest = digestSignals(run_id, { shapes, axes, min_severity, max_items }, missionId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ run_id, digest }) }],
      };
    },
  );
}
