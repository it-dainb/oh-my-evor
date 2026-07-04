"""Valid model package — same as golden. Only eval_locked fails (tampered evaluate.py)."""
import torch.nn as nn

from .backbone import TinyBackbone
from .head import LinearHead
from .neck import IdentityNeck


class TinyModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.backbone = TinyBackbone()
        self.neck = IdentityNeck()
        self.head = LinearHead(32, 10)

    def forward(self, x):
        x = self.backbone(x)
        x = self.neck(x)
        return self.head(x)


def build_model() -> TinyModel:
    return TinyModel()
