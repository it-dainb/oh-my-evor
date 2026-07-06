"""
SignalBus — the run's neutral observation/pain-point bus.

Layout on disk:
  <run_dir>/signals.jsonl        — append/dedup store of Signal records

Design (see agents' <Signal_Lens> + the signal-protocol reference):
  - Producers EMIT neutral, self-describing signals (open `kind`, structured
    `evidence`, closed `shapes`/`axes` facets).
  - Consumers PULL by facet through their own lens; the same signal is a brief
    to Mutagen, a gate to Selector, a default to Forge-architect, an escalate to
    Evor — the bus never decides routing.

Storm / oscillation dampers:
  - dedup by `signature`: repeat emits increment occurrences, bump last_seen,
    raise confidence toward 1.0 (recurrence x confidence weighting).
  - severity gates whether a signal reaches a spawn digest.
  - query()/digest() sort by (severity, confidence, recency) so a one-off low
    signal never drowns a recurring high one.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from evor.contracts import Signal

_SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}
_INBOX_FILENAME = "signals-inbox.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _signal_id(kind: str, signature: str) -> str:
    h = hashlib.sha256(f"{kind}:{signature}".encode()).hexdigest()[:12]
    return f"sig-{h}"


def _atomic_write_jsonl(path: Path, lines: list[str]) -> None:
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


def _load(path: Path) -> list[Signal]:
    if not path.exists():
        return []
    out: list[Signal] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(Signal.model_validate_json(line))
        except Exception:
            continue
    return out


class SignalBus:
    """Append/dedup/query store for Signal records on a run's bus."""

    def __init__(self, run_dir: Path) -> None:
        self._run_dir = Path(run_dir)
        self._path = self._run_dir / "signals.jsonl"

    # ── Emit ────────────────────────────────────────────────────────────────────
    def emit(self, signal: Signal) -> Signal:
        """Persist or aggregate a signal. Dedup key = signature.

        Repeat emits: increment occurrences, bump last_seen, raise confidence,
        and take the MAX severity seen (a signal that recurs harder escalates).
        """
        existing = _load(self._path)
        idx: Optional[int] = None
        for i, s in enumerate(existing):
            if s.signature == signal.signature:
                idx = i
                break

        if idx is not None:
            old = existing[idx]
            new_conf = min(1.0, old.confidence + (1.0 - old.confidence) * 0.4)
            sev = old.severity
            if _SEVERITY_ORDER[signal.severity] > _SEVERITY_ORDER[sev]:
                sev = signal.severity
            merged = Signal(
                signal_id=old.signal_id,
                kind=old.kind,
                signature=old.signature,
                shapes=sorted(set(old.shapes) | set(signal.shapes)),
                axes=sorted(set(old.axes) | set(signal.axes)),
                severity=sev,
                evidence={**old.evidence, **signal.evidence},
                source=signal.source,
                tick=signal.tick if signal.tick is not None else old.tick,
                node_id=signal.node_id or old.node_id,
                confidence=round(new_conf, 4),
                occurrences=old.occurrences + 1,
                first_seen=old.first_seen,
                last_seen=_now_iso(),
            )
            existing[idx] = merged
            final = merged
        else:
            final = Signal(
                signal_id=_signal_id(signal.kind, signal.signature),
                kind=signal.kind,
                signature=signal.signature,
                shapes=signal.shapes,
                axes=signal.axes,
                severity=signal.severity,
                evidence=signal.evidence,
                source=signal.source,
                tick=signal.tick,
                node_id=signal.node_id,
                confidence=signal.confidence,
                occurrences=signal.occurrences,
                first_seen=signal.first_seen or _now_iso(),
                last_seen=signal.last_seen or _now_iso(),
            )
            existing.append(final)

        _atomic_write_jsonl(self._path, [s.model_dump_json() for s in existing])
        return final

    # ── Query (the pull half) ────────────────────────────────────────────────────
    def query(
        self,
        shapes: Optional[list[str]] = None,
        axes: Optional[list[str]] = None,
        kind: Optional[str] = None,
        min_severity: str = "low",
        since_tick: Optional[int] = None,
    ) -> list[Signal]:
        """Return signals matching a lens's subscription.

        Lazily drains signals-inbox.jsonl before loading, so any hook captures
        written since the last query are visible immediately.

        Facet match is ANY-overlap: a signal matches if it shares >=1 requested
        shape (when shapes given) AND >=1 requested axis (when axes given).
        Sorted by (severity, confidence, last_seen) descending — highest-priority
        first, so digests take the top slice.
        """
        drain_inbox(self._run_dir, self)
        floor = _SEVERITY_ORDER.get(min_severity, 0)
        out: list[Signal] = []
        for s in _load(self._path):
            if _SEVERITY_ORDER[s.severity] < floor:
                continue
            if kind is not None and s.kind != kind:
                continue
            if since_tick is not None and (s.tick is None or s.tick < since_tick):
                continue
            if shapes and not (set(s.shapes) & set(shapes)):
                continue
            if axes and not (set(s.axes) & set(axes)):
                continue
            out.append(s)
        out.sort(
            key=lambda s: (_SEVERITY_ORDER[s.severity], s.confidence, s.last_seen),
            reverse=True,
        )
        return out

    def digest(
        self,
        shapes: Optional[list[str]] = None,
        axes: Optional[list[str]] = None,
        min_severity: str = "medium",
        max_items: int = 8,
    ) -> list[dict[str, Any]]:
        """Compact top-slice for a spawn prompt (the mandatory PUSH half).

        Defaults to severity>=medium so low-noise never floods a digest.
        """
        rows = self.query(shapes=shapes, axes=axes, min_severity=min_severity)[:max_items]
        return [
            {
                "kind": s.kind,
                "shapes": s.shapes,
                "axes": s.axes,
                "severity": s.severity,
                "occurrences": s.occurrences,
                "evidence": s.evidence,
            }
            for s in rows
        ]


def make_signal(
    kind: str,
    signature: str,
    shapes: list[str],
    axes: list[str],
    severity: str,
    evidence: dict[str, Any],
    source: str,
    tick: Optional[int] = None,
    node_id: Optional[str] = None,
    confidence: float = 0.5,
) -> Signal:
    """Convenience factory for a Signal with sensible defaults."""
    now = _now_iso()
    return Signal(
        signal_id=_signal_id(kind, signature),
        kind=kind,
        signature=signature,
        shapes=shapes,  # type: ignore[arg-type]
        axes=axes,  # type: ignore[arg-type]
        severity=severity,  # type: ignore[arg-type]
        evidence=evidence,
        source=source,
        tick=tick,
        node_id=node_id,
        confidence=confidence,
        occurrences=1,
        first_seen=now,
        last_seen=now,
    )


def drain_inbox(run_dir: Path, bus: "SignalBus | None" = None) -> int:
    """Drain <run_dir>/signals-inbox.jsonl into the SignalBus.

    Reads each line of the inbox file, builds a Signal via make_signal(),
    calls bus.emit() (which dedups by signature and updates occurrences/
    confidence/last_seen), then removes the inbox file.  Idempotent and
    crash-safe: the inbox is atomically renamed before processing so a crash
    mid-drain leaves a *.drain-tmp orphan (not the live inbox), meaning the
    next drain sees an empty inbox and produces no duplicates.  Malformed
    lines are skipped silently — one bad entry never blocks the rest.

    Inbox line schema (produced by post-tool-use.mjs):
      {kind, signature, shapes, axes, severity, evidence, source, created_at}

    Returns the count of successfully emitted signals.
    """
    inbox = Path(run_dir) / _INBOX_FILENAME
    if not inbox.exists():
        return 0
    if bus is None:
        bus = SignalBus(run_dir)

    # Atomically claim the inbox before reading so a concurrent or re-entrant
    # drain doesn't process the same lines twice.
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
        for raw in Path(tmp).read_text().splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                entry = json.loads(raw)
                sig = make_signal(
                    kind=entry["kind"],
                    signature=entry["signature"],
                    shapes=list(entry.get("shapes") or []),
                    axes=list(entry.get("axes") or []),
                    severity=entry.get("severity", "medium"),
                    evidence=entry.get("evidence") or {},
                    source=entry.get("source", "hook:unknown"),
                )
                bus.emit(sig)
                emitted += 1
            except Exception:
                continue
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    return emitted
