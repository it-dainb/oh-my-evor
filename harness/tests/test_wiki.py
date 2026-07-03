"""
M5 tests for CompoundingWiki (harness/evor/wiki.py).

Coverage:
  test_add_creates_files           — add() writes run-level and cross-run wiki files
  test_add_appends_to_index        — index.jsonl gets a new JSON line per add()
  test_add_returns_lesson_id       — return value is the lesson_id string
  test_query_roundtrip             — query() finds a lesson added via add()
  test_query_no_results            — query with no keyword match returns []
  test_query_family_filter         — family= filter excludes wrong families
  test_query_confirmed_only        — confirmed_only=True excludes unconfirmed lessons
  test_query_ranks_by_hits         — more keyword matches → ranked first
  test_query_limit                 — limit= parameter is respected
  test_cross_run_retrieval         — lesson added in run-A is visible from run-B query
  test_load_context_mission_filter — load_context returns only matching mission_id
  test_load_context_limit          — load_context respects limit parameter
"""

from __future__ import annotations

from pathlib import Path

import pytest

from evor.contracts import LessonEntry
from evor.wiki import CompoundingWiki


# ── Helpers ────────────────────────────────────────────────────────────────────


def _make_lesson(
    lesson_id: str = "les-001",
    node_id: str = "n1",
    run_id: str = "run1",
    mission_id: str = "mission-a",
    family: str = "arch",
    verdict: str = "confirmed",
    observation: str = "batch-norm improved training stability",
    actionable_lesson: str = "Add batch-norm before activation layers",
    tags: list[str] | None = None,
    created_at: str = "2026-07-03T10:00:00Z",
) -> LessonEntry:
    return LessonEntry(
        lesson_id=lesson_id,
        node_id=node_id,
        run_id=run_id,
        mission_id=mission_id,
        approach_family=family,  # type: ignore[arg-type]
        hypothesis_verdict=verdict,  # type: ignore[arg-type]
        observation=observation,
        root_cause=None,
        actionable_lesson=actionable_lesson,
        citations=[],
        telemetry_evidence=None,
        tags=tags or ["stability", "normalization"],
        created_at=created_at,
    )


# ── Tests ──────────────────────────────────────────────────────────────────────


def test_add_creates_files(tmp_path: Path) -> None:
    """add() creates both the run-level wiki md and the cross-run wiki md."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "mission-a" / "run1"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    entry = _make_lesson()
    wiki.add(entry, run_dir)

    # Cross-run copy
    assert (evor_root / "wiki" / "les-001.md").exists()
    # Per-run copy
    assert (run_dir / "wiki" / "les-001.md").exists()


def test_add_appends_to_index(tmp_path: Path) -> None:
    """add() appends a JSON line to index.jsonl."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "mission-a" / "run1"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    wiki.add(_make_lesson("les-001"), run_dir)
    wiki.add(_make_lesson("les-002"), run_dir)

    index_lines = (evor_root / "wiki" / "index.jsonl").read_text().strip().splitlines()
    assert len(index_lines) == 2
    ids = [__import__("json").loads(line)["lesson_id"] for line in index_lines]
    assert "les-001" in ids
    assert "les-002" in ids


def test_add_returns_lesson_id(tmp_path: Path) -> None:
    """add() returns the lesson_id string."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "m" / "r"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    returned = wiki.add(_make_lesson("les-abc"), run_dir)
    assert returned == "les-abc"


def test_query_roundtrip(tmp_path: Path) -> None:
    """query() finds a lesson that was previously added."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "m" / "r"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    entry = _make_lesson(observation="dropout improved generalisation")
    wiki.add(entry, run_dir)

    results = wiki.query("dropout generalisation")
    assert len(results) >= 1
    assert any(r.lesson_id == entry.lesson_id for r in results)


def test_query_no_results(tmp_path: Path) -> None:
    """query() with a term that matches nothing returns an empty list."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "m" / "r"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    wiki.add(_make_lesson(observation="dropout improved generalisation"), run_dir)

    results = wiki.query("transformer_attention_head_pruning_zzz")
    assert results == []


def test_query_empty_index(tmp_path: Path) -> None:
    """query() returns [] when index.jsonl doesn't exist yet."""
    wiki = CompoundingWiki(tmp_path / ".evor")
    assert wiki.query("anything") == []


def test_query_family_filter(tmp_path: Path) -> None:
    """family= filter returns only lessons of that approach_family."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "m" / "r"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    wiki.add(_make_lesson("les-arch", family="arch", observation="resnet depth scaling"), run_dir)
    wiki.add(_make_lesson("les-train", family="training", observation="learning rate warmup"), run_dir)

    arch_results = wiki.query("", family="arch")
    train_results = wiki.query("", family="training")

    assert all(r.approach_family == "arch" for r in arch_results)
    assert all(r.approach_family == "training" for r in train_results)
    assert not any(r.lesson_id == "les-arch" for r in train_results)
    assert not any(r.lesson_id == "les-train" for r in arch_results)


def test_query_confirmed_only(tmp_path: Path) -> None:
    """confirmed_only=True excludes refuted and inconclusive lessons."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "m" / "r"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    wiki.add(_make_lesson("les-confirmed", verdict="confirmed", observation="mixup improved accuracy"), run_dir)
    wiki.add(_make_lesson("les-refuted", verdict="refuted", observation="mixup improved accuracy"), run_dir)

    confirmed = wiki.query("mixup", confirmed_only=True)
    ids = {r.lesson_id for r in confirmed}
    assert "les-confirmed" in ids
    assert "les-refuted" not in ids


def test_query_ranks_by_keyword_hits(tmp_path: Path) -> None:
    """Lesson with more keyword matches ranks before one with fewer."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "m" / "r"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    wiki.add(_make_lesson(
        "les-many",
        observation="dropout regularization dropout overfitting dropout",
        actionable_lesson="dropout is key",
        created_at="2026-07-01T00:00:00Z",
    ), run_dir)
    wiki.add(_make_lesson(
        "les-few",
        observation="dropout alone",
        actionable_lesson="consider alternatives",
        created_at="2026-07-03T00:00:00Z",  # newer but fewer hits
    ), run_dir)

    # Two-keyword query: les-many matches "dropout" AND "regularization";
    # les-few matches only "dropout" → les-many gets 2 hits vs 1 and ranks first.
    results = wiki.query("dropout regularization")
    assert len(results) >= 2
    # les-many should rank first (more keyword hits)
    assert results[0].lesson_id == "les-many"


def test_query_limit(tmp_path: Path) -> None:
    """limit= parameter caps the number of returned results."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "m" / "r"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    for i in range(5):
        wiki.add(_make_lesson(f"les-{i:03d}", observation="accuracy improved"), run_dir)

    results = wiki.query("accuracy", limit=3)
    assert len(results) == 3


def test_cross_run_retrieval(tmp_path: Path) -> None:
    """A lesson added in run-A is discoverable from a query in the context of run-B."""
    evor_root = tmp_path / ".evor"
    run_a = evor_root / "runs" / "mission-x" / "run-a"
    run_b = evor_root / "runs" / "mission-x" / "run-b"
    run_a.mkdir(parents=True, exist_ok=True)
    run_b.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)

    # Add lesson in the context of run-a
    entry = _make_lesson("les-cross", observation="cosine annealing beats step-lr")
    wiki.add(entry, run_a)

    # Query is scoped to the cross-run index — run-b can see it
    results = wiki.query("cosine annealing")
    ids = {r.lesson_id for r in results}
    assert "les-cross" in ids, "Cross-run retrieval failed: lesson from run-a not visible"


def test_load_context_mission_filter(tmp_path: Path) -> None:
    """load_context() returns only lessons for the requested mission_id."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "m" / "r"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    wiki.add(_make_lesson("les-ma", mission_id="mission-a"), run_dir)
    wiki.add(_make_lesson("les-mb", mission_id="mission-b"), run_dir)

    ctx = wiki.load_context("mission-a")
    ids = {r.lesson_id for r in ctx}
    assert "les-ma" in ids
    assert "les-mb" not in ids


def test_load_context_limit(tmp_path: Path) -> None:
    """load_context() respects the limit parameter."""
    evor_root = tmp_path / ".evor"
    run_dir = evor_root / "runs" / "m" / "r"
    run_dir.mkdir(parents=True, exist_ok=True)

    wiki = CompoundingWiki(evor_root)
    for i in range(8):
        wiki.add(_make_lesson(f"les-{i:03d}", mission_id="mission-z"), run_dir)

    ctx = wiki.load_context("mission-z", limit=3)
    assert len(ctx) == 3


def test_load_context_empty(tmp_path: Path) -> None:
    """load_context() returns [] when index doesn't exist or no mission matches."""
    wiki = CompoundingWiki(tmp_path / ".evor")
    assert wiki.load_context("nonexistent-mission") == []
