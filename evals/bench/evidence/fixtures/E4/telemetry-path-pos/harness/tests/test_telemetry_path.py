"""Covering tests for telemetry-path. H-07: a test that was changed to accommodate
a fix is worth less than no test — the fix must be demonstrated to fail
against the OLD test for a stated reason."""
import json
from pathlib import Path

from check_under_test import check


def test_known_bad_still_fails():
    here = Path(__file__).resolve().parents[2]
    case = json.loads((here / "known_bad.json").read_text())
    spec = json.loads((here / "assertions.json").read_text())
    assert check(case, here / spec.get("data_root", ".")) is not True
