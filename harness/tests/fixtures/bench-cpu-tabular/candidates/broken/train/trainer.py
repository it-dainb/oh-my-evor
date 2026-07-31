"""Test-fixture candidate: raises during training. Must produce a recorded
failure (non-zero exit -> EvaluatorAdapter status='error'), never a silent
constant score."""
from __future__ import annotations


def train(Xtr, ytr, Xva, yva, cfg):
    raise ValueError("candidate training code is broken on purpose")
