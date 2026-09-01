"""Wave-1 RED — category 4: durability and audit (harness side).

Field-trace findings under test (docs/field-trace-v1.2.0/):

  I-01  decision-log.md recorded nothing but per-node stubs across all three
        field missions. Two mission restarts, seven waves of plugin patching,
        an evaluator rewrite and four gate changes left no entry.
  O-09  Two superseded missions were hand-backfilled from status "running" to
        "failed" 14h39m after the fact, in a single write, 40 seconds AFTER
        their successor had already been created and started.
  P-02  Live run state (active-run.json, mission-state.json, throttle files)
        was written INSIDE the installed plugin cache and the marketplace
        clone, making reinstall destructive of run history and leaking one
        project's mission into every future project.

Every test here asserts the invariant the code SHOULD hold. They are expected
to fail against the current implementation; that is the point of the RED phase.
No production file is modified by this module.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evor.artifacts import write_artifact
from evor.init_run import run_init_run
from evor.signals import SignalBus, make_signal


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures / helpers
# ─────────────────────────────────────────────────────────────────────────────


def _answers(mission_id: str) -> dict:
    """A complete, valid GoalContract answers dict (shape copied from
    test_init_run._minimal_answers so this module fails on its assertions,
    never on contract validation)."""
    return {
        "mission_id": mission_id,
        "mode": "from-scratch",
        "mission_type": "fixed",
        "task_description": "Binarise degraded palm-leaf manuscript images",
        "dataset_ref": "/data/dibco",
        "metrics": [{"name": "fmeasure", "direction": "higher", "primary": True}],
        "metric_specs": [
            {
                "metric_name": "fmeasure",
                "direction": "higher",
                "domain_applicability": "all",
                "aggregation_rule": "macro_avg",
                "role": "primary_fitness",
            }
        ],
        "fitness_mode": "aggregate",
        "eval_version": "v1",
        "baseline_value": 0.59,
        "target_value": 0.85,
        "coverage_target": None,
        "stop_condition": {"type": "target"},
        "wildness": 0.5,
        "budget": {
            "max_iterations": 200,
            "plateau_window": 5,
            "circuit_breaker": 3,
            "max_cost_usd": 50.0,
        },
        "framework": "pytorch",
        "seed_repo_path": None,
        "locked_split_hash": "abc123deadbeef",
        "eval_script_hash": "def456cafebabe",
        "expansion_policy": None,
        "allowed_licenses": ["MIT", "Apache-2.0"],
        "evolution_bounds": None,
        "autonomy_charter": None,
        "created_at": "2026-08-23T03:47:00+00:00",
    }


def _init(tmp_path: Path, evor_root: Path, mission_id: str, run_id: str) -> Path:
    """Initialise a mission run under *evor_root*; return its run_dir."""
    answers_path = tmp_path / f"answers-{mission_id}.json"
    answers_path.write_text(json.dumps(_answers(mission_id)))
    rc = run_init_run(
        str(answers_path),
        run_id_arg=run_id,
        mission_id_arg=mission_id,
        evor_root_arg=str(evor_root),
    )
    assert rc == 0, "fixture setup failed: run_init_run did not succeed"
    return evor_root / "runs" / mission_id / run_id


def _plugin_root(tmp_path: Path) -> Path:
    """A directory that is unambiguously an installed Claude Code plugin.

    Mirrors the real layout of
    ~/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/, which is where the
    field run actually wrote its state (P-02).
    """
    root = tmp_path / "plugins" / "cache" / "oh-my-evor" / "oh-my-evor" / "1.2.0"
    (root / ".claude-plugin").mkdir(parents=True)
    (root / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "oh-my-evor", "version": "1.2.0"})
    )
    return root


# ─────────────────────────────────────────────────────────────────────────────
# I-01 — a mission restart is a decision, and must reach the decision log
# ─────────────────────────────────────────────────────────────────────────────


def test_starting_a_successor_mission_logs_the_supersede_in_the_prior_run(
    tmp_path: Path,
) -> None:
    """Invariant: creating a new mission while an earlier one is live must
    leave a supersede entry in the earlier run's decision-log.md.

    In the field this happened twice (r1→r2 at 10:41, r2→r3 at 23:51) and
    neither restart appears anywhere in any decision log. The decision log is
    the only durable narrative artifact a run produces; a restart is the single
    largest decision a mission can make, so if anything belongs in it, this
    does. `evor.init_run.run_init_run` is the writer for a mission's opening
    artifacts and is therefore the code path that knows a successor is being
    created — it reads/writes active-run.json, which names the predecessor.
    """
    evor_root = tmp_path / ".evor"
    r1_dir = _init(tmp_path, evor_root, "binarization-r1", "run-live-01")
    r1_log_before = (r1_dir / "decision-log.md").read_text()

    _init(tmp_path, evor_root, "binarization-r2", "run-live-01")

    r1_log_after = (r1_dir / "decision-log.md").read_text()
    added = r1_log_after[len(r1_log_before):]

    assert added.strip(), (
        "starting mission 'binarization-r2' left NO entry in the superseded run's "
        "decision-log.md — the restart is invisible in the durable record "
        "(field-trace I-01)"
    )
    assert "binarization-r2" in added, (
        "the superseded run's decision log gained an entry that does not name "
        f"the successor mission:\n{added}"
    )


def test_starting_a_successor_mission_closes_out_the_prior_mission_state(
    tmp_path: Path,
) -> None:
    """Invariant: two missions in the same .evor/ root must never be live at
    once — creating a successor must transition the predecessor out of its
    live state at the moment of the decision, not 14 hours later.

    Choice of invariant (O-09/I-11): the field artifact shows THREE missions
    concurrently reading status "running", closed out by a single retroactive
    write 40 seconds after r3's own mission-state was created. Of the three
    candidate invariants (reject the retroactive write / record it as a dated
    correction / prevent the state that requires it), preventing the overlap is
    the one the code most plausibly should hold: the predecessor's status is
    known to be stale exactly when the successor is created, and init_run is
    already the writer of both mission-state.json and active-run.json. A rule
    that permits the overlap and only demands honest bookkeeping later cannot
    be enforced by any single writer.
    """
    evor_root = tmp_path / ".evor"
    r1_dir = _init(tmp_path, evor_root, "binarization-r1", "run-live-01")

    # r1 is live — exactly the state the field run's r1 and r2 were left in.
    r1_state_path = r1_dir / "mission-state.json"
    r1_state = json.loads(r1_state_path.read_text())
    r1_state["status"] = "running"
    r1_state_path.write_text(json.dumps(r1_state, indent=2))

    _init(tmp_path, evor_root, "binarization-r2", "run-live-01")

    # The bootstrapper has already repointed the root's single active-run
    # pointer at the successor, so r1 is no longer the mission being executed.
    active = json.loads((evor_root / "active-run.json").read_text())
    assert active["mission_id"] == "binarization-r2", (
        "fixture assumption broken: active-run.json did not move to the successor"
    )

    r1_after = json.loads(r1_state_path.read_text())
    assert r1_after["status"] not in {"running", "locked"}, (
        "binarization-r1 still reads status="
        f"{r1_after['status']!r} after binarization-r2 took over active-run.json "
        "— an orphaned mission left live is exactly the state that had to be "
        "hand-backfilled 14h39m later (field-trace O-09)"
    )


def test_closing_out_a_mission_records_why_and_when(tmp_path: Path) -> None:
    """Invariant: a mission leaving its live state must record a reason and a
    timestamp for that transition, in the same write that changes the status.

    The field run's supersede reason was typed by hand into two files after the
    fact, and I-11 shows it disagreed with the run's own tick-state halt_reason.
    A reason produced by the transition itself cannot drift from the state that
    caused it.
    """
    evor_root = tmp_path / ".evor"
    r1_dir = _init(tmp_path, evor_root, "binarization-r1", "run-live-01")
    r1_state_path = r1_dir / "mission-state.json"
    r1_state = json.loads(r1_state_path.read_text())
    r1_state["status"] = "running"
    r1_state_path.write_text(json.dumps(r1_state, indent=2))

    _init(tmp_path, evor_root, "binarization-r2", "run-live-01")

    after = json.loads(r1_state_path.read_text())
    reason_fields = [
        k for k in ("superseded_reason", "status_reason", "reason") if after.get(k)
    ]
    assert reason_fields, (
        "the superseded mission carries no machine-written reason for leaving "
        f"its live state; mission-state.json keys = {sorted(after)}"
    )
    assert after.get("superseded_by") or after.get("superseded_by_run_id"), (
        "the superseded mission does not name its successor"
    )


# ─────────────────────────────────────────────────────────────────────────────
# P-02 — no harness writer may put run state inside the installed plugin
# ─────────────────────────────────────────────────────────────────────────────


def test_signal_bus_refuses_a_run_dir_inside_an_installed_plugin(
    tmp_path: Path,
) -> None:
    """Invariant: SignalBus must refuse to write signals.jsonl under a plugin
    root. Run state belongs to the project; the installed artifact must stay
    stateless so a reinstall is never destructive of run history (P-02).
    """
    run_dir = _plugin_root(tmp_path) / ".evor" / "runs" / "frontier-1ms" / "run-live-01"
    run_dir.mkdir(parents=True)
    bus = SignalBus(run_dir)

    with pytest.raises(Exception) as exc:
        bus.emit(
            make_signal(
                "orchestration-stall",
                "stall-tick-1",
                ["failure"],
                ["compute"],
                "critical",
                {},
                "self-heal-monitor",
            )
        )
    assert "plugin" in str(exc.value).lower(), (
        "SignalBus raised, but not for the reason under test: " f"{exc.value!r}"
    )
    assert not (run_dir / "signals.jsonl").exists(), (
        "SignalBus wrote signals.jsonl inside the installed plugin tree"
    )


def test_write_artifact_refuses_a_run_dir_inside_an_installed_plugin(
    tmp_path: Path,
) -> None:
    """Invariant: write_artifact must refuse a run_dir under a plugin root.

    write_artifact reports failure by return value rather than by raising, so
    the refusal is asserted on the returned envelope AND on the filesystem —
    a returned error that still wrote the file would not close this finding.
    """
    run_dir = _plugin_root(tmp_path) / ".evor" / "runs" / "frontier-1ms" / "run-live-01"
    run_dir.mkdir(parents=True)

    result = write_artifact(
        run_dir=run_dir,
        tick=1,
        agent="probe",
        payload={"eda_summary": "x", "hypothesis_verdict": "y"},
    )

    assert "error" in result, (
        "write_artifact accepted a run_dir inside the installed plugin tree "
        f"and returned {result!r} (field-trace P-02)"
    )
    assert "plugin" in result["error"].lower(), (
        f"write_artifact failed for an unrelated reason: {result['error']!r}"
    )
    assert not list(run_dir.rglob("*.json")), (
        "write_artifact wrote into the installed plugin tree despite reporting "
        "an error"
    )


def test_init_run_refuses_an_evor_root_inside_an_installed_plugin(
    tmp_path: Path,
) -> None:
    """Invariant: the mission bootstrapper must refuse a state root inside the
    installed plugin.

    This is the writer that produced the field artifacts P-02 actually found:
    active-run.json and runs/frontier-1ms/run-live-01/mission-state.json, both
    living inside the plugin cache and the marketplace clone.
    """
    plugin_root = _plugin_root(tmp_path)
    evor_root = plugin_root / ".evor"
    answers_path = tmp_path / "answers.json"
    answers_path.write_text(json.dumps(_answers("frontier-1ms")))

    rc = run_init_run(
        str(answers_path),
        run_id_arg="run-live-01",
        mission_id_arg="frontier-1ms",
        evor_root_arg=str(evor_root),
    )

    assert rc == 1, (
        "run_init_run bootstrapped a mission inside the installed plugin tree "
        "(field-trace P-02)"
    )
    assert not (evor_root / "active-run.json").exists(), (
        "active-run.json was written inside the installed plugin tree"
    )
