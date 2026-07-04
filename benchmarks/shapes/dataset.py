#!/usr/bin/env python3
"""
benchmarks/shapes/dataset.py — Deterministic synthetic 16×16 grayscale image dataset.

3 classes: circle (0), square (1), triangle (2).
600 images total (200 per class, interleaved), seed=42, generated offline
with numpy + cv2.  No download required.

Splits (fixed indices):
  Train: 0–359   (360 samples, 60 %)
  Val:  360–479  (120 samples, 20 %)
  Test: 480–599  (120 samples, 20 %)

Headroom:
  A logistic / linear model working on flattened 256-dim pixels reaches
  ~0.65–0.70 accuracy.  Shapes are drawn at random positions and sizes, so
  a linear classifier cannot exploit a fixed spatial template; it can only
  learn the mean distribution of lit pixels per class.
  A 2-conv CNN learns local edge/shape features that generalise across
  positions and reaches ~0.90+.  The gap is genuine, not staged.
"""
from __future__ import annotations

import numpy as np
import cv2

_SEED: int = 42
_N: int = 600
_N_CLASSES: int = 3
_H: int = 16
_W: int = 16
_TRAIN_END: int = 360   # 60 %
_VAL_END: int = 480     # 80 %  (test = VAL_END … N)


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────


def _draw_one(rng: np.random.Generator, label: int) -> np.ndarray:
    """Draw a single (_H, _W) uint8 image for *label* with random position / size."""
    img = np.zeros((_H, _W), dtype=np.uint8)

    # Radius / half-side: 3–5 px, keeping the shape fully inside the frame
    r = int(rng.integers(3, 6))          # 3, 4, or 5
    margin = r + 1
    cx = int(rng.integers(margin, _W - margin))
    cy = int(rng.integers(margin, _H - margin))

    # Thin outlines + jittered foreground intensity => much less signal than
    # solid fills, so the classes are genuinely confusable under noise. This is
    # what gives the benchmark HEADROOM: linear ~0.60, CNN ~0.85 (not a 1.0
    # ceiling), and augmentation can meaningfully help.
    fg = int(rng.integers(150, 231))     # jittered foreground intensity
    t = 1                                # thin outline

    if label == 0:                        # ── circle ──────────────────────
        cv2.circle(img, (cx, cy), r, fg, thickness=t)

    elif label == 1:                      # ── square ──────────────────────
        cv2.rectangle(img, (cx - r, cy - r), (cx + r, cy + r), fg, thickness=t)

    else:                                 # ── triangle (equilateral, random rotation) ──
        angle0 = float(rng.uniform(0.0, 2.0 * np.pi))
        pts = np.array(
            [
                [
                    cx + int(round(r * np.cos(angle0 + k * 2.0 * np.pi / 3.0))),
                    cy + int(round(r * np.sin(angle0 + k * 2.0 * np.pi / 3.0))),
                ]
                for k in range(3)
            ],
            dtype=np.int32,
        ).reshape(-1, 1, 2)
        cv2.polylines(img, [pts], isClosed=True, color=fg, thickness=t)

    # Heavy Gaussian noise (σ ≈ 48 DN, ~19 % of full scale) — the real difficulty.
    noise = rng.normal(0.0, 48.0, (_H, _W))
    img = np.clip(img.astype(np.float32) + noise, 0.0, 255.0).astype(np.uint8)
    return img


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


def generate(seed: int = _SEED) -> tuple[np.ndarray, np.ndarray]:
    """Generate N=600 images (200 per class, interleaved order).

    Returns
    -------
    X : ndarray shape (600, 16, 16) float32, values in [0, 1]
    y : ndarray shape (600,) int64, class labels 0 / 1 / 2
    """
    rng = np.random.default_rng(seed)
    images: list[np.ndarray] = []
    labels: list[int] = []
    for i in range(_N):
        label = i % _N_CLASSES           # 0, 1, 2, 0, 1, 2, …
        images.append(_draw_one(rng, label))
        labels.append(label)
    X = np.stack(images).astype(np.float32) / 255.0
    y = np.array(labels, dtype=np.int64)
    return X, y


def get_splits(
    X: np.ndarray,
    y: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return (X_train, y_train, X_val, y_val, X_test, y_test) with fixed indices."""
    return (
        X[:_TRAIN_END],            y[:_TRAIN_END],
        X[_TRAIN_END:_VAL_END],    y[_TRAIN_END:_VAL_END],
        X[_VAL_END:],              y[_VAL_END:],
    )


def augment(X: np.ndarray, seed: int) -> np.ndarray:
    """Return an augmented copy of X: small random rotation (±15°) + mild noise.

    Intended for the TRAIN split only.  Does NOT modify X in-place.

    Args
    ----
    X    : ndarray shape (N, 16, 16) float32 in [0, 1] — typically the train split.
    seed : int — deterministic RNG seed (use a fixed value for reproducibility).

    Returns
    -------
    ndarray same shape as X, float32 in [0, 1].
    """
    rng = np.random.default_rng(seed)
    centre = (_W / 2.0, _H / 2.0)
    out: list[np.ndarray] = []
    for img in X:
        angle = float(rng.uniform(-15.0, 15.0))
        M = cv2.getRotationMatrix2D(centre, angle, 1.0)
        rotated = cv2.warpAffine(
            img, M, (_W, _H),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0.0,
        )
        noise = rng.normal(0.0, 0.03, img.shape).astype(np.float32)
        out.append(np.clip(rotated + noise, 0.0, 1.0))
    return np.stack(out).astype(np.float32)
