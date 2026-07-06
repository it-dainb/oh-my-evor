"""
Drain the run's remember-inbox or signals-inbox atomically.

kind='signals'  → drains signals-inbox.jsonl into the SignalBus (deduped).
kind='remember' → drains remember-inbox.jsonl into CompoundingWiki notes.

Both kinds atomically rename the inbox before processing so a crash mid-drain
leaves a *.drain-tmp orphan rather than a live inbox, preventing double-processing.

Inbox line formats (written by post-tool-use.mjs):
  signals-inbox:  {kind, signature, shapes, axes, severity, evidence, source, created_at}
  remember-inbox: {type: 'wiki'|'gotcha', content, run_id?, tick?, created_at?, node_id?}
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_SIGNALS_INBOX = "signals-inbox.jsonl"
_REMEMBER_INBOX = "remember-inbox.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Signals drain ────────────────────────────────────────────────────────────

def drain_signals(run_dir: Path) -> int:
    """Drain signals-inbox.jsonl into the run's SignalBus. Returns count emitted."""
    from evor.signals import SignalBus, drain_inbox as _drain

    bus = SignalBus(Path(run_dir))
    return _drain(Path(run_dir), bus)


# ─── Remember drain ───────────────────────────────────────────────────────────

def drain_remember(run_dir: Path, evor_root: Path | None = None) -> int:
    """Drain remember-inbox.jsonl into wiki notes. Returns count written.

    Each inbox line is turned into a synthetic LessonEntry and added to the
    CompoundingWiki.  Wiki entries AND gotcha entries both become wiki notes
    (with an appropriate tag); full GotchaEntry parsing is not attempted here
    because hook captures are raw text, not structured JSON.

    The inbox is atomically renamed before reading so a crash mid-drain leaves
    a *.drain-tmp orphan; the next drain sees an empty inbox (idempotent).
    """
    inbox = Path(run_dir) / _REMEMBER_INBOX
    if not inbox.exists():
        return 0

    # Auto-derive evor_root from the canonical layout (runs/<mission>/<run_id>/).
    _evor_root = evor_root if evor_root is not None else Path(run_dir).parent.parent.parent

    # Atomically claim the inbox before processing.
    fd, tmp = tempfile.mkstemp(dir=inbox.parent, suffix=".drain-tmp")
    os.close(fd)
    try:
        os.replace(str(inbox), tmp)
    except FileNotFoundError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return 0

    emitted = 0
    try:
        from evor.contracts import LessonEntry
        from evor.wiki import CompoundingWiki

        wiki = CompoundingWiki(Path(_evor_root))

        for raw in Path(tmp).read_text().splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                entry: dict[str, Any] = json.loads(raw)
                content: str = entry.get("content") or ""
                if not content.strip():
                    continue

                entry_type = entry.get("type", "wiki")
                # Stable lesson_id based on the raw line so re-adding the same
                # note is a no-op at the wiki level (same file gets overwritten).
                lesson_id = "note-" + hashlib.sha256(raw.encode()).hexdigest()[:16]

                lesson = LessonEntry(
                    lesson_id=lesson_id,
                    node_id=entry.get("node_id") or "unknown",
                    run_id=entry.get("run_id") or "unknown",
                    mission_id=os.environ.get("EVOR_MISSION_ID") or "unknown",
                    approach_family="other",
                    hypothesis_verdict="inconclusive",
                    observation=content,
                    actionable_lesson=content,
                    citations=[],
                    tags=["evor-remember", entry_type],
                    created_at=entry.get("created_at") or _now_iso(),
                )
                wiki.add(lesson, Path(run_dir))
                emitted += 1
            except Exception:
                # Malformed lines are skipped — one bad entry never blocks the rest.
                continue
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    return emitted


# ─── Public dispatch ─────────────────────────────────────────────────────────

def drain_inbox(run_dir: Path, kind: str, evor_root: Path | None = None) -> int:
    """Drain the given inbox kind; return count drained.

    Args:
        run_dir: Path to the run directory containing the inbox files.
        kind:    'signals' (→ SignalBus) or 'remember' (→ wiki notes).
        evor_root: Optional .evor/ root override (for remember drain).

    Raises:
        ValueError: if kind is not 'signals' or 'remember'.
    """
    if kind == "signals":
        return drain_signals(Path(run_dir))
    if kind == "remember":
        return drain_remember(Path(run_dir), evor_root)
    raise ValueError(
        f"Unknown inbox kind {kind!r}. Must be 'signals' or 'remember'."
    )
