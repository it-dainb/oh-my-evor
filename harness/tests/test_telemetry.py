"""
Unit tests for TelemetryCallback (harness/evor/telemetry.py).

Coverage:
  - log() writes a JSONL line with required fields (step, node_id, run_id, timestamp)
  - log() writes recognized metric kwargs; unknown keys are silently dropped
  - multiple log() calls each produce one line (append)
  - grad_norm absent case (XGBoost / tabular) → record still valid (R6)
  - read_records() round-trips JSONL back to list[dict]
  - on_epoch_end() populates train_loss and epoch from Keras-style logs
  - on_validation_epoch_end() buffers val_metric onto next on_train_batch_end
  - run_dir=None falls back to relative path (no exception on construction)
  - internal step counter increments when step is omitted
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from evor.telemetry import TelemetryCallback


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _make_cb(tmp_path: Path, node_id: str = "n1", run_id: str = "r1") -> TelemetryCallback:
    return TelemetryCallback(node_id=node_id, run_id=run_id, run_dir=tmp_path)


def _read_jsonl(path: Path) -> list[dict]:
    records = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


# ─────────────────────────────────────────────────────────────────────────────
# log() — required fields
# ─────────────────────────────────────────────────────────────────────────────

class TestLogRequiredFields:
    def test_required_fields_present(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.log(step=0, train_loss=1.0)

        records = _read_jsonl(cb.telemetry_path)
        assert len(records) == 1
        rec = records[0]
        assert rec["step"] == 0
        assert rec["node_id"] == "n1"
        assert rec["run_id"] == "r1"
        assert "timestamp" in rec
        assert isinstance(rec["timestamp"], str)

    def test_step_written_as_int(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.log(step=42, train_loss=0.5)
        records = _read_jsonl(cb.telemetry_path)
        assert records[0]["step"] == 42

    def test_node_id_and_run_id_match_constructor(self, tmp_path: Path):
        cb = TelemetryCallback("my-node", "my-run", run_dir=tmp_path)
        cb.log(step=1, train_loss=0.3)
        rec = _read_jsonl(cb.telemetry_path)[0]
        assert rec["node_id"] == "my-node"
        assert rec["run_id"] == "my-run"


# ─────────────────────────────────────────────────────────────────────────────
# log() — metric fields
# ─────────────────────────────────────────────────────────────────────────────

class TestLogMetricFields:
    def test_known_metric_fields_written(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.log(step=0, train_loss=1.0, lr=0.01, grad_norm=2.5, val_metric=0.7)
        rec = _read_jsonl(cb.telemetry_path)[0]
        assert rec["train_loss"] == pytest.approx(1.0)
        assert rec["lr"] == pytest.approx(0.01)
        assert rec["grad_norm"] == pytest.approx(2.5)
        assert rec["val_metric"] == pytest.approx(0.7)

    def test_unknown_kwargs_silently_dropped(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.log(step=0, train_loss=0.9, totally_unknown_field="ignored")
        rec = _read_jsonl(cb.telemetry_path)[0]
        assert "totally_unknown_field" not in rec
        assert "train_loss" in rec

    def test_none_metric_fields_not_written(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.log(step=0, train_loss=0.5, grad_norm=None)
        rec = _read_jsonl(cb.telemetry_path)[0]
        # None values should NOT appear in the record
        assert "grad_norm" not in rec
        assert rec["train_loss"] == pytest.approx(0.5)

    def test_all_metric_fields_accepted(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        all_metrics = {
            "epoch": 1.0,
            "train_loss": 0.8,
            "val_metric": 0.7,
            "lr": 0.001,
            "grad_norm": 1.5,
            "param_norm": 3.2,
            "update_ratio": 0.05,
            "throughput": 128.0,
            "gpu_util": 0.85,
            "mem_used_gb": 6.5,
            "mem_total_gb": 8.0,
        }
        cb.log(step=0, **all_metrics)
        rec = _read_jsonl(cb.telemetry_path)[0]
        for k, v in all_metrics.items():
            assert rec[k] == pytest.approx(v), f"Field {k!r} missing or wrong"


# ─────────────────────────────────────────────────────────────────────────────
# grad_norm absent (R6 — XGBoost / tabular case)
# ─────────────────────────────────────────────────────────────────────────────

class TestGradNormAbsent:
    def test_grad_norm_absent_does_not_crash(self, tmp_path: Path):
        """Tabular/XGBoost models omit grad_norm; record must still be valid."""
        cb = _make_cb(tmp_path)
        cb.log(step=0, train_loss=0.5)   # no grad_norm
        cb.log(step=1, train_loss=0.4)

        records = _read_jsonl(cb.telemetry_path)
        assert len(records) == 2
        assert "grad_norm" not in records[0]
        assert "grad_norm" not in records[1]
        assert records[0]["train_loss"] == pytest.approx(0.5)
        assert records[1]["train_loss"] == pytest.approx(0.4)

    def test_telemetry_path_is_valid_jsonl_without_grad_norm(self, tmp_path: Path):
        """Without grad_norm, every line must still parse as valid JSON."""
        cb = _make_cb(tmp_path)
        for i in range(5):
            cb.log(step=i, train_loss=1.0 - i * 0.1)

        records = _read_jsonl(cb.telemetry_path)
        assert len(records) == 5
        for rec in records:
            assert "step" in rec
            assert "node_id" in rec
            assert "grad_norm" not in rec


# ─────────────────────────────────────────────────────────────────────────────
# Multiple log() calls — append behaviour
# ─────────────────────────────────────────────────────────────────────────────

class TestAppendBehaviour:
    def test_multiple_logs_each_produce_one_line(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        for i in range(4):
            cb.log(step=i, train_loss=1.0 - i * 0.1)
        records = _read_jsonl(cb.telemetry_path)
        assert len(records) == 4

    def test_steps_in_order(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        for i in range(3):
            cb.log(step=i, train_loss=float(i))
        records = _read_jsonl(cb.telemetry_path)
        assert [r["step"] for r in records] == [0, 1, 2]


# ─────────────────────────────────────────────────────────────────────────────
# read_records() round-trip
# ─────────────────────────────────────────────────────────────────────────────

class TestReadRecords:
    def test_roundtrip_from_log_to_read(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.log(step=0, train_loss=0.9, grad_norm=1.1)
        cb.log(step=1, train_loss=0.7, grad_norm=0.9)

        records = cb.read_records()
        assert len(records) == 2
        assert records[0]["train_loss"] == pytest.approx(0.9)
        assert records[1]["train_loss"] == pytest.approx(0.7)

    def test_read_records_empty_when_no_logs(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        assert cb.read_records() == []

    def test_read_records_after_many_calls(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        for i in range(10):
            cb.log(step=i, train_loss=float(i))
        assert len(cb.read_records()) == 10


# ─────────────────────────────────────────────────────────────────────────────
# Internal step counter
# ─────────────────────────────────────────────────────────────────────────────

class TestStepCounter:
    def test_step_counter_auto_increments(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.log(train_loss=0.9)    # step omitted → step=0
        cb.log(train_loss=0.8)    # step omitted → step=1
        records = _read_jsonl(cb.telemetry_path)
        assert records[0]["step"] == 0
        assert records[1]["step"] == 1

    def test_explicit_step_updates_counter(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.log(step=10, train_loss=0.5)
        cb.log(train_loss=0.4)    # implicit → step=11
        records = _read_jsonl(cb.telemetry_path)
        assert records[0]["step"] == 10
        assert records[1]["step"] == 11


# ─────────────────────────────────────────────────────────────────────────────
# Keras hook: on_epoch_end
# ─────────────────────────────────────────────────────────────────────────────

class TestOnEpochEnd:
    def test_on_epoch_end_logs_loss_and_epoch(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.on_epoch_end(epoch=0, logs={"loss": 1.2, "val_loss": 0.9})

        records = cb.read_records()
        assert len(records) == 1
        rec = records[0]
        assert rec["train_loss"] == pytest.approx(1.2)
        assert rec["val_metric"] == pytest.approx(0.9)
        assert rec["epoch"] == pytest.approx(0.0)

    def test_on_epoch_end_handles_empty_logs(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.on_epoch_end(epoch=2)   # logs=None
        records = cb.read_records()
        assert len(records) == 1
        # Only epoch should be present (no train_loss or val_metric)
        assert records[0]["epoch"] == pytest.approx(2.0)
        assert "train_loss" not in records[0]


# ─────────────────────────────────────────────────────────────────────────────
# Lightning hook: on_validation_epoch_end + on_train_batch_end
# ─────────────────────────────────────────────────────────────────────────────

class TestLightningHooks:
    def _mock_trainer(
        self,
        global_step: int = 0,
        current_epoch: int = 0,
        val_metric_name: str = "val_acc",
        val_metric_val: float = 0.88,
    ) -> MagicMock:
        trainer = MagicMock()
        trainer.global_step = global_step
        trainer.current_epoch = current_epoch
        trainer.callback_metrics = {val_metric_name: val_metric_val}
        trainer.optimizers = []
        # Patch grad_norm path to raise (optional field)
        trainer.fit_loop.epoch_loop.batch_loop.optimizer_loop.grad_norm = None
        return trainer

    def test_val_metric_buffered_to_next_batch(self, tmp_path: Path):
        """val_metric set in on_validation_epoch_end attaches to next batch record."""
        cb = _make_cb(tmp_path)
        trainer = self._mock_trainer(val_metric_name="val_acc", val_metric_val=0.88)
        pl_module = MagicMock()
        pl_module.parameters.return_value = []

        cb.on_validation_epoch_end(trainer, pl_module)
        # Buffer set; next batch should carry it
        assert cb._pending_val_metric == pytest.approx(0.88)

        # Simulate a batch end — val_metric should be attached
        outputs = {"loss": 0.5}
        cb.on_train_batch_end(trainer, pl_module, outputs, batch=None, batch_idx=0)

        records = cb.read_records()
        assert len(records) == 1
        assert records[0]["val_metric"] == pytest.approx(0.88)
        # Buffer cleared after attachment
        assert cb._pending_val_metric is None

    def test_on_train_batch_end_extracts_loss(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        trainer = self._mock_trainer()
        pl_module = MagicMock()
        pl_module.parameters.return_value = []

        cb.on_train_batch_end(
            trainer, pl_module,
            outputs={"loss": 0.75},
            batch=None, batch_idx=5,
        )
        records = cb.read_records()
        assert len(records) == 1
        assert records[0]["train_loss"] == pytest.approx(0.75)


# ─────────────────────────────────────────────────────────────────────────────
# run_dir=None: relative path, no crash
# ─────────────────────────────────────────────────────────────────────────────

class TestNullRunDir:
    def test_constructor_with_none_run_dir_does_not_crash(self):
        cb = TelemetryCallback("node-x", "run-x", run_dir=None)
        assert "node-x" in str(cb.telemetry_path)

    def test_telemetry_path_property(self, tmp_path: Path):
        cb = TelemetryCallback("n1", "r1", run_dir=tmp_path)
        assert cb.telemetry_path == tmp_path / "nodes" / "n1" / "telemetry.jsonl"
