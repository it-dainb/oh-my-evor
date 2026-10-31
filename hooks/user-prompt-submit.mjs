#!/usr/bin/env node
/**
 * oh-my-evor UserPromptSubmit hook — intent routing
 *
 * Detects strict intent keywords in the user's prompt and injects a
 * context-appropriate nudge. Throttled per intent-kind to 10 minutes
 * (avoids repeated nudges on follow-up messages in the same conversation).
 *
 * Kill switches (checked FIRST):
 *   DISABLE_EVOR=1                       → exit 0 immediately
 *   EVOR_SKIP_HOOKS=user-prompt-submit   → exit 0 immediately
 *
 * Intent routes (anchored, lowercase match):
 *   "start mission" / "new mission"    → nudge /evor-setup skill + AskUserQuestion
 *   "resume" (+ "evor"/"run"/"mission")→ inject current tick state hint
 *   "run overnight" / "run unattended" → nudge evor-schedule skill
 *   brownfield: existing ML codebase   → nudge /evor-distill
 *
 * Fail-open: any error → exit 0.
 * §19: NO `python -m evor` in any agent-facing string.
 */

import { isMissionLive, isTickFinished } from './lib/run-status.mjs';
import { tickOwner, nextStep } from './lib/next-step.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { randomBytes } from 'crypto';
import { resolveActiveRun, resolveEvorRoot } from './lib/active-run.mjs';

// ── Kill switches ─────────────────────────────────────────────────────────────
if (process.env.DISABLE_EVOR) process.exit(0);

const skipHooks = (process.env.EVOR_SKIP_HOOKS ?? '').split(',').map(s => s.trim());
if (skipHooks.includes('user-prompt-submit')) process.exit(0);

// ── Parse STDIN payload ───────────────────────────────────────────────────────
let userText = '';
let payloadSessionId = '';
let payloadTranscript = '';
try {
  const raw = readFileSync(0, 'utf8');
  const payload = JSON.parse(raw || '{}');
  payloadSessionId = String(payload?.session_id ?? '');
  payloadTranscript = String(payload?.transcript_path ?? '');
  // UserPromptSubmit payload typically has `prompt` or `content`
  userText = String(
    payload?.prompt ??
    payload?.content ??
    payload?.user_message ??
    ''
  ).toLowerCase();
} catch {
  process.exit(0); // fail-open
}

if (!userText.trim()) process.exit(0);
// A background task's completion notice arrives through this hook too. It is not
// a person's intent: its words ("finished", "resume", "tick") matched the resume
// nudge and steered main into a blocking wait on an agent that was still running.
// The notice is not always first: it can follow other text, or arrive wrapped in a
// system-reminder. Any <task-notification> element, or a prompt that is nothing
// but a system-reminder, is the host speaking, not a person.
if (/<task-notification\b/.test(userText)) process.exit(0);
if (/^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(userText)) process.exit(0);

// A person's message during a tick is for the tick. Its agent id is the
// SendMessage address; main may no longer have it in context.
let tickNudge = '';
try {
  const ar = resolveActiveRun();
  const er = resolveEvorRoot();
  const rd = ar.runId ? (ar.missionId ? join(er, 'runs', ar.missionId, ar.runId) : join(er, 'runs', ar.runId)) : null;
  const rj = (n) => { try { return JSON.parse(readFileSync(join(rd, n), 'utf8')); } catch { return {}; } };
  if (rd && existsSync(rd) && isMissionLive(rj('mission-state.json'), rj('run-state.json'))) {
    const { ts, owner } = tickOwner(rd, payloadSessionId, payloadTranscript);
    if (owner && !isTickFinished(ts)) {
      tickNudge =
        `[EVOR TICK] Tick ${ts.tick} is run by agent ${owner.id}. To pass this message to the ` +
        `tick, SendMessage({ to: "${owner.id}", message: ... }); it relays to its children.`;
    }
  }
} catch { /* the hint is optional */ }

// ── Intent detection (strict anchored keywords) ───────────────────────────────
// Only fire on clear, unambiguous intent signals to avoid false positives.
const intents = {
  'start-mission':
    /\b(start\s+(?:a\s+)?(?:new\s+)?mission|new\s+(?:evor\s+)?mission|begin\s+(?:a\s+)?mission)\b/.test(userText),

  'resume-run':
    /\bresume\b/.test(userText) &&
    /\b(evor|run|mission|tick|training)\b/.test(userText),

  'schedule-overnight':
    /\b(run\s+overnight|run\s+unattended|run\s+while\s+(?:i'?m?\s+)?(?:away|asleep|offline)|unattended\s+run|overnight\s+(?:run|training))\b/.test(userText),

  'brownfield':
    /\b(import\s+(?:my|this|existing)\s+(?:project|model|codebase|repo)|distill|existing\s+(?:ml|model|training)\s+(?:project|codebase|code))\b/.test(userText),
};

const matched = Object.entries(intents).filter(([, v]) => v).map(([k]) => k);
if (matched.length === 0 && !tickNudge) process.exit(0);

// ── Throttle per intent — 10 min ─────────────────────────────────────────────
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
// 1.3: the evor root comes from the shared resolver, never re-derived here.
// Eleven hooks each computed `EVOR_ROOT ?? join(CLAUDE_PLUGIN_ROOT ?? cwd, '.evor')`
// for themselves, so fixing Q-01 in `resolveEvorRoot` alone would have reached
// none of them — the plugin's own `.evor/` would still have won in every one.
const evorRoot = resolveEvorRoot();
const throttlePath = join(evorRoot, 'user-prompt-throttle.json');
const THROTTLE_MS = 10 * 60 * 1000;

let throttleData = { version: 1, entries: {} };
try { throttleData = JSON.parse(readFileSync(throttlePath, 'utf8')); } catch { /* fresh */ }

const now = Date.now();
const unthrottled = matched.filter(intent => {
  const entry = throttleData.entries?.[intent];
  return !entry || (now - (entry.last_ms ?? 0)) >= THROTTLE_MS;
});

if (unthrottled.length === 0 && !tickNudge) process.exit(0);

// Update throttle state
try {
  throttleData.entries = throttleData.entries ?? {};
  for (const intent of unthrottled) {
    throttleData.entries[intent] = { last_ms: now };
  }
  throttleData.updated_at = new Date().toISOString();
  mkdirSync(evorRoot, { recursive: true });
  const tmp = throttlePath + '.tmp.' + randomBytes(4).toString('hex');
  writeFileSync(tmp, JSON.stringify(throttleData, null, 2));
  renameSync(tmp, throttlePath);
} catch { /* throttle write failure is non-fatal */ }

// ── Active run state (for resume hint) ───────────────────────────────────────
const activeRunId = resolveActiveRun().runId;
const runDir = (() => {
  if (!activeRunId) return null;
  const mId = resolveActiveRun().missionId;
  return mId
    ? join(evorRoot, 'runs', mId, activeRunId)
    : join(evorRoot, 'runs', activeRunId);
})();

function safeRead(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

// ── Build nudge per matched intent ────────────────────────────────────────────
const nudges = [];

if (unthrottled.includes('start-mission')) {
  nudges.push(
    '[EVOR SETUP] To start a new evolution mission: invoke the /oh-my-evor:evor-setup skill. ' +
    'It will guide you through goal, metric, budget, and autonomy settings via AskUserQuestion. ' +
    'Then call evor_init_run to initialize the run.'
  );
}

// No active run, nothing to resume. The hint fired in a directory with no .evor
// at all and sent an unrelated session looking for a run id.
if (unthrottled.includes('resume-run') && runDir && existsSync(runDir)) {
  let tickHint = '';
  if (runDir && existsSync(runDir)) {
    const ts = safeRead(join(runDir, 'tick-state.json'));
    const rs = safeRead(join(runDir, 'run-state.json'));
    const tick = ts?.tick ?? rs?.tick_count ?? null;
    const step = ts?.current_step ?? null;
    if (tick !== null) {
      tickHint = ` Active run is at tick ${tick}${step !== null ? ` step ${step}` : ''}.`;
    }
  }
  // While the mission RUNS, the governor denies main evor_state_read and
  // evor_tree_read: they belong to the tick boundary. This hint used to prescribe
  // exactly those two calls, so every resume prompt began with two denials.
  const live = runDir && existsSync(runDir)
    ? isMissionLive(safeRead(join(runDir, 'mission-state.json')), safeRead(join(runDir, 'run-state.json')))
    : false;
  nudges.push(
    live
      ? `[EVOR RESUME]${tickHint} The mission is running, so resume through the tick boundary. ` +
        nextStep(runDir, payloadSessionId, payloadTranscript) + ' Progress for the user comes ' +
        'from evor_check_stop. Do not call evor_state_read or evor_tree_read here; the governor ' +
        'denies them to main while the mission runs.'
      : `[EVOR RESUME]${tickHint} ` +
        'Call evor_state_read to check current position, then call evor_tree_read to see the frontier. ' +
        'If a tick is mid-flight (step < 9), continue from the last completed step.'
  );
}

if (unthrottled.includes('schedule-overnight')) {
  nudges.push(
    '[EVOR SCHEDULE] For unattended overnight runs: invoke the /oh-my-evor:evor-schedule skill. ' +
    'It will set execution_mode=scheduled and configure CronCreate/ScheduleWakeup for periodic ' +
    'check-ins so the session can sleep between ticks. ' +
    'Use PushNotification to alert you when milestones or failures occur.'
  );
}

if (unthrottled.includes('brownfield')) {
  nudges.push(
    '[EVOR IMPORT] To import an existing ML project as a starting point: ' +
    'invoke the /oh-my-evor:evor-distill skill. It scans the codebase and calls ' +
    'evor_distill_scan to create a starting-point.json, then you can run /oh-my-evor:evor-setup ' +
    'to configure the mission goal.'
  );
}

if (tickNudge) nudges.push(tickNudge);
if (nudges.length === 0) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: nudges.join('\n\n'),
    },
  }) + '\n'
);

process.exit(0);
