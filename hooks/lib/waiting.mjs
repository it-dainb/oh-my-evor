/**
 * Is this stop a YIELD rather than an END?
 *
 * Claude Code re-activates an agent when a background agent it spawned reports
 * back. So an agent that ends its turn with live children has not finished — it
 * has yielded, and the CLI says so ("Waiting for 5 background agents to
 * finish"). Blocking that stop is worse than useless: the session was never
 * going to end, and the block costs a turn of context every time the agent
 * yields. Measured twice — 497 blocked stops in one run, then the drift guard
 * firing 6+ times 16 seconds into a tick for a Mutagen artifact whose owning
 * sub-agent had not been spawned yet.
 *
 * The guards are for state DEBT the agent can discharge right now: a node it
 * recorded and never evaluated, a tick it abandoned. They are not for the
 * absence of an artifact somebody else still owes.
 *
 * Two signals, either one sufficient, both fail-open:
 *
 *   1. `tick-state.json`'s `blocked` field — written by `evor_await_artifact`,
 *      which the skill already tells agents to call before they block. This is
 *      first-party and in-band: the agent SAID what it is waiting for. It is the
 *      authoritative signal and it survives the reactivation race in (2).
 *
 *   2. A live agent under the session's `subagents/` directory. Covers agents
 *      that yield without recording a wait (evor-sage fanning out to five
 *      juniors, for one). An agent is live unless its transcript ends with an
 *      assistant message that stopped for a terminal reason — and a PARKED agent
 *      looks terminal by that test, which is why a recent write also counts: the
 *      window between a child finishing and its parent waking is real, and
 *      treating it as a dead chain is the false positive this avoids.
 */

import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Terminal stop_reasons — the model finished its message rather than yielding. */
const TERMINAL = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

/** How long after a transcript write a chain still counts as live (ms). */
const RECENT_MS = 120_000;

/** Bytes to tail-read from a transcript. Enough for the last record; hooks have 5s. */
const TAIL_BYTES = 65_536;

/**
 * The `blocked` marker an agent wrote about itself, or null.
 * `{ on: "artifact:sage@tick1", since: "..." }`
 */
export function recordedWait(tickState) {
  const on = tickState?.blocked?.on;
  return typeof on === 'string' && on.trim() ? tickState.blocked : null;
}

/** Last JSON record of a .jsonl file, reading only its tail. null on any failure. */
function lastRecord(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch { /* partial first line, or noise */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** The session's subagents directory, or null. */
function subagentsDir(sessionId, transcriptPath) {
  // Preferred: sibling of the transcript the payload names.
  if (typeof transcriptPath === 'string' && transcriptPath.endsWith('.jsonl')) {
    const d = join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents');
    if (existsSync(d)) return d;
  }
  // Fallback: find the session id under any project. Session ids are unique, so
  // this does not need the cwd slug — which a hook cannot always reconstruct.
  if (!sessionId) return null;
  const projects = join(homedir(), '.claude', 'projects');
  try {
    for (const proj of readdirSync(projects)) {
      const d = join(projects, proj, sessionId, 'subagents');
      if (existsSync(d)) return d;
    }
  } catch { /* fail-open */ }
  return null;
}

/**
 * Agents spawned in this session that have not finished.
 * Returns [] when the directory cannot be read — absence of evidence, so the
 * caller falls back to the recorded-wait signal rather than to a block.
 */
export function liveSubagents(sessionId, transcriptPath, now = Date.now()) {
  const dir = subagentsDir(sessionId, transcriptPath);
  if (!dir) return [];
  const live = [];
  let files;
  try {
    files = readdirSync(dir).filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  for (const f of files) {
    const path = join(dir, f);
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }

    const rec = lastRecord(path);
    const msg = rec?.message;
    const finished = rec?.type === 'assistant' && TERMINAL.has(msg?.stop_reason);
    // A parked agent reads as finished. If its transcript moved recently, the
    // chain is still turning over and the parent has not been woken yet.
    const recent = now - mtime < RECENT_MS;
    if (finished && !recent) continue;

    let agentType = '?';
    try {
      agentType = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'))?.agentType ?? '?';
    } catch { /* name is cosmetic */ }
    live.push({ agentType, finished, recent });
  }
  return live;
}

/**
 * Children this agent spawned in the background that have not finished.
 *
 * `liveSubagents` sees the whole session, so for a sub-agent it always includes
 * the parent waiting on it. A sub-agent has yielded only when one of ITS OWN
 * children is still running: Sage fanning out to its juniors, or Forge waiting
 * on its team. The children are the async launches its own transcript records.
 */
export function liveChildren(agentTranscriptPath, now = Date.now()) {
  if (typeof agentTranscriptPath !== 'string' || !agentTranscriptPath.endsWith('.jsonl')) return [];
  let text;
  try { text = readFileSync(agentTranscriptPath, 'utf8'); } catch { return []; }
  const ids = new Set();
  for (const m of text.matchAll(/"status":"async_launched","agentId":"([\w-]+)"/g)) ids.add(m[1]);
  const dir = join(agentTranscriptPath, '..');
  const live = [];
  for (const id of ids) {
    const path = join(dir, `agent-${id}.jsonl`);
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { live.push(id); continue; }  // launched, not written yet
    const rec = lastRecord(path);
    const finished = rec?.type === 'assistant' && TERMINAL.has(rec?.message?.stop_reason);
    if (!finished || now - mtime < RECENT_MS) live.push(id);
  }
  return live;
}

/**
 * True when ending this turn is a yield: the CLI will re-activate the agent.
 * Callers must treat true as "allow the stop", unconditionally.
 */
export function isYieldingStop(payload, tickState) {
  if (recordedWait(tickState)) return true;
  return liveSubagents(payload?.session_id, payload?.transcript_path).length > 0;
}
