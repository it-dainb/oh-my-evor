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
import sys
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


def _humanize_validation_error(exc: ValidationError) -> str:
    """Turn a Pydantic ValidationError into a concise, jargon-free message.

    Drops the "N validation errors for GoalContract" header, per-error input
    dumps, and the "https://errors.pydantic.dev/…" URLs that would otherwise
    leak the internal model name and implementation into the agent surface.
    Keeps only the user-domain field path + the plain reason for each problem.
    """
    parts: list[str] = []
    for e in exc.errors():
        loc = ".".join(str(x) for x in e.get("loc", ()))
        msg = str(e.get("msg", "invalid value")).strip()
        parts.append(f"{loc} ({msg})" if loc else msg)
    detail = "; ".join(parts) if parts else "one or more values are invalid"
    return f"the mission setup has missing or invalid values: {detail}"


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────────────────


#: How old a capability profile may be before a run must re-measure.
#:
#: This window covers the profile's HARDWARE IDENTITY — arch, device name, total
#: VRAM, CUDA version — which is stable across weeks on a given machine and is
#: what dtype and architecture decisions rest on. Thirty days rejects a profile
#: describing a box from another era while not forcing a probe before every run.
#:
#: It deliberately does NOT cover `free_vram_gb`, which is a point-in-time
#: measurement that goes stale in minutes and belongs to the sizing decision at
#: the moment it is made, not to run admission. Conflating the two would mean
#: either re-probing before every run or trusting a months-old free-memory
#: figure — and trusting a stale free-memory figure is R-04 itself.
#:
#: Ninety days is the line between "this machine" and "a machine from another
#: era". The RED suite fixes both anchors: a profile probed years earlier must
#: be refused, and one from the same season must not block a run.
_PROBE_MAX_AGE_S = 90 * 24 * 3600


def _check_capability_probe(evor_root_arg: str | None) -> str | None:
    """Is there a fresh capability profile? Returns an error message, or None.

    Item 6.1 / R-08. Both failure modes read the same way to a caller that only
    checks for a file: absent, and present but stale.
    """
    from .capability import MalformedCapabilityProfile, read_capability

    root = Path(evor_root_arg) if evor_root_arg else Path(".evor")
    try:
        profile = read_capability(root)
    except MalformedCapabilityProfile as exc:
        return str(exc)

    if profile is None:
        return (
            f"no capability profile at {root / 'capability.json'}. A run sizes its "
            "candidates against the machine, so it may not start before the machine "
            "has been measured — the field run began 26 minutes before its own probe. "
            "Run the preflight probe first."
        )

    try:
        probed = datetime.fromisoformat(str(profile.probed_at).replace("Z", "+00:00"))
        if probed.tzinfo is None:
            probed = probed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return (
            f"the capability profile at {root / 'capability.json'} has an unreadable "
            f"probed_at ({profile.probed_at!r}), so its freshness cannot be established."
        )

    age = (datetime.now(timezone.utc) - probed).total_seconds()
    if age > _PROBE_MAX_AGE_S:
        return (
            f"the capability profile was probed {age / 3600:.0f}h ago "
            f"(limit {_PROBE_MAX_AGE_S / 3600:.0f}h). Hardware is shared and changes; "
            "sizing this run against a stale measurement is how a candidate is built "
            "for memory that is no longer free. Re-run the preflight probe."
        )
    return None


def _env_manifest() -> dict:
    """The interpreter and package set this run is being produced under (6.3).

    Best-effort per field: a manifest that fails to write because one probe
    raised would record nothing at all, which is worse than recording most of it.
    """
    manifest: dict = {
        "python_version": sys.version.split()[0],
        "python_executable": sys.executable,
        "platform": sys.platform,
        "recorded_at": _now_iso(),
        "packages": {},
    }
    try:
        from importlib.metadata import distributions

        manifest["packages"] = {
            d.metadata["Name"]: d.version
            for d in distributions()
            if d.metadata and d.metadata.get("Name")
        }
    except Exception:  # noqa: BLE001
        manifest["packages"] = {}

    # The versions that actually decide whether a number reproduces. Recorded
    # separately so a reader does not have to know which of 400 packages mattered.
    for name in ("torch", "numpy", "pydantic"):
        try:
            module = __import__(name)
            manifest.setdefault("key_versions", {})[name] = getattr(module, "__version__", None)
        except Exception:  # noqa: BLE001
            continue
    return manifest


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

    # ── R-08 (item 6.1): a run may not start ahead of its own measurement ────
    #
    # The field run started at 00:05 and the capability probe ran at 00:31 — the
    # sizing decisions preceded the measurement they depend on by 26 minutes, and
    # nothing objected because nothing was looking. A profile that is absent and
    # one that is years old are both "we do not know what this machine is", which
    # is not a state a run should begin in.
    probe_error = _check_capability_probe(evor_root_arg)
    if probe_error:
        print(json.dumps({"error": probe_error}))
        return 1

    # ── Validate GoalContract — ALL validation before ANY disk write ──────────
    try:
        contract = GoalContract.model_validate(answers)
    except ValidationError as exc:
        print(json.dumps({"error": _humanize_validation_error(exc)}))
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
    # Preserve any server-owned integrity anchors already written by freeze/seal
    # so that freeze→init or init→freeze ordering is non-destructive.
    gc_path = run_dir / "goal-contract.json"
    contract_data = contract.model_dump()
    if gc_path.exists():
        try:
            existing = json.loads(gc_path.read_text())
            for anchor in ("locked_split_hash", "eval_script_hash"):
                existing_val = existing.get(anchor)
                if existing_val and not contract_data.get(anchor):
                    contract_data[anchor] = existing_val
        except (json.JSONDecodeError, OSError):
            pass  # corrupt/unreadable existing file — overwrite cleanly
    _atomic_write_json(gc_path, contract_data)

    # ── 2. run-state.json ─────────────────────────────────────────────────────
    # No ``status`` (item 1.9b). AF3 §4.1: a new FSM must REPLACE a field, never
    # accompany it. ``run-state.status`` duplicated ``mission-state.status`` and
    # "was wrong in all three field runs"; the mission is now the single
    # lifecycle state, driven server-side by ``evor_run_start`` and read by the
    # three stop-hook gates. Seeding the key here would reintroduce the fifth
    # status field AF3 names as this redesign's likeliest failure mode.
    _atomic_write_json(run_dir / "run-state.json", {
        "tick_count": 0,
        "best_score": None,
        "frontier_ids": [],
        "current_eval_version": contract.eval_version,
        "hypotheses": [],
        "pending_node_ids": [],
    })

    # ── 3. strategy.json ──────────────────────────────────────────────────────
    # ── R-03 (item 6.3): record the environment this run was produced under ──
    #
    # A result is a measurement made by a specific interpreter with a specific
    # set of packages. None of that was recorded, so after the fact it is
    # unrecoverable — and "we cannot reproduce this number" is indistinguishable
    # from "this number was wrong". Written at init, because afterwards the
    # environment may already have moved.
    _atomic_write_json(run_dir / "env-manifest.json", _env_manifest())

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
