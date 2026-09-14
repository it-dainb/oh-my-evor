"""Candidate model for node-1. This IS the candidate surface."""

import torch.nn as nn


def build_model(width=32):
    return nn.Sequential(nn.Conv2d(1, width, 3, padding=1), nn.ReLU())
