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
import re
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
from evor.eval_contract import SCORE_PLUGIN_FILENAME as SCORE_PLUGIN
from evor.freeze import FrozenSplitManager


class IntegrityError(Exception):
    """Raised when a BenchmarkUpgrade invariant is violated."""


#: How far a hardened score may exceed the parent's before it counts as a
#: softening — float noise between two runs of deterministic evaluators, no more.
HARDENING_EPSILON = 1e-6

#: The only shape an eval version takes where it builds a path. A version read
#: back from a result file or a tool argument is data, and `../x` is not a version.
VERSION_RE = re.compile(r"^v\d+$")

#: Who may propose a hardening. Anything else is refused, not relabelled.
HARDENING_PROPOSERS = ("user", "probe", "sage", "policy")


def valid_version(eval_version: object) -> bool:
    return isinstance(eval_version, str) and bool(VERSION_RE.match(eval_version))


def suite_status(run_dir: Path, eval_version: str | None) -> tuple[str, str | None]:
    """How ``eval_version`` relates to its parent, from its suite record.

    ``("hardening", parent)``, ``("plain", None)``, or ``("missing", None)`` when
    the record is absent or unreadable — which readers that guard a hardening
    must treat as a failure, not as "not a hardening".
    """
    if not valid_version(eval_version):
        return ("missing", None)
    try:
        suite = json.loads((Path(run_dir) / "eval-suites" / f"{eval_version}.json").read_text())
    except (OSError, ValueError):
        return ("missing", None)
    if not isinstance(suite, dict):
        return ("missing", None)
    parent = suite.get("parent_eval_version")
    if suite.get("kind") == "metric_hardening":
        return ("hardening", str(parent)) if valid_version(parent) else ("missing", None)
    return ("plain", None)


def run_has_suites(run_dir: Path) -> bool:
    """Does this run keep suite records at all? (Legacy runs may not.)"""
    base = Path(run_dir) / "eval-suites"
    return base.is_dir() and any(valid_version(p.stem) for p in base.glob("*.json"))


def hardening_parent(run_dir: Path, eval_version: str | None) -> str | None:
    """The parent version when ``eval_version`` is a metric hardening, else None.

    The suite record is the one owner of that fact: the runner reads it to decide
    whether to score the parent too, and the integrity gate to decide whether
    not_softer_than_parent applies.
    """
    status, parent = suite_status(run_dir, eval_version)
    return parent if status == "hardening" else None


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


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def receipt_files(run_dir: Path, eval_version: str) -> dict[str, str] | None:
    """The per-file manifest the seal recorded for a version, or None."""
    if not valid_version(eval_version):
        return None
    base = Path(run_dir) / "eval-suites"
    try:
        receipt = json.loads((base / f"{eval_version}.sealed.json").read_text())
    except (OSError, ValueError):
        return None
    files = dict(receipt.get("files") or {})
    if f"{eval_version}.py" not in files and receipt.get("hash"):
        files[f"{eval_version}.py"] = receipt["hash"]
    if SCORE_PLUGIN not in files and receipt.get("plugin_hash"):
        files[SCORE_PLUGIN] = receipt["plugin_hash"]
    return files


def sealed_script(run_dir: Path, eval_version: str) -> Path | None:
    """``eval-suites/<v>.py`` when EVERY file its seal receipt records still matches.

    The receipt covers the harness and, when there is one, ``score_plugin.py`` —
    the metric, which every version in the run shares. Checking the harness alone
    let a swapped plugin score the "parent" with bytes the parent never sealed.
    """
    files = receipt_files(run_dir, eval_version)
    base = Path(run_dir) / "eval-suites"
    script = base / f"{eval_version}.py"
    if not files or script.name not in files:
        return None
    try:
        for name, digest in files.items():
            if _sha256(base / name) != digest:
                return None
    except OSError:
        return None
    return script


def fitness_lower_is_better(goal: dict | object) -> bool:
    """Is a LOWER fitness_value better under this contract?

    Fitness is the primary metric's raw value whenever no baseline→target
    normalisation applies (worst-domain/weighted always; aggregate or a formula
    without a target), so a lower-is-better primary makes fitness lower-is-better
    too. With a target, aggregate fitness is normalised and higher is better.
    """
    g = goal if isinstance(goal, dict) else goal.model_dump()  # type: ignore[union-attr]
    spec = next((m for m in g.get("metric_specs") or [] if m.get("role") == "primary_fitness"), None)
    if not spec or spec.get("direction") != "lower":
        return False
    if g.get("fitness_mode") in ("worst-domain", "weighted") and not spec.get("fitness_formula"):
        return True
    return g.get("target_value") is None


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


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _atomic_write_json(path: Path, data: object) -> None:
    _atomic_write_bytes(path, json.dumps(data, indent=2).encode())


def _write_contract(tx: "_Transaction", path: Path, contract: dict) -> None:
    tx.write(path, json.dumps(contract, indent=2).encode())


class _Transaction:
    """All-or-nothing file writes: every write is recorded, and rollback() puts
    back the bytes of each file that existed and removes each file that did not."""

    def __init__(self) -> None:
        self._before: dict[Path, bytes | None] = {}
        self._appended: dict[Path, int] = {}

    def write(self, path: Path, data: bytes) -> None:
        if path not in self._before:
            self._before[path] = path.read_bytes() if path.exists() else None
        _atomic_write_bytes(path, data)

    def append(self, path: Path, text: str) -> None:
        if path not in self._appended:
            self._appended[path] = path.stat().st_size if path.exists() else -1
        with open(path, "a") as fh:
            fh.write(text)

    def rollback(self) -> None:
        for path, before in self._before.items():
            try:
                if before is None:
                    path.unlink(missing_ok=True)
                else:
                    _atomic_write_bytes(path, before)
            except OSError:
                pass
        for path, size in self._appended.items():
            try:
                if size < 0:
                    path.unlink(missing_ok=True)
                else:
                    with open(path, "r+b") as fh:
                        fh.truncate(size)
            except OSError:
                pass


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
        source: str | None,
        proposed_by: str = "probe",
        tick: int | None = None,
        rescore_deadline_ticks: int = 3,
    ) -> dict:
        """Make ``to_eval_version`` a metric hardening of ``from_eval_version``.

        ``source`` is the reviewed, stricter evaluator. It is validated against
        the evaluator contract and written, sealed and adopted here, in one
        transaction: on any failure every file is put back, so the run stays on
        the parent version with nothing that existed before deleted.

        Preconditions (each an IntegrityError):
          - the mission is running; ``from`` is the contract's eval_version and
            every file of its seal still matches;
          - ``to`` has no suite yet; an ``eval-suites/<to>.py`` already on disk is
            either an unsealed draft (replaced, restored on failure) or sealed with
            exactly ``source``'s bytes (adopted); anything else is refused;
          - ``contract_grounding`` is text the goal contract actually contains, and
            ``evidence`` names what found the artefact.

        Effects: ``eval-suites/<to>.py`` and its seal receipt; EvalSuite ``to``
        (same domains and split, kind=metric_hardening); a BenchmarkUpgrade record
        listing the frontier to re-score; the contract's eval_version and
        eval_script_hash; RunState.current_eval_version, with best_score and
        best_node_id cleared (the best under the parent is not a score under
        ``to``); a ``harden-eval`` DecisionLogEntry naming the parent, the
        rationale, the evidence and the frontier order under the parent.

        No consent: the Monotonic-Honesty Invariant pre-authorizes a harder
        evaluation. A softer one is caught per node by not_softer_than_parent.
        A stricter metric may REORDER the frontier — it caps each node's score,
        it does not preserve rank — so the order before is logged here and the
        order after when the re-score completes.
        """
        from evor.eval_contract_writer import validate

        run_dir = self._run_dir
        base = run_dir / "eval-suites"
        for v in (from_eval_version, to_eval_version):
            if not valid_version(v):
                raise IntegrityError(f"{v!r} is not an eval version (expected v<N>).")
        if proposed_by not in HARDENING_PROPOSERS:
            raise IntegrityError(
                f"proposed_by {proposed_by!r} is not one of {list(HARDENING_PROPOSERS)}."
            )
        if rescore_deadline_ticks < 0:
            raise IntegrityError("rescore_deadline_ticks must be >= 0.")
        try:
            mission = json.loads((run_dir / "mission-state.json").read_text())
        except (OSError, ValueError):
            mission = {}
        if mission.get("status") != "running":
            raise IntegrityError(
                f"the mission is {mission.get('status') or 'not started'!s}, not running; a "
                "hardening is applied by a running mission's tick."
            )

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
            if receipt_files(run_dir, from_eval_version) is None:
                raise IntegrityError(
                    f"the {from_eval_version!r} evaluator has no seal receipt. Verify "
                    f"eval-suites/{from_eval_version}.py against the contract's eval_script_hash "
                    "first (evor_integrity_check reports a mismatch as no_eval_shift); seal it "
                    "only if it matches — a seal records whatever bytes are on disk."
                )
            raise IntegrityError(
                f"the {from_eval_version!r} evaluator, or the score_plugin.py it was sealed "
                "with, changed after its seal; the parent is scored only with its sealed "
                "bytes, so it cannot be hardened."
            )
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
        if not source or not source.strip():
            raise IntegrityError("pass the reviewed hardened evaluator as source.")
        problems = validate(source, target="evaluator")
        if problems:
            raise IntegrityError(
                "hardened evaluator does not conform to the evaluator contract: "
                + "; ".join(problems)
            )

        # ── What is already on disk for <to> ──────────────────────────────
        script = base / f"{to_eval_version}.py"
        source_bytes = source.encode()
        source_sha = hashlib.sha256(source_bytes).hexdigest()
        to_receipt = receipt_files(run_dir, to_eval_version)
        adopt = False
        if to_receipt is not None:
            if sealed_script(run_dir, to_eval_version) is None:
                raise IntegrityError(
                    f"{to_eval_version!r} has a seal receipt that no longer matches its files; "
                    "it cannot be adopted. Harden into a NEW eval_version with this source."
                )
            if to_receipt.get(script.name) != source_sha:
                raise IntegrityError(
                    f"{to_eval_version!r} is already sealed with different bytes than the "
                    "reviewed source. Harden into a NEW eval_version with this source."
                )
            adopt = True

        # The metric is shared: <to> is sealed with the plugin its parent was.
        plugin = base / SCORE_PLUGIN
        plugin_sha = _sha256(plugin) if plugin.exists() else None
        parent_files = receipt_files(run_dir, from_eval_version) or {}
        if parent_files.get(SCORE_PLUGIN) != plugin_sha:
            raise IntegrityError(
                "score_plugin.py differs from the one the parent was sealed with; a "
                "hardening changes the evaluator, never the shared metric under the parent."
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
        lower = fitness_lower_is_better(contract)
        name_of = lambda i: str(nodes.get(i, {}).get("name") or i)  # noqa: E731
        scored = [i for i in frontier if isinstance(nodes.get(i, {}).get("fitness_value"), (int, float))]
        order_before = [
            name_of(i) for i in sorted(scored, key=lambda i: nodes[i]["fitness_value"], reverse=not lower)
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
            proposed_by=proposed_by,  # type: ignore[arg-type]
            proposal_citations=list(evidence),
            consent_granted=True,
            consent_at=now,
            new_domains_added=[],
            domains_removed=[],
            rescore_status="pending" if frontier else "complete",
            rescore_deadline_ticks=rescore_deadline_ticks,
            decision_log_ref="decision-log.md",
            created_at=now,
            kind="metric_hardening",
            rescore_node_ids=frontier,
        )
        parent_best = (state or {}).get("best_score")
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

        files = {script.name: source_sha, **({SCORE_PLUGIN: plugin_sha} if plugin_sha else {})}
        receipt = {
            "eval_version": to_eval_version,
            "hash": source_sha,
            **({"plugin_hash": plugin_sha} if plugin_sha else {}),
            "files": files,
            "sealed_at": now,
            "sealed_by": "evor_harden_eval",
        }
        new_contract = dict(contract)
        new_contract["eval_version"] = to_eval_version
        new_contract["eval_script_hash"] = source_sha
        if plugin_sha:
            new_contract["eval_plugin_hash"] = plugin_sha

        log_text = (
            f"\n## Metric hardening {upgrade_id}\n"
            f"- applied_at: {now}\n"
            f"- parent: {from_eval_version} (stays sealed; its scores are kept)\n"
            f"- from: {from_eval_version} → to: {to_eval_version} (same domains, same split)\n"
            f"- gate: {rationale}\n"
            f"- contract intent: \"{contract_grounding.strip()}\"\n"
            f"- evidence: {', '.join(evidence)}\n"
            f"- consent: pre-authorized by the Monotonic-Honesty Invariant\n"
            f"- best_score under {from_eval_version}: {parent_best} (cleared; recomputed from re-scores)\n"
            f"- frontier order under {from_eval_version}: {', '.join(order_before) or '(none)'}\n"
            f"- rescore: {len(frontier)} frontier node(s) pending\n"
            f"- entry: {entry.model_dump_json()}\n"
        )

        tx = _Transaction()
        try:
            if not adopt:
                tx.write(script, source_bytes)
                tx.write(base / f"{to_eval_version}.sealed.json", json.dumps(receipt, indent=2).encode())
            tx.write(self._suite_path(to_eval_version), suite.model_dump_json(indent=2).encode())
            upgrades_dir = run_dir / "benchmark-upgrades"
            upgrades_dir.mkdir(parents=True, exist_ok=True)
            tx.write(upgrades_dir / f"{upgrade_id}.json", upgrade.model_dump_json(indent=2).encode())
            if state is not None:
                new_state = dict(state)
                new_state["current_eval_version"] = to_eval_version
                new_state.pop("best_score", None)
                new_state.pop("best_node_id", None)
                tx.write(state_path, json.dumps(new_state, indent=2).encode())
            tx.append(self._decision_log_path(), log_text)
            # The contract moves last: until it does, the run is on the parent.
            _write_contract(tx, contract_path, new_contract)
        except BaseException:
            tx.rollback()
            raise

        return {
            "ok": True,
            "upgrade_id": upgrade_id,
            "from_eval_version": from_eval_version,
            "to_eval_version": to_eval_version,
            "adopted_sealed": adopt,
            "rescore": [name_of(i) for i in frontier],
            "frontier_order_before": order_before,
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
        Make ``--to-version`` a metric hardening of the contract's current
        ``--from-version``, with the reviewed evaluator on stdin
        (``--stdin-source``); see apply_hardening(). Called by the
        evor_harden_eval MCP tool.
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
    hd.add_argument("--rescore-deadline-ticks", type=int, default=3)
    hd.add_argument("--stdin-source", action="store_true",
                    help="read the hardened evaluator's source from stdin")

    args = parser.parse_args()

    if args.cmd == "harden":
        try:
            out = BenchmarkManager(Path(args.run_dir)).apply_hardening(
                from_eval_version=args.from_version,
                to_eval_version=args.to_version,
                rationale=args.rationale,
                contract_grounding=args.contract_grounding,
                evidence=args.evidence,
                source=_sys.stdin.read() if args.stdin_source else None,
                proposed_by=args.proposed_by,
                tick=args.tick,
                rescore_deadline_ticks=args.rescore_deadline_ticks,
            )
        except (IntegrityError, OSError) as exc:
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
