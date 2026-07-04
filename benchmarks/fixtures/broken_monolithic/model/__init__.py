"""Monolithic model — no separate backbone.py / head.py seam files.

BROKEN: fails ForgeStructureGate.model_seams because backbone.py and head.py
are absent; everything is packed into this single file. The model still runs
correctly (forward_pass sub-check passes), but the seam structure required
by the genome materialization protocol is missing.
"""
import torch.nn as nn


class MonolithicModel(nn.Module):
    """All components inlined — no addressable seams."""

    def __init__(self) -> None:
        super().__init__()
        # backbone logic inlined — NOT in a separate backbone.py
        self.backbone = nn.Sequential(
            nn.Conv2d(3, 8, kernel_size=3, padding=1),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d(2),
            nn.Flatten(),
        )
        # neck inlined
        self.neck = nn.Identity()
        # head inlined — NOT in a separate head.py
        self.head = nn.Linear(32, 10)

    def forward(self, x):
        x = self.backbone(x)
        x = self.neck(x)
        return self.head(x)


def build_model() -> MonolithicModel:
    """Entry point — model is functional but genome seams are missing."""
    return MonolithicModel()
