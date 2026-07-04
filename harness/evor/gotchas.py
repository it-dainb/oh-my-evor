"""
GotchaStore — durable, queryable knowledge layer for failures and hardware limits.

Layout on disk:
  .evor/wiki/gotchas/
    global.jsonl            — global-scoped gotchas (cross-mission, cross-run)

  <run_dir>/gotchas/
    mission.jsonl           — mission-scoped gotchas (current run only)

add_gotcha():
    Dedup by (signature, scope). If a matching gotcha already exists,
    increment occurrences, bump last_seen, raise confidence (capped at 1.0).
    Otherwise insert. Atomic write via temp-file + rename.

query_gotchas():
    Filter by kind, scope, context_filter keys, and min_confidence.
    Reads from global store (always) and mission store (when mission_run_dir set).

Global gotchas persist across missions so a later mission on the same machine
benefits from prior OOM/NaN/dep failures; mission-scoped gotchas live only in
the run that produced them.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from evor.contracts import GotchaEntry


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _gotcha_id(kind: str, signature: str, scope: str) -> str:
    """Deterministic ID based on (kind, signature, scope)."""
    raw = f"{kind}:{signature}:{scope}"
    h = hashlib.sha256(raw.encode()).hexdigest()[:12]
    return f"gotcha-{h}"


def _atomic_write_jsonl(path: Path, lines: list[str]) -> None:
    """Overwrite path with lines atomically via temp-file + rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            for line in lines:
                fh.write(line + "\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _load_jsonl(path: Path) -> list[GotchaEntry]:
    """Load all valid GotchaEntry records from a .jsonl file."""
    if not path.exists():
        return []
    entries: list[GotchaEntry] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(GotchaEntry.model_validate_json(line))
        except Exception:
            continue
    return entries


class GotchaStore:
    """Append/dedup store for GotchaEntry records.

    Parameters
    ----------
    evor_root:
        The ``.evor/`` root directory.  Global gotchas live at
        ``evor_root/wiki/gotchas/global.jsonl``.
    mission_run_dir:
        Optional run directory for this mission.  Mission-scoped gotchas live
        at ``mission_run_dir/gotchas/mission.jsonl``.
    """

    def __init__(
        self,
        evor_root: Path,
        mission_run_dir: Optional[Path] = None,
    ) -> None:
        self._evor_root = Path(evor_root)
        self._global_path = self._evor_root / "wiki" / "gotchas" / "global.jsonl"
        self._mission_run_dir = Path(mission_run_dir) if mission_run_dir else None
        self._mission_path = (
            Path(mission_run_dir) / "gotchas" / "mission.jsonl"
            if mission_run_dir
            else None
        )

    # ── Public API ─────────────────────────────────────────────────────────────

    def add_gotcha(self, entry: GotchaEntry) -> GotchaEntry:
        """Persist or update a gotcha entry.

        Dedup by (signature, scope):
        - If found: increment occurrences, bump last_seen, raise confidence.
        - If not found: insert as new.

        Returns the final (possibly updated) entry.
        """
        path = self._path_for_scope(entry.scope)
        existing = _load_jsonl(path)

        # Dedup lookup
        match_idx: Optional[int] = None
        for i, e in enumerate(existing):
            if e.signature == entry.signature and e.scope == entry.scope:
                match_idx = i
                break

        if match_idx is not None:
            old = existing[match_idx]
            # Raise confidence toward 1.0 by halving the gap each time
            new_conf = min(1.0, old.confidence + (1.0 - old.confidence) * 0.4)
            updated = GotchaEntry(
                gotcha_id=old.gotcha_id,
                kind=old.kind,
                signature=old.signature,
                context={**old.context, **entry.context},
                resolution=entry.resolution,
                avoidance=entry.avoidance,
                scope=old.scope,
                confidence=round(new_conf, 4),
                occurrences=old.occurrences + 1,
                first_seen=old.first_seen,
                last_seen=_now_iso(),
            )
            existing[match_idx] = updated
            final = updated
        else:
            # Ensure stable gotcha_id
            new_entry = GotchaEntry(
                gotcha_id=_gotcha_id(entry.kind, entry.signature, entry.scope),
                kind=entry.kind,
                signature=entry.signature,
                context=entry.context,
                resolution=entry.resolution,
                avoidance=entry.avoidance,
                scope=entry.scope,
                confidence=entry.confidence,
                occurrences=entry.occurrences,
                first_seen=entry.first_seen or _now_iso(),
                last_seen=entry.last_seen or _now_iso(),
            )
            existing.append(new_entry)
            final = new_entry

        lines = [e.model_dump_json() for e in existing]
        _atomic_write_jsonl(path, lines)
        return final

    def query_gotchas(
        self,
        kind: Optional[str] = None,
        context_filter: Optional[dict[str, Any]] = None,
        scope: Optional[str] = None,
        min_confidence: float = 0.0,
    ) -> list[GotchaEntry]:
        """Query the gotcha store.

        Parameters
        ----------
        kind:
            Filter to a specific kind ("runtime-failure", "hardware-constraint",
            "approach-deadend"). None = all kinds.
        context_filter:
            Dict of key/value pairs that must all appear in entry.context.
            None = no context filtering.
        scope:
            Filter to "global" or "mission" scope. None = both.
        min_confidence:
            Only return entries with confidence >= min_confidence.

        Returns entries sorted by confidence descending, then last_seen descending.
        """
        candidates: list[GotchaEntry] = []

        # Always read global gotchas
        candidates.extend(_load_jsonl(self._global_path))

        # Read mission gotchas when available
        if self._mission_path is not None:
            candidates.extend(_load_jsonl(self._mission_path))

        results: list[GotchaEntry] = []
        for entry in candidates:
            if kind is not None and entry.kind != kind:
                continue
            if scope is not None and entry.scope != scope:
                continue
            if entry.confidence < min_confidence:
                continue
            if context_filter:
                if not all(
                    entry.context.get(k) == v for k, v in context_filter.items()
                ):
                    continue
            results.append(entry)

        results.sort(key=lambda e: (e.confidence, e.last_seen), reverse=True)
        return results

    def matches_known_failure(
        self,
        signature: str,
        min_confidence: float = 0.7,
    ) -> Optional[GotchaEntry]:
        """Return the first gotcha matching signature with confidence >= min_confidence.

        Used by Selector avoidance gate: if not None, the config likely repeats
        a known failure.
        """
        for entry in self.query_gotchas(min_confidence=min_confidence):
            if entry.signature == signature:
                return entry
        return None

    # ── Internal helpers ───────────────────────────────────────────────────────

    def _path_for_scope(self, scope: str) -> Path:
        if scope == "global":
            return self._global_path
        if scope == "mission":
            if self._mission_path is None:
                # Fall back to global when no mission dir provided
                return self._global_path
            return self._mission_path
        return self._global_path


def make_gotcha(
    kind: str,
    signature: str,
    context: dict[str, Any],
    resolution: str,
    avoidance: str,
    scope: str = "global",
    confidence: float = 0.5,
) -> GotchaEntry:
    """Convenience factory for GotchaEntry with sensible defaults."""
    now = _now_iso()
    return GotchaEntry(
        gotcha_id=_gotcha_id(kind, signature, scope),
        kind=kind,  # type: ignore[arg-type]
        signature=signature,
        context=context,
        resolution=resolution,
        avoidance=avoidance,
        scope=scope,  # type: ignore[arg-type]
        confidence=confidence,
        occurrences=1,
        first_seen=now,
        last_seen=now,
    )
