/**
 * hooks/lib/next-step.mjs — what main does next, said one way everywhere.
 *
 * Main runs ticks only through evor-tick agents. Several hooks tell it what to
 * do next (session start, compaction, a resume prompt, a refused stop, a denied
 * tool), and each one used to derive the answer itself. They disagreed with the
 * governor: some said "spawn evor-tick" while pre-tool-use refuses a second tick
 * agent for an unfinished tick that already has one. The owner predicate below
 * is the governor's own, so a hint and a denial can never contradict each other.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { isMissionLive, isTickFinished } from './run-status.mjs';
import { currentTickAgent } from './waiting.mjs';

/** The call main makes before ending its turn on a yield; stop.mjs requires it. */
export const HEARTBEAT_CALL = 'evor_wait({ heartbeat: true })';

function readJson(dir, name) {
  try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return {}; }
}

/**
 * The tick state and the agent that runs that tick, or owner null. An agent
 * counts as the owner only when its description names the tick in tick-state,
 * the same test pre-tool-use applies before refusing a second evor-tick.
 */
export function tickOwner(runDir, sessionId, transcriptPath) {
  const ts = runDir ? readJson(runDir, 'tick-state.json') : {};
  let owner = null;
  try { owner = typeof ts?.tick === 'number' ? currentTickAgent(sessionId, String(transcriptPath ?? ''), ts.tick) : null; } catch { owner = null; }
  return { ts, owner: owner && owner.tick !== null && owner.tick === ts?.tick ? owner : null };
}

/**
 * How main hands work to the tick: resume its agent when one exists, else spawn
 * evor-tick. A lower-case clause, for use inside a sentence.
 */
export function tickRoute(runDir, sessionId, transcriptPath) {
  const { ts, owner } = tickOwner(runDir, sessionId, transcriptPath);
  if (owner) return `resume the tick agent ${owner.id} with SendMessage({ to: "${owner.id}", message: ... })`;
  const t = Number.isInteger(ts?.tick) && ts.tick > 0 ? ts.tick : null;
  return t !== null && !isTickFinished(ts)
    ? `spawn Task(subagent_type="oh-my-evor:evor-tick") for tick ${t} (it continues from its last completed step)`
    : `spawn Task(subagent_type="oh-my-evor:evor-tick")`;
}

/**
 * Main's next step while the mission is live; '' when it is not.
 * @param {string} runDir
 * @param {string} sessionId
 * @param {string} transcriptPath
 */
export function nextStep(runDir, sessionId, transcriptPath) {
  try {
    const rs = readJson(runDir, 'run-state.json');
    if (!isMissionLive(readJson(runDir, 'mission-state.json'), rs)) return '';
    const { ts, owner } = tickOwner(runDir, sessionId, transcriptPath);
    // No tick in tick-state: the run's completed-tick count says where it stands.
    const inFlight = Number.isInteger(ts?.tick);
    const tick = inFlight ? ts.tick : (Number.isInteger(rs?.tick_count) ? rs.tick_count : 0);
    if (inFlight && tick > 0 && !isTickFinished(ts)) {
      if (owner && owner.working) {
        return `Tick ${tick} is run by agent ${owner.id}, and it or its children are still working. ` +
          `Call ${HEARTBEAT_CALL}, then end your turn; their notices wake you. To pass on a message, ` +
          `SendMessage({ to: "${owner.id}", message: ... }). Do not spawn another tick agent.`;
      }
      if (owner) {
        return `Tick ${tick} is run by agent ${owner.id} and nothing of it is running: resume it with ` +
          `SendMessage({ to: "${owner.id}", message: ... }); it continues from its last completed step.`;
      }
      return `Tick ${tick} is unfinished: spawn oh-my-evor:evor-tick for it; it continues from its last completed step.`;
    }
    return tick > 0
      ? `Tick ${tick} is finished: call evor_check_stop, then spawn oh-my-evor:evor-tick for tick ${tick + 1}.`
      : `No tick has run yet: call evor_check_stop, then spawn oh-my-evor:evor-tick for tick 1.`;
  } catch {
    return 'Call evor_check_stop, then continue through the evor-tick agent.';
  }
}
