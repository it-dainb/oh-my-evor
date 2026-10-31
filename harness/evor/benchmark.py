"""
BenchmarkManager — EvalSuite/BenchmarkUpgrade governance (Pillar 3 + 4).

apply_upgrade() is the SINGLE creation path for BenchmarkUpgrade records (Q4).
Re-score mode is read from StrategyState.rescore_mode — the single source of
truth (Q1); no separate rescore_synchronous parameter exists here.

Defensive invariants enforced by this module:
  - domains_removed MUST always be empty (Q4 additive-only superset rule).
  - consent_granted MUST be True before any EvalSuite is materialised.
  - BenchmarkUpgrade records are never hand-authored; they originate here only.

apply_hardening() is the second creation path, for the other monotonic move: the
domains stay and the EVALUATOR is replaced by a stricter one. It needs no consent
— the Monotonic-Honesty Invariant pre-authorizes making evaluation harder — and
it cannot soften, because every node scored under a hardened version also carries
the sealed parent evaluator's score for the same node, and the integrity gate
fails the node when the hardened score exceeds it (not_softer_than_parent).
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from evor.contracts import (
    BenchmarkUpgrade,
    DecisionLogEntry,
    Domain,
    EvalSuite,
    StrategyState,
)
from evor.freeze import FrozenSplitManager


class IntegrityError(Exception):
    """Raised when a BenchmarkUpgrade invariant is violated."""


#: How far a hardened score may exceed the parent's before it counts as a
#: softening — float noise between two runs of deterministic evaluators, no more.
HARDENING_EPSILON = 1e-6


def hardening_parent(run_dir: Path, eval_version: str | None) -> str | None:
    """The parent version when ``eval_version`` is a metric hardening, else None.

    The suite record is the one owner of that fact: the runner reads it to decide
    whether to score the parent too, and the integrity gate to decide whether
    not_softer_than_parent applies.
    """
    if not eval_version:
        return None
    try:
        suite = json.loads((Path(run_dir) / "eval-suites" / f"{eval_version}.json").read_text())
    except (OSError, ValueError):
        return None
    parent = suite.get("parent_eval_version")
    return str(parent) if suite.get("kind") == "metric_hardening" and parent else None


def split_version(run_dir: Path, eval_version: str) -> str:
    """The version whose frozen split ``eval_version`` scores.

    A hardening changes the evaluator, never the data, so it reads its parent's
    split; walk the chain down to the version that froze one.
    """
    seen = {eval_version}
    parent = hardening_parent(run_dir, eval_version)
    while parent and parent not in seen:
        eval_version = parent
        seen.add(parent)
        parent = hardening_parent(run_dir, parent)
    return eval_version


def sealed_script(run_dir: Path, eval_version: str) -> Path | None:
    """``eval-suites/<v>.py`` when its bytes still match the seal receipt, else None."""
    base = Path(run_dir) / "eval-suites"
    script = base / f"{eval_version}.py"
    try:
        receipt = json.loads((base / f"{eval_version}.sealed.json").read_text())
        sealed = (receipt.get("files") or {}).get(script.name) or receipt.get("hash")
        actual = hashlib.sha256(script.read_bytes()).hexdigest()
    except (OSError, ValueError):
        return None
    return script if sealed and sealed == actual else None


def _contract_strings(value: object) -> list[str]:
    """Every string value in the goal contract — the text a grounding may quote."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _contract_strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _contract_strings(v)]
    return []


def _normalise(text: str) -> str:
    return " ".join(text.split()).casefold()


def _atomic_write_json(path: Path, data: object) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, path)


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
        if upgrade.kind == "metric_hardening":
            raise IntegrityError(
                f"BenchmarkUpgrade {upgrade.upgrade_id!r} is a metric hardening; "
                "those are applied by apply_hardening(), which replaces the evaluator "
                "and adds no domains."
            )

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
            kind="domain_upgrade",
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

    def apply_hardening(
        self,
        from_eval_version: str,
        to_eval_version: str,
        rationale: str,
        contract_grounding: str,
        evidence: list[str],
        proposed_by: str = "probe",
        tick: int | None = None,
    ) -> dict:
        """Make ``to_eval_version`` a metric hardening of ``from_eval_version``.

        Preconditions (each an IntegrityError):
          - ``from`` is the contract's current eval_version and its evaluator is sealed;
          - ``to`` has an evaluator written (``eval-suites/<to>.py``) and no suite yet;
          - ``contract_grounding`` is text the goal contract actually contains: a
            hardening reconciles the metric to the contract's stated intent, so the
            intent it enforces must be quotable from the contract.

        Effects: EvalSuite ``to`` (same domains and split, kind=metric_hardening);
        a BenchmarkUpgrade record listing the frontier nodes to re-score;
        GoalContract.eval_version and RunState.current_eval_version set to ``to``;
        a ``harden-eval`` DecisionLogEntry. The new evaluator's seal (the contract's
        eval_script_hash) is written by the caller's seal step, afterwards.

        No consent: the Monotonic-Honesty Invariant pre-authorizes a harder
        evaluation. A softer one is caught per node by not_softer_than_parent.
        """
        run_dir = self._run_dir
        contract_path = run_dir / "goal-contract.json"
        try:
            contract = json.loads(contract_path.read_text())
        except (OSError, ValueError) as exc:
            raise IntegrityError(f"goal contract is unreadable: {exc}") from exc

        current = contract.get("eval_version", "v1")
        if from_eval_version != current:
            raise IntegrityError(
                f"from_eval_version {from_eval_version!r} is not the contract's current "
                f"eval_version {current!r}; only the version in force can be hardened."
            )
        if to_eval_version == from_eval_version:
            raise IntegrityError("to_eval_version must differ from from_eval_version.")
        if self._suite_path(to_eval_version).exists():
            raise IntegrityError(
                f"EvalSuite {to_eval_version!r} already exists; a version is created once."
            )
        if sealed_script(run_dir, from_eval_version) is None:
            raise IntegrityError(
                f"the {from_eval_version!r} evaluator is not sealed (or changed since its "
                "seal); a hardening is checked against the sealed parent, so seal it first."
            )
        if not (run_dir / "eval-suites" / f"{to_eval_version}.py").exists():
            raise IntegrityError(f"no evaluator written for {to_eval_version!r}.")
        if not rationale.strip():
            raise IntegrityError("a hardening needs a rationale: the gate it adds and why.")
        evidence = [e.strip() for e in evidence or [] if e and e.strip()]
        if not evidence:
            raise IntegrityError(
                "a hardening needs evidence: the wiki lesson or probe proposal that found "
                "the metric artefact."
            )
        grounding = _normalise(contract_grounding)
        if len(grounding) < 12 or not any(
            grounding in _normalise(s) for s in _contract_strings(contract)
        ):
            raise IntegrityError(
                "contract_grounding must quote the goal contract's own text (at least 12 "
                "characters) — the stated intent the current metric fails to enforce. "
                "A gate the contract does not ask for is a new objective, not a hardening."
            )

        from_suite = self.get_eval_suite(from_eval_version, run_dir)
        now = datetime.now(timezone.utc).isoformat()
        upgrade_id = f"harden-{from_eval_version}-to-{to_eval_version}"

        # Frontier to re-score: run-state's frontier, else every passed node.
        state_path = run_dir / "run-state.json"
        try:
            state = json.loads(state_path.read_text())
        except (OSError, ValueError):
            state = None
        try:
            nodes = json.loads((run_dir / "tree.json").read_text()).get("nodes") or {}
        except (OSError, ValueError):
            nodes = {}
        if isinstance(nodes, list):
            nodes = {n.get("id"): n for n in nodes if isinstance(n, dict)}
        frontier = [i for i in (state or {}).get("frontier_ids") or [] if i in nodes]
        if not frontier:
            frontier = [
                i for i, n in nodes.items()
                if n.get("status") == "done" and n.get("integrity_status") == "passed"
            ]

        suite = EvalSuite(
            eval_version=to_eval_version,
            mission_id=from_suite.mission_id,
            parent_eval_version=from_eval_version,
            domains=list(from_suite.domains),
            split_hashes=dict(from_suite.split_hashes),
            created_at=now,
            created_by="policy",
            consent_log_ref="monotonic-honesty-invariant",
            kind="metric_hardening",
            hardening_rationale=rationale,
        )
        upgrade = BenchmarkUpgrade(
            upgrade_id=upgrade_id,
            mission_id=from_suite.mission_id,
            from_eval_version=from_eval_version,
            to_eval_version=to_eval_version,
            proposed_by=proposed_by if proposed_by in ("user", "probe", "sage", "policy") else "policy",  # type: ignore[arg-type]
            proposal_citations=list(evidence),
            consent_granted=True,
            consent_at=now,
            new_domains_added=[],
            domains_removed=[],
            rescore_status="pending" if frontier else "complete",
            rescore_deadline_ticks=3,
            decision_log_ref="decision-log.md",
            created_at=now,
            kind="metric_hardening",
            rescore_node_ids=frontier,
        )
        entry = DecisionLogEntry(
            timestamp=now,
            tick=int(tick if tick is not None else (state or {}).get("tick_count", 0) or 0),
            decision_type="harden-eval",
            rationale=(
                f"{to_eval_version} hardens {from_eval_version}: {rationale} "
                f"(contract: \"{contract_grounding.strip()}\")"
            ),
            node_ids=frontier,
            evidence=evidence,
        )

        suite_path = self._suite_path(to_eval_version)
        tmp = suite_path.with_suffix(".json.tmp")
        tmp.write_text(suite.model_dump_json(indent=2))
        os.replace(tmp, suite_path)

        upgrades_dir = run_dir / "benchmark-upgrades"
        upgrades_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(upgrades_dir / f"{upgrade_id}.json", json.loads(upgrade.model_dump_json()))

        contract["eval_version"] = to_eval_version
        _atomic_write_json(contract_path, contract)
        if state is not None:
            state["current_eval_version"] = to_eval_version
            _atomic_write_json(state_path, state)

        self._append_decision_log(
            f"\n## Metric hardening {upgrade_id}\n"
            f"- applied_at: {now}\n"
            f"- parent: {from_eval_version} (stays sealed; its scores are kept)\n"
            f"- from: {from_eval_version} → to: {to_eval_version} (same domains, same split)\n"
            f"- evidence: {', '.join(evidence)}\n"
            f"- gate: {rationale}\n"
            f"- contract intent: \"{contract_grounding.strip()}\"\n"
            f"- consent: pre-authorized by the Monotonic-Honesty Invariant\n"
            f"- rescore: {len(frontier)} frontier node(s) pending\n"
            f"- entry: {entry.model_dump_json()}\n"
        )

        names = [str(nodes.get(i, {}).get("name") or i) for i in frontier]
        return {
            "ok": True,
            "upgrade_id": upgrade_id,
            "from_eval_version": from_eval_version,
            "to_eval_version": to_eval_version,
            "rescore": names,
        }

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
            "with --eval-domains, parse EvaluationResult.per_domain[domain_id]."
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

    def create_initial_suite(
        self,
        mission_id: str,
        eval_version: str,
        task_description: str,
        run_dir: Path,
    ) -> EvalSuite:
        """Create the first EvalSuite from scratch (no parent required).

        Domains come from the FROZEN SPLIT: one per distinct value of
        ``frozen-splits/<eval_version>-test.json``'s ``per_sample_domains``.
        Only when no split has been frozen yet, or it records no domains, is a
        single placeholder 'primary' domain used.

        This used to say it "derives a single 'primary' domain from
        task_description" and did exactly that, whatever the data: a mission whose
        frozen test split held 22 real domains got a suite with one. The sealed
        evaluator still enforced all 22, so scores were right, but every
        open-ended angle and coverage figure keyed off the suite described a
        one-domain mission. `freeze.py` already derives the domains from the
        frozen samples themselves — never from the caller — so that is the source.

        Writes ``eval-suites/<eval_version>.json`` and ``angle-registry.json``
        (empty angles list for open-ended readiness).

        Called by ``python -m evor.benchmark init-eval-suite`` during setup, AFTER
        ``evor_freeze_splits``.
        """
        domain_ids: list[str] = []
        split_path = run_dir / "frozen-splits" / f"{eval_version}-test.json"
        try:
            per_sample = json.loads(split_path.read_text()).get("per_sample_domains") or {}
            domain_ids = sorted({str(d) for d in per_sample.values() if d})
        except (OSError, ValueError):
            domain_ids = []  # no split frozen yet — the placeholder below applies

        if domain_ids:
            domains = [
                Domain(
                    domain_id=domain_id,
                    description=f"{domain_id} (from the frozen {eval_version} test split)",
                    metric_specs=[],
                    sota_source=None,
                    added_at_eval_version=eval_version,
                )
                for domain_id in domain_ids
            ]
        else:
            domains = [Domain(
                domain_id="primary",
                description=task_description,
                metric_specs=[],
                sota_source=None,
                added_at_eval_version=eval_version,
            )]

        suite = EvalSuite(
            eval_version=eval_version,
            mission_id=mission_id,
            parent_eval_version=None,
            domains=domains,
            split_hashes={},
            created_at=datetime.now(timezone.utc).isoformat(),
            created_by="user",
            consent_log_ref="setup-session",
        )

        suite_path = self._suite_path(eval_version)
        tmp_path = suite_path.with_suffix(".json.tmp")
        tmp_path.write_text(suite.model_dump_json(indent=2))
        os.replace(tmp_path, suite_path)

        # Initialise an empty angle-registry for open_ended readiness
        angle_registry_path = run_dir / "angle-registry.json"
        if not angle_registry_path.exists():
            angle_registry_path.write_text(json.dumps({
                "mission_id": mission_id,
                "angles": [],
                "updated_at": suite.created_at,
            }, indent=2))

        return suite


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry point — `python -m evor.benchmark`
# ─────────────────────────────────────────────────────────────────────────────


def _cli() -> None:
    """CLI for BenchmarkManager.

    Subcommands
    -----------
    init-eval-suite
        Create the initial EvalSuite v1 for a new mission.

        Usage::

            python -m evor.benchmark init-eval-suite \\
                --mission-id <mission_id> \\
                --eval-version v1 \\
                --task-description "<description>" \\
                --run-dir .evor/runs/<mission>/<run-id>/

    harden
        Make ``--to-version`` (its evaluator already written) a metric hardening of
        the contract's current ``--from-version``; see apply_hardening(). Called by
        the evor_harden_eval MCP tool, which validates the source first and seals
        it afterwards.
    """
    import argparse
    import sys as _sys

    parser = argparse.ArgumentParser(prog="python -m evor.benchmark")
    sub = parser.add_subparsers(dest="cmd", required=True)

    ie = sub.add_parser(
        "init-eval-suite",
        help="Create the initial EvalSuite for a new mission.",
    )
    ie.add_argument("--mission-id", required=True, help="Mission identifier")
    ie.add_argument("--eval-version", required=True, help="Eval version string (e.g. v1)")
    ie.add_argument("--task-description", required=True, help="Task description for domain derivation")
    ie.add_argument("--run-dir", required=True, help="Path to .evor/runs/<mission>/<run-id>/")

    hd = sub.add_parser(
        "harden",
        help="Make a new eval version a metric hardening of the current one.",
    )
    hd.add_argument("--run-dir", required=True)
    hd.add_argument("--from-version", required=True)
    hd.add_argument("--to-version", required=True)
    hd.add_argument("--rationale", required=True)
    hd.add_argument("--contract-grounding", required=True)
    hd.add_argument("--proposed-by", default="probe")
    hd.add_argument("--evidence", action="append", default=[])
    hd.add_argument("--tick", type=int, default=None)

    args = parser.parse_args()

    if args.cmd == "harden":
        try:
            out = BenchmarkManager(Path(args.run_dir)).apply_hardening(
                from_eval_version=args.from_version,
                to_eval_version=args.to_version,
                rationale=args.rationale,
                contract_grounding=args.contract_grounding,
                evidence=args.evidence,
                proposed_by=args.proposed_by,
                tick=args.tick,
            )
        except (IntegrityError, FileNotFoundError) as exc:
            print(json.dumps({"ok": False, "error": str(exc)}))
            _sys.exit(1)
        print(json.dumps(out))
        _sys.exit(0)

    if args.cmd == "init-eval-suite":
        run_dir = Path(args.run_dir)
        mgr = BenchmarkManager(run_dir)
        suite = mgr.create_initial_suite(
            mission_id=args.mission_id,
            eval_version=args.eval_version,
            task_description=args.task_description,
            run_dir=run_dir,
        )
        print(json.dumps({
            "eval_version": suite.eval_version,
            "mission_id": suite.mission_id,
            "domains": [d.domain_id for d in suite.domains],
            "created_at": suite.created_at,
        }))
        _sys.exit(0)


if __name__ == "__main__":
    _cli()
