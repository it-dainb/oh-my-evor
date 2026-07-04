"""Linear classification head."""
import torch.nn as nn


class LinearHead(nn.Module):
    """Fully-connected classification head.

    Input:  (batch, input_dim)
    Output: (batch, num_classes) — raw logits
    """

    def __init__(self, input_dim: int = 32, num_classes: int = 10) -> None:
        super().__init__()
        self.fc = nn.Linear(input_dim, num_classes)

    def forward(self, x):
        return self.fc(x)
