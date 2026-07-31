"""
Test-fixture candidate: real depth-limited CART (Gini), grown one depth at a
time so each depth's train accuracy is genuine per-step telemetry — not a
fabricated series.

Contract (benchmarks/tabular-churn/evaluate.py):
    train(Xtr, ytr, Xva, yva, cfg) -> predict(X) -> list[float]
"""
from __future__ import annotations

import json
import math
import os


def _gini(labels: list[int]) -> float:
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


def _build(X, y, max_depth, depth=0):
    if depth >= max_depth or len(set(y)) == 1 or len(y) < 4:
        p = sum(y) / max(len(y), 1)
        return {"leaf": 1 if p >= 0.5 else 0, "p": p}
    split = _best_split(X, y)
    if split is None or split[0] <= 1e-9:
        p = sum(y) / max(len(y), 1)
        return {"leaf": 1 if p >= 0.5 else 0, "p": p}
    _, f, thr = split
    li = [i for i in range(len(X)) if X[i][f] <= thr]
    ri = [i for i in range(len(X)) if X[i][f] > thr]
    return {
        "f": f, "thr": thr,
        "left": _build([X[i] for i in li], [y[i] for i in li], max_depth, depth + 1),
        "right": _build([X[i] for i in ri], [y[i] for i in ri], max_depth, depth + 1),
    }


def _predict_one(node, row):
    while "leaf" not in node:
        node = node["left"] if row[node["f"]] <= node["thr"] else node["right"]
    return node["p"]


def train(Xtr, ytr, Xva, yva, cfg):
    max_depth = int(cfg.get("max_depth", 5))
    tel_path = os.environ.get("EVOR_TELEMETRY_PATH")
    node_id = os.environ.get("EVOR_NODE_ID", "")
    run_id = os.environ.get("EVOR_RUN_ID", "")

    tree = None
    for depth in range(1, max_depth + 1):
        tree = _build(Xtr, ytr, depth)
        if tel_path:
            tr_p = [_predict_one(tree, r) for r in Xtr]
            train_acc = sum(1 for p, t in zip(tr_p, ytr) if (p >= 0.5) == t) / max(len(ytr), 1)
            loss = -math.log(max(train_acc, 1e-7))
            with open(tel_path, "a") as f:
                f.write(json.dumps({
                    "step": depth, "node_id": node_id, "run_id": run_id,
                    "timestamp": "1970-01-01T00:00:00Z",
                    "train_loss": round(loss, 6),
                }) + "\n")

    def predict(X):
        return [_predict_one(tree, r) for r in X]

    return predict
