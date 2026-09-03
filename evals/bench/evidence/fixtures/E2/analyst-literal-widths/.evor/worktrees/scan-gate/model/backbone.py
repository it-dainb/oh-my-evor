"""Candidate backbone for scan-gate-05.

Stage widths come from the mission-wide width table so that a width sweep does
not require touching this file.
"""
WIDTHS = {"narrow": [16, 24, 32, 32], "wide": [32, 64, 96, 96]}
import torch.nn as nn


def build_model(cfg):
    stages = []
    prev = 1
    for w in WIDTHS[cfg["width_profile"]]:
        stages += [nn.Conv2d(prev, w, 3, padding=1), nn.GroupNorm(1, w), nn.SiLU()]
        prev = w
    return nn.Sequential(*stages, nn.Conv2d(prev, 1, 1))
