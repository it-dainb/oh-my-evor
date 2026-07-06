#!/usr/bin/env node
/**
 * oh-my-evor PostToolUse hook — full implementation (M7a) + Phase-2 kill switches
 *
 * Kill switches (checked FIRST, before any other logic):
 *   DISABLE_EVOR=1             → exit 0 immediately
 *   EVOR_SKIP_HOOKS=post-tool-use → exit 0 immediately
 *
 * Validates that recording tool calls left the expected artifacts on disk.
 * Emits [EVOR WARNING] lines to stdout (non-blocking, exit 0) when files are
 * missing or empty so the model is informed without halting the session.
 *
 * evor_record_eval:
 *   - Checks nodes/<node_id>/results.json exists
 *   - Checks nodes/<node_id>/telemetry.jsonl exists AND has > 0 bytes
 *     NOTE: TelemetryCallback writes telemetry.jsonl directly during training;
 *     Forge calls evor_telemetry_ingest explicitly after training completes.
 *     This hook does NOT re-ingest from stdout (R11: stdout-scan path removed).
 *
 * evor_record_node:
 *   - Checks tree.json exists and was written within the last 30 seconds.
 *
 * Guard is inert (immediate exit 0) when EVOR_ACTIVE_RUN_ID is unset.
 */

import { existsSync, statSync, appendFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'node:crypto';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('post-tool-use')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
const activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
if (!activeRunId) process.exit(0); // No active evor run — nothing to validate

let input;
try {
  // Claude Code delivers the hook payload on STDIN (fd 0), not via env var.
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  input = JSON.parse(raw || process.env.CLAUDE_HOOK_INPUT || '{}');
} catch {
  // Malformed hook input — do not block; exit safely
  process.exit(0);
}

const toolName = input?.tool_name ?? '';
const toolInput = input?.tool_input ?? {};

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');

// BUG H fix: mirror run-store.ts:lookupMissionId so inboxes always land at the
// canonical nested path (runs/<mission>/<runId>/) the MCP drain expects.
// When EVOR_MISSION_ID is set in the session env use it directly; otherwise
// resolve it from disk — (1) active-run.json, then (2) directory scan — and
// fall back to the flat layout only for truly bare/legacy runs.
let missionId = process.env.EVOR_MISSION_ID ?? '';
if (!missionId) {
  try {
    const ar = JSON.parse(readFileSync(join(evorRoot, 'active-run.json'), 'utf8'));
    if (ar?.run_id === activeRunId && ar?.mission_id) missionId = String(ar.mission_id);
  } catch { /* no/invalid active-run.json — fall through to scan */ }
}
if (!missionId) {
  try {
    for (const entry of readdirSync(join(evorRoot, 'runs'), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(evorRoot, 'runs', entry.name, activeRunId))) {
        missionId = entry.name;
        break;
      }
    }
  } catch { /* runs/ dir absent or unreadable — stay flat */ }
}

/** Derive the run's directory from a run ID. */
function runDir(runId) {
  return missionId
    ? join(evorRoot, 'runs', missionId, runId)
    : join(evorRoot, 'runs', runId);
}

// BUG G fix: deterministic signature for SignalBus dedup.
// Prefer description text when present; otherwise stable-stringify the full
// evidence object (sorted keys, no undefined values).
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function signalSignature(kind, evidence) {
  const text = (evidence?.description && typeof evidence.description === 'string')
    ? evidence.description
    : stableStringify(evidence ?? {});
  return kind + ':' + createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

const warnings = [];

// ── evor_record_eval — verify results.json and telemetry.jsonl ───────────────
if (toolName === 'evor_record_eval') {
  const runId = toolInput.run_id ?? activeRunId;
  const nodeId = toolInput.node_id ?? '';

  if (nodeId) {
    const nodeDir = join(runDir(runId), 'nodes', nodeId);
    const resultsPath = join(nodeDir, 'results.json');
    const telemetryPath = join(nodeDir, 'telemetry.jsonl');

    if (!existsSync(resultsPath)) {
      warnings.push(
        `results.json missing for node ${nodeId} — evor_record_eval may not have written it`
      );
    }

    if (!existsSync(telemetryPath) || statSync(telemetryPath).size === 0) {
      warnings.push(
        `telemetry.jsonl missing or empty for node ${nodeId} — ` +
          'ensure Forge called evor_telemetry_ingest after training completed'
      );
    }
  }
}

// ── evor_record_node — verify tree.json was recently written ─────────────────
if (toolName === 'evor_record_node') {
  const runId = toolInput.run_id ?? activeRunId;
  const treePath = join(runDir(runId), 'tree.json');
  const RECENT_MS = 30_000; // 30 seconds

  if (!existsSync(treePath)) {
    warnings.push(
      `tree.json not found for run ${runId} — evor_record_node may not have written it`
    );
  } else {
    const age = Date.now() - statSync(treePath).mtimeMs;
    if (age > RECENT_MS) {
      warnings.push(
        `tree.json for run ${runId} was last written ${Math.round(age / 1000)}s ago ` +
          '(expected within 30s) — evor_record_node may not have updated the tree'
      );
    }
  }
}

if (warnings.length > 0) {
  process.stdout.write(warnings.map((w) => `[EVOR WARNING] ${w}`).join('\n') + '\n');
}

// ── <evor-remember> tag capture ───────────────────────────────────────────────
// Agents mark durable facts with <evor-remember>…</evor-remember> and hard
// constraints/failures with <evor-remember gotcha>…</evor-remember>.
// We scan text surfaces in the hook input and write matches to an inbox file
// (.evor/runs/<run-id>/remember-inbox.jsonl) for the orchestrator to process.
//
// Surfaces scanned:
//   - tool_input.content  (Write tool file body)
//   - tool_response       (string tool output, if present)
//
// Best-effort: any failure is swallowed — never block on this path.
try {
  const REMEMBER_RE = /<evor-remember(\s+gotcha)?>([\s\S]*?)<\/evor-remember>/gi;

  const surfaces = [];
  if (typeof toolInput?.content === 'string') surfaces.push(toolInput.content);
  // tool_response may be a string OR an object ({stdout, stderr, content}).
  const tr = input?.tool_response;
  if (typeof tr === 'string') surfaces.push(tr);
  else if (tr && typeof tr === 'object') {
    if (typeof tr.stdout === 'string') surfaces.push(tr.stdout);
    if (typeof tr.content === 'string') surfaces.push(tr.content);
    if (Array.isArray(tr.content)) {
      for (const part of tr.content) {
        if (part && typeof part.text === 'string') surfaces.push(part.text);
      }
    }
  }

  const entries = [];
  for (const text of surfaces) {
    let m;
    REMEMBER_RE.lastIndex = 0;
    while ((m = REMEMBER_RE.exec(text)) !== null) {
      const isGotcha = !!m[1];
      const content = m[2].trim();
      if (content) {
        entries.push({
          type: isGotcha ? 'gotcha' : 'wiki',
          content,
          run_id: activeRunId,
          mission_id: missionId || null,
          tool_name: toolName,
          created_at: new Date().toISOString(),
        });
      }
    }
  }

  if (entries.length > 0) {
    const inboxDir = runDir(activeRunId);
    mkdirSync(inboxDir, { recursive: true });
    const inboxPath = join(inboxDir, 'remember-inbox.jsonl');
    appendFileSync(inboxPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  // <evor-signal kind="..." shapes="limit,failure" axes="memory,compute" severity="high">
  //   short evidence description
  // </evor-signal>  → signals-inbox.jsonl (drained by Evor into the SignalBus, deduped).
  const SIGNAL_RE = /<evor-signal\s+([^>]*?)>([\s\S]*?)<\/evor-signal>/gi;
  const sigEntries = [];
  for (const text of surfaces) {
    let sm;
    SIGNAL_RE.lastIndex = 0;
    while ((sm = SIGNAL_RE.exec(text)) !== null) {
      const attrs = {};
      for (const am of sm[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[am[1]] = am[2];
      const desc = (sm[2] || '').trim();
      if (!attrs.kind && !desc) continue;
      const splitCsv = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean);
      const kind = attrs.kind || 'observation';
      const evidence = { description: desc };
      sigEntries.push({
        kind,
        signature: signalSignature(kind, evidence),
        shapes: splitCsv(attrs.shapes || attrs.shape),
        axes: splitCsv(attrs.axes || attrs.axis),
        severity: attrs.severity || 'medium',
        evidence,
        source: `hook:${toolName}`,
        created_at: new Date().toISOString(),
      });
    }
  }
  if (sigEntries.length > 0) {
    const inboxDir = runDir(activeRunId);
    mkdirSync(inboxDir, { recursive: true });
    appendFileSync(
      join(inboxDir, 'signals-inbox.jsonl'),
      sigEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8'
    );
  }
} catch {
  // Fail-open — evor-remember / evor-signal capture is advisory, never blocks
}

process.exit(0);
