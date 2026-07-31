"""Phase 0b (RALPLAN-DR REV 5) — a frozen split must not change under it.

Observed in run 29d17abc: the frozen test split went from item_count=2 to
item_count=1, with no decision recorded. A shrinking eval set invalidates every
fitness comparison made across it, and 8 of 22 domains were already at n<=2.

The plan carried this as "an unlocated retry caller" and time-boxed the hunt.
The session log locates it: `evor_freeze_splits` was called three times with the
same mission_id and eval_version but a progressively narrower dataset_ref
(`data/corpora/v10`, then `data/corpora/v10/_freeze_anchor` twice).

There is no retry wrapper. `_freeze_one` names its output
`frozen-splits/{eval_version}-{split_type}.json` — dataset_ref appears in neither
the filename nor the split_id — and writes it unconditionally. So a second freeze
over a different, smaller dataset overwrites the first in place. The write itself
is already single-shot at the end of the function, which is why a mid-loop crash
could never have produced this and why the original crash theory did not fit.

Frozen means frozen: re-freezing to different content raises, and re-freezing to
identical content is a no-op. Deliberate re-freezing stays possible through an
explicit opt-in, so this fails loud (P5) without becoming a lockout (PM3).
"""

from __future__ import annotations

import pytest

from evor.freeze import FrozenSplitManager


def _config(mission_id: str, test: dict, val: dict) -> dict:
    return {"mission_id": mission_id, "test": test, "val": val}


@pytest.fixture()
def run_dir(tmp_path):
    d = tmp_path / "run"
    d.mkdir()
    return d


@pytest.fixture()
def dataset(tmp_path):
    p = tmp_path / "dataset"
    p.mkdir()
    return p


def test_freeze_then_refreeze_smaller_raises(run_dir, dataset):
    """The exact regression: 2 test samples frozen, then re-frozen with 1."""
    fm = FrozenSplitManager()
    fm.freeze_splits(dataset, _config("m1", {"0": b"a", "1": b"b"}, {"0": b"v"}), "v1", run_dir)

    with pytest.raises(ValueError) as exc:
        fm.freeze_splits(dataset, _config("m1", {"0": b"a"}, {"0": b"v"}), "v1", run_dir)

    msg = str(exc.value)
    assert "item_count" in msg or "2" in msg, msg
    assert "test" in msg


def test_shrink_leaves_the_original_split_intact(run_dir, dataset):
    """A rejected re-freeze must not half-apply — the frozen file is untouched."""
    fm = FrozenSplitManager()
    test_split, _ = fm.freeze_splits(dataset, _config("m1", {"0": b"a", "1": b"b"}, {"0": b"v"}), "v1", run_dir)
    original_hash = test_split.split_hash

    with pytest.raises(ValueError):
        fm.freeze_splits(dataset, _config("m1", {"0": b"a"}, {"0": b"v"}), "v1", run_dir)

    stored = (run_dir / "frozen-splits" / "v1-test.json").read_text()
    assert f'"item_count": 2' in stored
    assert original_hash in stored


def test_refreeze_with_different_content_at_same_size_raises(run_dir, dataset):
    """Silent substitution is as corrupting as shrinkage, and count alone misses it."""
    fm = FrozenSplitManager()
    fm.freeze_splits(dataset, _config("m1", {"0": b"a", "1": b"b"}, {"0": b"v"}), "v1", run_dir)

    with pytest.raises(ValueError):
        fm.freeze_splits(dataset, _config("m1", {"0": b"a", "1": b"DIFFERENT"}, {"0": b"v"}), "v1", run_dir)


def test_refreeze_identical_content_is_idempotent(run_dir, dataset):
    """Re-running the same freeze must not fail — init flows legitimately retry."""
    fm = FrozenSplitManager()
    first, _ = fm.freeze_splits(dataset, _config("m1", {"0": b"a", "1": b"b"}, {"0": b"v"}), "v1", run_dir)
    second, _ = fm.freeze_splits(dataset, _config("m1", {"0": b"a", "1": b"b"}, {"0": b"v"}), "v1", run_dir)
    assert first.split_hash == second.split_hash
    assert first.item_count == second.item_count


def test_explicit_optin_allows_a_deliberate_refreeze(run_dir, dataset):
    """Fail loud, not locked out (PM3) — an intentional re-freeze stays reachable."""
    fm = FrozenSplitManager()
    fm.freeze_splits(dataset, _config("m1", {"0": b"a", "1": b"b"}, {"0": b"v"}), "v1", run_dir)
    new_test, _ = fm.freeze_splits(
        dataset, _config("m1", {"0": b"a"}, {"0": b"v"}), "v1", run_dir, allow_refreeze=True
    )
    assert new_test.item_count == 1


def test_a_different_eval_version_is_a_different_split(run_dir, dataset):
    """Versioning is the supported way to change an eval set."""
    fm = FrozenSplitManager()
    fm.freeze_splits(dataset, _config("m1", {"0": b"a", "1": b"b"}, {"0": b"v"}), "v1", run_dir)
    v2_test, _ = fm.freeze_splits(dataset, _config("m1", {"0": b"a"}, {"0": b"v"}), "v2", run_dir)
    assert v2_test.item_count == 1
    assert (run_dir / "frozen-splits" / "v1-test.json").exists()
    assert (run_dir / "frozen-splits" / "v2-test.json").exists()
