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

    from evor.handoff import read_handoff, read_tick_handoff, latest_tick_handoff, tick_json_handoffs

    # ── Route: within-tick agent pair ─────────────────────────────────────────
    if args.from_agent is not None and args.to_agent is not None:
        result = read_handoff(run_dir, args.from_agent, args.to_agent)
        if result is None:
            # No pair file: the newest entry evor_write_handoff addressed to this
            # reader carries the same routing (e.g. the tick sending Mutagen's
            # queries to Sage).
            entries = tick_json_handoffs(run_dir, to_agent=args.to_agent)
            if entries:
                print(json.dumps({"ok": True, "handoff": entries[-1], "tick": entries[-1]["_tick"]}))
                return 0
            print(json.dumps({"error": "not found"}))
            return 0
        print(json.dumps({"ok": True, "handoff": result}))
        return 0

    # ── Route: specific tick markdown ─────────────────────────────────────────
    if args.tick is not None:
        text = read_tick_handoff(run_dir, args.tick)
        entries = tick_json_handoffs(run_dir, tick=args.tick)
        if text is None and not entries:
            print(json.dumps({"error": "not found"}))
            return 0
        print(json.dumps({"ok": True, "handoff": text if text is not None else entries,
                          "tick": args.tick, "entries": entries}))
        return 0

    # ── Route: latest tick handoff ────────────────────────────────────────────
    latest = latest_tick_handoff(run_dir)
    entries = tick_json_handoffs(run_dir)
    if latest is None and not entries:
        print(json.dumps({"error": "not found"}))
        return 0
    if latest is None:
        print(json.dumps({"ok": True, "handoff": entries, "tick": entries[-1]["_tick"], "entries": entries}))
        return 0
    tick_n, text = latest
    print(json.dumps({"ok": True, "handoff": text, "tick": tick_n,
                      "entries": tick_json_handoffs(run_dir, tick=tick_n)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
