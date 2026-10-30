"""A Selector winner written inside its review is lifted to the top level."""
import json

from evor.artifacts import write_artifact

CRITIC = {
    "h001_one_hypothesis": "pass", "h002_family_streak": "pass", "h003_intra_tick_diversity": "pass",
    "h004_parent_diversity": "pass", "integrity_risk": "pass", "instrumentation_check": "pass",
    "schema_valid": "pass", "acquisition_contamination": None, "gotcha_avoidance": "pass",
    "verdict": "approved", "rejection_reason": None,
}


def _review(pid, **extra):
    r = {"proposal_id": pid, "approach_family": "arch", "critic_review": dict(CRITIC),
         "selected": True, "selection_note": "leads"}
    r.update(extra)
    return r


def _written(tmp_path):
    return json.loads((tmp_path / "ticks" / "1" / "selector" / "verdict.json").read_text())


def test_winner_inside_a_review_is_lifted(tmp_path):
    r = write_artifact(tmp_path, 1, "selector", {"reviews": [_review("prop-a-0", winner="prop-a-0")]})
    assert "error" not in r, r
    written = _written(tmp_path)
    assert written["winner"] == "prop-a-0"
    assert "winner" not in written["reviews"][0]


def test_reviews_naming_different_winners_are_left_for_the_validator(tmp_path):
    payload = {"reviews": [_review("prop-a-0", winner="prop-a-0"), _review("prop-b-1", winner="prop-b-1")]}
    assert "error" in write_artifact(tmp_path, 1, "selector", payload)
