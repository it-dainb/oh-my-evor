"""Training loop for the golden fixture — injects TelemetryCallback per mandate."""
import os

import torch
import torch.optim as optim
from torch.utils.data import DataLoader

from evor.telemetry import TelemetryCallback


def train(model, train_loader: DataLoader, epochs: int = 2) -> None:
    """Train model for ``epochs`` epochs with AdamW + cross-entropy.

    Args:
        model:        A model returned by build_model().
        train_loader: DataLoader yielding (x, y) batches.
        epochs:       Number of training epochs.
    """
    node_id = os.environ.get("EVOR_NODE_ID", "fixture-node")
    run_id = os.environ.get("EVOR_RUN_ID", "fixture-run")

    optimizer = optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.01)
    criterion = torch.nn.CrossEntropyLoss()
    telemetry = TelemetryCallback(node_id=node_id, run_id=run_id)

    model.train()
    global_step = 0
    for epoch in range(epochs):
        for x, y in train_loader:
            optimizer.zero_grad()
            out = model(x)
            loss = criterion(out, y)
            loss.backward()
            optimizer.step()

            telemetry.log(
                step=global_step,
                train_loss=loss.item(),
                epoch=float(epoch),
                lr=optimizer.param_groups[0]["lr"],
            )
            global_step += 1
