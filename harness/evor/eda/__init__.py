"""
ProbeEDA SDK — thin primitives for Probe-generated analysis scripts (M6).

Probe (evor-probe) WRITES AND RUNS its own Python analysis code per iteration.
This module provides only the infrastructure primitives; no fixed analyses are
hardcoded here. Probe generates modality-appropriate scripts and calls these
functions from them.

Primitives:
  load_artifact   — resolve content-hash → blob path via ContentAddressedStore
  load_telemetry  — read nodes/<node_id>/telemetry.jsonl
  save_finding    — write finding to nodes/<node_id>/eda/<name><suffix>
  safe_plot       — save matplotlib/plotly figure; catches all rendering errors
  safe_exec       — run a generated analysis script under resource limits

See harness/evor/eda/ for the ProbeEDAContract and Probe agent flow.
"""

from __future__ import annotations

import json
import resource
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

# ContentAddressedStore imported lazily to avoid circular deps
try:
    from evor.store import ContentAddressedStore as _Store
    _STORE_AVAILABLE = True
except ImportError:
    _STORE_AVAILABLE = False


# ─────────────────────────────────────────────────────────────────────────────
# Artifact access
# ─────────────────────────────────────────────────────────────────────────────

def load_artifact(content_hash: str, run_dir: Path) -> Path:
    """Resolve a content-hash to its blob path via ContentAddressedStore.

    Args:
        content_hash: sha256 hex string (as stored in TreeNode.genome_ref etc.)
        run_dir:      Run directory; ContentAddressedStore root = run_dir/../../../

    Returns:
        Path to the blob file.

    Raises:
        FileNotFoundError if the blob is not in the store.
        RuntimeError if ContentAddressedStore is unavailable.
    """
    if not _STORE_AVAILABLE:
        raise RuntimeError(
            "ContentAddressedStore (evor.store) is not available. "
            "Install the harness package or check import paths."
        )
    # Store artifacts directory lives two levels above run_dir:
    # .evor/runs/<mission>/<run-id>/ → .evor/
    evor_root = run_dir.parent.parent.parent
    artifacts_dir = evor_root / "artifacts"
    store = _Store(artifacts_dir)
    return store.get(content_hash)


# ─────────────────────────────────────────────────────────────────────────────
# Telemetry loading
# ─────────────────────────────────────────────────────────────────────────────

def load_telemetry(node_id: str, run_dir: Path) -> list[dict[str, Any]]:
    """Read nodes/<node_id>/telemetry.jsonl; return parsed records.

    Returns an empty list if the file does not exist or is empty.
    Malformed lines are skipped with a warning printed to stderr.
    """
    path = run_dir / "nodes" / node_id / "telemetry.jsonl"
    if not path.exists():
        return []

    records: list[dict[str, Any]] = []
    with open(path) as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(
                    f"[ProbeEDA] telemetry.jsonl line {lineno} skipped (JSON error): {exc}",
                    file=sys.stderr,
                )
    return records


# ─────────────────────────────────────────────────────────────────────────────
# Finding persistence
# ─────────────────────────────────────────────────────────────────────────────

def save_finding(
    node_id: str,
    run_dir: Path,
    name: str,
    data: dict[str, Any] | str | bytes,
    suffix: str = ".json",
) -> Path:
    """Write a finding artifact to nodes/<node_id>/eda/<name><suffix>.

    Args:
        node_id: Node identifier.
        run_dir: Run directory root.
        name:    Finding name (filename stem, no extension).
        data:    Content: dict → JSON, str → UTF-8 text, bytes → raw.
        suffix:  File extension including leading dot (default: .json).

    Returns:
        Absolute Path to the written file.
    """
    eda_dir = run_dir / "nodes" / node_id / "eda"
    eda_dir.mkdir(parents=True, exist_ok=True)

    dest = eda_dir / f"{name}{suffix}"

    if isinstance(data, dict):
        dest.write_text(json.dumps(data, indent=2, default=str))
    elif isinstance(data, str):
        dest.write_text(data)
    else:
        dest.write_bytes(data)

    return dest


# ─────────────────────────────────────────────────────────────────────────────
# Figure saving
# ─────────────────────────────────────────────────────────────────────────────

def safe_plot(
    fig: Any,
    node_id: str,
    run_dir: Path,
    name: str,
) -> Path:
    """Save a matplotlib or plotly figure; catch all rendering errors.

    On rendering failure, falls back to saving the figure's underlying data
    as a JSON table so the finding is never silently lost.

    Args:
        fig:     matplotlib Figure or plotly Figure object.
        node_id: Node identifier.
        run_dir: Run directory root.
        name:    Plot name (filename stem, no .png extension needed).

    Returns:
        Path to the saved file (.png on success, .json on fallback).
    """
    eda_dir = run_dir / "nodes" / node_id / "eda"
    eda_dir.mkdir(parents=True, exist_ok=True)
    png_path = eda_dir / f"{name}.png"

    try:
        # matplotlib
        if hasattr(fig, "savefig"):
            fig.savefig(str(png_path), bbox_inches="tight", dpi=150)
            return png_path

        # plotly
        if hasattr(fig, "write_image"):
            fig.write_image(str(png_path))
            return png_path

        # Attempt generic save
        if hasattr(fig, "save"):
            fig.save(str(png_path))
            return png_path

    except Exception as exc:
        print(
            f"[ProbeEDA] safe_plot: rendering {name!r} failed ({exc}); "
            "falling back to data table.",
            file=sys.stderr,
        )

    # Fallback: save figure data as JSON if available
    json_path = eda_dir / f"{name}_data.json"
    try:
        if hasattr(fig, "to_json"):
            json_path.write_text(fig.to_json())
        elif hasattr(fig, "data"):
            json_path.write_text(
                json.dumps({"data": str(fig.data)}, indent=2)
            )
        else:
            json_path.write_text(
                json.dumps({"error": "figure data unavailable", "repr": repr(fig)}, indent=2)
            )
    except Exception:
        json_path.write_text(
            json.dumps({"error": "fallback serialisation failed"}, indent=2)
        )

    return json_path


# ─────────────────────────────────────────────────────────────────────────────
# Safe script execution
# ─────────────────────────────────────────────────────────────────────────────

def safe_exec(
    script_path: Path,
    timeout_sec: int = 300,
    mem_limit_mb: int = 2048,
) -> tuple[str, str]:
    """Execute a generated analysis script under resource limits.

    Runs the script in a subprocess with:
      - Timeout: raises TimeoutError after timeout_sec seconds.
      - Memory limit: RLIMIT_AS set to mem_limit_mb MB on Linux (best-effort;
        no-op on non-Linux platforms).

    Args:
        script_path:  Path to the Python analysis script to execute.
        timeout_sec:  Wall-clock timeout in seconds (default 300).
        mem_limit_mb: RSS memory limit in MB (default 2048).

    Returns:
        (stdout, stderr) as strings.

    Raises:
        TimeoutError: if the script runs longer than timeout_sec.
        FileNotFoundError: if script_path does not exist.
    """
    if not script_path.exists():
        raise FileNotFoundError(f"Analysis script not found: {script_path}")

    # Build a small wrapper that sets RLIMIT_AS before exec'ing the script
    wrapper_src = _build_resource_wrapper(script_path, mem_limit_mb)

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, dir=script_path.parent
    ) as tmp:
        tmp.write(wrapper_src)
        wrapper_path = tmp.name

    try:
        result = subprocess.run(
            [sys.executable, wrapper_path],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            cwd=str(script_path.parent),
        )
        return result.stdout, result.stderr
    except subprocess.TimeoutExpired as exc:
        stdout = (exc.stdout or b"").decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = (exc.stderr or b"").decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        raise TimeoutError(
            f"Analysis script {script_path.name!r} timed out after {timeout_sec}s. "
            f"stdout: {stdout[:500]}\nstderr: {stderr[:500]}"
        ) from exc
    finally:
        try:
            Path(wrapper_path).unlink()
        except OSError:
            pass


def _build_resource_wrapper(script_path: Path, mem_limit_mb: int) -> str:
    """Build Python source for a resource-limited wrapper around script_path."""
    mem_bytes = mem_limit_mb * 1024 * 1024
    return f"""\
import sys, resource, runpy
# Set memory limit (Linux only; no-op elsewhere)
try:
    resource.setrlimit(resource.RLIMIT_AS, ({mem_bytes}, {mem_bytes}))
except (AttributeError, ValueError, resource.error):
    pass
# Execute the analysis script in its own namespace
sys.argv = [{str(script_path)!r}]
runpy.run_path({str(script_path)!r}, run_name="__main__")
"""
