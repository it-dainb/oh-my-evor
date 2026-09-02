"""§2.5 — the scored-plugin split (AF2 §4.1).

Every field failure lived in the column the agent hand-wrote: polarity inverted,
latency gates applied at the wrong scope, domains never joined. All of it in a
file the mission authored from scratch every time, alongside the parts that are
identical across every mission and were re-derived by hand each time too.

The server owns the harness; the mission owns `score(pred, gt)`.

Determinism is the point rather than a nicety: the harness is a pure function of
the contract, the eval suite and the frozen index, so it can be regenerated and
byte-compared — which turns the seal from an assertion into CUSTODY.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from evor.scaffold_evaluator import (
    HARNESS_VERSION,
    SCORE_PLUGIN_FILENAME,
    scaffold_evaluator,
    verify_harness_unmodified,
)


def _run(tmp_path: Path, *, domains: bool = True, per_domain_gate: bool = False) -> Path:
    run_dir = tmp_path / "run"
    (run_dir / "frozen-splits").mkdir(parents=True)
    constraints = [{
        "metric": "precision", "op": ">=", "threshold": 0.5,
        "scope": "per_domain" if per_domain_gate else "all", "purpose": "floor",
    }]
    (run_dir / "goal-contract.json").write_text(json.dumps({
        "mission_id": "m1",
        "label_semantics": "foreground_is_1",
        "fitness_mode": "worst-domain" if domains else "aggregate",
        "metric_specs": [{"metric_name": "fmeasure", "constraints": constraints}],
    }))
    (run_dir / "frozen-splits" / "v1-test.json").write_text(json.dumps({
        "item_count": 2,
        "per_sample_domains": {"a": "scan", "b": "print"} if domains else {},
    }))
    return run_dir


class TestTheSplit:
    def test_it_generates_a_harness_and_a_plugin_stub(self, tmp_path: Path):
        res = scaffold_evaluator(_run(tmp_path))
        assert res["ok"] is True
        assert Path(res["harness_path"]).exists()
        assert Path(res["plugin_path"]).name == SCORE_PLUGIN_FILENAME
        assert res["plugin_written"] is True

    def test_the_plugin_is_the_only_thing_the_mission_writes(self, tmp_path: Path):
        res = scaffold_evaluator(_run(tmp_path))
        plugin = Path(res["plugin_path"]).read_text()
        assert "def score(" in plugin
        assert "NotImplementedError" in plugin, "the stub must not pretend to be a metric"
        # The parts that produced every field failure are NOT in the file the
        # mission edits.
        for generated_concern in ("_load_split", "_apply_gates", "_aggregate", "json.dumps"):
            assert generated_concern not in plugin

    def test_regenerating_never_destroys_the_mission_s_own_work(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        res = scaffold_evaluator(run_dir)
        Path(res["plugin_path"]).write_text("def score(pred, gt, **kw):\n    return {'fmeasure': 1.0}\n")

        again = scaffold_evaluator(run_dir)
        assert again["plugin_written"] is False
        assert "1.0" in Path(res["plugin_path"]).read_text(), (
            "regenerating the harness overwrote the mission's score function"
        )

    def test_overwrite_is_possible_but_must_be_asked_for(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        res = scaffold_evaluator(run_dir)
        Path(res["plugin_path"]).write_text("# mine\n")
        scaffold_evaluator(run_dir, overwrite_plugin=True)
        assert "# mine" not in Path(res["plugin_path"]).read_text()


class TestDeterminismIsCustody:
    """The property that makes the seal mean something (RC1 / item 2.7)."""

    def test_the_same_inputs_produce_the_same_bytes(self, tmp_path: Path):
        a = scaffold_evaluator(_run(tmp_path / "one"))
        b = scaffold_evaluator(_run(tmp_path / "two"))
        assert a["harness_sha256"] == b["harness_sha256"]

    def test_a_hand_edit_is_detected_by_regeneration(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        res = scaffold_evaluator(run_dir)
        assert verify_harness_unmodified(run_dir)["matches"] is True

        harness = Path(res["harness_path"])
        harness.write_text(harness.read_text().replace("EXPECTED_ITEM_COUNT = 2", "EXPECTED_ITEM_COUNT = 0"))

        verdict = verify_harness_unmodified(run_dir)
        assert verdict["ok"] is False
        # Caught HERE rather than at the seal, where the only evidence would be a
        # hash matching a file nobody can reproduce.
        assert "hand-edited" in verdict["error"]

    def test_a_contract_change_changes_the_harness(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        first = scaffold_evaluator(run_dir)["harness_sha256"]
        contract = json.loads((run_dir / "goal-contract.json").read_text())
        contract["label_semantics"] = "foreground_is_0"
        (run_dir / "goal-contract.json").write_text(json.dumps(contract))
        assert scaffold_evaluator(run_dir)["harness_sha256"] != first


class TestTheGeneratedHarnessBehaves:
    def _install_plugin(self, run_dir: Path, body: str) -> None:
        (run_dir / "eval-suites" / SCORE_PLUGIN_FILENAME).write_text(body)

    def _evaluate(self, run_dir: Path, tmp_path: Path, preds: dict[str, bytes]) -> dict:
        split_dir = tmp_path / "split"; split_dir.mkdir(exist_ok=True)
        pred_dir = tmp_path / "pred"; pred_dir.mkdir(exist_ok=True)
        for name in ("a", "b"):
            (split_dir / name).write_bytes(b"GT")
        for name, data in preds.items():
            (pred_dir / name).write_bytes(data)
        out = subprocess.run(
            [sys.executable, str(run_dir / "eval-suites" / "v1.py"), str(split_dir), str(pred_dir)],
            capture_output=True, text=True, timeout=60,
        )
        assert out.returncode == 0, out.stderr
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_it_scores_and_reports_per_domain(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        scaffold_evaluator(run_dir)
        self._install_plugin(run_dir, "def score(pred, gt, **kw):\n"
                                      "    return {'fmeasure': 0.8 if pred == b'GOOD' else 0.2}\n")
        res = self._evaluate(run_dir, tmp_path, {"a": b"GOOD", "b": b"BAD"})
        assert res["scored_items"] == 2
        # worst-domain fitness: the join the hand-written evaluators never did.
        assert res["metrics"]["fmeasure"] == pytest.approx(0.2)
        assert set(res["per_domain"]) == {"scan", "print"}
        assert res["harness_version"] == HARNESS_VERSION

    def test_it_refuses_a_split_that_is_not_the_frozen_one(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        scaffold_evaluator(run_dir)
        self._install_plugin(run_dir, "def score(pred, gt, **kw):\n    return {'fmeasure': 1.0}\n")

        split_dir = tmp_path / "wrong"; split_dir.mkdir()
        (split_dir / "only-one").write_bytes(b"GT")   # 1 item, frozen said 2
        pred_dir = tmp_path / "p"; pred_dir.mkdir()
        out = subprocess.run(
            [sys.executable, str(run_dir / "eval-suites" / "v1.py"), str(split_dir), str(pred_dir)],
            capture_output=True, text=True, timeout=60,
        )
        # AF1: a freeze that captured 5 metadata files reported success, and every
        # fitness number in the run was computed against them.
        assert out.returncode != 0
        assert "expected 2" in (out.stderr + out.stdout)

    def test_gates_are_applied_from_the_contract_not_from_the_plugin(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        scaffold_evaluator(run_dir)
        self._install_plugin(run_dir, "def score(pred, gt, **kw):\n"
                                      "    return {'fmeasure': 0.9, 'precision': 0.1}\n")
        res = self._evaluate(run_dir, tmp_path, {"a": b"x", "b": b"y"})
        # Every gate change used to be an evaluator rewrite, which is why the seal
        # kept breaking for reasons that were never about the seal.
        assert res["gate_violations"], "the precision floor in the CONTRACT was not applied"
        assert "precision" in res["gate_violations"][0]

    def test_polarity_is_handed_to_the_plugin_not_guessed(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        scaffold_evaluator(run_dir)
        self._install_plugin(run_dir, "def score(pred, gt, *, label_semantics='unspecified'):\n"
                                      "    return {'fmeasure': 1.0 if label_semantics == 'foreground_is_1' else 0.0}\n")
        res = self._evaluate(run_dir, tmp_path, {"a": b"x", "b": b"y"})
        # r1 and r2 both failed on polarity. A convention the DATA has is data.
        assert res["metrics"]["fmeasure"] == pytest.approx(1.0)


class TestRefusals:
    def test_no_contract_means_no_harness(self, tmp_path: Path):
        (tmp_path / "run").mkdir()
        res = scaffold_evaluator(tmp_path / "run")
        assert "error" in res and "goal contract" in res["error"]
