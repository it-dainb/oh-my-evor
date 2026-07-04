"""BROKEN training loop (embedding family) — optimizer, loss, DataLoader present; telemetry absent.

BROKEN: fails ForgeStructureGate check #6 because no telemetry instrumentation
(neither the callback class nor the evor telemetry import) appears anywhere in
train/ or the candidate root.
All other checks (genome_yaml, model_seams, train_ops, forward_pass, eval_locked)
pass normally.

NOTE: this is a non-CNN (embedding-family) fixture — demonstrates that the gate
is architecture-agnostic and enforces telemetry across all model families.
"""
import torch
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset


def train(model, epochs: int = 1) -> None:
    """Train embedding model with cosine-embedding loss — no telemetry instrumentation."""
    # Dummy pairs of token-ID sequences (batch=32, seq_len=16)
    seq1 = torch.randint(0, 1000, (32, 16))
    seq2 = torch.randint(0, 1000, (32, 16))
    labels = torch.ones(32)  # +1 = similar pair

    loader = DataLoader(TensorDataset(seq1, seq2, labels), batch_size=16)

    optimizer = optim.AdamW(model.parameters(), lr=0.001)
    criterion = torch.nn.CosineEmbeddingLoss()

    model.train()
    for xb1, xb2, yb in loader:
        optimizer.zero_grad()
        emb1 = model(xb1)
        emb2 = model(xb2)
        loss = criterion(emb1, emb2, yb)
        loss.backward()
        optimizer.step()
        # Intentionally absent: no telemetry instrumentation — Selector will reject this candidate.
