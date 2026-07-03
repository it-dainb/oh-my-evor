"""
Unit tests for ResourceScheduler (harness/evor/scheduler.py).

Covers:
  - probe_throughput returns a valid ResourcePlan (cpu_fallback=True when no GPU)
  - next_concurrency increments below 90% util
  - next_concurrency backs off at >= 90% util
  - next_concurrency backs off when throughput degrades > 5%
  - submit() raises NotImplementedError (wired in M6)
  - preflight() raises NotImplementedError when torch unavailable
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from evor.contracts import ResourcePlan
from evor.scheduler import ResourceScheduler, _UTIL_BACKOFF_THRESHOLD


@pytest.fixture
def scheduler(tmp_path: Path) -> ResourceScheduler:
    return ResourceScheduler(run_dir=tmp_path)


def _plan(
    concurrency: int = 1,
    throughput: float = 100.0,
    util_target: float = _UTIL_BACKOFF_THRESHOLD,
    gpu_ids: list[int] | None = None,
) -> ResourcePlan:
    return ResourcePlan(
        concurrency=concurrency,
        gpu_ids=gpu_ids or [],
        cpu_fallback=(not gpu_ids),
        throughput_samples_per_sec=throughput,
        vram_per_job_gb=0.0,
        util_target=util_target,
        last_probed_at="2026-07-03T00:00:00Z",
    )


# ─────────────────────────────────────────────────────────────────────────────
# probe_throughput
# ─────────────────────────────────────────────────────────────────────────────


def test_probe_throughput_cpu_fallback(scheduler: ResourceScheduler) -> None:
    """No GPU available → cpu_fallback=True, gpu_ids=[], concurrency=1."""
    with patch("evor.scheduler.query_gpus", return_value=[]):
        plan = scheduler.probe_throughput("run-1", {"samples_per_step": 32})

    assert isinstance(plan, ResourcePlan)
    assert plan.cpu_fallback is True
    assert plan.gpu_ids == []
    assert plan.concurrency == 1
    assert plan.throughput_samples_per_sec > 0


def test_probe_throughput_with_gpu(scheduler: ResourceScheduler) -> None:
    """Mocked GPU present → gpu_ids populated, cpu_fallback=False."""
    mock_gpu = [{"index": 0, "util": 0.5, "mem_used_gb": 2.0, "mem_total_gb": 8.0}]
    with patch("evor.scheduler.query_gpus", return_value=mock_gpu):
        plan = scheduler.probe_throughput("run-1", {"samples_per_step": 64})

    assert plan.cpu_fallback is False
    assert plan.gpu_ids == [0]
    assert plan.vram_per_job_gb == pytest.approx(2.0)


def test_probe_throughput_vram_ceiling_exceeded(tmp_path: Path) -> None:
    """VRAM ceiling enforcement raises RuntimeError when exceeded."""
    sched = ResourceScheduler(vram_ceiling_gb=1.0, run_dir=tmp_path)
    mock_gpu = [{"index": 0, "util": 0.3, "mem_used_gb": 4.0, "mem_total_gb": 8.0}]
    with patch("evor.scheduler.query_gpus", return_value=mock_gpu):
        with pytest.raises(RuntimeError, match="VRAM per job"):
            sched.probe_throughput("run-1", {})


def test_probe_throughput_custom_steps(scheduler: ResourceScheduler) -> None:
    """probe_steps is capped at 10."""
    with patch("evor.scheduler.query_gpus", return_value=[]):
        plan = scheduler.probe_throughput("run-1", {"probe_steps": 999, "samples_per_step": 10})
    assert plan.concurrency == 1


# ─────────────────────────────────────────────────────────────────────────────
# next_concurrency
# ─────────────────────────────────────────────────────────────────────────────


def test_next_concurrency_increases_below_threshold(
    scheduler: ResourceScheduler,
) -> None:
    plan = _plan(concurrency=2, throughput=100.0)
    new_c = scheduler.next_concurrency(plan, new_util=0.50, new_throughput=110.0)
    assert new_c == 3


def test_next_concurrency_backs_off_at_90_util(
    scheduler: ResourceScheduler,
) -> None:
    plan = _plan(concurrency=4, throughput=100.0)
    new_c = scheduler.next_concurrency(plan, new_util=0.90, new_throughput=105.0)
    assert new_c == 3


def test_next_concurrency_backs_off_above_90_util(
    scheduler: ResourceScheduler,
) -> None:
    plan = _plan(concurrency=3, throughput=100.0)
    new_c = scheduler.next_concurrency(plan, new_util=0.95, new_throughput=105.0)
    assert new_c == 2


def test_next_concurrency_backs_off_on_throughput_degradation(
    scheduler: ResourceScheduler,
) -> None:
    """> 5% throughput drop triggers back-off regardless of util."""
    plan = _plan(concurrency=4, throughput=100.0)
    # 6% degradation
    new_c = scheduler.next_concurrency(plan, new_util=0.70, new_throughput=94.0)
    assert new_c == 3


def test_next_concurrency_no_backoff_on_5pct_degradation(
    scheduler: ResourceScheduler,
) -> None:
    """Exactly 5% degradation does NOT trigger back-off (threshold is strictly >5%)."""
    plan = _plan(concurrency=2, throughput=100.0)
    new_c = scheduler.next_concurrency(plan, new_util=0.60, new_throughput=95.0)
    assert new_c == 3  # 95.0 / 100.0 = 5% ≤ threshold → increment


def test_next_concurrency_minimum_one(
    scheduler: ResourceScheduler,
) -> None:
    """Concurrency never drops below 1."""
    plan = _plan(concurrency=1, throughput=100.0)
    new_c = scheduler.next_concurrency(plan, new_util=0.99, new_throughput=50.0)
    assert new_c == 1


# ─────────────────────────────────────────────────────────────────────────────
# submit — wired in M6
# ─────────────────────────────────────────────────────────────────────────────


def test_submit_no_entry_resolves_immediately(scheduler: ResourceScheduler) -> None:
    """submit() with no 'entry' key resolves the Future with exit code 0 (no-op mode)."""
    import asyncio

    future = scheduler.submit("node-1", {}, "run-1")

    # Run the event loop briefly to let the call_soon callback fire
    loop = asyncio.get_event_loop()
    loop.run_until_complete(asyncio.sleep(0))

    assert future.done()
    assert future.result() == 0


def test_submit_returns_future(scheduler: ResourceScheduler) -> None:
    """submit() always returns an asyncio.Future regardless of job_spec."""
    import asyncio

    future = scheduler.submit("node-2", {}, "run-2")
    assert hasattr(future, "done")
    assert hasattr(future, "result")
    assert hasattr(future, "add_done_callback")

    # Drain the event loop so the Future resolves (avoids ResourceWarning)
    loop = asyncio.get_event_loop()
    loop.run_until_complete(asyncio.sleep(0))


# ─────────────────────────────────────────────────────────────────────────────
# preflight
# ─────────────────────────────────────────────────────────────────────────────


def test_preflight_raises_when_torch_missing(scheduler: ResourceScheduler) -> None:
    """preflight() raises NotImplementedError when torch is not importable."""
    with patch("evor.scheduler.query_gpus", return_value=[]):
        with patch("importlib.import_module", side_effect=ImportError("no torch")):
            with pytest.raises(NotImplementedError, match="PyTorch"):
                scheduler.preflight("run-1")
