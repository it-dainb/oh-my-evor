#!/usr/bin/env python3
"""
handoff_bridge.py — write a tick handoff JSON atomically.

Usage:
  python handoff_bridge.py \\
    --run-dir <path> --tick <n> --payload-file <path>

Writes handoffs/<tick>-<seq>.json where <seq> is the next available sequence
number for this tick (starts at 0; increments to avoid overwriting existing
handoffs for the same tick).

Stdout: {"ok": true, "path": "...", "seq": N} or {"error": "..."}
Exit 0 on success, 1 on failure.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import sys
from pathlib import Path


def _next_seq(handoffs_dir: Path, tick: int) -> int:
    """Return the next available sequence number for the given tick.

    Scans existing files matching `<tick>-<seq>.json` and returns max_seq + 1.
    Returns 0 when no handoffs for this tick exist yet.
    """
    pattern = re.compile(rf"^{re.escape(str(tick))}-(\d+)\.json$")
    max_seq = -1
    if handoffs_dir.exists():
        for entry in handoffs_dir.iterdir():
            m = pattern.match(entry.name)
            if m:
                max_seq = max(max_seq, int(m.group(1)))
    return max_seq + 1


def main() -> int:
    parser = argparse.ArgumentParser(prog="handoff_bridge")
    parser.add_argument("--run-dir", required=True, type=Path,
                        help="Path to .evor/runs/<mission>/<run-id>/")
    parser.add_argument("--tick", required=True, type=int,
                        help="Tick number for this handoff")
    parser.add_argument("--payload-file", required=True, type=Path,
                        help="Path to a JSON file containing the handoff payload")
    args = parser.parse_args()

    try:
        data = json.loads(args.payload_file.read_text())
    except Exception as exc:
        print(json.dumps({"error": f"could not read payload file: {exc}"}))
        return 1

    run_dir = args.run_dir.resolve()
    handoffs_dir = run_dir / "handoffs"
    handoffs_dir.mkdir(parents=True, exist_ok=True)

    seq = _next_seq(handoffs_dir, args.tick)
    target = handoffs_dir / f"{args.tick}-{seq}.json"

    try:
        fd, tmp_path = tempfile.mkstemp(dir=handoffs_dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(data, fh, indent=2)
            os.replace(tmp_path, target)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except Exception as exc:
        print(json.dumps({"error": f"write failed: {exc}"}))
        return 1

    print(json.dumps({"ok": True, "path": str(target), "seq": seq}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
