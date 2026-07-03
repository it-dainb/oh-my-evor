"""
CompoundingWiki — per-run and cross-run lesson store (Addendum v2).

Layout on disk:
  .evor/wiki/
    index.jsonl              — append-only LessonEntry index (cross-run)
    <lesson-id>.md           — rendered markdown for each lesson (cross-run)
  .evor/runs/<mission>/<run-id>/wiki/
    <lesson-id>.md           — per-run copy (for run-scoped browsing)

add()   writes to both locations.
query() scans .evor/wiki/index.jsonl; filter by family; rank by recency.
load_context() returns top-N lessons by keyword relevance for mission startup.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from evor.contracts import ApproachFamily, LessonEntry


class CompoundingWiki:
    """Append-only lesson store with cross-run retrieval.

    Parameters
    ----------
    evor_root:
        The ``.evor/`` root directory (parent of ``runs/``).
        Cross-run wiki lives at ``evor_root / "wiki"``.
    """

    def __init__(self, evor_root: Path) -> None:
        self._evor_root = Path(evor_root)
        self._wiki_dir = self._evor_root / "wiki"
        self._index_path = self._wiki_dir / "index.jsonl"

    # ── Public API ─────────────────────────────────────────────────────────────

    def add(self, entry: LessonEntry, run_dir: Path) -> str:
        """Persist a lesson to both the per-run wiki and the cross-run index.

        Writes:
          - ``run_dir/wiki/<lesson_id>.md``          (per-run copy)
          - ``evor_root/wiki/<lesson_id>.md``         (cross-run copy)
          - ``evor_root/wiki/index.jsonl``            (appended JSON line)

        Returns the lesson_id for reference chaining.
        """
        self._wiki_dir.mkdir(parents=True, exist_ok=True)

        rendered = self._render_lesson(entry)

        # Cross-run wiki (primary; queried by all subsequent runs)
        (self._wiki_dir / f"{entry.lesson_id}.md").write_text(rendered)
        with open(self._index_path, "a") as fh:
            fh.write(entry.model_dump_json() + "\n")

        # Per-run wiki (convenient when browsing a single run)
        run_wiki = Path(run_dir) / "wiki"
        run_wiki.mkdir(parents=True, exist_ok=True)
        (run_wiki / f"{entry.lesson_id}.md").write_text(rendered)

        return entry.lesson_id

    def query(
        self,
        query: str,
        family: Optional[ApproachFamily] = None,
        confirmed_only: bool = False,
        limit: int = 10,
    ) -> list[LessonEntry]:
        """Keyword scan over the cross-run index.jsonl.

        Matching:
          Each lesson is scored by the number of query keywords that appear in its
          ``observation``, ``actionable_lesson``, ``tags``, or ``root_cause`` text.
          Lessons with zero keyword hits are excluded.

        Filters:
          family       — if provided, only lessons with this approach_family are returned.
          confirmed_only — if True, only lessons where hypothesis_verdict='confirmed'.

        Ranking:
          Results are sorted first by keyword hit count (desc), then by recency
          (created_at desc) to break ties.
        """
        if not self._index_path.exists():
            return []

        keywords = [kw.lower() for kw in query.split() if kw.strip()]

        entries: list[tuple[int, str, LessonEntry]] = []  # (hits, created_at, entry)
        for line in self._index_path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = LessonEntry.model_validate_json(line)
            except Exception:
                continue

            if family is not None and entry.approach_family != family:
                continue
            if confirmed_only and entry.hypothesis_verdict != "confirmed":
                continue

            if not keywords:
                # No keywords → return all (up to limit), ranked by recency
                entries.append((0, entry.created_at, entry))
                continue

            # Build searchable text blob
            tag_text = " ".join(entry.tags)
            blob = " ".join(filter(None, [
                entry.observation,
                entry.actionable_lesson,
                entry.root_cause or "",
                tag_text,
            ])).lower()

            hits = sum(blob.count(kw) for kw in keywords)
            if hits > 0:
                entries.append((hits, entry.created_at, entry))

        # Sort: most keyword hits first, then newest first
        entries.sort(key=lambda x: (x[0], x[1]), reverse=True)
        return [e for _, _, e in entries[:limit]]

    def load_context(self, mission_id: str, limit: int = 5) -> list[LessonEntry]:
        """Return top-N lessons relevant to the mission for Evor context injection.

        Matches lessons whose mission_id equals the given mission_id or whose
        tags/observation mention the mission's task keywords.  Returns the most
        recently created lessons that match.
        """
        if not self._index_path.exists():
            return []

        matched: list[tuple[str, LessonEntry]] = []  # (created_at, entry)
        for line in self._index_path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = LessonEntry.model_validate_json(line)
            except Exception:
                continue

            if entry.mission_id == mission_id:
                matched.append((entry.created_at, entry))

        # Sort newest first
        matched.sort(key=lambda x: x[0], reverse=True)
        return [e for _, e in matched[:limit]]

    # ── Internal helpers ───────────────────────────────────────────────────────

    def _render_lesson(self, entry: LessonEntry) -> str:
        """Render a LessonEntry as human-readable markdown."""
        lines: list[str] = [
            f"# Lesson: {entry.lesson_id}",
            "",
            f"**Node:** {entry.node_id}  |  **Run:** {entry.run_id}  |  **Mission:** {entry.mission_id}",
            f"**Family:** {entry.approach_family}  |  **Verdict:** {entry.hypothesis_verdict}",
            f"**Created:** {entry.created_at}",
            "",
            "## Observation",
            "",
            entry.observation,
            "",
        ]

        if entry.root_cause:
            lines += ["## Root Cause", "", entry.root_cause, ""]

        lines += [
            "## Actionable Lesson",
            "",
            entry.actionable_lesson,
            "",
        ]

        if entry.telemetry_evidence:
            lines += ["## Telemetry Evidence", "", entry.telemetry_evidence, ""]

        if entry.citations:
            lines += ["## Citations", ""]
            for cit in entry.citations:
                lines.append(f"- {cit}")
            lines.append("")

        if entry.tags:
            lines += [f"**Tags:** {', '.join(entry.tags)}", ""]

        return "\n".join(lines)
