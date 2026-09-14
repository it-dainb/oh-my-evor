"""no_test_leakage — the check under repair.

Flags a corpus when a test item shares a content hash with a training item.
Ground truth is content-addressed, so the same mask bytes can legitimately
appear twice; whether that is leakage depends on where the two items came from.
"""
import json
from pathlib import Path


def check(case, root):
    """Return True (clean), False (leaked)."""
    manifest = json.loads((Path(root) / case["manifest"]).read_text())
    train = manifest["train"]
    test = manifest["test"]
    train_img = {i["image_sha256"] for i in train}
    train_mask = {i["mask_sha256"] for i in train}
    for item in test:
        if item["image_sha256"] in train_img:
            return False
        if item["mask_sha256"] in train_mask:
            return False
    return True
