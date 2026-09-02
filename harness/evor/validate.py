"""
harness/evor/validate.py — Programmatic contract/state validator (Phase 2).

Entry point: python -m evor validate --run-id <run_dir>

Returns a ValidationReport with ok=True iff ALL checks pass.
Two-layer gameability check:
  Layer 1 (rule-registry): fast metric-name-based pre-check — always runs.
  Layer 2 (empirical probe): degenerate-predictor probe over the frozen eval
    label vector — runs when labels.json is present, skipped gracefully otherwise.
"""
from __future__ import annotations

import json
import random
import time
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .run_status import REQUIRED_RUN_STATE_FIELDS

# ─── Trivially-gameable metric names (rule-registry fast pre-check) ───────────
# These metrics reach 1.0 (or 0.0) via degenerate all-positive / all-negative
# predictions, making them trivially optimisable WITHOUT learning anything:
#   recall / sensitivity / tpr  → predict all-positive → 1.0
#   specificity / tnr           → predict all-negative → 1.0
#   fpr                         → predict all-negative → 0.0 (lower is better)
#   precision alone             → predict exactly the one highest-confidence true
#                                 positive → 1.0 (degenerate single-sample strategy)
_GAMEABLE_BY_NAME: frozenset[str] = frozenset({
    "recall",
    "precision",
    "sensitivity",
    "specificity",
    "tpr",      # true positive rate  = recall
    "tnr",      # true negative rate  = specificity
    "fpr",      # false positive rate  (lower-is-better gameable)
    "fnr",      # false negative rate  (lower-is-better gameable)
    "hit_rate",
    "miss_rate",
    "pd",       # probability of detection = recall
})

# ─── Pure-Python metric utilities (no numpy, no sklearn, no torch) ────────────

def _counts(y_true: list[int], y_pred: list[int], pos: int = 1) -> tuple[int, int, int, int]:
    """Return (TP, FP, FN, TN) for binary labels."""
    tp = fp = fn = tn = 0
    for t, p in zip(y_true, y_pred):
        if p == pos and t == pos:
            tp += 1
        elif p == pos and t != pos:
            fp += 1
        elif p != pos and t == pos:
            fn += 1
        else:
            tn += 1
    return tp, fp, fn, tn


def _recall(y_true: list[int], y_pred: list[int], pos: int = 1) -> float:
    tp, fp, fn, tn = _counts(y_true, y_pred, pos)
    denom = tp + fn
    return tp / denom if denom else 0.0


def _precision(y_true: list[int], y_pred: list[int], pos: int = 1) -> float:
    tp, fp, fn, tn = _counts(y_true, y_pred, pos)
    denom = tp + fp
    return tp / denom if denom else 0.0


def _f1(y_true: list[int], y_pred: list[int], pos: int = 1) -> float:
    p = _precision(y_true, y_pred, pos)
    r = _recall(y_true, y_pred, pos)
    denom = p + r
    return 2 * p * r / denom if denom else 0.0


def _fbeta(y_true: list[int], y_pred: list[int], beta: float, pos: int = 1) -> float:
    p = _precision(y_true, y_pred, pos)
    r = _recall(y_true, y_pred, pos)
    b2 = beta ** 2
    denom = (1 + b2) * p + b2 * r + r  # simplified: b2*p + b2*r + p*r... fix:
    # F-beta = (1+b2)*P*R / (b2*P + R)
    real_denom = b2 * p + r
    return (1 + b2) * p * r / real_denom if real_denom else 0.0


def _accuracy(y_true: list[int], y_pred: list[int]) -> float:
    if not y_true:
        return 0.0
    return sum(t == p for t, p in zip(y_true, y_pred)) / len(y_true)


def _eval_fitness_formula(formula: str, metrics: dict[str, float]) -> float:
    """Evaluate a fitness formula string over a dict of metric values.

    Only identifiers, numbers, and basic arithmetic (+, -, *, /) are permitted.
    Returns NaN on parse/evaluation error.
    """
    # Whitelist: only allow identifiers, digits, ., +, -, *, /, (, ), spaces
    if re.search(r"[^a-zA-Z0-9_.+\-*/() ]", formula):
        return float("nan")
    try:
        # Allow only the metric variables as names — no builtins
        return float(eval(formula, {"__builtins__": {}}, metrics))  # noqa: S307
    except Exception:
        return float("nan")


def _compute_fitness(
    y_true: list[int],
    y_pred: list[int],
    spec: Any,         # MetricSpec
) -> float:
    """Compute the fitness value for a MetricSpec given binary prediction vectors."""
    pos = 1

    # Named base metrics available to formulas
    tp, fp, fn, tn = _counts(y_true, y_pred, pos)
    n = len(y_true)
    base: dict[str, float] = {
        "accuracy": _accuracy(y_true, y_pred),
        "precision": _precision(y_true, y_pred, pos),
        "recall": _recall(y_true, y_pred, pos),
        "sensitivity": _recall(y_true, y_pred, pos),
        "specificity": (tn / (tn + fp)) if (tn + fp) else 0.0,
        "tpr": _recall(y_true, y_pred, pos),
        "tnr": (tn / (tn + fp)) if (tn + fp) else 0.0,
        "fpr": (fp / (fp + tn)) if (fp + tn) else 0.0,
        "fnr": (fn / (fn + tp)) if (fn + tp) else 0.0,
        "f1": _f1(y_true, y_pred, pos),
    }

    # fbeta mode
    if spec.fbeta is not None and spec.fbeta > 0:
        return _fbeta(y_true, y_pred, spec.fbeta, pos)

    # fitness_formula mode
    if spec.fitness_formula:
        return _eval_fitness_formula(spec.fitness_formula, base)

    # scalar named metric
    name = spec.metric_name.lower()
    return base.get(name, float("nan"))


# ─── Label vector loader ──────────────────────────────────────────────────────

def _load_eval_labels(run_dir: Path) -> tuple[list[int] | None, str | None]:
    """Try to load a binary/multi-class label vector from the frozen test split.

    Looks for (in order):
      frozen-splits/*-test/labels.json  — {"labels": [0,1,1,...], "positive_class": 1}
      frozen-splits/*-test/labels.txt   — one integer label per line

    Returns (labels, None) on success, (None, skip_reason) on failure.
    """
    frozen_dir = run_dir / "frozen-splits"
    if not frozen_dir.exists():
        return None, "frozen-splits/ directory not found"

    # Find any *-test subdirectory
    test_dirs = [d for d in frozen_dir.iterdir() if d.is_dir() and "test" in d.name]
    if not test_dirs:
        return None, "no *-test/ subdirectory found in frozen-splits/"

    for test_dir in sorted(test_dirs):
        labels_json = test_dir / "labels.json"
        labels_txt = test_dir / "labels.txt"

        if labels_json.exists():
            try:
                data = json.loads(labels_json.read_text())
                labels = [int(x) for x in data.get("labels", [])]
                if labels:
                    return labels, None
            except Exception as exc:
                continue

        if labels_txt.exists():
            try:
                lines = labels_txt.read_text().strip().splitlines()
                labels = [int(line.strip()) for line in lines if line.strip()]
                if labels:
                    return labels, None
            except Exception:
                continue

    return None, "no labels.json or labels.txt found in frozen-splits/*-test/"


# ─── Empirical degenerate-predictor probe ─────────────────────────────────────

def probe_metric_gameability(
    goal: Any,  # GoalContract
    run_dir: Path,
) -> dict[str, Any]:
    """Empirically probe whether a degenerate predictor achieves near-target fitness.

    For each degenerate strategy (all-positive, all-negative, majority-class,
    random-seed-42, random-seed-0), the probe computes the primary fitness metric
    WITHOUT any model or training.

    A MetricSpec is gameable if:
      - Any degenerate strategy achieves >= 0.9 * target_value (when target set)
      - OR   any degenerate strategy achieves a fitness above the majority-class
        baseline by more than 5% (when no explicit target)

    AND the MetricSpec has no constraint guard or fitness_formula.

    Returns:
      {
        "gameable": bool,
        "worst_cheater": str | None,
        "score": float | None,
        "reason": str,
        "layer": "probe" | "none",
        "skipped": bool,
        "skip_reason": str | None,
      }
    """
    labels, skip_reason = _load_eval_labels(run_dir)
    if labels is None:
        return {
            "gameable": False,
            "worst_cheater": None,
            "score": None,
            "reason": "empirical probe skipped — label vector not available",
            "layer": "none",
            "skipped": True,
            "skip_reason": skip_reason,
        }

    # Find the primary MetricSpec
    primary_spec = None
    for spec in goal.metric_specs:
        if spec.role == "primary_fitness":
            primary_spec = spec
            break
    if primary_spec is None:
        return {
            "gameable": False,
            "worst_cheater": None,
            "score": None,
            "reason": "no primary_fitness MetricSpec found in goal-contract",
            "layer": "none",
            "skipped": True,
            "skip_reason": "no primary MetricSpec",
        }

    n = len(labels)
    classes = sorted(set(labels))
    pos = 1 if 1 in classes else (classes[-1] if classes else 1)
    majority = max(classes, key=lambda c: labels.count(c)) if classes else 0

    # Build degenerate predictors
    degenerate_preds: list[tuple[str, list[int]]] = [
        ("all-positive", [pos] * n),
        ("all-negative", [c for c in classes if c != pos][:1] * n
                         if len(classes) > 1 else [0] * n),
        ("majority-class", [majority] * n),
    ]
    # random predictors (seeded)
    for seed in (42, 0):
        rng = random.Random(seed)
        degenerate_preds.append((
            f"random-seed-{seed}",
            [rng.choice(classes) for _ in range(n)] if classes else [0] * n,
        ))

    # Check whether primary spec has a guard
    has_constraints = bool(primary_spec.constraints)
    has_formula = bool(primary_spec.fitness_formula)
    has_fbeta = primary_spec.fbeta is not None
    has_guard = has_constraints or has_formula or has_fbeta

    # Compute majority-class baseline fitness
    majority_preds = [majority] * n
    baseline_fitness = _compute_fitness(labels, majority_preds, primary_spec)

    # gameability threshold
    target = goal.target_value
    direction = primary_spec.direction  # "higher" or "lower"

    def _is_gameable(score: float) -> bool:
        if target is not None and target > 0:
            threshold = 0.9 * target
            return score >= threshold if direction == "higher" else score <= threshold
        # No explicit target: flag if degenerate beats majority by >5% trivially
        if direction == "higher":
            return score >= baseline_fitness + 0.05
        else:
            return score <= baseline_fitness - 0.05

    worst_cheater: str | None = None
    worst_score: float | None = None
    gameable = False

    for name, preds in degenerate_preds:
        score = _compute_fitness(labels, preds, primary_spec)
        if not (score == score):  # NaN check
            continue
        if _is_gameable(score):
            if worst_score is None or (
                direction == "higher" and score > worst_score
            ) or (
                direction == "lower" and score < worst_score
            ):
                worst_score = score
                worst_cheater = f"{name} achieves {primary_spec.metric_name}={score:.3f}"
                gameable = True

    if gameable and not has_guard:
        return {
            "gameable": True,
            "worst_cheater": worst_cheater,
            "score": worst_score,
            "reason": (
                f"Degenerate predictor '{worst_cheater}' reaches near-target fitness. "
                f"Add constraints or a fitness_formula guard to MetricSpec "
                f"'{primary_spec.metric_name}'."
            ),
            "layer": "probe",
            "skipped": False,
            "skip_reason": None,
        }

    return {
        "gameable": False,
        "worst_cheater": worst_cheater,
        "score": worst_score,
        "reason": (
            "No degenerate predictor reached the gameability threshold"
            if not gameable
            else f"Guard present: {worst_cheater} flagged but spec has constraint/formula guard"
        ),
        "layer": "probe",
        "skipped": False,
        "skip_reason": None,
    }


# ─── ValidationReport ─────────────────────────────────────────────────────────

@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str


@dataclass
class ValidationReport:
    ok: bool
    checks: list[CheckResult] = field(default_factory=list)
    verdict: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "checks": [
                {"name": c.name, "ok": c.ok, "detail": c.detail}
                for c in self.checks
            ],
            "verdict": self.verdict,
        }


# ─── Individual check helpers ─────────────────────────────────────────────────

def _check_goal_contract(run_dir: Path) -> list[CheckResult]:
    checks: list[CheckResult] = []
    gc_path = run_dir / "goal-contract.json"

    if not gc_path.exists():
        checks.append(CheckResult(
            name="goal_contract_exists",
            ok=False,
            detail="the run's goal contract is missing — the run has not been initialized yet",
        ))
        return checks
    checks.append(CheckResult(
        name="goal_contract_exists",
        ok=True,
        detail="present",
    ))

    try:
        raw = json.loads(gc_path.read_text())
    except json.JSONDecodeError as exc:
        checks.append(CheckResult(
            name="goal_contract_parseable",
            ok=False,
            detail=f"goal-contract.json is not valid JSON: {exc}",
        ))
        return checks
    checks.append(CheckResult(
        name="goal_contract_parseable",
        ok=True,
        detail="JSON parsed successfully",
    ))

    try:
        from evor.contracts import GoalContract
        gc = GoalContract.model_validate(raw)
    except Exception as exc:
        checks.append(CheckResult(
            name="goal_contract_schema",
            ok=False,
            detail=f"the goal contract failed its schema check: {exc}",
        ))
        return checks
    checks.append(CheckResult(
        name="goal_contract_schema",
        ok=True,
        detail="Schema validation passed",
    ))

    # Required non-null fields
    missing = []
    if not gc.task_description:
        missing.append("task_description")
    if not gc.mission_type:
        missing.append("mission_type")
    if not gc.metric_specs:
        missing.append("metric_specs (empty list)")

    if missing:
        checks.append(CheckResult(
            name="goal_contract_required_fields",
            ok=False,
            detail=f"Required fields empty or missing: {missing}",
        ))
    else:
        checks.append(CheckResult(
            name="goal_contract_required_fields",
            ok=True,
            detail="All required fields present",
        ))

    # stop_condition or (baseline + target)
    has_stop = gc.stop_condition is not None
    has_bt = gc.baseline_value is not None
    if not (has_stop or has_bt):
        checks.append(CheckResult(
            name="goal_contract_stop_defined",
            ok=False,
            detail="Neither stop_condition nor baseline_value is defined",
        ))
    else:
        checks.append(CheckResult(
            name="goal_contract_stop_defined",
            ok=True,
            detail=(
                f"Stop defined: stop_condition={'present' if has_stop else 'absent'}, "
                f"baseline_value={gc.baseline_value!r}"
            ),
        ))

    # Integrity anchor checks
    if not gc.locked_split_hash:
        checks.append(CheckResult(
            name="goal_contract_split_anchor",
            ok=False,
            detail="the frozen split has not been sealed — re-run the freeze step before locking",
        ))
    else:
        checks.append(CheckResult(
            name="goal_contract_split_anchor",
            ok=True,
            detail="split anchor present",
        ))

    if not gc.eval_script_hash:
        checks.append(CheckResult(
            name="goal_contract_eval_anchor",
            ok=False,
            detail="the evaluation script has not been sealed — write the canonical evaluator and seal it before locking",
        ))
    else:
        checks.append(CheckResult(
            name="goal_contract_eval_anchor",
            ok=True,
            detail="eval-script anchor present",
        ))

    # Gameability checks (two layers)
    checks.extend(_check_gameability_registry(gc))
    checks.extend(_check_gameability_probe(gc, run_dir))

    return checks


def _check_gameability_registry(gc: Any) -> list[CheckResult]:
    """Layer 1 (fast): rule-registry check — metric name alone signals gameability."""
    issues: list[str] = []
    for spec in gc.metric_specs:
        if spec.role != "primary_fitness":
            continue
        name_lower = spec.metric_name.lower()
        if name_lower not in _GAMEABLE_BY_NAME:
            continue
        has_guard = bool(spec.constraints) or bool(spec.fitness_formula) or (spec.fbeta is not None)
        if not has_guard:
            issues.append(
                f"primary metric '{spec.metric_name}' is in the gameable-metric registry "
                f"(predict-all-{spec.metric_name.split('_')[0]} → trivial optimum) "
                f"but has no constraint, fitness_formula, or fbeta guard. "
                f"Suggested fix: add "
                f"constraints=[MetricConstraint(metric='precision', op='>=', threshold=0.5)] "
                f"or use fitness_formula='0.7*{spec.metric_name}+0.3*precision'."
            )
    if issues:
        return [CheckResult(
            name="metric_gameability_registry",
            ok=False,
            detail=" | ".join(issues),
        )]
    return [CheckResult(
        name="metric_gameability_registry",
        ok=True,
        detail="No unguarded gameable primary metrics in rule-registry",
    )]


def _check_gameability_probe(gc: Any, run_dir: Path) -> list[CheckResult]:
    """Layer 2 (empirical): degenerate-predictor probe over the frozen eval labels."""
    try:
        result = probe_metric_gameability(gc, run_dir)
    except Exception as exc:
        # fail-open: probe errors must not crash the validator
        return [CheckResult(
            name="metric_gameability_probe",
            ok=True,  # fail-open
            detail=f"probe raised an unexpected error (fail-open): {exc}",
        )]

    if result["skipped"]:
        return [CheckResult(
            name="metric_gameability_probe",
            ok=True,  # not a hard fail when labels unavailable
            detail=f"skipped — {result['skip_reason']}",
        )]

    if result["gameable"]:
        return [CheckResult(
            name="metric_gameability_probe",
            ok=False,
            detail=result["reason"],
        )]
    return [CheckResult(
        name="metric_gameability_probe",
        ok=True,
        detail=result["reason"],
    )]


def _check_frozen_splits(run_dir: Path) -> list[CheckResult]:
    checks: list[CheckResult] = []
    frozen_dir = run_dir / "frozen-splits"

    if not frozen_dir.exists():
        checks.append(CheckResult(
            name="frozen_splits_dir",
            ok=False,
            detail="the frozen eval splits are missing — freeze the test/val splits first",
        ))
        return checks
    checks.append(CheckResult(
        name="frozen_splits_dir",
        ok=True,
        detail="present",
    ))

    test_jsons = sorted(frozen_dir.glob("*-test.json"))
    if not test_jsons:
        checks.append(CheckResult(
            name="frozen_splits_test_json",
            ok=False,
            detail="no frozen test split was found — freeze the test/val splits first",
        ))
        return checks
    checks.append(CheckResult(
        name="frozen_splits_test_json",
        ok=True,
        detail=f"{len(test_jsons)} frozen test split(s) present",
    ))

    missing_hash: list[str] = []
    for test_json in test_jsons:
        try:
            data = json.loads(test_json.read_text())
            if not data.get("split_hash"):
                missing_hash.append(test_json.name)
        except Exception:
            missing_hash.append(f"{test_json.name} (unparseable)")

    if missing_hash:
        checks.append(CheckResult(
            name="frozen_splits_hash",
            ok=False,
            detail=f"{len(missing_hash)} frozen test split(s) are missing their integrity hash",
        ))
    else:
        checks.append(CheckResult(
            name="frozen_splits_hash",
            ok=True,
            detail="split_hash present in all test split files",
        ))

    return checks


def _check_tree(run_dir: Path) -> list[CheckResult]:
    checks: list[CheckResult] = []
    tree_path = run_dir / "tree.json"

    if not tree_path.exists():
        checks.append(CheckResult(
            name="tree_json_exists",
            ok=False,
            detail="the run's evolution tree is missing",
        ))
        return checks
    checks.append(CheckResult(
        name="tree_json_exists",
        ok=True,
        detail="present",
    ))

    try:
        data = json.loads(tree_path.read_text())
    except json.JSONDecodeError as exc:
        checks.append(CheckResult(
            name="tree_json_parseable",
            ok=False,
            detail=f"tree.json is not valid JSON: {exc}",
        ))
        return checks
    checks.append(CheckResult(
        name="tree_json_parseable",
        ok=True,
        detail="JSON parsed",
    ))

    nodes_val = data.get("nodes")
    if isinstance(nodes_val, dict):
        checks.append(CheckResult(
            name="tree_json_dict_format",
            ok=True,
            detail=f"DICT format confirmed ({len(nodes_val)} nodes)",
        ))
    else:
        checks.append(CheckResult(
            name="tree_json_dict_format",
            ok=False,
            detail=f"tree.json.nodes is {type(nodes_val).__name__!r}, expected dict",
        ))

    return checks


def _check_run_state(run_dir: Path) -> list[CheckResult]:
    checks: list[CheckResult] = []
    rs_path = run_dir / "run-state.json"

    if not rs_path.exists():
        checks.append(CheckResult(
            name="run_state_exists",
            ok=False,
            detail="the run state is missing — the run has not been initialized yet",
        ))
        return checks
    checks.append(CheckResult(
        name="run_state_exists",
        ok=True,
        detail="present",
    ))

    try:
        data = json.loads(rs_path.read_text())
    except json.JSONDecodeError as exc:
        checks.append(CheckResult(
            name="run_state_parseable",
            ok=False,
            detail=f"run-state.json is not valid JSON: {exc}",
        ))
        return checks

    required = REQUIRED_RUN_STATE_FIELDS
    missing = [f for f in required if f not in data]
    if missing:
        checks.append(CheckResult(
            name="run_state_well_formed",
            ok=False,
            detail=f"run-state.json missing fields: {missing}",
        ))
    else:
        checks.append(CheckResult(
            name="run_state_well_formed",
            ok=True,
            detail=f"well-formed (status={data.get('status')!r}, tick={data.get('tick_count')})",
        ))

    return checks


# ─── Main validate_run ─────────────────────────────────────────────────────────

def _check_stop_reachable(run_dir: Path) -> list[CheckResult]:
    """Is there any state this run could reach that would stop it? (Item 9.3.)

    K-06 / K-07 / L-05. A stop condition that cannot be met is not a stop
    condition — the mission has no exit, and nothing says so until someone
    notices hours later that it is still going. These are all checkable at
    init, from the contract alone, which is the only moment fixing them is cheap.
    """
    out: list[CheckResult] = []
    gc_path = run_dir / "goal-contract.json"
    if not gc_path.exists():
        return out
    try:
        gc = json.loads(gc_path.read_text())
    except Exception:  # noqa: BLE001
        return out

    stop = gc.get("stop_condition") or {}
    stop_type = str(stop.get("stop_type") or stop.get("type") or "")
    coverage_target = gc.get("coverage_target")
    if coverage_target is None:
        coverage_target = stop.get("coverage_target")

    # ── K-06: coverage-target stops ──────────────────────────────────────────
    if coverage_target is not None:
        try:
            target = float(coverage_target)
        except (TypeError, ValueError):
            target = None
        if target is not None and not (0.0 < target <= 1.0):
            out.append(CheckResult(
                name="coverage_target_reachable",
                ok=False,
                detail=(
                    f"coverage_target={target} is outside (0, 1]. Coverage is a fraction "
                    "of the angle registry, so no run can ever reach it and the mission "
                    "has no exit."
                ),
            ))
        elif stop_type in ("coverage-target", "coverage_target"):
            registry = _angle_registry_size(run_dir)
            if registry == 0:
                out.append(CheckResult(
                    name="coverage_target_reachable",
                    ok=False,
                    detail=(
                        "the stop condition is coverage-target but the angle registry is "
                        "EMPTY. Coverage over nothing is undefined, so the run has no "
                        "reachable termination criterion."
                    ),
                ))
            else:
                out.append(CheckResult(
                    name="coverage_target_reachable", ok=True,
                    detail=f"coverage_target={target} over {registry} angle(s)",
                ))

    budget = gc.get("budget") or {}

    # ── K-06: a circuit breaker below the advertised iteration budget ────────
    breaker = budget.get("circuit_breaker")
    max_iter = budget.get("max_iterations")
    if isinstance(breaker, int) and isinstance(max_iter, int) and 0 < breaker < max_iter:
        out.append(CheckResult(
            name="circuit_breaker_consistent",
            ok=False,
            detail=(
                f"circuit_breaker={breaker} trips long before max_iterations={max_iter}. "
                "The advertised budget is unreachable: the run stops at "
                f"{breaker} consecutive non-improving ticks, so the other "
                f"{max_iter - breaker} are budget the mission can never spend."
            ),
        ))

    # ── K-07: a zero cost ceiling ───────────────────────────────────────────
    # `0` currently means UNLIMITED in a three-way doc/code/type collision, which
    # is the most expensive possible reading of a field an operator sets to zero
    # when they mean "do not spend".
    if "max_cost_usd" in budget:
        try:
            ceiling = float(budget["max_cost_usd"])
        except (TypeError, ValueError):
            ceiling = None
        if ceiling is not None and ceiling <= 0:
            out.append(CheckResult(
                name="cost_ceiling_enforceable",
                ok=False,
                detail=(
                    f"max_cost_usd={budget['max_cost_usd']} disables the spend ceiling. "
                    "Zero is read as 'unlimited' by the stop path — the opposite of what "
                    "an operator setting it to zero means. Set a positive ceiling, or "
                    "omit the field to accept the default."
                ),
            ))
        else:
            out.append(CheckResult(
                name="cost_ceiling_enforceable", ok=True,
                detail=f"max_cost_usd={budget['max_cost_usd']}",
            ))

    return out


def _angle_registry_size(run_dir: Path) -> int:
    """How many angles this run's registry declares. 0 when there is none."""
    for candidate in ("angle-registry.json", "angles.json"):
        path = run_dir / candidate
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text())
        except Exception:  # noqa: BLE001
            continue
        angles = data.get("angles") if isinstance(data, dict) else data
        if isinstance(angles, (list, dict)):
            return len(angles)
    return 0


def _check_gate_feasible(run_dir: Path) -> list[CheckResult]:
    """Can a candidate satisfy the gates this contract sets? (Items 9.3 / L-05.)

    Two failures, both discovered late in the field:

      An out-of-RANGE threshold — `precision >= 1.5` — that no candidate can meet
      because the metric cannot take that value.

      An out-of-REACH threshold: a precision floor of 0.80 against a measured
      incumbent of 0.0040, two hundred times below it. Every candidate was
      penalised to fitness 0.0 and the run had no way to succeed. That was
      discovered 26 hours in; the incumbent's own measurement was on disk the
      whole time.
    """
    out: list[CheckResult] = []
    gc_path = run_dir / "goal-contract.json"
    if not gc_path.exists():
        return out
    try:
        gc = json.loads(gc_path.read_text())
    except Exception:  # noqa: BLE001
        return out

    baseline = None
    baseline_path = run_dir / "baseline-eval.json"
    if baseline_path.exists():
        try:
            baseline = json.loads(baseline_path.read_text())
        except Exception:  # noqa: BLE001
            baseline = None

    #: Metrics bounded to [0, 1] by definition. A threshold outside that is not
    #: a demanding gate, it is an unmeetable one.
    BOUNDED = ("precision", "recall", "fmeasure", "f1", "accuracy", "iou", "auc", "coverage")

    for spec in gc.get("metric_specs") or []:
        for constraint in (spec.get("constraints") or []):
            metric = str(constraint.get("metric", ""))
            op = str(constraint.get("op", ""))
            try:
                threshold = float(constraint.get("threshold"))
            except (TypeError, ValueError):
                continue

            if any(b in metric.lower() for b in BOUNDED) and op in (">=", ">") and threshold > 1.0:
                out.append(CheckResult(
                    name=f"constraint_in_range:{metric}",
                    ok=False,
                    detail=(
                        f"{metric} {op} {threshold} can never be satisfied: {metric} is "
                        "bounded above by 1.0. Every candidate is penalised to fitness 0.0 "
                        "regardless of how good it is."
                    ),
                ))
                continue

            measured = _measured_metric(baseline, metric)
            if measured is not None and op in (">=", ">") and threshold > 0 and measured >= 0:
                # A gate far above the measured incumbent is a research goal
                # stated as a gameability guard. 10x is deliberately generous —
                # this exists to catch 200x, not to police ambition.
                if measured > 0 and threshold / measured >= 10:
                    out.append(CheckResult(
                        name=f"constraint_satisfiable:{metric}",
                        ok=False,
                        detail=(
                            f"{metric} {op} {threshold} is {threshold / measured:.0f}x the "
                            f"measured incumbent ({measured}). As a hard constraint this "
                            "penalises every candidate to fitness 0.0, so the run cannot "
                            "succeed. Declare it as a goal (purpose='goal') rather than a "
                            "floor, or set a floor the incumbent can approach."
                        ),
                    ))
                elif measured == 0 and threshold > 0:
                    out.append(CheckResult(
                        name=f"constraint_satisfiable:{metric}",
                        ok=False,
                        detail=(
                            f"{metric} {op} {threshold} against a measured incumbent of 0. "
                            "Nothing in the run has ever produced a non-zero value for this "
                            "metric, so the floor cannot currently be cleared by anything."
                        ),
                    ))
    return out


def _measured_metric(baseline: Optional[dict], metric: str) -> Optional[float]:
    """The incumbent's worst measured value for `metric`, across domains.

    Worst rather than mean: a per-domain floor binds on the weakest domain, and
    that is the number the gate has to clear.
    """
    if not baseline:
        return None
    values: list[float] = []
    top = (baseline.get("metrics") or {}).get(metric)
    if isinstance(top, (int, float)):
        values.append(float(top))
    for per_domain in (baseline.get("per_domain") or {}).values():
        v = (per_domain or {}).get(metric)
        if isinstance(v, (int, float)):
            values.append(float(v))
    return min(values) if values else None


def _check_liveness(run_dir: Path) -> list[CheckResult]:
    """Is this run actually alive, and do its state files agree? (C-01, item 3.3.)

    The field run's `run-state.json` read `status: running` after 8 hours of no
    activity, and its `mission-state.json` was 2h07m behind its own
    `tick-state.json`. Neither was reported, because "is this still alive?"
    required an event nobody emitted.

    3.3 made it arithmetic: `max_dwell_s` per state, compared against how long
    the entity has sat there. This is that predicate applied to a run's files at
    validation time, using mtime as the activity signal — a file nobody has
    written in eight hours is not being written by a live loop, whatever its
    `status` field says.

    A missing timestamp is NOT stale. An unknown age is not evidence of death,
    which is A6's mistake with the sign flipped.
    """
    out: list[CheckResult] = []
    state_files = ["run-state.json", "tick-state.json", "mission-state.json"]
    present = [(n, run_dir / n) for n in state_files if (run_dir / n).exists()]
    if not present:
        return out

    now = time.time()
    ages = {name: (now - path.stat().st_mtime) for name, path in present}
    freshest = min(ages.values())

    # The dwell budget for a tick that is running, from the shared FSM table —
    # the same number `stop.mjs` and `stateRead` use, so the three languages
    # cannot disagree about when a run has stalled.
    try:
        from .fsm import max_dwell_s
        limit = max_dwell_s("tick", "running") or 7200
    except Exception:  # noqa: BLE001
        limit = 7200

    claims_running = False
    for name, path in present:
        try:
            if str(json.loads(path.read_text()).get("status", "")) == "running":
                claims_running = True
        except Exception:  # noqa: BLE001
            continue

    if claims_running and freshest > limit:
        out.append(CheckResult(
            name="run_not_stale",
            ok=False,
            detail=(
                f"this run reports status=running but no state file has been written "
                f"for {freshest / 3600:.1f}h (limit {limit / 3600:.1f}h). A file nobody "
                "has written is not being written by a live loop."
            ),
        ))
    else:
        out.append(CheckResult(
            name="run_not_stale", ok=True,
            detail=f"most recent state write {freshest / 60:.0f} min ago",
        ))

    # ── mission-state lagging tick-state ────────────────────────────────────
    #
    # Separate from staleness: both files can be recent while one is hours behind
    # the other, and a mission whose own record trails its tick loop by two hours
    # is describing a run that has moved on without it.
    if "mission-state.json" in ages and "tick-state.json" in ages:
        lag = ages["mission-state.json"] - ages["tick-state.json"]
        if lag > limit / 2:
            out.append(CheckResult(
                name="mission_state_current",
                ok=False,
                detail=(
                    f"mission-state.json is {lag / 3600:.1f}h older than tick-state.json. "
                    "The mission's own record trails its tick loop, so anything reading "
                    "mission state is reading a run that has moved on without it."
                ),
            ))
        else:
            out.append(CheckResult(
                name="mission_state_current", ok=True,
                detail=f"mission-state within {abs(lag) / 60:.0f} min of tick-state",
            ))

    return out


def validate_run(run_dir: Path) -> ValidationReport:
    """Validate all contracts and state for a run directory.

    Checks (in order):
      1. goal-contract.json exists + GoalContract schema validation
      2. Required GoalContract fields non-null
      3. stop_condition or (baseline + target) defined
      4. MetricSpec gameability guard — layer 1 (rule-registry)
      5. MetricSpec gameability guard — layer 2 (empirical probe, skip if no labels)
      6. frozen-splits/*-test.json exists with split_hash
      7. tree.json DICT format
      8. run-state.json well-formed

    Returns ValidationReport with ok=True iff all checks pass.
    """
    run_dir = Path(run_dir)
    all_checks: list[CheckResult] = []

    all_checks.extend(_check_goal_contract(run_dir))
    all_checks.extend(_check_frozen_splits(run_dir))
    all_checks.extend(_check_tree(run_dir))
    all_checks.extend(_check_run_state(run_dir))
    # Items 9.3 / K-06 / K-07 / L-05: a run whose stop condition cannot be met,
    # or whose gates cannot be satisfied, has no exit. All of it is checkable
    # from the contract at init — the only moment fixing it is cheap.
    all_checks.extend(_check_stop_reachable(run_dir))
    all_checks.extend(_check_gate_feasible(run_dir))
    # C-01 / item 3.3: a run that claims to be running while nothing has written
    # its state for hours is not running; nothing was asking.
    all_checks.extend(_check_liveness(run_dir))

    failed = [c for c in all_checks if not c.ok]
    ok = len(failed) == 0

    if ok:
        verdict = "VALID — all checks passed"
    else:
        names = [c.name for c in failed]
        verdict = f"INVALID — {len(failed)} check(s) failed: {names}"

    return ValidationReport(ok=ok, checks=all_checks, verdict=verdict)
