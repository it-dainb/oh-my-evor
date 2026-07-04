"""Locked evaluation script — do NOT modify (hash-verified by ForgeStructureGate).

This file is chmod 444 in production worktrees and its sha256 is stored in
GoalContract.eval_script_hash. Any modification causes IntegrityGate check-4
(no_eval_shift) to fail.
"""
import json
import sys


def evaluate(model, test_loader):
    """Return accuracy dict for test_loader.

    Args:
        model:       Trained model in eval mode.
        test_loader: DataLoader yielding (x, y) test batches.

    Returns:
        dict with key "accuracy" (float 0-1).
    """
    import torch

    model.eval()
    correct = total = 0
    with torch.no_grad():
        for x, y in test_loader:
            preds = model(x).argmax(dim=1)
            correct += int((preds == y).sum().item())
            total += len(y)
    accuracy = correct / total if total > 0 else 0.0
    return {"accuracy": accuracy}


if __name__ == "__main__":
    # Harness-compatible: emit JSON result to stdout.
    result = {
        "metrics": {"accuracy": 0.0},
        "per_domain": {"default": {"accuracy": 0.0}},
        "telemetry_summary": {"total_steps": 0},
        "status": "success",
        "benchmark_raw": "",
    }
    json.dump(result, sys.stdout)
