"""A forge-family artifact read without kind resolves to the tick's only candidate."""
import json

from evor.artifacts import read_artifact


def _report(run_dir, slug):
    d = run_dir / "ticks" / "1" / "forge" / slug
    d.mkdir(parents=True)
    (d / "forge-report.json").write_text(json.dumps({"node_id": slug, "status": "done"}))


def test_single_candidate_is_found_without_kind(tmp_path):
    _report(tmp_path, "cosine-lr-01")
    r = read_artifact(tmp_path, 1, "forge")
    assert r.get("path", "").endswith("cosine-lr-01/forge-report.json"), r


def test_several_candidates_ask_for_kind(tmp_path):
    _report(tmp_path, "a-01")
    _report(tmp_path, "b-01")
    r = read_artifact(tmp_path, 1, "forge")
    assert "kind" in r.get("error", "")


def test_no_candidate_is_not_found(tmp_path):
    assert read_artifact(tmp_path, 1, "forge") == {"error": "not found"}
