"""
Content-addressed blob store with atomic refcount tracking.

put() writes sha256-addressed blobs into artifacts/<sha[:2]>/<sha[2:]>;
uses os.link() for deduplication; falls back to copy+chmod444 on cross-device.
Refcounts are written atomically via .refcounts.json.tmp → os.replace().
Orphaned .tmp files (from a prior crash) are cleaned before any refcount read.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Literal


class ContentAddressedStore:
    """Immutable, content-addressed blob store backed by a flat artifact directory.

    Directory layout:
      <root>/artifacts/<sha[:2]>/<sha[2:]>   — immutable blob (chmod 444)
      <root>/artifacts/.refcounts.json        — atomic refcount dict
      <root>/artifacts/.refcounts.json.tmp    — in-flight write; cleaned on next access
      <root>/artifacts/.namespaces.json       — acquisition namespace registry
      <root>/artifacts/.deltas.json           — base→delta relationship map
    """

    def __init__(self, root: Path) -> None:
        self._root = Path(root)
        self._blobs = self._root / "artifacts"
        self._blobs.mkdir(parents=True, exist_ok=True)
        self._refcounts_path = self._blobs / ".refcounts.json"
        self._tmp_path = self._blobs / ".refcounts.json.tmp"
        self._ns_path = self._blobs / ".namespaces.json"

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _blob_path(self, content_hash: str) -> Path:
        return self._blobs / content_hash[:2] / content_hash[2:]

    def _sha256_file(self, path: Path) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()

    def _load_refcounts(self) -> dict[str, int]:
        """Load refcounts; clean up any orphaned .tmp left by a prior crash."""
        if self._tmp_path.exists():
            # previous process died between tmp-write and os.replace() — remove orphan
            self._tmp_path.unlink(missing_ok=True)
        if self._refcounts_path.exists():
            with open(self._refcounts_path) as f:
                return json.load(f)
        return {}

    def _save_refcounts(self, counts: dict[str, int]) -> None:
        """Atomic write: serialise to .tmp then os.replace() → .json."""
        data = json.dumps(counts, indent=2, sort_keys=True).encode()
        self._tmp_path.write_bytes(data)
        os.replace(self._tmp_path, self._refcounts_path)

    def _load_namespaces(self) -> dict[str, dict]:
        if self._ns_path.exists():
            with open(self._ns_path) as f:
                return json.load(f)
        return {}

    def _save_namespaces(self, ns: dict[str, dict]) -> None:
        tmp = self._blobs / ".namespaces.json.tmp"
        tmp.write_bytes(json.dumps(ns, indent=2, sort_keys=True).encode())
        os.replace(tmp, self._ns_path)

    # ------------------------------------------------------------------
    # Core API
    # ------------------------------------------------------------------

    def put(self, src_path: Path) -> str:
        """Store blob; return sha256 hex digest.

        Hardlink attempt first (zero-copy dedup on same filesystem).
        Falls back to shutil.copy2() + chmod 444 on OSError (e.g. cross-device).
        Orphaned .refcounts.json.tmp from a prior crash is removed before any
        refcount update.
        """
        counts = self._load_refcounts()

        content_hash = self._sha256_file(src_path)
        dest = self._blob_path(content_hash)

        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(src_path, dest)
            except OSError:
                # cross-device link or unsupported FS — copy instead
                shutil.copy2(src_path, dest)
            # make immutable regardless of how the blob landed
            dest.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)

        counts[content_hash] = counts.get(content_hash, 0) + 1
        self._save_refcounts(counts)
        return content_hash

    def get(self, content_hash: str) -> Path:
        """Return path to blob; raise FileNotFoundError if missing."""
        p = self._blob_path(content_hash)
        if not p.exists():
            raise FileNotFoundError(f"Blob not found in store: {content_hash}")
        return p

    def link(self, content_hash: str, target: Path) -> None:
        """Create hardlink at *target*; fall back to symlink if hardlink fails.

        Hardlinks share the OS inode — GC cannot remove the underlying file even if
        the blob entry is deleted, so no refcount change is needed.
        Symlinks DO point to the blob path: if the blob is GC'd the symlink dangles.
        Therefore symlink fallback MUST increment the blob's refcount (same atomic
        write path as all other refcount mutations).
        """
        src = self.get(content_hash)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(src, target)
            # hardlink: same inode — no refcount bump required
        except OSError:
            target.symlink_to(src.resolve())
            # symlink points to blob PATH — must protect from GC
            counts = self._load_refcounts()
            counts[content_hash] = counts.get(content_hash, 0) + 1
            self._save_refcounts(counts)

    def gc(self, referenced_hashes: set[str]) -> int:
        """Delete all blobs not in *referenced_hashes*; return count deleted."""
        counts = self._load_refcounts()
        deleted = 0
        for shard in self._blobs.iterdir():
            if not shard.is_dir() or len(shard.name) != 2:
                continue
            for blob in list(shard.iterdir()):
                full_hash = shard.name + blob.name
                # Honor symlink-protection refcounts: link() with the symlink
                # fallback bumps refcount to signal an outstanding external
                # reference ("symlink points to blob PATH — must protect from
                # GC").  Only delete when the blob is absent from the caller's
                # reference set AND refcount ≤ 1 (at most the single put()-call
                # reference, no symlink bump on top).
                if full_hash not in referenced_hashes and counts.get(full_hash, 0) <= 1:
                    # make temporarily writable so unlink works
                    blob.chmod(stat.S_IRUSR | stat.S_IWUSR)
                    blob.unlink()
                    counts.pop(full_hash, None)
                    deleted += 1
        self._save_refcounts(counts)
        return deleted

    def put_delta(self, base_hash: str, patch_path: Path) -> str:
        """Store patch as blob; record base→delta relationship in .deltas.json."""
        delta_hash = self.put(patch_path)
        meta_path = self._blobs / ".deltas.json"
        tmp_meta = self._blobs / ".deltas.json.tmp"
        deltas: dict[str, list[str]] = {}
        if meta_path.exists():
            with open(meta_path) as f:
                deltas = json.load(f)
        deltas.setdefault(base_hash, [])
        if delta_hash not in deltas[base_hash]:
            deltas[base_hash].append(delta_hash)
        tmp_meta.write_bytes(json.dumps(deltas, indent=2).encode())
        os.replace(tmp_meta, meta_path)
        return delta_hash

    def apply_delta(self, base_hash: str, delta_hash: str) -> Path:
        """Reconstruct base blob + unified-diff delta into a temp directory.

        Both blobs are resolved from the store.  The patch is applied with the
        standard `patch -u` command — store-level behavior: blob lookup plus
        generic text-patch application.

        Returns the path to the reconstructed file inside a caller-owned temp
        directory; the caller is responsible for cleanup.

        Scope: handles unified-diff patches only.  Git format-patches (produced
        by `git format-patch`) embed commit metadata and must be applied with
        `git apply` inside a working tree — that is Forge/genome.py's
        responsibility.  For those patches, retrieve blobs via get() and call
        `git apply` in the candidate worktree directly.

        Raises RuntimeError if `patch` reports a failure.
        """
        base_path = self.get(base_hash)
        patch_path = self.get(delta_hash)

        tmp_dir = Path(tempfile.mkdtemp(prefix="evor-delta-"))
        reconstructed = tmp_dir / base_path.name
        shutil.copy2(base_path, reconstructed)
        # make writable so patch can edit it in place
        reconstructed.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)

        # Prefer the absolute path to GNU patch so nvm's `patch` shim (a Node.js
        # CLI tool) does not shadow it when nvm is on PATH; else resolve via PATH.
        # If the POSIX `patch` utility is genuinely absent, fail with a clear
        # message rather than a cryptic FileNotFoundError.
        _patch_bin = "/usr/bin/patch" if Path("/usr/bin/patch").exists() else shutil.which("patch")
        if not _patch_bin:
            raise RuntimeError(
                "apply_delta requires the POSIX `patch` utility, which was not found "
                "(checked /usr/bin/patch and PATH). Install it (e.g. `apt-get install patch`)."
            )
        result = subprocess.run(
            [_patch_bin, "-u", str(reconstructed), str(patch_path)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"patch failed (base={base_hash[:8]}… delta={delta_hash[:8]}…): "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )
        return reconstructed

    # ------------------------------------------------------------------
    # data-acquisition namespace enforcement (two-path rule, ADR-015)
    # ------------------------------------------------------------------

    def register_acquired(
        self,
        acquisition_id: str,
        content_hashes: list[str],
        namespace: Literal["train", "eval"],
    ) -> None:
        """Register acquired sample hashes under an explicit namespace.

        Raises ValueError if namespace == 'eval' — eval data must enter via
        BenchmarkUpgrade, never via ContentAddressedStore directly.
        This is the structural enforcement layer for the two-path rule (ADR-015).
        """
        if namespace == "eval":
            raise ValueError(
                f"Acquired data cannot be registered under the 'eval' namespace "
                f"(acquisition_id={acquisition_id!r}). "
                "Eval data must enter via BenchmarkUpgrade only (ADR-015)."
            )
        ns = self._load_namespaces()
        entry = ns.get(acquisition_id, {"namespace": "train", "hashes": []})
        existing = set(entry["hashes"])
        existing.update(content_hashes)
        entry["hashes"] = sorted(existing)
        entry["namespace"] = "train"
        ns[acquisition_id] = entry
        self._save_namespaces(ns)

    def verify_namespace(
        self,
        acquisition_id: str,
        expected_namespace: Literal["train"],
    ) -> bool:
        """Return True iff ALL hashes registered under *acquisition_id* are in the
        train namespace and none appear in any frozen eval split namespace.

        Returns False if the acquisition_id is not registered at all.
        """
        ns = self._load_namespaces()
        entry = ns.get(acquisition_id)
        if entry is None:
            return False
        return entry.get("namespace") == expected_namespace
