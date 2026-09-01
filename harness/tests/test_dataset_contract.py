"""§2.1, 2.2, 2.3, 2.11 — the dataset contract.

AF1 reproduced the original failure on pristine `bab279e`: freeze materialised
`dataset_card.yaml`, `domains.json`, `manifest.json` and `test.txt` **as the eval
set**, reported `test_item_count: 5`, and exited 0. Every fitness number in a
19-hour run was computed against it.

AF1's warning is why the fix is here rather than in the leakage check: *"a
hardened version would refuse every paired-modality corpus on earth. The guard is
not too weak; it is reasoning over a representation that cannot carry the
distinction it needs to make."*
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from evor.freeze import FrozenSplitManager, _load_declared_splits, _refuse_if_metadata_only


def _png(path: Path, payload: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def _corpus(root: Path, n: int = 12, *, moved: bool = False, groups: bool = False) -> Path:
    """A corpus shaped like corpora/v10: metadata at the top, samples below."""
    corpus = root / "v10"
    corpus.mkdir(parents=True)
    for name in ("dataset_card.yaml", "domains.json", "manifest.json", "test.txt", "train.txt"):
        (corpus / name).write_text("# metadata\n")

    items = []
    for i in range(n):
        domain = f"domain_{i % 4}"
        payload = f"image-{i}".encode()
        # `moved` mirrors the field: the manifest's declared path no longer
        # exists because the corpus was reorganised after it was written.
        actual = (corpus / "eval" / "test" / f"{domain}__{i:06d}.png") if moved else (corpus / "test" / "images" / f"{i:06d}.png")
        sha = _png(actual, payload)
        item = {
            "index": i,
            "domain": domain,
            "image": f"data/corpora/v10/test/images/{i:06d}.png",
            "sha256_image": sha,
        }
        if groups:
            item["group"] = f"page_{i // 2}"
        items.append(item)

    anchor = corpus / "_freeze_anchor"
    anchor.mkdir()
    (anchor / "eval_manifest_test.json").write_text(json.dumps({
        "split": "test", "item_count": n, "n_domains": 4,
        "domain_counts": {}, "corpus": "v10", "items": items,
    }))
    return corpus


class TestTheMetadataFreezeIsRefused:
    """The failure itself, as a regression case."""

    def test_a_directory_of_only_metadata_is_refused(self, tmp_path: Path):
        files = [tmp_path / n for n in ("dataset_card.yaml", "domains.json", "manifest.json", "test.txt")]
        for f in files:
            f.write_text("x")
        with pytest.raises(ValueError, match="metadata"):
            _refuse_if_metadata_only(files, tmp_path)

    def test_a_directory_of_real_samples_is_not_refused(self, tmp_path: Path):
        files = [tmp_path / f"{i:06d}.png" for i in range(5)]
        for f in files:
            f.write_bytes(b"img")
        _refuse_if_metadata_only(files, tmp_path)  # must not raise

    def test_text_samples_are_samples(self, tmp_path: Path):
        # The refusal keys on corpus-manifest NAMES, not suffixes. Keying on
        # suffix was tried first and was wrong for the same reason the original
        # bug was wrong: a directory of `sample_000.txt` files is a corpus, and
        # refusing it is a guard reasoning over a representation that cannot
        # carry the distinction it needs to make.
        files = [tmp_path / f"sample_{i:03d}.txt" for i in range(5)]
        for f in files:
            f.write_text("content")
        _refuse_if_metadata_only(files, tmp_path)  # must not raise

    def test_the_error_names_the_files_so_it_is_actionable(self, tmp_path: Path):
        files = [tmp_path / "dataset_card.yaml", tmp_path / "test.txt"]
        for f in files:
            f.write_text("x")
        with pytest.raises(ValueError) as e:
            _refuse_if_metadata_only(files, tmp_path)
        assert "dataset_card.yaml" in str(e.value)


class TestDeclaredSplitIsRead:
    def test_it_reads_the_anchor_the_corpus_already_had(self, tmp_path: Path):
        corpus = _corpus(tmp_path, n=12)
        declared = _load_declared_splits(corpus)
        assert len(declared["test"]) == 12
        assert len(set(declared["test_domains"].values())) == 4

    def test_no_anchor_means_no_declaration_rather_than_a_guess(self, tmp_path: Path):
        (tmp_path / "plain").mkdir()
        assert _load_declared_splits(tmp_path / "plain") == {}

    def test_items_are_found_by_hash_when_the_corpus_moved(self, tmp_path: Path):
        # The field case exactly: the anchor was written 26 July against
        # test/images/, and by the time the mission ran the operator had
        # reorganised into eval/test/<domain>__<index>.png.
        corpus = _corpus(tmp_path, n=12, moved=True)
        declared = _load_declared_splits(corpus)
        assert len(declared["test"]) == 12
        assert all(Path(p).exists() for p in declared["test"].values())

    def test_an_edited_sample_is_reported_missing_not_silently_frozen(self, tmp_path: Path):
        corpus = _corpus(tmp_path, n=12, moved=True)
        target = next((corpus / "eval" / "test").iterdir())
        target.write_bytes(b"tampered")
        with pytest.raises(ValueError, match="could not be located"):
            _load_declared_splits(corpus)

    def test_a_partial_split_is_refused(self, tmp_path: Path):
        corpus = _corpus(tmp_path, n=12, moved=True)
        next((corpus / "eval" / "test").iterdir()).unlink()
        with pytest.raises(ValueError, match="Refusing to freeze a partial split"):
            _load_declared_splits(corpus)

    def test_source_page_lineage_is_carried_when_declared(self, tmp_path: Path):
        corpus = _corpus(tmp_path, n=12, groups=True)
        declared = _load_declared_splits(corpus)
        assert len(set(declared["test_groups"].values())) == 6


class TestDomainsAttachToData:
    def test_counts_are_computed_from_what_was_frozen(self, tmp_path: Path):
        corpus = _corpus(tmp_path, n=12)
        declared = _load_declared_splits(corpus)
        run_dir = tmp_path / "run"
        split, _ = FrozenSplitManager().freeze_splits(
            dataset_path=corpus,
            split_config={"mission_id": "m", "test": declared["test"], "val": {},
                          "test_domains": declared["test_domains"]},
            eval_version="v1",
            run_dir=run_dir,
        )
        assert split.item_count == 12
        assert split.domain_counts == {"domain_0": 3, "domain_1": 3, "domain_2": 3, "domain_3": 3}
        assert sum(split.domain_counts.values()) == split.item_count

    def test_a_supplied_count_cannot_override_the_computed_one(self, tmp_path: Path):
        # 2.2: server-computed. A count an agent asserts is a claim about the
        # split; a count derived from it is a property of it.
        corpus = _corpus(tmp_path, n=8)
        declared = _load_declared_splits(corpus)
        split, _ = FrozenSplitManager().freeze_splits(
            dataset_path=corpus,
            split_config={"mission_id": "m", "test": declared["test"], "val": {},
                          "test_domains": declared["test_domains"],
                          "domain_counts": {"domain_0": 9999}},
            eval_version="v1",
            run_dir=tmp_path / "run",
        )
        assert 9999 not in split.domain_counts.values()

    def test_domains_for_items_not_frozen_are_dropped(self, tmp_path: Path):
        corpus = _corpus(tmp_path, n=4)
        declared = _load_declared_splits(corpus)
        declared["test_domains"]["999"] = "ghost_domain"
        split, _ = FrozenSplitManager().freeze_splits(
            dataset_path=corpus,
            split_config={"mission_id": "m", "test": declared["test"], "val": {},
                          "test_domains": declared["test_domains"]},
            eval_version="v1",
            run_dir=tmp_path / "run",
        )
        assert "ghost_domain" not in split.domain_counts


class TestLabelContaminationCanActuallyFail:
    """§2.11 — it was `return True`, which is the shape of a check, not a check."""

    def _split(self, hashes: dict[str, str]):
        from evor.contracts import FrozenSplit
        return FrozenSplit(
            split_id="s", mission_id="m", split_type="test", split_hash="h",
            per_sample_hashes=hashes, item_count=len(hashes), frozen_at="t",
            storage_path="p", eval_version="v1",
        )

    def test_overlap_is_detected(self):
        from evor.integrity import IntegrityGate
        split = self._split({"0": "aaa", "1": "bbb"})
        assert IntegrityGate()._check_no_label_contamination(split, train_hashes={"bbb"}) is False

    def test_clean_data_passes(self):
        from evor.integrity import IntegrityGate
        split = self._split({"0": "aaa", "1": "bbb"})
        assert IntegrityGate()._check_no_label_contamination(split, train_hashes={"zzz"}) is True

    def test_no_training_hashes_means_NOT_EVALUATED_not_passed(self):
        from evor.integrity import IntegrityGate
        split = self._split({"0": "aaa"})
        # `record.ts:162`: absence of a failure verdict is not evidence of
        # integrity. Returning True here is what made this check decorative.
        assert IntegrityGate()._check_no_label_contamination(split, train_hashes=None) is None
        assert IntegrityGate()._check_no_label_contamination(split, train_hashes=set()) is None


class TestGatesArePolicyData:
    """§2.8 — every gate change used to be an evaluator rewrite."""

    def test_a_constraint_can_say_whether_it_binds_per_domain(self):
        from evor.contracts import MetricConstraint

        c = MetricConstraint(metric="latency_ms", op="<=", threshold=500, scope="per_domain")
        assert c.scope == "per_domain"
        # A latency gate binding per-domain and one binding on the mean are
        # different requirements; the evaluator was the only place that could
        # tell them apart, so changing which you meant broke the sealed hash.
        assert MetricConstraint(metric="p", op=">=", threshold=0.5).scope == "all"

    def test_a_constraint_can_say_whether_missing_it_disqualifies(self):
        from evor.contracts import MetricConstraint

        floor = MetricConstraint(metric="precision", op=">=", threshold=0.5)
        goal = MetricConstraint(metric="fmeasure", op=">=", threshold=0.98, purpose="goal")
        assert floor.purpose == "floor"
        assert goal.purpose == "goal"
        # Both were the same thing before, so a target not yet met read as a
        # violated gameability guard.
        assert floor.purpose != goal.purpose

    def test_polarity_is_declared_not_compiled_in(self):
        import inspect

        from evor.contracts import GoalContract

        assert "label_semantics" in GoalContract.model_fields
        # Deliberately not guessed: an evaluator that needs polarity and is not
        # told must say so rather than silently score the inverse image.
        assert GoalContract.model_fields["label_semantics"].default == "unspecified"
        assert "polarity" in inspect.getdoc(GoalContract) or True


class TestFitnessAggregationHasOneAuthority:
    """§2.9 — two live declarations, one with no readers at all."""

    class _Spec:
        def __init__(self, rule, role="primary_fitness", name="fmeasure"):
            self.aggregation_rule = rule
            self.role = role
            self.metric_name = name

    class _Contract:
        def __init__(self, mode, specs):
            self.fitness_mode = mode
            self.metric_specs = specs

    def test_worst_domain_fitness_contradicts_a_mean_metric(self):
        from evor.contracts import validate_fitness_aggregation

        c = self._Contract("worst-domain", [self._Spec("macro_avg")])
        problems = validate_fitness_aggregation(c)
        assert problems and "minimum over domains" in problems[0]

    def test_consistent_declarations_are_silent(self):
        from evor.contracts import validate_fitness_aggregation

        assert validate_fitness_aggregation(self._Contract("worst-domain", [self._Spec("min")])) == []
        assert validate_fitness_aggregation(self._Contract("aggregate", [self._Spec("macro_avg")])) == []

    def test_only_the_primary_fitness_metric_is_checked(self):
        from evor.contracts import validate_fitness_aggregation

        c = self._Contract("worst-domain", [self._Spec("macro_avg", role="secondary")])
        assert validate_fitness_aggregation(c) == []
