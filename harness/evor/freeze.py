"""
FrozenSplitManager — Pillar 2 dataset split freeze + integrity enforcement.
DataProvenanceTracker — per-augmented-sample provenance + near-dup detection.

Layers implemented here:
  Layer 1: chmod 444 on all frozen split files (check_read_only)
  Layer 2: split_hash recomputation (verify_frozen_split)
  Layer 3: near-duplicate augmentation-of-test check (DataProvenanceTracker.check_near_dup)
  Layer 4: data provenance — augmented samples trace to train, not test (DataProvenanceTracker.record)
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from evor.contracts import DataProvenance, FrozenSplit


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _make_readonly(path: Path) -> None:
    """chmod 444."""
    path.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)


def _is_readonly(path: Path) -> bool:
    """Return True iff the file has no write bits set."""
    mode = path.stat().st_mode
    return not bool(mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))


def _sample_to_bytes(sample: Any, idx: str, dest_dir: Path) -> bytes:
    """Materialise a sample (bytes / path / arbitrary value) into dest_dir; return bytes."""
    if isinstance(sample, bytes):
        dest = dest_dir / idx
        dest.write_bytes(sample)
        return sample
    if isinstance(sample, (str, Path)):
        src = Path(sample)
        dest = dest_dir / (idx + src.suffix)
        shutil.copy2(src, dest)
        return dest.read_bytes()
    # Tabular / arbitrary — JSON-encode for deterministic hashing
    encoded = json.dumps(sample, sort_keys=True, default=str).encode()
    dest = dest_dir / (idx + ".json")
    dest.write_bytes(encoded)
    return encoded


def _sample_bytes(sample: Any) -> bytes:
    """Byte encoding of a sample WITHOUT materialising it (mirrors _sample_to_bytes)."""
    if isinstance(sample, bytes):
        return sample
    if isinstance(sample, (str, Path)):
        return Path(sample).read_bytes()
    return json.dumps(sample, sort_keys=True, default=str).encode()


def _compute_split_hash(per_sample_hashes: dict[str, str]) -> str:
    """sha256(sorted_indices_json_bytes || sorted_hashes_json_bytes)."""
    sorted_indices = sorted(per_sample_hashes.keys())
    idx_bytes = json.dumps(sorted_indices).encode()
    hash_bytes = json.dumps([per_sample_hashes[i] for i in sorted_indices]).encode()
    return _sha256_bytes(idx_bytes + hash_bytes)


# ─────────────────────────────────────────────────────────────────────────────
# FrozenSplitManager
# ─────────────────────────────────────────────────────────────────────────────


class FrozenSplitManager:
    """Create and verify frozen test/val splits (Pillar 2 layers 1–2)."""

    def freeze_splits(
        self,
        dataset_path: Path,
        split_config: dict[str, Any],
        eval_version: str,
        run_dir: Path,
        allow_refreeze: bool = False,
    ) -> tuple[FrozenSplit, FrozenSplit]:
        """Create FrozenSplit records for test and val splits.

        Steps:
          1. Compute per_sample_hashes: {str(i): sha256(sample_bytes)}
          2. Compute split_hash = sha256(sorted_indices_bytes || sorted_hashes_bytes)
          3. Copy sample files into frozen-splits/<eval_version>-{test,val}/
          4. chmod 444 on all copied files (Pillar 2 layer 1)
          5. Write FrozenSplit JSON to frozen-splits/<eval_version>-{test,val}.json

        split_config keys:
          mission_id  (str)                     — carried into split_id
          test        (dict[str, Any])           — {sample_index: sample}
          val         (dict[str, Any])           — {sample_index: sample}

        Returns (test_split, val_split).
        locked_split_hash (for GoalContract) = test_split.split_hash.
        """
        (run_dir / "frozen-splits").mkdir(parents=True, exist_ok=True)
        mission_id = split_config.get("mission_id", "")

        test_split = self._freeze_one(
            split_type="test",
            entries=split_config.get("test", {}),
            eval_version=eval_version,
            run_dir=run_dir,
            mission_id=mission_id,
            allow_refreeze=allow_refreeze,
            domains=split_config.get("test_domains"),
            groups=split_config.get("test_groups"),
        )
        val_split = self._freeze_one(
            split_type="val",
            entries=split_config.get("val", {}),
            eval_version=eval_version,
            run_dir=run_dir,
            mission_id=mission_id,
            allow_refreeze=allow_refreeze,
            domains=split_config.get("val_domains"),
            groups=split_config.get("val_groups"),
        )
        # ── G-4 (item 2.4): anchor TRAIN too, when it is declared ────────────
        #
        # `freeze_splits` returned only test and val, and the contract anchored
        # the test hash alone — train was never hashed, never anchored, never
        # recorded. So the training set could change between ticks with no anchor
        # violation: fitness stayed comparable by the contract's own definition
        # while the denominator of LEARNING moved underneath it. Silent, which is
        # why it survived the field run unremarked.
        #
        # `IntegrityGate.lock_splits` already computed a three-way anchor and had
        # zero production callers. The affordance existed; nothing used it.
        train_entries = split_config.get("train") or {}
        if train_entries:
            self._freeze_one(
                split_type="train",
                entries=train_entries,
                eval_version=eval_version,
                run_dir=run_dir,
                mission_id=mission_id,
                allow_refreeze=allow_refreeze,
                domains=split_config.get("train_domains"),
                groups=split_config.get("train_groups"),
            )

        return test_split, val_split

    def _freeze_one(
        self,
        split_type: str,
        entries: dict[str, Any] | list[tuple[str, Any]],
        eval_version: str,
        run_dir: Path,
        mission_id: str,
        allow_refreeze: bool = False,
        domains: dict[str, str] | None = None,
        groups: dict[str, str] | None = None,
    ) -> FrozenSplit:
        frozen_dir = run_dir / "frozen-splits"
        split_dir = frozen_dir / f"{eval_version}-{split_type}"
        split_dir.mkdir(parents=True, exist_ok=True)

        items: list[tuple[str, Any]] = (
            list(entries) if isinstance(entries, list)
            else [(str(k), v) for k, v in entries.items()]
        )

        storage_path = frozen_dir / f"{eval_version}-{split_type}.json"

        # ── Decide BEFORE materialising anything ──────────────────────────────
        # The first freeze chmods every materialised sample to 444, so a second
        # freeze into the same split_dir raises PermissionError inside
        # _sample_to_bytes before any guard placed after the loop could run. That
        # is the PermissionError seen in run 29d17abc, and it is the same
        # mechanism as the shrink rather than a separate fault: the failed second
        # call left the split untouched, and a third call over a narrower dataset
        # (fewer indices, so no collision with the read-only files) then wrote a
        # smaller split over the original.
        #
        # Hashing without writing lets the decision happen first, so a rejected
        # re-freeze touches neither the samples nor the JSON.
        prospective = {str(idx): _sha256_bytes(_sample_bytes(sample)) for idx, sample in items}
        prospective_hash = _compute_split_hash(prospective)

        if storage_path.exists() and not allow_refreeze:
            try:
                prior = FrozenSplit.model_validate_json(storage_path.read_text())
            except Exception:
                prior = None  # unreadable prior — treat as absent and re-freeze
            if prior is not None:
                if prior.split_hash == prospective_hash:
                    return prior  # identical content: idempotent, nothing to do
                raise ValueError(
                    f"refusing to re-freeze the {split_type} split for eval_version "
                    f"{eval_version!r}: it is already frozen with item_count="
                    f"{prior.item_count} (hash {prior.split_hash[:12]}…) and this call "
                    f"would replace it with item_count={len(prospective)} "
                    f"(hash {prospective_hash[:12]}…). A frozen split is the denominator "
                    f"of every fitness comparison already recorded, so it cannot change "
                    f"silently. Use a new eval_version for a new eval set, or pass "
                    f"allow_refreeze=True to state that replacing it is intended."
                )

        # A deliberate re-freeze must be able to overwrite the read-only samples
        # its predecessor left behind.
        if split_dir.exists():
            for f in split_dir.iterdir():
                if f.is_file():
                    f.chmod(0o644)

        per_sample_hashes: dict[str, str] = {}
        for idx, sample in items:
            sample_bytes = _sample_to_bytes(sample, idx, split_dir)
            per_sample_hashes[str(idx)] = _sha256_bytes(sample_bytes)

        # chmod 444 all materialised sample files
        for f in split_dir.iterdir():
            if f.is_file():
                _make_readonly(f)

        split_hash = _compute_split_hash(per_sample_hashes)

        # ── 2.2: domain counts are COMPUTED here, from what was actually frozen.
        # Never taken from the caller. A count an agent supplies is a claim about
        # the split; a count derived from the split is a property of it. Fitness
        # on this mission is min-over-22-domains, and until now the contract had
        # no way to name a domain at all — so the aggregation it declared was not
        # expressible over the split it was handed.
        per_sample_domains = {k: v for k, v in (domains or {}).items() if k in per_sample_hashes}
        domain_counts: dict[str, int] = {}
        for domain_id in per_sample_domains.values():
            domain_counts[domain_id] = domain_counts.get(domain_id, 0) + 1

        split = FrozenSplit(
            split_id=f"{mission_id}-{eval_version}-{split_type}",
            mission_id=mission_id,
            split_type=split_type,  # type: ignore[arg-type]
            split_hash=split_hash,
            per_sample_hashes=per_sample_hashes,
            item_count=len(per_sample_hashes),
            frozen_at=datetime.now(timezone.utc).isoformat(),
            storage_path=str(storage_path.resolve()),
            eval_version=eval_version,
            per_sample_domains=per_sample_domains,
            domain_counts=domain_counts,
            per_sample_groups={k: v for k, v in (groups or {}).items() if k in per_sample_hashes},
        )
        # Atomic: a reader must never observe a half-written split.
        tmp_path = storage_path.with_suffix(".json.tmp")
        tmp_path.write_text(split.model_dump_json(indent=2))
        tmp_path.replace(storage_path)
        return split

    def verify_frozen_split(self, split: FrozenSplit, run_dir: Path) -> bool:
        """Recompute split_hash + per_sample_hashes; return False on any mismatch.

        Called by IntegrityGate on every evaluation (Pillar 2 layer 2).
        """
        split_dir = run_dir / "frozen-splits" / f"{split.eval_version}-{split.split_type}"
        if not split_dir.exists():
            return False

        recomputed: dict[str, str] = {}
        for f in split_dir.iterdir():
            if f.is_file():
                recomputed[f.stem] = _sha256_bytes(f.read_bytes())

        if recomputed != split.per_sample_hashes:
            return False

        return _compute_split_hash(recomputed) == split.split_hash

    def check_read_only(self, split: FrozenSplit, run_dir: Path) -> bool:
        """Return False if any file in the frozen-split directory is writable (Pillar 2 layer 1)."""
        split_dir = run_dir / "frozen-splits" / f"{split.eval_version}-{split.split_type}"
        if not split_dir.exists():
            return False
        for f in split_dir.iterdir():
            if f.is_file() and not _is_readonly(f):
                return False
        return True


# ─────────────────────────────────────────────────────────────────────────────
# DataProvenanceTracker
# ─────────────────────────────────────────────────────────────────────────────


class DataProvenanceTracker:
    """Per-augmented-sample provenance tracking + near-dup leakage detection."""

    def record(
        self,
        sample_id: str,
        source_sample_id: str,
        transforms: list[str],
        is_synthetic: bool,
        frozen_test: FrozenSplit,
        frozen_val: FrozenSplit,
        sample_bytes: bytes | None = None,
        node_id: str = "",
        run_dir: Path | None = None,
    ) -> DataProvenance:
        """Compute sha256(augmented_sample); confirm not in test or val per_sample_hashes.

        Raises ValueError if the augmented sample's hash collides with any frozen split.
        Appends a DataProvenance record to nodes/<node_id>/data-provenance.jsonl.
        """
        verified = True
        if sample_bytes is not None:
            aug_hash = _sha256_bytes(sample_bytes)
            test_hashes = set(frozen_test.per_sample_hashes.values())
            val_hashes = set(frozen_val.per_sample_hashes.values())
            if aug_hash in test_hashes or aug_hash in val_hashes:
                raise ValueError(
                    f"Augmented sample {sample_id!r} (sha256={aug_hash[:12]}…) "
                    "collides with a frozen split sample — data provenance violation."
                )

        prov = DataProvenance(
            sample_id=sample_id,
            source_sample_id=source_sample_id,
            split_type="train",
            transform_applied=transforms,
            is_synthetic=is_synthetic,
            verified_not_in_test=verified,
        )

        if run_dir is not None and node_id:
            prov_dir = run_dir / "nodes" / node_id
            prov_dir.mkdir(parents=True, exist_ok=True)
            prov_file = prov_dir / "data-provenance.jsonl"
            with open(prov_file, "a") as fh:
                fh.write(prov.model_dump_json() + "\n")

        return prov

    def check_near_dup(
        self,
        aug_samples: list[bytes],
        frozen_test: FrozenSplit,
        similarity_threshold: float = 0.95,
        frozen_test_raw: dict[str, bytes] | None = None,
    ) -> list[str]:
        """Near-duplicate check (Pillar 2 layer 3).

        Primary check: exact sha256 match against frozen test hashes (always performed).
        Secondary check (when frozen_test_raw is supplied): byte 4-gram Jaccard similarity.

        Returns list of sample indices (str) where similarity > threshold.

        Modality note: proper image dhash and text embedding similarity require
        Pillow / sentence-transformers.  Pass frozen_test_raw for Jaccard-based
        detection; leave it None for exact-match-only (safe default for tabular data).
        """
        test_hash_set = set(frozen_test.per_sample_hashes.values())
        flagged: list[str] = []

        for i, sample in enumerate(aug_samples):
            # Layer 1: exact hash match
            if _sha256_bytes(sample) in test_hash_set:
                flagged.append(str(i))
                continue

            # Layer 2 (optional): Jaccard on byte 4-grams
            if frozen_test_raw is not None:
                sample_shingles = _byte_shingles(sample)
                for raw in frozen_test_raw.values():
                    ref_shingles = _byte_shingles(raw)
                    union = len(sample_shingles | ref_shingles)
                    if union == 0:
                        continue
                    jaccard = len(sample_shingles & ref_shingles) / union
                    if jaccard >= similarity_threshold:
                        flagged.append(str(i))
                        break

        return flagged


def _byte_shingles(data: bytes, k: int = 4) -> frozenset[bytes]:
    """k-gram shingles over raw bytes."""
    if len(data) < k:
        return frozenset()
    return frozenset(data[i: i + k] for i in range(len(data) - k + 1))


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point — `python -m evor.freeze`
# ─────────────────────────────────────────────────────────────────────────────


def _cli() -> None:
    """CLI for FrozenSplitManager.

    Subcommands
    -----------
    freeze-splits
        Freeze test and val splits from a dataset directory.

        Usage::

            python -m evor.freeze freeze-splits \\
                --dataset-path /path/to/dataset \\
                --eval-version v1 \\
                --run-dir .evor/runs/<mission>/<run-id>/ \\
                [--mission-id <id>]

        Scans *dataset-path* for files and assigns 80 % to test, 20 % to val.
        If the directory is empty or does not exist, empty splits are created
        (valid for environments without a real dataset during setup/testing).
        Outputs a JSON line with ``locked_split_hash`` (= test split hash) and
        ``val_split_hash``.
    """
    import argparse
    import sys as _sys

    parser = argparse.ArgumentParser(prog="python -m evor.freeze")
    sub = parser.add_subparsers(dest="cmd", required=True)

    fs = sub.add_parser(
        "freeze-splits",
        help="Freeze test and val splits from a dataset directory.",
    )
    fs.add_argument("--dataset-path", required=True, help="Path to dataset directory or file")
    fs.add_argument("--eval-version", required=True, help="Eval version string (e.g. v1)")
    fs.add_argument("--run-dir", required=True, help="Path to .evor/runs/<mission>/<run-id>/")
    fs.add_argument("--mission-id", default="", help="Mission ID carried into split_id")

    args = parser.parse_args()

    if args.cmd == "freeze-splits":
        dataset_path = Path(args.dataset_path)
        run_dir = Path(args.run_dir)

        # ── 2.1: read the DECLARED split when the corpus declares one ────────
        #
        # What stood here took `dataset_path.iterdir()` — the corpus's top-level
        # files — and split them 80/20. For `corpora/v10` that is
        # `dataset_card.yaml`, `domains.json`, `frozen_index.json`,
        # `manifest.json`, `test.txt`, `train.txt`, `val.txt`: SEVEN METADATA
        # FILES, of which five became "the eval set". It exited 0 and reported
        # `test_item_count: 5`, and every fitness number in the mission was
        # computed against it.
        #
        # The corpus was never ambiguous. `_freeze_anchor/eval_manifest_test.json`
        # — written four weeks before the mission — declares 132 items, 22
        # domains, an image/gt pair per item, a sha256 per file, and per-domain
        # counts. Nothing read it. AF1's warning is why the fix is here and not
        # in the leakage check: "the guard is not too weak; it is reasoning over a
        # representation that cannot carry the distinction it needs to make."
        split_config: dict[str, Any] = {"mission_id": args.mission_id}
        declared = _load_declared_splits(dataset_path)
        if declared:
            split_config.update(declared)
        elif dataset_path.is_dir():
            all_files = sorted(
                f for f in dataset_path.iterdir()
                if f.is_file() and not f.name.startswith(".")
            )
            _refuse_if_metadata_only(all_files, dataset_path)
            split_idx = max(1, int(len(all_files) * 0.8))
            split_config["test"] = {str(i): f for i, f in enumerate(all_files[:split_idx])}
            split_config["val"] = {str(i): f for i, f in enumerate(all_files[split_idx:])}
        else:
            split_config["test"] = {}
            split_config["val"] = {}

        mgr = FrozenSplitManager()
        test_split, val_split = mgr.freeze_splits(
            dataset_path=dataset_path,
            split_config=split_config,
            eval_version=args.eval_version,
            run_dir=run_dir,
        )
        print(json.dumps({
            "locked_split_hash": test_split.split_hash,
            "val_split_hash": val_split.split_hash,
            "test_item_count": test_split.item_count,
            "val_item_count": val_split.item_count,
        }))
        _sys.exit(0)


#: Filenames that DESCRIBE a corpus rather than belong to it.
#:
#: Matched by name, not by suffix. Suffix was the first thing tried here and it
#: was wrong for the same reason the original bug was wrong: a directory of
#: `sample_000.txt` files is a perfectly good corpus, and refusing it would be a
#: guard reasoning over a representation that cannot carry the distinction it
#: needs to make — AF1's warning, repeated by the fix for AF1.
#:
#: These specific names are the corpus-manifest vocabulary, and a directory
#: containing ONLY them is the AF1 signature exactly.
_METADATA_NAMES = {
    "dataset_card.yaml", "dataset_card.yml", "domains.json", "manifest.json",
    "frozen_index.json", "test.txt", "train.txt", "val.txt", "readme.md",
    "license", "license.txt", "citation.cff",
}


def _refuse_if_metadata_only(files: list[Path], dataset_path: Path) -> None:
    """Refuse a directory scan that would freeze only metadata (item 2.1).

    The fallback scan is legitimate for a flat directory of samples. It is never
    legitimate when every file it found is a manifest — that is not a small eval
    set, it is the wrong set, and returning it as a valid split is how five
    metadata files became the denominator of every fitness comparison in a
    19-hour run.
    """
    if not files:
        return
    if all(f.name.lower() in _METADATA_NAMES for f in files):
        names = ", ".join(sorted(f.name for f in files)[:8])
        raise ValueError(
            f"refusing to freeze {dataset_path}: every file found at the top level is "
            f"metadata ({names}). These describe the corpus; they are not samples of "
            f"it. Declare the split in _freeze_anchor/eval_manifest_<split>.json, or "
            f"point --dataset-path at the directory that holds the samples."
        )


def _load_declared_splits(dataset_path: Path) -> dict[str, Any]:
    """Read `_freeze_anchor/eval_manifest_{test,val}.json` if the corpus has them.

    Returns entries plus the per-item domain and group metadata the manifest
    already carries, or {} when there is no anchor to read.

    Item paths are resolved relative to the corpus root and then, failing that,
    to the repository root — the manifests in the field carry paths like
    `data/corpora/v10/test/images/000000.png`, which are relative to the project
    rather than to `--dataset-path`.
    """
    anchor = dataset_path / "_freeze_anchor"
    if not anchor.is_dir():
        return {}

    out: dict[str, Any] = {}
    for split in ("test", "val", "train"):
        manifest = anchor / f"eval_manifest_{split}.json"
        if not manifest.exists():
            continue
        try:
            data = json.loads(manifest.read_text())
        except Exception as exc:
            raise ValueError(f"{manifest} is unreadable: {exc}") from exc

        entries: dict[str, Any] = {}
        domains: dict[str, str] = {}
        groups: dict[str, str] = {}
        unresolved: list[str] = []
        for i, item in enumerate(data.get("items", [])):
            key = str(item.get("index", i))
            resolved = _resolve_item_path(item.get("image"), dataset_path)
            if resolved is None:
                resolved = _resolve_item_by_hash(item, dataset_path)
            if resolved is None:
                unresolved.append(str(item.get("image")))
                continue
            entries[key] = resolved
            if item.get("domain"):
                domains[key] = str(item["domain"])
            # 2.3: the corpus declares source-page lineage under either name.
            group = item.get("group") or item.get("source_page")
            if group:
                groups[key] = str(group)

        out[split] = entries
        out[f"{split}_domains"] = domains
        out[f"{split}_groups"] = groups

        # The manifest states its own count. If our reading of it disagrees, the
        # manifest is not what we think it is — say so rather than freezing a
        # different number of items than the corpus declares.
        if unresolved:
            raise ValueError(
                f"{manifest} declares {len(data.get('items', []))} items but "
                f"{len(unresolved)} could not be located by path or by declared "
                f"sha256 (first: {unresolved[0]!r}). Refusing to freeze a partial "
                f"split — a smaller eval set is not a smaller answer to the same "
                f"question, it is an answer to a different one."
            )

        declared_count = data.get("item_count")
        if isinstance(declared_count, int) and declared_count != len(entries):
            raise ValueError(
                f"{manifest} declares item_count={declared_count} but yields "
                f"{len(entries)} items. Refusing to freeze a split the corpus does "
                f"not agree with."
            )
    return out


def _resolve_item_path(raw: Any, dataset_path: Path) -> Path | None:
    """Resolve a manifest item path against the plausible roots, or None."""
    if not raw:
        return None
    p = Path(str(raw))
    if p.is_absolute():
        return p if p.exists() else None
    for root in (dataset_path, dataset_path.parent, dataset_path.parent.parent,
                 dataset_path.parent.parent.parent, Path.cwd()):
        candidate = root / p
        if candidate.exists():
            return candidate
    # The manifest path may repeat the corpus dir name.
    if dataset_path.name in p.parts:
        tail = Path(*p.parts[p.parts.index(dataset_path.name) + 1:])
        if (dataset_path / tail).exists():
            return dataset_path / tail
    return None


@lru_cache(maxsize=8)
def _content_index(dataset_path: Path) -> dict[str, Path]:
    """sha256 -> path for every file under the corpus.

    Built once per corpus and cached. Roughly a hundred files for a corpus this
    size; the cost is trivial against freezing the wrong set.
    """
    index: dict[str, Path] = {}
    for f in sorted(dataset_path.rglob("*")):
        if f.is_file():
            try:
                index.setdefault(_sha256_bytes(f.read_bytes()), f)
            except OSError:
                continue
    return index


def _resolve_item_by_hash(item: dict[str, Any], dataset_path: Path) -> Path | None:
    """Find the file the manifest DESCRIBES, wherever it now lives.

    A manifest's authority is the hash, not the path. `corpora/v10`'s anchor was
    written on 26 July against `test/images/000000.png`; by the time the mission
    ran, the operator had reorganised the corpus into `eval/test/<domain>__<index>.png`
    and those paths no longer existed. The declaration was still exactly right
    about WHICH 132 files constitute the test split — it was only wrong about
    where they sit.

    Resolving by content makes the manifest survive a reorganisation, and it is
    STRICTER than resolving by path: a file that has been edited no longer
    matches its declared hash and is reported missing rather than silently
    frozen in place of the original.
    """
    declared = item.get("sha256_image") or item.get("sha256")
    if not declared:
        return None
    return _content_index(dataset_path).get(str(declared))


if __name__ == "__main__":
    _cli()
