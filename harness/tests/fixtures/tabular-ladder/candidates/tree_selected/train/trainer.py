"""
Reference candidate — LADDER RUNG 3: "handling irrelevant/noisy features".

Ranks all raw features by the gini gain of their single best split on the
TRAIN set only, keeps the top-K (14, generous enough to cover both main
effects, all four conjunction pairs, and the rare-subgroup feature), and
fits a CART tree restricted to that pool. Removing the 79 pure-noise columns
before growing the tree, and affording it more depth than rung 2 could
safely spend unfiltered, recovers more of the conjunction structure.

Contract (benchmarks/tabular-ladder/evaluate.py):
    train(Xtr, ytr, Xva, yva, cfg) -> predict(X) -> list[float]
"""
from __future__ import annotations

import json
import math
import os


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
    top_k = int(cfg.get("top_k", 14))
    max_depth = int(cfg.get("max_depth", 7))
    min_leaf = int(cfg.get("min_leaf", 15))

    tel_path = os.environ.get("EVOR_TELEMETRY_PATH")
    node_id = os.environ.get("EVOR_NODE_ID", "")
    run_id = os.environ.get("EVOR_RUN_ID", "")

    selected = _select_features(Xtr, ytr, top_k, min_leaf)
    if tel_path:
        with open(tel_path, "a") as f:
            f.write(json.dumps({
                "step": 0, "node_id": node_id, "run_id": run_id,
                "timestamp": "1970-01-01T00:00:00Z",
                "train_loss": 1.0,
            }) + "\n")

    tree = None
    for depth in range(1, max_depth + 1):
        tree = _build_tree(Xtr, ytr, 0, depth, min_leaf, selected)
        if tel_path:
            tr_p = [_tree_predict_one(tree, r) for r in Xtr]
            train_acc = sum(1 for p, t in zip(tr_p, ytr) if (p >= 0.5) == t) / max(len(ytr), 1)
            loss = -math.log(max(train_acc, 1e-7))
            with open(tel_path, "a") as f:
                f.write(json.dumps({
                    "step": depth, "node_id": node_id, "run_id": run_id,
                    "timestamp": "1970-01-01T00:00:00Z",
                    "train_loss": round(loss, 6),
                }) + "\n")

    def predict(X):
        return [_tree_predict_one(tree, r) for r in X]

    return predict
