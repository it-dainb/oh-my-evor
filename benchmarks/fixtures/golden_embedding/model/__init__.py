"""Golden embedding model package — exposes build_model() as the genome seam entry point.

Architecture family: embedding (model_family: embedding in genome.yaml).
Required seam files: encoder.py (present) + pooling.py (present).
All 6 ForgeStructureGate sub-checks must pass for this fixture.
"""
import torch.nn as nn

from .encoder import TinyEncoder
from .pooling import MeanPooling


class TinyEmbeddingModel(nn.Module):
    """Minimal sentence-embedding model: encoder → mean-pool.

    Input:  (batch, seq_len) LongTensor of token IDs
    Output: (batch, embed_dim) float sentence embeddings
    """

    def __init__(self) -> None:
        super().__init__()
        self.encoder = TinyEncoder(vocab_size=1000, embed_dim=32)
        self.pooler = MeanPooling()

    def forward(self, input_ids):
        x = self.encoder(input_ids)   # (batch, seq_len, 32)
        return self.pooler(x)         # (batch, 32)


def build_model() -> TinyEmbeddingModel:
    """Genome seam entry point — returns a model instance ready for training.

    Called by the harness and by ForgeStructureGate's forward-pass check.
    """
    return TinyEmbeddingModel()
