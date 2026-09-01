"""§1.8 — the run lock must be a property of the FORMAT, not of one language.

RC3, stated exactly: *"the lock became a TypeScript implementation detail rather
than a property of the on-disk format… There was never one owner of the on-disk
format — only of the schemas."*

``mcp/src/lock.ts`` guards ``<run_dir>/.tree.lock`` with ``O_EXCL``. Python writes
the same ``tree.json`` — ``tree.py`` bumps ``visit_count`` while the MCP server
upserts nodes — and took no lock at all, so the mutual exclusion was mutual only
among TypeScript callers. A lock that one of two writers does not participate in
is not a lock; it is a comment.

These tests run the ACTUAL TypeScript lock in a node subprocess against the
actual Python one, because a Python-only test of a Python-only lock would pass
while the cross-language property it exists for remained broken — which is how
this survived in the first place.
"""

from __future__ import annotations

import json
import subprocess
import textwrap
import time
from pathlib import Path

import pytest

from evor.runlock import LOCK_FILENAME, STALE_AFTER_S, run_lock, RunLockTimeout

LOCK_TS = Path(__file__).resolve().parents[2] / "mcp" / "src" / "lock.ts"


class TestSharedConstants:
    """The two implementations duplicate their constants; drift is silent."""

    def test_stale_threshold_matches_lock_ts(self):
        src = LOCK_TS.read_text()
        assert "10_000" in src, "lock.ts's stale threshold moved; runlock.py must move with it"
        assert STALE_AFTER_S == 10.0

    def test_lock_filename_matches_lock_ts(self):
        assert '".tree.lock"' in LOCK_TS.read_text()
        assert LOCK_FILENAME == ".tree.lock"


class TestPythonSideExclusion:
    def test_the_lock_file_exists_while_held_and_is_gone_after(self, tmp_path: Path):
        with run_lock(tmp_path):
            assert (tmp_path / LOCK_FILENAME).exists()
        assert not (tmp_path / LOCK_FILENAME).exists()

    def test_a_raising_critical_section_still_releases(self, tmp_path: Path):
        with pytest.raises(ValueError):
            with run_lock(tmp_path):
                raise ValueError("boom")
        assert not (tmp_path / LOCK_FILENAME).exists(), (
            "a lock left held by a raising section deadlocks every later writer "
            "until the staleness window expires"
        )

    def test_a_held_lock_blocks_a_second_acquirer(self, tmp_path: Path):
        with run_lock(tmp_path):
            with pytest.raises(RunLockTimeout):
                with run_lock(tmp_path):
                    pass

    def test_a_stale_lock_is_reclaimed_rather_than_deadlocking(self, tmp_path: Path):
        lock = tmp_path / LOCK_FILENAME
        lock.write_text("")
        old = time.time() - (STALE_AFTER_S + 5)
        import os

        os.utime(lock, (old, old))
        # A governance lock that can deadlock the run is worse than one that can
        # be broken after ten seconds — F6 is the shipped demonstration.
        with run_lock(tmp_path):
            pass


class TestCrossLanguageExclusion:
    """The property that was actually missing."""

    def _node_holds_lock(self, tmp_path: Path, hold_ms: int) -> subprocess.Popen:
        script = tmp_path / "hold.mjs"
        script.write_text(
            textwrap.dedent(
                f"""
                import {{ openSync, closeSync, unlinkSync }} from 'fs';
                const p = {json.dumps(str(tmp_path / LOCK_FILENAME))};
                const fd = openSync(p, 'wx');
                process.stdout.write('held\\n');
                const until = Date.now() + {hold_ms};
                while (Date.now() < until) {{}}
                closeSync(fd); unlinkSync(p);
                """
            )
        )
        proc = subprocess.Popen(
            ["node", str(script)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        assert proc.stdout is not None
        assert proc.stdout.readline().strip() == "held"
        return proc

    def test_python_waits_for_a_lock_held_by_node(self, tmp_path: Path):
        proc = self._node_holds_lock(tmp_path, hold_ms=400)
        try:
            started = time.monotonic()
            with run_lock(tmp_path):
                waited = time.monotonic() - started
            assert waited >= 0.2, (
                "Python acquired the lock while a node process held it. The two "
                "writers do not exclude each other, which is the whole defect: "
                "tree.json is read-modify-written from both."
            )
        finally:
            proc.wait(timeout=10)

    def test_python_gives_up_rather_than_blocking_forever(self, tmp_path: Path):
        proc = self._node_holds_lock(tmp_path, hold_ms=4000)
        try:
            with pytest.raises(RunLockTimeout):
                with run_lock(tmp_path):
                    pass
        finally:
            proc.wait(timeout=15)

    def test_node_is_blocked_by_a_lock_python_holds(self, tmp_path: Path):
        # The mirror image. Without it this suite would pass on a Python lock
        # that node happens to ignore.
        script = tmp_path / "try.mjs"
        script.write_text(
            textwrap.dedent(
                f"""
                import {{ openSync }} from 'fs';
                try {{
                  openSync({json.dumps(str(tmp_path / LOCK_FILENAME))}, 'wx');
                  process.stdout.write('acquired');
                }} catch (e) {{
                  process.stdout.write(e.code);
                }}
                """
            )
        )
        with run_lock(tmp_path):
            out = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=30)
        assert out.stdout.strip() == "EEXIST", (
            f"node saw {out.stdout.strip()!r} while Python held the lock"
        )
