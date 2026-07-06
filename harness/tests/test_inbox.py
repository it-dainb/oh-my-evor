"""
Tests for harness/evor/inbox.py.

Coverage:
  drain_signals:
    test_drain_signals_empty_inbox           — returns 0 when no inbox exists
    test_drain_signals_consumes_entries      — valid entries land in signals.jsonl
    test_drain_signals_idempotent            — second drain returns 0 (inbox gone)

  drain_remember:
    test_drain_remember_empty_inbox          — returns 0 when no inbox exists
    test_drain_remember_writes_wiki_index    — index.jsonl updated after drain
    test_drain_remember_returns_count        — count matches number of entries
    test_drain_remember_idempotent           — second drain returns 0 (inbox gone)
    test_drain_remember_skips_empty_content  — blank content lines not written
    test_drain_remember_skips_corrupt_line   — malformed JSON line skipped gracefully
    test_drain_remember_gotcha_tag           — type='gotcha' entries tagged correctly

  drain_inbox dispatch:
    test_dispatch_signals                    — kind='signals' delegates to drain_signals
    test_dispatch_remember                   — kind='remember' delegates to drain_remember
    test_dispatch_unknown_kind_raises        — ValueError for unknown kind

  inbox_bridge.py (subprocess):
    test_bridge_help_exits_zero              — --help exits 0
    test_bridge_drains_signals               — end-to-end signals drain via bridge
    test_bridge_drains_remember              — end-to-end remember drain via bridge
    test_bridge_unknown_kind_errors          — invalid kind returns {error}
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evor.inbox import drain_inbox, drain_remember, drain_signals

_HARNESS_DIR = Path(__file__).resolve().parent.parent
_BRIDGE = _HARNESS_DIR.parent / "mcp" / "bridge" / "inbox_bridge.py"

_SIGNALS_INBOX = "signals-inbox.jsonl"
_REMEMBER_INBOX = "remember-inbox.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _signal_line(kind: str = "cuda-oom", signature: str = "cuda-oom-bs256") -> str:
    return json.dumps({
        "kind": kind,
        "signature": signature,
        "shapes": ["limit"],
        "axes": ["memory"],
        "severity": "high",
        "evidence": {"batch_size": 256},
        "source": "test",
        "created_at": _now_iso(),
    })


def _remember_line(content: str = "Use lr=1e-4 for stability", entry_type: str = "wiki") -> str:
    return json.dumps({
        "type": entry_type,
        "content": content,
        "run_id": "run-test-001",
        "node_id": "node-test-001",
        "created_at": _now_iso(),
    })


# ─────────────────────────────────────────────────────────────────────────────
# drain_signals
# ─────────────────────────────────────────────────────────────────────────────

class TestDrainSignals:
    def test_drain_signals_empty_inbox(self, tmp_path: Path) -> None:
        count = drain_signals(tmp_path)
        assert count == 0

    def test_drain_signals_consumes_entries(self, tmp_path: Path) -> None:
        inbox = tmp_path / _SIGNALS_INBOX
        inbox.write_text(_signal_line() + "\n")

        count = drain_signals(tmp_path)
        assert count == 1

        # Inbox should be gone after drain.
        assert not inbox.exists()
        # Signal should now be in signals.jsonl.
        assert (tmp_path / "signals.jsonl").exists()

    def test_drain_signals_idempotent(self, tmp_path: Path) -> None:
        inbox = tmp_path / _SIGNALS_INBOX
        inbox.write_text(_signal_line() + "\n")
        drain_signals(tmp_path)
        count2 = drain_signals(tmp_path)
        assert count2 == 0


# ─────────────────────────────────────────────────────────────────────────────
# drain_remember
# ─────────────────────────────────────────────────────────────────────────────

class TestDrainRemember:
    def test_drain_remember_empty_inbox(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        # run_dir layout: <evor_root>/runs/<mission>/<run_id>/
        run_dir = evor_root / "runs" / "m1" / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)
        count = drain_remember(run_dir, evor_root=evor_root)
        assert count == 0

    def test_drain_remember_writes_wiki_index(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        run_dir = evor_root / "runs" / "m1" / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)

        inbox = run_dir / _REMEMBER_INBOX
        inbox.write_text(_remember_line("lr=1e-4 is good") + "\n")

        count = drain_remember(run_dir, evor_root=evor_root)
        assert count == 1

        index = evor_root / "wiki" / "index.jsonl"
        assert index.exists()
        lines = [l for l in index.read_text().splitlines() if l.strip()]
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert "lr=1e-4 is good" in entry["observation"]

    def test_drain_remember_returns_count(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        run_dir = evor_root / "runs" / "m1" / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)

        lines = "\n".join([
            _remember_line("note one"),
            _remember_line("note two"),
            _remember_line("note three"),
        ]) + "\n"
        (run_dir / _REMEMBER_INBOX).write_text(lines)

        count = drain_remember(run_dir, evor_root=evor_root)
        assert count == 3

    def test_drain_remember_idempotent(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        run_dir = evor_root / "runs" / "m1" / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)

        (run_dir / _REMEMBER_INBOX).write_text(_remember_line("once") + "\n")
        drain_remember(run_dir, evor_root=evor_root)
        count2 = drain_remember(run_dir, evor_root=evor_root)
        assert count2 == 0

    def test_drain_remember_skips_empty_content(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        run_dir = evor_root / "runs" / "m1" / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)

        empty_entry = json.dumps({
            "type": "wiki", "content": "   ", "created_at": _now_iso()
        })
        (run_dir / _REMEMBER_INBOX).write_text(empty_entry + "\n")

        count = drain_remember(run_dir, evor_root=evor_root)
        assert count == 0

    def test_drain_remember_skips_corrupt_line(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        run_dir = evor_root / "runs" / "m1" / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)

        lines = "{not valid json}\n" + _remember_line("valid note") + "\n"
        (run_dir / _REMEMBER_INBOX).write_text(lines)

        count = drain_remember(run_dir, evor_root=evor_root)
        assert count == 1  # only the valid line

    def test_drain_remember_gotcha_tag(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        run_dir = evor_root / "runs" / "m1" / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)

        (run_dir / _REMEMBER_INBOX).write_text(
            _remember_line("OOM at batch=512 on A100", entry_type="gotcha") + "\n"
        )
        drain_remember(run_dir, evor_root=evor_root)

        index = evor_root / "wiki" / "index.jsonl"
        entry = json.loads(index.read_text().strip())
        assert "gotcha" in entry["tags"]


# ─────────────────────────────────────────────────────────────────────────────
# drain_inbox dispatch
# ─────────────────────────────────────────────────────────────────────────────

class TestDrainInboxDispatch:
    def test_dispatch_signals(self, tmp_path: Path) -> None:
        (tmp_path / _SIGNALS_INBOX).write_text(_signal_line() + "\n")
        count = drain_inbox(tmp_path, kind="signals")
        assert count == 1

    def test_dispatch_remember(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        run_dir = evor_root / "runs" / "m1" / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / _REMEMBER_INBOX).write_text(_remember_line("dispatch test") + "\n")
        count = drain_inbox(run_dir, kind="remember", evor_root=evor_root)
        assert count == 1

    def test_dispatch_unknown_kind_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="Unknown inbox kind"):
            drain_inbox(tmp_path, kind="invalid")


# ─────────────────────────────────────────────────────────────────────────────
# inbox_bridge.py (subprocess)
# ─────────────────────────────────────────────────────────────────────────────

def _run_bridge(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(_BRIDGE), *args],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(_HARNESS_DIR)},
    )


class TestInboxBridge:
    def test_bridge_help_exits_zero(self) -> None:
        result = _run_bridge("--help")
        assert result.returncode == 0

    def test_bridge_drains_signals(self, tmp_path: Path) -> None:
        (tmp_path / _SIGNALS_INBOX).write_text(_signal_line() + "\n")
        result = _run_bridge("--run-dir", str(tmp_path), "--kind", "signals")
        assert result.returncode == 0, result.stderr
        data = json.loads(result.stdout)
        assert data.get("ok") is True
        assert data.get("drained") == 1

    def test_bridge_drains_remember(self, tmp_path: Path) -> None:
        # Use a run_dir nested in evor_root for correct wiki path resolution.
        evor_root = tmp_path / ".evor"
        run_dir = evor_root / "runs" / "m1" / "r1"
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / _REMEMBER_INBOX).write_text(_remember_line("bridge note") + "\n")

        result = _run_bridge(
            "--run-dir", str(run_dir),
            "--kind", "remember",
            "--evor-root", str(evor_root),
        )
        assert result.returncode == 0, result.stderr
        data = json.loads(result.stdout)
        assert data.get("ok") is True
        assert data.get("drained") == 1

    def test_bridge_unknown_kind_errors(self, tmp_path: Path) -> None:
        result = _run_bridge("--run-dir", str(tmp_path), "--kind", "unknown")
        # argparse rejects the invalid choice before Python runs, so returncode != 0
        assert result.returncode != 0
