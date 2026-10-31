"""CLI entry point: ``python -m evor.dashboard``.

Examples::

    # Serve the entire .evor/ root (discovers all runs):
    python -m evor.dashboard --run-dir .evor --port 8756

    # Serve a specific run (evor_root is inferred 3 levels up):
    python -m evor.dashboard --run-dir .evor/runs/cifar10-2026-07/run-20260703T142300

    # Via environment variable:
    EVOR_ROOT=.evor python -m evor.dashboard

    # Write a self-contained static snapshot of one run (no server):
    python -m evor.dashboard --run-dir .evor/runs/<mission>/<run-id> --export snapshot.html
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
    parser.add_argument(
        "--no-steer",
        action="store_true",
        help="Disable the steer box (the only endpoint that writes: one line to signals-inbox.jsonl)",
    )
    parser.add_argument(
        "--steer-token",
        default=os.environ.get("EVOR_DASHBOARD_STEER_TOKEN"),
        metavar="TOKEN",
        help="Token required to post steer notes (default: random, printed once at startup). "
        "Also read from EVOR_DASHBOARD_STEER_TOKEN.",
    )
    parser.add_argument(
        "--export",
        metavar="OUT.html",
        help="Write a self-contained static HTML snapshot of the run and exit (requires a specific run dir)",
    )
    args = parser.parse_args()

    run_path = Path(args.run_dir).resolve()
    is_run = (run_path / "tree.json").exists()

    if args.export:
        if not is_run:
            parser.error("--export needs a specific run directory (one containing tree.json)")
        from evor.dashboard.export import export_snapshot

        out = export_snapshot(run_path, Path(args.export), evor_root=run_path.parent.parent.parent)
        print(f"[evor] Snapshot written to {out} ({out.stat().st_size / 1024:.0f} KB)")
        return

    from evor.dashboard.server import serve

    evor_root = _resolve_evor_root(args.run_dir)
    serve(
        evor_root=evor_root,
        host=args.host,
        port=args.port,
        open_browser=not args.no_browser,
        default_run_dir=run_path if is_run else None,
        allow_steer=not args.no_steer,
        steer_token=args.steer_token,
    )


if __name__ == "__main__":
    main()
