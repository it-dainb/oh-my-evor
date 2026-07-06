"""Training loop for the golden fixture — writes telemetry via $EVOR_TELEMETRY_PATH."""
import json
import os
from datetime import datetime, timezone

import torch
import torch.optim as optim
from torch.utils.data import DataLoader


def train(model, train_loader: DataLoader, epochs: int = 2) -> None:
    """Train model for ``epochs`` epochs with AdamW + cross-entropy.

    Args:
        model:        A model returned by build_model().
        train_loader: DataLoader yielding (x, y) batches.
        epochs:       Number of training epochs.
    """
    node_id = os.environ.get("EVOR_NODE_ID", "fixture-node")
    run_id = os.environ.get("EVOR_RUN_ID", "fixture-run")
    tel_path = os.environ.get("EVOR_TELEMETRY_PATH")

    optimizer = optim.AdamW(model.parameters(), lr=0.001, weight_decay=0.01)
    criterion = torch.nn.CrossEntropyLoss()

    model.train()
    global_step = 0
    for epoch in range(epochs):
        for x, y in train_loader:
            optimizer.zero_grad()
            out = model(x)
            loss = criterion(out, y)
            loss.backward()
            optimizer.step()

            if tel_path:
                record = {
                    "step": global_step,
                    "node_id": node_id,
                    "run_id": run_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "train_loss": loss.item(),
                    "epoch": float(epoch),
                    "lr": optimizer.param_groups[0]["lr"],
                }
                with open(tel_path, "a") as f:
                    f.write(json.dumps(record) + "\n")
            global_step += 1
