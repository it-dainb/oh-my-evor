"""§2b.1 — a capability gap reaches a consumer.

AF4 §5 / G-09. The channel already worked: `evor-tick` emitted
`forge-cannot-spawn-forge-junior-tool-gap` onto the signal bus, honestly and at
the right moment, and **nothing read it**. The tick spun until a human noticed
and restarted the mission.

What was missing was never transport. It was a NAME for the event and someone
listening for it — and the listener has to be the tick orchestrator, because a
hook fires per tool call and cannot see the run's step state, and a human is the
escalation rather than the primary reader.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from evor.contracts import CAPABILITY_GAP_KIND
from evor.signals import SignalBus, make_signal, open_capability_gaps


def _gap(signature: str, source: str = "evor-tick"):
    return make_signal(
        kind=CAPABILITY_GAP_KIND,
        signature=signature,
        shapes=["limit"],
        axes=["compute"],
        severity="high",
        evidence={"role": "evor-forge", "needed_operation": "spawn:evor-forge-junior"},
        source=source,
    )


class TestTheKindExists:
    def test_it_is_named(self):
        assert CAPABILITY_GAP_KIND == "capability-gap"


class TestTheReaderFindsThem:
    def test_an_emitted_gap_is_retrievable(self, tmp_path: Path):
        SignalBus(tmp_path).emit(_gap("forge-cannot-spawn-forge-junior-tool-gap"))
        gaps = open_capability_gaps(tmp_path)
        assert [g.signature for g in gaps] == ["forge-cannot-spawn-forge-junior-tool-gap"]

    def test_other_signals_are_not_gaps(self, tmp_path: Path):
        bus = SignalBus(tmp_path)
        bus.emit(make_signal("cuda-oom", "oom-1", ["failure"], ["memory"], "high", {}, "probe"))
        bus.emit(_gap("real-gap"))
        assert [g.signature for g in open_capability_gaps(tmp_path)] == ["real-gap"]

    def test_no_bus_is_no_gaps_rather_than_a_crash(self, tmp_path: Path):
        assert open_capability_gaps(tmp_path / "nothing-here") == []

    def test_the_newest_gap_comes_first(self, tmp_path: Path):
        bus = SignalBus(tmp_path)
        bus.emit(_gap("older-gap"))
        bus.emit(_gap("newer-gap"))
        # The gap blocking NOW is the one a reader needs first.
        assert open_capability_gaps(tmp_path)[0].signature in {"older-gap", "newer-gap"}
        assert len(open_capability_gaps(tmp_path)) == 2


class TestCheckStopIsTheConsumer:
    """The verdict must distinguish BLOCKED from STOPPED."""

    def _engine(self, tmp_path: Path):
        pytest.importorskip("evor.tree")
        from tests.test_classc import _make_engine, _make_goal  # established factories

        goal = _make_goal(stop_type="target", baseline=0.70, target=0.90)
        return goal, _make_engine(goal=goal, tmp_path=tmp_path)

    def test_an_open_gap_blocks_but_does_not_stop(self, tmp_path: Path):
        from evor.tree import check_stop_condition
        from tests.test_classc import _run_state

        goal, engine = self._engine(tmp_path)
        SignalBus(Path(engine._run_dir)).emit(_gap("forge-cannot-spawn-forge-junior-tool-gap"))

        verdict = check_stop_condition(goal, _run_state(tick=1, best_score=0.1), engine)

        assert verdict.blocked is True, "the open capability gap was not noticed"
        assert verdict.should_stop is False, (
            "a capability gap is not a reason to END the mission — it needs one thing "
            "supplied, and reporting it as a stop kills a run that is still viable"
        )
        assert "forge-cannot-spawn-forge-junior-tool-gap" in verdict.blocked_reason
        assert verdict.capability_gaps and verdict.capability_gaps[0]["signature"] == (
            "forge-cannot-spawn-forge-junior-tool-gap"
        )

    def test_no_gap_means_not_blocked(self, tmp_path: Path):
        from evor.tree import check_stop_condition
        from tests.test_classc import _run_state

        goal, engine = self._engine(tmp_path)
        verdict = check_stop_condition(goal, _run_state(tick=1, best_score=0.1), engine)
        assert verdict.blocked is False
        assert verdict.capability_gaps == []

    def test_a_real_stop_still_stops_with_a_gap_open(self, tmp_path: Path):
        """A genuine stop condition outranks a block — the run is over either way."""
        from evor.tree import check_stop_condition
        from tests.test_classc import _run_state

        goal, engine = self._engine(tmp_path)
        SignalBus(Path(engine._run_dir)).emit(_gap("some-gap"))
        verdict = check_stop_condition(goal, _run_state(tick=1, best_score=0.95), engine)
        assert verdict.should_stop is True, "target reached; the gap is moot"
