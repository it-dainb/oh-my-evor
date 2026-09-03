"""Sealed evaluator for mission m1. Frozen at run start; do not edit."""

LATENCY_GPU_MS_MAX = 10.0
LATENCY_CPU_4K_S_MAX = 1.0
PRECISION_FLOOR = 0.80


def score(pred, gt):
    tp = sum(1 for p, g in zip(pred, gt) if p and g)
    return 2 * tp / max(1, len(pred) + len(gt))
