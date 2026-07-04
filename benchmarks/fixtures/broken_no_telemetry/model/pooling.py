"""Pooling seam — mean-pool over the sequence dimension.

Reduces (batch, seq_len, embed_dim) to (batch, embed_dim).
"""
import torch.nn as nn


class MeanPooling(nn.Module):
    """Mean-pool token embeddings along the sequence dimension (dim=1)."""

    def forward(self, x):
        """Return mean of x over sequence axis; output shape (batch, embed_dim)."""
        return x.mean(dim=1)
