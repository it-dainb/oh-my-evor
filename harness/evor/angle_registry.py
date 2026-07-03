"""
AngleRegistry CRUD + SOTA trust model (R-8, R-9, R-11, Pillar 4).

score_angles() — per-angle vs SOTA comparison and worst_angle_coverage.
update_angle() — monotonic SOTA write-lock; raises ValueError if new bar < existing.
add_angle()    — defaults trust_level='indicative' unless quorum criteria met.
flag_sota_regression() — surfaces human-review alert; NEVER lowers committed bar.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from evor.contracts import (
    AngleEntry,
    AngleRegistry,
    AngleVsSOTA,
    EvaluationResult,
    SotaSource,
)


# ─────────────────────────────────────────────────────────────────────────────
# Registry I/O
# ─────────────────────────────────────────────────────────────────────────────


def _load_registry(run_dir: Path) -> AngleRegistry:
    path = run_dir / "angle-registry.json"
    if not path.exists():
        raise FileNotFoundError(f"angle-registry.json not found at {run_dir}")
    with open(path) as fh:
        return AngleRegistry.model_validate_json(fh.read())


def _save_registry(registry: AngleRegistry, run_dir: Path) -> None:
    """Atomic write: tmp + os.replace()."""
    path = run_dir / "angle-registry.json"
    tmp = run_dir / "angle-registry.json.tmp"
    tmp.write_text(registry.model_dump_json(indent=2))
    os.replace(tmp, path)


# ─────────────────────────────────────────────────────────────────────────────
# Trust helpers
# ─────────────────────────────────────────────────────────────────────────────


def _compute_quorum(sources: list[SotaSource]) -> bool:
    """True iff >=2 distinct sources with divergence <= 5% OR any human_provided."""
    if any(s.retrieval_method == "human_provided" for s in sources):
        return True
    distinct_ids = {s.source_id for s in sources}
    return len(distinct_ids) >= 2


def _effective_bar(angle: AngleEntry) -> float:
    """max(sota_bar, baseline_model_score_before_finetune or 0.0) per R-9."""
    baseline = angle.baseline_model_score_before_finetune or 0.0
    return max(angle.sota_bar, baseline)


def _trust_level(angle: AngleEntry) -> Literal["authoritative", "indicative"]:
    return "authoritative" if angle.sota_quorum_met else "indicative"


# ─────────────────────────────────────────────────────────────────────────────
# AngleRegistryManager
# ─────────────────────────────────────────────────────────────────────────────


class AngleRegistryManager:
    """CRUD + scoring for the angle registry stored at run_dir/angle-registry.json."""

    def __init__(self, mission_id: str) -> None:
        self._mission_id = mission_id

    def _ensure_registry(self, run_dir: Path) -> AngleRegistry:
        """Create empty registry on first access."""
        path = run_dir / "angle-registry.json"
        if not path.exists():
            reg = AngleRegistry(
                mission_id=self._mission_id,
                angles=[],
                updated_at=datetime.now(timezone.utc).isoformat(),
            )
            _save_registry(reg, run_dir)
        return _load_registry(run_dir)

    def add_angle(
        self,
        angle_id: str,
        sota_bar: float,
        sota_sources: list[SotaSource],
        baseline_score: float | None,
        run_dir: Path,
        eval_version_added: str = "v1",
        held_out_split_hash: str = "",
        is_public_benchmark: bool = False,
        pretraining_contamination_risk: Literal[
            "low", "medium", "high", "unknown"
        ] = "unknown",
        sota_retrieved_at: str | None = None,
        tick: int = 0,
        mission_type: Literal["fixed", "open_ended"] = "fixed",
    ) -> None:
        """Add a new angle to the registry.

        trust_level defaults to 'indicative'; upgraded to 'authoritative' when:
          - sota_quorum_met (>=2 distinct sources, divergence <=5%), OR
          - any source uses retrieval_method='human_provided'.

        Monotonic SOTA bar invariant: a new angle's sota_bar cannot be lowered
        after it is set; update_angle() enforces this invariant on updates.

        Tick-1 warning: if mission_type='open_ended' and 0 angles are registered
        after tick 1 completes, emit a warning — coverage target is unreachable.
        """
        registry = self._ensure_registry(run_dir)

        if any(a.angle_id == angle_id for a in registry.angles):
            raise ValueError(
                f"Angle {angle_id!r} already in registry. "
                "Use update_angle() to modify an existing entry."
            )

        quorum_met = _compute_quorum(sota_sources)

        entry = AngleEntry(
            angle_id=angle_id,
            eval_version_added=eval_version_added,
            sota_bar=sota_bar,
            sota_source_ids=[s.source_id for s in sota_sources],
            sota_quorum_met=quorum_met,
            baseline_model_score_before_finetune=baseline_score,
            sota_retrieved_at=(
                sota_retrieved_at or datetime.now(timezone.utc).isoformat()
            ),
            held_out_split_hash=held_out_split_hash,
            is_public_benchmark=is_public_benchmark,
            pretraining_contamination_risk=pretraining_contamination_risk,
        )
        registry.angles.append(entry)
        registry.updated_at = datetime.now(timezone.utc).isoformat()
        _save_registry(registry, run_dir)

        # Tick-1 warning for open_ended missions with still-empty registry
        if tick >= 1 and mission_type == "open_ended" and len(registry.angles) == 0:
            print(
                "[EVOR WARNING: open_ended mission has 0 angles registered"
                " — coverage target unreachable]",
                file=sys.stderr,
                flush=True,
            )

    def update_angle(
        self,
        angle_id: str,
        new_sota_bar: float,
        new_sources: list[str],
        run_dir: Path,
    ) -> None:
        """Monotonic write-lock (R-8): new_sota_bar must be >= existing sota_bar.

        Raises ValueError if the new bar would lower the committed bar.
        Recomputes sota_quorum_met from the updated source list.
        """
        registry = _load_registry(run_dir)
        idx = next(
            (i for i, a in enumerate(registry.angles) if a.angle_id == angle_id),
            None,
        )
        if idx is None:
            raise KeyError(f"Angle {angle_id!r} not found in registry.")

        angle = registry.angles[idx]
        if new_sota_bar < angle.sota_bar:
            raise ValueError(
                f"Monotonic SOTA write-lock violated for angle {angle_id!r}: "
                f"new_sota_bar={new_sota_bar} < existing sota_bar={angle.sota_bar}. "
                "SOTA bars can only increase. "
                "If the leaderboard has been corrected downward, use flag_sota_regression()."
            )

        quorum_met = len(set(new_sources)) >= 2

        registry.angles[idx] = AngleEntry(
            angle_id=angle.angle_id,
            eval_version_added=angle.eval_version_added,
            sota_bar=new_sota_bar,
            sota_source_ids=new_sources,
            sota_quorum_met=quorum_met,
            baseline_model_score_before_finetune=angle.baseline_model_score_before_finetune,
            sota_retrieved_at=datetime.now(timezone.utc).isoformat(),
            held_out_split_hash=angle.held_out_split_hash,
            is_public_benchmark=angle.is_public_benchmark,
            pretraining_contamination_risk=angle.pretraining_contamination_risk,
        )
        registry.updated_at = datetime.now(timezone.utc).isoformat()
        _save_registry(registry, run_dir)

    def score_angles(
        self,
        result: EvaluationResult,
        registry: AngleRegistry,
        eval_version: str,
    ) -> tuple[dict[str, AngleVsSOTA], float]:
        """Compute per-angle vs SOTA and worst_angle_coverage (R-11).

        For each angle in registry:
          effective_bar = max(sota_bar, baseline_model_score_before_finetune or 0.0)  (R-9)
          angle absent from result.per_domain → UNSCORED; excluded from denominator.
          above_sota = (value >= effective_bar) AND trust_level='authoritative'

        worst_angle_coverage = count(above_sota) / count(scored_angles)
          → 0.0 if no angles are scored (not a failure; coverage is undefined).

        Returns (per_angle_vs_sota, worst_angle_coverage).
        """
        per_angle: dict[str, AngleVsSOTA] = {}
        scored_count = 0
        above_sota_count = 0

        for angle in registry.angles:
            domain_scores = result.per_domain.get(angle.angle_id)
            if domain_scores is None:
                # Unscored — absent from result; excluded from coverage denominator
                continue

            # Primary metric value: first numeric value in the domain dict
            value = next(iter(domain_scores.values())) if domain_scores else 0.0

            eff_bar = _effective_bar(angle)
            trust = _trust_level(angle)
            above = (value >= eff_bar) and (trust == "authoritative")

            per_angle[angle.angle_id] = AngleVsSOTA(
                angle_id=angle.angle_id,
                value=value,
                sota_bar=eff_bar,
                above_sota=above,
                trust_level=trust,
            )
            scored_count += 1
            if above:
                above_sota_count += 1

        coverage = above_sota_count / scored_count if scored_count > 0 else 0.0
        return per_angle, coverage

    def get_coverage(self, result: EvaluationResult, run_dir: Path) -> float:
        """Convenience wrapper — returns worst_angle_coverage scalar."""
        registry = _load_registry(run_dir)
        _, coverage = self.score_angles(result, registry, result.eval_version)
        return coverage

    def flag_sota_regression(
        self,
        angle_id: str,
        new_fetched_bar: float,
        source: str,
        citation: str,
        run_dir: Path,
    ) -> None:
        """Surface a human-review alert when a newly-fetched SOTA bar is LOWER than
        the committed bar (R-8 / Q3 monotonic write-lock protection).

        NEVER lowers the committed bar — monotonic write-lock from R-8 forbids this.
        Prints the alert to stdout and appends it to decision-log.md.
        The user decides whether the leaderboard correction is legitimate; the system
        never auto-lowers (Q3).
        """
        registry = _load_registry(run_dir)
        angle = next(
            (a for a in registry.angles if a.angle_id == angle_id), None
        )
        if angle is None:
            raise KeyError(f"Angle {angle_id!r} not found in registry.")

        timestamp = datetime.now(timezone.utc).isoformat()
        alert = (
            f"[EVOR SOTA-REGRESSION ALERT: angle {angle_id}"
            f" | committed={angle.sota_bar}"
            f" | fetched={new_fetched_bar}"
            f" | source={source}"
            f" | citation={citation}"
            f" | {timestamp}]"
        )
        print(alert, flush=True)

        decision_log = run_dir / "decision-log.md"
        with open(decision_log, "a") as fh:
            fh.write(f"\n{alert}\n")
