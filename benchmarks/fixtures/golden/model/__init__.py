"""Model package — exposes build_model() as the genome seam entry point."""
import torch.nn as nn

from .backbone import TinyBackbone
from .head import LinearHead
from .neck import IdentityNeck


class TinyModel(nn.Module):
    """Minimal 3-seam model: backbone → neck → head.

    Attributes backbone, neck, and head are distinct submodules addressable
    by genome.yaml for parametric and structural mutations.
    """

    def __init__(self) -> None:
        super().__init__()
        self.backbone = TinyBackbone()   # (B,3,H,W) → (B,32)
        self.neck = IdentityNeck()       # (B,32)    → (B,32)
        self.head = LinearHead(32, 10)   # (B,32)    → (B,10)

    def forward(self, x):
        x = self.backbone(x)
        x = self.neck(x)
        return self.head(x)


def build_model() -> TinyModel:
    """Genome seam entry point — returns a model instance ready for training.

    Called by the harness and by ForgeStructureGate's forward-pass check.
    """
    return TinyModel()
