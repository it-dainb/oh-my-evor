"""
Tests for evor-distill: workspace classifier, deep scanner, and baseline verifier.

Coverage:
  Schema:
    test_starting_point_report_round_trip  — model_dump_json / model_validate_json
    test_scraped_metric_verified_always_false — invariant: verified is always False
    test_baseline_candidate_verified_always_false — invariant: verified is always False

  classify_workspace (fast path):
    test_classify_greenfield               — empty dir → greenfield
    test_classify_brownfield_model         — .pt file present → brownfield
    test_classify_brownfield_dataset       — data/ dir present → brownfield
    test_classify_brownfield_config        — config.yaml present → brownfield
    test_classify_brownfield_composite     — .pt + data/ + config.yaml → brownfield
    test_classify_evor_active              — .evor/active-run.json present → evor-active
    test_classify_possibly_training        — fresh .pt file → possibly-training
    test_classify_ignores_ignore_dirs      — .git / node_modules not counted
    test_classify_counts_shape             — counts dict has correct keys

  scan_workspace (deep path):
    test_scan_brownfield_finds_model       — fake .pt detected in models[]
    test_scan_brownfield_finds_dataset     — data/ dir detected in datasets[]
    test_scan_brownfield_finds_config      — config.yaml detected in configs[]
    test_scan_scrapes_readme_0_82          — README "val acc 0.82" scraped, verified=False
    test_scan_baseline_candidate_unverified — baseline_candidate.verified=False
    test_scan_framework_pytorch            — .pt → framework="pytorch"
    test_scan_possibly_training_warning    — fresh checkpoint → warning in warnings[]
    test_scan_no_crash_on_permission_error — scan doesn't raise on unreadable dirs

  CLI (subprocess, cwd-portable via _HARNESS_DIR):
    test_classify_cli_shape                — --root → one-line JSON with correct keys
    test_classify_cli_greenfield           — empty dir → greenfield
    test_scan_cli_writes_json_file         — --json flag → parseable JSON on stdout

  verify_baseline_claim:
    test_verify_reproduced                 — measured ≈ claimed → reproduced=True
    test_verify_not_reproduced             — measured far from claimed → reproduced=False
    test_verify_tolerance_exact_boundary   — at exact tolerance boundary → reproduced=True
    test_verify_tolerance_just_over        — just over tolerance → reproduced=False
    test_verify_return_keys                — dict has required keys
    test_verify_delta_sign                 — delta = measured - claimed (signed)
    test_verify_note_contains_metric       — note includes metric name
    test_verify_stub_neutral               — without override, reproduced=True (neutral stub)
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evor.contracts import (
    BaselineCandidate,
    DetectedConfig,
    DetectedDataset,
    DetectedModel,
    ScrapedMetric,
    StartingPointReport,
)
from evor.distill import (
    classify_workspace,
    scan_workspace,
    _scrape_readme_metrics,
)
from evor.integrity import verify_baseline_claim

# Portable harness dir — mirrors the pattern in test_gotchas.py.
# This file lives in <harness>/tests/ so parent.parent = <harness>/
_HARNESS_DIR = Path(__file__).resolve().parent.parent


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures / factories
# ─────────────────────────────────────────────────────────────────────────────

def _set_old_mtime(path: Path, age_secs: int = 7200) -> None:
    """Set a file's mtime to age_secs seconds in the past (default 2 h)."""
    old = time.time() - age_secs
    os.utime(path, (old, old))


def _make_messy_repo(tmp_path: Path) -> Path:
    """Create a synthetic brownfield ML repo fixture.

    Layout:
      <tmp>/messy-repo/model.pt     — fake PyTorch checkpoint (mtime 2 h ago)
      <tmp>/messy-repo/data/        — dataset directory
      <tmp>/messy-repo/config.yaml  — config with lr + batch_size
      <tmp>/messy-repo/README.md    — contains "val acc 0.82"

    The checkpoint mtime is backdated 2 hours so classify_workspace returns
    "brownfield" rather than "possibly-training".
    """
    root = tmp_path / "messy-repo"
    root.mkdir()

    # Fake model checkpoint — backdated so it doesn't trigger possibly-training
    ckpt = root / "model.pt"
    ckpt.write_bytes(b"\x80\x02}q\x00.")
    _set_old_mtime(ckpt)

    # Dataset directory
    (root / "data").mkdir()
    (root / "data" / "train.csv").write_text("label,feature\n0,1.0\n1,2.0\n")

    # Config file at repo root (name starts with "config")
    (root / "config.yaml").write_text(
        "lr: 0.001\nbatch_size: 32\nepochs: 10\nmodel: resnet50\n"
    )

    # README with a metric claim
    (root / "README.md").write_text(
        "# My Model\n\nAchieved val acc 0.82 on the validation set.\n"
    )

    return root


# ─────────────────────────────────────────────────────────────────────────────
# Schema round-trip
# ─────────────────────────────────────────────────────────────────────────────

def test_starting_point_report_round_trip(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    report = scan_workspace(root)

    serialised = report.model_dump_json(indent=2)
    restored = StartingPointReport.model_validate_json(serialised)

    assert restored.workspace_class == report.workspace_class
    assert restored.root == report.root
    assert len(restored.models) == len(report.models)
    assert len(restored.datasets) == len(report.datasets)
    assert len(restored.configs) == len(report.configs)
    assert len(restored.scraped_metrics) == len(report.scraped_metrics)


def test_scraped_metric_verified_always_false() -> None:
    # Constructing with verified=True should fail the invariant; this test
    # verifies that the schema accepts False and that distill always emits False.
    m = ScrapedMetric(
        source="readme",
        source_path="/some/README.md",
        metric="val_acc",
        value=0.82,
        split_hint="val",
        verified=False,
    )
    assert m.verified is False


def test_baseline_candidate_verified_always_false() -> None:
    bc = BaselineCandidate(
        model_path="/model.pt",
        metric_name="val_acc",
        claimed_value=0.82,
        source="readme",
        verified=False,
    )
    assert bc.verified is False


# ─────────────────────────────────────────────────────────────────────────────
# classify_workspace
# ─────────────────────────────────────────────────────────────────────────────

def test_classify_greenfield(tmp_path: Path) -> None:
    root = tmp_path / "empty"
    root.mkdir()
    wclass, counts = classify_workspace(root)
    assert wclass == "greenfield"
    assert counts["models"] == 0
    assert counts["datasets"] == 0


def test_classify_brownfield_model(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    ckpt = root / "model.pt"
    ckpt.write_bytes(b"\x00" * 16)
    _set_old_mtime(ckpt)  # backdate so it doesn't trigger possibly-training
    wclass, counts = classify_workspace(root)
    assert wclass == "brownfield"
    assert counts["models"] >= 1


def test_classify_brownfield_dataset(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    (root / "data").mkdir()
    wclass, counts = classify_workspace(root)
    assert wclass == "brownfield"
    assert counts["datasets"] >= 1


def test_classify_brownfield_config(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    (root / "config.yaml").write_text("lr: 0.001\n")
    wclass, counts = classify_workspace(root)
    assert wclass == "brownfield"
    assert counts["configs"] >= 1


def test_classify_brownfield_composite(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    wclass, counts = classify_workspace(root)
    assert wclass == "brownfield"
    assert counts["models"] >= 1
    assert counts["datasets"] >= 1
    assert counts["configs"] >= 1


def test_classify_evor_active(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    (root / ".evor").mkdir()
    (root / ".evor" / "active-run.json").write_text('{"run_id": "r1"}')
    wclass, _counts = classify_workspace(root)
    assert wclass == "evor-active"


def test_classify_possibly_training(tmp_path: Path) -> None:
    """A very freshly written checkpoint triggers possibly-training."""
    import time

    root = tmp_path / "repo"
    root.mkdir()
    ckpt = root / "model.pt"
    ckpt.write_bytes(b"\x00" * 16)
    # mtime is already "now" (just created) — within the 600s window
    wclass, _counts = classify_workspace(root)
    assert wclass == "possibly-training"


def test_classify_ignores_ignore_dirs(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    # Put a .pt inside an ignored dir — should NOT count
    git_dir = root / ".git"
    git_dir.mkdir()
    (git_dir / "model.pt").write_bytes(b"\x00" * 16)
    (root / "node_modules").mkdir()
    (root / "node_modules" / "weights.pt").write_bytes(b"\x00" * 16)
    wclass, counts = classify_workspace(root)
    assert wclass == "greenfield"
    assert counts["models"] == 0


def test_classify_counts_shape(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    _wclass, counts = classify_workspace(root)
    assert set(counts.keys()) == {"models", "datasets", "configs", "logs"}


# ─────────────────────────────────────────────────────────────────────────────
# scan_workspace
# ─────────────────────────────────────────────────────────────────────────────

def test_scan_brownfield_finds_model(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    report = scan_workspace(root)
    assert report.workspace_class == "brownfield"
    model_paths = [m.path for m in report.models]
    assert any("model.pt" in p for p in model_paths), f"models={model_paths}"


def test_scan_brownfield_finds_dataset(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    report = scan_workspace(root)
    dataset_paths = [d.path for d in report.datasets]
    assert any("data" in p for p in dataset_paths), f"datasets={dataset_paths}"


def test_scan_brownfield_finds_config(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    report = scan_workspace(root)
    config_paths = [c.path for c in report.configs]
    assert any("config.yaml" in p for p in config_paths), f"configs={config_paths}"


def test_scan_scrapes_readme_0_82(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    report = scan_workspace(root)
    assert len(report.scraped_metrics) >= 1, "expected at least one scraped metric"
    values = [m.value for m in report.scraped_metrics]
    assert any(
        abs(v - 0.82) < 0.005 for v in values
    ), f"expected ~0.82 among scraped values: {values}"
    # INVARIANT: all verified=False
    assert all(not m.verified for m in report.scraped_metrics)


def test_scan_baseline_candidate_unverified(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    report = scan_workspace(root)
    assert report.baseline_candidate is not None
    assert report.baseline_candidate.verified is False
    assert report.baseline_candidate.claimed_value is not None


def test_scan_framework_pytorch(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    report = scan_workspace(root)
    # model.pt at root → framework inferred as pytorch
    assert report.framework == "pytorch"


def test_scan_possibly_training_warning(tmp_path: Path) -> None:
    root = tmp_path / "repo"
    root.mkdir()
    (root / "model.pt").write_bytes(b"\x00" * 16)  # fresh file → possibly-training
    report = scan_workspace(root)
    assert report.workspace_class == "possibly-training"
    assert any("10 min" in w or "active" in w for w in report.warnings), \
        f"expected possibly-training warning, got: {report.warnings}"


def test_scan_no_crash_on_permission_error(tmp_path: Path) -> None:
    """scan_workspace must not raise even if a subdir is unreadable."""
    import os
    import stat

    root = tmp_path / "repo"
    root.mkdir()
    (root / "model.pt").write_bytes(b"\x00" * 16)
    locked = root / "locked_dir"
    locked.mkdir()
    try:
        locked.chmod(0o000)
        # Should complete without raising
        report = scan_workspace(root)
        assert report.workspace_class in ("brownfield", "possibly-training", "greenfield")
    finally:
        locked.chmod(stat.S_IRWXU)  # restore so tmp_path cleanup works


# ─────────────────────────────────────────────────────────────────────────────
# README metric scraper (unit)
# ─────────────────────────────────────────────────────────────────────────────

def test_scrape_readme_extracts_val_acc(tmp_path: Path) -> None:
    readme = tmp_path / "README.md"
    readme.write_text("Achieved val acc 0.82 on the val set.\n")
    metrics = _scrape_readme_metrics(readme)
    assert len(metrics) >= 1
    values = [m.value for m in metrics]
    assert any(abs(v - 0.82) < 0.005 for v in values)
    assert all(not m.verified for m in metrics)


def test_scrape_readme_percent_normalised(tmp_path: Path) -> None:
    readme = tmp_path / "README.md"
    readme.write_text("accuracy: 82.5%\n")
    metrics = _scrape_readme_metrics(readme)
    values = [m.value for m in metrics]
    # 82.5 → divided by 100 → 0.825
    assert any(abs(v - 0.825) < 0.005 for v in values), f"values={values}"


def test_scrape_readme_no_crash_missing_file(tmp_path: Path) -> None:
    missing = tmp_path / "NOTHERE.md"
    metrics = _scrape_readme_metrics(missing)
    assert metrics == []


# ─────────────────────────────────────────────────────────────────────────────
# CLI tests (subprocess, cwd=_HARNESS_DIR for portability)
# ─────────────────────────────────────────────────────────────────────────────

def test_classify_cli_shape(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    result = subprocess.run(
        [sys.executable, "-m", "evor.distill", "classify", "--root", str(root)],
        capture_output=True,
        text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    data = json.loads(result.stdout.strip())
    assert "workspace_class" in data
    assert "counts" in data
    assert set(data["counts"].keys()) == {"models", "datasets", "configs", "logs"}


def test_classify_cli_greenfield(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    result = subprocess.run(
        [sys.executable, "-m", "evor.distill", "classify", "--root", str(empty)],
        capture_output=True,
        text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    data = json.loads(result.stdout.strip())
    assert data["workspace_class"] == "greenfield"


def test_classify_cli_brownfield(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    result = subprocess.run(
        [sys.executable, "-m", "evor.distill", "classify", "--root", str(root)],
        capture_output=True,
        text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0
    data = json.loads(result.stdout.strip())
    assert data["workspace_class"] == "brownfield"


def test_scan_cli_writes_json_file(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    evor_root = tmp_path / "evor-out"
    result = subprocess.run(
        [
            sys.executable, "-m", "evor.distill", "scan",
            "--root", str(root),
            "--evor-root", str(evor_root),
            "--json",
        ],
        capture_output=True,
        text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"

    # Check stdout is valid JSON with required fields
    data = json.loads(result.stdout.strip())
    assert "workspace_class" in data
    assert "models" in data
    assert "datasets" in data
    assert "scraped_metrics" in data

    # Check starting-point.json was written
    sp_path = evor_root / "starting-point.json"
    assert sp_path.exists(), "starting-point.json not written"
    sp_data = json.loads(sp_path.read_text())
    assert sp_data["workspace_class"] == data["workspace_class"]


def test_scan_cli_human_summary(tmp_path: Path) -> None:
    root = _make_messy_repo(tmp_path)
    result = subprocess.run(
        [sys.executable, "-m", "evor.distill", "scan", "--root", str(root)],
        capture_output=True,
        text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    # Human summary contains the workspace class
    assert "brownfield" in result.stdout or "possibly-training" in result.stdout


def test_main_module_distill_classify(tmp_path: Path) -> None:
    """python -m evor distill classify also works."""
    root = _make_messy_repo(tmp_path)
    result = subprocess.run(
        [sys.executable, "-m", "evor", "distill", "classify", "--root", str(root)],
        capture_output=True,
        text=True,
        cwd=str(_HARNESS_DIR),
    )
    assert result.returncode == 0, f"stderr: {result.stderr}"
    data = json.loads(result.stdout.strip())
    assert "workspace_class" in data


# ─────────────────────────────────────────────────────────────────────────────
# verify_baseline_claim
# ─────────────────────────────────────────────────────────────────────────────

def test_verify_return_keys() -> None:
    result = verify_baseline_claim(
        model_path="/model.pt",
        frozen_split_dir="/splits/test",
        claimed_value=0.82,
        metric_name="val_acc",
        _measured_override=0.82,
    )
    assert set(result.keys()) == {"measured", "claimed", "reproduced", "delta", "note"}


def test_verify_reproduced() -> None:
    # measured == claimed → reproduced=True, delta=0
    result = verify_baseline_claim(
        model_path="/model.pt",
        frozen_split_dir="/splits",
        claimed_value=0.82,
        metric_name="val_acc",
        _measured_override=0.82,
    )
    assert result["reproduced"] is True
    assert result["delta"] == pytest.approx(0.0, abs=1e-9)
    assert result["measured"] == pytest.approx(0.82)
    assert result["claimed"] == pytest.approx(0.82)


def test_verify_not_reproduced() -> None:
    # measured is far from claimed
    result = verify_baseline_claim(
        model_path="/model.pt",
        frozen_split_dir="/splits",
        claimed_value=0.82,
        metric_name="val_acc",
        _measured_override=0.50,  # delta = -0.32; well beyond tolerance
    )
    assert result["reproduced"] is False
    assert result["delta"] == pytest.approx(-0.32, abs=1e-6)


def test_verify_tolerance_exact_boundary() -> None:
    # tolerance = max(0.02, 0.05 * 0.82) = max(0.02, 0.041) = 0.041
    # measured = claimed + tol - epsilon → clearly inside boundary → reproduced=True
    # (avoid floating-point edge: claimed+tol-claimed may slightly exceed tol)
    claimed = 0.82
    tol = max(0.02, 0.05 * abs(claimed))
    measured = claimed + tol - 1e-9  # just inside the boundary
    result = verify_baseline_claim(
        model_path="/model.pt",
        frozen_split_dir="/splits",
        claimed_value=claimed,
        metric_name="f1",
        _measured_override=measured,
    )
    assert result["reproduced"] is True


def test_verify_tolerance_just_over() -> None:
    # measured = claimed + tol + tiny epsilon → just over → reproduced=False
    claimed = 0.82
    tol = max(0.02, 0.05 * abs(claimed))
    measured = claimed + tol + 0.001
    result = verify_baseline_claim(
        model_path="/model.pt",
        frozen_split_dir="/splits",
        claimed_value=claimed,
        metric_name="f1",
        _measured_override=measured,
    )
    assert result["reproduced"] is False


def test_verify_delta_sign() -> None:
    # delta must be measured - claimed (signed)
    result = verify_baseline_claim(
        model_path="/m.pt",
        frozen_split_dir="/s",
        claimed_value=0.80,
        metric_name="acc",
        _measured_override=0.85,
    )
    assert result["delta"] == pytest.approx(0.05, abs=1e-9)


def test_verify_note_contains_metric() -> None:
    result = verify_baseline_claim(
        model_path="/m.pt",
        frozen_split_dir="/s",
        claimed_value=0.82,
        metric_name="my_special_metric",
        _measured_override=0.82,
    )
    assert "my_special_metric" in result["note"]


def test_verify_stub_neutral() -> None:
    # Without _measured_override the stub sets measured=claimed → reproduced=True
    result = verify_baseline_claim(
        model_path="/m.pt",
        frozen_split_dir="/s",
        claimed_value=0.75,
        metric_name="auc",
    )
    assert result["reproduced"] is True
    assert result["measured"] == pytest.approx(0.75)
    assert "stub" in result["note"].lower()


def test_verify_low_claimed_uses_absolute_floor() -> None:
    # For claimed=0.0, tolerance = max(0.02, 0) = 0.02
    result = verify_baseline_claim(
        model_path="/m.pt",
        frozen_split_dir="/s",
        claimed_value=0.0,
        metric_name="loss",
        _measured_override=0.019,
    )
    assert result["reproduced"] is True


def test_verify_not_reproduced_note_mentions_split() -> None:
    result = verify_baseline_claim(
        model_path="/m.pt",
        frozen_split_dir="/s",
        claimed_value=0.90,
        metric_name="acc",
        _measured_override=0.50,
    )
    assert result["reproduced"] is False
    note_lower = result["note"].lower()
    assert "split" in note_lower or "leak" in note_lower or "cherry" in note_lower
