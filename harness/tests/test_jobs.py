"""
harness/tests/test_jobs.py

Coverage:
  start_job:
    test_start_job_returns_all_keys         — {job_id, status_path, log_path} present
    test_start_job_returns_instantly        — returns in <2 s even with a long-running child
    test_start_job_creates_status_running   — status.json state=running written immediately
    test_start_job_log_path_in_run_dir      — log_path is under run_dir/jobs/<id>/

  Supervisor lifecycle:
    test_job_transitions_to_succeeded       — fast child exits 0 → state=succeeded
    test_job_transitions_to_failed          — child exits 1 → state=failed + exit_code=1
    test_log_file_written_after_job         — log.jsonl exists once job completes

  status():
    test_status_returns_dict_with_state     — status() dict has 'state' key
    test_status_unknown_job_returns_error   — missing job → error dict, never raises

  CLI (python -m evor.jobs):
    test_cli_start_outputs_json             — prints {job_id,...} to stdout
    test_cli_start_is_nonblocking           — exits quickly even with a sleeping child
    test_cli_status_outputs_json            — prints status dict to stdout
    test_main_module_jobs_subcommand        — python -m evor jobs start round-trips
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from evor.jobs import start_job
from evor.jobs import status as job_status

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

_PYTHON = sys.executable
_HARNESS_DIR = Path(__file__).resolve().parent.parent


def _evor_env() -> dict[str, str]:
    env = dict(os.environ)
    pypath = str(_HARNESS_DIR)
    if env.get("PYTHONPATH"):
        pypath = f"{pypath}{os.pathsep}{env['PYTHONPATH']}"
    env["PYTHONPATH"] = pypath
    return env


def _make_run_dir(tmp_path: Path) -> Path:
    rd = tmp_path / "runs" / "test-mission" / "run-jobs-001"
    rd.mkdir(parents=True)
    return rd


def _fast_cmd(exit_code: int = 0) -> list[str]:
    """Trivial command that exits with the given code immediately."""
    return [_PYTHON, "-c", f"import sys; sys.exit({exit_code})"]


def _slow_cmd(seconds: float = 30.0) -> list[str]:
    """Command that sleeps for *seconds* — used to prove non-blocking launch."""
    return [_PYTHON, "-c", f"import time; time.sleep({seconds})"]


def _wait_state(run_dir: Path, job_id: str, target: str, timeout: float = 10.0) -> dict:
    """Poll status.json until state == target or timeout; return final dict."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        s = job_status(job_id, run_dir)
        if s.get("state") == target:
            return s
        time.sleep(0.1)
    return job_status(job_id, run_dir)


# ─────────────────────────────────────────────────────────────────────────────
# start_job — return-value shape
# ─────────────────────────────────────────────────────────────────────────────

def test_start_job_returns_all_keys(tmp_path: Path) -> None:
    run_dir = _make_run_dir(tmp_path)
    result = start_job(_fast_cmd(), run_dir)
    assert "job_id" in result
    assert "status_path" in result
    assert "log_path" in result


def test_start_job_returns_instantly(tmp_path: Path) -> None:
    """start_job must return in <2 s even when the child sleeps for 30 s."""
    run_dir = _make_run_dir(tmp_path)
    t0 = time.monotonic()
    start_job(_slow_cmd(30), run_dir)
    elapsed = time.monotonic() - t0
    assert elapsed < 2.0, f"start_job blocked for {elapsed:.2f}s (expected <2s)"


def test_start_job_creates_status_running(tmp_path: Path) -> None:
    """status.json must be present with state=running immediately after start_job."""
    run_dir = _make_run_dir(tmp_path)
    result = start_job(_fast_cmd(), run_dir)
    sp = Path(result["status_path"])
    assert sp.exists(), "status.json not created by start_job"
    data = json.loads(sp.read_text())
    assert data["state"] == "running"
    assert "started_at" in data
    assert "pid" in data


def test_start_job_log_path_in_run_dir(tmp_path: Path) -> None:
    run_dir = _make_run_dir(tmp_path)
    result = start_job(_fast_cmd(), run_dir)
    log = Path(result["log_path"])
    # log_path must be under run_dir/jobs/<job_id>/
    assert str(log).startswith(str(run_dir))
    assert "jobs" in log.parts
    assert log.name == "log.jsonl"


# ─────────────────────────────────────────────────────────────────────────────
# Supervisor lifecycle — transitions
# ─────────────────────────────────────────────────────────────────────────────

def test_job_transitions_to_succeeded(tmp_path: Path) -> None:
    run_dir = _make_run_dir(tmp_path)
    result = start_job(_fast_cmd(0), run_dir)
    final = _wait_state(run_dir, result["job_id"], "succeeded", timeout=10.0)
    assert final["state"] == "succeeded", f"unexpected state: {final}"
    assert final.get("exit_code") == 0


def test_job_transitions_to_failed(tmp_path: Path) -> None:
    run_dir = _make_run_dir(tmp_path)
    result = start_job(_fast_cmd(1), run_dir)
    final = _wait_state(run_dir, result["job_id"], "failed", timeout=10.0)
    assert final["state"] == "failed", f"unexpected state: {final}"
    assert final.get("exit_code") == 1


def test_log_file_written_after_job(tmp_path: Path) -> None:
    """log.jsonl must exist once the job has completed."""
    run_dir = _make_run_dir(tmp_path)
    # Child writes to stdout/stderr so there is log content
    cmd = [_PYTHON, "-c", "print('hello log'); import sys; sys.exit(0)"]
    result = start_job(cmd, run_dir)
    _wait_state(run_dir, result["job_id"], "succeeded", timeout=10.0)
    log = Path(result["log_path"])
    assert log.exists(), "log.jsonl not written after job completion"


# ─────────────────────────────────────────────────────────────────────────────
# status()
# ─────────────────────────────────────────────────────────────────────────────

def test_status_returns_dict_with_state(tmp_path: Path) -> None:
    run_dir = _make_run_dir(tmp_path)
    result = start_job(_fast_cmd(), run_dir)
    s = job_status(result["job_id"], run_dir)
    assert isinstance(s, dict)
    assert "state" in s


def test_status_unknown_job_returns_error(tmp_path: Path) -> None:
    run_dir = _make_run_dir(tmp_path)
    s = job_status("nonexistent-job-id", run_dir)
    assert isinstance(s, dict)
    assert s.get("state") == "unknown"
    assert "error" in s


# ─────────────────────────────────────────────────────────────────────────────
# CLI  python -m evor.jobs
# ─────────────────────────────────────────────────────────────────────────────

def test_cli_start_outputs_json(tmp_path: Path) -> None:
    run_dir = _make_run_dir(tmp_path)
    cmd_json = json.dumps(_fast_cmd())
    proc = subprocess.run(
        [_PYTHON, "-m", "evor.jobs", "start",
         "--run-dir", str(run_dir),
         "--cmd-json", cmd_json],
        capture_output=True, text=True, env=_evor_env(),
        timeout=10,
    )
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert "job_id" in data
    assert "status_path" in data
    assert "log_path" in data


def test_cli_start_is_nonblocking(tmp_path: Path) -> None:
    """python -m evor.jobs start must exit in <2 s even with a sleeping child."""
    run_dir = _make_run_dir(tmp_path)
    cmd_json = json.dumps(_slow_cmd(30))
    t0 = time.monotonic()
    proc = subprocess.run(
        [_PYTHON, "-m", "evor.jobs", "start",
         "--run-dir", str(run_dir),
         "--cmd-json", cmd_json],
        capture_output=True, text=True, env=_evor_env(),
        timeout=10,
    )
    elapsed = time.monotonic() - t0
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert elapsed < 2.0, f"CLI start blocked for {elapsed:.2f}s"


def test_cli_status_outputs_json(tmp_path: Path) -> None:
    run_dir = _make_run_dir(tmp_path)
    # Launch a job first
    cmd_json = json.dumps(_fast_cmd())
    start_proc = subprocess.run(
        [_PYTHON, "-m", "evor.jobs", "start",
         "--run-dir", str(run_dir),
         "--cmd-json", cmd_json],
        capture_output=True, text=True, env=_evor_env(),
        timeout=10,
    )
    assert start_proc.returncode == 0
    job_id = json.loads(start_proc.stdout)["job_id"]

    # Read status via CLI
    st_proc = subprocess.run(
        [_PYTHON, "-m", "evor.jobs", "status",
         "--job-id", job_id,
         "--run-dir", str(run_dir)],
        capture_output=True, text=True, env=_evor_env(),
        timeout=10,
    )
    assert st_proc.returncode == 0, f"stderr: {st_proc.stderr}"
    data = json.loads(st_proc.stdout)
    assert "state" in data


def test_main_module_jobs_subcommand(tmp_path: Path) -> None:
    """python -m evor jobs start round-trips through __main__.py dispatcher."""
    run_dir = _make_run_dir(tmp_path)
    cmd_json = json.dumps(_fast_cmd())
    proc = subprocess.run(
        [_PYTHON, "-m", "evor", "jobs", "start",
         "--run-dir", str(run_dir),
         "--cmd-json", cmd_json],
        capture_output=True, text=True, env=_evor_env(),
        timeout=10,
    )
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert "job_id" in data
