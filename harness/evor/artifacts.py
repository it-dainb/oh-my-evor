"""
Write tick artifacts atomically by agent kind.

Called from mcp/bridge/artifact_bridge.py.

Path mapping (spec §1):
  mutagen         → ticks/<tick>/mutagen/proposals.json
  selector        → ticks/<tick>/selector/verdict.json
  probe           → ticks/<tick>/probe/findings.json
  sage            → ticks/<tick>/sage/findings.json
  sage-junior     → ticks/<tick>/sage/juniors/<kind-slug>.json
  forge           → ticks/<tick>/forge/forge-report.json
  forge-architect → ticks/<tick>/forge/architect.json
  forge-critic    → ticks/<tick>/forge/critic.json
  forge-analyst   → ticks/<tick>/forge/analyst.json
  acquirer        → ticks/<tick>/acquirer/<kind-slug>.json

Validation: payload is validated against Pydantic contracts where a mapping
exists (mutagen, selector, sage, sage-junior, acquirer); unknown agents pass
through as plain JSON objects.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from .state_root import is_inside_plugin_root

# ─── Path mapping ─────────────────────────────────────────────────────────────

# Agents with a fixed (groupdir, filename-stem) pair.
_FIXED_PATHS: dict[str, tuple[str, str]] = {
    "mutagen":          ("mutagen",  "proposals"),
    "selector":         ("selector", "verdict"),
    "probe":            ("probe",    "findings"),
    "sage":             ("sage",     "findings"),
    "forge":            ("forge",    "forge-report"),
    "forge-architect":  ("forge",    "architect"),
    "forge-critic":     ("forge",    "critic"),
    "forge-analyst":    ("forge",    "analyst"),
}

# Agents whose filename stem is derived from the 'kind' argument.
_KIND_SLUG_AGENTS = frozenset({"sage-junior", "acquirer"})

VALID_AGENTS = frozenset(_FIXED_PATHS) | _KIND_SLUG_AGENTS


def _slugify(text: str) -> str:
    """Convert an arbitrary string to a filesystem-safe kebab-case slug."""
    slug = re.sub(r"[^\w\-]", "-", text.lower()).strip("-")
    return slug or "artifact"


def resolve_artifact_path(
    run_dir: Path,
    tick: int,
    agent: str,
    kind: str | None = None,
    partial: bool = False,
) -> Path:
    """Return the canonical artifact path for the given agent and tick.

    Raises ValueError for unknown agents or when kind is missing for agents
    that require it (sage-junior, acquirer).
    """
    if agent in _FIXED_PATHS:
        groupdir, stem = _FIXED_PATHS[agent]
    elif agent == "sage-junior":
        if not kind:
            raise ValueError("sage-junior requires 'kind' (used as slug in path)")
        groupdir = "sage/juniors"
        stem = _slugify(kind)
    elif agent == "acquirer":
        if not kind:
            raise ValueError("acquirer requires 'kind' (used as source slug in path)")
        groupdir = "acquirer"
        stem = _slugify(kind)
    else:
        raise ValueError(
            f"Unknown agent {agent!r}. Valid agents: {sorted(VALID_AGENTS)}"
        )

    filename = f"{stem}-partial.json" if partial else f"{stem}.json"
    return Path(run_dir) / "ticks" / str(tick) / groupdir / filename


# ─── Payload validation ───────────────────────────────────────────────────────

def _validate_payload(agent: str, payload: Any) -> str | None:
    """Validate payload against Pydantic contracts where one exists.

    Returns an error string on failure, None on success (or when no model exists).
    probe, forge, forge-architect, forge-critic, forge-analyst pass through
    because their contracts are not in contracts.py (yet).
    """
    try:
        if agent == "mutagen":
            from evor.contracts import MutationProposal
            items = payload if isinstance(payload, list) else payload.get("proposals", [])
            for item in items:
                MutationProposal.model_validate(item)

        elif agent == "selector":
            from evor.contracts import SelectorVerdict
            SelectorVerdict.model_validate(payload)

        elif agent == "sage":
            from evor.contracts import CitationBackedFinding
            items = payload if isinstance(payload, list) else payload.get("findings", [])
            for item in items:
                CitationBackedFinding.model_validate(item)

        elif agent == "sage-junior":
            from evor.contracts import CitationBackedFinding
            # sage-junior may write a single finding or a list
            items = payload if isinstance(payload, list) else [payload]
            for item in items:
                CitationBackedFinding.model_validate(item)

        elif agent == "acquirer":
            from evor.contracts import AcquisitionProvenance
            AcquisitionProvenance.model_validate(payload)

        # probe, forge*, and all other unmapped agents pass through.

    except Exception as exc:
        return str(exc)

    return None


# ─── Atomic write ─────────────────────────────────────────────────────────────

def write_artifact(
    run_dir: Path,
    tick: int,
    agent: str,
    payload: Any,
    kind: str | None = None,
    partial: bool = False,
) -> dict[str, Any]:
    """Validate and atomically write a tick artifact.

    Returns:
        {"ok": True, "path": str}     on success
        {"error": str}                on validation or I/O failure
    """
    # P-02: refuse before resolving a path, and certainly before creating a
    # directory. This reports by RETURN VALUE rather than by raising, so the
    # refusal has to hold on the filesystem too — an error envelope that still
    # wrote the file would not close the finding, which is why the test asserts
    # both.
    if is_inside_plugin_root(run_dir):
        return {
            "error": (
                f"refusing to write an artifact inside the installed plugin tree "
                f"({run_dir}). Run state belongs to the project; an artifact written "
                f"there is destroyed by the next plugin update and leaks into every "
                f"project that installs the plugin. Point EVOR_ROOT at the project."
            )
        }

    try:
        target = resolve_artifact_path(run_dir, tick, agent, kind=kind, partial=partial)
    except ValueError as exc:
        return {"error": str(exc)}

    err = _validate_payload(agent, payload)
    if err:
        return {"error": f"payload validation failed for agent={agent!r}: {err}"}

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=target.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(payload, fh, indent=2)
            os.replace(tmp_path, target)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except Exception as exc:
        return {"error": f"write failed: {exc}"}

    return {"ok": True, "path": str(target)}


# ─── Atomic read ──────────────────────────────────────────────────────────────

def read_artifact(
    run_dir: Path,
    tick: int,
    agent: str,
    kind: str | None = None,
    partial: bool = False,
) -> dict[str, Any]:
    """Read and validate a tick artifact.

    Returns:
        {"ok": True, "payload": <parsed>, "path": str}  when the file exists and is valid
        {"error": "not found"}                           when the upstream agent hasn't written it yet
        {"error": str}                                   on path-resolution or I/O failure

    "not found" is a meaningful signal — the step this agent depends on hasn't run.
    It is not a crash; callers must surface it rather than proceeding on assumptions.
    """
    try:
        target = resolve_artifact_path(run_dir, tick, agent, kind=kind, partial=partial)
    except ValueError as exc:
        return {"error": str(exc)}

    if not target.exists():
        return {"error": "not found"}

    try:
        payload = json.loads(target.read_text())
    except Exception as exc:
        return {"error": f"read failed: {exc}"}

    err = _validate_payload(agent, payload)
    if err:
        return {"error": f"payload validation failed for agent={agent!r}: {err}"}

    return {"ok": True, "payload": payload, "path": str(target)}
