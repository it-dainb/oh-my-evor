"""
Reference candidate — LADDER RUNG 1: "basic model beating chance".

Plain logistic regression (batch gradient descent) over all raw features.
Captures the two linear main effects but cannot separate any of the four
independent pairwise conjunctions in benchmarks/tabular-ladder/evaluate.py's
v2 dataset — that gap is exactly what rung 2 (a tree) starts to close.

Contract (benchmarks/tabular-ladder/evaluate.py):
    train(Xtr, ytr, Xva, yva, cfg) -> predict(X) -> list[float]
"""
from __future__ import annotations

import json
import math
import os


def train(Xtr, ytr, Xva, yva, cfg):
    n_feat = len(Xtr[0])
    n = len(Xtr)
    w = [0.0] * n_feat
    b = 0.0
    lr = float(cfg.get("lr", 0.05))
    epochs = int(cfg.get("epochs", 60))

    tel_path = os.environ.get("EVOR_TELEMETRY_PATH")
    node_id = os.environ.get("EVOR_NODE_ID", "")
    run_id = os.environ.get("EVOR_RUN_ID", "")

    for ep in range(epochs):
        gw = [0.0] * n_feat
        gb = 0.0
        total_loss = 0.0
        for row, t in zip(Xtr, ytr):
            z = b + sum(wi * xi for wi, xi in zip(w, row))
            p = 1.0 / (1.0 + math.exp(-z))
            err = p - t
            for i in range(n_feat):
                gw[i] += err * row[i]
            gb += err
            p_clamped = min(max(p, 1e-7), 1 - 1e-7)
            total_loss += -(t * math.log(p_clamped) + (1 - t) * math.log(1 - p_clamped))
        for i in range(n_feat):
            w[i] -= lr * gw[i] / n
        b -= lr * gb / n

        if tel_path and (ep % 10 == 0 or ep == epochs - 1):
            grad_norm = math.sqrt(sum(g * g for g in gw)) / n
            with open(tel_path, "a") as f:
                f.write(json.dumps({
                    "step": ep, "node_id": node_id, "run_id": run_id,
                    "timestamp": "1970-01-01T00:00:00Z",
                    "train_loss": round(total_loss / n, 6),
                    "grad_norm": round(max(grad_norm, 1e-6), 6),
                }) + "\n")

    def predict(X):
        return [1.0 / (1.0 + math.exp(-(b + sum(wi * xi for wi, xi in zip(w, row))))) for row in X]

    return predict
