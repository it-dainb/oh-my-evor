"""evor.watch — stop waiting on a run that has stopped learning.

Tick 4 of the 2026-10-30 binarization mission: val_mean_S peaked at step 12,000 and
the primary at 15,000, train loss kept edging down to 60,000, and the run spent ~75%
of its compute generalizing no better.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from evor.watch import assess, watch


def _recs(n_train=4000, loss=lambda s: 1.0 / (1 + s / 500), vals=()):
    out = [{"step": s, "train_loss": loss(s)} for s in range(1, n_train + 1)]
    out += [{"step": s, "val_metric": v} for s, v in vals]
    return sorted(out, key=lambda r: r["step"])


def test_warmup_before_min_steps():
    assert assess(_recs(500), min_steps=2000)["state"] == "warmup"


def test_a_falling_loss_without_validation_is_learning():
    assert assess(_recs(8000, loss=lambda s: 2.0 - s / 10000))["state"] == "learning"


def test_a_flat_loss_without_validation_is_stalled():
    assert assess(_recs(8000, loss=lambda s: 0.3))["state"] == "stalled"


def test_validation_that_stopped_improving_is_stalled_even_while_loss_falls():
    vals = [(1000 * i, v) for i, v in enumerate([0.1, 0.3, 0.5, 0.4, 0.45, 0.48, 0.42, 0.44], start=1)]
    a = assess(_recs(8000, loss=lambda s: 2.0 - s / 10000, vals=vals), val_key="val_metric", val_patience=5)
    assert a["state"] == "stalled"
    assert a["val_best"] == 0.5 and a["val_evals_since_best"] == 5


def test_validation_still_setting_bests_is_learning_even_with_a_flat_loss():
    vals = [(1000 * i, 0.1 * i) for i in range(1, 9)]
    a = assess(_recs(8000, loss=lambda s: 0.3, vals=vals), val_key="val_metric", val_patience=5)
    assert a["state"] == "learning"


def test_nan_loss_is_diverged():
    recs = _recs(3000)
    recs[-1]["train_loss"] = float("nan")
    assert assess(recs)["state"] == "diverged"


def test_a_loss_climbing_far_above_its_best_is_diverged():
    assert assess(_recs(8000, loss=lambda s: 0.3 if s < 4000 else 0.3 + (s - 4000) / 2000))["state"] == "diverged"


def _args(tmp_path, pid, **kw):
    base = dict(telemetry=str(tmp_path / "t.jsonl"), pid=pid, loss_key="train_loss", val_key=None,
                val_lower_is_better=False, min_steps=2000, min_rel_improve=0.005, diverge_factor=1.5,
                val_patience=5, val_loss_key="val_loss", patience=1, interval=0.0, stuck_s=900.0, max_hours=48.0)
    base.update(kw)
    return argparse.Namespace(**base)


def test_watch_returns_exited_when_the_trainer_is_gone(tmp_path: Path):
    p = subprocess.Popen([sys.executable, "-c", "pass"]); p.wait()
    assert watch(_args(tmp_path, p.pid))["verdict"] == "exited"


def test_watch_returns_stalled_on_a_live_trainer(tmp_path: Path):
    (tmp_path / "t.jsonl").write_text("\n".join(json.dumps(r) for r in _recs(8000, loss=lambda s: 0.3)))
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert watch(_args(tmp_path, p.pid))["verdict"] == "stalled"
    finally:
        p.kill()


def test_watch_returns_stuck_when_no_telemetry_is_written(tmp_path: Path):
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        t = iter(range(0, 10_000, 1000))
        assert watch(_args(tmp_path, p.pid, stuck_s=1500.0), clock=lambda: next(t), sleep=lambda s: None)["verdict"] == "stuck"
    finally:
        p.kill()


def test_validation_stalled_while_train_falls_is_diagnosed_overfitting():
    vals = [(1000 * i, v) for i, v in enumerate([0.1, 0.3, 0.5, 0.4, 0.45, 0.48, 0.42, 0.41], start=1)]
    a = assess(_recs(8000, loss=lambda s: 2.0 - s / 10000, vals=vals), val_key="val_metric", val_patience=5)
    assert a["diagnosis"] == "overfitting"


def test_validation_stalled_with_a_flat_loss_is_diagnosed_underfitting():
    vals = [(1000 * i, v) for i, v in enumerate([0.1, 0.3, 0.5, 0.4, 0.45, 0.48, 0.42, 0.44], start=1)]
    a = assess(_recs(8000, loss=lambda s: 0.3, vals=vals), val_key="val_metric", val_patience=5)
    assert a["diagnosis"] == "underfitting"
