"""
evor.watch — wait on a training run, and stop waiting early when it has stopped learning.

    python -m evor.watch --telemetry <nodes/<id>/telemetry.jsonl> --pid <trainer pid>

Blocks until the first of these, then prints ONE JSON line and exits 0:

  exited    the trainer process ended (normal completion or a crash; read its log)
  diverged  the loss went NaN/inf, or its recent mean is far above its best
  stalled   validation set no new best for --val-patience evaluations (or, with no validation,
            the loss went flat), with a diagnosis: "overfitting" (train still falling, or the
            train-val gap widening), "underfitting" (both flat), or "plateau" (no validation)
  stuck     the trainer is alive but has written no telemetry for --stuck-s seconds
  timeout   --max-hours elapsed

It is meant to be the ONE background Bash task a forge-junior waits on: the trainer
runs detached, this exits when there is something to act on, and the host wakes the
agent once. That replaces both polling and waiting out a dead run. Tick 4 of the
2026-10-30 binarization mission trained a candidate for its whole budget although its
loss went flat early on.

It reads files only. Stopping the trainer is the caller's decision, and so is what to
record about it.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path
from statistics import mean
from typing import Any


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def read_records(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a line being written right now
                if isinstance(rec, dict):
                    out.append(rec)
    except FileNotFoundError:
        pass
    return out


def assess(
    records: list[dict[str, Any]],
    *,
    loss_key: str = "train_loss",
    val_key: str | None = None,
    val_higher_is_better: bool = True,
    min_steps: int = 2000,
    min_rel_improve: float = 0.005,
    diverge_factor: float = 1.5,
    val_patience: int = 5,
    val_loss_key: str | None = "val_loss",
) -> dict[str, Any]:
    """Judge the telemetry so far. Returns {"state": "learning"|"stalled"|"diverged"|"warmup", ...}.

    VALIDATION decides when it is logged: "stalled" when it has set no new best for
    `val_patience` consecutive evaluations, whatever the train loss is doing. In tick
    4 of the binarization mission val_mean_S peaked at step 12,000 and the primary at
    15,000, while train loss kept edging down to step 60,000: ~75% of the run fitted
    the training set and generalized no better. Train loss alone said "learning".

    Without a validation metric, the loss is compared over two equal windows: the most recent quarter of the
    steps seen and the quarter before it. "stalled" requires BOTH that the loss
    improved by less than `min_rel_improve` between them AND that the validation
    metric, when one is logged, set no new best in the recent window. A run whose
    train loss is flat but whose validation still climbs is learning.
    """
    train = [r for r in records if isinstance(r.get(loss_key), (int, float)) and isinstance(r.get("step"), int)]
    if not train:
        return {"state": "warmup", "reason": "no loss records yet"}
    losses = [float(r[loss_key]) for r in train]
    steps = [r["step"] for r in train]
    if any(math.isnan(x) or math.isinf(x) for x in losses[-50:]):
        return {"state": "diverged", "reason": f"{loss_key} is NaN/inf", "step": steps[-1]}
    if steps[-1] < min_steps or len(train) < 40:
        return {"state": "warmup", "step": steps[-1]}

    q = max(10, len(train) // 4)
    recent, previous = losses[-q:], losses[-2 * q:-q]
    best_window = min(mean(losses[i:i + q]) for i in range(0, len(losses) - q + 1, max(1, q // 2)))
    recent_mean, previous_mean = mean(recent), mean(previous)
    evidence = {
        "step": steps[-1],
        "loss_first": round(losses[0], 6),
        "loss_previous_window": round(previous_mean, 6),
        "loss_recent_window": round(recent_mean, 6),
        "loss_best_window": round(best_window, 6),
    }
    if best_window > 0 and recent_mean > diverge_factor * best_window:
        return {"state": "diverged", "reason": f"recent {loss_key} is {recent_mean / best_window:.2f}x its best window", **evidence}

    rel = (previous_mean - recent_mean) / abs(previous_mean) if previous_mean else 0.0
    evidence["loss_rel_improvement"] = round(rel, 6)

    if val_key:
        vals = [(r["step"], float(r[val_key])) for r in records
                if isinstance(r.get(val_key), (int, float)) and isinstance(r.get("step"), int)
                and not math.isnan(float(r[val_key]))]
        if len(vals) > val_patience:
            better = (lambda a, b: a > b) if val_higher_is_better else (lambda a, b: a < b)
            best_i = 0
            for i in range(1, len(vals)):
                if better(vals[i][1], vals[best_i][1]):
                    best_i = i
            since = len(vals) - 1 - best_i
            evidence.update({"val_key": val_key, "val_best": vals[best_i][1], "val_best_step": vals[best_i][0],
                             "val_latest": vals[-1][1], "val_evals_since_best": since})
            if since >= val_patience:
                # What train loss did while validation stalled says WHY it stalled.
                # Measured over the same span: from the best evaluation to now.
                tr_at_best = [l for st, l in zip(steps, losses) if st <= vals[best_i][0]][-50:]
                tr_now = losses[-50:]
                train_drop = ((mean(tr_at_best) - mean(tr_now)) / abs(mean(tr_at_best))) if tr_at_best and mean(tr_at_best) else 0.0
                worse = (vals[-1][1] < vals[best_i][1]) if val_higher_is_better else (vals[-1][1] > vals[best_i][1])
                evidence["train_drop_since_val_best"] = round(train_drop, 6)
                evidence.update(_diagnose(train_drop, worse, min_rel_improve, records, val_loss_key))
                return {"state": "stalled",
                        "reason": f"{val_key} has not beaten {vals[best_i][1]:.4g} (step {vals[best_i][0]}) "
                                  f"in {since} evaluations; train {loss_key} fell {train_drop:.2%} meanwhile",
                        **evidence}
            return {"state": "learning", **evidence}

    val_improving = None
    if val_key:
        vals = [(r["step"], float(r[val_key])) for r in records
                if isinstance(r.get(val_key), (int, float)) and isinstance(r.get("step"), int)]
        if len(vals) >= 2:
            cutoff = steps[-q] if len(steps) >= q else steps[0]
            before = [v for s, v in vals if s < cutoff]
            after = [v for s, v in vals if s >= cutoff]
            if before and after:
                best_before = max(before) if val_higher_is_better else min(before)
                best_after = max(after) if val_higher_is_better else min(after)
                val_improving = best_after > best_before if val_higher_is_better else best_after < best_before
                evidence.update({f"{val_key}_best_before": best_before, f"{val_key}_best_recent": best_after})

    if rel < min_rel_improve and val_improving is not True:
        evidence.update({"diagnosis": "plateau",
                         "next_tick_hint": "train loss is flat with no validation to judge by: try a different LR "
                                           "schedule or more capacity, and log a validation metric"})
        return {"state": "stalled", "reason": f"{loss_key} improved {rel:.2%} over the last window", **evidence}
    return {"state": "learning", **evidence}


def _diagnose(train_drop: float, val_worse: bool, min_rel: float,
              records: list[dict[str, Any]], val_loss_key: str | None) -> dict[str, Any]:
    """Name why validation stalled, from what train loss did over the same span.

    - train still falling, validation flat or worse than its best -> overfitting
    - train flat too                                             -> underfitting / plateau
    When an eval loss is logged, the train-val gap trend is added: a gap that
    widens is direct evidence of overfitting.
    """
    out: dict[str, Any] = {}
    if val_loss_key:
        pairs = []
        last_train = None
        for r in sorted((r for r in records if isinstance(r.get("step"), int)), key=lambda r: r["step"]):
            if isinstance(r.get("train_loss"), (int, float)):
                last_train = float(r["train_loss"])
            if isinstance(r.get(val_loss_key), (int, float)) and last_train is not None:
                pairs.append(float(r[val_loss_key]) - last_train)
        if len(pairs) >= 3:
            third = max(1, len(pairs) // 3)
            out["gap_early"] = round(mean(pairs[:third]), 6)
            out["gap_recent"] = round(mean(pairs[-third:]), 6)
    gap_widening = "gap_early" in out and out["gap_recent"] > out["gap_early"] * 1.1 + 1e-9
    if train_drop >= min_rel or gap_widening:
        out["diagnosis"] = "overfitting"
        out["next_tick_hint"] = ("train loss kept falling while validation did not improve"
                                 + (" and got worse" if val_worse else "")
                                 + ": regularize (weight decay, dropout, augmentation), add data, or stop earlier")
    else:
        out["diagnosis"] = "underfitting"
        out["next_tick_hint"] = ("train loss and validation both stopped improving: the model cannot fit more "
                                 "of the signal; try more capacity, a different LR schedule, or a better loss")
    return out


def watch(args: argparse.Namespace, clock=time.monotonic, sleep=time.sleep) -> dict[str, Any]:
    tel = Path(args.telemetry)
    start = clock()
    last_size, last_growth = -1, clock()
    stalled_checks = 0
    while True:
        if not _alive(args.pid):
            records = read_records(tel)
            return {"verdict": "exited", "pid": args.pid, "records": len(records),
                    "last_step": records[-1].get("step") if records else None}
        size = tel.stat().st_size if tel.exists() else 0
        if size != last_size:
            last_size, last_growth = size, clock()
        elif clock() - last_growth > args.stuck_s:
            return {"verdict": "stuck", "pid": args.pid,
                    "reason": f"no telemetry written for {int(clock() - last_growth)} s while the trainer is alive"}
        a = assess(read_records(tel), loss_key=args.loss_key, val_key=args.val_key,
                   val_higher_is_better=not args.val_lower_is_better, min_steps=args.min_steps,
                   min_rel_improve=args.min_rel_improve, diverge_factor=args.diverge_factor,
                   val_patience=args.val_patience, val_loss_key=args.val_loss_key)
        if a["state"] == "diverged":
            return {"verdict": "diverged", "pid": args.pid, **a}
        stalled_checks = stalled_checks + 1 if a["state"] == "stalled" else 0
        if stalled_checks >= args.patience:
            return {"verdict": "stalled", "pid": args.pid, "checks": stalled_checks, **a}
        if clock() - start > args.max_hours * 3600:
            return {"verdict": "timeout", "pid": args.pid, **a}
        sleep(args.interval)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m evor.watch", description=__doc__.split("\n\n")[0])
    p.add_argument("--telemetry", required=True)
    p.add_argument("--pid", type=int, required=True)
    p.add_argument("--loss-key", default="train_loss")
    p.add_argument("--val-key", default=None, help="validation metric logged in telemetry, e.g. val_min_S")
    p.add_argument("--val-lower-is-better", action="store_true")
    p.add_argument("--min-steps", type=int, default=2000, help="no stall verdict before this step")
    p.add_argument("--min-rel-improve", type=float, default=0.005, help="loss improvement per window below which it is flat")
    p.add_argument("--diverge-factor", type=float, default=1.5)
    p.add_argument("--val-loss-key", default="val_loss", help="eval loss logged in telemetry, for the train-val gap")
    p.add_argument("--val-patience", type=int, default=5, help="evaluations without a new best validation before 'stalled'")
    p.add_argument("--patience", type=int, default=3, help="consecutive stalled checks before reporting")
    p.add_argument("--interval", type=float, default=60.0, help="seconds between checks")
    p.add_argument("--stuck-s", type=float, default=900.0)
    p.add_argument("--max-hours", type=float, default=48.0)
    args = p.parse_args(argv)
    tel = Path(args.telemetry) if args.telemetry else None
    if tel is None or tel.is_dir():
        print(json.dumps({
            "verdict": "bad_arguments",
            "reason": f"--telemetry must name the trainer's telemetry file (e.g. <worktree>/telemetry.jsonl), "
                      f"got {args.telemetry!r}; an empty $EVOR_TELEMETRY_PATH gives this",
        }), flush=True)
        return 2
    print(json.dumps(watch(args)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
