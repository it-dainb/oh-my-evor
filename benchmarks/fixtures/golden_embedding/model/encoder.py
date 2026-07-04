"""Encoder seam — tiny token embedding layer.

Maps (batch, seq_len) LongTensor of token IDs to (batch, seq_len, embed_dim) floats.
"""
import torch.nn as nn


class TinyEncoder(nn.Module):
    """Minimal encoder: single embedding table.

    Args:
        vocab_size: Size of the token vocabulary.
        embed_dim:  Embedding dimension.
    """

    def __init__(self, vocab_size: int = 1000, embed_dim: int = 32) -> None:
        super().__init__()
        self.embed = nn.Embedding(vocab_size, embed_dim)

    def forward(self, input_ids):
        """Return token embeddings of shape (batch, seq_len, embed_dim)."""
        return self.embed(input_ids)
