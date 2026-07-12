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

// Resolve missionId for the canonical nested path (runs/<mission>/<runId>/).
// Priority: EVOR_MISSION_ID env → active-run.json → directory scan.
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

/** Derive the run's directory from a run ID (nested layout only). */
function runDir(runId) {
  return join(evorRoot, 'runs', missionId, runId);
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
  // toolInput.payload — evor_write_artifact agents embed <evor-remember> here
  if (typeof toolInput?.payload === 'string') surfaces.push(toolInput.payload);
  else if (toolInput?.payload && typeof toolInput.payload === 'object') {
    surfaces.push(JSON.stringify(toolInput.payload));
  }
  // toolInput.text — secondary fallback surface
  if (typeof toolInput?.text === 'string') surfaces.push(toolInput.text);
  // tool_response may be a string OR an object ({stdout, stderr, content})
  // OR a top-level MCP content array [{type:"text", text:"..."}]
  const tr = input?.tool_response;
  if (Array.isArray(tr)) {
    // Top-level MCP content array format
    for (const part of tr) {
      if (part && typeof part.text === 'string') surfaces.push(part.text);
    }
  } else if (typeof tr === 'string') {
    surfaces.push(tr);
  } else if (tr && typeof tr === 'object') {
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

// ── §9 Reflex advisor — workflow nudges after key evor tool calls ─────────────
// FIRST: REFLEX_TOOLS early-exit — skip ~95% of tool calls with zero work.
// Only tools in this set ever produce a nudge. (§15E perf note)
const REFLEX_TOOLS = new Set([
  // Canonical MCP tool names (full prefix)
  'mcp__plugin_oh-my-evor_evor__run_start',
  'mcp__plugin_oh-my-evor_evor__run_status',
  'mcp__plugin_oh-my-evor_evor__record_node',
  'mcp__plugin_oh-my-evor_evor__record_eval',
  'mcp__plugin_oh-my-evor_evor__integrity_check',
  'mcp__plugin_oh-my-evor_evor__init_run',
  'mcp__plugin_oh-my-evor_evor__write_artifact',
  'mcp__plugin_oh-my-evor_evor__read_artifact',
  'mcp__plugin_oh-my-evor_evor__select',
  'mcp__plugin_oh-my-evor_evor__cite',
  // Short-form fallback (tool name without MCP prefix, used in tests + dev)
  'evor_run_start', 'evor_run_status', 'evor_record_node', 'evor_record_eval',
  'evor_integrity_check', 'evor_init_run', 'evor_write_artifact',
  'evor_read_artifact', 'evor_select', 'evor_cite',
]);

if (!REFLEX_TOOLS.has(toolName)) process.exit(0); // fast path — no nudge for this tool

try {
  // ── Throttle: per (agent_type, bare_tool, nudgeKey, tick) ──────────────────
  // Each (role, tool, nudge, tick) fires at most once — high signal, no spam.
  const { join: pathJoin, dirname: pathDirname } = await import('path');
  const { existsSync: fsExists, readFileSync: fsRead, writeFileSync: fsWrite,
          mkdirSync: fsMkdir, renameSync: fsRename } = await import('fs');
  const { randomBytes: rndBytes } = await import('crypto');

  const agentTypeR = String(input?.agent_type ?? '').replace(/^oh-my-evor:/, '');
  const bareToolR  = toolName.replace(/^mcp__plugin_oh-my-evor_evor__/, '').replace(/^evor_/, '');
  const toolResp   = input?.tool_response ?? {};
  const toolInpR   = input?.tool_input ?? {};

  // Resolve current tick: env → tick-state.json → fallback 0
  let currentTick = 0;
  const envTick = process.env.EVOR_CURRENT_TICK;
  if (envTick && !isNaN(parseInt(envTick, 10))) {
    currentTick = parseInt(envTick, 10);
  } else {
    try {
      const tsPath = pathJoin(runDir(activeRunId), 'tick-state.json');
      if (fsExists(tsPath)) {
        const ts = JSON.parse(fsRead(tsPath, 'utf8'));
        if (typeof ts?.tick === 'number') currentTick = ts.tick;
      }
    } catch { /* fallback to 0 */ }
  }

  // Throttle file is stored in the run dir (session+run scoped)
  const throttleDir = runDir(activeRunId);
  const throttlePath = pathJoin(throttleDir, 'post-advisory-throttle.json');

  function isThrottled(nudgeKey) {
    try {
      const data = JSON.parse(fsRead(throttlePath, 'utf8'));
      const key = `${agentTypeR}:${bareToolR}:${nudgeKey}:tick${currentTick}`;
      return !!data.entries?.[key];
    } catch { return false; }
  }

  function markThrottled(nudgeKey) {
    try {
      let data = { version: 1, entries: {} };
      try { data = JSON.parse(fsRead(throttlePath, 'utf8')); } catch {}
      data.entries = data.entries ?? {};
      const key = `${agentTypeR}:${bareToolR}:${nudgeKey}:tick${currentTick}`;
      data.entries[key] = { last_ms: Date.now() };
      // Prune stale entries (> 48 h) to keep file bounded
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      for (const k of Object.keys(data.entries)) {
        if ((data.entries[k].last_ms ?? 0) < cutoff) delete data.entries[k];
      }
      data.updated_at = new Date().toISOString();
      fsMkdir(throttleDir, { recursive: true });
      const tmp = throttlePath + '.tmp.' + rndBytes(4).toString('hex');
      fsWrite(tmp, JSON.stringify(data, null, 2));
      fsRename(tmp, throttlePath);
    } catch { /* throttle write failure is non-fatal */ }
  }

  // ── Extract tool response state ───────────────────────────────────────────
  // Handles both object responses and raw string responses
  function respStr() {
    if (typeof toolResp === 'string') return toolResp;
    return JSON.stringify(toolResp ?? '{}');
  }

  const respState = String(
    toolResp?.state ?? toolResp?.status ?? toolResp?.verdict ?? ''
  ).toLowerCase();

  // ── evor_write_artifact — validate landed file + role-continuity nudge ────
  if (bareToolR === 'write_artifact') {
    const agentSlot = String(toolInpR?.agent ?? '');
    const runId2    = String(toolInpR?.run_id ?? activeRunId);
    const tick2     = typeof toolInpR?.tick === 'number' ? toolInpR.tick : currentTick;

    // Validate the artifact landed on disk (mirror record_eval/node validation)
    const SLOT_PATHS = {
      mutagen:          `ticks/${tick2}/mutagen/proposals.json`,
      selector:         `ticks/${tick2}/selector/verdict.json`,
      probe:            `ticks/${tick2}/probe/findings.json`,
      sage:             `ticks/${tick2}/sage/findings.json`,
      forge:            `ticks/${tick2}/forge/forge-report.json`,
      'forge-architect': `ticks/${tick2}/forge/architect.json`,
      'forge-critic':    `ticks/${tick2}/forge/critic.json`,
      'forge-analyst':   `ticks/${tick2}/forge/analyst.json`,
    };
    const relPath = SLOT_PATHS[agentSlot];
    if (relPath) {
      const artPath = pathJoin(runDir(runId2), relPath);
      if (!fsExists(artPath)) {
        process.stdout.write(
          `[EVOR WARNING] artifact for agent='${agentSlot}' not confirmed — the write may not have completed\n`
        );
      }
    }

    // Role-continuity nudge (once per tick per role)
    const ROLE_NEXT = {
      mutagen:  { key: 'write_artifact:mutagen:return', msg: 'Proposals recorded. Return — the orchestrator routes to evor-selector for verdict.' },
      selector: { key: 'write_artifact:selector:return', msg: 'Verdict recorded. Return — the orchestrator routes to evor-forge for the winning proposal.' },
      sage:     { key: 'write_artifact:sage:wiki', msg: 'Findings recorded. Call evor_wiki_add to persist durable lessons before returning.' },
      probe:    { key: 'write_artifact:probe:return', msg: 'Probe findings recorded. Return — the orchestrator evaluates them.' },
    };
    const roleNext = ROLE_NEXT[agentSlot];
    if (roleNext && !isThrottled(roleNext.key)) {
      markThrottled(roleNext.key);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `[EVOR REFLEX] ${roleNext.msg}` },
        }) + '\n'
      );
    }
    process.exit(0);
  }

  // ── evor_read_artifact — not-found safety rail ────────────────────────────
  if (bareToolR === 'read_artifact') {
    const isNotFound =
      toolResp?.error === 'not found' ||
      respStr().includes('"not found"') ||
      respStr().includes('not found');
    if (isNotFound && !isThrottled('read_artifact:not_found')) {
      markThrottled('read_artifact:not_found');
      const upstreamAgent = String(toolInpR?.agent ?? 'upstream');
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext:
              `[EVOR REFLEX] evor_read_artifact returned "not found" for agent="${upstreamAgent}". ` +
              `That step has not produced output — do NOT fabricate or proceed on assumptions. ` +
              `Surface the dependency gap to the orchestrator.`,
          },
        }) + '\n'
      );
    }
    process.exit(0);
  }

  // ── evor_run_start — FLAGSHIP nudge ───────────────────────────────────────
  if (bareToolR === 'run_start') {
    if (!isThrottled('run_start:launched')) {
      markThrottled('run_start:launched');
      const nudge =
        `[EVOR REFLEX] Job launched — poll with evor_run_status (no arguments needed beyond the active run). ` +
        `Do NOT block or tight-loop poll. Use the native Monitor tool to watch for progress and completion. ` +
        `When the run succeeds → call evor_record_eval; when it fails → call evor_signal_emit(kind="runtime-failure") + PushNotification.`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
        }) + '\n'
      );
    }
    process.exit(0);
  }

  // ── evor_run_status ───────────────────────────────────────────────────────
  if (bareToolR === 'run_status') {
    if (respState === 'succeeded' || respState === 'success' || respState === 'completed') {
      if (!isThrottled('run_status:succeeded')) {
        markThrottled('run_status:succeeded');
        // Prefer node name from response; fall back to name field in input. Never use a raw UUID.
        const nodeName2 = String(toolResp?.node_name ?? toolResp?.name ?? '').trim() || null;
        const score   = toolResp?.metrics?.val_score ?? toolResp?.metrics?.score ?? null;
        const scoreHint = score !== null ? ` (score: ${String(score).slice(0, 8)})` : '';
        const nudge =
          `[EVOR REFLEX] Run succeeded${scoreHint}. ` +
          `Call evor_record_eval(${nodeName2 ? `node_id="${nodeName2}"` : 'node_id=<name>'}) for the active run ` +
          `then evor_integrity_check to verify before propagating the score. ` +
          `If best_score improved, call PushNotification to alert the user of the breakthrough.`;
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
          }) + '\n'
        );
      }
    } else if (respState === 'failed' || respState === 'error' || respState === 'crashed') {
      if (!isThrottled('run_status:failed')) {
        markThrottled('run_status:failed');
        const errorReason = String(toolResp?.error ?? toolResp?.reason ?? '').slice(0, 150);
        const isOom = /oom|out.of.mem|killed/i.test(errorReason);
        const nudge =
          `[EVOR REFLEX] Run failed${errorReason ? `: ${errorReason}` : ''}. ` +
          `Call evor_signal_emit(kind="${isOom ? 'oom' : 'runtime-failure'}", severity="high") with the error. ` +
          `If this blocks the mission, call PushNotification to alert the user.`;
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
          }) + '\n'
        );
      }
    }
    // running: stay silent (watcher/Monitor handles it)
    process.exit(0);
  }

  // ── evor_record_node ─────────────────────────────────────────────────────
  if (bareToolR === 'record_node') {
    if (!isThrottled('record_node:run_start')) {
      markThrottled('record_node:run_start');
      // Name-only surface: the response carries `name`, never an internal id.
      const nodeName = String(toolResp?.name ?? toolInpR?.node?.name ?? '');
      const worktree  = String(toolInpR?.worktree ?? '');
      const nudge =
        `[EVOR REFLEX] Node recorded${nodeName ? ` (${nodeName})` : ''}. ` +
        `Launch its evaluation: call evor_run_start(node_id="${nodeName || '<name>'}"` +
        `${worktree ? `, worktree="${worktree}"` : ''}).`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
        }) + '\n'
      );
    }
    process.exit(0);
  }

  // ── evor_record_eval ──────────────────────────────────────────────────────
  if (bareToolR === 'record_eval') {
    if (!isThrottled('record_eval:integrity')) {
      markThrottled('record_eval:integrity');
      // Name-only surface: response carries `name`; do NOT fall back to node_id (may be UUID).
      const nodeName4 = String(toolResp?.name ?? toolInpR?.name ?? '').trim() || null;
      const prevBest = toolResp?.previous_best_score ?? null;
      const newScore = toolResp?.score ?? toolResp?.best_score ?? null;
      const improved = prevBest !== null && newScore !== null && newScore > prevBest;
      // P1-1: nudge full post-eval flow — integrity THEN state_write frontier update
      const nudge =
        `[EVOR REFLEX] Eval recorded${nodeName4 ? ` for ${nodeName4}` : ''}. ` +
        `Next: (1) verify evor_integrity_check(${nodeName4 ? `node_id="${nodeName4}"` : 'node_id=<name>'}); ` +
        `(2) if passed, update the frontier with evor_state_write for the active run.` +
        (improved
          ? ` New best score ${String(newScore).slice(0, 8)} > ${String(prevBest).slice(0, 8)} — ` +
            `call PushNotification to alert the user of the breakthrough.`
          : '');
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
        }) + '\n'
      );
    }
    process.exit(0);
  }

  // ── evor_integrity_check ──────────────────────────────────────────────────
  if (bareToolR === 'integrity_check') {
    const integrityPassed =
      respState === 'passed' ||
      toolResp?.verified === true ||
      respStr().includes('"passed"');
    if (!integrityPassed && !isThrottled('integrity_check:failed')) {
      markThrottled('integrity_check:failed');
      const nodeId5 = String(toolInpR?.node_id ?? toolResp?.node_id ?? '');
      const nudge =
        `[EVOR REFLEX] Integrity check failed${nodeId5 ? ` for ${nodeId5}` : ''}. ` +
        `Do NOT propagate this score — mark the node and call evor_signal_emit(kind="integrity-violation", severity="critical").`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
        }) + '\n'
      );
    } else if (integrityPassed && !isThrottled('integrity_check:passed')) {
      markThrottled('integrity_check:passed');
      const nudge =
        `[EVOR REFLEX] Integrity verified. ` +
        `Record the lesson: evor_wiki_add. Then update the frontier: evor_state_write.`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
        }) + '\n'
      );
    }
    process.exit(0);
  }

  // ── evor_init_run ─────────────────────────────────────────────────────────
  if (bareToolR === 'init_run') {
    if (!isThrottled('init_run:validate')) {
      markThrottled('init_run:validate');
      const nudge =
        `[EVOR REFLEX] Run initialized. Lock the mission: ` +
        `call evor_validate to check the config, then evor_state_write(mission_status="locked"). ` +
        `If any goal field was ambiguous, use AskUserQuestion to confirm before locking.`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
        }) + '\n'
      );
    }
    process.exit(0);
  }

  // ── evor_select ───────────────────────────────────────────────────────────
  if (bareToolR === 'select') {
    if (!isThrottled('select:spawn_forge')) {
      markThrottled('select:spawn_forge');
      // Use selected_names (name array) from new API shape; never use selected_id (may be UUID).
      const selectedNames = Array.isArray(toolResp?.selected_names) ? toolResp.selected_names : [];
      const winnerHint = selectedNames.length > 0 ? selectedNames.join(', ') : null;
      const nudge =
        `[EVOR REFLEX] Selector verdict recorded${winnerHint ? ` (winner: ${winnerHint})` : ''}. ` +
        `Spawn Forge for the winning proposal: Task(subagent_type="oh-my-evor:evor-forge").`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
        }) + '\n'
      );
    }
    process.exit(0);
  }

  // ── evor_cite ─────────────────────────────────────────────────────────────
  if (bareToolR === 'cite') {
    if (!isThrottled('cite:capture_spec')) {
      markThrottled('cite:capture_spec');
      const nudge =
        `[EVOR REFLEX] Citation captured. ` +
        `Include the implementation_spec from this citation in your findings via evor_write_artifact.`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge },
        }) + '\n'
      );
    }
    process.exit(0);
  }
} catch {
  // Fail-open — reflex advisor errors must never crash the session
}

process.exit(0);
