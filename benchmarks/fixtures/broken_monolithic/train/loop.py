"""Valid training loop for broken_monolithic fixture (only model_seams fails)."""
import json
import os
from datetime import datetime, timezone

import torch
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset


def train(model, epochs: int = 1) -> None:
    node_id = os.environ.get("EVOR_NODE_ID", "fixture-node")
    run_id = os.environ.get("EVOR_RUN_ID", "fixture-run")
    tel_path = os.environ.get("EVOR_TELEMETRY_PATH")

    x = torch.randn(32, 3, 32, 32)
    y = torch.randint(0, 10, (32,))
    loader = DataLoader(TensorDataset(x, y), batch_size=32)

    optimizer = optim.AdamW(model.parameters(), lr=0.001)
    criterion = torch.nn.CrossEntropyLoss()

    model.train()
    for step, (xb, yb) in enumerate(loader):
        optimizer.zero_grad()
        loss = criterion(model(xb), yb)
        loss.backward()
        optimizer.step()

        if tel_path:
            record = {
                "step": step,
                "node_id": node_id,
                "run_id": run_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "train_loss": loss.item(),
            }
            with open(tel_path, "a") as f:
                f.write(json.dumps(record) + "\n")
