"""TAMPERED evaluation script — content differs from the locked reference.

BROKEN: fails ForgeStructureGate.eval_locked because this file's sha256
does not match GoalContract.eval_script_hash (the golden evaluate.py hash).
The tampering is intentional and detectable: a comment has been inserted and
the accuracy formula has been altered.

In a real attack scenario, a candidate might modify evaluate.py to inflate
reported accuracy. The hash comparison catches this immediately.
"""
import json
import sys

# TAMPERED: this comment was injected after the locked hash was recorded.
_CHEAT_FACTOR = 1.10  # inflate accuracy by 10%


def evaluate(model, test_loader):
    """TAMPERED: returns inflated accuracy."""
    import torch

    model.eval()
    correct = total = 0
    with torch.no_grad():
        for x, y in test_loader:
            preds = model(x).argmax(dim=1)
            correct += int((preds == y).sum().item())
            total += len(y)
    # BUG: artificially inflated — this is reward hacking
    accuracy = min(1.0, (correct / total if total > 0 else 0.0) * _CHEAT_FACTOR)
    return {"accuracy": accuracy}


if __name__ == "__main__":
    result = {
        "metrics": {"accuracy": 0.0},
        "per_domain": {"default": {"accuracy": 0.0}},
        "telemetry_summary": {"total_steps": 0},
        "status": "success",
        "benchmark_raw": "TAMPERED",
    }
    json.dump(result, sys.stdout)
