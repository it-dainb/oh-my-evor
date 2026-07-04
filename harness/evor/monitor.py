"""
SelfHealMonitor — subprocess supervision + OOM/NaN/dep/checkpoint recovery (M6).

Wraps a running subprocess (Popen) and tails stdout/stderr to detect failure
patterns. On detection it applies the playbook (max 3 retries per node):

  CUDA OOM       → halve batch_size, double gradient_accumulation_steps, retry
  NaN loss       → restore last checkpoint; reduce lr by 0.5; retry
  ModuleNotFound → pip install <pkg> in worktree venv; retry once
  Missing ckpt   → restart training from epoch 0
  ≥3 failures    → mark status=error; log to decision-log.md; do NOT retry

GPU execution is gated: the monitor sets up the pattern-matching and retry
machinery but actual subprocess re-launch requires a real GPU/training environment.
Tests inject synthetic stderr lines via the mock interface.

Emits structured event dicts for each recovery action so Evor can log them.
"""

from __future__ import annotations

import asyncio
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

# GotchaStore import — optional; monitor works without it for backward compat
try:
    from evor.gotchas import GotchaStore, make_gotcha
    _GOTCHA_STORE_AVAILABLE = True
except ImportError:
    _GOTCHA_STORE_AVAILABLE = False

_MAX_RETRIES = 3

# ── Error pattern matchers ────────────────────────────────────────────────────
_OOM_PATTERNS = [
    re.compile(r"cuda out of memory", re.IGNORECASE),
    re.compile(r"out of memory", re.IGNORECASE),
    re.compile(r"RuntimeError.*memory", re.IGNORECASE),
]
_NAN_PATTERNS = [
    re.compile(r"\bnan\b.*loss", re.IGNORECASE),
    re.compile(r"loss.*\bnan\b", re.IGNORECASE),
    re.compile(r"loss became nan", re.IGNORECASE),
]
_MODULE_NOT_FOUND_PATTERN = re.compile(
    r"ModuleNotFoundError: No module named ['\"]?([A-Za-z0-9_\-]+)", re.IGNORECASE
)
_MISSING_CKPT_PATTERNS = [
    re.compile(r"checkpoint.*not found", re.IGNORECASE),
    re.compile(r"no such file.*\.pt", re.IGNORECASE),
    re.compile(r"failed to load.*checkpoint", re.IGNORECASE),
]


def _detect_failure(stderr_line: str) -> str | None:
    """Classify a stderr line into a failure category.

    Returns one of: 'oom', 'nan_loss', 'module_not_found', 'missing_ckpt', or None.
    """
    for pat in _OOM_PATTERNS:
        if pat.search(stderr_line):
            return "oom"
    for pat in _NAN_PATTERNS:
        if pat.search(stderr_line):
            return "nan_loss"
    if _MODULE_NOT_FOUND_PATTERN.search(stderr_line):
        return "module_not_found"
    for pat in _MISSING_CKPT_PATTERNS:
        if pat.search(stderr_line):
            return "missing_ckpt"
    return None


def _extract_module_name(stderr_line: str) -> str | None:
    """Extract missing module name from a ModuleNotFoundError line."""
    m = _MODULE_NOT_FOUND_PATTERN.search(stderr_line)
    return m.group(1) if m else None


def _log_decision(
    run_dir: Path,
    node_id: str,
    action: str,
    detail: str,
) -> None:
    """Append a self-heal event to decision-log.md."""
    log_path = run_dir / "decision-log.md"
    ts = datetime.now(timezone.utc).isoformat()
    entry = (
        f"\n## SelfHealMonitor [{ts}]\n"
        f"- node_id: {node_id}\n"
        f"- action: {action}\n"
        f"- detail: {detail}\n"
    )
    try:
        with open(log_path, "a") as fh:
            fh.write(entry)
    except OSError:
        pass  # non-fatal; monitor continues


class SelfHealMonitor:
    """Supervise a training subprocess; detect and recover from known failure modes.

    Usage (async context):
        monitor = SelfHealMonitor(node_id, run_dir, job_spec)
        exit_code, events = await monitor.supervise(proc)

    Usage (sync context / tests):
        monitor = SelfHealMonitor(node_id, run_dir, job_spec)
        for line in stderr_lines:
            monitor.feed_stderr(line)
        events = monitor.events
    """

    def __init__(
        self,
        node_id: str,
        run_dir: Path,
        job_spec: dict[str, Any],
        on_event: Callable[[dict[str, Any]], None] | None = None,
        gotcha_store: "Optional[GotchaStore]" = None,
        evor_root: Path | None = None,
    ) -> None:
        """
        Args:
            node_id:     Node being trained (for logging).
            run_dir:     Run directory root (for decision-log.md).
            job_spec:    Training job specification (mutated by playbook).
            on_event:    Optional callback invoked on each recovery event.
            gotcha_store: Optional GotchaStore; when provided, auto-captures
                          OOM/NaN/dep/checkpoint failures as runtime-failure gotchas.
            evor_root:   .evor/ root; used to construct a GotchaStore when
                         gotcha_store is None but evor_root is provided.
        """
        self._node_id = node_id
        self._run_dir = run_dir
        self._job_spec: dict[str, Any] = dict(job_spec)
        self._on_event = on_event
        self._retry_count = 0
        self._events: list[dict[str, Any]] = []

        # Gotcha auto-capture: use provided store, or build one from evor_root
        self._gotcha_store: "Optional[GotchaStore]" = gotcha_store
        if self._gotcha_store is None and evor_root is not None and _GOTCHA_STORE_AVAILABLE:
            self._gotcha_store = GotchaStore(evor_root, run_dir)

    @property
    def events(self) -> list[dict[str, Any]]:
        """Recovery events emitted so far."""
        return list(self._events)

    @property
    def job_spec(self) -> dict[str, Any]:
        """Current (possibly mutated) job spec."""
        return dict(self._job_spec)

    # ------------------------------------------------------------------
    # Sync interface (for testing / non-async callers)
    # ------------------------------------------------------------------

    def feed_stderr(self, line: str) -> dict[str, Any] | None:
        """Process one stderr line synchronously.

        Returns a recovery event dict if a playbook action was triggered,
        or None if the line is benign.

        If retry_count >= MAX_RETRIES, emits a final 'give_up' event
        regardless of failure type.
        """
        failure_type = _detect_failure(line)
        if failure_type is None:
            return None

        return self._apply_playbook(failure_type, line)

    def _apply_playbook(self, failure_type: str, trigger_line: str) -> dict[str, Any]:
        """Apply the recovery playbook for a given failure type.

        Mutates self._job_spec and records an event.
        """
        if self._retry_count >= _MAX_RETRIES:
            event = self._emit_event(
                action="give_up",
                failure_type=failure_type,
                detail=(
                    f"Reached max retries ({_MAX_RETRIES}). "
                    f"Marking node status=error. Last trigger: {trigger_line[:200]}"
                ),
            )
            return event

        self._retry_count += 1

        if failure_type == "oom":
            # Halve batch_size; double gradient_accumulation_steps
            old_batch = self._job_spec.get("batch_size", 32)
            new_batch = max(1, old_batch // 2)
            old_accum = self._job_spec.get("gradient_accumulation_steps", 1)
            new_accum = old_accum * 2
            self._job_spec["batch_size"] = new_batch
            self._job_spec["gradient_accumulation_steps"] = new_accum
            detail = (
                f"CUDA OOM: batch_size {old_batch}→{new_batch}, "
                f"gradient_accumulation_steps {old_accum}→{new_accum}"
            )
            event = self._emit_event("oom_recovery", failure_type, detail)

        elif failure_type == "nan_loss":
            # Reduce lr by 0.5; restore last checkpoint
            old_lr = self._job_spec.get("lr", 0.001)
            new_lr = old_lr * 0.5
            self._job_spec["lr"] = new_lr
            self._job_spec["restore_checkpoint"] = True
            detail = f"NaN loss: lr {old_lr}→{new_lr}; restoring last checkpoint"
            event = self._emit_event("nan_recovery", failure_type, detail)

        elif failure_type == "module_not_found":
            # pip install missing module; retry once
            module = _extract_module_name(trigger_line) or "unknown"
            self._job_spec.setdefault("missing_modules", []).append(module)
            detail = f"ModuleNotFoundError: pip install {module}"
            self._pip_install(module)
            event = self._emit_event("module_install", failure_type, detail)

        elif failure_type == "missing_ckpt":
            # Restart from epoch 0
            self._job_spec["start_epoch"] = 0
            self._job_spec.pop("restore_checkpoint", None)
            detail = "Missing checkpoint: restarting training from epoch 0"
            event = self._emit_event("ckpt_restart", failure_type, detail)

        else:
            event = self._emit_event("unknown_failure", failure_type, trigger_line[:200])

        return event

    def _emit_event(
        self, action: str, failure_type: str, detail: str
    ) -> dict[str, Any]:
        """Record a recovery event and invoke the on_event callback."""
        event: dict[str, Any] = {
            "action": action,
            "failure_type": failure_type,
            "detail": detail,
            "retry_count": self._retry_count,
            "node_id": self._node_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        self._events.append(event)
        _log_decision(self._run_dir, self._node_id, action, detail)
        if self._on_event is not None:
            self._on_event(event)
        self._capture_gotcha(action, failure_type, detail)
        return event

    def _capture_gotcha(self, action: str, failure_type: str, detail: str) -> None:
        """Auto-capture a runtime-failure gotcha for OOM/NaN/dep/ckpt recoveries.

        Signatures are stable so repeated occurrences dedup correctly:
          oom          -> 'cuda-oom'
          nan_loss     -> 'nan-loss'
          module_not_found -> 'module-not-found'
          missing_ckpt -> 'missing-checkpoint'
          give_up      -> 'give-up-<failure_type>'
        """
        if self._gotcha_store is None or not _GOTCHA_STORE_AVAILABLE:
            return

        _SIG_MAP = {
            "oom":           ("cuda-oom",         "batch_size in job_spec"),
            "nan_loss":      ("nan-loss",          "lr in job_spec"),
            "module_not_found": ("module-not-found", "missing_modules in job_spec"),
            "missing_ckpt":  ("missing-checkpoint", "start_epoch in job_spec"),
        }
        give_up = action == "give_up"
        sig_key = f"give-up-{failure_type}" if give_up else _SIG_MAP.get(failure_type, (failure_type,))[0]

        context: dict = {
            "node_id": self._node_id,
            "failure_type": failure_type,
            "action": action,
            "retry_count": self._retry_count,
        }
        # Add relevant job_spec fields to context
        for key in ("batch_size", "gradient_accumulation_steps", "lr", "worktree"):
            if key in self._job_spec:
                context[key] = self._job_spec[key]

        try:
            entry = make_gotcha(
                kind="runtime-failure",
                signature=sig_key,
                context=context,
                resolution=detail,
                avoidance=(
                    f"Avoid configurations that trigger {failure_type}. "
                    f"Recovery applied: {detail[:200]}"
                ),
                scope="mission",
                confidence=0.7 if not give_up else 0.8,
            )
            self._gotcha_store.add_gotcha(entry)
        except Exception:
            pass  # non-fatal: gotcha capture must never disrupt the monitor

    def _pip_install(self, module: str) -> None:
        """Install missing module into the worktree venv (best-effort).

        GPU-gated: no-op if not in a venv / pip unavailable.
        """
        worktree = self._job_spec.get("worktree")
        if not worktree:
            return

        venv_pip = Path(worktree) / ".venv" / "bin" / "pip"
        if not venv_pip.exists():
            venv_pip = Path(sys.executable).parent / "pip"

        try:
            subprocess.run(
                [str(venv_pip), "install", module],
                capture_output=True,
                timeout=120,
                check=False,
            )
        except Exception:
            pass  # non-fatal; retry will reveal if install succeeded

    # ------------------------------------------------------------------
    # Async supervision interface
    # ------------------------------------------------------------------

    async def supervise(
        self,
        proc: "subprocess.Popen[str]",
    ) -> tuple[int, list[dict[str, Any]]]:
        """Tail proc stderr asynchronously; apply playbook on failure detection.

        Returns (exit_code, events).

        Note: actual subprocess re-launch on retry requires the caller to
        reconstruct the Popen; this method only observes and emits events.
        GPU execution is gated — in CI the process under test is a mock.
        """
        loop = asyncio.get_event_loop()

        def _read_stderr() -> None:
            if proc.stderr is None:
                return
            for line in proc.stderr:
                self.feed_stderr(line.rstrip())

        # Run stderr reading in a thread to avoid blocking the event loop
        await loop.run_in_executor(None, _read_stderr)
        exit_code = proc.wait()
        return exit_code, self._events

    @property
    def should_retry(self) -> bool:
        """True if the monitor has retries remaining and last event was not give_up."""
        if not self._events:
            return False
        last = self._events[-1]
        return last.get("action") != "give_up" and self._retry_count < _MAX_RETRIES

    @property
    def retry_count(self) -> int:
        return self._retry_count
