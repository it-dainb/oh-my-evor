"""BROKEN backbone — forward() raises RuntimeError intentionally.

BROKEN: fails ForgeStructureGate.forward_pass because the forward method
raises at runtime. All file structure and seam checks pass; only the
subprocess forward-pass execution fails.
"""
import torch.nn as nn


class CrashBackbone(nn.Module):
    """Seam file present, build_model() works — but forward() crashes."""

    def __init__(self) -> None:
        super().__init__()

    def forward(self, x):
        raise RuntimeError(
            "Intentional crash: CrashBackbone.forward() — "
            "this candidate fails the forward-pass sub-check."
        )
