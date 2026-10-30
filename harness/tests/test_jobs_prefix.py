"""A job is found by a unique prefix of its id, as agents quote it."""
import json
from pathlib import Path

from evor.jobs import status, status_path


def _job(run_dir: Path, job_id: str) -> None:
    d = run_dir / "jobs" / job_id
    d.mkdir(parents=True)
    (d / "status.json").write_text(json.dumps({"state": "succeeded", "job_id": job_id}))


def test_unique_prefix_finds_the_job(tmp_path):
    _job(tmp_path, "be9bd7b6-04e6-48d7-9b9a-3f75d39b300e")
    assert status("be9bd7b6", tmp_path)["state"] == "succeeded"


def test_ambiguous_or_short_prefix_is_not_a_job(tmp_path):
    _job(tmp_path, "be9bd7b6-0000-0000-0000-000000000001")
    _job(tmp_path, "be9bd7b6-0000-0000-0000-000000000002")
    assert status("be9bd7b6", tmp_path)["state"] == "unknown"
    assert status("be9b", tmp_path)["state"] == "unknown"


def test_a_new_full_id_resolves_to_its_own_directory(tmp_path):
    _job(tmp_path, "be9bd7b6-04e6-48d7-9b9a-3f75d39b300e")
    new = "c0ffee00-0000-0000-0000-000000000000"
    assert status_path(tmp_path, new) == tmp_path / "jobs" / new / "status.json"
