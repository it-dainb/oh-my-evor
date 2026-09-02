"""
evor/jobs.py — detached-job manager for long training runs.

Public API
----------
start_job(cmd_args, run_dir) -> dict
    Spawn cmd_args detached via a supervisor; write jobs/<job_id>/status.json
    {state:"running", pid, started_at, cmd}; return {job_id, status_path, log_path}
    immediately (non-blocking, <1 s).

status(job_id, run_dir) -> dict
    Read and return jobs/<job_id>/status.json.  Returns {error:...} if absent.

Internal (invoked by supervisor only)
--------------------------------------
_supervise(job_id, run_dir, child_cmd) -> int
    Run child_cmd as a subprocess, piping stdout+stderr to log.jsonl;
    flip status.json to succeeded/failed (+ exit_code, finished_at) on exit.

CLI  python -m evor.jobs
---------------------------
  start    --run-dir <path> --cmd-json <json>   → {job_id, status_path, log_path}
  status   --job-id  <id>   --run-dir <path>    → status dict
  supervise --job-id <id>   --run-dir <path>    → (internal, runs child, writes final status)
             --cmd-json <json>
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# Path helpers
# ─────────────────────────────────────────────────────────────────────────────

def _job_dir(run_dir: Path, job_id: str) -> Path:
    return run_dir / "jobs" / job_id


def status_path(run_dir: Path, job_id: str) -> Path:
    """Canonical path for jobs/<job_id>/status.json."""
    return _job_dir(run_dir, job_id) / "status.json"


def log_path(run_dir: Path, job_id: str) -> Path:
    """Canonical path for jobs/<job_id>/log.jsonl."""
    return _job_dir(run_dir, job_id) / "log.jsonl"


def _atomic_write(path: Path, data: dict) -> None:
    """Atomically overwrite *path* with JSON (temp-file + rename)."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)


# ─────────────────────────────────────────────────────────────────────────────
# Environment helper (mirrors subprocess-bridge.ts _pythonEnv)
# ─────────────────────────────────────────────────────────────────────────────

def _child_env() -> dict[str, str]:
    """Build env with harness root prepended to PYTHONPATH."""
    harness = str(Path(__file__).resolve().parent.parent)
    existing = os.environ.get("PYTHONPATH", "")
    pypath = f"{harness}{os.pathsep}{existing}" if existing else harness
    return {**os.environ, "PYTHONPATH": pypath}  # type: ignore[return-value]


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def start_job(cmd_args: list[str], run_dir: Path) -> dict[str, str]:
    """Spawn *cmd_args* detached; return {job_id, status_path, log_path} instantly.

    Creates jobs/<job_id>/ under run_dir, writes status.json with state=running,
    then launches a supervisor process (detached, new session) that runs
    *cmd_args* as a child and flips status.json to succeeded/failed on exit.
    Never blocks waiting for the child.
    """
    job_id = str(uuid.uuid4())
    jdir = _job_dir(run_dir, job_id)
    jdir.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc).isoformat()
    initial: dict[str, Any] = {
        "state": "running",
        "job_id": job_id,
        "started_at": now,
        "cmd": cmd_args,
    }
    # Record EVOR_GPU_FRACTION in status.json so it is verifiable end-to-end
    # and visible to the run-watcher monitor.  Written by the TS bridge before
    # spawning this process; propagates naturally through _child_env() to the
    # supervisor and training child.
    gpu_fraction_str = os.environ.get("EVOR_GPU_FRACTION")
    if gpu_fraction_str is not None:
        try:
            initial["gpu_fraction"] = float(gpu_fraction_str)
        except ValueError:
            pass  # malformed value — skip silently
    _atomic_write(status_path(run_dir, job_id), initial)

    # Supervisor: python -m evor.jobs supervise --job-id X --run-dir Y --cmd-json [...]
    supervisor_cmd = [
        sys.executable, "-m", "evor.jobs",
        "supervise",
        "--job-id", job_id,
        "--run-dir", str(run_dir),
        "--cmd-json", json.dumps(cmd_args),
    ]
    proc = subprocess.Popen(
        supervisor_cmd,
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=_child_env(),
    )

    # Record supervisor PID so callers can kill it if needed
    initial["pid"] = proc.pid
    _atomic_write(status_path(run_dir, job_id), initial)

    return {
        "job_id": job_id,
        "status_path": str(status_path(run_dir, job_id)),
        "log_path": str(log_path(run_dir, job_id)),
    }


def _pid_alive(pid: int) -> bool:
    """Is this process still running? (Item 6.4.)

    Signal 0 performs the permission and existence checks without delivering
    anything. ``PermissionError`` means the process EXISTS and belongs to another
    user — alive, and not ours to judge.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        # Cannot tell. Absence of an answer is not evidence of death — the same
        # rule as 1.4, and reporting a live job dead would discard real work.
        return True
    return True


def status(job_id: str, run_dir: Path) -> dict[str, Any]:
    """Read jobs/<job_id>/status.json; return error dict if absent or unreadable."""
    sp = status_path(run_dir, job_id)
    if not sp.exists():
        return {
            "state": "unknown",
            "error": f"status.json not found: {sp}",
            "job_id": job_id,
        }
    try:
        data: dict[str, Any] = json.loads(sp.read_text())

        # ── R-11 (item 6.4): a claim of "running" must be CHECKED ────────────
        #
        # This re-read `status.json` and echoed it. When a job is killed — OOM,
        # SIGKILL, the machine going away — nothing rewrites that file, so the
        # record says `running` forever and every reader believes it. The
        # supervisor flips the status on a clean exit; being killed is precisely
        # the case where it does not get to.
        #
        # `os.kill(pid, 0)` asks the kernel, which is the only party that knows.
        # It is the same shape as 3.3's staleness rule: liveness needed an event
        # nobody emitted, so ask something that cannot fail to answer.
        if str(data.get("state", "")) == "running":
            pid = data.get("pid")
            if isinstance(pid, int) and pid > 0 and not _pid_alive(pid):
                data["state"] = "dead"
                data["error"] = (
                    f"process {pid} is not running, but status.json still said 'running'. "
                    "The job was killed without the supervisor getting to record it — "
                    "its checkpoint must not be scored."
                )
                data["detected_dead_at"] = datetime.now(timezone.utc).isoformat()

        # Append last log lines as tail when the job is still running or just finished
        lp = log_path(run_dir, job_id)
        if lp.exists():
            try:
                lines = lp.read_text(errors="replace").splitlines()
                data["tail"] = lines[-20:] if len(lines) > 20 else lines
            except Exception:
                pass
        return data
    except Exception as exc:
        return {"state": "error", "error": str(exc), "job_id": job_id}


# ─────────────────────────────────────────────────────────────────────────────
# Supervisor (internal — only called via CLI supervise subcommand)
# ─────────────────────────────────────────────────────────────────────────────

def _supervise(job_id: str, run_dir: Path, child_cmd: list[str]) -> int:
    """Run child_cmd, capture stdout+stderr to log.jsonl, flip status.json on exit.

    Called by the supervisor process spawned from start_job.  Never called
    directly by MCP tools — always via ``python -m evor.jobs supervise …``.
    """
    lp = log_path(run_dir, job_id)
    sp = status_path(run_dir, job_id)

    # Ensure the job dir exists (handles race where start_job hasn't finished)
    lp.parent.mkdir(parents=True, exist_ok=True)

    with open(lp, "ab") as log_fh:
        child = subprocess.Popen(
            child_cmd,
            stdout=log_fh,
            stderr=log_fh,
            env=_child_env(),
        )
        child.wait()

    # Read existing status to preserve started_at / cmd / pid
    current: dict[str, Any] = {}
    if sp.exists():
        try:
            current = json.loads(sp.read_text())
        except Exception:
            pass

    state = "succeeded" if child.returncode == 0 else "failed"
    final: dict[str, Any] = {
        **current,
        "state": state,
        "exit_code": child.returncode,
        "finished_at": datetime.now(timezone.utc).isoformat(),
    }
    _atomic_write(sp, final)
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# CLI  (python -m evor.jobs)
# ─────────────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m evor.jobs",
        description="evor detached-job manager",
    )
    sub = parser.add_subparsers(dest="action", required=True)

    # start
    sp = sub.add_parser("start", help="Launch a detached job")
    sp.add_argument(
        "--run-dir", required=True, type=Path,
        help="Run directory — jobs/<job_id>/ will be created inside",
    )
    sp.add_argument(
        "--cmd-json", required=True,
        help="JSON array of the full command + args to run",
    )

    # status
    st = sub.add_parser("status", help="Read jobs/<job_id>/status.json")
    st.add_argument("--job-id", required=True, help="Job identifier")
    st.add_argument(
        "--run-dir", required=True, type=Path,
        help="Run directory containing the jobs/ subtree",
    )

    # supervise (internal)
    sv = sub.add_parser(
        "supervise",
        help="[internal] Run child command, write log, flip status on exit",
    )
    sv.add_argument("--job-id", required=True)
    sv.add_argument("--run-dir", required=True, type=Path)
    sv.add_argument(
        "--cmd-json", required=True,
        help="JSON array of the full command + args to run as child",
    )

    return parser


def _main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.action == "start":
        cmd_args: list[str] = json.loads(args.cmd_json)
        run_dir = args.run_dir.resolve()
        result = start_job(cmd_args, run_dir)
        print(json.dumps(result))
        return 0

    if args.action == "status":
        run_dir = args.run_dir.resolve()
        result = status(args.job_id, run_dir)
        print(json.dumps(result))
        return 0 if result.get("state") != "error" else 1

    if args.action == "supervise":
        cmd_args = json.loads(args.cmd_json)
        run_dir = args.run_dir.resolve()
        return _supervise(args.job_id, run_dir, cmd_args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(_main())
