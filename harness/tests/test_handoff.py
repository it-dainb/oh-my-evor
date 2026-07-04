"""
harness/tests/test_handoff.py — Unit tests for evor.handoff (Phase 2).

Coverage:
  - write_handoff / read_handoff round-trip
  - write_tick_handoff / read_tick_handoff round-trip
  - latest_tick_handoff finds highest-numbered file
  - missing handoff returns None
  - handoffs/ directory auto-created
  - envelope fields (from_agent, to_agent, written_at, payload)
  - tick handoff contains expected markdown sections
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evor.handoff import (
    latest_tick_handoff,
    read_handoff,
    read_tick_handoff,
    write_handoff,
    write_tick_handoff,
)


# ─── within-tick JSON handoffs ────────────────────────────────────────────────

def test_write_read_handoff_roundtrip(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-001"
    run_dir.mkdir()

    payload = {"proposals": ["prop-a", "prop-b"], "tick": 3}
    path = write_handoff(run_dir, "evor", "mutagen", payload)

    assert path.exists()
    assert path.name == "evor_to_mutagen.json"

    result = read_handoff(run_dir, "evor", "mutagen")
    assert result is not None
    assert result["from_agent"] == "evor"
    assert result["to_agent"] == "mutagen"
    assert result["payload"] == payload
    assert "written_at" in result


def test_write_handoff_creates_handoffs_dir(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-002"
    run_dir.mkdir()
    assert not (run_dir / "handoffs").exists()

    write_handoff(run_dir, "selector", "forge", {"approved": ["prop-x"]})

    assert (run_dir / "handoffs").is_dir()
    assert (run_dir / "handoffs" / "selector_to_forge.json").exists()


def test_read_handoff_returns_none_when_missing(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-003"
    run_dir.mkdir()
    assert read_handoff(run_dir, "evor", "sage") is None


def test_write_handoff_overwrites_prior(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-004"
    run_dir.mkdir()

    write_handoff(run_dir, "evor", "forge", {"tick": 1})
    write_handoff(run_dir, "evor", "forge", {"tick": 2})

    result = read_handoff(run_dir, "evor", "forge")
    assert result["payload"]["tick"] == 2


def test_handoff_distinct_agent_pairs(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-005"
    run_dir.mkdir()

    write_handoff(run_dir, "evor", "sage", {"data": "for-sage"})
    write_handoff(run_dir, "evor", "mutagen", {"data": "for-mutagen"})
    write_handoff(run_dir, "selector", "forge", {"data": "from-selector"})

    assert read_handoff(run_dir, "evor", "sage")["payload"]["data"] == "for-sage"
    assert read_handoff(run_dir, "evor", "mutagen")["payload"]["data"] == "for-mutagen"
    assert read_handoff(run_dir, "selector", "forge")["payload"]["data"] == "from-selector"


# ─── tick-to-tick markdown handoffs ──────────────────────────────────────────

def test_write_read_tick_handoff_roundtrip(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-010"
    run_dir.mkdir()

    data = {
        "decided": ["node-a", "node-b"],
        "rejected": [["prop-x", "low diversity"]],
        "risks": ["gradient explosion on node-a"],
        "nodes": ["node-a"],
        "remaining": ["node-b"],
        "best_score": 0.851,
        "tick_count": 3,
        "notes": "Doom-loop risk at tick 4.",
    }
    path = write_tick_handoff(run_dir, 3, data)

    assert path.exists()
    assert path.name == "tick-3.md"

    text = read_tick_handoff(run_dir, 3)
    assert text is not None
    assert "Tick 3 Handoff" in text
    assert "node-a" in text
    assert "node-b" in text
    assert "0.851" in text
    assert "Doom-loop risk" in text
    assert "gradient explosion" in text
    assert "Read-before-act reminder" in text


def test_tick_handoff_creates_handoffs_dir(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-011"
    run_dir.mkdir()
    assert not (run_dir / "handoffs").exists()

    write_tick_handoff(run_dir, 0, {"best_score": 0.72})

    assert (run_dir / "handoffs").is_dir()
    assert (run_dir / "handoffs" / "tick-0.md").exists()


def test_read_tick_handoff_returns_none_when_missing(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-012"
    run_dir.mkdir()
    assert read_tick_handoff(run_dir, 5) is None


def test_tick_handoff_rejected_format(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-013"
    run_dir.mkdir()

    write_tick_handoff(run_dir, 1, {
        "rejected": [
            ["prop-r1", "violates H003"],
            "bare-string-reason",
        ]
    })
    text = read_tick_handoff(run_dir, 1)
    assert "prop-r1" in text
    assert "violates H003" in text
    assert "bare-string-reason" in text


def test_tick_handoff_empty_data(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-014"
    run_dir.mkdir()

    path = write_tick_handoff(run_dir, 0, {})
    text = read_tick_handoff(run_dir, 0)
    assert text is not None
    assert "Tick 0 Handoff" in text


# ─── latest_tick_handoff ──────────────────────────────────────────────────────

def test_latest_tick_handoff_finds_highest(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-020"
    run_dir.mkdir()

    write_tick_handoff(run_dir, 1, {"best_score": 0.72})
    write_tick_handoff(run_dir, 5, {"best_score": 0.85})
    write_tick_handoff(run_dir, 3, {"best_score": 0.80})

    result = latest_tick_handoff(run_dir)
    assert result is not None
    tick_num, text = result
    assert tick_num == 5
    assert "Tick 5 Handoff" in text
    assert "0.85" in text


def test_latest_tick_handoff_returns_none_when_no_handoffs(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-021"
    run_dir.mkdir()
    assert latest_tick_handoff(run_dir) is None


def test_latest_tick_handoff_returns_none_when_no_handoffs_dir(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-022"
    run_dir.mkdir()
    # handoffs/ dir doesn't exist
    assert latest_tick_handoff(run_dir) is None


def test_latest_tick_handoff_with_single_tick(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-023"
    run_dir.mkdir()
    write_tick_handoff(run_dir, 7, {"notes": "only tick"})
    result = latest_tick_handoff(run_dir)
    assert result is not None
    assert result[0] == 7


# ─── path safety ─────────────────────────────────────────────────────────────

def test_handoff_path_uses_agent_names(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-030"
    run_dir.mkdir()

    path = write_handoff(run_dir, "sage", "mutagen", {})
    assert "sage_to_mutagen" in path.name


def test_tick_handoff_path_uses_tick_number(tmp_path: Path) -> None:
    run_dir = tmp_path / "run-031"
    run_dir.mkdir()

    path = write_tick_handoff(run_dir, 42, {})
    assert "tick-42" in path.name
