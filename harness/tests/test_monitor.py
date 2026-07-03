"""
Unit tests for SelfHealMonitor (harness/evor/monitor.py).

Coverage:
  - _detect_failure: OOM, NaN loss, ModuleNotFound, missing ckpt patterns
  - OOM → batch_size halved, gradient_accumulation_steps doubled, retry_count=1
  - NaN loss → lr halved, restore_checkpoint=True, retry_count=1
  - ModuleNotFound → pip install called (best-effort), module in missing_modules
  - Missing checkpoint → start_epoch=0, restore_checkpoint removed
  - ≥ _MAX_RETRIES (3) failures → action='give_up', should_retry=False
  - Events emitted and accessible via .events property
  - on_event callback invoked for each recovery action
  - feed_stderr returns None for benign lines
  - Multiple failure types in sequence accumulate retries correctly
  - supervise() async interface (mock Popen with stderr stream)
"""

from __future__ import annotations

import asyncio
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from evor.monitor import (
    SelfHealMonitor,
    _detect_failure,
    _extract_module_name,
    _MAX_RETRIES,
)


# ─────────────────────────────────────────────────────────────────────────────
# _detect_failure pattern matching
# ─────────────────────────────────────────────────────────────────────────────

class TestDetectFailure:
    def test_cuda_oom_detected(self):
        assert _detect_failure("CUDA out of memory. Tried to allocate 4.00 GiB") == "oom"

    def test_out_of_memory_lowercase(self):
        assert _detect_failure("RuntimeError: out of memory") == "oom"

    def test_runtimeerror_memory(self):
        assert _detect_failure("RuntimeError: CUDA memory allocation failed") == "oom"

    def test_nan_loss_pattern_1(self):
        assert _detect_failure("nan loss detected at step 42") == "nan_loss"

    def test_nan_loss_pattern_2(self):
        assert _detect_failure("loss is nan at batch 10") == "nan_loss"

    def test_nan_loss_became(self):
        assert _detect_failure("loss became nan, stopping") == "nan_loss"

    def test_module_not_found(self):
        assert _detect_failure(
            "ModuleNotFoundError: No module named 'transformers'"
        ) == "module_not_found"

    def test_module_not_found_no_quotes(self):
        assert _detect_failure(
            "ModuleNotFoundError: No module named timm"
        ) == "module_not_found"

    def test_missing_checkpoint_not_found(self):
        assert _detect_failure("checkpoint not found at path/to/ckpt") == "missing_ckpt"

    def test_missing_checkpoint_pt_file(self):
        assert _detect_failure("No such file or directory: 'best.pt'") == "missing_ckpt"

    def test_missing_checkpoint_failed_to_load(self):
        assert _detect_failure("Failed to load checkpoint from epoch5.ckpt") == "missing_ckpt"

    def test_benign_line_returns_none(self):
        assert _detect_failure("Epoch 1/10: 100%|████| 938/938") is None

    def test_benign_warning_returns_none(self):
        assert _detect_failure("WARNING:root:Low disk space") is None

    def test_empty_line_returns_none(self):
        assert _detect_failure("") is None


class TestExtractModuleName:
    def test_extracts_quoted_module(self):
        assert (
            _extract_module_name("ModuleNotFoundError: No module named 'transformers'")
            == "transformers"
        )

    def test_extracts_unquoted_module(self):
        assert _extract_module_name("ModuleNotFoundError: No module named timm") == "timm"

    def test_returns_none_for_non_matching(self):
        assert _extract_module_name("RuntimeError: out of memory") is None


# ─────────────────────────────────────────────────────────────────────────────
# SelfHealMonitor — OOM playbook
# ─────────────────────────────────────────────────────────────────────────────

class TestOOMPlaybook:
    def _make_monitor(self, tmp_path: Path, **job_spec_overrides) -> SelfHealMonitor:
        job_spec = {"batch_size": 32, "gradient_accumulation_steps": 1, **job_spec_overrides}
        return SelfHealMonitor(
            node_id="node-001",
            run_dir=tmp_path,
            job_spec=job_spec,
        )

    def test_oom_halves_batch_size(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path)
        mon.feed_stderr("CUDA out of memory. Tried to allocate 8.00 GiB")
        assert mon.job_spec["batch_size"] == 16

    def test_oom_doubles_gradient_accumulation(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path)
        mon.feed_stderr("CUDA out of memory.")
        assert mon.job_spec["gradient_accumulation_steps"] == 2

    def test_oom_increments_retry_count(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path)
        mon.feed_stderr("CUDA out of memory.")
        assert mon.retry_count == 1

    def test_oom_emits_oom_recovery_event(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path)
        event = mon.feed_stderr("CUDA out of memory. Tried to allocate 4 GiB")
        assert event is not None
        assert event["action"] == "oom_recovery"
        assert event["failure_type"] == "oom"
        assert "batch_size" in event["detail"]

    def test_oom_second_time_halves_again(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path)
        mon.feed_stderr("CUDA out of memory.")   # batch 32→16
        mon.feed_stderr("CUDA out of memory.")   # batch 16→8
        assert mon.job_spec["batch_size"] == 8
        assert mon.job_spec["gradient_accumulation_steps"] == 4
        assert mon.retry_count == 2

    def test_batch_size_minimum_one(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path, batch_size=1)
        mon.feed_stderr("CUDA out of memory.")
        assert mon.job_spec["batch_size"] == 1  # max(1, 1//2) = max(1, 0) = 1


# ─────────────────────────────────────────────────────────────────────────────
# SelfHealMonitor — NaN loss playbook
# ─────────────────────────────────────────────────────────────────────────────

class TestNaNLossPlaybook:
    def _make_monitor(self, tmp_path: Path) -> SelfHealMonitor:
        return SelfHealMonitor(
            node_id="node-001",
            run_dir=tmp_path,
            job_spec={"lr": 0.01},
        )

    def test_nan_halves_lr(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path)
        mon.feed_stderr("nan loss at step 100")
        assert mon.job_spec["lr"] == pytest.approx(0.005)

    def test_nan_sets_restore_checkpoint(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path)
        mon.feed_stderr("loss is nan, reverting")
        assert mon.job_spec.get("restore_checkpoint") is True

    def test_nan_emits_nan_recovery_event(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path)
        event = mon.feed_stderr("loss became nan")
        assert event["action"] == "nan_recovery"
        assert "lr" in event["detail"]

    def test_nan_second_halves_again(self, tmp_path: Path):
        mon = self._make_monitor(tmp_path)
        mon.feed_stderr("nan loss step 10")    # lr 0.01→0.005
        mon.feed_stderr("nan loss step 20")    # lr 0.005→0.0025
        assert mon.job_spec["lr"] == pytest.approx(0.0025)
        assert mon.retry_count == 2


# ─────────────────────────────────────────────────────────────────────────────
# SelfHealMonitor — ModuleNotFound playbook
# ─────────────────────────────────────────────────────────────────────────────

class TestModuleNotFoundPlaybook:
    def test_module_install_called(self, tmp_path: Path):
        mon = SelfHealMonitor(
            node_id="node-001",
            run_dir=tmp_path,
            job_spec={"worktree": str(tmp_path)},
        )
        with patch.object(mon, "_pip_install") as mock_pip:
            mon.feed_stderr("ModuleNotFoundError: No module named 'transformers'")
            mock_pip.assert_called_once_with("transformers")

    def test_module_added_to_missing_modules(self, tmp_path: Path):
        mon = SelfHealMonitor(
            node_id="node-001",
            run_dir=tmp_path,
            job_spec={},
        )
        with patch.object(mon, "_pip_install"):
            mon.feed_stderr("ModuleNotFoundError: No module named 'timm'")
        assert "timm" in mon.job_spec.get("missing_modules", [])

    def test_module_install_event_emitted(self, tmp_path: Path):
        mon = SelfHealMonitor(
            node_id="node-001",
            run_dir=tmp_path,
            job_spec={},
        )
        with patch.object(mon, "_pip_install"):
            event = mon.feed_stderr("ModuleNotFoundError: No module named 'datasets'")
        assert event["action"] == "module_install"
        assert "datasets" in event["detail"]


# ─────────────────────────────────────────────────────────────────────────────
# SelfHealMonitor — Missing checkpoint playbook
# ─────────────────────────────────────────────────────────────────────────────

class TestMissingCheckpointPlaybook:
    def test_missing_ckpt_sets_start_epoch_zero(self, tmp_path: Path):
        mon = SelfHealMonitor(
            node_id="node-001",
            run_dir=tmp_path,
            job_spec={"start_epoch": 5, "restore_checkpoint": True},
        )
        mon.feed_stderr("checkpoint not found at epoch5.pt")
        assert mon.job_spec["start_epoch"] == 0

    def test_missing_ckpt_removes_restore_checkpoint(self, tmp_path: Path):
        mon = SelfHealMonitor(
            node_id="node-001",
            run_dir=tmp_path,
            job_spec={"restore_checkpoint": True},
        )
        mon.feed_stderr("checkpoint not found")
        assert "restore_checkpoint" not in mon.job_spec

    def test_missing_ckpt_event_action(self, tmp_path: Path):
        mon = SelfHealMonitor("n", tmp_path, {})
        event = mon.feed_stderr("Failed to load checkpoint from disk")
        assert event["action"] == "ckpt_restart"


# ─────────────────────────────────────────────────────────────────────────────
# Max retries → give_up
# ─────────────────────────────────────────────────────────────────────────────

class TestGiveUp:
    def test_give_up_after_max_retries(self, tmp_path: Path):
        """After _MAX_RETRIES (3) failures, next failure → action='give_up'."""
        mon = SelfHealMonitor(
            node_id="node-001",
            run_dir=tmp_path,
            job_spec={"batch_size": 32, "gradient_accumulation_steps": 1},
        )
        # Exhaust retries
        for _ in range(_MAX_RETRIES):
            mon.feed_stderr("CUDA out of memory.")

        # One more failure → give_up
        event = mon.feed_stderr("CUDA out of memory.")
        assert event["action"] == "give_up"
        assert event["retry_count"] == _MAX_RETRIES

    def test_should_retry_false_after_give_up(self, tmp_path: Path):
        mon = SelfHealMonitor("n", tmp_path, {"batch_size": 8, "gradient_accumulation_steps": 1})
        for _ in range(_MAX_RETRIES):
            mon.feed_stderr("CUDA out of memory.")
        mon.feed_stderr("CUDA out of memory.")  # give_up
        assert mon.should_retry is False

    def test_should_retry_true_before_max(self, tmp_path: Path):
        mon = SelfHealMonitor("n", tmp_path, {"batch_size": 16, "gradient_accumulation_steps": 1})
        mon.feed_stderr("CUDA out of memory.")  # retry_count=1, < _MAX_RETRIES
        assert mon.should_retry is True

    def test_events_accumulate(self, tmp_path: Path):
        mon = SelfHealMonitor("n", tmp_path, {"batch_size": 32, "gradient_accumulation_steps": 1})
        mon.feed_stderr("CUDA out of memory.")
        mon.feed_stderr("nan loss step 10")
        events = mon.events
        assert len(events) == 2
        assert events[0]["action"] == "oom_recovery"
        assert events[1]["action"] == "nan_recovery"


# ─────────────────────────────────────────────────────────────────────────────
# on_event callback
# ─────────────────────────────────────────────────────────────────────────────

class TestOnEventCallback:
    def test_callback_invoked_on_recovery(self, tmp_path: Path):
        received = []
        mon = SelfHealMonitor(
            node_id="node-001",
            run_dir=tmp_path,
            job_spec={"batch_size": 16, "gradient_accumulation_steps": 1},
            on_event=received.append,
        )
        mon.feed_stderr("CUDA out of memory.")
        assert len(received) == 1
        assert received[0]["action"] == "oom_recovery"

    def test_callback_receives_event_dict(self, tmp_path: Path):
        received = []
        mon = SelfHealMonitor("n", tmp_path, {"lr": 0.01}, on_event=received.append)
        mon.feed_stderr("nan loss detected")
        event = received[0]
        assert "action" in event
        assert "failure_type" in event
        assert "detail" in event
        assert "retry_count" in event
        assert "node_id" in event
        assert "timestamp" in event


# ─────────────────────────────────────────────────────────────────────────────
# feed_stderr — benign lines
# ─────────────────────────────────────────────────────────────────────────────

class TestFeedStderrBenign:
    def test_benign_line_returns_none(self, tmp_path: Path):
        mon = SelfHealMonitor("n", tmp_path, {})
        result = mon.feed_stderr("Epoch 1/10: training loss 0.3")
        assert result is None

    def test_empty_line_returns_none(self, tmp_path: Path):
        mon = SelfHealMonitor("n", tmp_path, {})
        assert mon.feed_stderr("") is None

    def test_no_events_from_benign_lines(self, tmp_path: Path):
        mon = SelfHealMonitor("n", tmp_path, {})
        for line in ["INFO:root: training", "Step 10/100", "val_loss=0.5"]:
            mon.feed_stderr(line)
        assert mon.events == []
        assert mon.retry_count == 0


# ─────────────────────────────────────────────────────────────────────────────
# decision-log.md written
# ─────────────────────────────────────────────────────────────────────────────

class TestDecisionLog:
    def test_decision_log_written_on_recovery(self, tmp_path: Path):
        mon = SelfHealMonitor(
            "node-001", tmp_path, {"batch_size": 8, "gradient_accumulation_steps": 1}
        )
        mon.feed_stderr("CUDA out of memory.")
        log_path = tmp_path / "decision-log.md"
        assert log_path.exists()
        content = log_path.read_text()
        assert "SelfHealMonitor" in content
        assert "node-001" in content

    def test_decision_log_accumulates_entries(self, tmp_path: Path):
        mon = SelfHealMonitor(
            "node-001", tmp_path,
            {"batch_size": 32, "gradient_accumulation_steps": 1, "lr": 0.01}
        )
        mon.feed_stderr("CUDA out of memory.")
        mon.feed_stderr("nan loss step 50")
        content = (tmp_path / "decision-log.md").read_text()
        assert content.count("SelfHealMonitor") == 2


# ─────────────────────────────────────────────────────────────────────────────
# supervise() async interface
# ─────────────────────────────────────────────────────────────────────────────

class TestSuperviseAsync:
    def test_supervise_returns_exit_code_and_events(self, tmp_path: Path):
        """supervise() with a mock Popen that emits OOM → oom_recovery event."""
        mon = SelfHealMonitor(
            "node-001", tmp_path,
            {"batch_size": 32, "gradient_accumulation_steps": 1}
        )

        # Mock Popen: stderr has OOM line, process exits with code 1
        mock_proc = MagicMock()
        mock_proc.stderr = iter([
            "CUDA out of memory. Tried to allocate 2.00 GiB\n",
            "Training stopped.\n",
        ])
        mock_proc.wait.return_value = 1

        exit_code, events = asyncio.run(mon.supervise(mock_proc))

        assert exit_code == 1
        assert len(events) == 1
        assert events[0]["action"] == "oom_recovery"

    def test_supervise_clean_process_no_events(self, tmp_path: Path):
        """Clean process (no failure lines) → empty events list."""
        mon = SelfHealMonitor("n", tmp_path, {})
        mock_proc = MagicMock()
        mock_proc.stderr = iter(["Step 1/100\n", "Step 2/100\n"])
        mock_proc.wait.return_value = 0

        exit_code, events = asyncio.run(mon.supervise(mock_proc))
        assert exit_code == 0
        assert events == []

    def test_supervise_multiple_failures(self, tmp_path: Path):
        """Multiple distinct failures → multiple recovery events."""
        mon = SelfHealMonitor(
            "n", tmp_path,
            {"batch_size": 32, "gradient_accumulation_steps": 1, "lr": 0.01}
        )
        mock_proc = MagicMock()
        mock_proc.stderr = iter([
            "CUDA out of memory.\n",
            "nan loss at step 5\n",
        ])
        mock_proc.wait.return_value = 1

        exit_code, events = asyncio.run(mon.supervise(mock_proc))
        assert len(events) == 2
        actions = {e["action"] for e in events}
        assert "oom_recovery" in actions
        assert "nan_recovery" in actions
