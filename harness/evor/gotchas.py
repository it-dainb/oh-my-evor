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
            # ── N-10 (item 5.2): the floor does not apply to an OPEN problem.
            #
            # Confidence measures certainty of the DIAGNOSIS, so an unresolved
            # gotcha is low-confidence precisely because it needs attention — and
            # a floor therefore filters out exactly the entries most worth
            # surfacing. `private-dataloader-test-leakage-iir-binnet-01` sat at
            # 0.5; every r3 query used 0.6 or 0.8; a live test-leakage defect was
            # hidden from all five retrievals.
            if entry.confidence < min_confidence and not entry.is_unresolved:
                continue
            if context_filter:
                if not all(
                    entry.context.get(k) == v for k, v in context_filter.items()
                ):
                    continue
            results.append(entry)

        results.sort(key=lambda e: (e.confidence, e.last_seen), reverse=True)
        return results

    def supersede_gotcha(
        self,
        signature: str,
        reason: str,
        superseded_by: Optional[str] = None,
        scope: Optional[str] = None,
    ) -> int:
        """Mark a gotcha as no longer true. Returns how many entries were marked.

        Item 5.2. ``add_gotcha`` only ever ratchets occurrences and confidence
        UP, so the store had no way to record that a fact had stopped being true.
        The r3 contract relaxed the latency gate this encodes tenfold and nothing
        could say so; five r3 agents were handed the retired gate as current.

        The entry is MARKED, not deleted. Deleting loses the history — that this
        was believed, and when it stopped being believed, is exactly what a later
        reader needs to interpret decisions made while it stood.
        """
        return self._mutate(
            signature,
            scope,
            lambda e: e.model_copy(update={
                "superseded_at": _now_iso(),
                "superseded_reason": reason,
                "superseded_by": superseded_by,
            }),
        )

    def record_contradiction(
        self, signature: str, evidence: str, scope: Optional[str] = None
    ) -> int:
        """Record evidence AGAINST a gotcha and lower its confidence.

        Item 5.2. Confidence was monotonically increasing — ``add_gotcha`` halves
        the gap to 1.0 on every repeat — so a fact measured to be wrong twice kept
        its 1.0. r2 and r3 both recorded that kMAC/px is a poor predictor of
        measured latency, and nothing moved.

        Symmetry with ``add_gotcha`` is deliberate: corroboration halves the gap
        UP toward 1.0, so a contradiction halves the distance DOWN toward 0. One
        contradiction does not erase a well-supported fact, and repeated ones
        converge on disbelief.
        """
        return self._mutate(
            signature,
            scope,
            lambda e: e.model_copy(update={
                "contradictions": [*e.contradictions, evidence],
                "confidence": round(e.confidence * 0.5, 4),
                "last_seen": _now_iso(),
            }),
        )

    def _mutate(self, signature: str, scope: Optional[str], fn) -> int:
        """Rewrite matching entries in place across the scopes this store owns."""
        touched = 0
        paths = [self._global_path]
        if self._mission_path is not None:
            paths.append(self._mission_path)
        for path in paths:
            entries = _load_jsonl(path)
            if not entries:
                continue
            updated = []
            changed = False
            for e in entries:
                if e.signature == signature and (scope is None or e.scope == scope):
                    updated.append(fn(e))
                    changed = True
                    touched += 1
                else:
                    updated.append(e)
            if changed:
                _atomic_write_jsonl(path, [e.model_dump_json() for e in updated])
        return touched

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

#: Item 5.5 — what determines whether a fact travels is what KIND of fact it is.
#:
#: N-08: r1 wrote five mission-scoped gotchas that were invisible to r2 and r3,
#: and THREE OF THE FIVE duplicate a global twin the same agent wrote minutes
#: earlier. The scope choice was not carrying a distinction; it was whim, because
#: scope was a free parameter with a silent default.
#:
#: A rule keyed on `kind` is deterministic and defensible:
#:
#:   hardware-constraint  GLOBAL — a property of the machine, true for every
#:                        mission that runs on it
#:   runtime-failure      GLOBAL — a property of the stack: a CUDA OOM or a
#:                        broken wheel does not become untrue for the next goal
#:   approach-deadend     MISSION — a property of THIS objective's search space.
#:                        "Attention did not help here" is about here.
_SCOPE_BY_KIND: dict[str, str] = {
    "hardware-constraint": "global",
    "runtime-failure": "global",
    "approach-deadend": "mission",
}


def scope_for_gotcha(kind: str, signature: str = "") -> str:
    """The scope a gotcha of this kind belongs in. Deterministic, not chosen.

    ``signature`` is accepted and deliberately unused for the decision: it is the
    part an agent writes freely, and letting it influence scope is how two
    equivalent hardware constraints ended up in different stores four minutes
    apart. It stays in the signature so callers can log what was scoped.
    """
    return _SCOPE_BY_KIND.get(kind, "global")
