"""A preflight check that was not run is reported as not run.

At setup there is no candidate worktree, so the micro-train behind
`loss_decreasing` cannot execute and the check returns None. The preflight then
printed "PASSED — environment ready", and a setup agent reported it as three
verified checks. Nothing later collects the deferral either: integrity check 5
rejects only NaN, Inf or constant loss.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parent.parent

pytest.importorskip("torch")


def _preflight(tmp_path: Path, mode: str) -> subprocess.CompletedProcess:
    run_dir = tmp_path / ".evor" / "runs" / "m1" / "r1"
    run_dir.mkdir(parents=True)
    return subprocess.run(
        [sys.executable, "-m", "evor", "preflight", "--run-id", "r1",
         "--run-dir", str(run_dir), "--mode", mode, "--no-gpu-check"],
        capture_output=True, text=True, timeout=300,
        env={**os.environ, "PYTHONPATH": str(HARNESS)},
        cwd=tmp_path,
    )


def _report(proc: subprocess.CompletedProcess) -> dict:
    start = proc.stdout.index("{")
    return json.loads(proc.stdout[start:proc.stdout.rindex("}") + 1])


def test_full_mode_at_setup_lists_loss_decreasing_as_unverified(tmp_path: Path) -> None:
    proc = _preflight(tmp_path, "full")
    assert proc.returncode == 0, proc.stderr
    report = _report(proc)
    assert report["checks"]["loss_decreasing"] is None
    assert report["unverified"] == ["loss_decreasing"]
    assert "UNVERIFIED" in proc.stderr
    assert "environment ready" not in proc.stderr


def test_env_only_has_nothing_unverified(tmp_path: Path) -> None:
    """env_only does not attempt the check, so there is nothing to disclose."""
    proc = _preflight(tmp_path, "env_only")
    assert proc.returncode == 0, proc.stderr
    assert "unverified" not in _report(proc)
