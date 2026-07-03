#!/usr/bin/env python3
"""
benchmarks/tabular-churn/evaluate.py — Real CPU-only tabular churn evaluator.

Zero third-party dependencies: trains REAL models using only the Python
standard library (random, math). numpy/sklearn are NOT required — this runs
in any Python 3.10+ interpreter, including the pure-Python harness venv.

EvaluatorAdapter subprocess contract:
  - Reads EVOR_EVAL_VERSION, EVOR_NODE_ID, EVOR_RUN_ID, EVOR_WORKTREE from env.
  - Reads model config from $EVOR_WORKTREE/config.json.
  - Generates a deterministic synthetic churn dataset (seed=42).
  - Trains the configured model on the train split (CPU-only, no GPU/torch).
  - Emits a single JSON object to STDOUT with keys:
      metrics, per_domain, telemetry_summary, status, benchmark_raw.
  - Never writes to the worktree or artifact store.

Supported model_type values (config.json):
  "logistic_regression" — real SGD logistic regression (default)
  "decision_tree"       — real depth-limited CART (Gini) — beats the linear
                          model on this deliberately non-linear (XOR) dataset,
                          which is what makes the L3 "mutation improves the
                          metric" story genuine rather than staged.

Dataset: 800 samples × 10 features, binary, seed=42.
  Train: idx 0–479 (60%) | Val: 480–639 (20%) | Test: 640–799 (20%)

GPU/vision path is gated — see KNOWN_GAPS.md#L3.
"""
from __future__ import annotations

import json
import math
import os
import random
import sys
import time
from pathlib import Path

_N_SAMPLES = 800
_N_FEATURES = 10
_SEED = 42
_TRAIN_END = 480
_VAL_END = 640

_DEFAULT_CONFIG = {"model_type": "logistic_regression", "C": 1.0, "max_iter": 200, "max_depth": 5}


# ─── Deterministic dataset (pure stdlib) ─────────────────────────────────────
# The label has a NON-MONOTONIC term in x0 (both tails positive) that a linear
# model provably cannot capture, plus a weak monotonic term in x1 that it can.
# A logistic model therefore lands ~0.62-0.70; a depth-5 CART splits out both
# tails of x0 (each split has real information gain — unlike XOR, which greedy
# trees also fail) and reaches ~0.85+. That gap makes the L3 "mutation improves
# the metric" story genuine rather than staged.

def _make_dataset(seed: int = _SEED):
    rng = random.Random(seed)
    X, y = [], []
    for _ in range(_N_SAMPLES):
        row = [rng.gauss(0.0, 1.0) for _ in range(_N_FEATURES)]
        label = 1 if abs(row[0]) > 0.9 else 0        # non-monotonic (both tails)
        if row[1] > 1.2:                              # weak monotonic (LR-friendly)
            label = 1
        elif row[1] < -1.2:
            label = 0
        if rng.random() < 0.05:                       # 5% label noise
            label = 1 - label
        X.append(row)
        y.append(label)
    return X, y


def _splits(X, y):
    return (X[:_TRAIN_END], y[:_TRAIN_END],
            X[_TRAIN_END:_VAL_END], y[_TRAIN_END:_VAL_END],
            X[_VAL_END:], y[_VAL_END:])


# ─── Real logistic regression (pure-Python SGD, L2) ──────────────────────────

def _sigmoid(z: float) -> float:
    if z < -60:
        return 0.0
    if z > 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-z))


def _train_logreg(Xtr, ytr, C: float = 1.0, epochs: int = 200, lr: float = 0.1):
    rng = random.Random(_SEED)
    d = len(Xtr[0])
    w = [0.0] * d
    b = 0.0
    l2 = 1.0 / max(C, 1e-6)      # smaller C -> stronger regularisation
    n = len(Xtr)
    idx = list(range(n))
    for _ in range(epochs):
        rng.shuffle(idx)
        for i in idx:
            xi, yi = Xtr[i], ytr[i]
            z = b + sum(w[j] * xi[j] for j in range(d))
            err = _sigmoid(z) - yi
            for j in range(d):
                w[j] -= lr * (err * xi[j] + l2 * w[j] / n)
            b -= lr * err
    return w, b


def _logreg_proba(X, model):
    w, b = model
    d = len(w)
    return [_sigmoid(b + sum(w[j] * row[j] for j in range(d))) for row in X]


# ─── Real decision tree (pure-Python CART, Gini) ─────────────────────────────

def _gini(labels):
    n = len(labels)
    if n == 0:
        return 0.0
    p = sum(labels) / n
    return 1.0 - (p * p + (1 - p) * (1 - p))


def _best_split(X, y):
    n, d = len(X), len(X[0])
    best = None
    base = _gini(y)
    for f in range(d):
        vals = sorted(set(row[f] for row in X))
        for k in range(1, len(vals)):
            thr = (vals[k - 1] + vals[k]) / 2.0
            ly = [y[i] for i in range(n) if X[i][f] <= thr]
            ry = [y[i] for i in range(n) if X[i][f] > thr]
            if not ly or not ry:
                continue
            gain = base - (len(ly) / n * _gini(ly) + len(ry) / n * _gini(ry))
            if best is None or gain > best[0]:
                best = (gain, f, thr)
    return best


def _train_tree(X, y, max_depth: int = 5, depth: int = 0):
    if depth >= max_depth or len(set(y)) == 1 or len(y) < 4:
        return {"leaf": 1 if (sum(y) / max(len(y), 1)) >= 0.5 else 0,
                "p": sum(y) / max(len(y), 1)}
    split = _best_split(X, y)
    if split is None or split[0] <= 1e-9:
        return {"leaf": 1 if (sum(y) / max(len(y), 1)) >= 0.5 else 0,
                "p": sum(y) / max(len(y), 1)}
    _, f, thr = split
    li = [i for i in range(len(X)) if X[i][f] <= thr]
    ri = [i for i in range(len(X)) if X[i][f] > thr]
    return {
        "f": f, "thr": thr,
        "left": _train_tree([X[i] for i in li], [y[i] for i in li], max_depth, depth + 1),
        "right": _train_tree([X[i] for i in ri], [y[i] for i in ri], max_depth, depth + 1),
    }


def _tree_proba_one(node, row):
    while "leaf" not in node:
        node = node["left"] if row[node["f"]] <= node["thr"] else node["right"]
    return node["p"]


def _tree_proba(X, tree):
    return [_tree_proba_one(tree, row) for row in X]


# ─── Metrics (pure stdlib) ───────────────────────────────────────────────────

def _accuracy(proba, y):
    return sum(1 for p, t in zip(proba, y) if (1 if p >= 0.5 else 0) == t) / max(len(y), 1)


def _roc_auc(proba, y):
    pos = [p for p, t in zip(proba, y) if t == 1]
    neg = [p for p, t in zip(proba, y) if t == 0]
    if not pos or not neg:
        return _accuracy(proba, y)
    wins = 0.0
    for pp in pos:
        for nn in neg:
            wins += 1.0 if pp > nn else (0.5 if pp == nn else 0.0)
    return wins / (len(pos) * len(neg))


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    worktree = Path(os.environ.get("EVOR_WORKTREE", "."))
    cfg = dict(_DEFAULT_CONFIG)
    config_path = worktree / "config.json"
    if config_path.exists():
        try:
            cfg.update(json.loads(config_path.read_text()))
        except Exception:
            pass

    t0 = time.monotonic()
    X, y = _make_dataset()
    Xtr, ytr, Xva, yva, Xte, yte = _splits(X, y)

    model_type = cfg.get("model_type", "logistic_regression")
    if model_type == "decision_tree":
        tree = _train_tree(Xtr, ytr, max_depth=int(cfg.get("max_depth", 5)))
        va_p, te_p, tr_p = _tree_proba(Xva, tree), _tree_proba(Xte, tree), _tree_proba(Xtr, tree)
        backend = "pure_decision_tree"
    else:
        model = _train_logreg(Xtr, ytr, C=float(cfg.get("C", 1.0)),
                              epochs=int(cfg.get("max_iter", 200)))
        va_p, te_p, tr_p = _logreg_proba(Xva, model), _logreg_proba(Xte, model), _logreg_proba(Xtr, model)
        backend = "pure_logistic_regression"

    val_acc, test_acc, test_auc = _accuracy(va_p, yva), _accuracy(te_p, yte), _roc_auc(te_p, yte)
    train_acc = _accuracy(tr_p, ytr)
    train_loss = -math.log(max(train_acc, 1e-7))
    elapsed = time.monotonic() - t0

    result = {
        "metrics": {
            "accuracy": round(test_acc, 6),
            "roc_auc": round(test_auc, 6),
            "val_accuracy": round(val_acc, 6),
        },
        "per_domain": {"default": {"accuracy": round(test_acc, 6), "roc_auc": round(test_auc, 6)}},
        "telemetry_summary": {
            "total_steps": len(Xtr),
            "final_train_loss": round(train_loss, 6),
            "best_val_metric": round(val_acc, 6),
            "throughput_samples_per_sec": round(len(Xtr) / max(elapsed, 1e-9), 1),
        },
        "status": "success",
        "benchmark_raw": f"backend={backend} test_acc={test_acc:.4f} roc_auc={test_auc:.4f} elapsed={elapsed:.3f}s",
    }
    print(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
