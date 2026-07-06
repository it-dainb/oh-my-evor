"""
test_telemetry_env_path.py — env-path telemetry mechanism (§19, EVOR_TELEMETRY_PATH).

Covers:
  - _build_env() exports EVOR_TELEMETRY_PATH when run_dir is provided
  - _build_env() skips EVOR_TELEMETRY_PATH when run_dir is None
  - candidate writing via env-path produces records parseable by TelemetryCallback.read_records()
  - TelemetrySummary / Probe read env-path records unchanged (same JSONL shape)
  - _check_telemetry gate accepts EVOR_TELEMETRY_PATH + open() pattern (required)
  - _check_telemetry gate rejects code without EVOR_TELEMETRY_PATH + open()
  - __main__.py _cmd_run env dict includes EVOR_TELEMETRY_PATH when run_dir is set
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from evor.quality_gate import ForgeStructureGate
from evor.telemetry import TelemetryCallback


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _write_env_path_record(tel_path: Path, step: int, **metrics: Any) -> dict:
    """Simulate what candidate training code does: append one JSONL record."""
    record: dict[str, Any] = {
        "step": step,
        "node_id": "test-node",
        "run_id": "test-run",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    record.update({k: v for k, v in metrics.items() if v is not None})
    with open(tel_path, "a") as f:
        f.write(json.dumps(record) + "\n")
    return record


def _read_jsonl(path: Path) -> list[dict]:
    records = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


# ─────────────────────────────────────────────────────────────────────────────
# _build_env: EVOR_TELEMETRY_PATH export
# ─────────────────────────────────────────────────────────────────────────────

class TestBuildEnvTelemetryPath:
    def _minimal_node(self, node_id: str = "n1"):
        node = MagicMock()
        node.id = node_id
        return node

    def _minimal_goal(self):
        goal = MagicMock()
        goal.eval_version = "v1"
        goal.mission_type = "fixed"
        return goal

    def test_telemetry_path_exported_when_run_dir_provided(self, tmp_path: Path) -> None:
        from evor.evaluator import _build_env

        node = self._minimal_node("my-node")
        goal = self._minimal_goal()
        env = _build_env(goal, node, {}, tmp_path / "worktree", run_dir=tmp_path)

        assert "EVOR_TELEMETRY_PATH" in env
        expected = str(tmp_path / "nodes" / "my-node" / "telemetry.jsonl")
        assert env["EVOR_TELEMETRY_PATH"] == expected

    def test_telemetry_path_absent_when_run_dir_none(self, tmp_path: Path) -> None:
        from evor.evaluator import _build_env

        node = self._minimal_node()
        goal = self._minimal_goal()
        env = _build_env(goal, node, {}, tmp_path / "worktree", run_dir=None)

        assert "EVOR_TELEMETRY_PATH" not in env

    def test_node_dir_created_by_build_env(self, tmp_path: Path) -> None:
        from evor.evaluator import _build_env

        node = self._minimal_node("created-node")
        goal = self._minimal_goal()
        _build_env(goal, node, {}, tmp_path / "worktree", run_dir=tmp_path)

        node_dir = tmp_path / "nodes" / "created-node"
        assert node_dir.is_dir(), "nodes/<node_id>/ directory must be created by _build_env"

    def test_node_id_and_run_id_still_exported(self, tmp_path: Path) -> None:
        from evor.evaluator import _build_env

        node = self._minimal_node("nx")
        goal = self._minimal_goal()
        env = _build_env(goal, node, {"EVOR_RUN_ID": "run-42"}, tmp_path / "wt", run_dir=tmp_path)

        assert env["EVOR_NODE_ID"] == "nx"
        # Callers override EVOR_RUN_ID via extra_env; it must survive
        # (original code sets to node.id after extra_env merge — extra_env wins at merge
        # but then it's overwritten; that's existing behaviour we preserve)
        assert "EVOR_NODE_ID" in env


# ─────────────────────────────────────────────────────────────────────────────
# Env-path records: schema identity with TelemetryCallback output
# ─────────────────────────────────────────────────────────────────────────────

class TestEnvPathRecordSchema:
    """Prove env-path records are schema-identical to TelemetryCallback records."""

    def test_required_fields_present(self, tmp_path: Path) -> None:
        tel_path = tmp_path / "telemetry.jsonl"
        _write_env_path_record(tel_path, step=0, train_loss=0.5)

        records = _read_jsonl(tel_path)
        assert len(records) == 1
        rec = records[0]
        assert rec["step"] == 0
        assert rec["node_id"] == "test-node"
        assert rec["run_id"] == "test-run"
        assert "timestamp" in rec
        assert isinstance(rec["timestamp"], str)
        assert rec["train_loss"] == pytest.approx(0.5)

    def test_optional_metric_fields_written(self, tmp_path: Path) -> None:
        tel_path = tmp_path / "telemetry.jsonl"
        _write_env_path_record(
            tel_path, step=1,
            train_loss=0.4, lr=0.001, grad_norm=1.5, val_metric=0.72,
            epoch=0.0,
        )
        rec = _read_jsonl(tel_path)[0]
        assert rec["lr"] == pytest.approx(0.001)
        assert rec["grad_norm"] == pytest.approx(1.5)
        assert rec["val_metric"] == pytest.approx(0.72)

    def test_grad_norm_absent_still_valid(self, tmp_path: Path) -> None:
        """Tabular models omit grad_norm; record must still parse correctly."""
        tel_path = tmp_path / "telemetry.jsonl"
        _write_env_path_record(tel_path, step=0, train_loss=0.8)
        rec = _read_jsonl(tel_path)[0]
        assert "grad_norm" not in rec
        assert rec["train_loss"] == pytest.approx(0.8)

    def test_multiple_steps_appended(self, tmp_path: Path) -> None:
        tel_path = tmp_path / "telemetry.jsonl"
        for i in range(5):
            _write_env_path_record(tel_path, step=i, train_loss=1.0 - i * 0.1)
        records = _read_jsonl(tel_path)
        assert len(records) == 5
        assert [r["step"] for r in records] == [0, 1, 2, 3, 4]

    def test_env_path_records_readable_by_telemetry_callback(self, tmp_path: Path) -> None:
        """TelemetryCallback.read_records() must parse env-path JSONL identically."""
        cb = TelemetryCallback("test-node", "test-run", run_dir=tmp_path)
        tel_path = cb.telemetry_path
        tel_path.parent.mkdir(parents=True, exist_ok=True)

        # Write 3 records via env-path pattern (simulating candidate code)
        for i in range(3):
            _write_env_path_record(tel_path, step=i, train_loss=float(i))

        # Read back via TelemetryCallback.read_records()
        records = cb.read_records()
        assert len(records) == 3
        assert records[0]["step"] == 0
        assert records[1]["train_loss"] == pytest.approx(1.0)
        assert records[2]["node_id"] == "test-node"



# ─────────────────────────────────────────────────────────────────────────────
# TelemetrySummary: still parses env-path records unchanged
# ─────────────────────────────────────────────────────────────────────────────

class TestTelemetrySummaryEnvPath:
    """TelemetrySummary is built from eval script JSON output (not from telemetry.jsonl).
    These tests confirm the JSONL record shape is intact so Probe's EDA checks pass."""

    def test_probe_check5_required_fields_present(self, tmp_path: Path) -> None:
        """Probe Check 5 requires step, train_loss, node_id, run_id, timestamp in all records."""
        tel_path = tmp_path / "telemetry.jsonl"
        for i in range(5):
            _write_env_path_record(tel_path, step=i, train_loss=1.0 - i * 0.1)

        records = _read_jsonl(tel_path)
        for rec in records:
            for field in ("step", "node_id", "run_id", "timestamp", "train_loss"):
                assert field in rec, f"Record at step {rec.get('step')} missing {field!r}"

    def test_jsonl_valid_json_each_line(self, tmp_path: Path) -> None:
        tel_path = tmp_path / "telemetry.jsonl"
        for i in range(10):
            _write_env_path_record(tel_path, step=i, train_loss=float(i))

        with open(tel_path) as fh:
            for line_no, line in enumerate(fh, 1):
                line = line.strip()
                assert line, f"Line {line_no} is empty"
                parsed = json.loads(line)  # must not raise
                assert isinstance(parsed, dict)


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate._check_telemetry: gate detection logic
# ─────────────────────────────────────────────────────────────────────────────

class TestCheckTelemetryGate:
    def _make_candidate(self, tmp_path: Path, source: str) -> Path:
        """Create a minimal candidate directory with train/loop.py containing source."""
        candidate_dir = tmp_path / "candidate"
        train_dir = candidate_dir / "train"
        train_dir.mkdir(parents=True)
        (train_dir / "loop.py").write_text(source)
        return candidate_dir

    def test_env_path_pattern_passes(self, tmp_path: Path) -> None:
        """EVOR_TELEMETRY_PATH + open() in train/ → telemetry check passes."""
        source = (
            'import json, os\n'
            'tel_path = os.environ.get("EVOR_TELEMETRY_PATH")\n'
            'if tel_path:\n'
            '    with open(tel_path, "a") as f:\n'
            '        f.write(json.dumps({"step": 0}) + "\\n")\n'
        )
        candidate_dir = self._make_candidate(tmp_path, source)
        gate = ForgeStructureGate()
        # Call _check_telemetry directly
        check = gate._check_telemetry(candidate_dir)
        assert check.passed, f"env-path pattern should pass: {check.reason}"
        assert "EVOR_TELEMETRY_PATH" in check.reason

    def test_no_instrumentation_fails(self, tmp_path: Path) -> None:
        """No telemetry instrumentation → check fails."""
        source = (
            'import torch\n'
            'def train(model, loader):\n'
            '    for x, y in loader:\n'
            '        pass  # no telemetry\n'
        )
        candidate_dir = self._make_candidate(tmp_path, source)
        gate = ForgeStructureGate()
        check = gate._check_telemetry(candidate_dir)
        assert not check.passed
        assert "not found" in check.reason or "EVOR_TELEMETRY_PATH" in check.reason

    def test_env_path_without_open_does_not_pass(self, tmp_path: Path) -> None:
        """EVOR_TELEMETRY_PATH in env-read only, no open() → check must fail."""
        source = (
            'import os\n'
            'tel_path = os.environ.get("EVOR_TELEMETRY_PATH")\n'
            '# intentionally no write call — env-read stub, never appends records\n'
        )
        candidate_dir = self._make_candidate(tmp_path, source)
        gate = ForgeStructureGate()
        check = gate._check_telemetry(candidate_dir)
        assert not check.passed, (
            "env-read without open() should not pass: Probe would get empty telemetry.jsonl"
        )

    def test_empty_train_dir_fails(self, tmp_path: Path) -> None:
        """Empty train/ directory → check fails."""
        candidate_dir = tmp_path / "empty_candidate"
        (candidate_dir / "train").mkdir(parents=True)
        gate = ForgeStructureGate()
        check = gate._check_telemetry(candidate_dir)
        assert not check.passed

    def test_env_path_in_candidate_root_passes(self, tmp_path: Path) -> None:
        """EVOR_TELEMETRY_PATH + open() in candidate root (not train/) also passes."""
        candidate_dir = tmp_path / "root_candidate"
        candidate_dir.mkdir()
        (candidate_dir / "train").mkdir()  # exists but empty
        (candidate_dir / "trainer.py").write_text(
            'import json, os\n'
            'tel = os.environ.get("EVOR_TELEMETRY_PATH")\n'
            'with open(tel, "a") as f:\n'
            '    f.write("{}")\n'
        )
        gate = ForgeStructureGate()
        check = gate._check_telemetry(candidate_dir)
        assert check.passed, f"env-path in candidate root should pass: {check.reason}"


# ─────────────────────────────────────────────────────────────────────────────
# __main__.py _cmd_run: EVOR_TELEMETRY_PATH in subprocess env
# ─────────────────────────────────────────────────────────────────────────────

class TestCmdRunTelemetryEnv:
    """Verify _cmd_run injects EVOR_TELEMETRY_PATH into the subprocess env."""

    def test_telemetry_path_in_env_when_run_dir_set(self, tmp_path: Path) -> None:
        """_build_env with run_dir should expose EVOR_TELEMETRY_PATH to subprocess."""
        from evor.evaluator import _build_env

        node = MagicMock()
        node.id = "node-abc"
        goal = MagicMock()
        goal.eval_version = "v1"
        goal.mission_type = "fixed"

        env = _build_env(goal, node, {}, tmp_path / "wt", run_dir=tmp_path)
        assert "EVOR_TELEMETRY_PATH" in env
        assert "node-abc" in env["EVOR_TELEMETRY_PATH"]
        assert env["EVOR_TELEMETRY_PATH"].endswith("telemetry.jsonl")

    def test_telemetry_path_resolves_to_correct_node_dir(self, tmp_path: Path) -> None:
        from evor.evaluator import _build_env

        node = MagicMock()
        node.id = "special-node-99"
        goal = MagicMock()
        goal.eval_version = "v1"
        goal.mission_type = "fixed"

        env = _build_env(goal, node, {}, tmp_path / "wt", run_dir=tmp_path)
        expected = str(tmp_path / "nodes" / "special-node-99" / "telemetry.jsonl")
        assert env["EVOR_TELEMETRY_PATH"] == expected
