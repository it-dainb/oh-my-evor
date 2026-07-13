"""Tests for the Signal schema + SignalBus (emit/dedup/query/digest/drain_inbox)."""

import json
from pathlib import Path

from evor.contracts import EvolutionBounds, Signal
from evor.signals import SignalBus, make_signal


def test_signal_schema_facets_closed():
    s = make_signal(
        kind="cuda-oom",
        signature="cuda-oom-bs256",
        shapes=["failure", "limit"],
        axes=["memory", "compute"],
        severity="high",
        evidence={"batch": 256, "vram_gb": 16},
        source="self-heal-monitor",
    )
    assert s.kind == "cuda-oom"
    assert set(s.shapes) == {"failure", "limit"}
    assert s.severity == "high"
    # round-trips through JSON
    assert Signal.model_validate_json(s.model_dump_json()).signature == s.signature


def test_emit_and_dedup_aggregates(tmp_path: Path):
    bus = SignalBus(tmp_path)
    bus.emit(make_signal("slow-train", "slow-train-cand", ["limit"], ["compute", "cost"],
                         "medium", {"wall_min": 18}, "evor-forge-analyst", tick=1))
    # same signature, harder severity → aggregate + escalate severity
    final = bus.emit(make_signal("slow-train", "slow-train-cand", ["trend"], ["compute"],
                                 "high", {"wall_min": 22}, "evor-forge-analyst", tick=2))
    assert final.occurrences == 2
    assert final.severity == "high"          # max severity wins
    assert final.confidence > 0.5            # recurrence raises confidence
    assert set(final.shapes) == {"limit", "trend"}  # facets unioned
    assert len(bus.query()) == 1             # still one deduped record


def test_query_by_facet_and_severity(tmp_path: Path):
    bus = SignalBus(tmp_path)
    bus.emit(make_signal("oom", "oom-x", ["failure"], ["memory"], "critical", {}, "m"))
    bus.emit(make_signal("class-confusion", "cc-cat-dog", ["limit"], ["accuracy"], "medium", {}, "p"))
    bus.emit(make_signal("noise", "noise-lo", ["limit"], ["data"], "low", {}, "p"))

    # Mutagen's lens: limit|opportunity|trend across all axes, medium+
    mutagen = bus.query(shapes=["limit", "opportunity", "trend"], min_severity="medium")
    kinds = {s.kind for s in mutagen}
    assert "class-confusion" in kinds       # limit + medium → in
    assert "noise" not in kinds             # low severity → filtered
    assert "oom" not in kinds               # failure shape, not limit/opp/trend

    # Selector's lens: failure|limit on memory
    selector = bus.query(shapes=["failure", "limit"], axes=["memory"])
    assert {s.kind for s in selector} == {"oom"}

    # highest severity sorts first
    allsig = bus.query()
    assert allsig[0].severity == "critical"


def test_digest_floor(tmp_path: Path):
    bus = SignalBus(tmp_path)
    bus.emit(make_signal("hi", "hi", ["limit"], ["accuracy"], "high", {"x": 1}, "s"))
    bus.emit(make_signal("lo", "lo", ["limit"], ["accuracy"], "low", {}, "s"))
    d = bus.digest(shapes=["limit"], min_severity="medium")
    assert len(d) == 1 and d[0]["kind"] == "hi"      # low dropped from digest


def test_evolution_bounds_defaults_monotonic():
    eb = EvolutionBounds()
    assert eb.benchmark_may_harden is True
    assert eb.primary_metric_frozen is True                    # can't soften
    assert eb.comparability_change_requires_consent is True    # gated


def test_autonomy_charter_defaults():
    from evor.contracts import AutonomyCharter
    c = AutonomyCharter()
    assert c.posture == "aggressive-never-halt"       # never stops for a human
    assert c.license_gate is False                     # research mode: acquire freely
    assert c.data_acquisition_enabled is True
    assert "no-test-leakage" in c.always_on_checks     # the invariant stays on
    assert "comparability-eval-version" in c.always_on_checks
    assert "monotonic" in c.invariant.lower()


def test_reward_hacking_flags_leakage_not_success():
    """The bug: a big legit improvement over baseline was flagged as hacking.
    Fix: only near-perfect val (leakage ceiling) or a per-step spike is flagged."""
    from types import SimpleNamespace
    from evor.integrity import IntegrityGate
    gate = IntegrityGate.__new__(IntegrityGate)  # method uses no self attrs
    goal = SimpleNamespace(
        metric_specs=[SimpleNamespace(metric_name="acc", role="primary_fitness")],
        baseline_value=0.2035,
    )
    # baseline 0.20 -> 0.38 = +88% relative but sub-ceiling → legitimate SUCCESS, NOT hacking
    assert gate._check_reward_hacking(SimpleNamespace(metrics={"acc": 0.382}, telemetry_summary={}), goal) is False
    # near-perfect on a hard task with corroboration → leakage signature → flagged
    assert gate._check_reward_hacking(SimpleNamespace(metrics={"acc": 0.99}, telemetry_summary={}), goal, corroborated=True) is True
    # sudden per-step val spike → flagged
    assert gate._check_reward_hacking(SimpleNamespace(metrics={"acc": 0.5}, telemetry_summary={"val_series": [0.2, 0.25, 0.9]}), goal) is True


# ── drain_inbox tests ─────────────────────────────────────────────────────────

def _inbox_entry(
    kind: str = "hook-capture",
    signature: str = "hook-capture:abc123def45678",
    shapes: list | None = None,
    axes: list | None = None,
    severity: str = "medium",
    evidence: dict | None = None,
    source: str = "hook:Bash",
) -> str:
    """Return a JSON inbox line matching the finalized hook drain contract."""
    return json.dumps({
        "kind": kind,
        "signature": signature,
        "shapes": shapes or ["limit"],
        "axes": axes or ["compute"],
        "severity": severity,
        "evidence": evidence or {"description": "test capture"},
        "source": source,
        "created_at": "2026-07-06T00:00:00Z",
    })


def test_drain_inbox_deduplicates_and_empties(tmp_path: Path):
    """Two inbox lines with the same signature → 1 deduped signal, occurrences==2, inbox cleared."""
    inbox = tmp_path / "signals-inbox.jsonl"
    line = _inbox_entry()
    inbox.write_text(line + "\n" + line + "\n")

    from evor.signals import SignalBus, drain_inbox
    bus = SignalBus(tmp_path)
    count = drain_inbox(tmp_path, bus)

    assert count == 2                       # two lines were processed
    signals = bus.query()
    assert len(signals) == 1               # deduped to one record
    assert signals[0].occurrences == 2     # aggregated
    assert signals[0].kind == "hook-capture"
    assert not inbox.exists()              # inbox cleared after drain


def test_drain_inbox_skips_malformed_line(tmp_path: Path):
    """A malformed inbox line is skipped; a valid line is drained correctly."""
    inbox = tmp_path / "signals-inbox.jsonl"
    good = _inbox_entry(kind="oom", signature="oom:cafebabe00000000",
                        shapes=["failure"], axes=["memory"], severity="high")
    inbox.write_text("not-valid-json\n" + good + "\n")

    from evor.signals import SignalBus, drain_inbox
    bus = SignalBus(tmp_path)
    count = drain_inbox(tmp_path, bus)

    assert count == 1                      # only the valid line counted
    signals = bus.query()
    assert len(signals) == 1
    assert signals[0].kind == "oom"
    assert not inbox.exists()


def test_drain_inbox_exposed_via_query(tmp_path: Path):
    """Inbox signals are visible through query() without an explicit drain call."""
    inbox = tmp_path / "signals-inbox.jsonl"
    inbox.write_text(_inbox_entry(
        kind="gradient-spike",
        signature="gradient-spike:1122334455667788",
        shapes=["trend"],
        axes=["stability"],
        severity="high",
        evidence={"step": 42},
    ) + "\n")

    from evor.signals import SignalBus
    bus = SignalBus(tmp_path)
    # No explicit drain call — query() drains lazily
    signals = bus.query()
    assert len(signals) == 1
    assert signals[0].kind == "gradient-spike"
    assert not inbox.exists()


def test_drain_inbox_idempotent_no_inbox(tmp_path: Path):
    """drain_inbox returns 0 and does nothing when no inbox file exists."""
    from evor.signals import SignalBus, drain_inbox
    bus = SignalBus(tmp_path)
    assert drain_inbox(tmp_path, bus) == 0
    assert bus.query() == []


def test_drain_inbox_cli(tmp_path: Path):
    """python -m evor signals drain --run-dir <dir> exits 0 and reports drained count."""
    import subprocess
    import sys
    _HARNESS_DIR = Path(__file__).resolve().parent.parent
    inbox = tmp_path / "signals-inbox.jsonl"
    inbox.write_text(_inbox_entry() + "\n")

    result = subprocess.run(
        [sys.executable, "-m", "evor", "signals", "drain", "--run-dir", str(tmp_path)],
        capture_output=True, text=True, cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0, f"CLI failed:\n{result.stderr}"
    data = json.loads(result.stdout)
    assert data["ok"] is True
    assert data["drained"] == 1
    assert not inbox.exists()
