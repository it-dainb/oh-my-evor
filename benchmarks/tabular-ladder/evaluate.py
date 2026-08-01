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

── Dataset design (v2 — see task S2) ─────────────────────────────────────────
v1 of this dataset (one weak linear main effect + ONE conjunction interaction)
saturated in practice: a real agent run's very first tick — feature selection
followed by a bagged-tree ensemble, exactly the "obvious" first attempt any
able agent reaches for — landed AT the v1 Bayes ceiling (roc_auc 0.918) on
attempt 1, because a handful of shallow bagged trees have more than enough
capacity to fully represent "2 linear terms + 1 pairwise conjunction". There
was nothing left to search for. v2 fixes this by giving the label FOUR
independent pairwise conjunctions instead of one, plus a rare, high-weight
subpopulation — structure that a small ensemble of independently-bootstrapped
SHALLOW trees (the "obvious first attempt") cannot jointly represent, because
each individual tree's depth budget only fits one or two of the four
interactions, but that residual/complementary structure IS recoverable by a
stage-wise learner (gradient boosting) that explicitly fits what earlier
rounds got wrong.

10,000 samples x 90 features, binary label. Splits: train 0-5999 (60%),
val 6000-7999 (20%), test 8000-9999 (20% = 2000 samples, comfortably above the
>=1000 floor needed so a single sample can't flip a ranking).

Features 0,1 carry a WEAK MONOTONIC main effect (linear-recoverable).
Four independent pairwise CONJUNCTIONS, each on its own feature pair —
(x2,x3), (x4,x5), (x6,x7), (x9,x10) — each contributing a bonus only when
BOTH features in the pair exceed 0.3. They are otherwise unrelated: no single
tree of depth < ~8 can isolate all four in one path, so a single shallow tree
(rung 2/3) fits at most one, and a bootstrap-bagged ensemble of shallow trees
(rung 4) fits whichever subset the greedy split search happens to find first
in each bootstrap — usually the same one or two, since the pairs have equal
signal strength and no randomized per-split feature subsampling is used to
decorrelate the trees.
Feature 8 carries a RARE, high-weight subpopulation effect: x8 > 2.2 (~1.4%
of samples) adds a large positive bonus — a small but genuinely informative
subgroup, not noise.
Features 11-89 (79 of them) are pure Gaussian noise, uncorrelated with the
label.

label ~ Bernoulli(sigmoid(
    1.2*x0 + 0.6*x1
  + 3.0*conj1 + 3.0*conj2 + 3.0*conj3 + 3.0*conj4
  + 4.0*rare - 2.9)),
  where conj_k = 1.0 if (both features of pair k are > 0.3) else 0.0,
  rare = 1.0 if x8 > 2.2 else 0.0.
This is a genuinely probabilistic label (irreducible Bayes noise), not a
deterministic rule plus flips — so no candidate can reach roc_auc = 1.0.
The Bayes-optimal predictor (using the true generating formula) scores
roc_auc ~= 0.906 on the frozen test split — that is the ceiling every
candidate is chasing but cannot reach. (Measured separately: a logistic
regression fit — not given, but EMPIRICALLY LEARNED from the 6000 train rows —
on the exact true derived features (x0, x1, conj1..4, rare) reaches roc_auc
~= 0.897, i.e. the 0.906 ceiling is reachable up to ordinary finite-sample
noise once you have the right features; the remaining gap for a raw-feature
learner is closeable by genuinely better search, not by dataset noise.)

── The improvement ladder (measured, see report) ────────────────────────────
Reference candidates of increasing sophistication were run through this
evaluator; each rung is a DISTINCT, MEASURABLE roc_auc gain over the last,
with gaps well above the bootstrap noise floor (~0.01 sd at n=2000):

  rung 1 — basic model beating chance:
    plain logistic regression (gradient descent) over all 90 raw features.
    Captures the two linear main effects and part of each conjunction's
    marginal mean-shift, but cannot separate any of the four interactions.
    measured roc_auc ~= 0.767

  rung 2 — handling feature interactions:
    a single unregularized CART decision tree (depth 5, min_leaf 5) over all
    90 features. Can isolate at most one or two of the four conjunctions in
    its depth budget, and spends some capacity on spurious noise splits.
    measured roc_auc ~= 0.782   (+0.015 over rung 1)

  rung 3 — handling irrelevant/noisy features:
    a feature-selection pre-filter (rank all 90 features by train-set gini
    gain from their single best split, keep the top 14) followed by a CART
    tree (depth 7, min_leaf 15) restricted to that pool. Filtering out noise
    columns before fitting, and affording more depth, recovers more of the
    conjunction structure than rung 2's unrestricted-but-shallower tree.
    measured roc_auc ~= 0.810   (+0.028 over rung 2)

  rung 4 — regularization / ensembling ("the strong obvious first attempt"):
    bagging: 20 bootstrap-resampled CART trees (depth 4, min_leaf 15), each
    restricted to the same top-14 feature pool as rung 3, averaged. This is
    the ensemble an able agent reaches for immediately — and it is measurably
    NOT the ceiling: each bootstrap's greedy shallow tree tends to lock onto
    the same one or two conjunctions, so averaging many similar trees mostly
    reduces variance, not bias. It reaches roughly 85% of the way from chance
    to the Bayes ceiling, not 100%.
    measured roc_auc ~= 0.844   (+0.034 over rung 3; ~0.85 of the way from
    chance (0.5) to the 0.906 ceiling — well short of saturating)

  rung 5 — sequential residual fitting (gradient boosting):
    gradient boosting in logit space: 40 rounds of depth-3 regression trees
    over the rung-3/4 feature pool, each round fit to the CURRENT residual
    (what earlier rounds got wrong). Because each round targets what's still
    unexplained, successive rounds pick up the conjunctions rung 4's bagging
    left on the table, closing much of the remaining gap to the ceiling.
    measured roc_auc ~= 0.869   (+0.024 over rung 4)

NOTE on headroom above rung 5 (measured, reported honestly): an oracle
logistic regression EMPIRICALLY FIT (not hand-specified) on the exact true
derived features (x0, x1, the four conj indicators, rare) reaches roc_auc
~= 0.897 on this split — confirming the 0.906 ceiling is reachable up to
ordinary finite-sample noise, i.e. real headroom exists above rung 5. But
every raw-feature technique tried to close that gap WITHOUT cheating (an
agent doesn't get to see the generating function) — more boosting rounds/
depth, an ensemble of several bootstrap-resampled boosted models, and
data-driven pairwise-interaction feature search (which correctly recovers
all four true conjunction pairs by gini gain alone) followed by either
logistic regression or boosting on the augmented features — landed at or
BELOW rung 5's 0.869, not above it. None of these produced a further rung
whose gap over rung 5 clears the bootstrap noise floor. So this ladder ships
with 5 measured rungs, not 6: one clean, well-separated improvement (rung 5)
above the strong first attempt, not two.

A search that is actually working climbs this ladder tick over tick; a search
that is stuck plateaus at whichever rung it already reached — unlike v1, the
strong "obvious first attempt" (rung 4) lands well short of the ceiling
(~0.85 of the way from chance to Bayes-optimal, not ~1.0), and rung 5 gives
a search process a genuine, measurable further improvement to find.
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
# 0,1 main effect; (2,3),(4,5),(6,7),(9,10) four independent pairwise
# conjunctions; 8 rare high-weight subpopulation; 11-89 noise (79).
_N_FEATURES = 90
_SEED = 42
_TRAIN_END = 6_000
_VAL_END = 8_000

_MAIN0_W = 1.2
_MAIN1_W = 0.6
_CONJ_W = 3.0  # shared weight for all four independent conjunctions
_RARE_W = 4.0
_RARE_THRESH = 2.2  # gauss(0,1) > 2.2 -> ~1.4% of samples
_INTERCEPT = -2.9
_CONJ_THRESH = 0.3
_CONJ_PAIRS = ((2, 3), (4, 5), (6, 7), (9, 10))


def _conjunctions(row):
    return [1.0 if (row[a] > _CONJ_THRESH and row[b] > _CONJ_THRESH) else 0.0
            for a, b in _CONJ_PAIRS]


# ─── Deterministic dataset (pure stdlib) ─────────────────────────────────────

def _make_dataset(seed: int = _SEED):
    rng = random.Random(seed)
    X, y = [], []
    for _ in range(_N_SAMPLES):
        row = [rng.gauss(0.0, 1.0) for _ in range(_N_FEATURES)]
        conjs = _conjunctions(row)
        rare = 1.0 if row[8] > _RARE_THRESH else 0.0
        logit = (_MAIN0_W * row[0] + _MAIN1_W * row[1] + _CONJ_W * sum(conjs)
                  + _RARE_W * rare + _INTERCEPT)
        p = 1.0 / (1.0 + math.exp(-logit))
        label = 1 if rng.random() < p else 0
        X.append(row)
        y.append(label)
    return X, y


def _splits(X, y):
    return (X[:_TRAIN_END], y[:_TRAIN_END],
            X[_TRAIN_END:_VAL_END], y[_TRAIN_END:_VAL_END],
            X[_VAL_END:], y[_VAL_END:])


def _bayes_predict(X):
    """The true generating probability for each row — the Bayes-optimal
    predictor. Exposed so tests/tooling can compute the exact roc_auc ceiling
    without duplicating the generating formula."""
    out = []
    for row in X:
        conjs = _conjunctions(row)
        rare = 1.0 if row[8] > _RARE_THRESH else 0.0
        logit = (_MAIN0_W * row[0] + _MAIN1_W * row[1] + _CONJ_W * sum(conjs)
                  + _RARE_W * rare + _INTERCEPT)
        out.append(1.0 / (1.0 + math.exp(-logit)))
    return out


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
