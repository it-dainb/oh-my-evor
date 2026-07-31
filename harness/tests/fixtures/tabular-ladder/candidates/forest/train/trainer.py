"""
Reference candidate — LADDER RUNG 4: "regularization / ensembling".

Same train-set feature-selection pre-filter as rung 3, but instead of a
single tree, bags N bootstrap-resampled CART trees over the selected pool
and averages their predictions. The bagging variance reduction squeezes out
most of the remaining recoverable signal in
benchmarks/tabular-ladder/evaluate.py's dataset, approaching (never
reaching) the ~0.918 Bayes-optimal roc_auc ceiling.

Contract (benchmarks/tabular-ladder/evaluate.py):
    train(Xtr, ytr, Xva, yva, cfg) -> predict(X) -> list[float]
"""
from __future__ import annotations

import json
import math
import os
import random


def _gini(counts):
    n = counts[0] + counts[1]
    if n == 0:
        return 0.0
    return 1.0 - ((counts[0] / n) ** 2 + (counts[1] / n) ** 2)


def _quantile_thresholds(X, f, n_bins=12):
    vals = sorted(row[f] for row in X)
    n = len(vals)
    thresh = []
    for i in range(1, n_bins):
        idx = int(n * i / n_bins)
        if 0 < idx < n:
            thresh.append((vals[idx - 1] + vals[idx]) / 2.0)
    return sorted(set(thresh))


def _best_split_for_feature(X, y, f, n, n_pos, parent_gini, min_leaf, n_bins=12):
    best = None
    for thresh in _quantile_thresholds(X, f, n_bins):
        left_n = left_pos = 0
        for row, t in zip(X, y):
            if row[f] <= thresh:
                left_n += 1
                left_pos += t
        right_n = n - left_n
        if left_n < min_leaf or right_n < min_leaf:
            continue
        right_pos = n_pos - left_pos
        g = (left_n / n) * _gini([left_pos, left_n - left_pos]) + \
            (right_n / n) * _gini([right_pos, right_n - right_pos])
        gain = parent_gini - g
        if best is None or gain > best[0]:
            best = (gain, thresh)
    return best


def _build_tree(X, y, depth, max_depth, min_leaf, feat_subset, n_bins=12):
    n = len(y)
    n_pos = sum(y)
    if depth >= max_depth or n < 2 * min_leaf or n_pos == 0 or n_pos == n:
        return {"leaf": True, "p": n_pos / n if n else 0.5}
    parent_gini = _gini([n_pos, n - n_pos])
    best = None
    for f in feat_subset:
        r = _best_split_for_feature(X, y, f, n, n_pos, parent_gini, min_leaf, n_bins)
        if r is not None and (best is None or r[0] > best[0]):
            best = (r[0], f, r[1])
    if best is None or best[0] <= 1e-9:
        return {"leaf": True, "p": n_pos / n}
    _, f, thresh = best
    Xl, yl, Xr, yr = [], [], [], []
    for row, t in zip(X, y):
        if row[f] <= thresh:
            Xl.append(row)
            yl.append(t)
        else:
            Xr.append(row)
            yr.append(t)
    return {
        "leaf": False, "f": f, "thresh": thresh,
        "left": _build_tree(Xl, yl, depth + 1, max_depth, min_leaf, feat_subset, n_bins),
        "right": _build_tree(Xr, yr, depth + 1, max_depth, min_leaf, feat_subset, n_bins),
    }


def _tree_predict_one(tree, row):
    node = tree
    while not node["leaf"]:
        node = node["left"] if row[node["f"]] <= node["thresh"] else node["right"]
    return node["p"]


def _select_features(Xtr, ytr, top_k, min_leaf):
    n_feat = len(Xtr[0])
    n = len(Xtr)
    n_pos = sum(ytr)
    parent_gini = _gini([n_pos, n - n_pos])
    scores = []
    for f in range(n_feat):
        r = _best_split_for_feature(Xtr, ytr, f, n, n_pos, parent_gini, min_leaf)
        scores.append((r[0] if r else 0.0, f))
    scores.sort(reverse=True)
    return [f for _, f in scores[:top_k]]


def train(Xtr, ytr, Xva, yva, cfg):
    top_k = int(cfg.get("top_k", 10))
    max_depth = int(cfg.get("max_depth", 4))
    min_leaf = int(cfg.get("min_leaf", 15))
    n_trees = int(cfg.get("n_trees", 20))

    tel_path = os.environ.get("EVOR_TELEMETRY_PATH")
    node_id = os.environ.get("EVOR_NODE_ID", "")
    run_id = os.environ.get("EVOR_RUN_ID", "")

    selected = _select_features(Xtr, ytr, top_k, min_leaf)

    rng = random.Random(7)
    n = len(Xtr)
    trees = []
    for i in range(n_trees):
        idxs = [rng.randrange(n) for _ in range(n)]
        Xb = [Xtr[j] for j in idxs]
        yb = [ytr[j] for j in idxs]
        tree = _build_tree(Xb, yb, 0, max_depth, min_leaf, selected)
        trees.append(tree)

        if tel_path:
            tr_p = [sum(_tree_predict_one(t, r) for t in trees) / len(trees) for r in Xtr]
            train_acc = sum(1 for p, t in zip(tr_p, ytr) if (p >= 0.5) == t) / max(len(ytr), 1)
            loss = -math.log(max(train_acc, 1e-7))
            with open(tel_path, "a") as f:
                f.write(json.dumps({
                    "step": i, "node_id": node_id, "run_id": run_id,
                    "timestamp": "1970-01-01T00:00:00Z",
                    "train_loss": round(loss, 6),
                }) + "\n")

    def predict(X):
        out = []
        for row in X:
            preds = [_tree_predict_one(t, row) for t in trees]
            out.append(sum(preds) / len(preds))
        return out

    return predict
