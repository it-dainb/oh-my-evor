"""Synthetic DataLoader for the golden fixture (CPU-only, no real dataset needed)."""
import torch
from torch.utils.data import DataLoader, TensorDataset


def get_dataloaders(batch_size: int = 32, num_samples: int = 64):
    """Return (train_loader, val_loader) backed by random tensors.

    Generates a tiny synthetic CIFAR-10-shaped dataset so the training loop
    can run without any real data files.
    """
    x = torch.randn(num_samples, 3, 32, 32)
    y = torch.randint(0, 10, (num_samples,))
    dataset = TensorDataset(x, y)
    train_loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(dataset, batch_size=batch_size, shuffle=False)
    return train_loader, val_loader
