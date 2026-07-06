#!/usr/bin/env python3
"""
inbox_bridge.py — drain a run's remember-inbox or signals-inbox.

Usage:
  python inbox_bridge.py \\
    --run-dir <path> --kind (remember|signals) [--evor-root <path>]

Delegates to evor.inbox.drain_inbox, which atomically claims and processes the
inbox file, then returns the count of successfully drained entries.

Stdout: {"ok": true, "drained": N} or {"error": "..."}
Exit 0 on success, 1 on failure.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(prog="inbox_bridge")
    parser.add_argument("--run-dir", required=True, type=Path,
                        help="Path to .evor/runs/<mission>/<run-id>/")
    parser.add_argument("--kind", required=True, choices=["remember", "signals"],
                        help="Inbox to drain: 'remember' (wiki) or 'signals' (SignalBus)")
    parser.add_argument("--evor-root", default=None, type=Path,
                        help="Override .evor/ root (used for remember drain; "
                             "inferred from run-dir layout if omitted)")
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    evor_root = args.evor_root.resolve() if args.evor_root else None

    from evor.inbox import drain_inbox

    try:
        count = drain_inbox(run_dir, kind=args.kind, evor_root=evor_root)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        return 1

    print(json.dumps({"ok": True, "drained": count}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
