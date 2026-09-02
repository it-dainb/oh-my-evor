"""
test_quality_gate.py — pytest suite for ForgeStructureGate + ProbeEDAGate.

Deterministic, CPU-only, runnable in evor-ml-test container.
The forward-pass sub-check runs torch in a subprocess — requires torch in the
container's Python environment; no direct torch import in this test file.

Fixture layout (benchmarks/fixtures/):
  golden/                  → all 6 sub-checks pass (CNN family, model_family: cnn)
  golden_embedding/        → all 6 sub-checks pass (embedding family, model_family: embedding)
  broken_monolithic/       → model_seams fails  (no backbone.py / head.py for cnn family)
  broken_no_dataloader/    → train_ops fails    (no DataLoader in train/)
  broken_forward_crash/    → forward_pass fails (backbone.forward() raises)
  broken_eval_tampered/    → eval_locked fails  (evaluate.py hash differs)
  broken_no_telemetry/     → telemetry fails    (embedding model, no TelemetryCallback)
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import importlib.util

import pytest

from evor.quality_gate import ForgeStructureGate, ProbeEDAGate, QualityReport

# ─────────────────────────────────────────────────────────────────────────────
# Fixture paths
# ─────────────────────────────────────────────────────────────────────────────

_FIXTURES = Path(__file__).parent.parent.parent / "benchmarks" / "fixtures"
_GOLDEN = _FIXTURES / "golden"


def _locked_eval_hash() -> str:
    """sha256 of the golden evaluate.py — used as the locked reference hash."""
    return hashlib.sha256((_GOLDEN / "evaluate.py").read_bytes()).hexdigest()


def _gate(locked_hash: str | None = None) -> ForgeStructureGate:
    return ForgeStructureGate(locked_eval_hash=locked_hash or _locked_eval_hash())


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate — golden fixture (all checks must pass)
# ─────────────────────────────────────────────────────────────────────────────



# The quality gate runs a real forward pass, so these classes need torch. The
# slim CI image (ci/docker/Dockerfile) deliberately ships without it; torch lives
# in the ML image (ci/docker/Dockerfile.ml). Without this guard the slim image
# reported 13 hard failures for an absence that is by design, which buries any
# real regression in noise. On the host and in the ML image these still run.
_requires_torch = pytest.mark.skipif(
    importlib.util.find_spec("torch") is None,
    reason="quality gate performs a real forward pass — needs torch (ML image only)",
)


@_requires_torch
class TestGoldenFixturePasses:
    """Golden candidate must pass every sub-check."""

    def test_golden_overall_pass(self) -> None:
        report = _gate().check(_GOLDEN)
        assert report.passed, f"Golden fixture failed: {report.failure_reasons}"

    def test_golden_genome_yaml(self) -> None:
        report = _gate().check(_GOLDEN)
        check = report.check_by_name("genome_yaml")
        assert check is not None
        assert check.passed, check.reason

    def test_golden_model_seams(self) -> None:
        report = _gate().check(_GOLDEN)
        check = report.check_by_name("model_seams")
        assert check is not None
        assert check.passed, check.reason

    def test_golden_train_ops(self) -> None:
        report = _gate().check(_GOLDEN)
        check = report.check_by_name("train_ops")
        assert check is not None
        assert check.passed, check.reason

    def test_golden_forward_pass(self) -> None:
        report = _gate().check(_GOLDEN)
        check = report.check_by_name("forward_pass")
        assert check is not None
        assert check.passed, check.reason

    def test_golden_eval_locked(self) -> None:
        report = _gate().check(_GOLDEN)
        check = report.check_by_name("eval_locked")
        assert check is not None
        assert check.passed, check.reason

    def test_golden_telemetry(self) -> None:
        report = _gate().check(_GOLDEN)
        check = report.check_by_name("telemetry")
        assert check is not None
        assert check.passed, check.reason

    def test_golden_all_seven_checks_present(self) -> None:
        report = _gate().check(_GOLDEN)
        names = {c.name for c in report.checks}
        expected = {
            "genome_yaml",
            "model_seams",
            "train_ops",
            "forward_pass",
            "eval_locked",
            "telemetry",
            # R-15: candidate code must anchor imports to __file__, not the cwd.
            # `sys.path.insert(0, os.getcwd())` resolved against whatever
            # directory the launcher was in and raised ModuleNotFoundError at
            # launch — after the merge and after the review.
            "path_anchoring",
        }
        assert names == expected


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate — broken_monolithic: model_seams fails, all others pass
# ─────────────────────────────────────────────────────────────────────────────


@_requires_torch
class TestBrokenMonolithic:
    """Monolithic model — no backbone.py / head.py seam files."""

    _DIR = _FIXTURES / "broken_monolithic"

    def test_overall_fails(self) -> None:
        report = _gate().check(self._DIR)
        assert not report.passed

    def test_model_seams_fails(self) -> None:
        report = _gate().check(self._DIR)
        check = report.check_by_name("model_seams")
        assert check is not None
        assert not check.passed, (
            "model_seams should fail: backbone.py and head.py are absent"
        )
        # Reason must mention the missing files
        assert "backbone.py" in check.reason or "head.py" in check.reason, check.reason

    def test_exactly_one_check_fails(self) -> None:
        report = _gate().check(self._DIR)
        failures = [c for c in report.checks if not c.passed]
        assert len(failures) == 1, (
            f"Expected exactly 1 failure, got {len(failures)}: "
            f"{[c.name for c in failures]}"
        )
        assert failures[0].name == "model_seams"

    def test_other_checks_pass(self) -> None:
        report = _gate().check(self._DIR)
        for check in report.checks:
            if check.name != "model_seams":
                assert check.passed, (
                    f"{check.name} should pass for broken_monolithic but got: {check.reason}"
                )


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate — broken_no_dataloader: train_ops fails, all others pass
# ─────────────────────────────────────────────────────────────────────────────


@_requires_torch
class TestBrokenNoDataloader:
    """train/ contains optimizer + loss but no DataLoader import."""

    _DIR = _FIXTURES / "broken_no_dataloader"

    def test_overall_fails(self) -> None:
        report = _gate().check(self._DIR)
        assert not report.passed

    def test_train_ops_fails(self) -> None:
        report = _gate().check(self._DIR)
        check = report.check_by_name("train_ops")
        assert check is not None
        assert not check.passed, "train_ops should fail: no DataLoader"
        assert "DataLoader" in check.reason, check.reason

    def test_exactly_one_check_fails(self) -> None:
        report = _gate().check(self._DIR)
        failures = [c for c in report.checks if not c.passed]
        assert len(failures) == 1, (
            f"Expected exactly 1 failure, got {len(failures)}: "
            f"{[c.name for c in failures]}"
        )
        assert failures[0].name == "train_ops"

    def test_other_checks_pass(self) -> None:
        report = _gate().check(self._DIR)
        for check in report.checks:
            if check.name != "train_ops":
                assert check.passed, (
                    f"{check.name} should pass for broken_no_dataloader but got: {check.reason}"
                )


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate — broken_forward_crash: forward_pass fails, all others pass
# ─────────────────────────────────────────────────────────────────────────────


class TestBrokenForwardCrash:
    """backbone.forward() raises RuntimeError — subprocess detects the crash."""

    _DIR = _FIXTURES / "broken_forward_crash"

    def test_overall_fails(self) -> None:
        report = _gate().check(self._DIR)
        assert not report.passed

    def test_forward_pass_fails(self) -> None:
        report = _gate().check(self._DIR)
        check = report.check_by_name("forward_pass")
        assert check is not None
        assert not check.passed, "forward_pass should fail: backbone raises RuntimeError"

    def test_exactly_one_check_fails(self) -> None:
        report = _gate().check(self._DIR)
        failures = [c for c in report.checks if not c.passed]
        assert len(failures) == 1, (
            f"Expected exactly 1 failure, got {len(failures)}: "
            f"{[(c.name, c.reason) for c in failures]}"
        )
        assert failures[0].name == "forward_pass"

    def test_other_checks_pass(self) -> None:
        report = _gate().check(self._DIR)
        for check in report.checks:
            if check.name != "forward_pass":
                assert check.passed, (
                    f"{check.name} should pass for broken_forward_crash but got: {check.reason}"
                )


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate — broken_eval_tampered: eval_locked fails, all others pass
# ─────────────────────────────────────────────────────────────────────────────


@_requires_torch
class TestBrokenEvalTampered:
    """evaluate.py content differs from the locked reference hash."""

    _DIR = _FIXTURES / "broken_eval_tampered"

    def test_overall_fails(self) -> None:
        report = _gate().check(self._DIR)
        assert not report.passed

    def test_eval_locked_fails(self) -> None:
        report = _gate().check(self._DIR)
        check = report.check_by_name("eval_locked")
        assert check is not None
        assert not check.passed, "eval_locked should fail: tampered evaluate.py"
        assert "mismatch" in check.reason.lower(), check.reason

    def test_exactly_one_check_fails(self) -> None:
        report = _gate().check(self._DIR)
        failures = [c for c in report.checks if not c.passed]
        assert len(failures) == 1, (
            f"Expected exactly 1 failure, got {len(failures)}: "
            f"{[c.name for c in failures]}"
        )
        assert failures[0].name == "eval_locked"

    def test_other_checks_pass(self) -> None:
        report = _gate().check(self._DIR)
        for check in report.checks:
            if check.name != "eval_locked":
                assert check.passed, (
                    f"{check.name} should pass for broken_eval_tampered but got: {check.reason}"
                )


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate — broken_no_telemetry: telemetry fails, all others pass
# ─────────────────────────────────────────────────────────────────────────────


@_requires_torch
class TestBrokenNoTelemetry:
    """train/ has no TelemetryCallback or evor.telemetry import."""

    _DIR = _FIXTURES / "broken_no_telemetry"

    def test_overall_fails(self) -> None:
        report = _gate().check(self._DIR)
        assert not report.passed

    def test_telemetry_fails(self) -> None:
        report = _gate().check(self._DIR)
        check = report.check_by_name("telemetry")
        assert check is not None
        assert not check.passed, "telemetry should fail: no TelemetryCallback"

    def test_exactly_one_check_fails(self) -> None:
        report = _gate().check(self._DIR)
        failures = [c for c in report.checks if not c.passed]
        assert len(failures) == 1, (
            f"Expected exactly 1 failure, got {len(failures)}: "
            f"{[c.name for c in failures]}"
        )
        assert failures[0].name == "telemetry"

    def test_other_checks_pass(self) -> None:
        report = _gate().check(self._DIR)
        for check in report.checks:
            if check.name != "telemetry":
                assert check.passed, (
                    f"{check.name} should pass for broken_no_telemetry but got: {check.reason}"
                )


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate — edge cases
# ─────────────────────────────────────────────────────────────────────────────


class TestForgeEdgeCases:
    """Gate behaviour on missing or malformed inputs."""

    def test_missing_candidate_dir_fails_all_file_checks(self, tmp_path: Path) -> None:
        report = _gate().check(tmp_path / "nonexistent")
        assert not report.passed
        assert report.check_by_name("genome_yaml") is not None
        assert not report.check_by_name("genome_yaml").passed  # type: ignore[union-attr]

    def test_no_locked_hash_skips_eval_locked(self, tmp_path: Path) -> None:
        """eval_locked passes (skip) when locked_eval_hash is None."""
        # Copy golden so other checks pass; pass no hash
        import shutil
        dest = tmp_path / "candidate"
        shutil.copytree(_GOLDEN, dest)
        gate = ForgeStructureGate(locked_eval_hash=None)
        report = gate.check(dest)
        check = report.check_by_name("eval_locked")
        assert check is not None
        assert check.passed, "eval_locked should pass (skipped) when no hash provided"
        assert "skipped" in check.reason.lower()

    def test_report_passed_property_false_if_any_check_fails(self, tmp_path: Path) -> None:
        report = ForgeStructureGate().check(tmp_path / "empty")
        assert not report.passed
        assert len(report.failure_reasons) > 0

    def test_quality_report_check_by_name_returns_none_for_unknown(self, tmp_path: Path) -> None:
        report = _gate().check(_GOLDEN)
        assert report.check_by_name("nonexistent_check") is None


# ─────────────────────────────────────────────────────────────────────────────
# ProbeEDAGate — golden EDA directory (all checks pass)
# ─────────────────────────────────────────────────────────────────────────────


class TestProbeEDAGolden:
    """Golden EDA directory passes all 5 sub-checks."""

    def _make_golden_eda(self, tmp_path: Path) -> Path:
        """Create a minimal but complete EDA directory."""
        eda_dir = tmp_path / "nodes" / "test-node-001" / "eda"
        eda_dir.mkdir(parents=True)

        (eda_dir / "analysis_loss_curve.py").write_text(
            """\
import argparse
from evor.eda import load_telemetry, save_finding


def main(node_id: str, run_dir: str) -> None:
    from pathlib import Path
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    records = load_telemetry(node_id, Path(run_dir))
    finding = {"steps": len(records), "trend": "decreasing"}
    save_finding(node_id, Path(run_dir), "loss_summary", finding)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--run-dir", required=True)
    args = parser.parse_args()
    main(args.node_id, args.run_dir)
"""
        )
        # Finding artifact
        (eda_dir / "loss_summary.json").write_text(
            json.dumps({"steps": 10, "trend": "decreasing"})
        )
        return eda_dir

    def test_golden_eda_passes(self, tmp_path: Path) -> None:
        eda_dir = self._make_golden_eda(tmp_path)
        report = ProbeEDAGate(node_id="test-node-001").check(eda_dir)
        assert report.passed, f"Golden EDA failed: {report.failure_reasons}"

    def test_golden_analysis_script_exists(self, tmp_path: Path) -> None:
        eda_dir = self._make_golden_eda(tmp_path)
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("analysis_script_exists")
        assert check is not None and check.passed, check

    def test_golden_evor_eda_import(self, tmp_path: Path) -> None:
        eda_dir = self._make_golden_eda(tmp_path)
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("evor_eda_import")
        assert check is not None and check.passed, check

    def test_golden_runtime_ref(self, tmp_path: Path) -> None:
        eda_dir = self._make_golden_eda(tmp_path)
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("runtime_telemetry_ref")
        assert check is not None and check.passed, check

    def test_golden_resource_guard(self, tmp_path: Path) -> None:
        eda_dir = self._make_golden_eda(tmp_path)
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("resource_guard")
        assert check is not None and check.passed, check

    def test_golden_finding_artifact(self, tmp_path: Path) -> None:
        eda_dir = self._make_golden_eda(tmp_path)
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("finding_artifact")
        assert check is not None and check.passed, check


# ─────────────────────────────────────────────────────────────────────────────
# ProbeEDAGate — broken EDA scenarios
# ─────────────────────────────────────────────────────────────────────────────


class TestProbeEDABroken:
    """Each broken EDA case fails exactly one sub-check."""

    def test_missing_analysis_script(self, tmp_path: Path) -> None:
        eda_dir = tmp_path / "eda"
        eda_dir.mkdir()
        (eda_dir / "findings.json").write_text("{}")
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("analysis_script_exists")
        assert check is not None
        assert not check.passed

    def test_no_evor_eda_import(self, tmp_path: Path) -> None:
        eda_dir = tmp_path / "eda"
        eda_dir.mkdir()
        (eda_dir / "analysis_plain.py").write_text(
            """\
import argparse
import resource
resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024, 512*1024*1024))
# deliberately omits the evor eda module import
"""
        )
        (eda_dir / "finding.json").write_text("{}")
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("evor_eda_import")
        assert check is not None
        assert not check.passed

    def test_hardcoded_domain(self, tmp_path: Path) -> None:
        """Script with no argparse / env / function params → runtime_telemetry_ref fails."""
        eda_dir = tmp_path / "eda"
        eda_dir.mkdir()
        (eda_dir / "analysis_hardcoded.py").write_text(
            """\
from evor.eda import load_telemetry, save_finding
from pathlib import Path
import resource
resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024, 512*1024*1024))
# all values hardcoded — not runtime-parameterised
records = load_telemetry("hardcoded-node-id", Path("/hardcoded/run/dir"))
save_finding("hardcoded-node-id", Path("/hardcoded/run/dir"), "finding", {"x": 1})
"""
        )
        (eda_dir / "finding.json").write_text("{}")
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("runtime_telemetry_ref")
        assert check is not None
        assert not check.passed

    def test_no_resource_guard(self, tmp_path: Path) -> None:
        eda_dir = tmp_path / "eda"
        eda_dir.mkdir()
        (eda_dir / "analysis_unguarded.py").write_text(
            """\
import argparse
from evor.eda import load_telemetry, save_finding
from pathlib import Path

def main(node_id: str, run_dir: str) -> None:
    records = load_telemetry(node_id, Path(run_dir))
    save_finding(node_id, Path(run_dir), "result", {"steps": len(records)})

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--run-dir", required=True)
    args = parser.parse_args()
    main(args.node_id, args.run_dir)
# no memory limit or subprocess execution guard present
"""
        )
        (eda_dir / "finding.json").write_text("{}")
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("resource_guard")
        assert check is not None
        assert not check.passed

    def test_no_finding_artifact(self, tmp_path: Path) -> None:
        eda_dir = tmp_path / "eda"
        eda_dir.mkdir()
        (eda_dir / "analysis_no_output.py").write_text(
            """\
import argparse
import resource
from evor.eda import load_telemetry
from pathlib import Path
resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024, 512*1024*1024))

def main(node_id: str, run_dir: str) -> None:
    records = load_telemetry(node_id, Path(run_dir))
    # BUG: never calls save_finding() — no artifact written

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--run-dir", required=True)
    args = parser.parse_args()
    main(args.node_id, args.run_dir)
"""
        )
        # Only .py files — no finding artifacts
        report = ProbeEDAGate().check(eda_dir)
        check = report.check_by_name("finding_artifact")
        assert check is not None
        assert not check.passed

    def test_missing_eda_dir(self, tmp_path: Path) -> None:
        report = ProbeEDAGate().check(tmp_path / "nonexistent" / "eda")
        assert not report.passed
        check = report.check_by_name("analysis_script_exists")
        assert check is not None and not check.passed


# ─────────────────────────────────────────────────────────────────────────────
# Integration with IntegrityGate (structure_ok wired in)
# ─────────────────────────────────────────────────────────────────────────────


@_requires_torch
class TestIntegrityGateStructureOk:
    """Verify ForgeStructureGate is invoked from IntegrityGate when candidate_dir is passed."""

    def _make_integrity_inputs(self, tmp_path: Path):
        """Build minimal inputs for IntegrityGate.check() — mirrors test_tick_loop.py helpers."""
        import hashlib as _hl

        from evor.contracts import (
            EvaluationResult,
            FrozenSplit,
            GenomeConfig,
            GoalContract,
            TelemetrySummary,
            TreeNode,
        )
        from evor.freeze import _compute_split_hash

        # Frozen split
        per_sample = {"0": _hl.sha256(b"a").hexdigest(), "1": _hl.sha256(b"b").hexdigest()}
        split_hash = _compute_split_hash(per_sample)
        frozen_split = FrozenSplit(
            split_id="test-split",
            mission_id="test-mission",
            split_type="test",
            split_hash=split_hash,
            per_sample_hashes=per_sample,
            item_count=2,
            frozen_at="2026-07-04T00:00:00Z",
            storage_path=str(tmp_path / "test-split.json"),
            eval_version="v1",
        )

        # Eval script — use golden's evaluate.py
        eval_script = tmp_path / "evaluate.py"
        eval_script.write_bytes((_GOLDEN / "evaluate.py").read_bytes())
        eval_hash = _hl.sha256(eval_script.read_bytes()).hexdigest()

        goal = GoalContract(
            mission_id="test-mission",
            mode="from-scratch",
            mission_type="fixed",
            task_description="test",
            dataset_ref="/data/test",
            metric_specs=[{
                "metric_name": "accuracy",
                "direction": "higher",
                "domain_applicability": "all",
                "aggregation_rule": "macro_avg",
                "role": "primary_fitness",
                "sota_bar": None,
            }],
            fitness_mode="aggregate",
            eval_version="v1",
            baseline_value=0.70,
            target_value=0.90,
            stop_condition={"type": "target"},
            wildness=0.5,
            budget={"max_iterations": 10, "plateau_window": 5, "circuit_breaker": 3, "max_cost_usd": 0.0},
            locked_split_hash=split_hash,
            eval_script_hash=eval_hash,
            allowed_licenses=["MIT"],
            created_at="2026-07-04T00:00:00Z",
        )

        node = TreeNode(
            id="test-node-001",
            parent_ids=[],
            approach_family="arch",
            hypothesis_id="hyp-001",
            code_ref="nodes/test-node-001/code/",
            genome_ref="abc123",
            data_version_ref="data-v1",
            config={},
            metrics={},
            eval_version="v1",
            lesson_ids=[],
            citations=[],
            integrity_status="pending",
            status="pending",
            is_crossover=False,
            visit_count=0,
            depth=0,
            created_at="2026-07-04T00:00:00Z",
        )

        result = EvaluationResult(
            node_id="test-node-001",
            run_id="run-001",
            eval_version="v1",
            metrics={"accuracy": 0.80},
            per_domain={"default": {"accuracy": 0.80}},
            fitness_value=0.80,
            telemetry_summary=TelemetrySummary(total_steps=5),
            status="success",
            benchmark_raw="",
            timestamp="2026-07-04T02:00:00Z",
        )

        # Write valid telemetry
        tel_path = tmp_path / "telemetry.jsonl"
        records = [
            {"step": i, "train_loss": 1.0 - i * 0.1, "grad_norm": 1.0 + i * 0.1,
             "node_id": "test-node-001", "run_id": "run-001",
             "timestamp": "2026-07-04T01:00:00Z", "lr": 0.001}
            for i in range(5)
        ]
        tel_path.write_text("\n".join(json.dumps(r) for r in records) + "\n")

        return goal, node, result, frozen_split, eval_script, tel_path

    def test_structure_ok_none_when_candidate_dir_not_provided(self, tmp_path: Path) -> None:
        """structure_ok is None when candidate_dir not passed — no gate regression."""
        from evor.integrity import IntegrityGate

        goal, node, result, frozen_split, eval_script, tel_path = self._make_integrity_inputs(tmp_path)
        gate = IntegrityGate()
        report = gate.check(
            node=node,
            result=result,
            goal=goal,
            telemetry_path=tel_path,
            eval_script_path=eval_script,
            frozen_test=frozen_split,
            provenance_path=None,
            # candidate_dir NOT provided
        )
        assert report.checks.structure_ok is None
        assert report.verdict == "passed"

    def test_structure_ok_true_for_golden_candidate(self, tmp_path: Path) -> None:
        """structure_ok=True when golden candidate_dir passed."""
        from evor.integrity import IntegrityGate

        goal, node, result, frozen_split, eval_script, tel_path = self._make_integrity_inputs(tmp_path)
        gate = IntegrityGate()
        report = gate.check(
            node=node,
            result=result,
            goal=goal,
            telemetry_path=tel_path,
            eval_script_path=eval_script,
            frozen_test=frozen_split,
            provenance_path=None,
            candidate_dir=_GOLDEN,
        )
        assert report.checks.structure_ok is True, (
            f"Expected structure_ok=True for golden fixture; "
            f"failure_reason: {report.failure_reason}"
        )
        assert report.verdict == "passed"

    def test_structure_ok_false_rejects_broken_candidate(self, tmp_path: Path) -> None:
        """structure_ok=False (broken_monolithic) flips verdict to failed."""
        from evor.integrity import IntegrityGate

        goal, node, result, frozen_split, eval_script, tel_path = self._make_integrity_inputs(tmp_path)
        gate = IntegrityGate()
        report = gate.check(
            node=node,
            result=result,
            goal=goal,
            telemetry_path=tel_path,
            eval_script_path=eval_script,
            frozen_test=frozen_split,
            provenance_path=None,
            candidate_dir=_FIXTURES / "broken_monolithic",
        )
        assert report.checks.structure_ok is False
        assert report.verdict == "failed"
        assert "structure_ok" in (report.failure_reason or "")


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate — golden_embedding: non-CNN fixture, all checks pass
# ─────────────────────────────────────────────────────────────────────────────


@_requires_torch
class TestGoldenEmbeddingFixturePasses:
    """Golden embedding candidate (model_family: embedding) must pass every sub-check.

    Proves ForgeStructureGate is architecture-agnostic:
      - model_seams validates encoder.py + pooling.py (not backbone.py / head.py)
      - forward_pass succeeds with text token-ID input (LongTensor)
      - train_ops detects CosineEmbeddingLoss + DataLoader + AdamW
      - evaluate.py hash identical to golden CNN evaluate.py
    """

    _DIR = _FIXTURES / "golden_embedding"

    def test_embedding_overall_pass(self) -> None:
        report = _gate().check(self._DIR)
        assert report.passed, (
            f"golden_embedding should pass all checks but failed: {report.failure_reasons}"
        )

    def test_embedding_genome_yaml(self) -> None:
        report = _gate().check(self._DIR)
        check = report.check_by_name("genome_yaml")
        assert check is not None
        assert check.passed, check.reason

    def test_embedding_model_seams(self) -> None:
        """model_seams must pass: encoder.py + pooling.py present for embedding family."""
        report = _gate().check(self._DIR)
        check = report.check_by_name("model_seams")
        assert check is not None
        assert check.passed, check.reason
        # Reason should mention the embedding family seams, NOT backbone/head
        assert "backbone" not in check.reason.lower(), (
            f"model_seams should NOT mention backbone for embedding family: {check.reason}"
        )

    def test_embedding_train_ops(self) -> None:
        report = _gate().check(self._DIR)
        check = report.check_by_name("train_ops")
        assert check is not None
        assert check.passed, check.reason

    def test_embedding_forward_pass(self) -> None:
        """Forward pass with text token-ID input must succeed."""
        report = _gate().check(self._DIR)
        check = report.check_by_name("forward_pass")
        assert check is not None
        assert check.passed, (
            f"forward_pass should succeed for embedding model but failed: {check.reason}"
        )

    def test_embedding_eval_locked(self) -> None:
        report = _gate().check(self._DIR)
        check = report.check_by_name("eval_locked")
        assert check is not None
        assert check.passed, check.reason

    def test_embedding_telemetry(self) -> None:
        report = _gate().check(self._DIR)
        check = report.check_by_name("telemetry")
        assert check is not None
        assert check.passed, check.reason

    def test_embedding_all_seven_checks_present(self) -> None:
        report = _gate().check(self._DIR)
        names = {c.name for c in report.checks}
        expected = {
            "genome_yaml",
            "model_seams",
            "train_ops",
            "forward_pass",
            "eval_locked",
            "telemetry",
            # R-15: candidate code must anchor imports to __file__, not the cwd.
            # `sys.path.insert(0, os.getcwd())` resolved against whatever
            # directory the launcher was in and raised ModuleNotFoundError at
            # launch — after the merge and after the review.
            "path_anchoring",
        }
        assert names == expected
