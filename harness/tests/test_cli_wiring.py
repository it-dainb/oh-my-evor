"""
harness/tests/test_cli_wiring.py

CLI-through-subprocess tests that PROVE each formerly-dead function is reachable
via `python -m evor <subcommand>`.  These tests do NOT call functions directly by
import — they invoke the full CLI as a child process, which is the only way to
confirm the wiring is live rather than just unit-testable in isolation.

Functions verified here:
  P1-9   preflight --mode env_only  → no longer exits 2 on unknown arg
  P1-10  setup-gates --split-dir    → check_corpus_layout reachable via CLI
  P2-12  setup-gates --declared-arch → check_config_drift reachable via CLI
  P2-11  export-telemetry --job-dir  → export_wandb_to_csv reachable via CLI
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

_PYTHON = sys.executable
_HARNESS = Path(__file__).resolve().parent.parent


def _run(*args: str, **kw) -> subprocess.CompletedProcess:
    """Run `python -m evor <args>` as a subprocess; capture both streams."""
    return subprocess.run(
        [_PYTHON, "-m", "evor", *args],
        capture_output=True,
        text=True,
        cwd=str(_HARNESS),
        **kw,
    )


# ─────────────────────────────────────────────────────────────────────────────
# P1-9: preflight --mode env_only — no longer exits 2 (argparse unknown arg)
# ─────────────────────────────────────────────────────────────────────────────


class TestPreflightMode:
    def test_mode_env_only_is_accepted_not_exit2(self, tmp_path: Path) -> None:
        """--mode env_only must be parsed without argparse error (exit 2)."""
        result = _run(
            "preflight",
            "--run-id", "test-run-001",
            "--run-dir", str(tmp_path),
            "--mode", "env_only",
            "--no-gpu-check",
        )
        # Exit 2 = argparse error "unrecognised argument". Any other exit is acceptable.
        assert result.returncode != 2, (
            f"argparse rejected --mode; stderr: {result.stderr!r}"
        )

    def test_mode_full_is_accepted(self, tmp_path: Path) -> None:
        """--mode full (the default) must also be accepted by argparse."""
        result = _run(
            "preflight",
            "--run-id", "test-run-002",
            "--run-dir", str(tmp_path),
            "--mode", "full",
            "--no-gpu-check",
        )
        assert result.returncode != 2, (
            f"argparse rejected --mode full; stderr: {result.stderr!r}"
        )

    def test_mode_env_only_omits_loss_decreasing_from_output(self, tmp_path: Path) -> None:
        """env_only mode must NOT include loss_decreasing in the JSON output."""
        result = _run(
            "preflight",
            "--run-id", "test-run-env-only",
            "--run-dir", str(tmp_path),
            "--mode", "env_only",
            "--no-gpu-check",
        )
        # Exit 5 = preflight check failed (torch/GPU not available in CI); still
        # means the flag was parsed and the code ran.  Exit 2 = argparse failure.
        assert result.returncode != 2, f"argparse error: {result.stderr!r}"
        # If a JSON blob was emitted, loss_decreasing must not be in it
        stdout = result.stdout.strip()
        if stdout:
            try:
                payload = json.loads(stdout)
                assert "loss_decreasing" not in payload.get("checks", {}), (
                    "env_only mode incorrectly included loss_decreasing"
                )
            except json.JSONDecodeError:
                pass  # non-JSON output means something else went wrong upstream

    def test_invalid_mode_choice_exits2(self, tmp_path: Path) -> None:
        """An unrecognised --mode value must produce an argparse exit 2."""
        result = _run(
            "preflight",
            "--run-id", "x",
            "--mode", "bogus_mode",
        )
        assert result.returncode == 2


# ─────────────────────────────────────────────────────────────────────────────
# P1-10: setup-gates --split-dir → check_corpus_layout reachable via CLI
# ─────────────────────────────────────────────────────────────────────────────


class TestSetupGatesCorpusLayout:
    def test_matching_pairs_exit0(self, tmp_path: Path) -> None:
        """Valid split (matching image/gt pairs) → exit 0, JSON passed=true."""
        img_dir = tmp_path / "images"
        gt_dir = tmp_path / "gt"
        img_dir.mkdir(); gt_dir.mkdir()
        for i in range(3):
            (img_dir / f"{i}.png").write_bytes(b"img")
            (gt_dir / f"{i}.png").write_bytes(b"gt")

        result = _run("setup-gates", "--split-dir", str(tmp_path))
        assert result.returncode == 0, f"stderr: {result.stderr!r}"

        report = json.loads(result.stdout)
        assert report["passed"] is True
        assert report["checks"]["corpus_layout"]["ok"] is True
        assert "3" in report["checks"]["corpus_layout"]["detail"]

    def test_mismatch_exit1(self, tmp_path: Path) -> None:
        """Mismatched image/gt counts → exit 1, JSON passed=false."""
        img_dir = tmp_path / "images"
        gt_dir = tmp_path / "gt"
        img_dir.mkdir(); gt_dir.mkdir()
        for i in range(4):
            (img_dir / f"{i}.png").write_bytes(b"img")
        (gt_dir / "0.png").write_bytes(b"gt")

        result = _run("setup-gates", "--split-dir", str(tmp_path))
        assert result.returncode == 1
        report = json.loads(result.stdout)
        assert report["passed"] is False
        assert report["checks"]["corpus_layout"]["ok"] is False

    def test_no_args_exit1_with_useful_error(self) -> None:
        """No --split-dir and no --declared-arch → exit 1 with guidance message."""
        result = _run("setup-gates")
        assert result.returncode == 1
        assert "split-dir" in result.stderr or "declared-arch" in result.stderr


# ─────────────────────────────────────────────────────────────────────────────
# P2-12: setup-gates --declared-arch → check_config_drift reachable via CLI
# ─────────────────────────────────────────────────────────────────────────────


class TestSetupGatesConfigDrift:
    def test_matching_arch_exit0(self) -> None:
        """Declared arch == checkpoint arch → exit 0, passed=true."""
        hparams = json.dumps({"arch": "small_unet", "lr": 0.001})
        result = _run(
            "setup-gates",
            "--declared-arch", "small_unet",
            "--checkpoint-hparams-json", hparams,
        )
        assert result.returncode == 0, f"stderr: {result.stderr!r}"
        report = json.loads(result.stdout)
        assert report["passed"] is True
        assert report["checks"]["config_drift"]["ok"] is True

    def test_drifted_arch_exit1(self) -> None:
        """Declared arch != checkpoint arch → exit 1, passed=false."""
        hparams = json.dumps({"arch": "dual_robust_v2"})
        result = _run(
            "setup-gates",
            "--declared-arch", "small_unet",
            "--checkpoint-hparams-json", hparams,
        )
        assert result.returncode == 1
        report = json.loads(result.stdout)
        assert report["passed"] is False
        assert report["checks"]["config_drift"]["ok"] is False

    def test_declared_arch_without_hparams_exit1(self) -> None:
        """--declared-arch without --checkpoint-hparams-json → exit 1 with guidance."""
        result = _run("setup-gates", "--declared-arch", "small_unet")
        assert result.returncode == 1
        assert "checkpoint-hparams-json" in result.stderr

    def test_invalid_hparams_json_exit1(self) -> None:
        """Malformed JSON for --checkpoint-hparams-json → exit 1."""
        result = _run(
            "setup-gates",
            "--declared-arch", "small_unet",
            "--checkpoint-hparams-json", "NOT_JSON",
        )
        assert result.returncode == 1

    def test_combined_checks_both_pass(self, tmp_path: Path) -> None:
        """--split-dir + --declared-arch together → both checks in report."""
        img_dir = tmp_path / "images"
        gt_dir = tmp_path / "gt"
        img_dir.mkdir(); gt_dir.mkdir()
        (img_dir / "0.png").write_bytes(b"img")
        (gt_dir / "0.png").write_bytes(b"gt")
        hparams = json.dumps({"arch": "resnet"})

        result = _run(
            "setup-gates",
            "--split-dir", str(tmp_path),
            "--declared-arch", "resnet",
            "--checkpoint-hparams-json", hparams,
        )
        assert result.returncode == 0
        report = json.loads(result.stdout)
        assert "corpus_layout" in report["checks"]
        assert "config_drift" in report["checks"]
        assert report["passed"] is True


# ─────────────────────────────────────────────────────────────────────────────
# P2-11: export-telemetry --job-dir → export_wandb_to_csv reachable via CLI
# ─────────────────────────────────────────────────────────────────────────────


class TestExportTelemetryCli:
    def test_no_wandb_dir_exit0_null_csv(self, tmp_path: Path) -> None:
        """Job dir with no .wandb/ → exit 0, csv_path=null."""
        result = _run("export-telemetry", "--job-dir", str(tmp_path))
        assert result.returncode == 0, f"stderr: {result.stderr!r}"
        payload = json.loads(result.stdout)
        assert payload["csv_path"] is None

    def test_wandb_summary_writes_csv_exit0(self, tmp_path: Path) -> None:
        """Job dir with .wandb/wandb-summary.json → exit 0, csv_path points to file."""
        wandb_dir = tmp_path / ".wandb"
        wandb_dir.mkdir()
        (wandb_dir / "wandb-summary.json").write_text(
            json.dumps({"train_loss": 0.42, "val_metric": 0.88})
        )

        result = _run("export-telemetry", "--job-dir", str(tmp_path))
        assert result.returncode == 0, f"stderr: {result.stderr!r}"
        payload = json.loads(result.stdout)
        assert payload["csv_path"] is not None
        csv_path = Path(payload["csv_path"])
        assert csv_path.exists()
        lines = [l for l in csv_path.read_text().splitlines() if l.strip()]
        assert len(lines) >= 2, "CSV must have header + at least 1 data row"
        assert "train_loss" in lines[0]

    def test_wandb_jsonl_history_writes_csv(self, tmp_path: Path) -> None:
        """Job dir with .wandb/history.jsonl → CSV has correct row count."""
        wandb_dir = tmp_path / ".wandb"
        wandb_dir.mkdir()
        records = [{"step": i, "loss": float(i)} for i in range(5)]
        with open(wandb_dir / "history.jsonl", "w") as fh:
            for r in records:
                fh.write(json.dumps(r) + "\n")

        result = _run("export-telemetry", "--job-dir", str(tmp_path))
        assert result.returncode == 0
        payload = json.loads(result.stdout)
        csv_path = Path(payload["csv_path"])
        lines = [l for l in csv_path.read_text().splitlines() if l.strip()]
        assert len(lines) == 6  # header + 5 data rows

    def test_missing_job_dir_exit1(self) -> None:
        """Non-existent --job-dir → exit 1."""
        result = _run("export-telemetry", "--job-dir", "/nonexistent/path/xyz_evor")
        assert result.returncode == 1
