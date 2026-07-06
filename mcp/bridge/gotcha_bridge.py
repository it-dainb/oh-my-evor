#!/usr/bin/env python3
"""
gotcha_bridge.py — query or add a gotcha via GotchaStore.

Usage (query):
  python gotcha_bridge.py --action query \\
    --evor-root <path> [--run-dir <path>] \\
    [--kind runtime-failure|hardware-constraint|approach-deadend] \\
    [--scope global|mission] [--min-confidence 0.0]

Usage (add):
  python gotcha_bridge.py --action add \\
    --evor-root <path> [--run-dir <path>] \\
    --payload-file <path>

Payload JSON for add must contain: kind, signature, context, resolution, avoidance.
Optional fields: scope (default "global"), confidence (default 0.5).

Stdout (query):  {"ok": true, "gotchas": [...], "total": N}
Stdout (add):    {"ok": true, "gotcha": {...}}
Stdout (error):  {"error": "..."}
Exit 0 on success, 1 on failure.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(prog="gotcha_bridge")
    parser.add_argument(
        "--action", required=True, choices=["query", "add"],
        help="Operation to perform",
    )
    parser.add_argument(
        "--evor-root", required=True, type=Path,
        help="Path to .evor/ root directory",
    )
    parser.add_argument(
        "--run-dir", default=None, type=Path,
        help="Path to run directory for mission-scoped gotchas",
    )
    # query filters
    parser.add_argument(
        "--kind", default=None,
        choices=["runtime-failure", "hardware-constraint", "approach-deadend"],
        help="Filter by gotcha kind (query only)",
    )
    parser.add_argument(
        "--scope", default=None, choices=["global", "mission"],
        help="Filter by scope (query only)",
    )
    parser.add_argument(
        "--min-confidence", type=float, default=0.0,
        help="Minimum confidence threshold for query (default 0.0)",
    )
    # add payload
    parser.add_argument(
        "--payload-file", default=None, type=Path,
        help="JSON file containing GotchaEntry fields (add only)",
    )
    args = parser.parse_args()

    evor_root = args.evor_root.resolve()
    run_dir = args.run_dir.resolve() if args.run_dir else None

    from evor.gotchas import GotchaStore, make_gotcha

    store = GotchaStore(evor_root, mission_run_dir=run_dir)

    # ── Query ─────────────────────────────────────────────────────────────────
    if args.action == "query":
        try:
            gotchas = store.query_gotchas(
                kind=args.kind,
                scope=args.scope,
                min_confidence=args.min_confidence,
            )
            print(json.dumps({
                "ok": True,
                "gotchas": [g.model_dump() for g in gotchas],
                "total": len(gotchas),
            }))
            return 0
        except Exception as exc:
            print(json.dumps({"error": f"query_gotchas failed: {exc}"}))
            return 1

    # ── Add ───────────────────────────────────────────────────────────────────
    if args.action == "add":
        if not args.payload_file:
            print(json.dumps({"error": "--payload-file is required for --action add"}))
            return 1
        try:
            raw = args.payload_file.read_text()
            data = json.loads(raw)
        except Exception as exc:
            print(json.dumps({"error": f"could not read payload file: {exc}"}))
            return 1

        try:
            entry = make_gotcha(
                kind=data["kind"],
                signature=data["signature"],
                context=data.get("context", {}),
                resolution=data.get("resolution", ""),
                avoidance=data.get("avoidance", ""),
                scope=data.get("scope", "global"),
                confidence=data.get("confidence", 0.5),
            )
            final = store.add_gotcha(entry)
            print(json.dumps({"ok": True, "gotcha": final.model_dump()}))
            return 0
        except Exception as exc:
            print(json.dumps({"error": f"add_gotcha failed: {exc}"}))
            return 1

    print(json.dumps({"error": f"unknown action: {args.action}"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
