"""Identity neck — pass-through for architectures that need no feature pyramid."""
import torch.nn as nn


class IdentityNeck(nn.Module):
    """No-op neck; preserves the backbone output unchanged."""

    def forward(self, x):
        return x
