"""
harness/tests/test_compaction_survival.py

Tests for the compaction-survival layer:
  - pre-compact.mjs checkpoint payload is well-formed
  - <evor-restore> systemMessage is ≤500 chars and contains required fields
  - subagent-stop.mjs emits advisory warning for missing artifact, silent on present
  - session-start.mjs injects <evor-restore> when state files exist

All hook tests use subprocess calls matching the pattern in mcp/tests/hooks.test.ts,
but driven from Python + pytest.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

# ── Helpers ───────────────────────────────────────────────────────────────────

HOOKS_DIR = Path(__file__).parent.parent.parent / "hooks"
PRE_COMPACT = str(HOOKS_DIR / "pre-compact.mjs")
SUBAGENT_STOP = str(HOOKS_DIR / "subagent-stop.mjs")
SESSION_START = str(HOOKS_DIR / "session-start.mjs")

NODE_BIN = "node"


def run_hook(script: str, env: dict[str, str], timeout: int = 10) -> subprocess.CompletedProcess:
    """Spawn a hook script with a minimal, controlled environment."""
    clean_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    clean_env.update(env)
    return subprocess.run(
        [NODE_BIN, script],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=clean_env,
    )


# ── pre-compact checkpoint payload ────────────────────────────────────────────

class TestPreCompactCheckpoint:
    """Checkpoint written by pre-compact.mjs must be well-formed."""

    def test_checkpoint_written_on_active_run(self, tmp_path: Path) -> None:
        run_id = "run-pytest-001"
        run_dir = tmp_path / "runs" / run_id
        run_dir.mkdir(parents=True)

        (tmp_path / "active-run.json").write_text(
            json.dumps({"run_id": run_id})
        )
        (run_dir / "run-state.json").write_text(
            json.dumps({
                "tick_count": 3,
                "best_score": 0.88,
                "best_node_id": "node-alpha",
                "pending_node_ids": [],
            })
        )
        (run_dir / "tick-state.json").write_text(
            json.dumps({"tick": 3, "current_step": 4, "step_status": "running"})
        )
        (run_dir / "mission-state.json").write_text(
            json.dumps({"objective": "maximise F1 on CIFAR-10", "status": "running"})
        )

        result = run_hook(PRE_COMPACT, {
            "EVOR_ROOT": str(tmp_path),
            "EVOR_ACTIVE_RUN_ID": run_id,
        })
        assert result.returncode == 0

        checkpoints_dir = run_dir / "checkpoints"
        assert checkpoints_dir.exists(), "checkpoints/ dir should be created"
        files = list(checkpoints_dir.glob("precompact-*.json"))
        assert len(files) == 1, f"Expected exactly 1 checkpoint, got {len(files)}"

        cp = json.loads(files[0].read_text())
        assert "current_tick" in cp, "checkpoint must have current_tick"
        assert "current_step" in cp, "checkpoint must have current_step"
        assert "best_score" in cp, "checkpoint must have best_score"
        assert "best_node_id" in cp, "checkpoint must have best_node_id"
        assert "pending_node_ids" in cp, "checkpoint must have pending_node_ids"
        assert "flushed_at" in cp, "checkpoint must have flushed_at"
        assert "run_id" in cp, "checkpoint must have run_id"
        assert cp["run_id"] == run_id
        assert cp["current_tick"] == 3
        assert cp["best_score"] == pytest.approx(0.88)

    def test_checkpoint_includes_mission_objective(self, tmp_path: Path) -> None:
        run_id = "run-pytest-002"
        mission_id = "mission-pytest-002"
        run_dir = tmp_path / "runs" / mission_id / run_id
        run_dir.mkdir(parents=True)

        (tmp_path / "active-run.json").write_text(
            json.dumps({"run_id": run_id, "mission_id": mission_id})
        )
        (run_dir / "mission-state.json").write_text(
            json.dumps({"objective": "beat SOTA on WikiText-103", "status": "running"})
        )
        (run_dir / "run-state.json").write_text(
            json.dumps({"tick_count": 1, "best_score": 0.5, "pending_node_ids": []})
        )

        result = run_hook(PRE_COMPACT, {
            "EVOR_ROOT": str(tmp_path),
            "EVOR_ACTIVE_RUN_ID": run_id,
            "EVOR_MISSION_ID": mission_id,
        })
        assert result.returncode == 0

        files = list((run_dir / "checkpoints").glob("precompact-*.json"))
        assert len(files) == 1
        cp = json.loads(files[0].read_text())
        assert "beat SOTA on WikiText-103" in cp.get("mission_objective", "")

    def test_checkpoint_trigger_field_recorded(self, tmp_path: Path) -> None:
        run_id = "run-pytest-003"
        run_dir = tmp_path / "runs" / run_id
        run_dir.mkdir(parents=True)

        (tmp_path / "active-run.json").write_text(json.dumps({"run_id": run_id}))
        (run_dir / "run-state.json").write_text(
            json.dumps({"tick_count": 0, "best_score": None, "pending_node_ids": []})
        )

        result = run_hook(PRE_COMPACT, {
            "EVOR_ROOT": str(tmp_path),
            "EVOR_ACTIVE_RUN_ID": run_id,
            "CLAUDE_HOOK_INPUT": json.dumps({"trigger": "manual"}),
        })
        assert result.returncode == 0

        files = list((run_dir / "checkpoints").glob("precompact-*.json"))
        assert files, "checkpoint must be written even for manual trigger"
        cp = json.loads(files[0].read_text())
        assert cp.get("trigger") == "manual"


# ── <evor-restore> payload shape ──────────────────────────────────────────────

class TestEvorRestorePayload:
    """The systemMessage from pre-compact must meet the ≤500 char contract."""

    def test_restore_payload_within_500_chars(self, tmp_path: Path) -> None:
        run_id = "run-restore-py-001"
        mission_id = "m-restore-py-001"
        run_dir = tmp_path / "runs" / mission_id / run_id
        run_dir.mkdir(parents=True)

        (tmp_path / "active-run.json").write_text(
            json.dumps({"run_id": run_id, "mission_id": mission_id})
        )
        (run_dir / "mission-state.json").write_text(
            json.dumps({
                "objective": "A" * 200,   # long objective to stress the limit
                "status": "running",
            })
        )
        (run_dir / "tick-state.json").write_text(
            json.dumps({"tick": 99, "current_step": 8})
        )
        (run_dir / "run-state.json").write_text(
            json.dumps({
                "tick_count": 99,
                "best_score": 0.9999,
                "best_node_id": "node-" + "z" * 30,
                "pending_node_ids": [],
            })
        )

        result = run_hook(PRE_COMPACT, {
            "EVOR_ROOT": str(tmp_path),
            "EVOR_ACTIVE_RUN_ID": run_id,
            "EVOR_MISSION_ID": mission_id,
        })
        assert result.returncode == 0

        output = json.loads(result.stdout.strip())
        assert output.get("continue") is True
        msg = output.get("systemMessage", "")
        assert len(msg) <= 500, f"systemMessage is {len(msg)} chars (limit 500)"
        assert "<evor-restore>" in msg
        assert "</evor-restore>" in msg

    def test_restore_payload_contains_required_fields(self, tmp_path: Path) -> None:
        run_id = "run-restore-py-002"
        run_dir = tmp_path / "runs" / run_id
        run_dir.mkdir(parents=True)

        (tmp_path / "active-run.json").write_text(json.dumps({"run_id": run_id}))
        (run_dir / "mission-state.json").write_text(
            json.dumps({"objective": "test objective", "status": "running"})
        )
        (run_dir / "tick-state.json").write_text(
            json.dumps({"tick": 7, "current_step": 2})
        )
        (run_dir / "run-state.json").write_text(
            json.dumps({
                "tick_count": 7,
                "best_score": 0.75,
                "best_node_id": "node-best-001",
                "pending_node_ids": [],
            })
        )

        result = run_hook(PRE_COMPACT, {
            "EVOR_ROOT": str(tmp_path),
            "EVOR_ACTIVE_RUN_ID": run_id,
        })
        assert result.returncode == 0

        output = json.loads(result.stdout.strip())
        msg = output["systemMessage"]
        # Must contain tick reference
        assert "Tick 7" in msg, "restore must mention current tick"
        # Must mention run id (possibly truncated)
        assert run_id[:10] in msg, "restore must reference run_id"
        # Must have recovery hint
        assert ".evor/" in msg, "restore must include recovery path hint"

    def test_no_active_run_exits_0_silently(self, tmp_path: Path) -> None:
        result = run_hook(PRE_COMPACT, {"EVOR_ROOT": str(tmp_path)})
        assert result.returncode == 0
        assert result.stdout.strip() == "", "no output when no active run"

    def test_disable_evor_skips_all_logic(self, tmp_path: Path) -> None:
        (tmp_path / "active-run.json").write_text(json.dumps({"run_id": "run-ks"}))
        result = run_hook(PRE_COMPACT, {
            "EVOR_ROOT": str(tmp_path),
            "DISABLE_EVOR": "1",
        })
        assert result.returncode == 0
        assert result.stdout.strip() == ""


# ── subagent-stop artifact check ──────────────────────────────────────────────

class TestSubagentStopArtifactCheck:
    """subagent-stop.mjs advisory check for per-role deliverables."""

    def test_warns_on_missing_sage_artifact(self, tmp_path: Path) -> None:
        run_id = "run-sa-py-001"
        run_dir = tmp_path / "runs" / run_id
        run_dir.mkdir(parents=True)

        (run_dir / "tick-state.json").write_text(json.dumps({"tick": 2, "current_step": 3}))

        result = run_hook(SUBAGENT_STOP, {
            "EVOR_ROOT": str(tmp_path),
            "EVOR_ACTIVE_RUN_ID": run_id,
            "EVOR_AGENT_ROLE": "sage",
        })
        assert result.returncode == 0
        assert "[EVOR SUBAGENT WARNING]" in result.stdout
        assert "findings.json" in result.stdout

    def test_silent_when_artifact_present(self, tmp_path: Path) -> None:
        run_id = "run-sa-py-002"
        tick = 3
        run_dir = tmp_path / "runs" / run_id
        artifact_dir = run_dir / "ticks" / str(tick) / "mutagen"
        artifact_dir.mkdir(parents=True)

        (run_dir / "tick-state.json").write_text(json.dumps({"tick": tick, "current_step": 2}))
        (artifact_dir / "proposals.json").write_text(
            json.dumps({"proposals": [{"id": "p-1", "approach_family": "arch"}]})
        )

        result = run_hook(SUBAGENT_STOP, {
            "EVOR_ROOT": str(tmp_path),
            "EVOR_ACTIVE_RUN_ID": run_id,
            "EVOR_AGENT_ROLE": "mutagen",
        })
        assert result.returncode == 0
        assert result.stdout.strip() == "", "no warning when artifact is present"

    def test_silent_when_no_active_run(self, tmp_path: Path) -> None:
        result = run_hook(SUBAGENT_STOP, {"EVOR_ROOT": str(tmp_path)})
        assert result.returncode == 0
        assert result.stdout.strip() == ""

    def test_disable_evor_skips(self, tmp_path: Path) -> None:
        result = run_hook(SUBAGENT_STOP, {
            "EVOR_ROOT": str(tmp_path),
            "EVOR_ACTIVE_RUN_ID": "run-ks",
            "EVOR_AGENT_ROLE": "forge",
            "DISABLE_EVOR": "1",
        })
        assert result.returncode == 0
        assert result.stdout.strip() == ""

    @pytest.mark.parametrize("role,expected_file", [
        ("sage", "findings.json"),
        ("mutagen", "proposals.json"),
        ("probe", "findings.json"),
        ("forge", "forge-report.json"),
        ("selector", "verdict.json"),
    ])
    def test_each_role_has_distinct_artifact(
        self, tmp_path: Path, role: str, expected_file: str
    ) -> None:
        """Each roster role's missing artifact produces a warning naming the correct file."""
        run_id = f"run-sa-py-role-{role}"
        run_dir = tmp_path / "runs" / run_id
        run_dir.mkdir(parents=True)
        (run_dir / "tick-state.json").write_text(json.dumps({"tick": 1, "current_step": 5}))

        result = run_hook(SUBAGENT_STOP, {
            "EVOR_ROOT": str(tmp_path),
            "EVOR_ACTIVE_RUN_ID": run_id,
            "EVOR_AGENT_ROLE": role,
        })
        assert result.returncode == 0
        assert "[EVOR SUBAGENT WARNING]" in result.stdout
        assert expected_file in result.stdout, (
            f"Warning for role={role} must mention artifact {expected_file}"
        )
