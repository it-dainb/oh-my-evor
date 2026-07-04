"""
harness/evor/handoff.py — Forced handoff read/write utilities (Phase 2).

Handoff types:
  Within-tick Evor↔agent JSON:  .evor/runs/<m>/<r>/handoffs/<from>_to_<to>.json
  Tick-to-tick markdown:        .evor/runs/<m>/<r>/handoffs/tick-<n>.md

The tick-end handoff captures what the orchestrator decided this tick so the
NEXT tick starts with full deterministic context rather than relying on
in-context memory that may drift or be truncated.

Usage:
  from evor.handoff import write_handoff, write_tick_handoff, read_handoff, read_tick_handoff
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ─── Path helpers ─────────────────────────────────────────────────────────────

def _handoffs_dir(run_dir: Path) -> Path:
    d = Path(run_dir) / "handoffs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _within_tick_path(run_dir: Path, from_agent: str, to_agent: str) -> Path:
    return _handoffs_dir(run_dir) / f"{from_agent}_to_{to_agent}.json"


def _tick_handoff_path(run_dir: Path, tick: int) -> Path:
    return _handoffs_dir(run_dir) / f"tick-{tick}.md"


# ─── Within-tick JSON handoffs ────────────────────────────────────────────────

def write_handoff(
    run_dir: Path,
    from_agent: str,
    to_agent: str,
    payload: dict[str, Any],
) -> Path:
    """Write a within-tick agent-to-agent handoff JSON.

    File: handoffs/<from_agent>_to_<to_agent>.json
    Overwrites any prior handoff for the same pair (one handoff per tick per pair).

    Args:
        run_dir: Path to the run directory (.evor/runs/<m>/<r>/).
        from_agent: Source agent name (e.g. "evor", "selector", "mutagen").
        to_agent: Destination agent name.
        payload: Arbitrary dict; will be JSON-serialised.

    Returns:
        Path to the written file.
    """
    envelope: dict[str, Any] = {
        "from_agent": from_agent,
        "to_agent": to_agent,
        "written_at": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
    path = _within_tick_path(run_dir, from_agent, to_agent)
    path.write_text(json.dumps(envelope, indent=2))
    return path


def read_handoff(
    run_dir: Path,
    from_agent: str,
    to_agent: str,
) -> dict[str, Any] | None:
    """Read the most-recent within-tick handoff for an agent pair.

    Returns the full envelope dict (including from_agent, to_agent, written_at,
    payload) or None if no handoff file exists.
    """
    path = _within_tick_path(run_dir, from_agent, to_agent)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


# ─── Tick-to-tick markdown handoffs ──────────────────────────────────────────

def write_tick_handoff(
    run_dir: Path,
    tick: int,
    data: dict[str, Any],
) -> Path:
    """Write a tick-end markdown handoff for the next tick to consume.

    File: handoffs/tick-<n>.md

    Expected data keys (all optional):
      decided     — list of node IDs approved and submitted this tick
      rejected    — list of (proposal_id, rejection_reason) pairs
      risks       — list of strings describing open risks
      nodes       — list of node IDs completed (integrity checked)
      remaining   — list of node IDs still pending
      best_score  — float best fitness value so far
      tick_count  — int tick number
      notes       — freeform orchestrator notes

    Args:
        run_dir: Path to the run directory.
        tick: Tick number (integer, 0-based).
        data: Dict of handoff contents (see above).

    Returns:
        Path to the written markdown file.
    """
    decided = data.get("decided", [])
    rejected = data.get("rejected", [])
    risks = data.get("risks", [])
    nodes_done = data.get("nodes", [])
    remaining = data.get("remaining", [])
    best_score = data.get("best_score")
    notes = data.get("notes", "")
    written_at = datetime.now(timezone.utc).isoformat()

    lines: list[str] = [
        f"# Tick {tick} Handoff",
        "",
        f"**Written at:** {written_at}",
        f"**Best score so far:** {best_score if best_score is not None else '(none)'}",
        "",
    ]

    if decided:
        lines += ["## Approved and submitted this tick", ""]
        for node_id in decided:
            lines.append(f"- {node_id}")
        lines.append("")

    if rejected:
        lines += ["## Rejected proposals", ""]
        for item in rejected:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                lines.append(f"- {item[0]}: {item[1]}")
            else:
                lines.append(f"- {item}")
        lines.append("")

    if nodes_done:
        lines += ["## Nodes completed (integrity checked)", ""]
        for node_id in nodes_done:
            lines.append(f"- {node_id}")
        lines.append("")

    if remaining:
        lines += ["## Nodes still pending", ""]
        for node_id in remaining:
            lines.append(f"- {node_id}")
        lines.append("")

    if risks:
        lines += ["## Open risks / interventions", ""]
        for risk in risks:
            lines.append(f"- {risk}")
        lines.append("")

    if notes:
        lines += ["## Orchestrator notes", "", notes, ""]

    lines += [
        "## Read-before-act reminder",
        "",
        "Before acting on tick N+1, ALL agents MUST read:",
        "1. `.evor/runs/<m>/<r>/run-state.json` — current mission state",
        "2. `.evor/runs/<m>/<r>/tree.json` — current tree",
        f"3. This file (`handoffs/tick-{tick}.md`) — prior tick context",
        "4. Their own incoming handoff in `handoffs/` if present",
        "",
    ]

    path = _tick_handoff_path(run_dir, tick)
    path.write_text("\n".join(lines))
    return path


def read_tick_handoff(run_dir: Path, tick: int) -> str | None:
    """Read the tick handoff markdown for a given tick number.

    Returns the markdown text or None if no handoff exists for that tick.
    """
    path = _tick_handoff_path(run_dir, tick)
    if not path.exists():
        return None
    try:
        return path.read_text()
    except Exception:
        return None


def latest_tick_handoff(run_dir: Path) -> tuple[int, str] | None:
    """Return (tick_number, markdown_text) for the most recent tick handoff.

    Scans handoffs/tick-*.md and returns the highest-numbered one.
    Returns None if no tick handoffs exist.
    """
    handoffs_dir = Path(run_dir) / "handoffs"
    if not handoffs_dir.exists():
        return None

    best: tuple[int, Path] | None = None
    for f in handoffs_dir.glob("tick-*.md"):
        try:
            n = int(f.stem.split("-", 1)[1])
            if best is None or n > best[0]:
                best = (n, f)
        except (ValueError, IndexError):
            continue

    if best is None:
        return None
    try:
        return (best[0], best[1].read_text())
    except Exception:
        return None
