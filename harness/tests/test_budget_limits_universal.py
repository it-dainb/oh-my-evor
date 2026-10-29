"""Budget limits apply to EVERY mission, and mean what the setup interview says.

The interview asks three questions (``skills/evor-setup/SKILL.md:173``):

    How many iterations (ticks) should Evor run at most?
    What is the plateau window (ticks with no improvement before stopping)?
    Do you want a circuit breaker (max consecutive failures)?

The stop path answered a different set. ``max_iterations`` was enforced only for
``maximize-under-budget``; ``plateau_window`` only for ``worst-angle-plateau``; and
the circuit breaker was ``tick >= circuit_breaker`` — an absolute tick cap, not a
count of anything. For a ``target`` mission that meant:

    max_iterations   never checked
    plateau_window   never checked
    circuit_breaker  the only thing that ever stopped the run

The validator (K-06) then rejected any breaker below the tick budget, because under
the tick-cap reading such a breaker makes the budget unreachable. It was right
about the code and wrong about the intent, and every mission set breaker equal to
the budget to get past it — which, by accident, made the breaker the run's only
working limit. A breaker of 0 or above the budget would have run forever.

And the history both plateau checks read, ``tick_history_scores``, was written by
nothing. ``evor_state_write`` is strict and did not even accept the key.

These cases pin the interview's meaning. Per-tick outcomes now come from
``run_state["tick_records"]``, written once per completed tick.
"""

from __future__ import annotations

from pathlib import Path

from evor.contracts import Budget
from evor.tree import check_stop_condition

from test_classc import _make_budget, _make_engine, _make_goal, _run_state


def _records(*entries: tuple[str, float | None]) -> list[dict]:
    """tick_records: one {tick, outcome, score} per completed tick, ticks 1..n."""
    return [
        {"tick": i, "outcome": outcome, **({"score": score} if score is not None else {})}
        for i, (outcome, score) in enumerate(entries, start=1)
    ]


def _state(tick: int, records: list[dict], best: float = 0.0) -> dict:
    s = _run_state(tick=tick, best_score=best)
    s["tick_records"] = records
    return s


def _goal(**budget):
    # `target` is the mission type that every one of these limits ignored.
    return _make_goal(stop_type="target", baseline=0.10, target=0.99, budget=_make_budget(**budget))


# ── max_iterations is a hard cap for every stop type ─────────────────────────


def test_max_iterations_stops_a_target_mission(tmp_path: Path) -> None:
    goal = _goal(max_iterations=50, plateau_window=50, circuit_breaker=50)
    v = check_stop_condition(goal, _state(50, []), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is True
    assert "max_iterations" in v.reason


def test_max_iterations_not_yet(tmp_path: Path) -> None:
    goal = _goal(max_iterations=50, plateau_window=50, circuit_breaker=50)
    v = check_stop_condition(goal, _state(49, []), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is False, v.reason


# ── the circuit breaker counts CONSECUTIVE FAILED ticks ──────────────────────


def test_breaker_trips_on_consecutive_failures(tmp_path: Path) -> None:
    goal = _goal(max_iterations=50, plateau_window=50, circuit_breaker=3)
    recs = _records(("scored", 0.5), ("failed", None), ("failed", None), ("failed", None))
    v = check_stop_condition(goal, _state(4, recs), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is True
    assert "circuit_breaker" in v.reason and "consecutive" in v.reason


def test_breaker_ignores_non_consecutive_failures(tmp_path: Path) -> None:
    goal = _goal(max_iterations=50, plateau_window=50, circuit_breaker=3)
    recs = _records(("failed", None), ("failed", None), ("scored", 0.5), ("failed", None))
    v = check_stop_condition(goal, _state(4, recs), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is False, v.reason


def test_breaker_is_not_a_tick_cap(tmp_path: Path) -> None:
    """The defect itself: breaker 3, tick 10, every tick improving — must NOT stop."""
    goal = _goal(max_iterations=50, plateau_window=50, circuit_breaker=3)
    # Scores stay under the 0.99 target so only the breaker could stop this run.
    recs = _records(*[("scored", 0.05 * i) for i in range(1, 11)])
    v = check_stop_condition(goal, _state(10, recs, best=0.5), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is False, v.reason


def test_rejected_and_skipped_are_not_failures(tmp_path: Path) -> None:
    """A tick whose proposals were all rejected did not break; it found nothing."""
    goal = _goal(max_iterations=50, plateau_window=50, circuit_breaker=2)
    recs = _records(("rejected", None), ("skipped", None), ("rejected", None))
    v = check_stop_condition(goal, _state(3, recs), _make_engine(goal=goal, tmp_path=tmp_path))
    assert "circuit_breaker" not in v.reason


# ── the plateau window stops every mission that stops improving ──────────────


def test_plateau_stops_a_target_mission(tmp_path: Path) -> None:
    goal = _goal(max_iterations=50, plateau_window=3, circuit_breaker=50)
    recs = _records(("scored", 0.5), ("scored", 0.6), ("scored", 0.6), ("scored", 0.6), ("scored", 0.59))
    v = check_stop_condition(goal, _state(5, recs, best=0.6), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is True
    assert "plateau" in v.reason


def test_plateau_resets_on_improvement_inside_the_window(tmp_path: Path) -> None:
    goal = _goal(max_iterations=50, plateau_window=3, circuit_breaker=50)
    recs = _records(("scored", 0.5), ("scored", 0.6), ("scored", 0.55), ("scored", 0.61), ("scored", 0.6))
    v = check_stop_condition(goal, _state(5, recs, best=0.61), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is False, v.reason


def test_ticks_without_a_score_count_as_no_improvement(tmp_path: Path) -> None:
    goal = _goal(max_iterations=50, plateau_window=3, circuit_breaker=50)
    recs = _records(("scored", 0.6), ("failed", None), ("rejected", None), ("skipped", None))
    v = check_stop_condition(goal, _state(4, recs, best=0.6), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is True
    assert "plateau" in v.reason


def test_plateau_needs_a_full_window(tmp_path: Path) -> None:
    goal = _goal(max_iterations=50, plateau_window=5, circuit_breaker=50)
    recs = _records(("scored", 0.6), ("scored", 0.6), ("scored", 0.6))
    v = check_stop_condition(goal, _state(3, recs, best=0.6), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is False, v.reason


def test_a_first_window_with_no_score_at_all_is_a_plateau(tmp_path: Path) -> None:
    """Five ticks that never produced a score have not improved on anything."""
    goal = _goal(max_iterations=50, plateau_window=3, circuit_breaker=50)
    recs = _records(("rejected", None), ("rejected", None), ("skipped", None))
    v = check_stop_condition(goal, _state(3, recs), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is True
    assert "plateau" in v.reason


# ── a target that is reached still wins ──────────────────────────────────────


def test_reaching_the_target_is_reported_as_the_target(tmp_path: Path) -> None:
    goal = _goal(max_iterations=5, plateau_window=50, circuit_breaker=50)
    v = check_stop_condition(goal, _state(5, [], best=0.995), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is True
    assert v.reason.startswith("target"), v.reason


# ── the cost ceiling is optional, and absent means none ──────────────────────


def test_no_cost_ceiling_is_a_valid_budget(tmp_path: Path) -> None:
    """Local-only runs have no spend to cap. The schema made the field required and
    the validator rejected 0, so missions shipped a nominal $10000 instead."""
    b = Budget(max_iterations=50, plateau_window=50, circuit_breaker=50)
    assert b.max_cost_usd is None
    goal = _make_goal(stop_type="target", baseline=0.1, target=0.99, budget=b)
    v = check_stop_condition(goal, _state(1, []), _make_engine(goal=goal, tmp_path=tmp_path))
    assert v.should_stop is False, v.reason


# ── the validator checks the hazards that remain, not the ones that were fixed ─


import json as _json

from evor.validate import _check_stop_reachable


def _validate_budget(tmp_path: Path, **budget) -> dict:
    (tmp_path / "goal-contract.json").write_text(
        _json.dumps({"stop_condition": {"type": "target"}, "budget": budget})
    )
    return {c.name: c for c in _check_stop_reachable(tmp_path)}


def test_a_breaker_below_the_budget_is_the_normal_case(tmp_path: Path) -> None:
    """K-06 rejected exactly this — breaker 8 on 120 ticks — and every mission
    worked around it by setting the breaker equal to the budget."""
    checks = _validate_budget(tmp_path, max_iterations=120, plateau_window=20, circuit_breaker=8)
    assert checks["circuit_breaker_consistent"].ok is True


def test_a_breaker_longer_than_the_budget_can_never_trip(tmp_path: Path) -> None:
    checks = _validate_budget(tmp_path, max_iterations=10, plateau_window=5, circuit_breaker=11)
    c = checks["circuit_breaker_consistent"]
    assert c.ok is False
    assert "never trip" in c.detail


def test_an_absent_cost_ceiling_is_valid(tmp_path: Path) -> None:
    checks = _validate_budget(tmp_path, max_iterations=120, plateau_window=20, circuit_breaker=8)
    assert checks["cost_ceiling_enforceable"].ok is True


def test_a_zero_ceiling_is_rejected_with_the_true_reason(tmp_path: Path) -> None:
    """The old message said 0 meant unlimited. The stop path reads 0 as no spend."""
    checks = _validate_budget(
        tmp_path, max_iterations=120, plateau_window=20, circuit_breaker=8, max_cost_usd=0
    )
    c = checks["cost_ceiling_enforceable"]
    assert c.ok is False
    assert "permits no spend" in c.detail
    assert "unlimited" not in c.detail
