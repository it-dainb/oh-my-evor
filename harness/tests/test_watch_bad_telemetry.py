"""An empty or directory --telemetry is a usage error with a clear reason, not a crash."""
import json
import subprocess
import sys
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[1]


def _run(*args):
    return subprocess.run([sys.executable, "-m", "evor.watch", *args], cwd=HARNESS,
                          capture_output=True, text=True, timeout=30)


def test_empty_telemetry_is_reported(tmp_path):
    r = _run("--telemetry", "", "--pid", "1")
    assert r.returncode == 2
    assert json.loads(r.stdout)["verdict"] == "bad_arguments"


def test_directory_telemetry_is_reported(tmp_path):
    r = _run("--telemetry", str(tmp_path), "--pid", "1")
    assert r.returncode == 2
    assert "telemetry.jsonl" in json.loads(r.stdout)["reason"]
