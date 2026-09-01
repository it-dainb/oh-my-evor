#!/usr/bin/env node
/**
 * oh-my-evor PermissionDenied hook — EVOR blocked notification
 *
 * Fires when a tool call is denied (permission blocked). During an active evor
 * run, a denial can halt the mission — this hook tells the agent to alert the
 * user so they can unblock it.
 *
 * Kill switches (checked FIRST):
 *   DISABLE_EVOR=1                     → exit 0 immediately
 *   EVOR_SKIP_HOOKS=permission-denied  → exit 0 immediately
 *
 * Active-run gated: inert when EVOR_ACTIVE_RUN_ID is unset.
 * Throttle: per (tool_name, reason_hash) — fires at most once per 10 min
 *   to avoid flooding on repeated permission prompts for the same tool.
 * Fail-open: any error → exit 0.
 *
 * §19: NO `python -m evor` in any agent-facing string.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { randomBytes } from 'crypto';
import { resolveActiveRun, resolveEvorRoot } from './lib/active-run.mjs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('permission-denied')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
if (!resolveActiveRun().runId) process.exit(0);

// ── Parse STDIN payload ───────────────────────────────────────────────────────
let toolName = '';
let denyReason = '';
try {
  const raw = readFileSync(0, 'utf8');
  const payload = JSON.parse(raw || '{}');
  toolName = String(payload?.tool_name ?? payload?.tool ?? '');
  denyReason = String(payload?.reason ?? payload?.deny_reason ?? payload?.message ?? '');
} catch {
  process.exit(0); // fail-open
}

if (!toolName) process.exit(0);

// ── Throttle per (tool, reason_hash) — 10 min TTL ────────────────────────────
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
// 1.3: the evor root comes from the shared resolver, never re-derived here.
// Eleven hooks each computed `EVOR_ROOT ?? join(CLAUDE_PLUGIN_ROOT ?? cwd, '.evor')`
// for themselves, so fixing Q-01 in `resolveEvorRoot` alone would have reached
// none of them — the plugin's own `.evor/` would still have won in every one.
const evorRoot = resolveEvorRoot();
const throttlePath = join(evorRoot, 'perm-denied-throttle.json');
const THROTTLE_MS = 10 * 60 * 1000; // 10 minutes

const reasonHash = createHash('sha256')
  .update(toolName + ':' + denyReason.slice(0, 200), 'utf8')
  .digest('hex')
  .slice(0, 16);
const throttleKey = `${toolName}:${reasonHash}`;

try {
  let throttleData = { version: 1, entries: {} };
  try { throttleData = JSON.parse(readFileSync(throttlePath, 'utf8')); } catch { /* no file — fresh */ }

  const now = Date.now();
  const entry = throttleData.entries?.[throttleKey];
  if (entry && (now - (entry.last_ms ?? 0)) < THROTTLE_MS) {
    process.exit(0); // throttled — stay silent
  }

  // Record this emission
  throttleData.entries = throttleData.entries ?? {};
  throttleData.entries[throttleKey] = { last_ms: now };
  throttleData.updated_at = new Date().toISOString();

  // Atomic write
  try {
    mkdirSync(evorRoot, { recursive: true });
    const tmp = throttlePath + '.tmp.' + randomBytes(4).toString('hex');
    writeFileSync(tmp, JSON.stringify(throttleData, null, 2));
    renameSync(tmp, throttlePath);
  } catch { /* throttle write failure is non-fatal */ }
} catch {
  // Fail-open — throttle errors must never block the hook
}

// ── §4.6: the hook escalates. It does not ask the governed agent to. ─────────
//
// This used to end with "Call PushNotification to alert the user", addressed to
// the agent that had just been denied. Lane J counted what that produced across
// the whole field run: **"Escalation to the user. Zero."**
//
// Delegating escalation to the governed party is the same shape as
// `critic_approved` — asking the subject of a control to operate it. The agent
// has no incentive, is mid-task, and is being told by a refusal that it is on
// the wrong path; "and now go interrupt your operator" is the least likely thing
// it will do. Every invariant needs a writer, and the writer cannot be the party
// that benefits from not writing.
//
// So: a durable record with an occurrences count, always; and `systemMessage`,
// which reaches the USER, instead of `additionalContext`, which reaches the
// model. The 10-minute throttle still suppresses repetition in the model's
// context — that part was right — but it no longer suppresses the record.
const shortTool = toolName.replace(/^mcp__plugin_oh-my-evor_evor__/, 'evor_');
const isEvorTool = /evor_/.test(shortTool);

let occurrences = 1;
try {
  mkdirSync(join(evorRoot, 'logs'), { recursive: true });
  const ledgerPath = join(evorRoot, 'logs', 'permission-denials.json');
  let ledger = { version: 1, entries: {} };
  try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch { /* fresh */ }
  ledger.entries = ledger.entries ?? {};
  const prior = ledger.entries[throttleKey] ?? { occurrences: 0 };
  occurrences = (prior.occurrences ?? 0) + 1;
  ledger.entries[throttleKey] = {
    tool: shortTool,
    reason: denyReason.slice(0, 300),
    occurrences,
    first_seen: prior.first_seen ?? new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
  const tmp = ledgerPath + '.tmp.' + randomBytes(4).toString('hex');
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, ledgerPath);
} catch {
  // A ledger write failure must not swallow the escalation below.
}

// A denial that keeps recurring is a blocked mission, not a stray refusal. The
// field's top rule fired 82 times without anyone hearing about it once.
const persistent = occurrences >= 3;

const forUser =
  `[EVOR BLOCKED] "${shortTool}" was denied` +
  (denyReason ? ` — ${denyReason.slice(0, 160)}` : '') +
  (persistent
    ? `. This is denial #${occurrences} for the same reason; the run is likely stuck on it and needs you.`
    : isEvorTool
      ? '. This may halt the active run.'
      : '.');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionDenied',
      // To the user, by the hook.
      systemMessage: forUser,
      // To the model: what it can actually do, with no instruction to escalate.
      additionalContext:
        `[EVOR BLOCKED] "${shortTool}" was denied${denyReason ? ` (${denyReason.slice(0, 120)})` : ''}. ` +
        `The operator has been notified — do not attempt to route around this. ` +
        `If the work cannot proceed without it, record a capability-gap signal and stop.`,
    },
  }) + '\n'
);

process.exit(0);
