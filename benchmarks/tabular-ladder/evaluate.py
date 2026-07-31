#!/usr/bin/env python3
"""
benchmarks/tabular-ladder/evaluate.py — CPU-only tabular churn evaluator with a
genuine improvement LADDER (companion to benchmarks/tabular-churn, which is a
fast smoke test but saturates on tick 1 — see task B3).

Zero third-party dependencies: dataset generation, models, and metrics use
only the Python standard library (random, math). No numpy/sklearn/torch.

EvaluatorAdapter subprocess contract — IDENTICAL to tabular-churn/evaluate.py:
  - Reads EVOR_EVAL_VERSION, EVOR_NODE_ID, EVOR_RUN_ID, EVOR_WORKTREE,
    EVOR_TELEMETRY_PATH from env.
  - Generates the deterministic synthetic dataset (seed=42) and frozen
    train/val/test splits itself; the candidate never sees generation code.
  - EXECUTES the candidate's own $EVOR_WORKTREE/train/trainer.py:
        def train(Xtr, ytr, Xva, yva, cfg) -> predict
    predict(X: list[list[float]]) -> list[float] of P(class=1). The candidate
    writes its own telemetry via EVOR_TELEMETRY_PATH.
  - Any failure to load/run the candidate raises -> non-zero exit -> the
    caller records status="error". No fabricated scores.
  - Emits one JSON object to STDOUT: metrics, per_domain, telemetry_summary,
    status, benchmark_raw. Never writes to the worktree/artifact store.

── Dataset design ────────────────────────────────────────────────────────────
10,000 samples x 84 features, binary label. Splits: train 0-5999 (60%),
val 6000-7999 (20%), test 8000-9999 (20% = 2000 samples, comfortably above the
>=1000 floor needed so a single sample can't flip a ranking).

Features 0,1 carry a WEAK MONOTONIC main effect (linear-recoverable).
Features 2,3 carry a CONJUNCTION interaction: bonus applies only when BOTH
x2 > 0.3 AND x3 > 0.3 — a linear model over raw features can only partially
recover this (through the marginal mean-shift each feature gets from the
conjunction), it cannot fully separate it the way a depth>=2 split can.
Features 4-83 (80 of them) are pure Gaussian noise, uncorrelated with the
label — enough of them that an unregularized model has real, measurable
overfitting risk, and a model that filters/regularizes has something real to
gain from doing so.

label ~ Bernoulli(sigmoid(1.5*x0 + 0.8*x1 + 7.0*conj - 1.8)),
  where conj = 1.0 if (x2 > 0.3 and x3 > 0.3) else 0.0.
This is a genuinely probabilistic label (irreducible Bayes noise), not a
deterministic rule plus flips — so no candidate can reach roc_auc = 1.0.
The Bayes-optimal predictor (using the true generating formula) scores
roc_auc ~= 0.918 on the frozen test split — that is the ceiling every
candidate is chasing but cannot reach.

── The improvement ladder (measured, see report) ────────────────────────────
Four reference candidates of increasing sophistication were run through this
evaluator; each rung is a DISTINCT, MEASURABLE roc_auc gain over the last,
with gaps well above the bootstrap noise floor (~0.01 sd at n=2000):

  rung 1 — basic model beating chance:
    plain logistic regression (gradient descent) over all 84 raw features.
    Captures the linear main effects (x0, x1) and part of the conjunction's
    marginal shift, but cannot fully separate the x2/x3 interaction.
    measured roc_auc ~= 0.81   (chance = 0.50, majority-class accuracy = 0.65)

  rung 2 — handling feature interactions:
    a single unregularized CART decision tree (depth 8, min_leaf 3) over all
    84 features. Can split on x2 then x3 to isolate the true conjunction
    region a linear model cannot — but with no regularization and 80 noise
    features, it also spends some of its capacity on spurious noise splits.
    measured roc_auc ~= 0.85   (+0.04 over rung 1)

  rung 3 — handling irrelevant/noisy features:
    a feature-selection pre-filter (rank all 84 features by train-set gini
    gain from their single best split, keep the top 10) followed by a CART
    tree (depth 4, min_leaf 15) restricted to that pool. Filtering out the 80
    noise columns before fitting removes the spurious-split risk rung 2 pays.
    measured roc_auc ~= 0.89   (+0.04 over rung 2)

  rung 4 — regularization / ensembling:
    bagging: 20 bootstrap-resampled CART trees (depth 4, min_leaf 15), each
    restricted to the same top-10 feature pool as rung 3, averaged. Variance
    reduction from the ensemble squeezes out the remaining recoverable
    signal.
    measured roc_auc ~= 0.91   (+0.02 over rung 3, approaching the 0.918
    Bayes ceiling)

A search that is actually working climbs this ladder tick over tick; a search
that is stuck plateaus at whichever rung it already reached — unlike the
tabular-churn mission, there is no depth-4-tree ceiling reachable on tick 1.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import random
import sys
from pathlib import Path

_N_SAMPLES = 10_000
_N_FEATURES = 84  # 0,1 main effect; 2,3 conjunction interaction; 4-83 noise (80)
_SEED = 42
_TRAIN_END = 6_000
_VAL_END = 8_000

_MAIN0_W = 1.5
_MAIN1_W = 0.8
_CONJ_W = 7.0
_INTERCEPT = -1.8
_CONJ_THRESH = 0.3


# ─── Deterministic dataset (pure stdlib) ─────────────────────────────────────

def _make_dataset(seed: int = _SEED):
    rng = random.Random(seed)
    X, y = [], []
    for _ in range(_N_SAMPLES):
        row = [rng.gauss(0.0, 1.0) for _ in range(_N_FEATURES)]
        x0, x1, x2, x3 = row[0], row[1], row[2], row[3]
        conj = 1.0 if (x2 > _CONJ_THRESH and x3 > _CONJ_THRESH) else 0.0
        logit = _MAIN0_W * x0 + _MAIN1_W * x1 + _CONJ_W * conj + _INTERCEPT
        p = 1.0 / (1.0 + math.exp(-logit))
        label = 1 if rng.random() < p else 0
        X.append(row)
        y.append(label)
    return X, y


def _splits(X, y):
    return (X[:_TRAIN_END], y[:_TRAIN_END],
            X[_TRAIN_END:_VAL_END], y[_TRAIN_END:_VAL_END],
            X[_VAL_END:], y[_VAL_END:])


# ─── Metrics (pure stdlib) ───────────────────────────────────────────────────

def _accuracy(proba, y):
    return sum(1 for p, t in zip(proba, y) if (1 if p >= 0.5 else 0) == t) / max(len(y), 1)


def _roc_auc(proba, y):
    """Rank-based AUC, O(n log n) — safe at n=2000+ where the pairwise-sum
    version used by the sibling tabular-churn evaluator would be O(n^2)."""
    combined = sorted(zip(proba, y))
    n = len(combined)
    n_pos = sum(y)
    n_neg = n - n_pos
    if n_pos == 0 or n_neg == 0:
        return _accuracy(proba, y)
    rank_sum_pos = 0.0
    idx = 0
    while idx < n:
        j = idx
        while j < n and combined[j][0] == combined[idx][0]:
            j += 1
        avg_rank = (idx + 1 + j) / 2.0
        for k in range(idx, j):
            if combined[k][1] == 1:
                rank_sum_pos += avg_rank
        idx = j
    return (rank_sum_pos - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


# ─── Candidate execution ─────────────────────────────────────────────────────

def _load_candidate_train(worktree: Path):
    """Import worktree/train/trainer.py and return its train() callable.

    Raises RuntimeError on any contract violation (missing file, missing
    train(), unloadable module) so the caller's failure handling applies
    uniformly to import-time and run-time candidate errors.
    """
    trainer_path = worktree / "train" / "trainer.py"
    if not trainer_path.exists():
        raise RuntimeError(f"candidate worktree missing train/trainer.py: {trainer_path}")

    spec = importlib.util.spec_from_file_location("candidate_trainer", trainer_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load candidate module: {trainer_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    if not hasattr(module, "train") or not callable(module.train):
        raise RuntimeError(
            "train/trainer.py must define train(Xtr, ytr, Xva, yva, cfg) -> predict"
        )
    return module.train


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    worktree = Path(os.environ.get("EVOR_WORKTREE", "."))
    cfg: dict = {}
    config_path = worktree / "config.json"
    if config_path.exists():
        try:
            cfg = json.loads(config_path.read_text())
        except Exception:
            pass

    X, y = _make_dataset()
    Xtr, ytr, Xva, yva, Xte, yte = _splits(X, y)

    train_fn = _load_candidate_train(worktree)
    predict = train_fn(Xtr, ytr, Xva, yva, cfg)
    if predict is None or not callable(predict):
        raise RuntimeError(
            "candidate train() must return a callable predict(X) -> list[float]"
        )

    va_p = predict(Xva)
    te_p = predict(Xte)

    val_acc = _accuracy(va_p, yva)
    test_acc = _accuracy(te_p, yte)
    test_auc = _roc_auc(te_p, yte)

    result = {
        "metrics": {
            "accuracy": round(test_acc, 6),
            "roc_auc": round(test_auc, 6),
            "val_accuracy": round(val_acc, 6),
        },
        "per_domain": {"default": {"accuracy": round(test_acc, 6), "roc_auc": round(test_auc, 6)}},
        "telemetry_summary": {"total_steps": len(Xtr)},
        "status": "success",
        "benchmark_raw": f"test_acc={test_acc:.4f} roc_auc={test_auc:.4f}",
    }
    print(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"evaluate.py: candidate execution failed: {exc}", file=sys.stderr)
        sys.exit(1)
