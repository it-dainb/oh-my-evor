/**
 * lock.ts — synchronous cross-process advisory lock via O_EXCL file creation
 *
 * `withRunLock(runDir, fn)` serialises the read-modify-write critical section
 * in both upsertNode (tree-store.ts) and emitSignal (tools/signals.ts), preventing
 * the concurrent-clobber lost-update that caused "node went missing from tree.json".
 *
 * Mechanism: `openSync(lockPath, 'wx')` is atomic O_EXCL — it succeeds only when
 * the file does not yet exist, giving a cross-process mutex with no external daemon.
 * The fd is kept open through the critical section and released in a finally block
 * (closeSync + unlink), so a crash during the critical section leaves a stale lock
 * that is auto-reclaimed after STALE_LOCK_MS.
 */

import { existsSync, mkdirSync, openSync, statSync, unlinkSync, closeSync } from "fs";
import { join } from "path";

/**
 * Run `fn` inside an exclusive per-run lock at `<runDir>/.tree.lock`.
 *
 * Acquisition uses a bounded 2-second busy-spin via `openSync('wx')` (O_EXCL).
 * A lock older than 10 s is considered stale (crashed holder) and forcibly reclaimed.
 * The fd is kept open through `fn` so the OS tie keeps ownership unambiguous;
 * it is closed and the file unlinked in the finally block.
 *
 * @param runDir  The run directory (e.g. `.evor/runs/<mission>/<run-id>`)
 * @param fn      The critical section to execute under the lock
 * @returns       The return value of `fn`
 */
export function withRunLock<T>(runDir: string, fn: () => T): T {
  const lockPath = join(runDir, ".tree.lock");

  // Ensure the run directory exists before attempting O_EXCL creation.
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

  const DEADLINE = Date.now() + 2_000; // bounded 2-second spin
  let fd: number | undefined;

  while (true) {
    try {
      fd = openSync(lockPath, "wx"); // O_EXCL: atomic, succeeds only if file absent
      break; // lock acquired — fd stays open through critical section
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Lock file exists — check if it is stale (crashed holder)
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
          unlinkSync(lockPath); // forcibly reclaim stale lock
          continue;
        }
      } catch {
        // Lock disappeared between EEXIST and statSync — retry immediately
        continue;
      }
      if (Date.now() > DEADLINE) {
        throw new Error(
          `withRunLock: timeout acquiring ${lockPath} after 2s — a prior process may have crashed holding the lock`,
        );
      }
      // Tiny synchronous busy-wait; the critical section is a single small JSON
      // read+write, so contention windows are sub-millisecond in practice.
      const spinUntil = Date.now() + 5;
      while (Date.now() < spinUntil) { /* busy-poll */ }
    }
  }

  try {
    return fn();
  } finally {
    try { closeSync(fd as number); } catch { /* fd already invalid — harmless */ }
    try { unlinkSync(lockPath); } catch { /* already removed — harmless */ }
  }
}
