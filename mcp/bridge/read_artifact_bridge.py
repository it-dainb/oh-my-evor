#!/usr/bin/env python3
"""
read_artifact_bridge.py — bridge for reading a validated tick artifact.

Usage:
  python read_artifact_bridge.py \\
    --run-dir <path> --tick <n> --agent <name> [--kind <slug>] [--partial]

Stdout: {"ok": true, "payload": {...}, "path": "..."} or {"error": "..."}

Exit codes:
  0 — artifact found and valid, OR "not found" (expected signal — upstream step
      hasn't run yet; callers must surface this, not proceed on assumptions).
  1 — unexpected error: bad agent name, unreadable file on an existing path, etc.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(prog="read_artifact_bridge")
    parser.add_argument("--run-dir", required=True, type=Path,
                        help="Path to .evor/runs/<mission>/<run-id>/")
    parser.add_argument("--tick", required=True, type=int,
                        help="Current tick number")
    parser.add_argument("--agent", required=True,
                        help="Agent kind (mutagen|selector|probe|sage|…)")
    parser.add_argument("--kind", default=None,
                        help="Kind slug (required for sage-junior and acquirer)")
    parser.add_argument("--partial", action="store_true",
                        help="Read the -partial.json variant instead of the final artifact")
    args = parser.parse_args()

    from evor.artifacts import read_artifact

    result = read_artifact(
        run_dir=args.run_dir.resolve(),
        tick=args.tick,
        agent=args.agent,
        kind=args.kind,
        partial=args.partial,
    )

    print(json.dumps(result))
    # "not found" is an expected outcome — the upstream agent hasn't produced the
    # artifact yet.  Exit 0 so the TS callBridge sees ok:true + structured data,
    # letting the caller distinguish "not there yet" from "tool broke".
    if result.get("ok") or result.get("error") == "not found":
        return 0
    # All other errors (bad agent name, I/O failure on existing file, …) are
    # unexpected — exit 1 so callBridge surfaces them as ok:false.
    return 1


if __name__ == "__main__":
    sys.exit(main())
