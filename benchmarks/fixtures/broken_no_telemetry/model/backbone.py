"""Tiny 2-layer CNN backbone — runs on CPU with no GPU or large-memory requirement."""
import torch.nn as nn


class TinyBackbone(nn.Module):
    """Minimal backbone: Conv2d(3→8) + ReLU + AdaptiveAvgPool2d(2) + Flatten.

    Input:  (batch, 3, H, W) — any spatial size >= 2
    Output: (batch, 32)      — 8 channels * 2*2 pooled spatial = 32 dims
    """

    def __init__(self) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(3, 8, kernel_size=3, padding=1)
        self.relu = nn.ReLU(inplace=True)
        self.pool = nn.AdaptiveAvgPool2d(2)
        self.flatten = nn.Flatten()

    def forward(self, x):
        x = self.conv1(x)
        x = self.relu(x)
        x = self.pool(x)
        return self.flatten(x)  # (batch, 32)
