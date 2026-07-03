"""CLI entry point: ``python -m evor.dashboard``.

Examples::

    # Serve the entire .evor/ root (discovers all runs):
    python -m evor.dashboard --run-dir .evor --port 8756

    # Serve a specific run (evor_root is inferred 3 levels up):
    python -m evor.dashboard --run-dir .evor/runs/cifar10-2026-07/run-20260703T142300

    # Via environment variable:
    EVOR_ROOT=.evor python -m evor.dashboard
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _resolve_evor_root(run_dir: str) -> Path:
    """
    Accept either:
    - An explicit ``.evor/`` root directory (has a ``runs/`` subdirectory)
    - A specific run directory (has ``tree.json`` at its root)

    In the second case the evor root is inferred as three levels up:
    ``<evor_root>/runs/<mission_id>/<run_id>/tree.json``.
    """
    p = Path(run_dir).resolve()
    if (p / "tree.json").exists():
        # Specific run dir: go up mission_id → runs → evor_root
        evor_root = p.parent.parent.parent
        print(
            f"[evor] Detected specific run dir — inferring evor_root as {evor_root}",
            file=sys.stderr,
        )
        return evor_root
    if (p / "runs").exists():
        return p
    # Assume it is the evor root even if runs/ doesn't exist yet
    return p


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m evor.dashboard",
        description="Evor Dashboard — live evolution mission viewer",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--run-dir",
        default=os.environ.get("EVOR_ROOT", ".evor"),
        metavar="PATH",
        help=(
            "Path to the .evor/ root directory, or a specific run directory "
            "(.evor/runs/<mission>/<run-id>). "
            "Also read from the EVOR_ROOT environment variable."
        ),
    )
    parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Interface to bind to",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8756,
        help="Port to listen on",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not open a browser window on startup",
    )
    args = parser.parse_args()

    from evor.dashboard.server import serve

    evor_root = _resolve_evor_root(args.run_dir)
    serve(
        evor_root=evor_root,
        host=args.host,
        port=args.port,
        open_browser=not args.no_browser,
    )


if __name__ == "__main__":
    main()
