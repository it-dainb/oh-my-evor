"""The initial EvalSuite takes its domains from the frozen split.

`create_initial_suite` said it "derives a single 'primary' domain from
task_description" and did exactly that: one hardcoded domain, whatever the data.
A binarization mission whose frozen test split held 22 real domains got a suite
with one, "primary". The sealed evaluator still enforced all 22, so scores were
unaffected — but every open-ended angle and coverage number keyed off the suite
described a mission with a single domain.

The frozen split already knows the domains: `freeze.py` writes
`per_sample_domains` from the frozen samples themselves, and deliberately never
from the caller. That is the source.
"""

from __future__ import annotations

import json
from pathlib import Path

from evor.benchmark import BenchmarkManager


def _freeze(run_dir: Path, version: str, domains: dict[str, str]) -> None:
    (run_dir / "frozen-splits").mkdir(parents=True, exist_ok=True)
    (run_dir / "frozen-splits" / f"{version}-test.json").write_text(json.dumps({
        "item_count": len(domains),
        "per_sample_domains": domains,
    }))


def _suite(run_dir: Path, version: str = "v3"):
    return BenchmarkManager(run_dir).create_initial_suite(
        mission_id="m1", eval_version=version, task_description="binarize documents", run_dir=run_dir,
    )


def test_one_domain_per_distinct_domain_in_the_frozen_split(tmp_path: Path) -> None:
    _freeze(tmp_path, "v3", {
        "a.png": "palmleaf_khmer", "b.png": "palmleaf_khmer",
        "c.png": "office_print", "d.png": "dibco_2019_track_a",
    })
    suite = _suite(tmp_path)
    assert sorted(d.domain_id for d in suite.domains) == [
        "dibco_2019_track_a", "office_print", "palmleaf_khmer",
    ]


def test_domains_are_recorded_against_this_eval_version(tmp_path: Path) -> None:
    _freeze(tmp_path, "v3", {"a.png": "scan", "b.png": "print"})
    assert {d.added_at_eval_version for d in _suite(tmp_path).domains} == {"v3"}


def test_no_frozen_split_yet_falls_back_to_one_domain(tmp_path: Path) -> None:
    """Before the freeze there is nothing to derive from. One placeholder, not a crash."""
    suite = _suite(tmp_path)
    assert [d.domain_id for d in suite.domains] == ["primary"]


def test_a_split_without_domains_falls_back_to_one_domain(tmp_path: Path) -> None:
    _freeze(tmp_path, "v3", {})
    assert [d.domain_id for d in _suite(tmp_path).domains] == ["primary"]
