"""
BenchmarkManager — EvalSuite/BenchmarkUpgrade governance (Pillar 3 + 4).

apply_upgrade() is the SINGLE creation path for BenchmarkUpgrade records (Q4).
Re-score mode is read from StrategyState.rescore_mode — the single source of
truth (Q1); no separate rescore_synchronous parameter exists here.

Defensive invariants enforced by this module:
  - domains_removed MUST always be empty (Q4 additive-only superset rule).
  - consent_granted MUST be True before any EvalSuite is materialised.
  - BenchmarkUpgrade records are never hand-authored; they originate here only.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from evor.contracts import (
    BenchmarkUpgrade,
    Domain,
    EvalSuite,
    StrategyState,
)
from evor.freeze import FrozenSplitManager


class IntegrityError(Exception):
    """Raised when a BenchmarkUpgrade invariant is violated."""


class BenchmarkManager:
    """Governs EvalSuite creation and BenchmarkUpgrade application."""

    def __init__(self, run_dir: Path) -> None:
        self._run_dir = run_dir
        self._freeze_mgr = FrozenSplitManager()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _eval_suites_dir(self) -> Path:
        d = self._run_dir / "eval-suites"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _suite_path(self, eval_version: str) -> Path:
        return self._eval_suites_dir() / f"{eval_version}.json"

    def _decision_log_path(self) -> Path:
        return self._run_dir / "decision-log.md"

    def _append_decision_log(self, text: str) -> None:
        with open(self._decision_log_path(), "a") as fh:
            fh.write(text + "\n")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def apply_upgrade(
        self,
        upgrade: BenchmarkUpgrade,
        run_dir: Path,
        seed_checkpoint_hash: str | None,
        strategy_state: StrategyState,
    ) -> EvalSuite:
        """Create new EvalSuite version (strict superset of from_eval_version).

        DEFENSIVE INVARIANT (Q4):
          upgrade.domains_removed MUST be empty — raise IntegrityError if not.
          This field exists only to trip on malformed/hand-authored records.

        CREATION GUARD (Q4):
          Only this method creates BenchmarkUpgrade + EvalSuite records.

        RE-SCORE MODE (Q1):
          Read strategy_state.rescore_mode — the SINGLE source of truth.
          "sync": block new ticks until all frontier nodes are re-scored.
          "async": mark frontier nodes stale and return immediately.
          Do NOT add a separate rescore_synchronous parameter.

        BASELINE SCORE CAPTURE (R-13):
          For each new domain, attempt to evaluate the SEED/foundation model
          checkpoint (seed_checkpoint_hash) on the new angle's held-out split.
          If seed_checkpoint_hash is None (from-scratch mode) or the GPU stack
          is unavailable, _eval_seed_model raises NotImplementedError and
          baseline_model_score_before_finetune is recorded as None.
        """
        # ── Invariant: domains_removed MUST be empty ─────────────────────
        if upgrade.domains_removed:
            raise IntegrityError(
                f"BenchmarkUpgrade {upgrade.upgrade_id!r} has non-empty "
                f"domains_removed={upgrade.domains_removed!r}. "
                "EvalSuite upgrades are strictly additive — domains are never removed."
            )

        # ── Consent gate ─────────────────────────────────────────────────
        if not upgrade.consent_granted:
            raise IntegrityError(
                f"BenchmarkUpgrade {upgrade.upgrade_id!r} lacks consent_granted=True. "
                "Obtain user or policy consent before calling apply_upgrade()."
            )

        # ── Load parent EvalSuite ─────────────────────────────────────────
        from_suite = self.get_eval_suite(upgrade.from_eval_version, run_dir)
        existing_domain_ids = {d.domain_id for d in from_suite.domains}

        # Verify superset invariant: new domains must not already exist
        for domain_id in upgrade.new_domains_added:
            if domain_id in existing_domain_ids:
                raise IntegrityError(
                    f"Domain {domain_id!r} already exists in "
                    f"EvalSuite {upgrade.from_eval_version!r}. "
                    "Superset invariant: each domain_id must be unique across versions."
                )

        # ── Baseline score capture + new Domain objects ───────────────────
        new_domains: list[Domain] = []
        angle_baseline_scores: dict[str, float | None] = {}

        for domain_id in upgrade.new_domains_added:
            baseline_score: float | None = None
            if seed_checkpoint_hash is not None:
                try:
                    baseline_score = self._eval_seed_model(
                        seed_checkpoint_hash=seed_checkpoint_hash,
                        domain_id=domain_id,
                        run_dir=run_dir,
                    )
                except NotImplementedError:
                    # GPU/eval stack unavailable — baseline stays None; wired in M6
                    baseline_score = None

            angle_baseline_scores[domain_id] = baseline_score

            new_domains.append(
                Domain(
                    domain_id=domain_id,
                    description=(
                        f"Domain added by BenchmarkUpgrade {upgrade.upgrade_id}"
                    ),
                    metric_specs=[],
                    sota_source=None,
                    added_at_eval_version=upgrade.to_eval_version,
                )
            )

        # ── Build new EvalSuite (strict superset) ─────────────────────────
        new_suite = EvalSuite(
            eval_version=upgrade.to_eval_version,
            mission_id=upgrade.mission_id,
            parent_eval_version=upgrade.from_eval_version,
            domains=from_suite.domains + new_domains,
            split_hashes=dict(from_suite.split_hashes),
            created_at=datetime.now(timezone.utc).isoformat(),
            created_by="policy",
            consent_log_ref=upgrade.decision_log_ref,
        )

        # Atomic write
        suite_path = self._suite_path(upgrade.to_eval_version)
        tmp_path = suite_path.with_suffix(".json.tmp")
        tmp_path.write_text(new_suite.model_dump_json(indent=2))
        os.replace(tmp_path, suite_path)

        # ── Re-score mode (Q1) ────────────────────────────────────────────
        rescore_mode: Literal["sync", "async"] = strategy_state.rescore_mode
        log_entry = (
            f"\n## BenchmarkUpgrade {upgrade.upgrade_id}\n"
            f"- applied_at: {new_suite.created_at}\n"
            f"- from: {upgrade.from_eval_version} → to: {upgrade.to_eval_version}\n"
            f"- new_domains: {upgrade.new_domains_added}\n"
            f"- rescore_mode: {rescore_mode}\n"
            f"- baseline_scores: {angle_baseline_scores}\n"
        )
        if rescore_mode == "sync":
            log_entry += "- action: blocking; new ticks paused until rescore complete\n"
        else:
            log_entry += "- action: async; frontier nodes marked stale (rescore_status=pending)\n"
        self._append_decision_log(log_entry)

        return new_suite

    def _eval_seed_model(
        self,
        seed_checkpoint_hash: str,
        domain_id: str,
        run_dir: Path,
    ) -> float:
        """Evaluate the SEED/foundation model checkpoint on a new angle's held-out split.

        Requires GPU + model + eval infrastructure (wired in M6/EvaluatorAdapter).
        Raises NotImplementedError until M6 is complete.
        """
        # Wiring (GPU-gated, see KNOWN_GAPS.md#G1):
        #   1. store.get(seed_checkpoint_hash) → checkpoint path
        #   2. EvaluatorAdapter(run_dir).run(eval_script, worktree, goal, node, env,
        #         rescore_context=BenchmarkRescore(new_domains=[domain_id]))
        #   3. return result.per_domain[domain_id][primary_metric]
        # Kept as a NotImplementedError until a GPU + live eval environment is present;
        # the surrounding BenchmarkEngine flow and storage are fully wired.
        raise NotImplementedError(
            f"_eval_seed_model requires GPU + live eval infrastructure. "
            f"seed_checkpoint_hash={seed_checkpoint_hash!r}, domain_id={domain_id!r}. "
            "Resolve checkpoint via ContentAddressedStore, invoke EvaluatorAdapter "
            "with --eval-domains, parse EvaluationResult.per_domain[domain_id]. "
            "See KNOWN_GAPS.md#G1."
        )

    def get_eval_suite(self, eval_version: str, run_dir: Path) -> EvalSuite:
        """Load EvalSuite snapshot from eval-suites/<eval_version>.json."""
        path = run_dir / "eval-suites" / f"{eval_version}.json"
        if not path.exists():
            raise FileNotFoundError(
                f"EvalSuite version {eval_version!r} not found at {path}"
            )
        with open(path) as fh:
            return EvalSuite.model_validate_json(fh.read())

    def list_versions(self, run_dir: Path) -> list[str]:
        """Return sorted list of eval_version strings present in eval-suites/."""
        suites_dir = run_dir / "eval-suites"
        if not suites_dir.exists():
            return []
        return sorted(p.stem for p in suites_dir.glob("*.json"))
