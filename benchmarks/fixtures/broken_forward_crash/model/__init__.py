"""Valid model package structure — only the backbone forward() crashes."""
import torch.nn as nn

from .backbone import CrashBackbone
from .head import LinearHead
from .neck import IdentityNeck


class TinyModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.backbone = CrashBackbone()
        self.neck = IdentityNeck()
        self.head = LinearHead(32, 10)

    def forward(self, x):
        x = self.backbone(x)   # raises RuntimeError
        x = self.neck(x)
        return self.head(x)


def build_model() -> TinyModel:
    return TinyModel()
