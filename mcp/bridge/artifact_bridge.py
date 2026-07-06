#!/usr/bin/env python3
"""
artifact_bridge.py — bridge between the TS MCP tool and evor.artifacts.

Usage:
  python artifact_bridge.py \\
    --run-dir <path> --tick <n> --agent <name> --payload-file <path>
    [--kind <slug>] [--partial]

Reads the payload from --payload-file (written by the TS caller to avoid
command-line length limits), validates it via evor.artifacts, and writes the
artifact atomically.

Stdout: {"ok": true, "path": "..."} or {"error": "..."}
Exit 0 on success, 1 on failure.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(prog="artifact_bridge")
    parser.add_argument("--run-dir", required=True, type=Path,
                        help="Path to .evor/runs/<mission>/<run-id>/")
    parser.add_argument("--tick", required=True, type=int,
                        help="Current tick number")
    parser.add_argument("--agent", required=True,
                        help="Agent kind (mutagen|selector|probe|sage|…)")
    parser.add_argument("--payload-file", required=True, type=Path,
                        help="Path to a JSON file containing the artifact payload")
    parser.add_argument("--kind", default=None,
                        help="Kind slug (required for sage-junior and acquirer)")
    parser.add_argument("--partial", action="store_true",
                        help="Write as <name>-partial.json (in-progress artifact)")
    args = parser.parse_args()

    # Load payload from the temp file written by the TS caller.
    try:
        payload = json.loads(args.payload_file.read_text())
    except Exception as exc:
        print(json.dumps({"error": f"could not read payload file: {exc}"}))
        return 1

    from evor.artifacts import write_artifact

    result = write_artifact(
        run_dir=args.run_dir.resolve(),
        tick=args.tick,
        agent=args.agent,
        payload=payload,
        kind=args.kind,
        partial=args.partial,
    )

    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
