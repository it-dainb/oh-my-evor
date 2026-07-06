"""
evor init-run — construct, validate, and atomically write all 7 mission run artifacts.

Replaces the fragile hand-authored GoalContract heredoc in evor-setup.

Usage (via __main__ dispatch):
    python -m evor init-run --answers <answers.json> [--run-dir <dir>]
        [--run-id <id>] [--mission-id <id>] [--evor-root <dir>]

Writes (atomically, temp + os.replace):
    <run_dir>/goal-contract.json
    <run_dir>/run-state.json
    <run_dir>/strategy.json
    <run_dir>/tree.json
    <run_dir>/mission-state.json
    <run_dir>/decision-log.md
    <evor_root>/active-run.json

On ValidationError: prints {"error": "<msg>"} to stdout and exits 1.
On success:        prints {"ok": true, ...} to stdout and exits 0.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from evor.contracts import AutonomyCharter, GoalContract


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────


def _now_iso() -> str:
    """UTC ISO-8601 timestamp with second precision."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _now_compact() -> str:
    """UTC compact timestamp used in auto-generated run_id."""
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _atomic_write_json(path: Path, data: object) -> None:
    """Serialise *data* as JSON and write atomically via tmp + os.replace()."""
    payload = json.dumps(data, indent=2).encode()
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(payload)
    os.replace(tmp, path)


def _atomic_write_text(path: Path, text: str) -> None:
    """Write *text* atomically via tmp + os.replace()."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(text.encode())
    os.replace(tmp, path)


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────────────────


def run_init_run(
    answers_path: str,
    *,
    run_dir_arg: str | None = None,
    run_id_arg: str | None = None,
    mission_id_arg: str | None = None,
    evor_root_arg: str | None = None,
) -> int:
    """Load answers.json, validate GoalContract, write 7 artifacts atomically.

    Returns exit code: 0 on success, 1 on validation or I/O failure.
    Always prints a JSON object to stdout:
      - success: {"ok": true, "mission_id":..., "run_id":..., "run_dir":..., "goal_contract_path":...}
      - failure: {"error": "<message>"}
    """
    # ── Load answers file ─────────────────────────────────────────────────────
    try:
        with open(answers_path) as fh:
            answers: dict = json.load(fh)
    except Exception as exc:
        print(json.dumps({"error": f"could not read answers file: {exc}"}))
        return 1

    # ── Auto-set created_at if absent ─────────────────────────────────────────
    if "created_at" not in answers:
        answers["created_at"] = _now_iso()

    # ── Default autonomy_charter when absent or null ───────────────────────────
    if not answers.get("autonomy_charter"):
        answers["autonomy_charter"] = AutonomyCharter(
            posture="aggressive-never-halt",
            license_gate=False,
            data_acquisition_enabled=True,
        ).model_dump()

    # ── Resolve mission_id (arg > answers.mission_id) ─────────────────────────
    mission_id: str = mission_id_arg or answers.get("mission_id", "")
    if not mission_id:
        print(json.dumps({"error": "mission_id is required (supply in answers or via --mission-id)"}))
        return 1
    answers["mission_id"] = mission_id  # keep in sync for GoalContract

    # ── Validate GoalContract — ALL validation before ANY disk write ──────────
    try:
        contract = GoalContract.model_validate(answers)
    except ValidationError as exc:
        print(json.dumps({"error": str(exc)}))
        return 1
    except Exception as exc:
        print(json.dumps({"error": f"unexpected error constructing GoalContract: {exc}"}))
        return 1

    # ── Resolve run_id (arg > auto-generated) ────────────────────────────────
    run_id: str = run_id_arg or f"{mission_id}-{_now_compact()}"

    # ── Resolve evor_root (arg > EVOR_ROOT env > .evor) ──────────────────────
    evor_root: Path = Path(
        evor_root_arg
        or os.environ.get("EVOR_ROOT", "")
        or ".evor"
    ).resolve()

    # ── Resolve run_dir (arg > <evor_root>/runs/<mission_id>/<run_id>) ────────
    run_dir: Path = (
        Path(run_dir_arg).resolve()
        if run_dir_arg
        else evor_root / "runs" / mission_id / run_id
    )

    run_dir.mkdir(parents=True, exist_ok=True)

    now = _now_iso()

    # ── 1. goal-contract.json ─────────────────────────────────────────────────
    _atomic_write_json(run_dir / "goal-contract.json", contract.model_dump())

    # ── 2. run-state.json ─────────────────────────────────────────────────────
    _atomic_write_json(run_dir / "run-state.json", {
        "status": "initialized",
        "tick_count": 0,
        "best_score": None,
        "frontier_ids": [],
        "current_eval_version": contract.eval_version,
        "hypotheses": [],
        "pending_node_ids": [],
    })

    # ── 3. strategy.json ──────────────────────────────────────────────────────
    _atomic_write_json(run_dir / "strategy.json", {
        "meta_iteration": 0,
        "selection_policy": "ucb1",
        "ucb1_c": 1.41,
        "wildness": contract.wildness,
        "family_mix": {
            "arch": 0.2,
            "training": 0.2,
            "data-curation": 0.15,
            "data-augmentation": 0.15,
            "data-acquisition": 0.1,
            "algo": 0.15,
            "other": 0.05,
        },
        "winning_families": [],
        "wins_by_family": {},
        "meta_loop_interval": 5,
        "post_upgrade_exploration_boost": None,
        "post_upgrade_exploration_ticks": 0,
        "rescore_mode": "sync",
        "updated_at": now,
    })

    # ── 4. tree.json ──────────────────────────────────────────────────────────
    _atomic_write_json(run_dir / "tree.json", {
        "nodes": {},
        "updated_at": now,
    })

    # ── 5. mission-state.json ─────────────────────────────────────────────────
    _atomic_write_json(run_dir / "mission-state.json", {
        "status": "draft",
        "objective": contract.task_description,
        "current_tick": 0,
        "max_ticks": contract.budget.max_iterations,
        "best_score": None,
        "best_node_id": None,
        "started_at": None,
        "updated_at": now,
    })

    # ── 6. decision-log.md ────────────────────────────────────────────────────
    _atomic_write_text(run_dir / "decision-log.md", (
        f"# Decision Log\n\n"
        f"- **setup_at**: {now}\n"
        f"- **mission_id**: {mission_id}\n"
        f"- **run_id**: {run_id}\n"
        f"- **objective**: {contract.task_description}\n"
    ))

    # ── 7. active-run.json  (evor_root, NOT run_dir) ──────────────────────────
    evor_root.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(evor_root / "active-run.json", {
        "mission_id": mission_id,
        "run_id": run_id,
        "run_dir": str(run_dir),
    })

    print(json.dumps({
        "ok": True,
        "mission_id": mission_id,
        "run_id": run_id,
        "run_dir": str(run_dir),
        "goal_contract_path": str(run_dir / "goal-contract.json"),
    }))
    return 0
