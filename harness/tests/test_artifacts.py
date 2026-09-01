"""
Tests for harness/evor/artifacts.py.

Coverage:
  resolve_artifact_path:
    test_fixed_agents_produce_correct_paths  — all 8 fixed-path agents
    test_sage_junior_with_kind               — sage/juniors/<slug>.json
    test_acquirer_with_kind                  — acquirer/<slug>.json
    test_partial_flag_appends_suffix         — <name>-partial.json when partial=True
    test_sage_junior_requires_kind           — ValueError without kind
    test_acquirer_requires_kind              — ValueError without kind
    test_unknown_agent_raises               — ValueError for unknown agent
    test_kind_slugified_in_path             — spaces/special chars become dashes

  write_artifact:
    test_write_creates_file_atomically       — file exists at canonical path after write
    test_write_creates_intermediate_dirs     — ticks/N/groupdir/ created automatically
    test_write_mutagen_valid_proposals       — valid MutationProposal list passes
    test_write_mutagen_invalid_fails         — bad proposals payload returns {error}
    test_write_sage_valid_findings           — valid CitationBackedFinding list passes
    test_write_sage_invalid_fails            — missing required field returns {error}
    test_write_acquirer_valid               — valid AcquisitionProvenance passes
    test_write_forge_passthrough             — no Pydantic model → passes through
    test_write_partial_artifact              — -partial.json written when partial=True
    test_write_overwrites_existing           — second write replaces first

  python artifact_bridge.py (subprocess):
    test_artifact_bridge_help_exits_zero     — --help exits 0
    test_artifact_bridge_mutagen_roundtrip   — full bridge invocation with valid payload
    test_artifact_bridge_bad_agent_errors    — unknown agent returns {error}
    test_artifact_bridge_missing_payload_file — missing file returns {error}
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evor.artifacts import resolve_artifact_path, write_artifact, read_artifact, VALID_AGENTS

# Portable harness dir — works on host and inside container.
_HARNESS_DIR = Path(__file__).resolve().parent.parent


# ─────────────────────────────────────────────────────────────────────────────
# resolve_artifact_path
# ─────────────────────────────────────────────────────────────────────────────

class TestResolveArtifactPath:
    def test_fixed_agents_produce_correct_paths(self, tmp_path: Path) -> None:
        expected = {
            "mutagen":          f"ticks/3/mutagen/proposals.json",
            "selector":         f"ticks/3/selector/verdict.json",
            "probe":            f"ticks/3/probe/findings.json",
            "sage":             f"ticks/3/sage/findings.json",
            "forge":            f"ticks/3/forge/forge-report.json",
            "forge-architect":  f"ticks/3/forge/architect.json",
            "forge-critic":     f"ticks/3/forge/critic.json",
            "forge-analyst":    f"ticks/3/forge/analyst.json",
        }
        for agent, rel in expected.items():
            path = resolve_artifact_path(tmp_path, tick=3, agent=agent)
            assert path == tmp_path / rel, f"agent={agent!r}: {path} != {tmp_path / rel}"

    def test_sage_junior_with_kind(self, tmp_path: Path) -> None:
        path = resolve_artifact_path(tmp_path, tick=1, agent="sage-junior", kind="attention-mechanisms")
        assert path == tmp_path / "ticks/1/sage/juniors/attention-mechanisms.json"

    def test_acquirer_with_kind(self, tmp_path: Path) -> None:
        path = resolve_artifact_path(tmp_path, tick=5, agent="acquirer", kind="huggingface-cifar")
        assert path == tmp_path / "ticks/5/acquirer/huggingface-cifar.json"

    def test_partial_flag_appends_suffix(self, tmp_path: Path) -> None:
        path = resolve_artifact_path(tmp_path, tick=2, agent="mutagen", partial=True)
        assert path.name == "proposals-partial.json"

    def test_sage_junior_requires_kind(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="kind"):
            resolve_artifact_path(tmp_path, tick=1, agent="sage-junior")

    def test_acquirer_requires_kind(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="kind"):
            resolve_artifact_path(tmp_path, tick=1, agent="acquirer")

    def test_unknown_agent_raises(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="Unknown agent"):
            resolve_artifact_path(tmp_path, tick=1, agent="nonexistent-agent")

    def test_kind_slugified_in_path(self, tmp_path: Path) -> None:
        path = resolve_artifact_path(tmp_path, tick=1, agent="acquirer", kind="HuggingFace CIFAR10!")
        assert " " not in path.name
        assert "!" not in path.name


# ─────────────────────────────────────────────────────────────────────────────
# write_artifact
# ─────────────────────────────────────────────────────────────────────────────

def _minimal_proposal() -> dict:
    """Return a minimal valid MutationProposal dict."""
    return {
        "proposal_id": "p-001",
        "parent_node_ids": ["root"],
        "approach_family": "arch",
        "idea": "Add a residual connection",
        "hypothesis": {
            "id": "h-001",
            "statement": "Residuals improve gradient flow",
            "prediction": "val_acc +2pp",
        },
        "citations": [],
        "wildness": 0.3,
        "critic_review": {
            "h001_one_hypothesis": "pass",
            "h002_family_streak": "pass",
            "h003_intra_tick_diversity": "pass",
            "integrity_risk": "pass",
            "instrumentation_check": "pass",
            "schema_valid": "pass",
            "verdict": "approved",
        },
    }


def _minimal_finding() -> dict:
    """Return a minimal valid CitationBackedFinding dict."""
    return {
        "title": "Attention improves accuracy",
        "source_url": "https://arxiv.org/abs/0000.00001",
        "sources": ["https://arxiv.org/abs/0000.00001"],
        "finding": "Self-attention boosts accuracy by 3pp on CIFAR-10.",
        "evidence": "Table 2, CIFAR-10 val set.",
        "confidence": "high",
        "trust_level": "authoritative",
        "applicable_families": ["arch"],
        "quorum_met": True,
    }


def _minimal_provenance() -> dict:
    """Return a minimal valid AcquisitionProvenance dict."""
    return {
        "acquisition_id": "acq-001",
        "acquisition_type": "external",
        "source_name": "HuggingFace",
        "source_url": "https://huggingface.co/datasets/cifar10",
        "license_identifier": "MIT",
        "license_in_allowlist": True,
        "citation": "CIFAR-10 dataset",
        "sample_count": 50000,
        "acquired_at": datetime.now(timezone.utc).isoformat(),
        "ingestion_contamination_cleared": True,
    }


class TestWriteArtifact:
    def test_write_creates_file_atomically(self, tmp_path: Path) -> None:
        result = write_artifact(tmp_path, tick=1, agent="forge", payload={"summary": "ok"})
        assert result.get("ok") is True
        target = tmp_path / "ticks/1/forge/forge-report.json"
        assert target.exists()
        assert json.loads(target.read_text()) == {"summary": "ok"}

    def test_write_creates_intermediate_dirs(self, tmp_path: Path) -> None:
        result = write_artifact(tmp_path, tick=7, agent="probe", payload={"findings": []})
        assert result.get("ok") is True
        assert (tmp_path / "ticks/7/probe").is_dir()

    def test_write_mutagen_valid_proposals(self, tmp_path: Path) -> None:
        payload = {"proposals": [_minimal_proposal()]}
        result = write_artifact(tmp_path, tick=1, agent="mutagen", payload=payload)
        assert result.get("ok") is True, result.get("error")

    def test_write_mutagen_invalid_fails(self, tmp_path: Path) -> None:
        # Missing required field 'idea'
        bad = {"proposals": [{"proposal_id": "bad", "approach_family": "arch"}]}
        result = write_artifact(tmp_path, tick=1, agent="mutagen", payload=bad)
        assert "error" in result
        assert "mutagen" in result["error"].lower() or "validation" in result["error"].lower()

    def test_write_sage_valid_findings(self, tmp_path: Path) -> None:
        payload = [_minimal_finding()]
        result = write_artifact(tmp_path, tick=2, agent="sage", payload=payload)
        assert result.get("ok") is True, result.get("error")

    def test_write_sage_invalid_fails(self, tmp_path: Path) -> None:
        bad_payload = [{"title": "incomplete finding"}]  # missing many required fields
        result = write_artifact(tmp_path, tick=2, agent="sage", payload=bad_payload)
        assert "error" in result

    def test_write_acquirer_valid(self, tmp_path: Path) -> None:
        result = write_artifact(
            tmp_path, tick=3, agent="acquirer",
            payload=_minimal_provenance(), kind="huggingface-cifar"
        )
        assert result.get("ok") is True, result.get("error")

    def test_write_forge_passthrough(self, tmp_path: Path) -> None:
        payload = {"node_id": "n1", "approach": "ResNet50", "summary": "works"}
        result = write_artifact(tmp_path, tick=1, agent="forge", payload=payload)
        assert result.get("ok") is True

    def test_write_partial_artifact(self, tmp_path: Path) -> None:
        payload = {"proposals": []}
        result = write_artifact(tmp_path, tick=4, agent="mutagen", payload=payload, partial=True)
        assert result.get("ok") is True
        target = tmp_path / "ticks/4/mutagen/proposals-partial.json"
        assert target.exists()

    def test_write_overwrites_existing(self, tmp_path: Path) -> None:
        write_artifact(tmp_path, tick=1, agent="forge", payload={"v": 1})
        write_artifact(tmp_path, tick=1, agent="forge", payload={"v": 2})
        target = tmp_path / "ticks/1/forge/forge-report.json"
        assert json.loads(target.read_text())["v"] == 2

    def test_sage_junior_write(self, tmp_path: Path) -> None:
        result = write_artifact(
            tmp_path, tick=2, agent="sage-junior",
            payload=_minimal_finding(), kind="attention"
        )
        assert result.get("ok") is True
        target = tmp_path / "ticks/2/sage/juniors/attention.json"
        assert target.exists()


# ─────────────────────────────────────────────────────────────────────────────
# selector verdict contract (C4) — three real shapes seen across one live run:
#   tick 1: canonical — "reviews" + nested "critic_review" + "selected" + top "winner"
#   tick 2: gate results hoisted to top level of each review; container renamed
#           "per_proposal_reviews"; no "selected"/"winner"
#   tick 3: adds a stray top-level "critic_approved" alongside "critic_review";
#           uses "selected_for_forge" instead of "selected"
# ─────────────────────────────────────────────────────────────────────────────

def _minimal_critic_review(verdict: str = "approved") -> dict:
    review = {
        "h001_one_hypothesis": "pass",
        "h002_family_streak": "pass",
        "h003_intra_tick_diversity": "pass",
        "h004_parent_diversity": "pass",
        "integrity_risk": "pass",
        "instrumentation_check": "pass",
        "schema_valid": "pass",
        "acquisition_contamination": None,
        "gotcha_avoidance": "pass",
        "verdict": verdict,
    }
    if verdict == "rejected":
        review["rejection_reason"] = "h001 fail: prediction unquantified"
    return review


def _minimal_selector_verdict() -> dict:
    """Canonical SelectorVerdict payload — the tick-1 shape from the C4 evidence."""
    return {
        "reviews": [
            {
                "proposal_id": "p1",
                "approach_family": "algo",
                "critic_review": _minimal_critic_review("approved"),
                "selected": True,
                "selection_note": "best fit for this tick",
            }
        ],
        "winner": "p1",
    }


class TestSelectorVerdictContract:
    def test_canonical_shape_accepted(self, tmp_path: Path) -> None:
        result = write_artifact(tmp_path, tick=1, agent="selector", payload=_minimal_selector_verdict())
        assert result.get("ok") is True, result.get("error")

    def test_tick2_shape_rejected(self, tmp_path: Path) -> None:
        # Real tick-2 shape: hoisted gate fields, renamed container, no reviews/selected/winner.
        payload = {
            "per_proposal_reviews": [
                {
                    "proposal_id": "p2",
                    "approach_family": "algo",
                    "h001_one_hypothesis": "pass",
                    "h002_family_streak": "pass",
                    "h003_intra_tick_diversity": "pass",
                    "verdict": "deferred",
                }
            ],
            "fast_path": True,
            "selected_winner": "p2",
            "summary": "deferred pending review",
        }
        result = write_artifact(tmp_path, tick=2, agent="selector", payload=payload)
        assert "error" in result
        assert "reviews" in result["error"]

    def test_tick3_shape_rejected(self, tmp_path: Path) -> None:
        # Real tick-3 shape: stray critic_approved alongside critic_review,
        # selected_for_forge instead of selected.
        payload = {
            "reviews": [
                {
                    "proposal_id": "p4",
                    "approach_family": "algo",
                    # The stray field is the POINT of this case — it must be
                    # rejected and named. 2b.2 removed `critic_approved` from the
                    # contract, which makes this rejection structural rather than
                    # a special case, so the test gets stronger, not weaker.
                    "critic_approved": True,
                    "critic_review": _minimal_critic_review("approved"),
                    "selected_for_forge": True,
                    "selection_note": "chosen",
                }
            ]
        }
        result = write_artifact(tmp_path, tick=3, agent="selector", payload=payload)
        assert "error" in result
        # Actionable: names the offending fields, not just "invalid".
        assert "critic_approved" in result["error"]
        assert "selected" in result["error"]

    def test_round_trip_unchanged(self, tmp_path: Path) -> None:
        payload = _minimal_selector_verdict()
        write_result = write_artifact(tmp_path, tick=5, agent="selector", payload=payload)
        assert write_result.get("ok") is True, write_result.get("error")
        read_result = read_artifact(tmp_path, tick=5, agent="selector")
        assert read_result.get("ok") is True, read_result.get("error")
        assert read_result["payload"] == payload

    def test_error_names_offending_field_not_generic(self, tmp_path: Path) -> None:
        # Missing required 'proposal_id' — error must name it, not say "invalid".
        payload = {
            "reviews": [
                {
                    "approach_family": "algo",
                    "critic_review": _minimal_critic_review("approved"),
                    "selected": True,
                }
            ]
        }
        result = write_artifact(tmp_path, tick=6, agent="selector", payload=payload)
        assert "error" in result
        assert "proposal_id" in result["error"]

    def test_selector_md_documents_same_field_names_as_validator(self) -> None:
        """The Output_Format block in agents/evor-selector.md must use exactly the
        field names the validator requires — a schema the agent's own instructions
        contradict is a trap (per the C4 task). Extract field names from the md
        file itself rather than hardcoding a second copy of the schema."""
        import re

        from evor.contracts import CriticReview, SelectorReview, SelectorVerdict

        md_path = _HARNESS_DIR.parent / "agents" / "evor-selector.md"
        text = md_path.read_text()

        # Grab the first fenced ```json ... ``` block inside Output_Format.
        output_format = text.split("<Output_Format>", 1)[1].split("</Output_Format>", 1)[0]
        code_block = re.search(r"```json(.*?)```", output_format, re.DOTALL)
        assert code_block, "Output_Format must contain a fenced json example"

        documented_fields = set(re.findall(r'"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:', code_block.group(1)))

        required_fields = (
            set(SelectorVerdict.model_fields)
            | set(SelectorReview.model_fields)
            | set(CriticReview.model_fields)
        )

        missing = required_fields - documented_fields
        assert not missing, f"evor-selector.md Output_Format is missing fields: {missing}"


# ─────────────────────────────────────────────────────────────────────────────
# artifact_bridge.py (subprocess)
# ─────────────────────────────────────────────────────────────────────────────

_BRIDGE = _HARNESS_DIR.parent / "mcp" / "bridge" / "artifact_bridge.py"


def _run_bridge(*args: str, payload: dict | None = None) -> subprocess.CompletedProcess:
    """Run artifact_bridge.py with a temp payload file and extra args."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        json.dump(payload or {}, f)
        payload_path = f.name
    try:
        return subprocess.run(
            [sys.executable, str(_BRIDGE), *args, "--payload-file", payload_path],
            capture_output=True,
            text=True,
            env={
                "PATH": "/usr/bin:/bin",
                "PYTHONPATH": str(_HARNESS_DIR),
            },
        )
    finally:
        Path(payload_path).unlink(missing_ok=True)


class TestArtifactBridge:
    def test_help_exits_zero(self) -> None:
        result = subprocess.run(
            [sys.executable, str(_BRIDGE), "--help"],
            capture_output=True, text=True,
            env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(_HARNESS_DIR)},
        )
        assert result.returncode == 0

    def test_mutagen_roundtrip(self, tmp_path: Path) -> None:
        payload = {"proposals": [_minimal_proposal()]}
        result = _run_bridge(
            "--run-dir", str(tmp_path),
            "--tick", "1",
            "--agent", "mutagen",
            payload=payload,
        )
        assert result.returncode == 0, result.stderr
        data = json.loads(result.stdout)
        assert data.get("ok") is True
        assert (tmp_path / "ticks/1/mutagen/proposals.json").exists()

    def test_bad_agent_errors(self, tmp_path: Path) -> None:
        result = _run_bridge(
            "--run-dir", str(tmp_path),
            "--tick", "1",
            "--agent", "nonexistent",
            payload={},
        )
        assert result.returncode != 0
        data = json.loads(result.stdout)
        assert "error" in data

    def test_missing_payload_file_errors(self, tmp_path: Path) -> None:
        result = subprocess.run(
            [
                sys.executable, str(_BRIDGE),
                "--run-dir", str(tmp_path),
                "--tick", "1",
                "--agent", "selector",
                "--payload-file", "/nonexistent/path/payload.json",
            ],
            capture_output=True, text=True,
            env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(_HARNESS_DIR)},
        )
        assert result.returncode != 0
        data = json.loads(result.stdout)
        assert "error" in data


# ─────────────────────────────────────────────────────────────────────────────
# read_artifact
# ─────────────────────────────────────────────────────────────────────────────

class TestReadArtifact:
    def test_returns_payload_when_found(self, tmp_path: Path) -> None:
        write_artifact(tmp_path, tick=1, agent="forge", payload={"summary": "ok"})
        result = read_artifact(tmp_path, tick=1, agent="forge")
        assert result.get("ok") is True
        assert result["payload"] == {"summary": "ok"}
        assert result["path"].endswith("forge/forge-report.json")

    def test_not_found_returns_error_not_found(self, tmp_path: Path) -> None:
        result = read_artifact(tmp_path, tick=1, agent="selector")
        assert result == {"error": "not found"}

    def test_read_validates_mutagen_on_read(self, tmp_path: Path) -> None:
        payload = {"proposals": [_minimal_proposal()]}
        write_artifact(tmp_path, tick=1, agent="mutagen", payload=payload)
        result = read_artifact(tmp_path, tick=1, agent="mutagen")
        assert result.get("ok") is True
        assert result["payload"] == payload

    def test_read_partial_artifact(self, tmp_path: Path) -> None:
        write_artifact(tmp_path, tick=2, agent="mutagen", payload={"proposals": []}, partial=True)
        result = read_artifact(tmp_path, tick=2, agent="mutagen", partial=True)
        assert result.get("ok") is True

    def test_read_sage_junior_with_kind(self, tmp_path: Path) -> None:
        finding = _minimal_finding()
        write_artifact(tmp_path, tick=3, agent="sage-junior", payload=finding, kind="attention")
        result = read_artifact(tmp_path, tick=3, agent="sage-junior", kind="attention")
        assert result.get("ok") is True
        assert result["payload"] == finding

    def test_read_acquirer_with_kind(self, tmp_path: Path) -> None:
        prov = _minimal_provenance()
        write_artifact(tmp_path, tick=4, agent="acquirer", payload=prov, kind="hf-cifar")
        result = read_artifact(tmp_path, tick=4, agent="acquirer", kind="hf-cifar")
        assert result.get("ok") is True

    def test_unknown_agent_returns_error(self, tmp_path: Path) -> None:
        result = read_artifact(tmp_path, tick=1, agent="nonexistent")  # type: ignore[arg-type]
        assert "error" in result
        assert result["error"] != "not found"

    def test_path_in_result_matches_canonical(self, tmp_path: Path) -> None:
        write_artifact(tmp_path, tick=5, agent="probe", payload={"findings": []})
        result = read_artifact(tmp_path, tick=5, agent="probe")
        assert result.get("ok") is True
        assert "ticks/5/probe/findings.json" in result["path"].replace("\\", "/")


# ─────────────────────────────────────────────────────────────────────────────
# read_artifact_bridge.py (subprocess)
# ─────────────────────────────────────────────────────────────────────────────

_READ_BRIDGE = _HARNESS_DIR.parent / "mcp" / "bridge" / "read_artifact_bridge.py"


def _run_read_bridge(tmp_path: Path, *extra_args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(_READ_BRIDGE), *extra_args],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(_HARNESS_DIR)},
    )


class TestReadArtifactBridge:
    def test_help_exits_zero(self) -> None:
        result = subprocess.run(
            [sys.executable, str(_READ_BRIDGE), "--help"],
            capture_output=True, text=True,
            env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(_HARNESS_DIR)},
        )
        assert result.returncode == 0

    def test_not_found_exits_zero_with_error_key(self, tmp_path: Path) -> None:
        # "not found" is an expected outcome — bridge must exit 0.
        result = _run_read_bridge(
            tmp_path,
            "--run-dir", str(tmp_path),
            "--tick", "1",
            "--agent", "selector",
        )
        assert result.returncode == 0, result.stderr
        data = json.loads(result.stdout)
        assert data == {"error": "not found"}

    def test_found_returns_payload(self, tmp_path: Path) -> None:
        write_artifact(tmp_path, tick=2, agent="forge", payload={"summary": "ok"})
        result = _run_read_bridge(
            tmp_path,
            "--run-dir", str(tmp_path),
            "--tick", "2",
            "--agent", "forge",
        )
        assert result.returncode == 0, result.stderr
        data = json.loads(result.stdout)
        assert data.get("ok") is True
        assert data["payload"] == {"summary": "ok"}

    def test_bad_agent_exits_one(self, tmp_path: Path) -> None:
        result = _run_read_bridge(
            tmp_path,
            "--run-dir", str(tmp_path),
            "--tick", "1",
            "--agent", "nonexistent",
        )
        assert result.returncode != 0
        data = json.loads(result.stdout)
        assert "error" in data
        assert data["error"] != "not found"
