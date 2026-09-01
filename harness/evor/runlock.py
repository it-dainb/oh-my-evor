"""Cross-LANGUAGE advisory run lock — plan item 1.8.

RC3's finding, stated exactly: *"the lock became a TypeScript implementation
detail rather than a property of the on-disk format… There was never one owner of
the on-disk format — only of the schemas."*

``mcp/src/lock.ts`` guards ``<runDir>/.tree.lock`` with ``O_EXCL``. Python writes
the same files — ``tree.py`` bumps ``visit_count`` in ``tree.json`` and the
signals drain rewrites ``signals.jsonl`` — and took no lock at all, so the
mutual exclusion was mutual only among TypeScript callers. A lock one of two
writers does not participate in is not a lock; it is a comment.

This is the same file, the same mechanism and the same timings, so the two
languages genuinely exclude each other:

    path        <run_dir>/.tree.lock
    acquire     O_CREAT|O_EXCL — atomic, succeeds only if absent
    stale after 10 s by mtime, then forcibly reclaimed
    deadline    2 s, then raise

Any change to those constants must change both files together. They are
duplicated rather than shared because there is nowhere for two languages to share
a constant — which is itself AF3 §4.3's point about the format being the
authority.

OWNERSHIP RULE (the written half of item 1.8). Locks exist ONLY where a second
writer genuinely survives in another process:

  * ``tree.json``      — the training subprocess bumps visit counts while the MCP
                         server upserts nodes.
  * ``signals.jsonl``  — the Python drain rewrites it while the MCP server appends.

Everything else has one writer and takes no lock. Twelve pairwise lock retrofits
were considered and cut: a lock around a single-writer file buys nothing and
costs a stale-lock failure mode, and the plan's §3 lists exactly that as the
wrong shape of fix.
"""

from __future__ import annotations

import contextlib
import errno
import os
import time
from pathlib import Path
from typing import Iterator

LOCK_FILENAME = ".tree.lock"
STALE_AFTER_S = 10.0
"""Matches ``lock.ts``'s 10_000 ms. A holder older than this is presumed crashed."""
DEADLINE_S = 2.0
"""Matches ``lock.ts``'s 2_000 ms bounded spin."""
_SPIN_S = 0.005


class RunLockTimeout(RuntimeError):
    """Raised when the lock could not be acquired within ``DEADLINE_S``."""


@contextlib.contextmanager
def run_lock(run_dir: Path | str) -> Iterator[Path]:
    """Hold the run's exclusive advisory lock for the critical section.

    Mirrors ``withRunLock`` in ``mcp/src/lock.ts`` exactly. Released in a
    ``finally`` so a raising critical section does not leave the lock held; a
    hard crash leaves a stale file, which the next acquirer reclaims after
    ``STALE_AFTER_S``.
    """
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    lock_path = run_dir / LOCK_FILENAME

    deadline = time.monotonic() + DEADLINE_S
    fd: int | None = None

    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            break
        except OSError as exc:
            if exc.errno != errno.EEXIST:
                raise
            try:
                if time.time() - lock_path.stat().st_mtime > STALE_AFTER_S:
                    # Crashed holder. Reclaim rather than block forever — a
                    # governance lock that can deadlock the run is worse than one
                    # that can be broken after ten seconds.
                    lock_path.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                # Released between EEXIST and stat — retry immediately.
                continue
            if time.monotonic() > deadline:
                raise RunLockTimeout(
                    f"run_lock: timeout acquiring {lock_path} after {DEADLINE_S}s — "
                    "a prior process may have crashed holding the lock"
                ) from exc
            time.sleep(_SPIN_S)

    try:
        yield lock_path
    finally:
        try:
            os.close(fd)  # type: ignore[arg-type]
        except OSError:
            pass
        with contextlib.suppress(FileNotFoundError):
            lock_path.unlink()
