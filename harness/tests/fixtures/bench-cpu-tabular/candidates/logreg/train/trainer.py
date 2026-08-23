"""
Test-fixture candidate: real pure-Python SGD logistic regression. Writes
genuine per-epoch train_loss (cross-entropy) and grad_norm telemetry so the
grad_norm branch of telemetry_sane is exercised too.

Contract (benchmarks/tabular-churn/evaluate.py):
    train(Xtr, ytr, Xva, yva, cfg) -> predict(X) -> list[float]
"""
from __future__ import annotations

import json
import math
import os
import random


def _sigmoid(z: float) -> float:
    if z < -60:
        return 0.0
    if z > 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-z))


def train(Xtr, ytr, Xva, yva, cfg):
    C = float(cfg.get("C", 1.0))
    epochs = int(cfg.get("max_iter", 60))
    lr = 0.1
    rng = random.Random(42)
    d = len(Xtr[0])
    w = [0.0] * d
    b = 0.0
    l2 = 1.0 / max(C, 1e-6)
    n = len(Xtr)
    idx = list(range(n))

    tel_path = os.environ.get("EVOR_TELEMETRY_PATH")
    node_id = os.environ.get("EVOR_NODE_ID", "")
    run_id = os.environ.get("EVOR_RUN_ID", "")

    for epoch in range(epochs):
        rng.shuffle(idx)
        grad_sq_sum = 0.0
        for i in idx:
            xi, yi = Xtr[i], ytr[i]
            z = b + sum(w[j] * xi[j] for j in range(d))
            err = _sigmoid(z) - yi
            for j in range(d):
                g = err * xi[j] + l2 * w[j] / n
                w[j] -= lr * g
                grad_sq_sum += g * g
            b -= lr * err

        if tel_path and epoch % 10 == 0:
            tr_p = [_sigmoid(b + sum(w[j] * row[j] for j in range(d))) for row in Xtr]
            eps = 1e-7
            ce = -sum(
                yi * math.log(max(pi, eps)) + (1 - yi) * math.log(max(1 - pi, eps))
                for pi, yi in zip(tr_p, ytr)
            ) / n
            grad_norm = math.sqrt(grad_sq_sum) / n
            with open(tel_path, "a") as f:
                f.write(json.dumps({
                    "step": epoch, "node_id": node_id, "run_id": run_id,
                    "timestamp": "1970-01-01T00:00:00Z",
                    "train_loss": round(ce, 6),
                    "grad_norm": round(grad_norm, 6),
                }) + "\n")

    def predict(X):
        return [_sigmoid(b + sum(w[j] * row[j] for j in range(d))) for row in X]

    return predict
