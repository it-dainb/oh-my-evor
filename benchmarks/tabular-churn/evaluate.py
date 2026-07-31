#!/usr/bin/env python3
"""
benchmarks/tabular-churn/evaluate.py — Real CPU-only tabular churn evaluator.

Zero third-party dependencies: dataset generation and metrics use only the
Python standard library (random, math). numpy/sklearn are NOT required.

EvaluatorAdapter subprocess contract:
  - Reads EVOR_EVAL_VERSION, EVOR_NODE_ID, EVOR_RUN_ID, EVOR_WORKTREE,
    EVOR_TELEMETRY_PATH from env (all injected by EvaluatorAdapter).
  - Generates the deterministic synthetic churn dataset (seed=42) and the
    frozen train/val/test splits — this is the evaluator's job, not the
    candidate's, so every candidate is scored on the same held-out data.
  - EXECUTES the CANDIDATE'S OWN code at $EVOR_WORKTREE/train/trainer.py.
    This evaluator does NOT reimplement or retrain a model of its own — it
    only wires the candidate's train() into the frozen splits and scores
    whatever comes back. That is the whole point of an evaluator: score the
    candidate, not a stand-in.
  - Candidate contract (train/trainer.py):
        def train(Xtr, ytr, Xva, yva, cfg) -> predict
    where cfg is the parsed $EVOR_WORKTREE/config.json (or {} if absent) and
    predict is a callable predict(X: list[list[float]]) -> list[float] of
    P(class=1). The candidate is responsible for writing its own telemetry
    via the env-path pattern (EVOR_TELEMETRY_PATH + open(...,"a")) — see
    harness/evor/telemetry.py — since only the candidate's training loop
    knows its real per-step loss/grad_norm.
  - Any failure to load or run the candidate (missing train/trainer.py, an
    exception during train(), a non-callable return value) raises, which
    exits non-zero: EvaluatorAdapter records status="error" for that node.
    This evaluator never emits a silent/fabricated score.
  - Emits a single JSON object to STDOUT with keys:
      metrics, per_domain, telemetry_summary, status, benchmark_raw.
  - Never writes to the worktree or artifact store itself.

Dataset: 800 samples x 10 features, binary, seed=42.
  Train: idx 0-479 (60%) | Val: 480-639 (20%) | Test: 640-799 (20%)

The label has a NON-MONOTONIC term in x0 (both tails positive) that a linear
model provably cannot capture, plus a weak monotonic term in x1 that it can.
A depth-limited tree candidate can split out both tails of x0 and beat a
linear candidate on this dataset — that gap is what makes "mutation improves
the metric" a genuine, executable claim rather than a staged one.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import random
import sys
from pathlib import Path

_N_SAMPLES = 800
_N_FEATURES = 10
_SEED = 42
_TRAIN_END = 480
_VAL_END = 640


# ─── Deterministic dataset (pure stdlib) ─────────────────────────────────────

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
