"""§1.10 — the tree migration.

The sharpest risk in the release: a one-way rewrite of three live mission trees.
It has to decide the lifecycle outcome of three real missions, which is the
judgement the operator previously made by hand in ``vim`` — so it is the domain
model's first real user, not a schema bump.

The properties that matter are the ones that cannot be undone: node artifacts
must survive byte-identical (r3's are the input to 9.2's re-score, which the
trace calls the highest-value single action in the investigation), and a dry run
must write nothing at all.
"""

from __future__ import annotations

import json
from pathlib import Path

from evor.migrate_v121 import KILLED_SESSION_OUTCOME, apply_run, main, plan_run, write_campaign


def _tree(root: Path, mission: str, run_status: str | None, mission_status: str) -> Path:
    run_dir = root / mission / "run-live-01"
    (run_dir / "nodes" / "node-a").mkdir(parents=True)
    (run_dir / "nodes" / "node-a" / "telemetry.jsonl").write_text('{"loss": 0.5}\n')
    (run_dir / "nodes" / "node-a" / "results.json").write_text('{"metrics": {"fmeasure": 0.687}}')
    rs: dict = {"run_id": "run-live-01", "tick_count": 1, "frontier_ids": []}
    if run_status is not None:
        rs["status"] = run_status
    (run_dir / "run-state.json").write_text(json.dumps(rs))
    (run_dir / "mission-state.json").write_text(
        json.dumps({"status": mission_status, "updated_at": "2026-08-24T00:12:56.083Z"})
    )
    return run_dir


class TestPlanning:
    def test_it_drops_the_retired_key(self, tmp_path: Path):
        run_dir = _tree(tmp_path, "m-r1", "running", "failed")
        actions = {(c["action"], c["key"]) for c in plan_run(run_dir)}
        assert ("drop-key", "status") in actions

    def test_it_adds_entered_at_so_staleness_is_computable(self, tmp_path: Path):
        run_dir = _tree(tmp_path, "m-r1", "running", "failed")
        entered = [c for c in plan_run(run_dir) if c["key"] == "entered_at"]
        assert entered and entered[0]["value"] == "2026-08-24T00:12:56.083Z"

    def test_a_mission_still_claiming_running_is_adjudicated(self, tmp_path: Path):
        run_dir = _tree(tmp_path, "m-r3", "running", "running")
        adj = [c for c in plan_run(run_dir) if c["action"] == "adjudicate"]
        assert len(adj) == 1
        assert adj[0]["was"] == "running"
        assert adj[0]["value"] == KILLED_SESSION_OUTCOME == "failed"

    def test_an_already_terminal_mission_is_left_alone(self, tmp_path: Path):
        run_dir = _tree(tmp_path, "m-r1", "running", "failed")
        assert not [c for c in plan_run(run_dir) if c["action"] == "adjudicate"]

    def test_a_migrated_tree_needs_nothing_further(self, tmp_path: Path):
        # Idempotence. A one-way migration that is not idempotent cannot be
        # safely re-run after an interruption, which is when it will be re-run.
        run_dir = _tree(tmp_path, "m-r3", "running", "running")
        apply_run(run_dir, plan_run(run_dir))
        assert plan_run(run_dir) == []


class TestApplying:
    def test_node_artifacts_are_byte_identical(self, tmp_path: Path):
        run_dir = _tree(tmp_path, "m-r3", "running", "running")
        before = {p: p.read_bytes() for p in (run_dir / "nodes").rglob("*") if p.is_file()}
        apply_run(run_dir, plan_run(run_dir))
        after = {p: p.read_bytes() for p in (run_dir / "nodes").rglob("*") if p.is_file()}
        assert after == before, (
            "r3's node artifacts are the input to 9.2's re-score. A migration that "
            "touches them destroys the highest-value single action the investigation found."
        )

    def test_the_key_is_gone_and_nothing_else_is(self, tmp_path: Path):
        run_dir = _tree(tmp_path, "m-r3", "running", "running")
        apply_run(run_dir, plan_run(run_dir))
        rs = json.loads((run_dir / "run-state.json").read_text())
        assert "status" not in rs
        assert rs["tick_count"] == 1 and rs["frontier_ids"] == []

    def test_the_adjudication_is_recorded_with_its_reason(self, tmp_path: Path):
        run_dir = _tree(tmp_path, "m-r3", "running", "running")
        apply_run(run_dir, plan_run(run_dir))
        entries = [json.loads(l) for l in (run_dir / "transitions.jsonl").read_text().splitlines()]
        assert len(entries) == 1
        assert entries[0]["from"] == "running" and entries[0]["to"] == "failed"
        # K-08: a reason reconstructed later is a reconstruction.
        assert "killed" in entries[0]["reason"]


class TestDryRunWritesNothing:
    def test_a_dry_run_leaves_every_byte_alone(self, tmp_path: Path):
        _tree(tmp_path, "m-r1", "running", "failed")
        _tree(tmp_path, "m-r3", "running", "running")
        before = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
        assert main(["--runs-root", str(tmp_path)]) == 0
        after = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
        assert after == before, "a dry run that writes is not a dry run"

    def test_dry_run_does_not_create_the_campaign_file(self, tmp_path: Path):
        _tree(tmp_path, "m-r1", "running", "failed")
        main(["--runs-root", str(tmp_path)])
        assert not (tmp_path / "campaign.json").exists()


class TestCampaign:
    def test_attempts_are_ordered_and_linked(self, tmp_path: Path):
        for name in ("m-2026-08", "m-2026-08-r2", "m-2026-08-r3"):
            _tree(tmp_path, name, "running", "failed")
        missions = sorted(p for p in tmp_path.iterdir() if p.is_dir())
        c = write_campaign(tmp_path, missions, dry=False)
        assert [a["ordinal"] for a in c["attempts"]] == [1, 2, 3]
        assert c["attempts"][0]["supersedes_attempt_id"] is None
        assert c["attempts"][2]["supersedes_attempt_id"] == "m-2026-08-r2"
        assert json.loads((tmp_path / "campaign.json").read_text())["campaign_id"] == c["campaign_id"]
