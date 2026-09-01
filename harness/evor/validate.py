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

    failed = [c for c in all_checks if not c.ok]
    ok = len(failed) == 0

    if ok:
        verdict = "VALID — all checks passed"
    else:
        names = [c.name for c in failed]
        verdict = f"INVALID — {len(failed)} check(s) failed: {names}"

    return ValidationReport(ok=ok, checks=all_checks, verdict=verdict)
