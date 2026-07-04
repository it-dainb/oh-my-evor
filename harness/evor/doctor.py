"""
harness/evor/doctor.py — Environment and .evor integrity doctor (Phase 2).

Entry point: python -m evor doctor [--run-id <run_dir>]

Checks:
  env     — Python version, torch presence (reported, not required), Node.js,
              EVOR_ROOT / EVOR_PYTHON env vars
  .evor   — tree.json DICT format (repairs LIST → DICT), mission-state.json
              present, no orphan pending_node_ids vs tree.json, frozen-splits
              hash matches goal-contract locked_split_hash
Repairs:
  - Rewrites a list-format tree.json to DICT format (with --repair flag)
  - Reports without modifying by default (dry-run)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ─── Report structures ────────────────────────────────────────────────────────

@dataclass
class DoctorItem:
    category: str        # "env" | "evor"
    name: str
    status: str          # "ok" | "warn" | "error" | "repaired" | "skipped"
    detail: str
    repaired: bool = False


@dataclass
class DoctorReport:
    ok: bool
    items: list[DoctorItem] = field(default_factory=list)
    repaired: list[str] = field(default_factory=list)
    verdict: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "items": [
                {
                    "category": i.category,
                    "name": i.name,
                    "status": i.status,
                    "detail": i.detail,
                    "repaired": i.repaired,
                }
                for i in self.items
            ],
            "repaired": self.repaired,
            "verdict": self.verdict,
        }


# ─── Environment checks ───────────────────────────────────────────────────────

def _check_python(items: list[DoctorItem]) -> None:
    vi = sys.version_info
    ver = f"{vi.major}.{vi.minor}.{vi.micro}"
    if vi.major < 3 or (vi.major == 3 and vi.minor < 10):
        items.append(DoctorItem(
            category="env",
            name="python_version",
            status="error",
            detail=f"Python {ver} — requires >=3.10",
        ))
    else:
        items.append(DoctorItem(
            category="env",
            name="python_version",
            status="ok",
            detail=f"Python {ver}",
        ))


def _check_torch(items: list[DoctorItem]) -> None:
    try:
        import importlib
        torch = importlib.import_module("torch")
        ver = getattr(torch, "__version__", "unknown")
        items.append(DoctorItem(
            category="env",
            name="torch",
            status="ok",
            detail=f"torch {ver} importable",
        ))
    except ImportError:
        items.append(DoctorItem(
            category="env",
            name="torch",
            status="warn",
            detail=(
                "torch not importable — GPU training paths gated. "
                "Install with `pip install torch` or use a GPU-enabled environment."
            ),
        ))


def _check_node(items: list[DoctorItem]) -> None:
    node_bin = shutil.which("node")
    if node_bin is None:
        items.append(DoctorItem(
            category="env",
            name="node",
            status="warn",
            detail="node not found on PATH — hooks (stop.mjs, session-start.mjs) require Node.js",
        ))
        return
    try:
        result = subprocess.run(
            [node_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        ver = result.stdout.strip()
        items.append(DoctorItem(
            category="env",
            name="node",
            status="ok",
            detail=f"node {ver}",
        ))
    except Exception as exc:
        items.append(DoctorItem(
            category="env",
            name="node",
            status="warn",
            detail=f"node found at {node_bin} but version check failed: {exc}",
        ))


def _check_env_vars(items: list[DoctorItem]) -> None:
    for var, desc in (
        ("EVOR_ROOT", "root .evor/ directory override"),
        ("EVOR_PYTHON", "Python interpreter for hooks (optional)"),
    ):
        val = os.environ.get(var)
        if val:
            items.append(DoctorItem(
                category="env",
                name=f"env_{var.lower()}",
                status="ok",
                detail=f"{var}={val!r}",
            ))
        else:
            items.append(DoctorItem(
                category="env",
                name=f"env_{var.lower()}",
                status="ok" if var == "EVOR_PYTHON" else "warn",
                detail=f"{var} not set — {desc}; will use default",
            ))


def _check_patch_tool(items: list[DoctorItem]) -> None:
    patch_bin = shutil.which("patch")
    if patch_bin is None:
        items.append(DoctorItem(
            category="env",
            name="patch",
            status="warn",
            detail="GNU patch not found — parent.patch application may fail",
        ))
    else:
        items.append(DoctorItem(
            category="env",
            name="patch",
            status="ok",
            detail=f"patch found at {patch_bin}",
        ))


# ─── .evor integrity checks ───────────────────────────────────────────────────

def _check_tree_format(
    run_dir: Path,
    items: list[DoctorItem],
    repair: bool,
    repaired: list[str],
) -> None:
    tree_path = run_dir / "tree.json"
    if not tree_path.exists():
        items.append(DoctorItem(
            category="evor",
            name="tree_json",
            status="warn",
            detail=f"tree.json not found at {tree_path}",
        ))
        return

    try:
        data = json.loads(tree_path.read_text())
    except json.JSONDecodeError as exc:
        items.append(DoctorItem(
            category="evor",
            name="tree_json",
            status="error",
            detail=f"tree.json is not valid JSON: {exc}",
        ))
        return

    nodes_val = data.get("nodes")

    if isinstance(nodes_val, dict):
        items.append(DoctorItem(
            category="evor",
            name="tree_json",
            status="ok",
            detail=f"DICT format ({len(nodes_val)} nodes)",
        ))
        return

    if isinstance(nodes_val, list):
        # Repairable: convert list-of-dicts to dict keyed by node id
        if repair:
            try:
                nodes_dict = {
                    n["id"]: n
                    for n in nodes_val
                    if isinstance(n, dict) and "id" in n
                }
                data["nodes"] = nodes_dict
                data["_doctor_repaired_at"] = datetime.now(timezone.utc).isoformat()
                tree_path.write_text(json.dumps(data, indent=2))
                items.append(DoctorItem(
                    category="evor",
                    name="tree_json",
                    status="repaired",
                    detail=(
                        f"Repaired LIST→DICT format ({len(nodes_dict)} nodes). "
                        f"Original had {len(nodes_val)} entries."
                    ),
                    repaired=True,
                ))
                repaired.append("tree_json: LIST→DICT conversion")
            except Exception as exc:
                items.append(DoctorItem(
                    category="evor",
                    name="tree_json",
                    status="error",
                    detail=f"LIST format found but repair failed: {exc}",
                ))
        else:
            items.append(DoctorItem(
                category="evor",
                name="tree_json",
                status="error",
                detail=(
                    f"tree.json uses legacy LIST format ({len(nodes_val)} nodes). "
                    "Re-run with --repair to convert to DICT format."
                ),
            ))
        return

    items.append(DoctorItem(
        category="evor",
        name="tree_json",
        status="error",
        detail=f"tree.json.nodes is {type(nodes_val).__name__!r}, expected dict",
    ))


def _check_mission_state(run_dir: Path, items: list[DoctorItem]) -> None:
    ms_path = run_dir / "mission-state.json"
    if not ms_path.exists():
        items.append(DoctorItem(
            category="evor",
            name="mission_state",
            status="warn",
            detail=(
                "mission-state.json not found — run has not completed Phase-2 setup. "
                "Re-run /evor-setup to initialize the locked mission state."
            ),
        ))
        return

    try:
        data = json.loads(ms_path.read_text())
    except json.JSONDecodeError as exc:
        items.append(DoctorItem(
            category="evor",
            name="mission_state",
            status="error",
            detail=f"mission-state.json is not valid JSON: {exc}",
        ))
        return

    status = data.get("status", "(missing)")
    items.append(DoctorItem(
        category="evor",
        name="mission_state",
        status="ok" if status == "locked" else "warn",
        detail=f"mission-state.json present (status={status!r})",
    ))


def _check_orphan_pending(run_dir: Path, items: list[DoctorItem]) -> None:
    """Check that every pending_node_id in run-state.json exists in tree.json."""
    rs_path = run_dir / "run-state.json"
    tree_path = run_dir / "tree.json"

    if not rs_path.exists() or not tree_path.exists():
        return  # can't check without both files

    try:
        rs = json.loads(rs_path.read_text())
        tree = json.loads(tree_path.read_text())
    except Exception:
        return

    pending = rs.get("pending_node_ids") or []
    nodes = tree.get("nodes", {})

    if isinstance(nodes, list):
        node_ids = {n.get("id") for n in nodes if isinstance(n, dict)}
    else:
        node_ids = set(nodes.keys())

    orphans = [pid for pid in pending if pid not in node_ids]

    if orphans:
        items.append(DoctorItem(
            category="evor",
            name="orphan_pending_nodes",
            status="error",
            detail=(
                f"pending_node_ids in run-state.json reference node IDs not in tree.json: "
                f"{orphans}. Call evor_record_node for each or clear pending_node_ids."
            ),
        ))
    else:
        items.append(DoctorItem(
            category="evor",
            name="orphan_pending_nodes",
            status="ok",
            detail=f"no orphan pending_node_ids ({len(pending)} checked)",
        ))


def _check_frozen_split_hash(run_dir: Path, items: list[DoctorItem]) -> None:
    """Check that frozen-splits test hash matches goal-contract.locked_split_hash."""
    gc_path = run_dir / "goal-contract.json"
    frozen_dir = run_dir / "frozen-splits"

    if not gc_path.exists() or not frozen_dir.exists():
        return

    try:
        gc_data = json.loads(gc_path.read_text())
        locked_hash = gc_data.get("locked_split_hash")
    except Exception:
        return

    if not locked_hash:
        items.append(DoctorItem(
            category="evor",
            name="frozen_split_hash_match",
            status="warn",
            detail="goal-contract.locked_split_hash is empty — cannot verify frozen split integrity",
        ))
        return

    # Find any *-test.json
    test_jsons = sorted(frozen_dir.glob("*-test.json"))
    if not test_jsons:
        items.append(DoctorItem(
            category="evor",
            name="frozen_split_hash_match",
            status="warn",
            detail="No *-test.json found in frozen-splits/ — cannot verify hash",
        ))
        return

    mismatch: list[str] = []
    for tf in test_jsons:
        try:
            split_data = json.loads(tf.read_text())
            actual_hash = split_data.get("split_hash", "")
            # Some runs store only the first part of the hash as locked_split_hash
            if not (actual_hash == locked_hash or actual_hash.startswith(locked_hash)
                    or locked_hash.startswith(actual_hash)):
                mismatch.append(
                    f"{tf.name}: split_hash={actual_hash!r} "
                    f"vs locked={locked_hash!r}"
                )
        except Exception as exc:
            mismatch.append(f"{tf.name}: unreadable ({exc})")

    if mismatch:
        items.append(DoctorItem(
            category="evor",
            name="frozen_split_hash_match",
            status="error",
            detail=f"Hash mismatch(es): {'; '.join(mismatch)}",
        ))
    else:
        items.append(DoctorItem(
            category="evor",
            name="frozen_split_hash_match",
            status="ok",
            detail="frozen-splits hash matches goal-contract.locked_split_hash",
        ))


# ─── Main doctor function ─────────────────────────────────────────────────────

def run_doctor(
    run_dir: Path | None = None,
    repair: bool = False,
) -> DoctorReport:
    """Run all doctor checks and optionally repair obvious issues.

    Args:
        run_dir: Path to an active run directory, or None for env-only checks.
        repair:  If True, rewrite a list-format tree.json to DICT format.

    Returns:
        DoctorReport with ok=True iff no error-level items remain.
    """
    items: list[DoctorItem] = []
    repaired: list[str] = []

    # ── Environment checks (always run) ──────────────────────────────────────
    _check_python(items)
    _check_torch(items)
    _check_node(items)
    _check_env_vars(items)
    _check_patch_tool(items)

    # ── .evor integrity checks (only when run_dir provided) ──────────────────
    if run_dir is not None:
        run_dir = Path(run_dir)
        if not run_dir.exists():
            items.append(DoctorItem(
                category="evor",
                name="run_dir",
                status="error",
                detail=f"Run directory does not exist: {run_dir}",
            ))
        else:
            items.append(DoctorItem(
                category="evor",
                name="run_dir",
                status="ok",
                detail=str(run_dir),
            ))
            _check_tree_format(run_dir, items, repair, repaired)
            _check_mission_state(run_dir, items)
            _check_orphan_pending(run_dir, items)
            _check_frozen_split_hash(run_dir, items)

    errors = [i for i in items if i.status == "error"]
    ok = len(errors) == 0

    if repaired:
        verdict = f"REPAIRED — {len(repaired)} issue(s) fixed: {repaired}"
        if errors:
            verdict += f"; {len(errors)} error(s) remain"
    elif ok:
        verdict = "OK — no errors detected"
    else:
        names = [i.name for i in errors]
        verdict = f"ERRORS — {len(errors)} issue(s): {names}"

    return DoctorReport(ok=ok, items=items, repaired=repaired, verdict=verdict)
