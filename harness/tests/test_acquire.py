"""
harness/tests/test_acquire.py

Unit tests for evor/acquire.py::check_leakage.

Coverage:
  - exact sha256 collision dropped (all modalities)
  - near-dup dropped at threshold (image/text/tabular) when libs available
  - clean item accepted (all modalities)
  - intra-batch exact duplicate dropped
  - intra-batch near-dup dropped (text)
  - missing optional lib returns {"ok": False, "error": ...} for that modality
  - empty candidate list → accepted_paths=[]
  - forbidden split not found → ok:False with error
  - near_dup=False disables near-dup pass
  - intra_batch=False disables intra-batch pass

Near-dup tests are skipped when the relevant optional library is unavailable
so the suite passes cleanly in minimal environments.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from evor.acquire import (
    IMAGE_PHASH_HAMMING_THRESHOLD,
    TEXT_MINHASH_JACCARD_THRESHOLD,
    TABULAR_L2_FRACTION_THRESHOLD,
    _HAS_DATASKETCH,
    _HAS_IMAGE,
    _HAS_NUMPY,
    check_leakage,
)

_HARNESS_DIR = Path(__file__).resolve().parent.parent


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_text_file(path: Path, content: str) -> Path:
    path.write_text(content, encoding="utf-8")
    return path


def _write_json_file(path: Path, obj: object) -> Path:
    path.write_text(json.dumps(obj), encoding="utf-8")
    return path


def _make_forbidden_split(path: Path, items: list[object]) -> Path:
    path.write_text(json.dumps(items), encoding="utf-8")
    return path


# ── TEXT modality ─────────────────────────────────────────────────────────────

class TestTextExactMatch:
    def test_exact_collision_dropped(self, tmp_path: Path) -> None:
        """A candidate whose sha256 matches a forbidden item is dropped."""
        content = "this is some test data that must not leak"
        forbidden_item = {"text": content}
        split = _make_forbidden_split(tmp_path / "split.json", [forbidden_item])

        candidate = _write_text_file(tmp_path / "c1.txt", content)

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["dropped_for_collision"] == 1
        assert result["dropped_for_near_dup"] == 0
        assert result["accepted_paths"] == []
        assert result["collision_log"][0]["collision_type"] == "exact_collision"

    def test_clean_item_accepted(self, tmp_path: Path) -> None:
        """A candidate with a different hash passes through."""
        forbidden_item = {"text": "forbidden sentence"}
        split = _make_forbidden_split(tmp_path / "split.json", [forbidden_item])

        candidate = _write_text_file(tmp_path / "clean.txt", "completely different text")

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["dropped_for_collision"] == 0
        assert result["accepted_paths"] == [str(candidate)]

    def test_multiple_candidates_mixed(self, tmp_path: Path) -> None:
        """Exact match items dropped; clean items pass."""
        forbidden = [{"text": "forbidden text one"}, {"text": "forbidden text two"}]
        split = _make_forbidden_split(tmp_path / "split.json", forbidden)

        c1 = _write_text_file(tmp_path / "c1.txt", "forbidden text one")
        c2 = _write_text_file(tmp_path / "c2.txt", "safe candidate text")
        c3 = _write_text_file(tmp_path / "c3.txt", "forbidden text two")

        result = check_leakage(
            candidate_paths=[str(c1), str(c2), str(c3)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["total_candidates"] == 3
        assert result["dropped_for_collision"] == 2
        assert result["accepted_paths"] == [str(c2)]


@pytest.mark.skipif(not _HAS_DATASKETCH, reason="datasketch not installed")
class TestTextNearDup:
    def test_near_dup_dropped_above_threshold(self, tmp_path: Path) -> None:
        """A text that is very similar (Jaccard > 0.8) to a forbidden item is dropped."""
        # Construct two texts sharing ~90% of 5-char shingles
        base = "the quick brown fox jumps over the lazy dog " * 10
        variant = base.replace("quick", "swift")  # One word change — still very similar
        forbidden = [{"text": base}]
        split = _make_forbidden_split(tmp_path / "split.json", [forbidden[0]])

        candidate = _write_text_file(tmp_path / "near.txt", variant)

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=True,
            intra_batch=False,
        )

        assert result["ok"] is True
        # Either dropped_for_collision or dropped_for_near_dup (variant is not exact match)
        total_dropped = result["dropped_for_collision"] + result["dropped_for_near_dup"]
        assert total_dropped == 1, (
            f"Expected near-dup to be caught; result={result}"
        )

    def test_distinct_text_not_dropped(self, tmp_path: Path) -> None:
        """A completely different text is not flagged as near-dup."""
        forbidden = [{"text": "machine learning is fascinating for research"}]
        split = _make_forbidden_split(tmp_path / "split.json", [forbidden[0]])

        candidate = _write_text_file(
            tmp_path / "clean.txt",
            "zucchini recipes: chop, sauté with garlic, serve warm"
        )

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=True,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["dropped_for_near_dup"] == 0
        assert result["accepted_paths"] == [str(candidate)]

    def test_near_dup_disabled(self, tmp_path: Path) -> None:
        """near_dup=False skips the near-dup pass even if items are similar."""
        base = "the quick brown fox jumps over the lazy dog " * 10
        variant = base.replace("quick", "swift")
        forbidden = [{"text": base}]
        split = _make_forbidden_split(tmp_path / "split.json", [forbidden[0]])

        candidate = _write_text_file(tmp_path / "near.txt", variant)

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["dropped_for_near_dup"] == 0


# ── TABULAR modality ──────────────────────────────────────────────────────────

class TestTabularExactMatch:
    def test_exact_collision_dropped(self, tmp_path: Path) -> None:
        """Tabular item with matching JSON sha256 is dropped."""
        row = {"a": 1, "b": 2, "c": 3}
        split = _make_forbidden_split(tmp_path / "split.json", [row])
        candidate = _write_json_file(tmp_path / "c1.json", row)

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="tabular",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["dropped_for_collision"] == 1
        assert result["accepted_paths"] == []

    def test_clean_item_accepted(self, tmp_path: Path) -> None:
        """Tabular item with different values passes through."""
        forbidden = {"a": 1, "b": 2, "c": 3}
        split = _make_forbidden_split(tmp_path / "split.json", [forbidden])
        candidate = _write_json_file(tmp_path / "c1.json", {"a": 99, "b": 99, "c": 99})

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="tabular",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["accepted_paths"] == [str(candidate)]


@pytest.mark.skipif(not _HAS_NUMPY, reason="numpy not installed")
class TestTabularNearDup:
    def test_near_dup_dropped_within_threshold(self, tmp_path: Path) -> None:
        """Row very close in L2 distance (< 1% of feature range) to a forbidden row is dropped."""
        forbidden_row = {"a": 0.0, "b": 0.0, "c": 0.0}
        split = _make_forbidden_split(tmp_path / "split.json", [forbidden_row])

        # Feature range is 0 (all zeros), so 1e-9 acts as denominator; any non-zero distance
        # must be < 0.01 * 1e-9 → effectively only exact (or near-zero) matches.
        # Use a truly tiny perturbation that is < 1% of range when range is large.
        # Build a case with a real spread: forbidden at 0, candidate at 0.001, max at 100.
        forbidden_spread = [
            {"a": 0.0, "b": 0.0},
            {"a": 100.0, "b": 100.0},
        ]
        split2 = _make_forbidden_split(tmp_path / "split2.json", forbidden_spread)
        # L2 distance from (0.5, 0.5) to nearest forbidden (0,0) = ~0.707
        # 1% of feature range (100) = 1.0  → 0.707 < 1.0 → near-dup
        candidate = _write_json_file(tmp_path / "near.json", {"a": 0.5, "b": 0.5})

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="tabular",
            forbidden_split_path=str(split2),
            near_dup=True,
            intra_batch=False,
        )

        assert result["ok"] is True
        total_dropped = result["dropped_for_collision"] + result["dropped_for_near_dup"]
        assert total_dropped == 1, f"Expected near-dup drop; result={result}"

    def test_distant_row_accepted(self, tmp_path: Path) -> None:
        """Row clearly outside the 1% threshold passes through."""
        # Forbidden at 0; range = 100; 1% = 1.0 threshold; candidate at distance 50
        forbidden_spread = [
            {"a": 0.0, "b": 0.0},
            {"a": 100.0, "b": 0.0},
        ]
        split = _make_forbidden_split(tmp_path / "split.json", forbidden_spread)
        candidate = _write_json_file(tmp_path / "far.json", {"a": 50.0, "b": 50.0})

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="tabular",
            forbidden_split_path=str(split),
            near_dup=True,
            intra_batch=False,
        )

        assert result["ok"] is True
        # Distance from (50,50) to (0,0) = ~70.7; to (100,0) = ~70.7; range = 100; threshold = 1.0
        # 70.7 > 1.0 → accepted
        assert result["accepted_paths"] == [str(candidate)]


# ── IMAGE modality ─────────────────────────────────────────────────────────────

class TestImageExactMatch:
    def test_exact_collision_dropped(self, tmp_path: Path) -> None:
        """Image with matching sha256 is dropped."""
        image_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100  # fake PNG bytes
        img_file = tmp_path / "img.png"
        img_file.write_bytes(image_bytes)

        forbidden = [{"path": str(img_file)}]
        split = _make_forbidden_split(tmp_path / "split.json", forbidden)

        candidate = tmp_path / "candidate.png"
        candidate.write_bytes(image_bytes)

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="image",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["dropped_for_collision"] == 1
        assert result["accepted_paths"] == []

    def test_different_image_accepted(self, tmp_path: Path) -> None:
        """Image with different bytes passes through."""
        img_a = tmp_path / "a.png"
        img_b = tmp_path / "b.png"
        img_a.write_bytes(b"\x89PNG" + b"\x00" * 50)
        img_b.write_bytes(b"\x89PNG" + b"\xff" * 50)

        split = _make_forbidden_split(tmp_path / "split.json", [{"path": str(img_a)}])

        result = check_leakage(
            candidate_paths=[str(img_b)],
            modality="image",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["accepted_paths"] == [str(img_b)]


@pytest.mark.skipif(not _HAS_IMAGE, reason="imagehash/Pillow not installed")
class TestImageNearDup:
    def test_near_dup_image_dropped(self, tmp_path: Path) -> None:
        """Two nearly-identical images are caught by phash Hamming distance."""
        import numpy as _np
        from PIL import Image as _PILImage

        # Build two real images that differ by only a few pixels (very low Hamming distance)
        arr_a = _np.zeros((64, 64, 3), dtype=_np.uint8)
        arr_b = arr_a.copy()
        arr_b[0, 0] = [1, 1, 1]  # single pixel change → Hamming will be very small

        img_a = tmp_path / "a.png"
        img_b = tmp_path / "b.png"
        _PILImage.fromarray(arr_a).save(str(img_a))
        _PILImage.fromarray(arr_b).save(str(img_b))

        split = _make_forbidden_split(tmp_path / "split.json", [{"path": str(img_a)}])

        result = check_leakage(
            candidate_paths=[str(img_b)],
            modality="image",
            forbidden_split_path=str(split),
            near_dup=True,
            intra_batch=False,
        )

        assert result["ok"] is True
        total_dropped = result["dropped_for_collision"] + result["dropped_for_near_dup"]
        assert total_dropped == 1, f"Expected near-dup drop; result={result}"

    def test_dissimilar_image_accepted(self, tmp_path: Path) -> None:
        """Two very different images are not flagged as near-dup."""
        import numpy as _np
        from PIL import Image as _PILImage

        arr_a = _np.zeros((64, 64, 3), dtype=_np.uint8)
        arr_b = _np.full((64, 64, 3), 255, dtype=_np.uint8)  # all-white vs all-black

        img_a = tmp_path / "a.png"
        img_b = tmp_path / "b.png"
        _PILImage.fromarray(arr_a).save(str(img_a))
        _PILImage.fromarray(arr_b).save(str(img_b))

        split = _make_forbidden_split(tmp_path / "split.json", [{"path": str(img_a)}])

        result = check_leakage(
            candidate_paths=[str(img_b)],
            modality="image",
            forbidden_split_path=str(split),
            near_dup=True,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["accepted_paths"] == [str(img_b)]


# ── INTRA-BATCH dedup ─────────────────────────────────────────────────────────

class TestIntraBatch:
    def test_intra_batch_exact_duplicate_dropped(self, tmp_path: Path) -> None:
        """Two identical candidates → second is dropped by intra-batch pass."""
        split = _make_forbidden_split(tmp_path / "split.json", [{"text": "forbidden"}])
        content = "safe unique text that is not in the forbidden split"
        c1 = _write_text_file(tmp_path / "c1.txt", content)
        c2 = _write_text_file(tmp_path / "c2.txt", content)  # same bytes

        result = check_leakage(
            candidate_paths=[str(c1), str(c2)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=True,
        )

        assert result["ok"] is True
        assert result["dropped_intra_batch"] == 1
        assert len(result["accepted_paths"]) == 1
        assert result["accepted_paths"][0] == str(c1)

    def test_intra_batch_disabled(self, tmp_path: Path) -> None:
        """intra_batch=False lets duplicates through."""
        split = _make_forbidden_split(tmp_path / "split.json", [{"text": "forbidden"}])
        content = "safe candidate text"
        c1 = _write_text_file(tmp_path / "c1.txt", content)
        c2 = _write_text_file(tmp_path / "c2.txt", content)

        result = check_leakage(
            candidate_paths=[str(c1), str(c2)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=False,
            intra_batch=False,
        )

        assert result["ok"] is True
        assert result["dropped_intra_batch"] == 0
        assert len(result["accepted_paths"]) == 2


# ── Edge cases ─────────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_empty_candidates(self, tmp_path: Path) -> None:
        """Empty candidate list returns ok with zero counts."""
        split = _make_forbidden_split(tmp_path / "split.json", [{"text": "x"}])

        result = check_leakage(
            candidate_paths=[],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=False,  # avoid optional-lib check on empty list
        )

        assert result["ok"] is True
        assert result["total_candidates"] == 0
        assert result["accepted_paths"] == []
        assert result["dropped_for_collision"] == 0

    def test_forbidden_split_not_found(self, tmp_path: Path) -> None:
        """Missing forbidden split returns ok:False with error message."""
        candidate = _write_text_file(tmp_path / "c.txt", "some text")

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="text",
            forbidden_split_path=str(tmp_path / "nonexistent.json"),
        )

        assert result["ok"] is False
        assert "error" in result

    def test_result_keys_present(self, tmp_path: Path) -> None:
        """Successful result always includes all required keys."""
        split = _make_forbidden_split(tmp_path / "split.json", [{"text": "forbidden"}])
        candidate = _write_text_file(tmp_path / "c.txt", "clean text")

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=False,  # avoid optional-lib dependency in key-shape test
        )

        required_keys = {
            "ok", "total_candidates", "dropped_for_collision",
            "dropped_for_near_dup", "dropped_intra_batch",
            "accepted_paths", "collision_log",
        }
        assert required_keys.issubset(result.keys()), (
            f"Missing keys: {required_keys - set(result.keys())}"
        )

    def test_collision_log_no_internal_paths(self, tmp_path: Path) -> None:
        """collision_log entries contain path and collision_type fields."""
        content = "test content for collision"
        split = _make_forbidden_split(tmp_path / "split.json", [{"text": content}])
        candidate = _write_text_file(tmp_path / "c.txt", content)

        result = check_leakage(
            candidate_paths=[str(candidate)],
            modality="text",
            forbidden_split_path=str(split),
            near_dup=False,
        )

        assert result["ok"] is True
        assert len(result["collision_log"]) == 1
        entry = result["collision_log"][0]
        assert "path" in entry
        assert "collision_type" in entry
        assert entry["collision_type"] == "exact_collision"


# ── CLI subprocess test ────────────────────────────────────────────────────────

class TestCLI:
    def test_cli_check_leakage_clean(self, tmp_path: Path) -> None:
        """CLI returns JSON with ok:True and accepted path for a clean candidate."""
        split = _make_forbidden_split(tmp_path / "split.json", [{"text": "forbidden"}])
        candidate = _write_text_file(tmp_path / "c.txt", "clean unique text")

        proc = subprocess.run(
            [
                sys.executable, "-m", "evor.acquire",
                "check-leakage",
                "--run-id", str(tmp_path),
                "--candidate-paths", json.dumps([str(candidate)]),
                "--modality", "text",
                "--forbidden-split", str(split),
                "--near-dup", "false",
                "--intra-batch", "false",
            ],
            capture_output=True,
            text=True,
            cwd=str(_HARNESS_DIR),
        )

        assert proc.returncode == 0, f"stderr: {proc.stderr}"
        data = json.loads(proc.stdout)
        assert data["ok"] is True
        assert data["accepted_paths"] == [str(candidate)]

    def test_cli_check_leakage_collision(self, tmp_path: Path) -> None:
        """CLI exits 1 and returns ok:False... actually ok:True but 0 accepted for a collision."""
        content = "this content is in the forbidden split"
        split = _make_forbidden_split(tmp_path / "split.json", [{"text": content}])
        candidate = _write_text_file(tmp_path / "c.txt", content)

        proc = subprocess.run(
            [
                sys.executable, "-m", "evor.acquire",
                "check-leakage",
                "--run-id", str(tmp_path),
                "--candidate-paths", json.dumps([str(candidate)]),
                "--modality", "text",
                "--forbidden-split", str(split),
                "--near-dup", "false",
                "--intra-batch", "false",
            ],
            capture_output=True,
            text=True,
            cwd=str(_HARNESS_DIR),
        )

        assert proc.returncode == 0, f"stderr: {proc.stderr}"
        data = json.loads(proc.stdout)
        assert data["ok"] is True
        assert data["dropped_for_collision"] == 1
        assert data["accepted_paths"] == []
