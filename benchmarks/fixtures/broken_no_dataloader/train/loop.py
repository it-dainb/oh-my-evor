"""BROKEN training loop — optimizer and loss present, DataLoader absent.

BROKEN: fails ForgeStructureGate.train_ops because no DataLoader is imported
or referenced. The optimizer (AdamW) and loss (CrossEntropyLoss) are present
so those sub-checks pass; only the DataLoader requirement fails.
"""
import os

import torch
import torch.optim as optim

from evor.telemetry import TelemetryCallback


def train(model, data: list, epochs: int = 1) -> None:
    """Train using a plain list of (x, y) tuples — no DataLoader.

    This is intentionally broken: the genome contract requires a DataLoader
    for reproducible shuffling and batching. Manual list iteration is not
    sufficient.
    """
    node_id = os.environ.get("EVOR_NODE_ID", "fixture-node")
    run_id = os.environ.get("EVOR_RUN_ID", "fixture-run")

    optimizer = optim.AdamW(model.parameters(), lr=0.001)
    criterion = torch.nn.CrossEntropyLoss()
    telemetry = TelemetryCallback(node_id=node_id, run_id=run_id)

    model.train()
    for step, (x, y) in enumerate(data):   # plain list, not a DataLoader
        optimizer.zero_grad()
        loss = criterion(model(x), y)
        loss.backward()
        optimizer.step()
        telemetry.log(step=step, train_loss=loss.item())
