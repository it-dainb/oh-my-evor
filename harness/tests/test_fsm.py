"""§3.1–3.4 — the Python reader over ``contracts/state-machines.json``.

Three languages read this table, and the agreement between them is the property
that matters. RC3: implementing the machine in one language and letting the
others re-derive it is the ``.tree.lock`` mistake — the lock became "a TypeScript
implementation detail rather than a property of the on-disk format".
"""

from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from evor.fsm import (
    IllegalTransition,
    TABLE_PATH,
    append_transition,
    assert_transition,
    guard_for,
    initial_state,
    is_stale,
    is_terminal,
    legal_events,
    load_table,
    max_dwell_s,
    next_state,
)

FSM_TS = Path(__file__).resolve().parents[2] / "mcp" / "src" / "fsm.ts"


class TestTheTableLoads:
    def test_the_three_machines_exist(self):
        assert sorted(load_table()["machines"]) == ["mission", "run", "tick"]

    def test_the_table_ships_where_all_three_languages_look(self):
        assert TABLE_PATH.exists(), f"{TABLE_PATH} is the shared authority; it must be on disk"
        # The TypeScript and JS readers resolve it relative to themselves; if the
        # path moves, all three must move together.
        assert 'state-machines.json' in FSM_TS.read_text()


class TestRecoveryEdgeSurvives:
    """§0.7. The plan requires this asserted, or Phase 3 silently drops it."""

    def test_locked_can_pause(self):
        assert assert_transition("mission", "locked", "pause") == "paused"

    def test_paused_can_return(self):
        assert next_state("mission", "paused", "resume_locked") == "locked"
        assert next_state("mission", "paused", "resume_running") == "running"

    def test_paused_is_not_a_dead_end(self):
        assert is_terminal("mission", "paused") is False
        assert legal_events("mission", "paused")


class TestIllegalTransitionsAreRefused:
    def test_it_names_what_was_legal(self):
        with pytest.raises(IllegalTransition, match=r"Legal from 'completed'"):
            assert_transition("mission", "completed", "pause")

    def test_an_unknown_event_is_illegal(self):
        with pytest.raises(IllegalTransition):
            assert_transition("run", "running", "teleport")

    def test_guards_are_named_but_not_evaluated_here(self):
        # Enforcement is the MCP write path; this reader answers questions.
        assert guard_for("mission", "draft", "lock") == "contract_validated"
        assert guard_for("mission", "locked", "pause") is None


class TestTimedStates:
    """§3.3 — the predicate the system never had."""

    def test_states_that_can_hang_have_a_limit(self):
        for entity, state in [("tick", "running"), ("run", "running"), ("mission", "running")]:
            assert (max_dwell_s(entity, state) or 0) > 0

    def test_stale_is_arithmetic_over_two_fields(self):
        now = datetime(2026, 8, 24, tzinfo=timezone.utc)
        limit = max_dwell_s("tick", "running")
        old = (now - timedelta(seconds=limit + 60)).isoformat()
        fresh = (now - timedelta(seconds=60)).isoformat()
        assert is_stale("tick", "running", old, now) is True
        assert is_stale("tick", "running", fresh, now) is False

    def test_an_unknown_age_is_not_evidence_of_death(self):
        assert is_stale("tick", "running", None) is False
        assert is_stale("tick", "running", "not-a-date") is False

    def test_a_state_with_no_limit_never_goes_stale(self):
        assert is_stale("mission", "completed", "1999-01-01T00:00:00Z") is False


class TestAuditLog:
    """§3.1 — append-only, with a reason recorded when it happens."""

    def test_transitions_are_appended_not_replaced(self, tmp_path: Path):
        append_transition(tmp_path, {"entity": "mission", "from": "locked", "to": "paused", "reason": "session ended"})
        append_transition(tmp_path, {"entity": "mission", "from": "paused", "to": "locked", "reason": "session resumed"})
        lines = (tmp_path / "transitions.jsonl").read_text().strip().split("\n")
        assert len(lines) == 2
        first, second = (json.loads(x) for x in lines)
        assert first["to"] == "paused" and second["to"] == "locked"

    def test_every_entry_is_stamped_when_it_happened(self, tmp_path: Path):
        append_transition(tmp_path, {"entity": "run", "from": "initialized", "to": "running", "reason": "tick 1"})
        entry = json.loads((tmp_path / "transitions.jsonl").read_text())
        # K-08's supersession reason was reconstructed afterwards by a human
        # editing JSON in vim. A reason written later is a reconstruction.
        assert entry["reason"] == "tick 1"
        datetime.fromisoformat(entry["at"].replace("Z", "+00:00"))


class TestAllThreeReadersAgree:
    CASES = [
        ("mission", "locked", "pause"),
        ("mission", "paused", "resume_locked"),
        ("mission", "running", "supersede"),
        ("run", "initialized", "start"),
        ("run", "running", "pause"),
        ("tick", "running", "finish"),
        ("tick", "running", "block"),
        ("tick", "blocked", "unblock"),
    ]

    def test_python_and_javascript_resolve_the_same_edges(self, tmp_path: Path):
        hooks_fsm = Path(__file__).resolve().parents[2] / "hooks" / "lib" / "fsm.mjs"
        probe = tmp_path / "probe.mjs"
        probe.write_text(
            f"import {{ nextState, isTerminal, maxDwellSeconds }} from {hooks_fsm.as_uri()!r};\n"
            "const cases = JSON.parse(process.argv[2]);\n"
            "console.log(JSON.stringify({\n"
            "  edges: cases.map(([e,s,v]) => nextState(e,s,v) ?? null),\n"
            "  terminal: ['completed','failed','superseded','running'].map(s => isTerminal('mission', s)),\n"
            "  dwell: maxDwellSeconds('tick','running'),\n"
            "}));\n"
        )
        out = subprocess.run(
            ["node", str(probe), json.dumps([list(c) for c in self.CASES])],
            capture_output=True, text=True, timeout=30,
        )
        assert out.returncode == 0, out.stderr
        js = json.loads(out.stdout)

        assert js["edges"] == [next_state(*c) for c in self.CASES], (
            "Python and JavaScript disagree about the lifecycle. stop.mjs decides "
            "whether the agent may end its turn and the harness decides whether "
            "the loop continues; if they read the table differently, one of them "
            "is wrong about the mission's state and neither reports it."
        )
        assert js["terminal"] == [is_terminal("mission", s) for s in ("completed", "failed", "superseded", "running")]
        assert js["dwell"] == max_dwell_s("tick", "running")

    def test_typescript_reads_the_same_file(self):
        # The TS half is exercised by mcp/tests/fsm.test.ts; here we only pin that
        # it has not been pointed at a different table.
        src = FSM_TS.read_text()
        m = re.search(r'join\((.*?)"state-machines\.json"\)', src, re.S)
        assert m, "fsm.ts no longer resolves the shared table by that name"
        assert '"contracts"' in m.group(1)
