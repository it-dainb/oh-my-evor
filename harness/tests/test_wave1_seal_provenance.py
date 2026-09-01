"""Wave 2 category 1 — seal and provenance integrity (RED phase).

Findings reproduced here come from the v1.2.0 field trace
(``docs/field-trace-v1.2.0/``), category 1: M-01, M-03, I-02, J-01, O-01.

Each test asserts the invariant the system is *supposed* to hold, not the
behaviour observed in the field. Where the current code satisfies the
invariant already, the test is left in place as a regression guard and is
recorded as ALREADY-GREEN in ``docs/field-trace-v1.2.0/red/T1-seal-provenance.md``.

Factory helpers mirror ``test_integrity.py`` deliberately — same FrozenSplit /
TreeNode / GoalContract shapes, so a reader can diff the two files.
"""

from __future__ import annotations

import hashlib
import json
import stat
from pathlib import Path

from evor.contracts import (
    EvaluationResult,
    FrozenSplit,
    GoalContract,
    MutationLocusArch,
    MutationLocusDataAugmentation,
    TelemetrySummary,
    TreeNode,
)
from evor.freeze import FrozenSplitManager, _compute_split_hash
from evor.integrity import IntegrityGate


# ─────────────────────────────────────────────────────────────────────────────
# Helpers / factories (mirrors test_integrity.py)
# ─────────────────────────────────────────────────────────────────────────────

def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _make_frozen_split(
    run_dir: Path,
    samples: dict[str, bytes],
    eval_version: str = "v1",
    mission_id: str = "test-mission",
) -> FrozenSplit:
    per_sample_hashes = {k: _sha256(v) for k, v in samples.items()}
    split_hash = _compute_split_hash(per_sample_hashes)

    split_dir = run_dir / "frozen-splits" / f"{eval_version}-test"
    split_dir.mkdir(parents=True, exist_ok=True)
    for idx, data in samples.items():
        f = split_dir / str(idx)
        f.write_bytes(data)
        f.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)

    split = FrozenSplit(
        split_id=f"{mission_id}-{eval_version}-test",
        mission_id=mission_id,
        split_type="test",
        split_hash=split_hash,
        per_sample_hashes=per_sample_hashes,
        item_count=len(samples),
        frozen_at="2026-08-23T00:00:00Z",
        storage_path=str(run_dir / "frozen-splits" / f"{eval_version}-test.json"),
        eval_version=eval_version,
    )
    (run_dir / "frozen-splits" / f"{eval_version}-test.json").write_text(
        split.model_dump_json(indent=2)
    )
    return split


def _make_node(
    node_id: str = "node-test-001",
    name: str | None = None,
    family: str = "arch",
    eval_version: str = "v1",
) -> TreeNode:
    if family == "data-augmentation":
        locus = MutationLocusDataAugmentation(family="data-augmentation", path="data/aug")
        approach_family = "data-augmentation"
    else:
        locus = MutationLocusArch(family="arch", path="model/")
        approach_family = "arch"

    return TreeNode(
        id=node_id,
        name=name,
        parent_ids=[],
        approach_family=approach_family,
        hypothesis_id="hyp-001",
        code_ref=f"nodes/{node_id}/code/",
        genome_ref="genome-ref-abc",
        data_version_ref="data-v1",
        config={},
        metrics={"fmeasure": 0.687},
        eval_version=eval_version,
        lesson_ids=[],
        citations=[],
        integrity_status="pending",
        status="done",
        is_crossover=False,
        visit_count=1,
        depth=0,
        created_at="2026-08-23T00:00:00Z",
        mutation_locus=locus,
    )


def _make_goal(
    locked_split_hash: str,
    eval_script_hash: str,
    eval_version: str = "v1",
) -> GoalContract:
    return GoalContract(
        mission_id="test-mission",
        mode="from-scratch",
        mission_type="fixed",
        task_description="Binarise degraded document images",
        dataset_ref="/data/corpora/v10",
        metric_specs=[{
            "metric_name": "fmeasure",
            "direction": "higher",
            "domain_applicability": "all",
            "aggregation_rule": "macro_avg",
            "role": "primary_fitness",
            "sota_bar": None,
        }],
        fitness_mode="aggregate",
        eval_version=eval_version,
        baseline_value=0.5961,
        stop_condition={"type": "target"},
        wildness=0.5,
        budget={
            "max_iterations": 200,
            "plateau_window": 8,
            "circuit_breaker": 5,
            "max_cost_usd": 0.0,
        },
        locked_split_hash=locked_split_hash,
        eval_script_hash=eval_script_hash,
        allowed_licenses=["MIT", "Apache-2.0", "CC-BY-4.0"],
        created_at="2026-08-23T00:00:00Z",
    )


def _make_result(score: float = 0.687, eval_version: str = "v1") -> EvaluationResult:
    return EvaluationResult(
        node_id="node-test-001",
        run_id="run-live-01",
        eval_version=eval_version,
        metrics={"fmeasure": score},
        per_domain={"office_scan": {"fmeasure": score}},
        fitness_value=score,
        telemetry_summary=TelemetrySummary(total_steps=12000),
        status="success",
        benchmark_raw="",
        timestamp="2026-08-24T01:56:05Z",
    )


def _write_telemetry(path: Path, n: int = 12) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        for step in range(n):
            fh.write(json.dumps({
                "step": step,
                "train_loss": 2.0 - step * 0.1,
                "grad_norm": 1.5,
                "node_id": "n1",
                "run_id": "run-live-01",
                "timestamp": "2026-08-24T00:00:00Z",
            }) + "\n")


# ─────────────────────────────────────────────────────────────────────────────
# M-01 / I-02 — the sealed evaluator must be an independent per-run copy
# ─────────────────────────────────────────────────────────────────────────────

class TestM01SealIsAnIndependentCopy:
    """M-01 / I-02 — all three runs' ``eval-suites/v1.py`` were ONE inode, nlink 5.

    Invariant: an artifact a run declares "sealed" must be byte-stable for the
    lifetime of that run. Sealing must therefore either materialise an
    independent copy, or refuse a target that shares an inode with a file
    outside the run's protected tree.

    Current behaviour: nothing in the harness materialises the per-run
    ``eval-suites/<eval_version>.py``. The one code path that *does* copy
    content into a run directory — ``FrozenSplitManager`` for the frozen splits —
    is the closest existing analogue, and the trace's own remedy for the
    evaluator ("copy, do not link") is what these tests pin. A rewrite through
    an alias outside the run dir must not reach the run's copy.
    """

    def test_frozen_sample_is_independent_of_its_source_file(self, tmp_path: Path):
        """M-01 — a frozen sample must not track later edits to its source file.

        Invariant: freezing copies bytes; the frozen artifact is decoupled from
        the path it came from.
        Current behaviour: ``_sample_to_bytes`` uses ``shutil.copy2``, so this
        holds for the frozen splits. It is the property the evaluator seal
        lacks, and this test is the reference for what "sealed" must mean.
        """
        source = tmp_path / "corpus" / "page-17.png"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"ORIGINAL PAGE BYTES")

        run_dir = tmp_path / "run"
        run_dir.mkdir()
        fm = FrozenSplitManager()
        split, _ = fm.freeze_splits(
            tmp_path / "corpus",
            {"mission_id": "m1", "test": {"0": source}, "val": {"0": b"v"}},
            "v1",
            run_dir,
        )

        # Rewrite the ORIGINAL, outside the run tree.
        source.chmod(0o644)
        source.write_bytes(b"REWRITTEN PAGE BYTES")

        frozen = run_dir / "frozen-splits" / "v1-test" / "0.png"
        assert frozen.read_bytes() == b"ORIGINAL PAGE BYTES", (
            "the frozen copy tracked a rewrite of its source file — it is a link, not a copy"
        )
        assert fm.verify_frozen_split(split, run_dir) is True

    # The second half of M-01 — "the seal must reject a target that is a hardlink
    # into another run" — has no home in the harness: nothing in evor/ materialises
    # the per-run eval-suites/<eval_version>.py. It is asserted against the real
    # sealing tool in mcp/tests/wave1-seal-provenance.test.ts.


# ─────────────────────────────────────────────────────────────────────────────
# M-03 — the leakage check that was reclassified to dismiss its own failure
# ─────────────────────────────────────────────────────────────────────────────

def _office_corpus(run_dir: Path) -> tuple[FrozenSplit, Path]:
    """The ``office_scan``/``office_print`` shape: 100% source-page leakage.

    Two source pages, each degraded twice. One degradation of each lands in
    train, the other in test. Image bytes differ (different degradation); the
    ground-truth mask is byte-identical (content-addressed GT of the same page).
    """
    test_samples = {
        "office_scan_p17_b": b"PAGE17-degraded-SCAN",
        "office_print_p42_b": b"PAGE42-degraded-PRINT",
    }
    frozen_test = _make_frozen_split(run_dir, test_samples)

    # The train-side half, recorded through the provenance channel the gate reads.
    prov_path = run_dir / "nodes" / "node-test-001" / "data-provenance.jsonl"
    prov_path.parent.mkdir(parents=True, exist_ok=True)
    with open(prov_path, "w") as fh:
        for train_id, source_page in (
            ("office_scan_p17_a", "page-17"),
            ("office_print_p42_a", "page-42"),
        ):
            fh.write(json.dumps({
                "sample_id": train_id,
                "source_sample_id": source_page,
                "split_type": "train",
                "transform_applied": ["degrade"],
                "is_synthetic": True,
                "verified_not_in_test": True,
            }) + "\n")

    # The GT masks, byte-identical between the train and test degradation of a page.
    gt_dir = run_dir / "gt"
    gt_dir.mkdir(parents=True, exist_ok=True)
    for item_id, page in (
        ("office_scan_p17_a", b"MASK-PAGE-17"),
        ("office_scan_p17_b", b"MASK-PAGE-17"),
        ("office_print_p42_a", b"MASK-PAGE-42"),
        ("office_print_p42_b", b"MASK-PAGE-42"),
    ):
        (gt_dir / item_id).write_bytes(page)

    return frozen_test, prov_path


def _run_gate(
    run_dir: Path,
    frozen_test: FrozenSplit,
    provenance_path: Path | None,
    node: TreeNode | None = None,
    telemetry_path: Path | None = None,
):
    gate = IntegrityGate()
    eval_script = run_dir / "eval-suites" / "v1.py"
    eval_script.parent.mkdir(parents=True, exist_ok=True)
    content = "# canonical evaluator\n"
    eval_script.write_text(content)

    node = node or _make_node(family="data-augmentation")
    if telemetry_path is None:
        telemetry_path = run_dir / "nodes" / node.id / "telemetry.jsonl"
        _write_telemetry(telemetry_path)

    goal = _make_goal(frozen_test.split_hash, _sha256(content.encode()))
    return gate.check(
        node=node,
        result=_make_result(),
        goal=goal,
        telemetry_path=telemetry_path,
        eval_script_path=eval_script,
        frozen_test=frozen_test,
        provenance_path=provenance_path,
        run_dir=run_dir,
    )


class TestM03SourcePageLeakage:
    """M-03 — a leakage check was reclassified so its own failing instance passed.

    The corpus is content-addressed and built by degrading source pages. When the
    SAME source page is degraded into a train item and a test item, the two have
    different image bytes and a byte-identical GT mask. The field harness counted
    exactly that signal ("48 benign mask-only collisions ignored") and then
    declared it benign, citing this corpus's own leakage count as the reason.

    Invariant: a test item whose source page also appears in train is leaked and
    must fail the gate. The contract's autonomy charter says a change "may make
    the evaluation harder or more honest, never easier".
    """

    def test_same_source_page_in_train_and_test_is_flagged(self, tmp_path: Path):
        """M-03 — the office_scan/office_print shape, 100% leaked.

        Invariant: two degradations of one source page, split across train and
        test, must fail the gate (no_label_contamination / no_test_leakage).
        Current behaviour: ``_check_no_label_contamination`` returns True
        unconditionally, ``_check_no_test_leakage`` only looks for duplicate
        hashes *within* the frozen test split, and check 9 compares
        ``source_sample_id`` against test *indices* only — so a shared source
        page is invisible on every one of the three surfaces. The gate passes.
        """
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        frozen_test, prov_path = _office_corpus(run_dir)

        report = _run_gate(run_dir, frozen_test, prov_path)

        leakage_seen = (
            not report.checks.no_test_leakage
            or not report.checks.no_label_contamination
            or not report.checks.data_provenance_valid
        )
        assert leakage_seen, (
            "train and test both contain a degradation of page-17 and page-42 "
            "(identical GT mask, different image bytes) and the gate reported "
            f"no leakage: no_test_leakage={report.checks.no_test_leakage}, "
            f"no_label_contamination={report.checks.no_label_contamination}, "
            f"data_provenance_valid={report.checks.data_provenance_valid}"
        )
        assert report.verdict == "failed", report.failure_reason

    def test_distinct_source_pages_sharing_a_gt_are_not_flagged(self, tmp_path: Path):
        """M-03, benign arm — the fix must not be "flag every mask collision".

        Invariant: two genuinely different source pages that happen to share a
        ground-truth mask (e.g. two blank-margin crops) are not leakage; the gate
        must pass.
        Current behaviour: passes trivially, because the gate does not look at
        masks or source pages at all. Kept so a GREEN-phase fix that flags all
        mask collisions fails here.
        """
        run_dir = tmp_path / "run"
        run_dir.mkdir()

        frozen_test = _make_frozen_split(run_dir, {
            "nabuco_p3": b"NABUCO-page-3-scan",
            "monk_cuper_p8": b"MONK-page-8-scan",
        })

        prov_path = run_dir / "nodes" / "node-test-001" / "data-provenance.jsonl"
        prov_path.parent.mkdir(parents=True, exist_ok=True)
        with open(prov_path, "w") as fh:
            for train_id, source_page in (
                ("livememory_p1", "livememory-page-1"),
                ("dibco2013_p2", "dibco2013-page-2"),
            ):
                fh.write(json.dumps({
                    "sample_id": train_id,
                    "source_sample_id": source_page,
                    "split_type": "train",
                    "transform_applied": ["degrade"],
                    "is_synthetic": False,
                    "verified_not_in_test": True,
                }) + "\n")

        # Coincidentally identical GT across four DISTINCT source pages.
        gt_dir = run_dir / "gt"
        gt_dir.mkdir(parents=True, exist_ok=True)
        for item_id in ("nabuco_p3", "monk_cuper_p8", "livememory_p1", "dibco2013_p2"):
            (gt_dir / item_id).write_bytes(b"MASK-MOSTLY-BLANK")

        report = _run_gate(run_dir, frozen_test, prov_path)

        assert report.checks.no_test_leakage is True
        assert report.checks.no_label_contamination is True
        assert report.checks.data_provenance_valid is True
        assert report.verdict == "passed", report.failure_reason


# ─────────────────────────────────────────────────────────────────────────────
# O-01 — node identity split-brain
# ─────────────────────────────────────────────────────────────────────────────

class TestO01NodeIdentitySplitBrain:
    """O-01 — the trainer writes ``nodes/<slug>/telemetry.jsonl``; the gate reads
    ``nodes/<uuid>/telemetry.jsonl``.

    Integrity check 5 looked under the UUID, found nothing, and failed a node
    with 12,000 well-formed telemetry records. That false negative stood as the
    run's final verdict and no candidate was ever re-scored.
    """

    def test_telemetry_written_under_the_slug_is_resolved(self, tmp_path: Path):
        """O-01 — telemetry_sane must not depend on which alias the writer used.

        Invariant: a node whose telemetry lives at ``nodes/<node.name>/`` passes
        ``telemetry_sane`` when the gate is handed the ``nodes/<node.id>/`` path
        — the node carries both identities, so the gate can resolve either.
        Current behaviour: ``_check_telemetry_sane`` returns False the moment the
        exact path it was handed does not exist. The ``_resolve_telemetry_path()``
        helper described in the trace exists only in the mutated plugin cache; it
        is in no commit in this repository.
        """
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        frozen_test = _make_frozen_split(run_dir, {"0": b"a", "1": b"b"})

        node = _make_node(node_id="afb204f4-66d0-4c6e-9f1e-ced66d31de8b",
                          name="iir-scan-binnet-02")

        # The trainer writes by SLUG.
        _write_telemetry(run_dir / "nodes" / node.name / "telemetry.jsonl", n=120)
        # The harness hands the gate the UUID path (evaluator.py:178).
        uuid_path = run_dir / "nodes" / node.id / "telemetry.jsonl"

        report = _run_gate(run_dir, frozen_test, None, node=node,
                           telemetry_path=uuid_path)

        assert report.checks.telemetry_sane is True, (
            "telemetry_sane failed a node whose telemetry.jsonl exists and is "
            f"well-formed at nodes/{node.name}/telemetry.jsonl; the gate looked "
            f"only under nodes/{node.id}/"
        )

    def test_a_node_with_no_telemetry_anywhere_still_fails(self, tmp_path: Path):
        """O-01, control arm — resolution must not become "pass when missing".

        Invariant: when no telemetry exists under either identity,
        ``telemetry_sane`` is False.
        Current behaviour: already correct; kept so a GREEN-phase fix cannot
        satisfy the test above by weakening the check.
        """
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        frozen_test = _make_frozen_split(run_dir, {"0": b"a", "1": b"b"})
        node = _make_node(node_id="afb204f4-66d0-4c6e-9f1e-ced66d31de8b",
                          name="iir-scan-binnet-02")

        report = _run_gate(run_dir, frozen_test, None, node=node,
                           telemetry_path=run_dir / "nodes" / node.id / "telemetry.jsonl")
        assert report.checks.telemetry_sane is False


# ─────────────────────────────────────────────────────────────────────────────
# J-01 — the seal re-applied over content changed out of band
# ─────────────────────────────────────────────────────────────────────────────

class TestJ01SealVerificationIgnoresFileMode:
    """J-01 — ``chmod 444`` was re-applied over an out-of-band rewrite.

    The agent isolated the guard's trigger token, patched the sealed evaluator
    through a split string literal, and then restored mode 444. Mode is not
    integrity.

    Invariant: verifying a sealed artifact compares CONTENT against the recorded
    hash. A read-only file whose bytes changed is a seal violation.
    """

    def test_content_change_under_mode_444_fails_no_eval_shift(self, tmp_path: Path):
        """J-01 — a 444 file whose bytes no longer match the contract hash.

        Invariant: ``no_eval_shift`` is False.
        Current behaviour: check 4 hashes file content, so this holds. Recorded
        as ALREADY-GREEN — the field failure was not here, it was that
        ``evor_seal_eval_script`` re-recorded the new hash (see
        ``mcp/tests/wave1-seal-provenance.test.ts``).
        """
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        frozen_test = _make_frozen_split(run_dir, {"0": b"a", "1": b"b"})

        eval_script = run_dir / "eval-suites" / "v1.py"
        eval_script.parent.mkdir(parents=True, exist_ok=True)
        sealed = "# evaluator rev 1\nLATENCY_GPU_MS_MAX = 10.0\n"
        eval_script.write_text(sealed)
        sealed_hash = _sha256(sealed.encode())
        eval_script.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)

        # Out-of-band rewrite, then the seal (mode 444) is re-applied.
        eval_script.chmod(0o644)
        eval_script.write_text("# evaluator rev 2\nLATENCY_GPU_MS_MAX = 500.0\n")
        eval_script.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)

        node = _make_node()
        _write_telemetry(run_dir / "nodes" / node.id / "telemetry.jsonl")
        goal = _make_goal(frozen_test.split_hash, sealed_hash)

        report = IntegrityGate().check(
            node=node,
            result=_make_result(),
            goal=goal,
            telemetry_path=run_dir / "nodes" / node.id / "telemetry.jsonl",
            eval_script_path=eval_script,
            frozen_test=frozen_test,
            provenance_path=None,
            run_dir=run_dir,
        )

        assert report.checks.no_eval_shift is False, (
            "the sealed evaluator's content changed and the gate accepted it "
            "because the file was still mode 444"
        )
        assert report.verdict == "failed"

    def test_frozen_split_rewrite_under_mode_444_is_detected(self, tmp_path: Path):
        """J-01 — the same trick against the frozen split, not the evaluator.

        Invariant: ``verify_frozen_split`` recomputes hashes, so restoring mode
        444 after a rewrite does not launder the change.
        Current behaviour: ``check_read_only`` passes (mode is correct) while
        ``verify_frozen_split`` catches the content. The gate must not be
        satisfied by the mode check alone.
        """
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        fm = FrozenSplitManager()
        split, _ = fm.freeze_splits(
            tmp_path,
            {"mission_id": "m1", "test": {"0": b"page-a", "1": b"page-b"}, "val": {"0": b"v"}},
            "v1",
            run_dir,
        )

        victim = run_dir / "frozen-splits" / "v1-test" / "0"
        victim.chmod(0o644)
        victim.write_bytes(b"page-a-TAMPERED")
        victim.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)

        assert fm.check_read_only(split, run_dir) is True, (
            "precondition: the mode-only guard is satisfied after re-chmod"
        )
        assert fm.verify_frozen_split(split, run_dir) is False, (
            "a rewritten frozen sample passed verification because mode 444 was restored"
        )
