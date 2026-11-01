"""trainer_completed counts the steps the trainer recorded. A sealed evaluator that reports no
step count leaves the summary at 0, which means "not reported", not "trained zero steps"."""
import json
from types import SimpleNamespace

from evor.integrity import IntegrityGate


def _telemetry(path, n):
    path.write_text("".join(json.dumps({"step": i, "train_loss": 1.0}) + "\n" for i in range(n)))
    return path


def _check(config, total_steps, telemetry):
    node = SimpleNamespace(config=config)
    result = SimpleNamespace(telemetry_summary=SimpleNamespace(total_steps=total_steps))
    return IntegrityGate()._check_trainer_completed(node, result, telemetry)


def test_completed_run_with_unreported_steps_passes(tmp_path):
    assert _check({"steps": 1920}, 0, _telemetry(tmp_path / "t.jsonl", 1920)) is True


def test_cut_short_run_still_fails(tmp_path):
    assert _check({"steps": 1920}, 0, _telemetry(tmp_path / "t.jsonl", 500)) is False


def test_no_telemetry_and_no_reported_steps_is_not_evaluated(tmp_path):
    assert _check({"steps": 1920}, 0, tmp_path / "missing.jsonl") is None


def test_reported_steps_are_used_when_telemetry_is_absent(tmp_path):
    assert _check({"steps": 1920}, 1920, tmp_path / "missing.jsonl") is True
