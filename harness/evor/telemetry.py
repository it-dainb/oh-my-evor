"""
Telemetry reader — JSONL parser for telemetry.jsonl files.

Candidate training code writes telemetry records via the env-path pattern
(§19-clean, no evor import required):

    import json, os
    tel_path = os.environ.get("EVOR_TELEMETRY_PATH")
    if tel_path:
        with open(tel_path, "a") as f:
            f.write(json.dumps({"step": step, "train_loss": loss, ...}) + "\\n")

Schema: TelemetryRecord from contracts.py.
  Required per record: step, node_id, run_id, timestamp.
  All metric fields optional but at least one must be present.
  grad_norm is conditional (R6): present for PyTorch; absent for tabular/XGBoost.

Output: JSONL appended to nodes/<node_id>/telemetry.jsonl.
Each line is a valid TelemetryRecord serialised to JSON.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class TelemetryCallback:
    """Read-only telemetry.jsonl reader.

    Provides path resolution and JSONL parsing for telemetry files written
    by candidate training code via EVOR_TELEMETRY_PATH + open().

    Usage:
        cb = TelemetryCallback(node_id, run_id, run_dir=run_dir)
        records = cb.read_records()   # list[dict]
    """

    def __init__(
        self,
        node_id: str,
        run_id: str,
        run_dir: Path | None = None,
    ) -> None:
        """
        Args:
            node_id:  Node identifier (used as path component).
            run_id:   Run identifier (informational; not written by this class).
            run_dir:  Root of the .evor/runs/<mission>/<run-id>/ directory.
                      If None, path resolves to './nodes/<node_id>/' relative
                      to the current working directory.
        """
        self._node_id = node_id
        self._run_id = run_id
        self._run_dir = run_dir

        if run_dir is not None:
            self._telemetry_path = run_dir / "nodes" / node_id / "telemetry.jsonl"
        else:
            self._telemetry_path = Path("nodes") / node_id / "telemetry.jsonl"

    @property
    def telemetry_path(self) -> Path:
        """Resolved path to the JSONL file."""
        return self._telemetry_path

    def read_records(self) -> list[dict[str, Any]]:
        """Read and parse all JSONL records written to telemetry.jsonl.

        Returns an empty list when the file does not exist.
        Skips lines that are not valid JSON (silent resilience).
        """
        if not self._telemetry_path.exists():
            return []
        records: list[dict[str, Any]] = []
        with open(self._telemetry_path) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        return records
