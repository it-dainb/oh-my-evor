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


# ─────────────────────────────────────────────────────────────────────────────
# P2-11: export_wandb_to_csv
# ─────────────────────────────────────────────────────────────────────────────

from evor.telemetry import export_wandb_to_csv  # noqa: E402


class TestExportWandbToCsv:
    def test_no_wandb_dir_returns_none(self, tmp_path: Path) -> None:
        """No .wandb directory → no-op, returns None."""
        result = export_wandb_to_csv(tmp_path)
        assert result is None

    def test_empty_wandb_dir_returns_none(self, tmp_path: Path) -> None:
        """Empty .wandb directory with no summary → returns None."""
        (tmp_path / ".wandb").mkdir()
        result = export_wandb_to_csv(tmp_path)
        assert result is None

    def test_summary_json_writes_csv(self, tmp_path: Path) -> None:
        """wandb-summary.json present → telemetry.csv written, path returned."""
        import json as _json

        summary = {"train_loss": 0.42, "val_metric": 0.88, "epoch": 5}
        wandb_dir = tmp_path / ".wandb"
        wandb_dir.mkdir()
        (wandb_dir / "wandb-summary.json").write_text(_json.dumps(summary))

        result = export_wandb_to_csv(tmp_path)
        assert result is not None
        assert result.name == "telemetry.csv"
        assert result.exists()
        content = result.read_text()
        # CSV must have a header row and at least one data row
        lines = [l for l in content.splitlines() if l.strip()]
        assert len(lines) >= 2
        assert "train_loss" in lines[0]

    def test_jsonl_records_write_csv(self, tmp_path: Path) -> None:
        """wandb JSONL history → CSV rows per record."""
        import json as _json

        wandb_dir = tmp_path / ".wandb"
        wandb_dir.mkdir()
        history_path = wandb_dir / "history.jsonl"
        records = [
            {"step": 0, "train_loss": 0.9},
            {"step": 1, "train_loss": 0.7},
            {"step": 2, "train_loss": 0.5},
        ]
        with open(history_path, "w") as fh:
            for r in records:
                fh.write(_json.dumps(r) + "\n")

        result = export_wandb_to_csv(tmp_path)
        assert result is not None
        lines = [l for l in result.read_text().splitlines() if l.strip()]
        # header + 3 data rows
        assert len(lines) == 4

    def test_idempotent_overwrite(self, tmp_path: Path) -> None:
        """Calling twice overwrites the CSV (not appends)."""
        import json as _json

        wandb_dir = tmp_path / ".wandb"
        wandb_dir.mkdir()
        (wandb_dir / "wandb-summary.json").write_text(_json.dumps({"loss": 0.1}))

        export_wandb_to_csv(tmp_path)
        result = export_wandb_to_csv(tmp_path)
        assert result is not None
        lines = [l for l in result.read_text().splitlines() if l.strip()]
        # Should be header + 1 row = 2 lines, not 4 (no append)
        assert len(lines) == 2
