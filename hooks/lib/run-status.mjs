import { isTerminal } from './fsm.mjs';

/**
 * hooks/lib/run-status.mjs — the one place that says what a run's liveness means.
 *
 * Plan item 1.3a, the JavaScript half. `run-state.status` has readers in three
 * languages and is written by two of them. Three consecutive plan revisions
 * enumerated those readers and three times the list came back incomplete under a
 * new grep shape — each grep correct for the shape it assumed, and each missing a
 * different one (an accessor-routed reader, then two Python sites, then two prose
 * readers). An enumeration maintained by diligence is an invariant with no writer,
 * which is this release's own §2 thesis pointed back at itself.
 *
 * So every read goes through a named function first. When the field is retired at
 * 1.9b the removal becomes an import error rather than a grep — the only version
 * of that fix whose correctness does not depend on anyone's enumeration being right.
 *
 * 1.3a is a PURE REFACTOR: behaviour identical, both suites green unchanged. The
 * temptation is to fix the default here too, because the fix is one line and the
 * function is right there. That is 1.4, and it lands separately — spending the
 * compile-error safety net on a semantic change would move behaviour in a commit
 * whose tests were expected to stay green, which is unattributable in exactly the
 * way the release's Risk 3 warns about.
 */

/**
 * The run's declared lifecycle status, or undefined when it declares none.
 * @param {Record<string, unknown> | null | undefined} runState
 * @returns {string | undefined}
 */
export function readRunStatus(runState) {
  const raw = runState?.status;
  return raw === undefined || raw === null ? undefined : String(raw);
}

/**
 * Is this run live — i.e. may a governance check still hold on its behalf?
 *
 * Every caller in `stop.mjs` asked `status === 'running'` directly. Naming the
 * question matters because `stop.mjs` is documented fail-open (`:24-25`): each of
 * those checks turns silently FALSE in the permissive direction when the field is
 * absent, and emits nothing. There are three of them, gating three of the five
 * debt checks in the drift guard.
 *
 * @param {Record<string, unknown> | null | undefined} runState
 * @returns {boolean}
 */
export function isRunLive(runState) {
  return readRunStatus(runState) === 'running';
}

/** The 9-step tick loop. One definition of where the end is. */
export const TICK_FINAL_STEP = 9;

/**
 * Is this tick finished? (Plan item 1.2 — the ONE definition.)
 *
 * The predicate was re-derived in five places across three languages, and two of
 * them disagreed in opposite directions: `stop.mjs:379` had `const finished =
 * step >= 9` while `tree.py` defaulted the other way. You cannot tune your way
 * out of two disagreeing defaults, so the plan cuts the tuning and gives the
 * predicate an owner instead.
 *
 * Three rules, and each one is load-bearing:
 *
 *   1. Reaching the last step is not finishing it. The final r3 tick sat at step
 *      9 with `step_status: "running"`, and `step >= 9` alone called that done —
 *      so the mission ended on a tick that was still in flight.
 *
 *   2. A failed integrity verdict is not a finished tick. A tick whose gate said
 *      "failed" produced no usable outcome; ending the turn there ends the
 *      mission on a failure and records it as completion.
 *
 *   3. An ABSENT `step_status` still counts as finished. This is deliberate and
 *      it is why the naive strengthening was reverted once already: requiring
 *      `step_status === "done"` blocks any run whose tick-state omits the field,
 *      and a false "not finished" traps the agent in a turn it cannot end. The
 *      hook fails toward letting the user stop, so absence is read permissively
 *      HERE while absence of run status is read conservatively in `isRunLive` —
 *      opposite defaults, because the two absences have opposite consequences.
 *
 * @param {Record<string, unknown> | null | undefined} tickState parsed tick-state.json
 * @returns {boolean}
 */
export function isTickFinished(tickState) {
  const step = typeof tickState?.current_step === 'number' ? tickState.current_step : 0;
  if (step < TICK_FINAL_STEP) return false;

  if (String(tickState?.integrity_verdict ?? '') === 'failed') return false;

  const stepStatus = tickState?.step_status;
  if (stepStatus === undefined || stepStatus === null || stepStatus === '') return true;
  return String(stepStatus) === 'done';
}

/**
 * Is this MISSION live — the question the three stop-hook gates actually ask.
 *
 * Item 1.9c. Those gates read `run-state.status === 'running'`. AF3 §4.1 retires
 * that field because it duplicated the mission's and "was wrong in all three
 * field runs", so the gates need somewhere else to point — and the mission's own
 * state is where liveness belongs, now that `evor_run_start` drives the
 * `locked -> running` edge server-side rather than asking an agent to.
 *
 * Both sources are consulted, deliberately, and this is NOT hedging:
 *
 *   - Mission state is authoritative. A mission in a terminal state is not live
 *     no matter what any run file says.
 *   - Run state remains a fallback for LEGACY trees written before 1.9b retired
 *     the key. Reading only mission-state would silently disarm three governance
 *     checks on every pre-existing run — the C5 regression the plan caught at
 *     rev 3, arriving one phase later. New runs never write the key, so the
 *     fallback is inert for them; it is load-bearing only until 1.10 has
 *     migrated the three field trees, and is safe because it can only make a
 *     guard fire, never suppress one.
 *
 * @param {Record<string, unknown> | null | undefined} missionState parsed mission-state.json
 * @param {Record<string, unknown> | null | undefined} runState parsed run-state.json
 * @returns {boolean}
 */
export function isMissionLive(missionState, runState) {
  const missionStatus = missionState?.status;
  if (missionStatus !== undefined && missionStatus !== null && missionStatus !== '') {
    if (isTerminal('mission', String(missionStatus))) return false;
    if (String(missionStatus) === 'paused') return false;
    if (String(missionStatus) === 'running') return true;
    // `locked` and `draft` are not live on their own — but a legacy run file may
    // still be the only thing that knows a tick is in flight.
  }
  return isRunLive(runState);
}
