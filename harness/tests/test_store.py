"""
Unit tests for ContentAddressedStore (harness/evor/store.py).

Covers:
  - put/get roundtrip
  - hardlink dedup (two identical files → same hash, one blob)
  - gc() removes unreferenced blobs
  - delta roundtrip (put_delta stores patch as blob + links base)
  - test_refcount_crash_safety: orphaned .tmp cleaned on next put()
  - test_cross_device_fallback: simulated cross-device (os.link raises OSError)
  - test_symlink_refcount: symlink fallback increments blob refcount
  - test_namespace_eval_rejected: register_acquired with namespace='eval' raises
  - test_namespace_train_roundtrip: register_acquired + verify_namespace happy path
"""

from __future__ import annotations

import os
import stat
from pathlib import Path
from unittest.mock import patch

import pytest

from evor.store import ContentAddressedStore


@pytest.fixture
def store(tmp_path: Path) -> ContentAddressedStore:
    return ContentAddressedStore(tmp_path)


def _write_file(path: Path, content: bytes) -> Path:
    path.write_bytes(content)
    return path


# ─────────────────────────────────────────────────────────────────────────────
# put / get
# ─────────────────────────────────────────────────────────────────────────────


def test_put_get_roundtrip(store: ContentAddressedStore, tmp_path: Path) -> None:
    src = _write_file(tmp_path / "a.bin", b"hello world")
    h = store.put(src)
    assert len(h) == 64  # sha256 hex
    blob = store.get(h)
    assert blob.read_bytes() == b"hello world"


def test_get_missing_raises(store: ContentAddressedStore) -> None:
    with pytest.raises(FileNotFoundError):
        store.get("a" * 64)


def test_blob_is_readonly_after_put(store: ContentAddressedStore, tmp_path: Path) -> None:
    src = _write_file(tmp_path / "b.bin", b"readonly-test")
    h = store.put(src)
    blob = store.get(h)
    mode = blob.stat().st_mode
    assert not (mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))


# ─────────────────────────────────────────────────────────────────────────────
# Hardlink dedup
# ─────────────────────────────────────────────────────────────────────────────


def test_hardlink_dedup_same_content(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    """Two files with identical content → same hash; only one blob on disk."""
    content = b"duplicate content"
    src1 = _write_file(tmp_path / "dup1.bin", content)
    src2 = _write_file(tmp_path / "dup2.bin", content)
    h1 = store.put(src1)
    h2 = store.put(src2)
    assert h1 == h2
    # Refcount should be 2
    import json
    counts = json.loads((store._blobs / ".refcounts.json").read_text())
    assert counts[h1] == 2


def test_different_content_different_hashes(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    src1 = _write_file(tmp_path / "x.bin", b"aaa")
    src2 = _write_file(tmp_path / "y.bin", b"bbb")
    h1 = store.put(src1)
    h2 = store.put(src2)
    assert h1 != h2


# ─────────────────────────────────────────────────────────────────────────────
# GC
# ─────────────────────────────────────────────────────────────────────────────


def test_gc_removes_unreferenced(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    src_a = _write_file(tmp_path / "a.bin", b"keep me")
    src_b = _write_file(tmp_path / "b.bin", b"delete me")
    ha = store.put(src_a)
    hb = store.put(src_b)

    deleted = store.gc(referenced_hashes={ha})
    assert deleted == 1
    assert store.get(ha).exists()
    with pytest.raises(FileNotFoundError):
        store.get(hb)


def test_gc_empty_referenced_deletes_all(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    src = _write_file(tmp_path / "a.bin", b"gone")
    h = store.put(src)
    deleted = store.gc(referenced_hashes=set())
    assert deleted == 1
    with pytest.raises(FileNotFoundError):
        store.get(h)


# ─────────────────────────────────────────────────────────────────────────────
# Delta (put_delta)
# ─────────────────────────────────────────────────────────────────────────────


def test_put_delta_returns_hash(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    base_file = _write_file(tmp_path / "base.bin", b"base content")
    patch_file = _write_file(tmp_path / "patch.diff", b"patch content")
    base_hash = store.put(base_file)
    delta_hash = store.put_delta(base_hash, patch_file)
    assert len(delta_hash) == 64
    assert store.get(delta_hash).read_bytes() == b"patch content"


def test_apply_delta_roundtrip(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    """apply_delta reconstructs a file from base + unified-diff patch."""
    import subprocess as _sp

    base_content = b"line one\nline two\nline three\n"
    modified_content = b"line one\nline TWO (changed)\nline three\n"

    base_file = _write_file(tmp_path / "base.txt", base_content)
    modified_file = tmp_path / "modified.txt"
    modified_file.write_bytes(modified_content)

    # Produce a unified diff; diff exits 1 when files differ (expected)
    diff_result = _sp.run(
        ["diff", "-u", str(base_file), str(modified_file)],
        capture_output=True,
        text=True,
    )
    patch_file = _write_file(tmp_path / "change.patch", diff_result.stdout.encode())

    base_hash = store.put(base_file)
    delta_hash = store.put_delta(base_hash, patch_file)

    reconstructed = store.apply_delta(base_hash, delta_hash)
    assert reconstructed.read_bytes() == modified_content


def test_apply_delta_bad_patch_raises(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    """apply_delta raises RuntimeError when the patch does not apply cleanly."""
    base_file = _write_file(tmp_path / "base.txt", b"hello\n")
    bad_patch = _write_file(
        tmp_path / "bad.patch",
        b"--- a/base.txt\n+++ b/base.txt\n@@ -99,1 +99,1 @@\n-nonexistent\n+replacement\n",
    )
    base_hash = store.put(base_file)
    delta_hash = store.put_delta(base_hash, bad_patch)

    with pytest.raises(RuntimeError, match="patch failed"):
        store.apply_delta(base_hash, delta_hash)


# ─────────────────────────────────────────────────────────────────────────────
# Crash safety: orphaned .tmp
# ─────────────────────────────────────────────────────────────────────────────


def test_refcount_crash_safety(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    """Simulate crash between .tmp write and os.replace(); next put() heals."""
    src_a = _write_file(tmp_path / "first.bin", b"first")
    h_a = store.put(src_a)  # refcounts.json now has {h_a: 1}

    # Simulate crash: write garbage into the tmp file, leave it on disk
    store._tmp_path.write_bytes(b'{"corrupted": true}')
    assert store._tmp_path.exists()

    # Next put() must remove the orphaned .tmp and still work correctly
    src_b = _write_file(tmp_path / "second.bin", b"second")
    h_b = store.put(src_b)

    # .tmp must be gone
    assert not store._tmp_path.exists()
    # Both blobs accessible
    assert store.get(h_a).read_bytes() == b"first"
    assert store.get(h_b).read_bytes() == b"second"

    # Refcounts consistent
    import json
    counts = json.loads(store._refcounts_path.read_text())
    assert counts[h_a] == 1
    assert counts[h_b] == 1


# ─────────────────────────────────────────────────────────────────────────────
# Cross-device fallback (simulated)
# ─────────────────────────────────────────────────────────────────────────────


def test_cross_device_fallback(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    """When os.link raises OSError, store falls back to copy; blob still accessible."""
    src = _write_file(tmp_path / "cross.bin", b"cross-device content")
    with patch("evor.store.os.link", side_effect=OSError("cross-device link")):
        h = store.put(src)

    blob = store.get(h)
    assert blob.read_bytes() == b"cross-device content"
    # chmod 444 was applied via the copy path
    mode = blob.stat().st_mode
    assert not (mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))


# ─────────────────────────────────────────────────────────────────────────────
# link() — symlink fallback increments refcount
# ─────────────────────────────────────────────────────────────────────────────


def test_symlink_refcount(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    """Symlink fallback in link() increments blob refcount identically to put()."""
    src = _write_file(tmp_path / "blobfile.bin", b"link me")
    h = store.put(src)

    import json
    counts_before = json.loads(store._refcounts_path.read_text())
    assert counts_before[h] == 1

    target = tmp_path / "linked_target"
    # Force symlink path by making os.link raise
    with patch("evor.store.os.link", side_effect=OSError("no hardlink")):
        store.link(h, target)

    assert target.is_symlink() or target.exists()
    counts_after = json.loads(store._refcounts_path.read_text())
    assert counts_after[h] == 2  # symlink bumped refcount


def test_hardlink_does_not_bump_refcount(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    """Hardlink in link() does NOT increment refcount (OS-level inode safety)."""
    src = _write_file(tmp_path / "hardlink.bin", b"hard link me")
    h = store.put(src)

    import json
    counts_before = json.loads(store._refcounts_path.read_text())
    assert counts_before[h] == 1

    target = tmp_path / "hl_target"
    store.link(h, target)  # should hardlink succeed on tmp_path same device

    counts_after = json.loads(store._refcounts_path.read_text())
    # refcount must NOT have increased — same inode
    assert counts_after[h] == 1


# ─────────────────────────────────────────────────────────────────────────────
# Namespace enforcement (two-path rule, ADR-015)
# ─────────────────────────────────────────────────────────────────────────────


def test_namespace_eval_rejected(store: ContentAddressedStore) -> None:
    """register_acquired with namespace='eval' raises ValueError."""
    with pytest.raises(ValueError, match="eval"):
        store.register_acquired(
            acquisition_id="acq-001",
            content_hashes=["a" * 64],
            namespace="eval",
        )


def test_namespace_train_roundtrip(store: ContentAddressedStore) -> None:
    """register_acquired + verify_namespace happy path."""
    store.register_acquired(
        acquisition_id="acq-train-01",
        content_hashes=["b" * 64, "c" * 64],
        namespace="train",
    )
    assert store.verify_namespace("acq-train-01", "train") is True


def test_verify_namespace_unregistered_returns_false(
    store: ContentAddressedStore,
) -> None:
    assert store.verify_namespace("acq-nonexistent", "train") is False


def test_namespace_accumulates_hashes(store: ContentAddressedStore) -> None:
    """Multiple register_acquired calls for same acquisition_id accumulate hashes."""
    store.register_acquired("acq-multi", ["d" * 64], "train")
    store.register_acquired("acq-multi", ["e" * 64], "train")
    assert store.verify_namespace("acq-multi", "train") is True
    import json
    ns = json.loads(store._ns_path.read_text())
    assert len(ns["acq-multi"]["hashes"]) == 2


# ─────────────────────────────────────────────────────────────────────────────
# BUG-1: gc() ignores symlink refcounts — symlink-protected blobs deleted
# ─────────────────────────────────────────────────────────────────────────────


def test_gc_respects_symlink_refcount(
    store: ContentAddressedStore, tmp_path: Path
) -> None:
    """gc() must not delete a blob whose refcount was bumped by a symlink link().

    Root cause: link() increments the blob's refcount to signal an outstanding
    symlink reference ("must protect from GC" per the comment in link()), but
    gc() ignores refcounts entirely and deletes every blob not in
    referenced_hashes, causing the symlink to dangle.

    Fix: gc() must skip deletion when counts.get(full_hash, 0) > 1 (i.e. the
    blob has an outstanding symlink reference beyond the single put() call).
    """
    src = _write_file(tmp_path / "sym_protected.bin", b"symlink-protected data")
    h = store.put(src)  # refcount = 1

    target = tmp_path / "link_to_blob"
    with patch("evor.store.os.link", side_effect=OSError("cross-device")):
        store.link(h, target)  # symlink fallback — refcount bumped to 2

    import json
    counts = json.loads(store._refcounts_path.read_text())
    assert counts[h] == 2, "symlink path must bump refcount to 2"

    # gc() with no referenced_hashes must NOT delete the symlink-protected blob
    deleted = store.gc(referenced_hashes=set())

    assert deleted == 0, (
        "gc() deleted a blob with refcount=2 (outstanding symlink reference); "
        "symlink is now dangling"
    )
    assert store.get(h).exists(), "blob must survive gc() while symlink-referenced"
    assert target.read_bytes() == b"symlink-protected data", (
        "symlink must not dangle after gc()"
    )
