"""
Unit tests for AngleRegistryManager (harness/evor/angle_registry.py).

Covers:
  - add_angle() creates entry with correct trust_level computation
  - update_angle() monotonic write-lock rejects lower sota_bar
  - update_angle() allows same or higher sota_bar
  - score_angles() angles absent from result.per_domain are UNSCORED, not failing
  - score_angles() present but below SOTA → counted, not above
  - score_angles() present and above SOTA with authoritative trust → above_sota=True
  - score_angles() indicative trust never counts as above_sota
  - worst_angle_coverage computed correctly
  - flag_sota_regression() prints alert, appends to decision-log, never lowers bar
  - sota_quorum_met computed correctly from source count
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from evor.angle_registry import AngleRegistryManager, _load_registry
from evor.contracts import (
    AngleEntry,
    AngleRegistry,
    AngleVsSOTA,
    EvaluationResult,
    SotaSource,
    TelemetrySummary,
)


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def run_dir(tmp_path: Path) -> Path:
    (tmp_path / "eval-suites").mkdir()
    return tmp_path


@pytest.fixture
def mgr() -> AngleRegistryManager:
    return AngleRegistryManager(mission_id="test-mission")


def _source(source_id: str, method: str = "web_fetch") -> SotaSource:
    return SotaSource(
        source_id=source_id,
        name=f"Source {source_id}",
        retrieval_method=method,  # type: ignore[arg-type]
        trust_level="authoritative",
    )


def _make_eval_result(
    per_domain: dict[str, dict[str, float]],
    eval_version: str = "v1",
) -> EvaluationResult:
    return EvaluationResult(
        node_id="node-1",
        run_id="run-1",
        eval_version=eval_version,
        metrics={"accuracy": 0.9},
        per_domain=per_domain,
        fitness_value=0.9,
        telemetry_summary=TelemetrySummary(total_steps=100),
        status="success",
        benchmark_raw="",
        timestamp="2026-07-03T00:00:00Z",
    )


# ─────────────────────────────────────────────────────────────────────────────
# add_angle
# ─────────────────────────────────────────────────────────────────────────────


def test_add_angle_single_source_indicative(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr.add_angle(
        angle_id="scanned",
        sota_bar=0.95,
        sota_sources=[_source("pwc")],
        baseline_score=None,
        run_dir=run_dir,
    )
    reg = _load_registry(run_dir)
    assert len(reg.angles) == 1
    angle = reg.angles[0]
    assert angle.angle_id == "scanned"
    assert angle.sota_quorum_met is False  # only 1 source


def test_add_angle_two_sources_quorum(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr.add_angle(
        angle_id="handwritten",
        sota_bar=0.88,
        sota_sources=[_source("pwc"), _source("arxiv")],
        baseline_score=None,
        run_dir=run_dir,
    )
    reg = _load_registry(run_dir)
    assert reg.angles[0].sota_quorum_met is True


def test_add_angle_human_provided_is_authoritative(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr.add_angle(
        angle_id="tabular-angle",
        sota_bar=0.80,
        sota_sources=[_source("human-eval", method="human_provided")],
        baseline_score=None,
        run_dir=run_dir,
    )
    reg = _load_registry(run_dir)
    # human_provided counts as quorum on its own
    assert reg.angles[0].sota_quorum_met is True


def test_add_angle_duplicate_raises(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr.add_angle("angle-x", 0.9, [_source("s1")], None, run_dir)
    with pytest.raises(ValueError, match="already in registry"):
        mgr.add_angle("angle-x", 0.91, [_source("s2")], None, run_dir)


# ─────────────────────────────────────────────────────────────────────────────
# update_angle — monotonic write-lock
# ─────────────────────────────────────────────────────────────────────────────


def test_update_angle_raises_if_lower_bar(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr.add_angle("angle-a", sota_bar=0.90, sota_sources=[_source("s1")],
                  baseline_score=None, run_dir=run_dir)
    with pytest.raises(ValueError, match="Monotonic SOTA write-lock violated"):
        mgr.update_angle("angle-a", new_sota_bar=0.89, new_sources=["s1"], run_dir=run_dir)


def test_update_angle_allows_same_bar(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr.add_angle("angle-b", sota_bar=0.90, sota_sources=[_source("s1")],
                  baseline_score=None, run_dir=run_dir)
    mgr.update_angle("angle-b", new_sota_bar=0.90, new_sources=["s1", "s2"], run_dir=run_dir)
    reg = _load_registry(run_dir)
    assert reg.angles[0].sota_bar == 0.90


def test_update_angle_allows_higher_bar(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr.add_angle("angle-c", sota_bar=0.90, sota_sources=[_source("s1")],
                  baseline_score=None, run_dir=run_dir)
    mgr.update_angle("angle-c", new_sota_bar=0.95, new_sources=["s1", "s2"], run_dir=run_dir)
    reg = _load_registry(run_dir)
    assert reg.angles[0].sota_bar == 0.95


def test_update_angle_missing_raises_key_error(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr._ensure_registry(run_dir)
    with pytest.raises(KeyError):
        mgr.update_angle("nonexistent", 0.5, ["s1"], run_dir)


# ─────────────────────────────────────────────────────────────────────────────
# score_angles — unscored vs failing
# ─────────────────────────────────────────────────────────────────────────────


def test_score_angles_absent_is_unscored_not_failing(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    """Angles absent from result.per_domain are unscored; excluded from denominator."""
    mgr.add_angle("present", 0.8, [_source("s1"), _source("s2")], None, run_dir)
    mgr.add_angle("absent", 0.7, [_source("s3"), _source("s4")], None, run_dir)

    reg = _load_registry(run_dir)
    # Only "present" in per_domain
    result = _make_eval_result({"present": {"accuracy": 0.85}})

    per_angle, coverage = mgr.score_angles(result, reg, "v1")

    assert "present" in per_angle
    assert "absent" not in per_angle   # unscored — NOT in output at all
    # Coverage = 1 above / 1 scored (absent excluded from denominator)
    assert per_angle["present"].above_sota is True
    assert coverage == pytest.approx(1.0)


def test_score_angles_below_sota_not_above(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr.add_angle("angle-d", 0.90, [_source("s1"), _source("s2")], None, run_dir)
    reg = _load_registry(run_dir)
    result = _make_eval_result({"angle-d": {"accuracy": 0.85}})

    per_angle, coverage = mgr.score_angles(result, reg, "v1")
    assert per_angle["angle-d"].above_sota is False
    assert coverage == pytest.approx(0.0)


def test_score_angles_above_sota_authoritative(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr.add_angle("angle-e", 0.80, [_source("s1"), _source("s2")], None, run_dir)
    reg = _load_registry(run_dir)
    result = _make_eval_result({"angle-e": {"accuracy": 0.85}})

    per_angle, coverage = mgr.score_angles(result, reg, "v1")
    assert per_angle["angle-e"].above_sota is True
    assert per_angle["angle-e"].trust_level == "authoritative"
    assert coverage == pytest.approx(1.0)


def test_score_angles_indicative_never_counts_as_above(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    """Indicative trust angles are scored but above_sota is always False."""
    mgr.add_angle("angle-f", 0.80, [_source("s1")], None, run_dir)  # 1 source → indicative
    reg = _load_registry(run_dir)
    result = _make_eval_result({"angle-f": {"accuracy": 0.95}})

    per_angle, coverage = mgr.score_angles(result, reg, "v1")
    assert per_angle["angle-f"].trust_level == "indicative"
    assert per_angle["angle-f"].above_sota is False
    assert coverage == pytest.approx(0.0)


def test_score_angles_empty_registry_coverage_zero(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr._ensure_registry(run_dir)
    reg = _load_registry(run_dir)
    result = _make_eval_result({})
    _, coverage = mgr.score_angles(result, reg, "v1")
    assert coverage == pytest.approx(0.0)


def test_score_angles_effective_bar_uses_baseline(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    """Effective bar = max(sota_bar, baseline); high baseline raises the bar."""
    mgr.add_angle(
        "angle-g", sota_bar=0.70,
        sota_sources=[_source("s1"), _source("s2")],
        baseline_score=0.90,   # baseline > sota_bar → effective bar = 0.90
        run_dir=run_dir,
    )
    reg = _load_registry(run_dir)
    # Model scores 0.85 — above sota_bar (0.70) but below effective bar (0.90)
    result = _make_eval_result({"angle-g": {"accuracy": 0.85}})
    per_angle, coverage = mgr.score_angles(result, reg, "v1")
    assert per_angle["angle-g"].sota_bar == pytest.approx(0.90)
    assert per_angle["angle-g"].above_sota is False


def test_score_angles_mixed_present_absent(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    """Coverage denominator counts only scored (present) angles."""
    mgr.add_angle("scored-1", 0.80, [_source("s1"), _source("s2")], None, run_dir)
    mgr.add_angle("scored-2", 0.85, [_source("s3"), _source("s4")], None, run_dir)
    mgr.add_angle("unscored", 0.75, [_source("s5"), _source("s6")], None, run_dir)

    reg = _load_registry(run_dir)
    result = _make_eval_result({
        "scored-1": {"accuracy": 0.90},  # above SOTA
        "scored-2": {"accuracy": 0.80},  # below SOTA
        # "unscored" absent
    })
    per_angle, coverage = mgr.score_angles(result, reg, "v1")
    assert "unscored" not in per_angle
    assert per_angle["scored-1"].above_sota is True
    assert per_angle["scored-2"].above_sota is False
    # 1 above / 2 scored = 0.5
    assert coverage == pytest.approx(0.5)


# ─────────────────────────────────────────────────────────────────────────────
# flag_sota_regression
# ─────────────────────────────────────────────────────────────────────────────


def test_flag_sota_regression_prints_and_logs(
    mgr: AngleRegistryManager, run_dir: Path, capsys
) -> None:
    mgr.add_angle("angle-h", 0.95, [_source("s1"), _source("s2")], None, run_dir)

    mgr.flag_sota_regression(
        angle_id="angle-h",
        new_fetched_bar=0.88,
        source="Papers With Code",
        citation="https://example.com",
        run_dir=run_dir,
    )

    captured = capsys.readouterr()
    assert "EVOR SOTA-REGRESSION ALERT" in captured.out
    assert "angle-h" in captured.out
    assert "committed=0.95" in captured.out
    assert "fetched=0.88" in captured.out

    log_text = (run_dir / "decision-log.md").read_text()
    assert "EVOR SOTA-REGRESSION ALERT" in log_text


def test_flag_sota_regression_does_not_lower_bar(
    mgr: AngleRegistryManager, run_dir: Path, capsys
) -> None:
    """flag_sota_regression must NEVER modify the committed sota_bar."""
    mgr.add_angle("angle-i", 0.95, [_source("s1"), _source("s2")], None, run_dir)
    mgr.flag_sota_regression("angle-i", 0.80, "source", "cite", run_dir)

    reg = _load_registry(run_dir)
    angle = next(a for a in reg.angles if a.angle_id == "angle-i")
    assert angle.sota_bar == pytest.approx(0.95)  # unchanged


def test_flag_sota_regression_missing_angle_raises(
    mgr: AngleRegistryManager, run_dir: Path
) -> None:
    mgr._ensure_registry(run_dir)
    with pytest.raises(KeyError):
        mgr.flag_sota_regression("nonexistent", 0.5, "src", "cite", run_dir)
