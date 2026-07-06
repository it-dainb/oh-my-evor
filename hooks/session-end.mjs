#!/usr/bin/env node
/**
 * oh-my-evor SessionEnd hook — mark active run paused on session exit
 *
 * When a session ends with an active evor run, writes mission_status="paused"
 * to mission-state.json so the orchestrator knows to resume cleanly next session.
 *
 * Kill switches (checked FIRST):
 *   DISABLE_EVOR=1                → exit 0 immediately
 *   EVOR_SKIP_HOOKS=session-end   → exit 0 immediately
 *
 * §17D: This is a COMMAND hook (not mcp_tool) because it reads EVOR_ACTIVE_RUN_ID
 * from env — mcp_tool hooks only support ${field} substitution from the hook
 * payload, not arbitrary $ENV_VAR.
 *
 * Fail-open: any error → exit 0. Session end must never be delayed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('session-end')) process.exit(0);

// ── Active run guard ──────────────────────────────────────────────────────────
const activeRunId = process.env.EVOR_ACTIVE_RUN_ID ?? '';
if (!activeRunId) process.exit(0);

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
const evorRoot = process.env.EVOR_ROOT ?? join(pluginRoot, '.evor');
const missionId = process.env.EVOR_MISSION_ID ?? '';

const runDir = missionId
  ? join(evorRoot, 'runs', missionId, activeRunId)
  : join(evorRoot, 'runs', activeRunId);

// ── Read current mission-state (to avoid overwriting a terminal status) ───────
const missionStatePath = join(runDir, 'mission-state.json');

try {
  let missionState = {};
  try {
    missionState = JSON.parse(readFileSync(missionStatePath, 'utf8'));
  } catch { /* missing or corrupt — start fresh */ }

  // Do not overwrite a terminal or already-paused status
  const currentStatus = String(missionState?.status ?? '');
  if (['completed', 'failed', 'paused'].includes(currentStatus)) {
    process.exit(0);
  }

  // Atomic write: update status to "paused"
  const updated = {
    ...missionState,
    status: 'paused',
    paused_at: new Date().toISOString(),
    paused_by: 'session-end-hook',
  };

  mkdirSync(runDir, { recursive: true });
  const tmp = missionStatePath + '.tmp.' + randomBytes(4).toString('hex');
  writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
  renameSync(tmp, missionStatePath);
} catch {
  // Fail-open — session end must never be delayed by a failed hook
}

process.exit(0);
