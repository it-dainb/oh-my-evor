"""
ResourceScheduler — throughput-probe concurrency + VRAM hard ceiling.

Concurrency is adaptive: start at 1, increment while aggregate throughput
rises and util < 90%, back off at >=90% util or when throughput degrades >5%.

GPU stats: pynvml is preferred; nvidia-smi subprocess is the fallback.
Neither available → cpu_fallback=True, gpu_ids=[].
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from evor.contracts import ResourcePlan

# Optional pynvml — gated at import time; tests without CUDA import cleanly
try:
    import pynvml  # type: ignore[import]
    _PYNVML_AVAILABLE = True
except ImportError:
    _PYNVML_AVAILABLE = False

_UTIL_BACKOFF_THRESHOLD = 0.90          # back off at or above this utilisation
_THROUGHPUT_DEGRADE_THRESHOLD = 0.05    # 5% throughput drop triggers back-off


# ─────────────────────────────────────────────────────────────────────────────
# GPU stat helpers
# ─────────────────────────────────────────────────────────────────────────────


def _query_gpu_nvml() -> list[dict[str, Any]]:
    """Return per-GPU stats via pynvml."""
    pynvml.nvmlInit()
    try:
        count = pynvml.nvmlDeviceGetCount()
        gpus = []
        for i in range(count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            gpus.append({
                "index": i,
                "util": util.gpu / 100.0,
                "mem_used_gb": mem.used / 1024 ** 3,
                "mem_total_gb": mem.total / 1024 ** 3,
            })
        return gpus
    finally:
        pynvml.nvmlShutdown()


def _query_gpu_smi() -> list[dict[str, Any]]:
    """Fallback: parse nvidia-smi CSV output."""
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=index,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if result.returncode != 0:
        raise RuntimeError(f"nvidia-smi failed: {result.stderr.strip()}")
    gpus = []
    for line in result.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        gpus.append({
            "index": int(parts[0]),
            "util": float(parts[1]) / 100.0,
            "mem_used_gb": float(parts[2]) / 1024.0,
            "mem_total_gb": float(parts[3]) / 1024.0,
        })
    return gpus


def query_gpus() -> list[dict[str, Any]]:
    """Return per-GPU stats; pynvml first, nvidia-smi fallback, [] if unavailable."""
    if _PYNVML_AVAILABLE:
        try:
            return _query_gpu_nvml()
        except Exception:
            pass
    try:
        return _query_gpu_smi()
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# ResourceScheduler
# ─────────────────────────────────────────────────────────────────────────────


class ResourceScheduler:
    """Adaptive concurrency scheduler with throughput probing and VRAM ceiling."""

    def __init__(
        self,
        vram_ceiling_gb: float = 0.0,
        run_dir: Path | None = None,
    ) -> None:
        """
        Args:
            vram_ceiling_gb: Hard VRAM ceiling per job in GB.  0 = no ceiling.
            run_dir:         Optional run directory for logging probe results.
        """
        self._vram_ceiling_gb = vram_ceiling_gb
        self._run_dir = run_dir

    def probe_throughput(self, run_id: str, job_spec: dict[str, Any]) -> ResourcePlan:
        """Run job_spec for ≤10 steps; measure samples/sec + GPU util.

        Returns a ResourcePlan anchored at concurrency=1.

        job_spec keys consumed here:
          samples_per_step  (int, default 32)  — batch size used in probe
          probe_steps       (int, default 10)  — steps to run; capped at 10
          entry             (str, optional)    — Python script path for real probe

        If 'entry' is not in job_spec, a synthetic wall-clock measurement is used
        (suitable for unit tests).  VRAM ceiling is enforced after the probe run.
        """
        samples_per_step: int = int(job_spec.get("samples_per_step", 32))
        steps: int = min(int(job_spec.get("probe_steps", 10)), 10)

        gpus_before = query_gpus()
        gpu_ids = [int(g["index"]) for g in gpus_before]
        cpu_fallback = len(gpu_ids) == 0

        start = time.monotonic()

        if "entry" in job_spec:
            import os as _os
            env = {
                **_os.environ,
                "EVOR_PROBE_STEPS": str(steps),
                "EVOR_PROBE_ONLY": "1",
            }
            subprocess.run(
                [sys.executable, job_spec["entry"]],
                env=env,
                timeout=120,
                check=False,
            )
        else:
            # synthetic probe — wall-clock only; real training deferred to Forge
            time.sleep(0.001 * steps)

        elapsed = max(time.monotonic() - start, 1e-9)
        throughput = (samples_per_step * steps) / elapsed

        gpus_after = query_gpus()
        avg_util = (
            sum(g["util"] for g in gpus_after) / len(gpus_after)
            if gpus_after else 0.0
        )
        vram_per_job_gb = (
            max(g["mem_used_gb"] for g in gpus_after) if gpus_after else 0.0
        )

        if self._vram_ceiling_gb > 0 and vram_per_job_gb > self._vram_ceiling_gb:
            raise RuntimeError(
                f"VRAM per job ({vram_per_job_gb:.2f} GB) exceeds hard ceiling "
                f"({self._vram_ceiling_gb:.2f} GB). Reduce batch size or set a "
                "higher vram_ceiling_gb."
            )

        return ResourcePlan(
            concurrency=1,
            gpu_ids=gpu_ids,
            cpu_fallback=cpu_fallback,
            throughput_samples_per_sec=throughput,
            vram_per_job_gb=vram_per_job_gb,
            util_target=_UTIL_BACKOFF_THRESHOLD,
            last_probed_at=datetime.now(timezone.utc).isoformat(),
        )

    def next_concurrency(
        self,
        plan: ResourcePlan,
        new_util: float,
        new_throughput: float,
    ) -> int:
        """Compute next concurrency based on current utilisation and throughput.

        Rules (spec R3, ResourcePlan.util_target):
          util >= 0.90  OR  throughput degraded > 5%  → concurrency -= 1 (min 1)
          otherwise                                   → concurrency += 1
        """
        prev = plan.throughput_samples_per_sec
        degraded = (
            prev > 0
            and (prev - new_throughput) / prev > _THROUGHPUT_DEGRADE_THRESHOLD
        )
        if new_util >= _UTIL_BACKOFF_THRESHOLD or degraded:
            return max(1, plan.concurrency - 1)
        return plan.concurrency + 1

    def preflight(self, run_id: str) -> dict[str, bool]:
        """5-step micro-train smoke-test (spec R3, §evor-setup).

        Verifies:
          1. import_ok     — torch importable
          2. loss_decreasing — loss at step 5 < loss at step 1
          3. gpu_active    — GPU utilisation > 0% if GPU detected

        Raises NotImplementedError when torch is unavailable — the caller
        gates on this and prompts the user to confirm or override.
        GPU checks are skipped (passes trivially) when no GPU is detected.
        """
        checks: dict[str, bool] = {
            "import_ok": False,
            "loss_decreasing": False,
            "gpu_active": False,
        }
        try:
            import importlib
            importlib.import_module("torch")
            checks["import_ok"] = True
        except ImportError:
            raise NotImplementedError(
                "Preflight smoke-test requires PyTorch. "
                "Install torch in the harness venv or run with --no-preflight."
            )

        gpus = query_gpus()
        checks["gpu_active"] = len(gpus) > 0

        if checks["gpu_active"]:
            # GPU detected — the micro-train COULD run, but preflight() has no
            # fixed eval_script / worktree at this call site (it is invoked before
            # the candidate worktree is materialised).  Raise so the caller knows
            # this check was not evaluated rather than silently returning False.
            # Wiring: pass eval_script + worktree as kwargs then invoke
            # EvaluatorAdapter.run() with EVOR_PROBE_STEPS=5.
            # See KNOWN_GAPS.md#G2.
            raise NotImplementedError(
                "Preflight loss_decreasing check requires a live EvaluatorAdapter "
                "micro-train (5 steps). Call preflight() after the candidate worktree "
                "is materialised and supply eval_script + worktree — see KNOWN_GAPS.md#G2."
            )

        # No GPU: micro-train cannot execute; loss_decreasing stays False.
        # gpu_active=False already signals the caller that the GPU path is inactive.
        checks["loss_decreasing"] = False
        return checks

    def submit(
        self,
        node_id: str,
        job_spec: dict[str, Any],
        run_id: str,
    ) -> "asyncio.Future[int]":
        """Add job to subprocess pool; return Future resolved on job completion.

        Dispatches a training job as a background subprocess and returns an
        asyncio.Future[int] that resolves to the process exit code.

        job_spec keys consumed:
          entry        (str, optional) — path to training script; if absent,
                                         resolves immediately with exit code 0
          worktree     (str, optional) — working directory for the subprocess
          env          (dict, optional) — additional env vars
          timeout_sec  (int, default 3600) — wall-clock timeout

        GPU execution: if the training script requires CUDA and no GPU is
        present the subprocess exits non-zero; the caller inspects the exit
        code and may hand off to SelfHealMonitor for recovery.

        """
        import os as _os
        import threading

        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        future: "asyncio.Future[int]" = loop.create_future()

        if "entry" not in job_spec:
            # No entry script: resolve immediately (no-op / test mode)
            loop.call_soon(future.set_result, 0)
            return future

        timeout_sec: int = int(job_spec.get("timeout_sec", 3600))
        worktree: str | None = job_spec.get("worktree")
        extra_env: dict[str, str] = job_spec.get("env", {})

        proc_env = {
            **_os.environ,
            **extra_env,
            "EVOR_NODE_ID": node_id,
            "EVOR_RUN_ID": run_id,
        }

        def _run() -> None:
            try:
                proc = subprocess.Popen(
                    [sys.executable, job_spec["entry"]],
                    cwd=worktree,
                    env=proc_env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                try:
                    _, _ = proc.communicate(timeout=timeout_sec)
                    exit_code = proc.returncode
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate()
                    exit_code = 2  # timeout (mirrors __main__.py exit code convention)
                loop.call_soon_threadsafe(future.set_result, exit_code)
            except Exception as exc:
                loop.call_soon_threadsafe(future.set_exception, exc)

        thread = threading.Thread(
            target=_run, daemon=True, name=f"evor-job-{node_id}"
        )
        thread.start()
        return future
