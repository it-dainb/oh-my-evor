"""
Reference candidate — LADDER RUNG 5: "sequential residual fitting (gradient
boosting)".

Gradient boosting in logit space over the same train-set feature-selection
pool as rungs 3/4: 40 rounds of depth-3 CART REGRESSION trees, each fit to
the CURRENT residual (what earlier rounds still get wrong), added to the
running logit with a learning-rate shrinkage factor.

Unlike rung 4's bagging (many independent trees averaged, which mostly
reduces variance), each boosting round explicitly targets whatever the
ensemble-so-far still misses — so successive rounds pick up the pairwise
conjunctions rung 4's bagged trees left on the table (each bootstrap's
greedy split search tends to lock onto the same one or two of the four
independent conjunctions in benchmarks/tabular-ladder/evaluate.py's v2
dataset). That closes a real, measurable chunk of the remaining gap to the
Bayes-optimal ceiling.

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


def _variance(vals):
    n = len(vals)
    if n == 0:
        return 0.0
    m = sum(vals) / n
    return sum((v - m) ** 2 for v in vals) / n


def _best_split_regression(X, resid, f, min_leaf, n_bins=12):
    best = None
    for thresh in _quantile_thresholds(X, f, n_bins):
        left = [r for row, r in zip(X, resid) if row[f] <= thresh]
        right = [r for row, r in zip(X, resid) if row[f] > thresh]
        if len(left) < min_leaf or len(right) < min_leaf:
            continue
        sse = _variance(left) * len(left) + _variance(right) * len(right)
        parent_sse = _variance(resid) * len(resid)
        gain = parent_sse - sse
        if best is None or gain > best[0]:
            best = (gain, thresh)
    return best


def _build_regression_tree(X, resid, depth, max_depth, min_leaf, feat_subset):
    n = len(resid)
    if depth >= max_depth or n < 2 * min_leaf:
        return {"leaf": True, "v": sum(resid) / n if n else 0.0}
    best = None
    for f in feat_subset:
        r = _best_split_regression(X, resid, f, min_leaf)
        if r is not None and (best is None or r[0] > best[0]):
            best = (r[0], f, r[1])
    if best is None or best[0] <= 1e-9:
        return {"leaf": True, "v": sum(resid) / n}
    _, f, thresh = best
    Xl, rl, Xr, rr = [], [], [], []
    for row, r in zip(X, resid):
        if row[f] <= thresh:
            Xl.append(row)
            rl.append(r)
        else:
            Xr.append(row)
            rr.append(r)
    return {
        "leaf": False, "f": f, "thresh": thresh,
        "left": _build_regression_tree(Xl, rl, depth + 1, max_depth, min_leaf, feat_subset),
        "right": _build_regression_tree(Xr, rr, depth + 1, max_depth, min_leaf, feat_subset),
    }


def _reg_tree_predict_one(tree, row):
    node = tree
    while not node["leaf"]:
        node = node["left"] if row[node["f"]] <= node["thresh"] else node["right"]
    return node["v"]


def train(Xtr, ytr, Xva, yva, cfg):
    top_k = int(cfg.get("top_k", 14))
    max_depth = int(cfg.get("max_depth", 3))
    min_leaf = int(cfg.get("min_leaf", 15))
    n_rounds = int(cfg.get("n_rounds", 40))
    lr = float(cfg.get("lr", 0.3))

    tel_path = os.environ.get("EVOR_TELEMETRY_PATH")
    node_id = os.environ.get("EVOR_NODE_ID", "")
    run_id = os.environ.get("EVOR_RUN_ID", "")

    selected = _select_features(Xtr, ytr, top_k, min_leaf)

    n = len(Xtr)
    base_rate = min(max(sum(ytr) / n, 1e-4), 1 - 1e-4)
    f0 = math.log(base_rate / (1 - base_rate))
    F = [f0] * n
    trees = []

    for rnd in range(n_rounds):
        preds = [1.0 / (1.0 + math.exp(-f)) for f in F]
        residual = [t - p for t, p in zip(ytr, preds)]
        tree = _build_regression_tree(Xtr, residual, 0, max_depth, min_leaf, selected)
        trees.append(tree)
        update = [_reg_tree_predict_one(tree, r) for r in Xtr]
        F = [f + lr * u for f, u in zip(F, update)]

        if tel_path:
            train_acc = sum(1 for f, t in zip(F, ytr) if (f >= 0.0) == bool(t)) / max(n, 1)
            loss = -math.log(max(train_acc, 1e-7))
            with open(tel_path, "a") as fh:
                fh.write(json.dumps({
                    "step": rnd, "node_id": node_id, "run_id": run_id,
                    "timestamp": "1970-01-01T00:00:00Z",
                    "train_loss": round(loss, 6),
                }) + "\n")

    def predict(X):
        Fx = [f0] * len(X)
        for tree in trees:
            update = [_reg_tree_predict_one(tree, r) for r in X]
            Fx = [f + lr * u for f, u in zip(Fx, update)]
        return [1.0 / (1.0 + math.exp(-f)) for f in Fx]

    return predict
