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

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('permission-denied')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
if (!(process.env.EVOR_ACTIVE_RUN_ID ?? '')) process.exit(0);

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
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
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

// ── Emit blocked notification ─────────────────────────────────────────────────
const shortTool = toolName.replace(/^mcp__plugin_oh-my-evor_evor__/, 'evor_');
const isEvorTool = /evor_/.test(shortTool);

const additionalContext = isEvorTool
  ? `[EVOR BLOCKED] "${shortTool}" was denied${denyReason ? ` (${denyReason.slice(0, 120)})` : ''}. ` +
    `This may halt the active run. Call PushNotification to alert the user so they can grant permission or unblock the mission.`
  : `[EVOR BLOCKED] "${shortTool}" was denied${denyReason ? ` (${denyReason.slice(0, 120)})` : ''}. ` +
    `If this tool is required for the active run, call PushNotification to alert the user.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionDenied',
      additionalContext,
    },
  }) + '\n'
);

process.exit(0);
