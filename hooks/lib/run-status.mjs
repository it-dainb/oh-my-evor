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
