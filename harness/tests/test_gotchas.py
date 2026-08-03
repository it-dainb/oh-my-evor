"""
Tests for the Gotcha knowledge layer.

Coverage:
  GotchaStore.add_gotcha:
    test_add_new_gotcha                — new entry is written and returned
    test_add_dedup_increments          — same (signature, scope) increments occurrences
    test_add_dedup_raises_confidence   — confidence increases on repeat
    test_add_dedup_updates_last_seen   — last_seen is updated; first_seen preserved
    test_add_dedup_merges_context      — context dict is merged (new keys take precedence)
    test_add_global_vs_mission_separate — global and mission entries stored separately
    test_add_atomic_write              — concurrent add does not corrupt the file
    test_add_global_no_mission_dir     — mission-scoped entry goes to global when no run_dir

  GotchaStore.query_gotchas:
    test_query_all                     — no filters returns all entries
    test_query_by_kind                 — kind filter works
    test_query_by_scope                — scope filter works
    test_query_by_min_confidence       — min_confidence filter works
    test_query_context_filter          — context_filter matches on key/value pairs
    test_query_sorted_by_confidence    — highest confidence first
    test_query_includes_both_scopes    — global + mission entries both returned when no scope filter
    test_query_empty_store             — returns [] when no files exist

  GotchaStore.matches_known_failure:
    test_matches_known_failure_found   — returns entry when signature matches above threshold
    test_matches_known_failure_miss    — returns None when signature absent

  SelfHealMonitor OOM → gotcha captured:
    test_monitor_oom_captures_gotcha   — feed_stderr OOM line → gotcha in store
    test_monitor_nan_captures_gotcha   — feed_stderr NaN line → gotcha in store
    test_monitor_give_up_captures_gotcha — exhaust retries → give_up gotcha with higher confidence
    test_monitor_no_store_no_error     — monitor without gotcha_store still works
    test_monitor_evor_root_builds_store — evor_root kwarg auto-builds GotchaStore

  CapabilityProfile probe (CPU-only, graceful):
    test_probe_cpu_only_no_crash       — probe_capability returns cpu_only=True without raising
    test_probe_writes_capability_json  — capability.json is created at evor_root
    test_probe_seeds_hw_constraints    — cpu-only box seeds no-gpu + 3 arch constraints
    test_probe_read_roundtrip          — read_capability returns the written profile
    test_probe_read_none_when_absent   — read_capability returns None when file absent
    test_probe_repeated_seeds_dedup    — re-running probe deduplicates (occurrences increases)

  Selector avoidance (config matches known failure):
    test_selector_rejects_matching_signature  — matches_known_failure finds high-conf gotcha
    test_selector_passes_different_signature  — no match when signature differs
    test_selector_passes_low_confidence       — below min_confidence threshold is not blocked

  python -m evor gotchas --help:
    test_gotchas_subcommand_help_exits_zero   — --help exits 0
    test_gotchas_subcommand_runs_empty_store  — empty store returns JSON with gotchas=[]
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evor.capability import probe_capability, read_capability
from evor.contracts import GotchaEntry
from evor.gotchas import GotchaStore, make_gotcha

# Portable harness dir (this file lives in <harness>/tests/). Works on the host
# and inside the container (where the repo mounts at /plugin) — do NOT hardcode.
_HARNESS_DIR = Path(__file__).resolve().parent.parent
from evor.monitor import SelfHealMonitor


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _make_entry(
    signature: str = "cuda-oom",
    kind: str = "runtime-failure",
    scope: str = "global",
    confidence: float = 0.6,
    occurrences: int = 1,
    context: dict | None = None,
) -> GotchaEntry:
    now = datetime.now(timezone.utc).isoformat()
    return GotchaEntry(
        gotcha_id=f"gotcha-test-{signature}",
        kind=kind,  # type: ignore[arg-type]
        signature=signature,
        context=context or {"task": "cifar10", "batch_size": 256},
        resolution="Reduced batch_size to 128.",
        avoidance="Do not use batch_size > 128 on this task.",
        scope=scope,  # type: ignore[arg-type]
        confidence=confidence,
        occurrences=occurrences,
        first_seen=now,
        last_seen=now,
    )


# ─────────────────────────────────────────────────────────────────────────────
# GotchaStore.add_gotcha
# ─────────────────────────────────────────────────────────────────────────────

class TestAddGotcha:
    def test_add_new_gotcha(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        entry = _make_entry()
        result = store.add_gotcha(entry)
        assert result.signature == "cuda-oom"
        assert result.occurrences == 1

    def test_add_dedup_increments_occurrences(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        entry = _make_entry()
        store.add_gotcha(entry)
        store.add_gotcha(_make_entry())  # same signature+scope
        result = store.add_gotcha(_make_entry())
        assert result.occurrences == 3

    def test_add_dedup_raises_confidence(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        e = _make_entry(confidence=0.5)
        store.add_gotcha(e)
        result = store.add_gotcha(e)
        assert result.confidence > 0.5

    def test_add_dedup_updates_last_seen(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        now1 = "2026-01-01T00:00:00+00:00"
        now2 = "2026-06-01T00:00:00+00:00"
        e1 = GotchaEntry(
            gotcha_id="g1", kind="runtime-failure", signature="sig-a",
            context={}, resolution="r", avoidance="a",
            scope="global", confidence=0.5, occurrences=1,
            first_seen=now1, last_seen=now1,
        )
        store.add_gotcha(e1)
        e2 = GotchaEntry(
            gotcha_id="g1", kind="runtime-failure", signature="sig-a",
            context={}, resolution="r2", avoidance="a2",
            scope="global", confidence=0.5, occurrences=1,
            first_seen=now2, last_seen=now2,
        )
        result = store.add_gotcha(e2)
        assert result.first_seen == now1          # preserved
        assert result.last_seen >= now2           # updated

    def test_add_dedup_merges_context(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        e1 = _make_entry(context={"batch_size": 256})
        store.add_gotcha(e1)
        e2 = _make_entry(context={"lr": 0.001})
        result = store.add_gotcha(e2)
        assert "batch_size" in result.context
        assert "lr" in result.context

    def test_add_global_vs_mission_separate(self, tmp_path: Path) -> None:
        run_dir = tmp_path / ".evor" / "runs" / "m" / "r"
        run_dir.mkdir(parents=True)
        store = GotchaStore(tmp_path / ".evor", run_dir)
        store.add_gotcha(_make_entry(signature="g-global", scope="global"))
        store.add_gotcha(_make_entry(signature="g-mission", scope="mission"))

        globals_ = store.query_gotchas(scope="global")
        missions = store.query_gotchas(scope="mission")
        assert any(g.signature == "g-global" for g in globals_)
        assert any(g.signature == "g-mission" for g in missions)
        assert not any(g.signature == "g-mission" for g in globals_)

    def test_add_global_no_mission_dir(self, tmp_path: Path) -> None:
        """When no mission_run_dir, mission-scoped entry falls back to global store."""
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_make_entry(signature="fallback-to-global", scope="mission"))
        # Should appear in global path
        global_path = tmp_path / ".evor" / "wiki" / "gotchas" / "global.jsonl"
        assert global_path.exists()
        data = [json.loads(l) for l in global_path.read_text().splitlines() if l.strip()]
        assert any(d["signature"] == "fallback-to-global" for d in data)


# ─────────────────────────────────────────────────────────────────────────────
# GotchaStore.query_gotchas
# ─────────────────────────────────────────────────────────────────────────────

class TestQueryGotchas:
    def _populated_store(self, tmp_path: Path) -> GotchaStore:
        run_dir = tmp_path / ".evor" / "runs" / "m" / "r"
        run_dir.mkdir(parents=True)
        store = GotchaStore(tmp_path / ".evor", run_dir)
        store.add_gotcha(_make_entry("cuda-oom",     kind="runtime-failure",    scope="global",  confidence=0.8))
        store.add_gotcha(_make_entry("nan-loss",     kind="runtime-failure",    scope="mission", confidence=0.6))
        store.add_gotcha(_make_entry("no-gpu",       kind="hardware-constraint",scope="global",  confidence=1.0))
        store.add_gotcha(_make_entry("dead-arch",    kind="approach-deadend",   scope="global",  confidence=0.7))
        return store

    def test_query_all(self, tmp_path: Path) -> None:
        store = self._populated_store(tmp_path)
        results = store.query_gotchas()
        assert len(results) == 4

    def test_query_by_kind(self, tmp_path: Path) -> None:
        store = self._populated_store(tmp_path)
        rt = store.query_gotchas(kind="runtime-failure")
        assert all(g.kind == "runtime-failure" for g in rt)
        assert len(rt) == 2

    def test_query_by_scope(self, tmp_path: Path) -> None:
        store = self._populated_store(tmp_path)
        global_g = store.query_gotchas(scope="global")
        assert all(g.scope == "global" for g in global_g)
        mission_g = store.query_gotchas(scope="mission")
        assert all(g.scope == "mission" for g in mission_g)

    def test_query_by_min_confidence(self, tmp_path: Path) -> None:
        store = self._populated_store(tmp_path)
        high = store.query_gotchas(min_confidence=0.8)
        assert all(g.confidence >= 0.8 for g in high)
        assert all(g.signature in ("cuda-oom", "no-gpu") for g in high)

    def test_query_context_filter(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_make_entry("oom-big-batch", context={"batch_size": 256, "task": "cifar10"}))
        store.add_gotcha(_make_entry("oom-small-task", context={"batch_size": 32, "task": "cifar10"}))
        results = store.query_gotchas(context_filter={"batch_size": 256})
        assert len(results) == 1
        assert results[0].signature == "oom-big-batch"

    def test_query_sorted_by_confidence(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_make_entry("low",  confidence=0.3))
        store.add_gotcha(_make_entry("high", confidence=0.9))
        store.add_gotcha(_make_entry("med",  confidence=0.6))
        results = store.query_gotchas()
        confs = [g.confidence for g in results]
        assert confs == sorted(confs, reverse=True)

    def test_query_includes_both_scopes(self, tmp_path: Path) -> None:
        store = self._populated_store(tmp_path)
        results = store.query_gotchas()
        sigs = {g.signature for g in results}
        assert "cuda-oom" in sigs
        assert "nan-loss" in sigs

    def test_query_empty_store(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        assert store.query_gotchas() == []


# ─────────────────────────────────────────────────────────────────────────────
# GotchaStore.matches_known_failure
# ─────────────────────────────────────────────────────────────────────────────

class TestMatchesKnownFailure:
    def test_matches_known_failure_found(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_make_entry("cuda-oom", confidence=0.9))
        match = store.matches_known_failure("cuda-oom", min_confidence=0.7)
        assert match is not None
        assert match.signature == "cuda-oom"

    def test_matches_known_failure_miss(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_make_entry("cuda-oom", confidence=0.9))
        assert store.matches_known_failure("nan-loss") is None

    def test_matches_known_failure_below_threshold(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_make_entry("cuda-oom", confidence=0.5))
        assert store.matches_known_failure("cuda-oom", min_confidence=0.8) is None


# ─────────────────────────────────────────────────────────────────────────────
# SelfHealMonitor → gotcha auto-capture
# ─────────────────────────────────────────────────────────────────────────────

class TestMonitorGotchaCapture:
    def _monitor(self, tmp_path: Path, **job_spec_overrides) -> tuple[SelfHealMonitor, GotchaStore]:
        evor_root = tmp_path / ".evor"
        run_dir = evor_root / "runs" / "m" / "r"
        run_dir.mkdir(parents=True)
        store = GotchaStore(evor_root, run_dir)
        job_spec = {"batch_size": 64, "gradient_accumulation_steps": 1, **job_spec_overrides}
        mon = SelfHealMonitor(
            node_id="node-001",
            run_dir=run_dir,
            job_spec=job_spec,
            gotcha_store=store,
        )
        return mon, store

    def test_monitor_oom_captures_gotcha(self, tmp_path: Path) -> None:
        mon, store = self._monitor(tmp_path)
        mon.feed_stderr("CUDA out of memory. Tried to allocate 4 GiB")
        gotchas = store.query_gotchas(kind="runtime-failure")
        assert len(gotchas) >= 1
        sigs = {g.signature for g in gotchas}
        assert "cuda-oom" in sigs

    def test_monitor_nan_captures_gotcha(self, tmp_path: Path) -> None:
        mon, store = self._monitor(tmp_path, lr=0.01)
        mon.feed_stderr("loss became nan, stopping training")
        gotchas = store.query_gotchas(kind="runtime-failure")
        sigs = {g.signature for g in gotchas}
        assert "nan-loss" in sigs

    def test_monitor_give_up_higher_confidence(self, tmp_path: Path) -> None:
        mon, store = self._monitor(tmp_path)
        # Exhaust retries
        for _ in range(3):
            mon.feed_stderr("CUDA out of memory.")
        # This triggers give_up
        mon.feed_stderr("CUDA out of memory.")
        gotchas = store.query_gotchas(kind="runtime-failure")
        give_up = [g for g in gotchas if g.signature.startswith("give-up")]
        assert len(give_up) >= 1
        assert give_up[0].confidence >= 0.8

    def test_monitor_no_store_no_error(self, tmp_path: Path) -> None:
        """Monitor without gotcha_store must not raise."""
        mon = SelfHealMonitor(
            node_id="n", run_dir=tmp_path,
            job_spec={"batch_size": 32, "gradient_accumulation_steps": 1},
        )
        # Must not raise
        event = mon.feed_stderr("CUDA out of memory.")
        assert event is not None
        assert event["action"] == "oom_recovery"

    def test_monitor_evor_root_builds_store(self, tmp_path: Path) -> None:
        """Passing evor_root= to SelfHealMonitor auto-builds a GotchaStore."""
        evor_root = tmp_path / ".evor"
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        mon = SelfHealMonitor(
            node_id="n",
            run_dir=run_dir,
            job_spec={"batch_size": 32, "gradient_accumulation_steps": 1},
            evor_root=evor_root,
        )
        mon.feed_stderr("CUDA out of memory.")
        # Gotcha should appear in the global store
        store = GotchaStore(evor_root, run_dir)
        gotchas = store.query_gotchas(kind="runtime-failure")
        assert len(gotchas) >= 1


# ─────────────────────────────────────────────────────────────────────────────
# CapabilityProfile probe (CPU-only, graceful)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def force_cpu_only(monkeypatch):
    """Make the capability probe see no CUDA device, whatever the host has.

    These tests asserted `cpu_only is True` against whatever hardware happened to
    be present. On a CPU box they passed; on this A100 host the probe correctly
    reported `cpu_only=False` and six tests failed — not a regression, a test that
    had been passing for the wrong reason and silently changed meaning with the
    machine. A test whose result depends on the developer's GPU is not testing the
    code.

    Patches `torch.cuda.is_available` rather than CUDA_VISIBLE_DEVICES because
    torch caches device availability after first initialisation, so the env var is
    not reliably honoured mid-process.
    """
    try:
        import torch  # type: ignore[import]
    except ImportError:
        return  # no torch: the probe already takes the cpu_only branch
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)


@pytest.mark.usefixtures("force_cpu_only")
class TestCapabilityProbe:
    def test_probe_cpu_only_no_crash(self, tmp_path: Path) -> None:
        profile = probe_capability(tmp_path / ".evor")
        assert profile.cpu_only is True
        assert "fp32" in profile.supported_dtypes

    def test_probe_writes_capability_json(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        probe_capability(evor_root)
        cap_file = evor_root / "capability.json"
        assert cap_file.exists()
        data = json.loads(cap_file.read_text())
        assert "cpu_only" in data
        assert data["cpu_only"] is True

    def test_probe_seeds_hw_constraints(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        probe_capability(evor_root)
        store = GotchaStore(evor_root)
        hw = store.query_gotchas(kind="hardware-constraint")
        sigs = {g.signature for g in hw}
        # CPU-only box should seed no-gpu + 3 arch constraints
        assert "no-gpu-cpu-only" in sigs
        assert "flash-attn-v3-requires-sm90" in sigs
        assert "bf16-requires-sm80" in sigs
        assert "fp8-requires-sm89" in sigs
        assert len(hw) == 4

    def test_probe_read_roundtrip(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        written = probe_capability(evor_root)
        read_back = read_capability(evor_root)
        assert read_back is not None
        assert read_back.cpu_only == written.cpu_only
        assert read_back.supported_dtypes == written.supported_dtypes

    def test_probe_read_none_when_absent(self, tmp_path: Path) -> None:
        result = read_capability(tmp_path / ".evor")
        assert result is None

    def test_probe_repeated_deduplicates_constraints(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        probe_capability(evor_root)
        probe_capability(evor_root)  # second run
        store = GotchaStore(evor_root)
        hw = store.query_gotchas(kind="hardware-constraint")
        sigs = [g.signature for g in hw]
        # No duplicates (dedup by signature)
        assert len(sigs) == len(set(sigs))
        # Occurrences should have incremented
        no_gpu = next(g for g in hw if g.signature == "no-gpu-cpu-only")
        assert no_gpu.occurrences == 2


# ─────────────────────────────────────────────────────────────────────────────
# Selector avoidance: matches_known_failure gate
# ─────────────────────────────────────────────────────────────────────────────

class TestSelectorAvoidance:
    def test_selector_rejects_matching_signature(self, tmp_path: Path) -> None:
        """Selector gate: a seeded high-confidence OOM gotcha blocks the same config."""
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_make_entry("cuda-oom", confidence=0.85))
        match = store.matches_known_failure("cuda-oom", min_confidence=0.8)
        assert match is not None
        # Selector would reject: gotcha avoidance gate fires

    def test_selector_passes_different_signature(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_make_entry("cuda-oom", confidence=0.9))
        assert store.matches_known_failure("nan-loss", min_confidence=0.8) is None

    def test_selector_passes_low_confidence(self, tmp_path: Path) -> None:
        store = GotchaStore(tmp_path / ".evor")
        store.add_gotcha(_make_entry("cuda-oom", confidence=0.5))
        # Below 0.8 threshold → no block
        assert store.matches_known_failure("cuda-oom", min_confidence=0.8) is None


# ─────────────────────────────────────────────────────────────────────────────
# python -m evor gotchas CLI
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.usefixtures("force_cpu_only")
class TestGotchasSubcommand:
    def test_gotchas_help_exits_zero(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "evor", "gotchas", "--help"],
            capture_output=True,
            text=True,
            cwd=str(_HARNESS_DIR),
        )
        assert result.returncode == 0
        assert "--kind" in result.stdout

    def test_gotchas_empty_store_returns_json(self, tmp_path: Path) -> None:
        result = subprocess.run(
            [
                sys.executable, "-m", "evor", "gotchas",
                "--evor-root", str(tmp_path / ".evor"),
            ],
            capture_output=True,
            text=True,
            cwd=str(_HARNESS_DIR),
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert "gotchas" in data
        assert data["gotchas"] == []
        assert data["total"] == 0

    def test_gotchas_shows_seeded_constraints(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        probe_capability(evor_root)  # seeds hw constraints
        result = subprocess.run(
            [
                sys.executable, "-m", "evor", "gotchas",
                "--evor-root", str(evor_root),
                "--kind", "hardware-constraint",
            ],
            capture_output=True,
            text=True,
            cwd=str(_HARNESS_DIR),
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["total"] == 4
        sigs = {g["signature"] for g in data["gotchas"]}
        assert "no-gpu-cpu-only" in sigs

    def test_gotchas_min_confidence_filter(self, tmp_path: Path) -> None:
        evor_root = tmp_path / ".evor"
        probe_capability(evor_root)
        result = subprocess.run(
            [
                sys.executable, "-m", "evor", "gotchas",
                "--evor-root", str(evor_root),
                "--min-confidence", "1.0",
            ],
            capture_output=True,
            text=True,
            cwd=str(_HARNESS_DIR),
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        # All hw constraint gotchas from CPU-only probe have confidence=1.0
        assert data["total"] == 4
        assert all(g["confidence"] == 1.0 for g in data["gotchas"])
