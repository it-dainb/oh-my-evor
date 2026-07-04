# Shapes Benchmark — Circle / Square / Triangle Classification

Reference mission benchmark for the **oh-my-evor** plugin.  
Exercises the full engine end-to-end on a CPU-fast image-classification task.

## Overview

| Item | Value |
|------|-------|
| Task | 3-class image classification (circle / square / triangle) |
| Images | 600 × 16×16 grayscale, seed=42, generated offline with numpy+cv2 |
| Split | Train 360 / Val 120 / Test 120 (fixed indices, 60/20/20%) |
| Primary metric | `accuracy` (higher is better) |
| Baseline | 0.65 (logistic regression on flattened pixels) |
| Target | 0.88 |
| Expected runtime | ~1–3 min total (CPU-only) |
| Docker image | `evor-ml-test` (torch, cv2, sklearn, numpy) |

## Files

```
benchmarks/shapes/
  dataset.py     — Synthetic image generator (numpy + cv2, no download)
  evaluate.py    — EvaluatorAdapter-contract evaluator (torch + sklearn)
  README.md      — This file

scripts/
  shapes-mission.py  — Deterministic driver: full engine round-trip
```

## How to run

```bash
# Inside the ML Docker image
python scripts/shapes-mission.py
```

Expected final line: `SHAPES-MISSION: PASS`

The script writes `ci/out/shapes-tree.png` (evolution frontier plot).

## Dataset (`dataset.py`)

Generates 600 images deterministically (seed=42):

- **Labels** interleaved: `label = i % 3` → balanced classes throughout every split.
- **Drawing**: each image is a filled shape on a black 16×16 canvas.
  - Circle (0): `cv2.circle`, radius 3–5 px, random centre.
  - Square (1): `cv2.rectangle`, half-side 3–5 px, random centre.
  - Triangle (2): `cv2.fillPoly`, equilateral with random orientation, radius 3–5 px.
- **Noise**: Gaussian σ=20 DN added per image (≈8% of full scale).
- **Normalisation**: pixel values divided by 255 → `float32 [0, 1]`.

Public API:

```python
from dataset import generate, get_splits, augment

X, y = generate(seed=42)                            # (600, 16, 16), (600,)
X_tr, y_tr, X_va, y_va, X_te, y_te = get_splits(X, y)
X_aug = augment(X_tr, seed=42)                      # rotation ±15° + noise
```

## Evaluator (`evaluate.py`)

Reads `$EVOR_WORKTREE/config.json`; writes nothing to disk; emits **one JSON line** to stdout.

### `config.json` keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model_type` | str | `"logistic"` | `"logistic"` \| `"mlp"` \| `"cnn"` |
| `lr` | float | `0.01` | Adam learning rate |
| `epochs` | int | `20` | Training epochs |
| `hidden` | int | `128` | MLP hidden layer width |
| `conv_channels` | int | `16` | CNN first conv output channels |
| `dropout` | float | `0.0` | Dropout probability |
| `augment` | bool | `false` | Concat augmented train split (doubles training set) |

### Models

- **logistic**: `Flatten → Linear(256, 3)` — baseline, ~0.65–0.72 accuracy.
- **mlp**: `Flatten → Linear(256, H) → ReLU → Dropout → Linear(H, 3)` — ~0.78–0.85.
- **cnn**: Two conv blocks (`1→ch→ch×2`, MaxPool×2) + `Linear(ch×2×16, 64) → Linear(64, 3)` — ~0.90–0.95.

### Stdout contract

```json
{
  "metrics":           {"accuracy": 0.91, "macro_f1": 0.91},
  "per_domain":        {"default": {"accuracy": 0.91, "macro_f1": 0.91}},
  "telemetry_summary": {"total_steps": 15, "final_train_loss": 0.22,
                        "best_val_metric": 0.93, "throughput_samples_per_sec": 5200.0},
  "status":            "success",
  "benchmark_raw":     "model=cnn epochs=15 lr=0.01 ...",
  "telemetry":         [{"epoch": 1, "train_loss": 0.95, "val_metric": 0.52, ...}, ...]
}
```

The `telemetry` key is **extra** — `EvaluatorAdapter` ignores it; `shapes-mission.py` reads it to write `nodes/<id>/telemetry.jsonl`.

## Mission script (`shapes-mission.py`)

Runs 6 ticks + 1 cheat probe, exercising the complete engine pipeline.

### Tick plan

| Tick | Node | Family | Config | Expected accuracy |
|------|------|--------|--------|-------------------|
| 1 | `t1-logistic` | training | logistic, lr=0.01, epochs=20 | ~0.65–0.72 |
| 2 | `t2-mlp` | training | mlp, lr=0.005, epochs=30, hidden=128 | ~0.78–0.85 |
| 3 | `t3-cnn` | arch | cnn, lr=0.01, epochs=15, channels=16 | ~0.90–0.95 |
| 4 | `t4-cnn-aug` | data-augmentation | cnn + augment=True | ~0.91–0.95 |
| 5 | `t5-crossover` | arch (crossover) | CNN arch × MLP lr, augment=True | ~0.90–0.95 |
| CHEAT | `t-cheat` | training | duplicate per_sample_hashes | **REJECTED** |

### Engine features exercised

| Feature | Where |
|---------|-------|
| `FrozenSplitManager.freeze_splits` | Mission start — locks test+val splits |
| `IntegrityGate.check` | Pre-eval on every node (dummy result at baseline) |
| `IntegrityGate` — no_test_leakage | Cheat probe — duplicate per_sample_hashes → rejected |
| `EvaluatorAdapter.run` | Real training + metrics for each node |
| Telemetry extraction | Subprocess JSON `telemetry` array → `nodes/<id>/telemetry.jsonl` |
| `TreeEngine.should_crossover` | T3 × T2 distinct-lineage check |
| `TreeEngine.propose_crossover` | Genome merge (CNN arch + MLP lr) |
| `TreeEngine.prune` + `store.gc` | Losers pruned; blobs GC'd |
| `TreeEngine.best_frontier` | Returns highest-fitness done node |

### Assertions

| ID | Assertion |
|----|-----------|
| (a) | Winner accuracy ≥ 0.88 (target beaten) |
| (b) | Winner is NOT `t1-logistic` (mutation improved over baseline) |
| (c) | Cheat candidate rejected — `IntegrityGate.no_test_leakage=False` |
| (d) | At least one crossover node with `status=done` in the tree |
| (e) | `nodes/<id>/telemetry.jsonl` written with real per-epoch curves (≥2 records, changing `train_loss`) |
| (f) | `ci/out/shapes-tree.png` exists |

### Output files

| Path | Description |
|------|-------------|
| `ci/out/shapes-tree.png` | Evolution frontier plot (accuracy vs tick) |
| `<run_dir>/decision-log.md` | Human-readable tick-by-tick decision log |
| `<run_dir>/nodes/<id>/telemetry.jsonl` | Per-epoch training curves |

## Design notes

**Why the accuracy gap is genuine** — shapes are drawn at random positions and sizes,
so a linear classifier cannot exploit a fixed spatial template; it can only learn the
mean pixel distribution per class (~65% ceiling).  A 2-conv CNN learns local
edge/shape features that generalise across positions and consistently reaches 90%+.
The 25-point gap is not staged.

**Why seed=42 determinism matters** — every run produces identical images, splits,
and training trajectories.  The benchmark can be reproduced byte-for-byte on any
machine with the same torch+numpy+cv2 versions.

**CPU-only** — no CUDA calls; total runtime is dominated by the 5 training runs
(~20–30 epochs each on 360 samples).  Expected wall time: 60–180 seconds.
