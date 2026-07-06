#!/usr/bin/env python3
"""
store_blob_bridge.py — store a blob in the ContentAddressedStore.

Usage:
  python store_blob_bridge.py \\
    --run-dir <path> --src-path <path> \\
    [--acquisition-id <id>]

If --acquisition-id is provided, also calls register_acquired() under the
"train" namespace (enforces ADR-015 two-path rule).

Stdout: {"ok": true, "content_ref": "<sha256hex>"} or {"error": "..."}
Exit 0 on success, 1 on failure.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(prog="store_blob_bridge")
    parser.add_argument(
        "--run-dir", required=True, type=Path,
        help="Path to .evor/runs/<mission>/<run-id>/ (store root for artifacts)",
    )
    parser.add_argument(
        "--src-path", required=True, type=Path,
        help="Path to the source file to store as a content-addressed blob",
    )
    parser.add_argument(
        "--acquisition-id", default=None,
        help="If provided, register the blob under this acquisition ID (train namespace)",
    )
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    src_path = args.src_path.resolve()

    if not src_path.exists():
        print(json.dumps({"error": f"src_path does not exist: {src_path}"}))
        return 1

    from evor.store import ContentAddressedStore

    store = ContentAddressedStore(run_dir)

    try:
        content_ref = store.put(src_path)
    except Exception as exc:
        print(json.dumps({"error": f"ContentAddressedStore.put failed: {exc}"}))
        return 1

    if args.acquisition_id:
        try:
            store.register_acquired(
                acquisition_id=args.acquisition_id,
                content_hashes=[content_ref],
                namespace="train",
            )
        except Exception as exc:
            print(json.dumps({"error": f"register_acquired failed: {exc}"}))
            return 1

    print(json.dumps({"ok": True, "content_ref": content_ref}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
