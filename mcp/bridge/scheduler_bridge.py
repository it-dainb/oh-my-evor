#!/usr/bin/env python3
"""
scheduler_bridge.py — bridge between TS MCP tool and Python ResourceScheduler.

Launches `python -m evor run` as a detached background subprocess; returns
immediately with {job_id, pid, status: "submitted"} JSON on stdout so the
MCP tool call is non-blocking (training is long-running).

Usage:
  python scheduler_bridge.py \\
    --run-id <id> --node-id <nid> --worktree <path> \\
    [--run-dir <path>] [--timeout <seconds>]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(prog="scheduler_bridge")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--worktree", required=True, type=Path)
    parser.add_argument("--run-dir", default=None, type=Path)
    parser.add_argument("--timeout", type=int, default=3600)
    args = parser.parse_args()

    job_id = str(uuid.uuid4())

    cmd = [
        sys.executable, "-m", "evor", "run",
        "--run-id", args.run_id,
        "--node-id", args.node_id,
        "--worktree", str(args.worktree.resolve()),
    ]
    if args.run_dir:
        cmd += ["--run-dir", str(args.run_dir.resolve())]

    # Inherit EVOR_ROOT and other env vars so the subprocess can locate .evor/
    env = os.environ.copy()

    try:
        proc = subprocess.Popen(
            cmd,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,  # detach from parent's process group
        )
        print(json.dumps({
            "job_id": job_id,
            "pid": proc.pid,
            "status": "submitted",
            "run_id": args.run_id,
            "node_id": args.node_id,
        }))
        return 0
    except Exception as exc:
        print(json.dumps({
            "job_id": job_id,
            "status": "failed",
            "error": str(exc),
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
