"""§1.1 / §1.2 — the lifecycle domain model, and its two halves agreeing.

AF6: 58 contract models and not one of them was a ``Mission``, a ``Run`` or a
``Tick``. The three things this system actually is had no type — they lived as
untyped keys in JSON blobs written by a merge-patch that accepted anything, and
"~25 enumerated fixes collapse into 7 once one writer owns run state".

These entities are read from three languages, so the model existing is only half
of it: the Python and TypeScript declarations have to *agree*. A divergence here
is invisible until a run behaves differently depending on which side wrote last,
which is the shape of RC3.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from evor.contracts import (
    TICK_FINAL_STEP,
    Campaign,
    Mission,
    MissionAttempt,
    Run,
    Tick,
    is_run_active,
    is_tick_finished,
)

CONTRACTS_TS = Path(__file__).resolve().parents[2] / "mcp" / "src" / "contracts.ts"


def _ts_enum(name: str) -> list[str]:
    """Members of a `z.enum([...])` declared as `export const <name> = z.enum([...])`."""
    src = CONTRACTS_TS.read_text()
    m = re.search(rf"export const {name} = z\.enum\(\[(.*?)\]\)", src, re.S)
    assert m, f"{name} not found in {CONTRACTS_TS} — this test's parser is stale"
    return re.findall(r'"([^"]+)"', m.group(1))


def _py_literal(name: str) -> list[str]:
    import evor.contracts as c
    from typing import get_args

    return list(get_args(getattr(c, name)))


class TestTickFinishedHasOneDefinition:
    """The predicate was re-derived in five places across three languages."""

    def test_reaching_the_last_step_is_not_finishing_it(self):
        # The exact final r3 tick-state: step 9, still running, integrity failed.
        assert is_tick_finished(TICK_FINAL_STEP, "running") is False, (
            "`stop.mjs:379` had `const finished = step >= 9`, which called this "
            "tick done. It was not done; it was stuck at the last step."
        )

    def test_a_genuinely_finished_tick_is_finished(self):
        assert is_tick_finished(TICK_FINAL_STEP, "done") is True

    @pytest.mark.parametrize("step", [0, 1, 8])
    def test_an_earlier_step_is_never_finished(self, step: int):
        assert is_tick_finished(step, "done") is False

    def test_a_failed_last_step_is_not_finished(self):
        assert is_tick_finished(TICK_FINAL_STEP, "failed") is False


class TestAbsenceIsNotLiveness:
    def test_no_status_is_not_active(self):
        assert is_run_active(None) is False
        assert is_run_active("") is False

    def test_initialized_is_not_active(self):
        assert is_run_active("initialized") is False

    def test_running_is_active(self):
        assert is_run_active("running") is True


class TestTheTwoLanguagesAgree:
    """A divergence here is invisible until a run behaves differently by writer."""

    @pytest.mark.parametrize(
        "py_name,ts_name",
        [("RunStatus", "RunStatusSchema"), ("MissionStatus", "MissionStatusSchema"), ("StepStatus", "StepStatusSchema")],
    )
    def test_enum_members_match(self, py_name: str, ts_name: str):
        assert _py_literal(py_name) == _ts_enum(ts_name), (
            f"{py_name} (Python) and {ts_name} (TypeScript) describe the same "
            "entity from two sides. If they differ, whichever side wrote last wins "
            "and nothing reports the disagreement."
        )

    def test_tick_final_step_matches(self):
        src = CONTRACTS_TS.read_text()
        m = re.search(r"export const TICK_FINAL_STEP = (\d+);", src)
        assert m, "TICK_FINAL_STEP not found in contracts.ts"
        assert int(m.group(1)) == TICK_FINAL_STEP


class TestCampaignNamesWhatR1R2R3Were:
    def test_a_campaign_holds_its_attempts_in_order(self):
        c = Campaign(
            campaign_id="binarization-worldmodel-min98",
            objective="min98 F-measure across 22 domains",
            created_at="2026-08-23T03:47:00Z",
            attempt_ids=["a1", "a2", "a3"],
            status="failed",
        )
        assert c.attempt_ids == ["a1", "a2", "a3"]

    def test_an_attempt_records_why_it_ended_when_it_ended(self):
        a = MissionAttempt(
            attempt_id="a3",
            campaign_id="binarization-worldmodel-min98",
            mission_id="binarization-worldmodel-min98-2026-08-r3",
            ordinal=3,
            started_at="2026-08-23T20:00:00Z",
            ended_at="2026-08-24T00:13:36Z",
            outcome_reason="operator killed the session; 1 tick of 200, 0 promotions",
            supersedes_attempt_id="a2",
        )
        assert a.outcome_reason
        assert a.supersedes_attempt_id == "a2"

    def test_the_model_rejects_an_unknown_key(self):
        # 1.6: the drift that used to be silent.
        with pytest.raises(Exception):
            Mission(mission_id="m", status="locked", created_at="t", updated_at="t", bogus=1)


class TestRunAndTick:
    def test_a_run_carries_its_validated_state_root(self):
        r = Run(run_id="r1", mission_id="m1", status="initialized", state_root="/p/.evor")
        assert r.state_root == "/p/.evor"

    def test_state_root_defaults_to_unset_rather_than_a_guess(self):
        # Q-01: every hook re-derived this from `CLAUDE_PLUGIN_ROOT or cwd`, and
        # when both were wrong all 14 read another project's .evor for 19 hours.
        assert Run(run_id="r1", mission_id="m1", status="initialized").state_root is None

    def test_a_tick_can_say_it_is_blocked(self):
        t = Tick(tick=1, run_id="r1", blocked_on="forge-junior artifact", blocked_since="2026-08-23T21:00:00Z")
        assert t.blocked_on == "forge-junior artifact"

    def test_step_beyond_the_final_step_is_rejected(self):
        with pytest.raises(Exception):
            Tick(tick=1, run_id="r1", current_step=10, step_status="done").model_dump()


class TestAllThreeImplementationsAgree:
    """`is_tick_finished` exists in Python, TypeScript and JavaScript.

    Three copies of a predicate is how it came to be re-derived in five places in
    the first place. The hooks copy carries two extra rules the typed contract
    version does not need — an absent ``step_status`` counts as finished (the
    deliberate false-stop guard) and a failed integrity verdict does not — so the
    implementations are not identical by design. What must hold is that they
    never DISAGREE on a case both can express.
    """

    CASES = [
        # (current_step, step_status, expected)
        (0, "pending", False),
        (8, "done", False),
        (9, "running", False),   # the exact final r3 tick
        (9, "failed", False),
        (9, "pending", False),
        (9, "done", True),
    ]

    def test_python_and_javascript_agree(self, tmp_path):
        import json
        import subprocess

        hooks_lib = Path(__file__).resolve().parents[2] / "hooks" / "lib" / "run-status.mjs"
        script = (
            f"import {{ isTickFinished }} from {hooks_lib.as_uri()!r};\n"
            "const cases = JSON.parse(process.argv[2]);\n"
            "console.log(JSON.stringify(cases.map("
            "([s, st]) => isTickFinished({ current_step: s, step_status: st }))));\n"
        )
        f = tmp_path / "probe.mjs"
        f.write_text(script)
        payload = json.dumps([[c[0], c[1]] for c in self.CASES])
        out = subprocess.run(
            ["node", str(f), payload], capture_output=True, text=True, timeout=30
        )
        assert out.returncode == 0, out.stderr
        js = json.loads(out.stdout)
        py = [is_tick_finished(step, status) for step, status, _ in self.CASES]
        expected = [e for _, _, e in self.CASES]

        assert py == expected, "the Python predicate disagrees with the specification"
        assert js == expected, "the JavaScript predicate disagrees with the specification"
        assert py == js, (
            "Python and JavaScript disagree about whether a tick is finished. "
            "`stop.mjs` decides whether the agent may end its turn and the harness "
            "decides whether the loop continues; if they differ, one of them is "
            "wrong about the mission's state and neither reports it."
        )


class TestConcurrencySemanticsAreDecided:
    """§1.9 — the rule must exist, and must be the same rule in both languages.

    These were never decided, so they were settled by whoever wrote last. O-09 is
    the consequence: three missions in one workspace, overlapping in time, with
    no statement anywhere about whether that was legal — so nothing could be
    called a violation and nothing was.
    """

    def test_the_singletons_are_named(self):
        from evor.contracts import SINGLETON_PER_PARENT

        assert SINGLETON_PER_PARENT == {"tick": "run", "run": "mission", "mission": "campaign"}

    def test_subagents_are_the_one_deliberate_plural(self):
        from evor.contracts import may_overlap

        assert may_overlap("subagent") is True, (
            "fan-out within a tick is what the design exists for; a rule that "
            "forbade it would be a rule against the system working"
        )
        for singleton in ("tick", "run", "mission"):
            assert may_overlap(singleton) is False

    def test_typescript_declares_the_same_rule(self):
        src = CONTRACTS_TS.read_text()
        m = re.search(r"export const SINGLETON_PER_PARENT: Record<string, string> = \{(.*?)\};", src, re.S)
        assert m, "SINGLETON_PER_PARENT not found in contracts.ts"
        ts_pairs = dict(re.findall(r"(\w+):\s*\"(\w+)\"", m.group(1)))

        from evor.contracts import SINGLETON_PER_PARENT

        assert ts_pairs == SINGLETON_PER_PARENT, (
            "a concurrency rule that holds in one language is not a rule. Both "
            "halves read the same files and either can write last."
        )
