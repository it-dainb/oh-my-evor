"""Training loop for the golden embedding fixture — injects TelemetryCallback per mandate."""
import os

import torch
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

from evor.telemetry import TelemetryCallback


def train(model, epochs: int = 2) -> None:
    """Train embedding model for ``epochs`` epochs with AdamW + cosine-embedding loss.

    Args:
        model:  A model returned by build_model() — accepts (batch, seq_len) LongTensor.
        epochs: Number of training epochs.
    """
    node_id = os.environ.get("EVOR_NODE_ID", "fixture-node")
    run_id = os.environ.get("EVOR_RUN_ID", "fixture-run")

    # Dummy similar pairs: seq1/seq2 are token-ID sequences, labels=+1 (similar)
    seq1 = torch.randint(0, 1000, (32, 16))
    seq2 = torch.randint(0, 1000, (32, 16))
    labels = torch.ones(32)
    loader = DataLoader(TensorDataset(seq1, seq2, labels), batch_size=16)

    optimizer = optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.01)
    criterion = torch.nn.CosineEmbeddingLoss()
    telemetry = TelemetryCallback(node_id=node_id, run_id=run_id)

    model.train()
    global_step = 0
    for epoch in range(epochs):
        for xb1, xb2, yb in loader:
            optimizer.zero_grad()
            emb1 = model(xb1)
            emb2 = model(xb2)
            loss = criterion(emb1, emb2, yb)
            loss.backward()
            optimizer.step()

            telemetry.log(
                step=global_step,
                train_loss=loss.item(),
                epoch=float(epoch),
                lr=optimizer.param_groups[0]["lr"],
            )
            global_step += 1
