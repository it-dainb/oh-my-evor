#!/usr/bin/env python3
"""
read_handoff_bridge.py — read handoffs from .evor/runs/<m>/<r>/handoffs/

Usage (within-tick agent-to-agent JSON handoff):
  python read_handoff_bridge.py \\
    --run-dir <path> --from-agent <a> --to-agent <b>

Usage (tick-N markdown handoff):
  python read_handoff_bridge.py \\
    --run-dir <path> --tick <n>

Usage (latest tick handoff):
  python read_handoff_bridge.py --run-dir <path>

Stdout (success):
  {"ok": true, "handoff": ..., "tick": N}   (tick key present for tick-md variants)
Stdout (not found):
  {"error": "not found"}
Exit 0 always — errors returned as JSON so the TS caller can branch cleanly.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(prog="read_handoff_bridge")
    parser.add_argument(
        "--run-dir", required=True, type=Path,
        help="Path to .evor/runs/<mission>/<run-id>/",
    )
    parser.add_argument(
        "--from-agent", default=None,
        help="Source agent name for within-tick handoff (requires --to-agent)",
    )
    parser.add_argument(
        "--to-agent", default=None,
        help="Destination agent name for within-tick handoff (requires --from-agent)",
    )
    parser.add_argument(
        "--tick", default=None, type=int,
        help="Tick number for tick-markdown handoff; omit for latest tick",
    )
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()

    from evor.handoff import read_handoff, read_tick_handoff, latest_tick_handoff

    # ── Route: within-tick agent pair ─────────────────────────────────────────
    if args.from_agent is not None and args.to_agent is not None:
        result = read_handoff(run_dir, args.from_agent, args.to_agent)
        if result is None:
            print(json.dumps({"error": "not found"}))
            return 0
        print(json.dumps({"ok": True, "handoff": result}))
        return 0

    # ── Route: specific tick markdown ─────────────────────────────────────────
    if args.tick is not None:
        text = read_tick_handoff(run_dir, args.tick)
        if text is None:
            print(json.dumps({"error": "not found"}))
            return 0
        print(json.dumps({"ok": True, "handoff": text, "tick": args.tick}))
        return 0

    # ── Route: latest tick handoff ────────────────────────────────────────────
    latest = latest_tick_handoff(run_dir)
    if latest is None:
        print(json.dumps({"error": "not found"}))
        return 0
    tick_n, text = latest
    print(json.dumps({"ok": True, "handoff": text, "tick": tick_n}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
