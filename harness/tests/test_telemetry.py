"""
Unit tests for TelemetryCallback (harness/evor/telemetry.py).

Coverage:
  - read_records() returns empty list when no file exists
  - read_records() parses JSONL written by env-path pattern
  - read_records() skips malformed lines silently
  - run_dir=None falls back to relative path (no exception on construction)
  - telemetry_path property resolves correctly
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evor.telemetry import TelemetryCallback


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _make_cb(tmp_path: Path, node_id: str = "n1", run_id: str = "r1") -> TelemetryCallback:
    return TelemetryCallback(node_id=node_id, run_id=run_id, run_dir=tmp_path)


def _write_record(path: Path, step: int, **metrics) -> None:
    """Write one JSONL record directly (env-path pattern simulation)."""
    record = {"step": step, "node_id": "n1", "run_id": "r1", "timestamp": "2026-01-01T00:00:00Z"}
    record.update(metrics)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as fh:
        fh.write(json.dumps(record) + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# read_records() round-trip
# ─────────────────────────────────────────────────────────────────────────────

class TestReadRecords:
    def test_empty_when_no_file(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        assert cb.read_records() == []

    def test_parses_env_path_written_records(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        _write_record(cb.telemetry_path, step=0, train_loss=0.9)
        _write_record(cb.telemetry_path, step=1, train_loss=0.7)

        records = cb.read_records()
        assert len(records) == 2
        assert records[0]["train_loss"] == pytest.approx(0.9)
        assert records[1]["train_loss"] == pytest.approx(0.7)

    def test_required_fields_present(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        _write_record(cb.telemetry_path, step=5, val_metric=0.88)

        rec = cb.read_records()[0]
        assert rec["step"] == 5
        assert rec["node_id"] == "n1"
        assert rec["run_id"] == "r1"
        assert "timestamp" in rec

    def test_many_records(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        for i in range(10):
            _write_record(cb.telemetry_path, step=i, train_loss=float(i))
        assert len(cb.read_records()) == 10

    def test_skips_malformed_lines(self, tmp_path: Path):
        cb = _make_cb(tmp_path)
        cb.telemetry_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cb.telemetry_path, "w") as fh:
            fh.write('{"step": 0, "train_loss": 0.5}\n')
            fh.write("not valid json\n")
            fh.write('{"step": 1, "train_loss": 0.4}\n')

        records = cb.read_records()
        assert len(records) == 2
        assert records[0]["step"] == 0
        assert records[1]["step"] == 1


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
