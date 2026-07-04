#!/usr/bin/env python3
"""
benchmarks/shapes/evaluate.py — EvaluatorAdapter-contract evaluator for the
shapes image-classification benchmark (CPU-only, torch + sklearn).

EvaluatorAdapter subprocess contract
-------------------------------------
Environment variables read:
  EVOR_WORKTREE     — path to candidate worktree containing config.json
  EVOR_EVAL_VERSION — injected by EvaluatorAdapter (not echoed to avoid mismatch check)
  EVOR_NODE_ID      — node identifier (unused inside eval; carried in telemetry)
  EVOR_RUN_ID       — run identifier (unused inside eval; carried in telemetry)

config.json keys (all optional, shown with defaults):
  model_type    : "logistic" | "mlp" | "cnn"  (default "logistic")
  lr            : float  (default 0.01)
  epochs        : int    (default 20)
  hidden        : int    (default 128)         — MLP hidden layer width
  conv_channels : int    (default 16)          — CNN first conv output channels
  dropout       : float  (default 0.0)
  augment       : bool   (default false)       — concat augmented train split

Stdout contract (ONE JSON line):
  metrics           : {accuracy: float, macro_f1: float}
  per_domain        : {default: {accuracy: float, macro_f1: float}}
  telemetry_summary : {total_steps, final_train_loss, best_val_metric,
                       throughput_samples_per_sec}
  status            : "success"
  benchmark_raw     : str
  telemetry         : [{epoch, train_loss, val_metric, lr, grad_norm}, ...]
                      (per-epoch array; EvaluatorAdapter ignores it; mission script
                       reads it to write nodes/<id>/telemetry.jsonl)

Isolation contract: writes NOTHING to disk.  stdout only.

Expected accuracy (seed=42):
  logistic (~20 epochs)   → ~0.65–0.72
  mlp      (~30 epochs)   → ~0.78–0.85
  cnn      (~15–20 epochs) → ~0.90–0.95
"""
from __future__ import annotations

import json
import os
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

# ── Locate benchmarks/shapes/ so that dataset.py is importable ──────────────
_BENCH_DIR = Path(__file__).resolve().parent
if str(_BENCH_DIR) not in sys.path:
    sys.path.insert(0, str(_BENCH_DIR))

_DEFAULT_CONFIG: dict = {
    "model_type": "logistic",
    "lr": 0.01,
    "epochs": 20,
    "hidden": 128,
    "conv_channels": 16,
    "dropout": 0.0,
    "augment": False,
}


# ─────────────────────────────────────────────────────────────────────────────
# Model definitions (all torch for uniform per-epoch telemetry)
# ─────────────────────────────────────────────────────────────────────────────


def _build_model(
    model_type: str,
    hidden: int,
    conv_channels: int,
    dropout: float,
) -> "torch.nn.Module":
    import torch.nn as nn

    if model_type == "logistic":
        # 1-layer linear classifier on flattened 256-dim input
        return nn.Sequential(
            nn.Flatten(),
            nn.Linear(16 * 16, 3),
        )

    if model_type == "mlp":
        return nn.Sequential(
            nn.Flatten(),
            nn.Linear(16 * 16, hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden, 3),
        )

    # cnn — default / fallback
    fc_in = conv_channels * 2 * 4 * 4   # two halvings: 16→8→4

    class _TinyCNN(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.features = nn.Sequential(
                nn.Conv2d(1, conv_channels, kernel_size=3, padding=1),  # 16×16
                nn.ReLU(),
                nn.MaxPool2d(2),                                         # 8×8
                nn.Conv2d(conv_channels, conv_channels * 2, kernel_size=3, padding=1),
                nn.ReLU(),
                nn.MaxPool2d(2),                                         # 4×4
            )
            self.classifier = nn.Sequential(
                nn.Flatten(),
                nn.Dropout(dropout),
                nn.Linear(fc_in, 64),
                nn.ReLU(),
                nn.Linear(64, 3),
            )

        def forward(self, x: "torch.Tensor") -> "torch.Tensor":  # type: ignore[override]
            return self.classifier(self.features(x))

    return _TinyCNN()


# ─────────────────────────────────────────────────────────────────────────────
# Training loop
# ─────────────────────────────────────────────────────────────────────────────


def _train(
    model: "torch.nn.Module",
    X_tr: "np.ndarray",
    y_tr: "np.ndarray",
    X_va: "np.ndarray",
    y_va: "np.ndarray",
    lr: float,
    epochs: int,
    model_type: str,
    batch_size: int = 32,
) -> tuple[list[dict], float, float]:
    """Train model; return (telemetry_list, best_val_acc, final_train_loss).

    telemetry_list entries: {epoch, train_loss, val_metric, lr, grad_norm}
    grad_norm = mean per-batch L2-norm of all parameter gradients (per epoch).
    """
    import torch
    import torch.nn as nn

    torch.manual_seed(42)

    X_tr_t = torch.from_numpy(X_tr).float()
    y_tr_t = torch.from_numpy(y_tr).long()
    X_va_t = torch.from_numpy(X_va).float()
    y_va_t = torch.from_numpy(y_va).long()

    if model_type == "cnn":
        X_tr_t = X_tr_t.unsqueeze(1)   # (N, 1, H, W)
        X_va_t = X_va_t.unsqueeze(1)

    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)

    n = len(X_tr_t)
    telemetry: list[dict] = []
    best_val = 0.0

    for epoch in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(n)
        epoch_loss = 0.0
        epoch_gnorm = 0.0
        n_batches = 0

        for start in range(0, n, batch_size):
            idx = perm[start: start + batch_size]
            xb, yb = X_tr_t[idx], y_tr_t[idx]

            optimizer.zero_grad()
            loss = criterion(model(xb), yb)
            loss.backward()

            # Grad-norm computed BEFORE optimizer.step() (gradients populated)
            gn_sq = sum(
                p.grad.data.norm(2).item() ** 2
                for p in model.parameters()
                if p.grad is not None
            )
            grad_norm_batch = float(gn_sq ** 0.5)

            optimizer.step()
            epoch_loss += loss.item()
            epoch_gnorm += grad_norm_batch
            n_batches += 1

        avg_loss = epoch_loss / max(n_batches, 1)
        avg_gnorm = epoch_gnorm / max(n_batches, 1)

        # Validation accuracy
        model.eval()
        with torch.no_grad():
            val_preds = model(X_va_t).argmax(dim=1)
            val_acc = (val_preds == y_va_t).float().mean().item()

        best_val = max(best_val, val_acc)
        current_lr = float(optimizer.param_groups[0]["lr"])

        telemetry.append({
            "epoch": epoch,
            "train_loss": round(avg_loss, 6),
            "val_metric": round(val_acc, 6),
            "lr": current_lr,
            "grad_norm": round(avg_gnorm, 6),
        })

    final_loss = telemetry[-1]["train_loss"] if telemetry else 0.0
    return telemetry, best_val, final_loss


# ─────────────────────────────────────────────────────────────────────────────
# Test-set evaluation
# ─────────────────────────────────────────────────────────────────────────────


def _test_metrics(
    model: "torch.nn.Module",
    X_te: "np.ndarray",
    y_te: "np.ndarray",
    model_type: str,
) -> tuple[float, float]:
    """Return (accuracy, macro_f1) on the test split."""
    import torch
    from sklearn.metrics import f1_score

    model.eval()
    X_t = torch.from_numpy(X_te).float()
    if model_type == "cnn":
        X_t = X_t.unsqueeze(1)

    with torch.no_grad():
        preds = model(X_t).argmax(dim=1).numpy()

    accuracy = float((preds == y_te).mean())
    macro_f1 = float(f1_score(y_te, preds, average="macro", zero_division=0))
    return accuracy, macro_f1


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────


def main() -> None:
    worktree = Path(os.environ.get("EVOR_WORKTREE", "."))

    # Load config
    cfg: dict = dict(_DEFAULT_CONFIG)
    config_path = worktree / "config.json"
    if config_path.exists():
        try:
            cfg.update(json.loads(config_path.read_text()))
        except Exception:
            pass

    model_type = str(cfg.get("model_type", "logistic")).lower()
    lr = float(cfg.get("lr", 0.01))
    epochs = int(cfg.get("epochs", 20))
    hidden = int(cfg.get("hidden", 128))
    conv_channels = int(cfg.get("conv_channels", 16))
    dropout = float(cfg.get("dropout", 0.0))
    do_augment = bool(cfg.get("augment", False))

    t0 = time.monotonic()

    # ── Dataset ───────────────────────────────────────────────────────────
    from dataset import augment, generate, get_splits
    import numpy as np

    X, y = generate()
    X_tr, y_tr, X_va, y_va, X_te, y_te = get_splits(X, y)

    if do_augment:
        # Concatenate original + augmented train split
        X_aug = augment(X_tr, seed=42)
        X_tr = np.concatenate([X_tr, X_aug], axis=0)
        y_tr = np.concatenate([y_tr, y_tr], axis=0)

    # ── Model ─────────────────────────────────────────────────────────────
    model = _build_model(model_type, hidden, conv_channels, dropout)

    # ── Training ──────────────────────────────────────────────────────────
    tele, best_val, final_loss = _train(
        model, X_tr, y_tr, X_va, y_va,
        lr=lr, epochs=epochs, model_type=model_type,
    )

    # ── Test metrics ──────────────────────────────────────────────────────
    accuracy, macro_f1 = _test_metrics(model, X_te, y_te, model_type)

    elapsed = time.monotonic() - t0
    n_tr = len(X_tr)
    throughput = n_tr * epochs / max(elapsed, 1e-9)

    # ── Emit result ───────────────────────────────────────────────────────
    result = {
        "metrics": {
            "accuracy": round(accuracy, 6),
            "macro_f1": round(macro_f1, 6),
        },
        "per_domain": {
            "default": {
                "accuracy": round(accuracy, 6),
                "macro_f1": round(macro_f1, 6),
            }
        },
        "telemetry_summary": {
            "total_steps": len(tele),
            "final_train_loss": round(final_loss, 6),
            "best_val_metric": round(best_val, 6),
            "throughput_samples_per_sec": round(throughput, 1),
        },
        "status": "success",
        "benchmark_raw": (
            f"model={model_type} epochs={epochs} lr={lr} augment={do_augment} "
            f"n_train={n_tr} "
            f"test_acc={accuracy:.4f} macro_f1={macro_f1:.4f} "
            f"elapsed={elapsed:.3f}s"
        ),
        # Per-epoch telemetry array — EvaluatorAdapter ignores this key;
        # shapes-mission.py reads it to write nodes/<id>/telemetry.jsonl.
        "telemetry": tele,
    }

    print(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
