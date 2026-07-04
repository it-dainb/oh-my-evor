"""Loss function factory for the golden fixture."""
import torch.nn as nn


def get_criterion() -> nn.CrossEntropyLoss:
    """Return a cross-entropy loss for multi-class classification."""
    return nn.CrossEntropyLoss()


# Module-level alias so train_ops AST scan detects a loss name
criterion = get_criterion()
