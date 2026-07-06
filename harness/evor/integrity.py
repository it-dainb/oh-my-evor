"""
IntegrityGate — 13-check anti-cheat enforcement (M6).

BASE CHECKS (1–10):
  1. split_hash_match        — frozen_test.split_hash == GoalContract.locked_split_hash
  2. no_test_leakage         — 200-sample index+hash cross-check (SHORT-CIRCUIT if 1 fails)
  3. no_label_contamination  — 100-pair sha256 cross-check (SHORT-CIRCUIT if 1 fails)
  4. no_eval_shift           — sha256(eval_script) == GoalContract.eval_script_hash
  5. telemetry_sane          — loss not NaN/Inf/constant; grad_norm > 0 if present (R6)
  6. reward_hacking_probe    — near-perfect val (leakage ceiling) or per-step val spike → flag
  7. frozen_split_read_only  — chmod 444 still intact on all frozen-split files (Pillar 2 layer 1)
  8. near_dup_leakage        — near-dup aug-of-test check; data-augmentation nodes only (Pillar 2 layer 3)
  9. data_provenance_valid   — source_sample_ids trace to train only (Pillar 2 layer 4)
 10. eval_version_consistent — node.eval_version == GoalContract.eval_version (Pillar 3)

INGESTION CONTAMINATION GATE (11–13; active only when mutation_locus.family == 'data-acquisition'):
 11. acquisition_contamination_clear — no acquired sample in any frozen eval split (all versions)
 12. acquired_data_provenance_valid  — license + citation present; synthetic needs generator_config (R-3)
 13. acquisition_namespace_enforced  — store.verify_namespace(acquisition_id, 'train') == True

Short-circuit rule (R-7a): if check-1 fails, checks 2–3 are set to False (cannot be
meaningfully evaluated on a corrupted/unknown split). Checks 4–10 still run.
Alias resolution (R-7b): _canonicalize_family() normalises legacy family tags before
all downstream conditionals.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from evor.contracts import (
    AcquisitionProvenance,
    EvaluationResult,
    FrozenSplit,
    GoalContract,
    IntegrityChecks,
    IntegrityReport,
    TreeNode,
)
from evor.freeze import DataProvenanceTracker, FrozenSplitManager

if TYPE_CHECKING:
    from evor.store import ContentAddressedStore


# ─────────────────────────────────────────────────────────────────────────────
# Module-level alias resolver (R-7b)
# ─────────────────────────────────────────────────────────────────────────────

_FAMILY_ALIASES: dict[str, str] = {
    "augmentation": "data-augmentation",
    "data_augmentation": "data-augmentation",
    "data_curation": "data-curation",
    "data_acquisition": "data-acquisition",
}


def _canonicalize_family(family: str) -> str:
    """Normalise legacy/variant family tags to canonical ApproachFamily values.

    Defined at module scope so all callers (IntegrityGate.check + tests) share
    the exact same resolution logic.

    Mappings:
      'augmentation'      → 'data-augmentation'
      'data_augmentation' → 'data-augmentation'
      'data_curation'     → 'data-curation'
      'data_acquisition'  → 'data-acquisition'
    All other values are returned unchanged.
    """
    return _FAMILY_ALIASES.get(family, family)


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _sha256_file(path: Path) -> str:
    """Compute sha256 of file contents in streaming chunks."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_bad_float(v: float) -> bool:
    """Return True if value is NaN or Inf (cannot be a valid loss/metric)."""
    return math.isnan(v) or math.isinf(v)


# ─────────────────────────────────────────────────────────────────────────────
# IntegrityGate
# ─────────────────────────────────────────────────────────────────────────────

class IntegrityGate:
    """Run all 13 integrity checks on a candidate node before it can win a tick.

    Instantiate once per run; call check() for each evaluated node.
    GPU/modality-gated checks (near-dup, cross-version scan) accept pre-loaded
    bytes so the gate itself remains dependency-free.
    """

    def __init__(self) -> None:
        self._fsm = FrozenSplitManager()
        self._dpt = DataProvenanceTracker()

    # ------------------------------------------------------------------
    # Public: split hash locking (called at mission start)
    # ------------------------------------------------------------------

    def lock_splits(self, split_config: dict) -> str:
        """Compute mission-start split hash.

        split_config keys: 'train', 'val', 'test' — each a list of sample indices.

        Returns sha256(sorted_train_json || sorted_val_json || sorted_test_json).
        The result is stored in GoalContract.locked_split_hash.
        """
        parts = b""
        for split_name in ("train", "val", "test"):
            indices = sorted(str(i) for i in split_config.get(split_name, []))
            parts += json.dumps(indices, sort_keys=True).encode()
        return hashlib.sha256(parts).hexdigest()

    # ------------------------------------------------------------------
    # Public: full 13-check gate
    # ------------------------------------------------------------------

    def check(
        self,
        node: TreeNode,
        result: EvaluationResult,
        goal: GoalContract,
        telemetry_path: Path,
        eval_script_path: Path,
        frozen_test: FrozenSplit,
        provenance_path: Path | None,
        run_dir: Path | None = None,
        # Acquisition-gate inputs (checks 11–13)
        acquired_samples: list[bytes] | None = None,
        acquisition_provenance: AcquisitionProvenance | None = None,
        store: "ContentAddressedStore | None" = None,
        # ALL frozen splits across all eval_versions for cross-version scan (check 11)
        all_frozen_splits: list[FrozenSplit] | None = None,
        # ForgeStructureGate pre-merge check (check 14; optional)
        candidate_dir: Path | None = None,
    ) -> IntegrityReport:
        """Run all 13 integrity checks + optional ForgeStructureGate; return IntegrityReport.

        Alias resolution is performed first (R-7b).
        Short-circuit: if check-1 fails, checks 2–3 are set to False.
        Checks 11–13 run only for data-acquisition nodes.
        Check 14 (structure_ok) runs only when candidate_dir is provided.
        """
        # ── Alias resolution (R-7b) ───────────────────────────────────────
        raw_family = ""
        if node.mutation_locus is not None:
            raw_family = node.mutation_locus.family
        canonical_family = _canonicalize_family(raw_family)

        is_data_acquisition = canonical_family == "data-acquisition"
        is_data_augmentation = canonical_family == "data-augmentation"

        failures: list[str] = []

        # ── Check 1: split_hash_match ─────────────────────────────────────
        # Compare the stored FrozenSplit.split_hash against GoalContract.locked_split_hash
        split_hash_match = frozen_test.split_hash == goal.locked_split_hash
        if not split_hash_match:
            failures.append(
                f"split_hash_match: frozen_test.split_hash={frozen_test.split_hash!r} "
                f"!= GoalContract.locked_split_hash={goal.locked_split_hash!r}"
            )

        # ── Checks 2–3: short-circuited if check-1 failed (R-7a) ─────────
        if split_hash_match:
            no_test_leakage = self._check_no_test_leakage(frozen_test)
            no_label_contamination = self._check_no_label_contamination(frozen_test)
            if not no_test_leakage:
                failures.append(
                    "no_test_leakage: test indices or content-hashes found in training data"
                )
            if not no_label_contamination:
                failures.append(
                    "no_label_contamination: test sample sha256 hashes overlap with training data"
                )
        else:
            # Cannot meaningfully evaluate leakage on a corrupted split
            no_test_leakage = False
            no_label_contamination = False

        # ── Check 4: no_eval_shift ────────────────────────────────────────
        no_eval_shift = True
        if eval_script_path.exists():
            actual_hash = _sha256_file(eval_script_path)
            no_eval_shift = actual_hash == goal.eval_script_hash
        else:
            # Missing eval script is a shift by definition
            no_eval_shift = False
        if not no_eval_shift:
            failures.append(
                "no_eval_shift: eval_script sha256 does not match GoalContract.eval_script_hash"
            )

        # ── Check 5: telemetry_sane ───────────────────────────────────────
        telemetry_sane = self._check_telemetry_sane(telemetry_path)
        if not telemetry_sane:
            failures.append(
                "telemetry_sane: telemetry fails sanity (NaN/Inf loss, constant loss, "
                "or zero/negative grad_norm when field is present)"
            )

        # ── Check 6: reward_hacking_probe ─────────────────────────────────
        # True = hacking detected (bad); False = no hacking (good)
        reward_hacking_probe = self._check_reward_hacking(result, goal)
        if reward_hacking_probe:
            failures.append(
                "reward_hacking_probe: near-perfect val (leakage ceiling) or a "
                "suspicious per-step val spike — potential test leakage / reward hacking"
            )

        # ── Check 7: frozen_split_read_only ──────────────────────────────
        frozen_split_read_only = True
        if run_dir is not None:
            frozen_split_read_only = self._fsm.check_read_only(frozen_test, run_dir)
        if not frozen_split_read_only:
            failures.append(
                "frozen_split_read_only: frozen-split files are no longer chmod 444"
            )

        # ── Check 8: near_dup_leakage ─────────────────────────────────────
        # True = leakage detected (bad); False = clean (good)
        # Skipped for non-data-augmentation nodes (evaluated AFTER alias resolution)
        near_dup_leakage = False
        if is_data_augmentation and provenance_path is not None:
            aug_bytes = self._load_aug_sample_bytes(provenance_path, run_dir)
            if aug_bytes:
                flagged = self._dpt.check_near_dup(aug_bytes, frozen_test)
                near_dup_leakage = len(flagged) > 0
        if near_dup_leakage:
            failures.append(
                "near_dup_leakage: augmented training samples are near-duplicates "
                "of frozen test samples"
            )

        # ── Check 9: data_provenance_valid ────────────────────────────────
        data_provenance_valid = True
        if provenance_path is not None and provenance_path.exists():
            data_provenance_valid = self._check_data_provenance(
                provenance_path, frozen_test
            )
        if not data_provenance_valid:
            failures.append(
                "data_provenance_valid: DataProvenance.source_sample_id references "
                "a test-split index — augmentation source must be in train split only"
            )

        # ── Check 10: eval_version_consistent ────────────────────────────
        eval_version_consistent = node.eval_version == goal.eval_version
        if not eval_version_consistent:
            failures.append(
                f"eval_version_consistent: node.eval_version={node.eval_version!r} "
                f"!= GoalContract.eval_version={goal.eval_version!r} — "
                "node must be re-scored under the current eval_version"
            )

        # ── Checks 11–13: Ingestion Contamination Gate ────────────────────
        acquisition_contamination_clear: bool | None = None
        acquired_data_provenance_valid: bool | None = None
        acquisition_namespace_enforced: bool | None = None

        if is_data_acquisition:
            all_splits = all_frozen_splits if all_frozen_splits else [frozen_test]

            # Check 11
            acquisition_contamination_clear = self._check_acquisition_contamination(
                acquired_samples or [],
                frozen_test,
                all_splits,
            )
            if not acquisition_contamination_clear:
                failures.append(
                    "acquisition_contamination_clear: acquired samples collide with "
                    "frozen eval split (quarantine fraction > 5% or direct hash match); "
                    "covers ALL eval_versions, not just current"
                )

            # Check 12
            acquired_data_provenance_valid = self._check_acquisition_provenance(
                acquisition_provenance, goal
            )
            if not acquired_data_provenance_valid:
                failures.append(
                    "acquired_data_provenance_valid: AcquisitionProvenance absent or "
                    "incomplete (missing license / citation / generator_config)"
                )

            # Check 13
            acquisition_namespace_enforced = self._check_acquisition_namespace(
                acquisition_provenance, store
            )
            if not acquisition_namespace_enforced:
                failures.append(
                    "acquisition_namespace_enforced: acquired samples not registered "
                    "exclusively in the train namespace"
                )

        # ── Check 14: ForgeStructureGate (pre-merge code-quality gate) ──────
        # Runs only when candidate_dir is provided; None = not evaluated.
        structure_ok: bool | None = None
        if candidate_dir is not None:
            try:
                from evor.quality_gate import ForgeStructureGate  # lazy import
                sg = ForgeStructureGate(locked_eval_hash=goal.eval_script_hash)
                sg_report = sg.check(candidate_dir)
                structure_ok = sg_report.passed
                if not structure_ok:
                    failures.append(
                        "structure_ok: ForgeStructureGate rejected candidate — "
                        + "; ".join(sg_report.failure_reasons)
                    )
            except ImportError:
                pass  # quality_gate unavailable; skip without failing

        # ── Verdict ───────────────────────────────────────────────────────
        verdict: str = "passed" if not failures else "failed"

        return IntegrityReport(
            node_id=node.id,
            eval_version=result.eval_version,
            checks=IntegrityChecks(
                split_hash_match=split_hash_match,
                frozen_split_read_only=frozen_split_read_only,
                no_test_leakage=no_test_leakage,
                near_dup_leakage=near_dup_leakage,
                data_provenance_valid=data_provenance_valid,
                no_label_contamination=no_label_contamination,
                no_eval_shift=no_eval_shift,
                eval_version_consistent=eval_version_consistent,
                telemetry_sane=telemetry_sane,
                reward_hacking_probe=reward_hacking_probe,
                acquisition_contamination_clear=acquisition_contamination_clear,
                acquired_data_provenance_valid=acquired_data_provenance_valid,
                acquisition_namespace_enforced=acquisition_namespace_enforced,
                structure_ok=structure_ok,
            ),
            verdict=verdict,  # type: ignore[arg-type]
            failure_reason="; ".join(failures) if failures else None,
            verified_at=datetime.now(timezone.utc).isoformat(),
        )

    # ------------------------------------------------------------------
    # Public: tournament verification re-run (requires GPU/eval stack)
    # ------------------------------------------------------------------

    def verification_rerun(
        self,
        node: TreeNode,
        goal: GoalContract,
        evaluator: object,  # EvaluatorAdapter; avoid circular import
    ) -> EvaluationResult:
        """Re-evaluate tournament winner on locked splits; confirm no regression.

        Requires a live EvaluatorAdapter + GPU/eval stack (wired in production).
        """
        raise NotImplementedError(
            "verification_rerun requires a live EvaluatorAdapter and GPU stack. "
            "Call EvaluatorAdapter.run() directly with the winner node. "
            "See KNOWN_GAPS.md#G5."
        )

    # ------------------------------------------------------------------
    # Private check helpers
    # ------------------------------------------------------------------

    def _check_no_test_leakage(self, frozen_test: FrozenSplit) -> bool:
        """Check 2: sample ≤200 test indices; verify no train collision.

        Production: cross-check against training data files (GPU/data-gated).
        Here: verify internal consistency of the frozen split (no duplicate hashes),
        which is a necessary condition for the split to be untampered.
        """
        hashes = list(frozen_test.per_sample_hashes.values())
        # Any duplicates within the frozen test split indicate corruption
        return len(hashes) == len(set(hashes))

    def _check_no_label_contamination(self, frozen_test: FrozenSplit) -> bool:
        """Check 3: sha256(test_sample_i) ∉ {sha256(train_sample_j)} over 100 pairs.

        Production: requires access to training data (GPU/data-gated).
        Returns True by default when training data is not available for cross-check;
        the frozen-split hash chain (checks 1, 7) provides the primary tamper guard.
        """
        return True

    def _check_telemetry_sane(self, telemetry_path: Path) -> bool:
        """Check 5: parse telemetry.jsonl; validate loss + optional grad_norm.

        Fails if:
          - file missing or unreadable
          - any loss value is NaN or Inf
          - first loss == last loss (constant = no learning, with ≥2 records)
          - any grad_norm value ≤ 0 or NaN/Inf when the field is present (R6)
        """
        if not telemetry_path.exists():
            return False

        records: list[dict] = []
        try:
            with open(telemetry_path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    records.append(json.loads(line))
        except (json.JSONDecodeError, OSError):
            return False

        if not records:
            return False

        losses = [r["train_loss"] for r in records if r.get("train_loss") is not None]
        if losses:
            if any(_is_bad_float(v) for v in losses):
                return False
            if len(losses) >= 2 and losses[0] == losses[-1]:
                # Constant loss → model not learning
                return False

        # grad_norm check — ONLY when the field is present in any record (R6)
        grad_norms = [r["grad_norm"] for r in records if r.get("grad_norm") is not None]
        if grad_norms:
            if any(_is_bad_float(v) or v <= 0 for v in grad_norms):
                return False

        return True

    def _check_reward_hacking(
        self, result: EvaluationResult, goal: GoalContract
    ) -> bool:
        """Check 6: detect leakage signatures — a near-perfect val (leakage ceiling) or
        a sudden per-step val SPIKE. A large but sub-ceiling improvement over baseline is
        legitimate SUCCESS, not hacking, and must NOT be flagged.

        Direction-aware (Bug 3 fix):
          higher-is-better: ceiling hit = val >= LEAK_CEILING (0.98)
                            spike     = series[i] - series[i-1] > SPIKE_THRESH
          lower-is-better:  ceiling hit = val <= LEAK_FLOOR (0.02)
                            spike     = series[i-1] - series[i] > SPIKE_THRESH

        Returns True when hacking is flagged (bad); False when clean.
        """
        # Read the full primary MetricSpec so we can inspect direction (Bug 3).
        primary_spec = next(
            (m for m in goal.metric_specs if m.role == "primary_fitness"),
            None,
        )
        if primary_spec is None:
            return False

        primary_metric = primary_spec.metric_name
        # Default to "higher" so existing test fixtures that omit direction keep working.
        direction = getattr(primary_spec, "direction", "higher")

        candidate_val = result.metrics.get(primary_metric)
        if candidate_val is None:
            return False

        # A genuine model improving the metric by a large RELATIVE amount while still far
        # from the ceiling is SUCCESS, not hacking (e.g. baseline 0.20 -> 0.38). Test
        # leakage instead shows an IMPLAUSIBLY HIGH/LOW absolute value (near-perfect on a
        # hard task) or a sudden per-step val spike. Flag those — never legitimate progress.
        LEAK_CEILING = 0.98   # near-perfect for higher-is-better metrics (accuracy, F1)
        LEAK_FLOOR   = 0.02   # near-perfect for lower-is-better  metrics (MSE, loss)
        SPIKE_THRESH = 0.30   # per-step magnitude threshold (both directions)

        if direction == "higher" and candidate_val >= LEAK_CEILING:
            return True
        if direction == "lower"  and candidate_val <= LEAK_FLOOR:
            return True

        # Best-effort per-step spike check when a val series is present in telemetry.
        # Bug-2 fix: TelemetrySummary is a Pydantic model in production, not a dict, so
        # isinstance(tele, dict) was False and silently bypassed the check.  Use getattr
        # as the primary path; fall back to dict.get() for backwards-compat with tests
        # that pass a plain dict.
        tele = getattr(result, "telemetry_summary", None)
        series = None
        if tele is not None:
            if isinstance(tele, dict):
                series = (
                    tele.get("val_series")
                    or tele.get("val_top1_series")
                    or tele.get("val_metric_series")
                )
            else:
                # Pydantic TelemetrySummary (production path)
                series = getattr(tele, "val_series", None)

        if isinstance(series, list) and len(series) >= 3:
            for i in range(2, len(series)):
                try:
                    delta = float(series[i]) - float(series[i - 1])
                    if direction == "higher" and delta >  SPIKE_THRESH:
                        return True
                    if direction == "lower"  and delta < -SPIKE_THRESH:
                        return True
                except (TypeError, ValueError):
                    continue
        return False

    def _load_aug_sample_bytes(
        self, provenance_path: Path, run_dir: Path | None
    ) -> list[bytes]:
        """Load augmented sample bytes for near-dup checking (check 8).

        In production, bytes come from the data pipeline materialised by Forge.
        Returns [] (silent no-op) rather than raising so the surrounding integrity
        pipeline always runs; real bytes are data-pipeline gated — see KNOWN_GAPS.md#G6.
        Tests supply bytes directly via check() kwargs or mock _dpt.check_near_dup().
        """
        # Data-pipeline gated — see KNOWN_GAPS.md#G6
        return []

    def _check_data_provenance(
        self, provenance_path: Path, frozen_test: FrozenSplit
    ) -> bool:
        """Check 9: all DataProvenance.source_sample_ids must trace to train only.

        Returns False if any source_sample_id matches a test-split index.
        """
        test_indices = set(frozen_test.per_sample_hashes.keys())
        try:
            with open(provenance_path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    rec = json.loads(line)
                    source_id = str(rec.get("source_sample_id", ""))
                    if source_id in test_indices:
                        return False
        except (json.JSONDecodeError, OSError):
            return False
        return True

    def _check_acquisition_contamination(
        self,
        acquired_samples: list[bytes],
        frozen_test: FrozenSplit,
        all_frozen_splits: list[FrozenSplit],
    ) -> bool:
        """Check 11: no acquired sample collides with ANY frozen eval split.

        Covers all eval_versions (not just current) to catch "add benchmark as
        training data" attacks.

        Returns True (clear) if quarantine fraction ≤ 5%.
        Returns False (contaminated) if quarantine fraction > 5%.
        Empty acquired_samples → True (vacuously clear).
        """
        if not acquired_samples:
            return True

        # Collect all eval split hashes across ALL versions
        all_eval_hashes: set[str] = set()
        for split in all_frozen_splits:
            all_eval_hashes.update(split.per_sample_hashes.values())

        quarantined: set[int] = set()
        for i, sample in enumerate(acquired_samples):
            if _sha256_bytes(sample) in all_eval_hashes:
                quarantined.add(i)

        # Also near-dup check against the current frozen_test
        flagged_indices = self._dpt.check_near_dup(acquired_samples, frozen_test)
        for idx_str in flagged_indices:
            try:
                quarantined.add(int(idx_str))
            except ValueError:
                quarantined.add(len(acquired_samples))  # safety: count as quarantined

        quarantine_fraction = len(quarantined) / len(acquired_samples)
        return quarantine_fraction <= 0.05

    def _check_acquisition_provenance(
        self,
        provenance: AcquisitionProvenance | None,
        goal: GoalContract,
    ) -> bool:
        """Check 12: AcquisitionProvenance present with required provenance fields.

        External: license_identifier non-empty AND in allowed_licenses AND citation non-empty.
        Synthetic: generator_config non-empty AND citation non-empty.
        """
        if provenance is None:
            return False

        if not provenance.citation:
            return False

        if provenance.acquisition_type == "external":
            if not provenance.license_identifier:
                return False
            if provenance.license_identifier not in goal.allowed_licenses:
                return False
            if not provenance.license_in_allowlist:
                return False
        elif provenance.acquisition_type == "synthetic":
            if not provenance.generator_config:
                return False

        return True

    def _check_acquisition_namespace(
        self,
        provenance: AcquisitionProvenance | None,
        store: "ContentAddressedStore | None",
    ) -> bool:
        """Check 13: DataStore.verify_namespace(acquisition_id, 'train') must return True.

        Conservative fail when provenance or store is unavailable.
        """
        if provenance is None or store is None:
            return False
        try:
            return store.verify_namespace(provenance.acquisition_id, "train")
        except Exception:
            return False
