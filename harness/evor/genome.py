"""
GenomeConfig loader, validator, and merge logic (Addendum v2 Pillar 1).

validate_schema_extensions() checks structural mutations against the
genome-schema-registry.json manifest co-located in harness/evor/.

merge_genomes() combines two GenomeConfig objects across named loci:
- Parametric genes: taken from parent a or b depending on which locus is named.
- Structural extensions: intersection of both parents' schema_extensions[] —
  only extensions both agree on are carried into the child.

Raises ValueError if the merged result fails validate_schema_extensions().
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from evor.contracts import GenomeConfig

# Try PyYAML for .yaml genome files; fall back to JSON-only if absent
try:
    import yaml as _yaml  # type: ignore[import]
    _YAML_AVAILABLE = True
except ImportError:
    _YAML_AVAILABLE = False

# Default registry co-located with this module
_DEFAULT_REGISTRY = Path(__file__).parent / "genome-schema-registry.json"


# ─────────────────────────────────────────────────────────────────────────────
# Registry loading
# ─────────────────────────────────────────────────────────────────────────────


def _load_registry(registry_path: Path) -> dict[str, Any]:
    """Load genome-schema-registry.json; return {} if file is missing."""
    if not registry_path.exists():
        return {}
    with open(registry_path) as f:
        data = json.load(f)
    return data.get("schema_extensions", {})


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


def load_genome(genome_path: Path) -> GenomeConfig:
    """Load GenomeConfig from genome.yaml (or .json).

    Raises ImportError (with a clear message) when PyYAML is unavailable
    and the file is a .yaml/.yml.
    """
    suffix = genome_path.suffix.lower()
    with open(genome_path, "rb") as f:
        raw_bytes = f.read()

    if suffix in (".yaml", ".yml"):
        if not _YAML_AVAILABLE:
            raise ImportError(
                "PyYAML is required to load .yaml genome files. "
                "Install it with: pip install pyyaml"
            )
        raw: dict[str, Any] = _yaml.safe_load(raw_bytes)
    else:
        raw = json.loads(raw_bytes)

    return GenomeConfig.model_validate(raw)


def validate_schema_extensions(
    genome: GenomeConfig,
    registry_path: Path = _DEFAULT_REGISTRY,
) -> list[str]:
    """Validate structural-mutation schema extensions against the registry.

    Called on every structural-mutation path (mutation_tier='structural').
    Checks:
      - Each name in genome.schema_extensions[] is present in the registry.
      - genome.extra[name] exists and its value is within valid_range (if specified).

    Returns a list of error strings; empty list means the genome is valid.
    """
    registry = _load_registry(registry_path)
    errors: list[str] = []

    for name in genome.schema_extensions:
        if name not in registry:
            errors.append(
                f"schema_extension '{name}' not found in genome-schema-registry.json"
            )
            continue

        spec = registry[name]

        if name not in genome.extra:
            errors.append(
                f"schema_extension '{name}' declared in schema_extensions[] "
                f"but absent from genome.extra"
            )
            continue

        value = genome.extra[name]
        valid_range = spec.get("valid_range")
        if valid_range is not None and len(valid_range) == 2:
            lo, hi = valid_range
            try:
                if not (lo <= value <= hi):
                    errors.append(
                        f"schema_extension '{name}' value {value!r} is outside "
                        f"valid_range [{lo}, {hi}]"
                    )
            except TypeError:
                errors.append(
                    f"schema_extension '{name}' value {value!r} is not comparable "
                    f"to valid_range [{lo}, {hi}]"
                )

    return errors


def merge_genomes(
    a: GenomeConfig,
    b: GenomeConfig,
    loci: list[str],
    registry_path: Path = _DEFAULT_REGISTRY,
) -> GenomeConfig:
    """Merge two GenomeConfigs across the named *loci*.

    Parametric genes listed in *loci* are taken from genome *b*; all others
    come from genome *a*.  This mirrors the crossover semantics in tree.py:
    loci = the seam fields that genome b "donates" to the child.

    Structural extensions: only names present in BOTH parents' schema_extensions[]
    are included in the child (intersection).  Extra values for shared extensions
    follow the same locus rule: take from b if the extension name is in loci,
    else from a.

    Calls validate_schema_extensions() on the result; raises ValueError listing
    all validation errors if the merged genome is structurally invalid.
    """
    loci_set = set(loci)

    def _pick(field: str) -> Any:
        """Return field value from b if field is in loci, else from a."""
        return getattr(b, field) if field in loci_set else getattr(a, field)

    # Structural extensions: intersection of both parents
    ext_a = set(a.schema_extensions)
    ext_b = set(b.schema_extensions)
    shared_extensions = sorted(ext_a & ext_b)

    # Merge extra: start from a, let b override for keys in loci_set
    merged_extra: dict[str, Any] = dict(a.extra)
    for key in b.extra:
        if key in loci_set:
            merged_extra[key] = b.extra[key]
    # Restrict to only keys relevant to shared extensions (keep other extra keys too)

    merged = GenomeConfig(
        genome_version=a.genome_version,
        backbone=_pick("backbone"),
        head=_pick("head"),
        neck=_pick("neck"),
        optimizer=_pick("optimizer"),
        lr=_pick("lr"),
        lr_schedule=_pick("lr_schedule"),
        batch_size=_pick("batch_size"),
        epochs=_pick("epochs"),
        loss=_pick("loss"),
        aug_set=_pick("aug_set"),
        acquired_datasets=_pick("acquired_datasets"),
        regularization=_pick("regularization"),
        schema_extensions=shared_extensions,
        extra=merged_extra,
    )

    errors = validate_schema_extensions(merged, registry_path)
    if errors:
        raise ValueError(
            "merge_genomes produced an invalid genome:\n"
            + "\n".join(f"  - {e}" for e in errors)
        )

    return merged
