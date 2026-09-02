"""telemetry_sane — the check under repair.

Resolves the node's telemetry stream and validates it. Fails a node whose
stream is missing, empty, non-monotonic in `step`, carries NaN/Inf loss, or
whose loss never moves.
"""
import json
import math
from pathlib import Path


def _load(path):
    rows = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def check(case, root):
    """Return True (sane), False (not sane). Never None: this check has no
    not-evaluated state, because a stream it cannot find is a stream that is
    not there."""
    root = Path(root)
    path = root / "nodes" / case["node"]["uuid"] / "telemetry.jsonl"
    if not path.exists():
        return False
    rows = _load(path)
    if not rows:
        return False
    steps = [r.get("step") for r in rows]
    if any(s is None for s in steps) or steps != sorted(set(steps)):
        return False
    losses = [r.get("train_loss") for r in rows]
    if any(l is None or math.isnan(l) or math.isinf(l) for l in losses):
        return False
    if losses[0] == losses[-1]:
        return False
    grads = [r["grad_norm"] for r in rows if "grad_norm" in r]
    if grads and min(grads) <= 0:
        return False
    return True
