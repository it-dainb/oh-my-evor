"""Frozen-split manifest support (project checkout copy)."""

FREEZE_MANIFEST_VERSION = 1


def freeze_splits(root, allow_refreeze=False):
    """Write the frozen split manifest and return its anchor."""
    return {"version": FREEZE_MANIFEST_VERSION, "root": str(root)}
