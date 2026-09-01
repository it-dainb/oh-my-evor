/**
 * hooks/lib/audit.mjs — the governor's audit lane (plan item 0.4).
 *
 * `pre-tool-use.mjs` was, until this file existed, a write-nothing process whose
 * only visible act was refusal. Every guard body was wrapped in
 * `try { … } catch { /* fail-open *\/ }` with an empty catch, so an internal
 * error and a clean allow were indistinguishable from outside — seven of them,
 * measured. Fail-open is the right policy for a governor; silence is not, and
 * K-14 is the finding that separates the two.
 *
 * Writing is best-effort by construction. A logger that can throw would convert
 * fail-open into fail-closed on the first read-only filesystem, so every entry
 * point here swallows its own failure and falls back to stderr, which the host
 * captures.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveEvorRoot } from './active-run.mjs';

/** @returns {string} '' when no log directory can be established */
function logDir() {
  try {
    const dir = join(resolveEvorRoot(), 'logs');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return '';
  }
}

function emit(file, record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  const dir = logDir();
  if (dir) {
    try {
      appendFileSync(join(dir, file), line);
      return;
    } catch {
      // Fall through to stderr — an unwritable log must not silence the event.
    }
  }
  try {
    process.stderr.write(line);
  } catch {
    // Nothing left to try. Never throw from the audit lane.
  }
}

/**
 * Record a caught internal error. Fail-open is preserved by the caller; this
 * only ensures the caught exception leaves a trace.
 * @param {string} where guard block identifier, e.g. 'role-rules'
 * @param {unknown} err
 */
export function logError(where, err) {
  emit('governor-errors.log', {
    kind: 'governor-error',
    where,
    error: String(err && err.stack ? err.stack : err),
  });
}

/**
 * Record a decision. `verdict` is 'deny' or 'allow'; audit entries never
 * influence the outcome.
 *
 * Hook decisions compose by a strictness floor — a `deny` from any hook cannot
 * be undone by an `allow` from another — which is what makes an audit lane
 * beside the enforcing governor safe to add rather than a second opinion that
 * could weaken the first.
 */
export function logDecision(record) {
  emit('governor.log', { kind: 'decision', ...record });
}

/**
 * Announce that enforcement is disabled. `EVOR_SKIP_HOOKS=pre-tool-use` turns
 * off the entire surface and, before this, was recorded nowhere: a run could be
 * ungoverned end to end with nothing in the trace to say so.
 */
export function logSkip(reason) {
  emit('governor.log', { kind: 'skip', reason, note: 'enforcement disabled for this call' });
  try {
    process.stderr.write(`[EVOR GOVERNOR] skip: ${reason}\n`);
  } catch {
    // stderr unavailable — the log line above is the record.
  }
}

/**
 * Emit a denial as a SIGNAL, not only as a log line (plan item 4.8).
 *
 * The field run's top governor rule fired **82 times** and produced no data. A
 * denial is the system's most reliable evidence that an agent wants something it
 * cannot have — which is either a rule that is wrong or an affordance that is
 * missing, and both are worth knowing. Emitting it into the signal bus makes it
 * a first-class observation instead of a refusal that vanishes.
 *
 * Deduped by `signature` and counted by `occurrences`, so 82 firings arrive as
 * one signal with a count rather than 82 lines nobody reads. The bus already
 * does that merge; this only has to write the inbox line, which the Python drain
 * folds in.
 *
 * Best-effort and silent on failure: a governor that cannot write a signal must
 * still govern.
 */
export function emitDenialSignal({ rule, tool, target, agentType, reason }) {
  try {
    const dir = logDir();
    if (!dir) return;
    // The signature is what dedups. It deliberately excludes the specific path
    // and the agent, so N agents hitting one rule are one signal about that rule.
    const signature = `governor-denial:${rule ?? 'unknown'}:${tool ?? 'unknown'}`;
    appendFileSync(
      join(dir, '..', 'signals-inbox.jsonl'),
      JSON.stringify({
        kind: 'capability-gap',
        signature,
        shapes: ['limit'],
        axes: ['governance'],
        severity: 'medium',
        evidence: {
          rule: rule ?? null,
          tool: tool ?? null,
          agent_type: agentType ?? null,
          // Truncated: evidence, not a transcript.
          target: target ? String(target).slice(0, 200) : null,
          reason: reason ? String(reason).slice(0, 300) : null,
        },
        source: 'pre-tool-use',
        created_at: new Date().toISOString(),
      }) + '\n'
    );
  } catch {
    // A governor that cannot write a signal must still govern.
  }
}
