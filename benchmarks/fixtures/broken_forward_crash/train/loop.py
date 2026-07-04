"""Valid training loop for broken_forward_crash fixture (only forward_pass fails)."""
import os

import torch
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

from evor.telemetry import TelemetryCallback


def train(model, epochs: int = 1) -> None:
    node_id = os.environ.get("EVOR_NODE_ID", "fixture-node")
    run_id = os.environ.get("EVOR_RUN_ID", "fixture-run")

    x = torch.randn(32, 3, 32, 32)
    y = torch.randint(0, 10, (32,))
    loader = DataLoader(TensorDataset(x, y), batch_size=32)

    optimizer = optim.AdamW(model.parameters(), lr=0.001)
    criterion = torch.nn.CrossEntropyLoss()
    telemetry = TelemetryCallback(node_id=node_id, run_id=run_id)

    model.train()
    for step, (xb, yb) in enumerate(loader):
        optimizer.zero_grad()
        loss = criterion(model(xb), yb)
        loss.backward()
        optimizer.step()
        telemetry.log(step=step, train_loss=loss.item())
