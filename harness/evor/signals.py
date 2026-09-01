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

from .runlock import run_lock
from evor.contracts import Signal

_SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}
_INBOX_FILENAME = "signals-inbox.jsonl"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _signal_id(kind: str, signature: str) -> str:
    h = hashlib.sha256(f"{kind}:{signature}".encode()).hexdigest()[:12]
    return f"sig-{h}"


def _atomic_write_jsonl(path: Path, lines: list[str]) -> None:
    """Atomically write the bus, PRESERVING records this writer never saw.

    Finding O-02, item 1.8. This is the commit point of a read-modify-write:
    ``emit`` loads every signal, merges one, and writes the whole list back. Any
    record another writer committed between that load and this write was silently
    erased — the file is rewritten wholesale, so a lost update leaves no trace at
    all, in a bus whose entire purpose is to not lose signals.

    The run lock excludes the other PROCESS that writes this file. It cannot
    exclude what reaches the file by another route: an appender, a re-entrant
    call, a writer that does not take the lock. So the union happens HERE, at the
    moment of commit, where the window is empty rather than merely narrow:
    re-read the file, keep every signature the caller is not writing, then
    replace. Records the caller IS writing win — it has just merged them.

    Bus-only by construction (``gotchas.py`` has its own writer). A generic
    atomic writer would not merge; this one is named for its file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)

    incoming: dict[str, str] = {}
    order: list[str] = []
    for line in lines:
        try:
            sig = json.loads(line).get("signature")
        except (ValueError, AttributeError):
            sig = None
        key = sig if sig is not None else f"__unkeyed__{len(order)}"
        if key not in incoming:
            order.append(key)
        incoming[key] = line

    if path.exists():
        try:
            for raw in path.read_text().splitlines():
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    sig = json.loads(raw).get("signature")
                except (ValueError, AttributeError):
                    continue
                if sig is not None and sig not in incoming:
                    incoming[sig] = raw
                    order.append(sig)
        except OSError:
            # Unreadable bus — writing what we have beats refusing to write.
            pass

    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            for key in order:
                fh.write(incoming[key] + "\n")
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
        """Persist or aggregate a signal, under the shared run lock (item 1.8).

        The body is a read-modify-write: load every signal, merge this one by
        signature, rewrite the file. Two concurrent emits lose one — and there
        genuinely are two writers, in two languages: the Python drain called from
        `subagent-stop.mjs` and the MCP server's own signal tools, which already
        take `<run_dir>/.tree.lock` through `withRunLock`. Taking the same lock
        here is what makes that mutual.

        `signals.jsonl` is one of exactly two files this release locks. The
        ownership rule is in `runlock.py`: a lock exists only where a second
        writer genuinely survives in another process. Twelve pairwise retrofits
        were considered and cut — a lock around a single-writer file buys nothing
        and adds a stale-lock failure mode.
        """
        with run_lock(self._run_dir):
            return self._emit_locked(signal)

    def _emit_locked(self, signal: Signal) -> Signal:
        """The critical section of :meth:`emit`. Never call without the lock."""
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

        # The commit point unions with whatever is on disk (see
        # `_atomic_write_jsonl`), so a record another writer added inside this
        # read-modify-write window survives. One mechanism, at the moment where
        # the window is empty rather than merely narrow.
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
