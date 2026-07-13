"""
harness/evor/acquire.py — Acquisition dedup / near-dup gate (AREA 2).

Entry point: python -m evor.acquire check-leakage --run-id <run_dir> ...

Moves the Deduplication_Protocol logic out of agent prose and into a
server-owned tool so agents never see the algorithm or thresholds.

Checks (in order):
  1. Exact sha256 content match against forbidden split  → dropped_for_collision
  2. Per-modality near-dup check (image/text/tabular)    → dropped_for_near_dup
  3. Intra-batch dedup (same two checks across candidates) → dropped_intra_batch

All thresholds are named constants with spec defaults.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Literal

# ── Named threshold constants (spec defaults) ─────────────────────────────────

IMAGE_PHASH_HAMMING_THRESHOLD: int = 8          # Hamming distance ≤ 8 → near-dup
TEXT_MINHASH_JACCARD_THRESHOLD: float = 0.8     # Jaccard similarity ≥ 0.8 → near-dup
TEXT_MINHASH_NUM_PERM: int = 128                # MinHash permutations
TEXT_SHINGLE_K: int = 5                         # k-shingle length for text
TABULAR_L2_FRACTION_THRESHOLD: float = 0.01    # L2 < 1% of feature range → near-dup

Modality = Literal["image", "text", "tabular"]

# ── Optional-dependency availability flags ────────────────────────────────────

try:
    import imagehash as _imagehash  # type: ignore[import-untyped]
    from PIL import Image as _PILImage  # type: ignore[import-untyped]
    _HAS_IMAGE = True
except ImportError:
    _HAS_IMAGE = False

try:
    from datasketch import MinHash as _MinHash, MinHashLSH as _MinHashLSH  # type: ignore[import-untyped]
    _HAS_DATASKETCH = True
except ImportError:
    _HAS_DATASKETCH = False

try:
    import numpy as _np  # type: ignore[import-untyped]
    _HAS_NUMPY = True
except ImportError:
    _HAS_NUMPY = False


# ── Internal helpers ──────────────────────────────────────────────────────────

def _sha256_file(path: str | Path) -> str:
    """SHA-256 of raw file bytes."""
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _sha256_json(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()


def _candidate_sha256(path: str, modality: Modality) -> str:
    """Compute sha256 for a candidate item given its modality."""
    if modality == "image":
        return _sha256_file(path)
    elif modality == "text":
        # Treat path as the text content file; read and hash its text.
        return _sha256_text(Path(path).read_text(encoding="utf-8"))
    else:  # tabular
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        return _sha256_json(raw)


def _split_item_sha256(item: Any, modality: Modality) -> str:
    """Compute sha256 for a frozen-split item dict."""
    if modality == "image":
        return _sha256_file(item["path"])
    elif modality == "text":
        return _sha256_text(item["text"])
    else:  # tabular
        return _sha256_json(item)


def _shingles(text: str, k: int = TEXT_SHINGLE_K) -> list[str]:
    """Character-level k-shingles for a text string."""
    return [text[i : i + k] for i in range(max(0, len(text) - k + 1))]


def _load_split(forbidden_split_path: str | Path) -> list[Any]:
    """Load frozen-split JSON; expects a list of item dicts."""
    data = json.loads(Path(forbidden_split_path).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        # Accept {"items": [...]} wrapper or bare list
        return data.get("items", data.get("samples", []))
    return list(data)


def _feature_vector(row: Any) -> Any:
    """Extract a numeric feature vector from a tabular row dict."""
    if not _HAS_NUMPY:
        raise RuntimeError("numpy unavailable")
    values = [v for v in row.values() if isinstance(v, (int, float))]
    return _np.array(values, dtype=float)


# ── Per-modality near-dup builders ────────────────────────────────────────────

def _build_image_index(forbidden_items: list[Any]) -> list[Any]:
    """Build list of perceptual hashes for forbidden images."""
    if not _HAS_IMAGE:
        raise ImportError("imagehash/Pillow unavailable — cannot check near-dup for image modality")
    phashes = []
    for item in forbidden_items:
        ph = _imagehash.phash(_PILImage.open(item["path"]))
        phashes.append(ph)
    return phashes


def _is_near_dup_image(candidate_path: str, forbidden_phashes: list[Any]) -> bool:
    if not _HAS_IMAGE:
        raise ImportError("imagehash/Pillow unavailable")
    h = _imagehash.phash(_PILImage.open(candidate_path))
    return any(abs(h - fh) <= IMAGE_PHASH_HAMMING_THRESHOLD for fh in forbidden_phashes)


def _build_text_index(forbidden_items: list[Any]) -> Any:
    """Build MinHashLSH index over forbidden text items."""
    if not _HAS_DATASKETCH:
        raise ImportError("datasketch unavailable — cannot check near-dup for text modality")
    lsh = _MinHashLSH(threshold=TEXT_MINHASH_JACCARD_THRESHOLD, num_perm=TEXT_MINHASH_NUM_PERM)
    for i, item in enumerate(forbidden_items):
        m = _MinHash(num_perm=TEXT_MINHASH_NUM_PERM)
        for shingle in _shingles(item["text"], k=TEXT_SHINGLE_K):
            m.update(shingle.encode())
        lsh.insert(f"f-{i}", m)
    return lsh


def _is_near_dup_text(text: str, lsh: Any) -> bool:
    if not _HAS_DATASKETCH:
        raise ImportError("datasketch unavailable")
    m = _MinHash(num_perm=TEXT_MINHASH_NUM_PERM)
    for shingle in _shingles(text, k=TEXT_SHINGLE_K):
        m.update(shingle.encode())
    return len(lsh.query(m)) > 0


def _build_tabular_index(forbidden_items: list[Any]) -> tuple[Any, Any]:
    """Build numpy matrix + feature range for tabular near-dup check."""
    if not _HAS_NUMPY:
        raise ImportError("numpy unavailable — cannot check near-dup for tabular modality")
    vecs = _np.array([_feature_vector(r) for r in forbidden_items], dtype=float)
    feat_range = vecs.max() - vecs.min() + 1e-9
    return vecs, feat_range


def _is_near_dup_tabular(row: Any, forbidden_vecs: Any, feat_range: float) -> bool:
    if not _HAS_NUMPY:
        raise ImportError("numpy unavailable")
    v = _feature_vector(row)
    dists = _np.linalg.norm(forbidden_vecs - v, axis=1)
    return float(dists.min()) < TABULAR_L2_FRACTION_THRESHOLD * float(feat_range)


# ── Public API ─────────────────────────────────────────────────────────────────

def check_leakage(
    candidate_paths: list[str],
    modality: Modality,
    forbidden_split_path: str,
    near_dup: bool = True,
    intra_batch: bool = True,
) -> dict[str, Any]:
    """
    Check candidate_paths for exact-match and near-dup collisions against the
    forbidden split, then optionally run intra-batch dedup.

    Returns:
        {
            "ok": bool,
            "total_candidates": int,
            "dropped_for_collision": int,
            "dropped_for_near_dup": int,
            "dropped_intra_batch": int,
            "accepted_paths": list[str],
            "collision_log": [{"path": str, "collision_type": str}],
        }

    If a required optional library is missing for the requested modality, returns
        {"ok": false, "error": "<message>"}
    rather than crashing the import.
    """
    collision_log: list[dict[str, str]] = []
    dropped_collision = 0
    dropped_near_dup = 0
    dropped_intra_batch = 0

    # ── Load forbidden split ────────────────────────────────────────────────
    try:
        forbidden_items = _load_split(forbidden_split_path)
    except Exception as exc:
        return {"ok": False, "error": f"Failed to load forbidden split: {exc}"}

    # ── Build forbidden sha256 set ──────────────────────────────────────────
    forbidden_hashes: set[str] = set()
    for item in forbidden_items:
        try:
            h = _split_item_sha256(item, modality)
            forbidden_hashes.add(h)
        except Exception as exc:
            return {"ok": False, "error": f"Failed to hash forbidden item: {exc}"}

    # ── Build near-dup index (per modality) ────────────────────────────────
    near_dup_index: Any = None
    if near_dup and forbidden_items:
        try:
            if modality == "image":
                near_dup_index = _build_image_index(forbidden_items)
            elif modality == "text":
                near_dup_index = _build_text_index(forbidden_items)
            else:  # tabular
                near_dup_index = _build_tabular_index(forbidden_items)
        except ImportError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:
            return {"ok": False, "error": f"Failed to build near-dup index: {exc}"}

    # ── Cross-split dedup pass ──────────────────────────────────────────────
    accepted: list[str] = []

    for cpath in candidate_paths:
        try:
            chash = _candidate_sha256(cpath, modality)
        except Exception as exc:
            collision_log.append({"path": cpath, "collision_type": f"hash_error: {exc}"})
            dropped_collision += 1
            continue

        # 1. Exact content match
        if chash in forbidden_hashes:
            collision_log.append({"path": cpath, "collision_type": "exact_collision"})
            dropped_collision += 1
            continue

        # 2. Near-dup check
        if near_dup and near_dup_index is not None:
            try:
                is_dup = False
                if modality == "image":
                    is_dup = _is_near_dup_image(cpath, near_dup_index)
                elif modality == "text":
                    text = Path(cpath).read_text(encoding="utf-8")
                    is_dup = _is_near_dup_text(text, near_dup_index)
                else:  # tabular
                    row = json.loads(Path(cpath).read_text(encoding="utf-8"))
                    vecs, feat_range = near_dup_index
                    is_dup = _is_near_dup_tabular(row, vecs, feat_range)
                if is_dup:
                    collision_log.append({"path": cpath, "collision_type": "near_dup"})
                    dropped_near_dup += 1
                    continue
            except ImportError as exc:
                return {"ok": False, "error": str(exc)}
            except Exception as exc:
                collision_log.append({"path": cpath, "collision_type": f"near_dup_error: {exc}"})
                dropped_near_dup += 1
                continue

        accepted.append(cpath)

    # ── Intra-batch dedup pass ─────────────────────────────────────────────
    if intra_batch and accepted:
        seen_hashes: set[str] = set()
        intra_near_dup_index: Any = None

        # Build intra-batch near-dup index from already-accepted items
        if near_dup:
            try:
                if modality == "image":
                    intra_near_dup_index = []
                elif modality == "text":
                    intra_near_dup_index = (
                        _MinHashLSH(threshold=TEXT_MINHASH_JACCARD_THRESHOLD,
                                    num_perm=TEXT_MINHASH_NUM_PERM)
                        if _HAS_DATASKETCH else None
                    )
                else:  # tabular
                    intra_near_dup_index = []  # grows as items are accepted
            except ImportError as exc:
                return {"ok": False, "error": str(exc)}

        deduped: list[str] = []
        for cpath in accepted:
            try:
                chash = _candidate_sha256(cpath, modality)
            except Exception:
                dropped_intra_batch += 1
                collision_log.append({"path": cpath, "collision_type": "intra_batch_hash_error"})
                continue

            if chash in seen_hashes:
                dropped_intra_batch += 1
                collision_log.append({"path": cpath, "collision_type": "intra_batch_exact"})
                continue

            # Intra-batch near-dup
            is_intra_dup = False
            if near_dup and intra_near_dup_index is not None:
                try:
                    if modality == "image":
                        ph = _imagehash.phash(_PILImage.open(cpath))
                        is_intra_dup = any(
                            abs(ph - existing) <= IMAGE_PHASH_HAMMING_THRESHOLD
                            for existing in intra_near_dup_index
                        )
                        if not is_intra_dup:
                            intra_near_dup_index.append(ph)
                    elif modality == "text":
                        text = Path(cpath).read_text(encoding="utf-8")
                        m = _MinHash(num_perm=TEXT_MINHASH_NUM_PERM)
                        for shingle in _shingles(text, k=TEXT_SHINGLE_K):
                            m.update(shingle.encode())
                        is_intra_dup = len(intra_near_dup_index.query(m)) > 0
                        if not is_intra_dup:
                            intra_near_dup_index.insert(f"b-{len(deduped)}", m)
                    else:  # tabular
                        row = json.loads(Path(cpath).read_text(encoding="utf-8"))
                        v = _feature_vector(row)
                        if intra_near_dup_index:
                            existing_mat = _np.array(intra_near_dup_index, dtype=float)
                            feat_r = existing_mat.max() - existing_mat.min() + 1e-9
                            dists = _np.linalg.norm(existing_mat - v, axis=1)
                            is_intra_dup = float(dists.min()) < TABULAR_L2_FRACTION_THRESHOLD * float(feat_r)
                        if not is_intra_dup:
                            intra_near_dup_index.append(v.tolist())
                except ImportError as exc:
                    return {"ok": False, "error": str(exc)}
                except Exception:
                    pass  # fail-open for intra-batch near-dup errors

            if is_intra_dup:
                dropped_intra_batch += 1
                collision_log.append({"path": cpath, "collision_type": "intra_batch_near_dup"})
                continue

            seen_hashes.add(chash)
            deduped.append(cpath)

        accepted = deduped

    return {
        "ok": True,
        "total_candidates": len(candidate_paths),
        "dropped_for_collision": dropped_collision,
        "dropped_for_near_dup": dropped_near_dup,
        "dropped_intra_batch": dropped_intra_batch,
        "accepted_paths": accepted,
        "collision_log": collision_log,
    }


# ── CLI entry point ────────────────────────────────────────────────────────────

def _cli() -> None:  # pragma: no cover
    parser = argparse.ArgumentParser(prog="python -m evor.acquire")
    sub = parser.add_subparsers(dest="cmd", required=True)

    cl = sub.add_parser("check-leakage")
    cl.add_argument("--run-id", required=True,
                    help="Run directory path (for context; not used by logic directly)")
    cl.add_argument("--candidate-paths", required=True,
                    help="JSON array of candidate file paths")
    cl.add_argument("--modality", required=True,
                    choices=["image", "text", "tabular"])
    cl.add_argument("--forbidden-split", required=True,
                    help="Path to frozen-splits/<eval_version>-test.json")
    cl.add_argument("--near-dup", default="true",
                    help="Enable near-dup check (true/false)")
    cl.add_argument("--intra-batch", default="true",
                    help="Enable intra-batch dedup (true/false)")

    args = parser.parse_args()

    if args.cmd == "check-leakage":
        candidates = json.loads(args.candidate_paths)
        result = check_leakage(
            candidate_paths=candidates,
            modality=args.modality,
            forbidden_split_path=args.forbidden_split,
            near_dup=args.near_dup.lower() not in ("false", "0", "no"),
            intra_batch=args.intra_batch.lower() not in ("false", "0", "no"),
        )
        print(json.dumps(result))
        sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    _cli()
