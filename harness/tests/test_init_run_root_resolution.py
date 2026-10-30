"""init_run reads its capability probe from the same root it creates the run in.

It held two answers for "where is .evor": run creation honoured EVOR_ROOT, the
capability check did not and fell back to the PROCESS CWD. The MCP server runs with
cwd = the plugin repo, so with the root set by environment the check read the wrong
directory and refused "no capability profile" seconds after evor_capability wrote
one. Every bench tick since 2026-09-02 failed there, before any model ran.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_wave1_environment_secrets import _minimal_answers  # noqa: E402


def test_probe_is_found_under_EVOR_ROOT_whatever_the_cwd(tmp_path: Path) -> None:
    evor_root = tmp_path / "project" / ".evor"
    evor_root.mkdir(parents=True)
    (evor_root / "capability.json").write_text(json.dumps({
        "gpu_arch": None, "gpu_name": None, "vram_gb": None,
        "supported_dtypes": ["fp32"], "available_libs": [],
        "cuda_version": None, "cpu_only": True,
        "probed_at": datetime.now(timezone.utc).isoformat(),
    }))
    answers = tmp_path / "answers.json"
    answers.write_text(json.dumps(_minimal_answers()))
    elsewhere = tmp_path / "unrelated-cwd"  # the plugin repo, in the field
    elsewhere.mkdir()

    proc = subprocess.run(
        [sys.executable, "-m", "evor", "init-run", "--answers", str(answers), "--run-id", "r1"],
        cwd=elsewhere, capture_output=True, text=True, timeout=120,
        env={**os.environ, "PYTHONPATH": str(HARNESS), "EVOR_ROOT": str(evor_root)},
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "no capability profile" not in proc.stdout
    # And the run lands under the same root the probe was read from.
    assert any((evor_root / "runs").rglob("run-state.json")), "run not created under EVOR_ROOT"
    assert not (elsewhere / ".evor").exists(), "init wrote a second .evor under the cwd"
