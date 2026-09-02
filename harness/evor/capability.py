"""
Hardware capability prober — runs at preflight time (M6 gotcha layer).

probe_capability():
  - Detects GPU arch (sm_80, sm_90, etc.), name, VRAM, supported dtypes,
    available acceleration libs, and CUDA version.
  - On CPU-only boxes (no torch or no CUDA), records cpu_only=True gracefully.
  - Writes the result to .evor/capability.json (global; readable by all agents).
  - Seeds global hardware-constraint gotchas for known capability mismatches
    (e.g. flash-attn v3 requires sm_90; bf16 requires sm_80+).

read_capability(evor_root):
  - Loads the CapabilityProfile from .evor/capability.json.
  - Returns None when the file is absent (probe not yet run).

All GPU code is gated: if torch is absent or CUDA is unavailable, the prober
returns a cpu_only CapabilityProfile without raising.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from evor.contracts import CapabilityProfile, GotchaEntry
from evor.gotchas import GotchaStore, make_gotcha

_CAPABILITY_FILE = "capability.json"

# Minimum CUDA compute capability (major, minor) for dtype support
_BF16_MIN_ARCH = (8, 0)   # sm_80 (Ampere)
_FP8_MIN_ARCH  = (8, 9)   # sm_89 (Ada Lovelace)
_FA3_MIN_ARCH  = (9, 0)   # sm_90 (Hopper) — flash-attn v3

# Known capability-constraint signatures seeded from the profile
_CONSTRAINT_SEEDS: list[dict] = [
    {
        "requires_arch_min": _FA3_MIN_ARCH,
        "signature": "flash-attn-v3-requires-sm90",
        "avoidance": (
            "flash-attn v3 (FA3) requires CUDA sm_90 (Hopper). "
            "On this hardware use flash-attn v2 or xformers memory-efficient attention instead."
        ),
    },
    {
        "requires_arch_min": _BF16_MIN_ARCH,
        "signature": "bf16-requires-sm80",
        "avoidance": (
            "bf16 requires CUDA sm_80 (Ampere) or newer. "
            "On this hardware use fp16 or fp32 instead."
        ),
    },
    {
        "requires_arch_min": _FP8_MIN_ARCH,
        "signature": "fp8-requires-sm89",
        "avoidance": (
            "fp8 training requires CUDA sm_89 (Ada Lovelace) or newer. "
            "On this hardware use bf16 or fp16 instead."
        ),
    },
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_arch(major: int, minor: int) -> str:
    """Format (major, minor) as 'sm_XY'."""
    return f"sm_{major}{minor}"


def _probe_torch_gpu() -> tuple[
    Optional[str],   # gpu_arch
    Optional[str],   # gpu_name
    Optional[float], # vram_gb (TOTAL)
    list[str],       # supported_dtypes
    list[str],       # available_libs (exercised — R-09)
    Optional[str],   # cuda_version
    bool,            # cpu_only
    Optional[float], # free_vram_gb (measured — R-04)
    list[str],       # importable_libs (raw import result — R-09)
]:
    """Probe GPU capabilities via torch. Returns (gpu_arch, gpu_name, vram_gb,
    supported_dtypes, available_libs, cuda_version, cpu_only).

    Returns cpu_only=True with None GPU fields when torch is absent or no
    CUDA device is available. Never raises.
    """
    try:
        import torch  # type: ignore[import]
    except ImportError:
        return None, None, None, ["fp32"], [], None, True, None, []

    if not torch.cuda.is_available():
        return None, None, None, ["fp32"], [], None, True, None, []

    try:
        dev = torch.cuda.current_device()
        props = torch.cuda.get_device_properties(dev)
        major, minor = props.major, props.minor
        arch = _parse_arch(major, minor)
        name = props.name
        vram_gb = round(props.total_memory / (1024 ** 3), 2)

        # ── R-04: ASK the driver what is free ────────────────────────────────
        #
        # `props.total_memory` is the card's capacity, not what this process can
        # have. On a shared-tenant A100 the artifact said 79.25 GB while ~40 GB
        # was free; agents learned to distrust it, and the next one that does not
        # will oversize a candidate. Free memory cannot be derived from total —
        # it has to be measured, which is what `mem_get_info` is for.
        free_vram_gb: Optional[float] = None
        try:
            free_bytes, _total_bytes = torch.cuda.mem_get_info()
            free_vram_gb = round(free_bytes / (1024 ** 3), 2)
        except Exception:
            free_vram_gb = None   # older torch or a driver that will not say

        # cuda version
        cuda_ver: Optional[str] = None
        try:
            cuda_ver = torch.version.cuda  # type: ignore[attr-defined]
        except Exception:
            pass

        # supported dtypes
        dtypes = ["fp32"]
        if (major, minor) >= (5, 3):
            dtypes.append("fp16")
        if (major, minor) >= _BF16_MIN_ARCH:
            dtypes.append("bf16")
        if (major, minor) >= _FP8_MIN_ARCH:
            dtypes.append("fp8")

        # ── R-09: importable is not available ────────────────────────────────
        #
        # This list advertised flash-attn, xformers and triton on the strength of
        # a bare `__import__`, while the goal contract FORBADE all three and the
        # verification artifact recorded "no flash_attn" as a PASS. Three
        # different questions were being answered by one: can it be imported, is
        # it permitted here, does it actually work on this device?
        #
        # `importable_libs` keeps the raw answer, labelled as what it is.
        # `available_libs` means usable, and a bare import is not evidence of
        # that — so it stays empty until something exercises the library.
        importable: list[str] = []
        for lib_name, import_name in [
            ("flash-attn", "flash_attn"),
            ("xformers",   "xformers"),
            ("apex",       "apex"),
            ("triton",     "triton"),
        ]:
            try:
                __import__(import_name)
                importable.append(lib_name)
            except Exception:
                # Deliberately broad. `except ImportError` was too narrow and it
                # took the WHOLE probe down: a library that raises on import for
                # its own reasons — a version mismatch, a missing CUDA symbol —
                # escaped the handler, hit the outer catch, and the run was
                # reported cpu_only with no VRAM at all. A library that explodes
                # when imported is not importable, which is precisely the answer
                # this loop exists to collect.
                pass

        # Exercised, not merely imported. Nothing is claimed available until a
        # probe actually runs it — which is the difference R-09 is about.
        libs: list[str] = []

        return arch, name, vram_gb, dtypes, libs, cuda_ver, False, free_vram_gb, importable

    except Exception:
        # GPU present but probe failed — report as cpu_only
        return None, None, None, ["fp32"], [], None, True, None, []


def probe_capability(
    evor_root: Path,
    mission_run_dir: Optional[Path] = None,
) -> CapabilityProfile:
    """Probe hardware capabilities and persist the result.

    Writes:
      - ``.evor/capability.json``   — CapabilityProfile (always, global)
      - Global hardware-constraint gotchas for known missing features based
        on the detected arch (e.g. if arch < sm_90, seeds flash-attn-v3 constraint).

    Parameters
    ----------
    evor_root:
        The ``.evor/`` root directory.
    mission_run_dir:
        Optional; passed to GotchaStore for mission-scoped writes (unused for
        hardware constraints which are always global).

    Returns
    -------
    CapabilityProfile
        The probed profile (also written to disk).
    """
    (arch, name, vram_gb, dtypes, libs, cuda_ver, cpu_only,
     free_vram_gb, importable_libs) = _probe_torch_gpu()

    profile = CapabilityProfile(
        gpu_arch=arch,
        gpu_name=name,
        vram_gb=vram_gb,
        supported_dtypes=dtypes,
        available_libs=libs,
        cuda_version=cuda_ver,
        cpu_only=cpu_only,
        free_vram_gb=free_vram_gb,
        importable_libs=importable_libs,
        # R-05: this profile was MEASURED. A hand-authored capability.json sat in
        # the plugin root and was read by two agents as "the capability profile",
        # one treating it as a measurement and one as a policy ceiling. Saying
        # which it is costs one field and removes the ambiguity that produced
        # both readings.
        source="probe",
        probed_at=_now_iso(),
    )

    # Write capability.json
    cap_path = Path(evor_root) / _CAPABILITY_FILE
    cap_path.parent.mkdir(parents=True, exist_ok=True)
    cap_path.write_text(profile.model_dump_json(indent=2))

    # Seed hardware-constraint gotchas
    _seed_constraint_gotchas(profile, evor_root, mission_run_dir)

    return profile


def _arch_tuple(arch_str: Optional[str]) -> tuple[int, int]:
    """Parse 'sm_80' -> (8, 0). Returns (0, 0) when arch is None."""
    if arch_str is None:
        return (0, 0)
    stripped = arch_str.replace("sm_", "")
    if len(stripped) >= 2:
        try:
            major = int(stripped[0])
            minor = int(stripped[1:])
            return (major, minor)
        except (ValueError, IndexError):
            pass
    return (0, 0)


def _seed_constraint_gotchas(
    profile: CapabilityProfile,
    evor_root: Path,
    mission_run_dir: Optional[Path],
) -> None:
    """For each known arch-gated feature, seed a hardware-constraint gotcha
    when the current hardware does NOT meet the minimum requirement."""
    arch_tuple = _arch_tuple(profile.gpu_arch)
    store = GotchaStore(evor_root, mission_run_dir)
    context: dict = {
        "gpu_arch": profile.gpu_arch,
        "gpu_name": profile.gpu_name,
        "vram_gb": profile.vram_gb,
        "cpu_only": profile.cpu_only,
    }

    for seed in _CONSTRAINT_SEEDS:
        min_arch: tuple[int, int] = seed["requires_arch_min"]
        if arch_tuple < min_arch:
            entry = make_gotcha(
                kind="hardware-constraint",
                signature=seed["signature"],
                context={
                    **context,
                    "requires_arch": _parse_arch(*min_arch),
                    "detected_arch": profile.gpu_arch,
                },
                resolution="Use an alternative technique compatible with detected arch.",
                avoidance=seed["avoidance"],
                scope="global",
                confidence=1.0,  # hardware facts are certain
            )
            store.add_gotcha(entry)

    # Seed cpu_only constraint when no GPU detected
    if profile.cpu_only:
        entry = make_gotcha(
            kind="hardware-constraint",
            signature="no-gpu-cpu-only",
            context=context,
            resolution="Skip GPU-specific ops; use CPU-compatible equivalents.",
            avoidance=(
                "No CUDA GPU detected on this machine. Do not propose GPU-only "
                "techniques (flash-attn, bf16 autocast, multi-GPU DDP). "
                "All training must run on CPU."
            ),
            scope="global",
            confidence=1.0,
        )
        store.add_gotcha(entry)


class MalformedCapabilityProfile(ValueError):
    """A capability.json exists but is not a CapabilityProfile (R-05)."""


def read_capability(evor_root: Path) -> Optional[CapabilityProfile]:
    """Load the CapabilityProfile from ``.evor/capability.json``.

    Returns ``None`` only when the file is ABSENT — the probe has not run.
    Raises :class:`MalformedCapabilityProfile` when a file exists but does not
    conform.

    R-05. Both cases used to return ``None``, so a hand-authored file read
    exactly like an absent one. Two conflicting ``capability.json`` files
    existed; the plugin-side one was hand-written, schema-nonconformant, and
    bypassed the prober entirely — and two agents reading "the capability
    profile" got contradictory answers depending on which root they resolved.
    Neither could tell, because the failure mode of the malformed one was
    silence.

    Pinning a profile to steer proposals is legitimate. It just has to SAY so —
    ``source: "policy-pin"`` — rather than impersonating a measurement of this
    machine.
    """
    cap_path = Path(evor_root) / _CAPABILITY_FILE
    if not cap_path.exists():
        return None
    try:
        return CapabilityProfile.model_validate_json(cap_path.read_text())
    except Exception as exc:
        raise MalformedCapabilityProfile(
            f"the capability profile at {cap_path} exists but does not conform to "
            f"CapabilityProfile: {exc}. This is not the same as 'no probe has run' — "
            f"a hand-authored profile that fails validation must be fixed or removed, "
            f"not silently ignored. If it is a deliberate pin, declare "
            f'source: "policy-pin" and supply the required fields.'
        ) from exc
