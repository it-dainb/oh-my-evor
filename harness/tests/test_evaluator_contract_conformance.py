"""The evaluator contract, checked across the boundaries the product crosses.

WHY THIS FILE EXISTS. `test_scaffold_evaluator.py` passes, and the feature it
covers cannot complete a mission. It passes because at both boundaries that
matter it substitutes its own version of the thing under test:

    # how the test launches the harness
    [sys.executable, str(run_dir / "eval-suites" / "v1.py"), str(split_dir), str(pred_dir)]
    # how the PRODUCT launches it — evor/evaluator.py::_build_cmd
    [sys.executable, str(eval_script)]                      # no positional args

    # how the test writes the mission-owned file
    (run_dir / "eval-suites" / SCORE_PLUGIN_FILENAME).write_text(body)
    # how an AGENT must write it
    Write/Edit → denied by PROTECTED_RUNS_RE in hooks/pre-tool-use.mjs

So the suite supplies its own argv, writes the plugin by direct filesystem call,
and hands in its own `score()` returning a constant. Each substitution hides
exactly one defect, and all three are fatal:

  1. the mission-owned file has no writer any agent can reach
  2. the generated harness exits 2 under the product's own runner
  3. the harness scores prediction FILES, so it can never measure the latency
     and VRAM gates a contract declares

A mission setup ran into all three on 2026-09-14 and could only be completed by
the operator typing `cp` — the shell being the one actor outside the hook.

The defects are downstream. The root cause is that the evaluator's interface has
no owner: `_build_cmd`, `scaffold_evaluator`, `evor_seal_eval_script` and
`skills/evor-setup/SKILL.md` each assert their own belief about argv, about what
files constitute "the evaluator", and about what it must load — and nothing makes
them agree, because no test crosses from one to another. This file is that
crossing. It is expected to FAIL until the contract has a single owner.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from evor.evaluator import _build_cmd
from evor.scaffold_evaluator import SCORE_PLUGIN_FILENAME, scaffold_evaluator


def _run(tmp_path: Path, *, gates: list[dict] | None = None) -> Path:
    """A run dir whose contract declares the gates a real mission declares."""
    run_dir = tmp_path / "run"
    (run_dir / "frozen-splits").mkdir(parents=True)
    (run_dir / "goal-contract.json").write_text(json.dumps({
        "mission_id": "m1",
        "label_semantics": "foreground_is_1",
        "fitness_mode": "worst-domain",
        "eval_version": "v1",
        "metric_specs": [{
            "metric_name": "fmeasure",
            "constraints": gates if gates is not None else [{
                "metric": "precision", "op": ">=", "threshold": 0.5,
                "scope": "per_domain", "purpose": "floor",
            }],
        }],
    }))
    (run_dir / "frozen-splits" / "v1-test.json").write_text(json.dumps({
        "item_count": 2,
        "per_sample_domains": {"a": "scan", "b": "print"},
    }))
    # The split and the predictions as they exist on disk at score time. The
    # evaluator finds these itself — no positional arguments are passed.
    split = run_dir / "frozen-splits" / "v1-test"
    split.mkdir(parents=True)
    preds = run_dir / "predictions" / "v1"
    preds.mkdir(parents=True)
    for name in ("a", "b"):
        (split / name).write_bytes(b"GT")
        (preds / name).write_bytes(b"PRED")
    return run_dir


class TestTheGeneratedEvaluatorRunsUnderTheProductRunner:
    """Break 2: argv. The existing suite invents its own and never sees this."""

    def test_the_runner_can_execute_what_the_generator_produced(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        scaffold_evaluator(run_dir)
        # A working metric, so a failure here is about the interface and nothing else.
        (run_dir / "eval-suites" / SCORE_PLUGIN_FILENAME).write_text(
            "def score(pred, gt, **kw):\n    return {'fmeasure': 0.5}\n"
        )
        eval_script = run_dir / "eval-suites" / "v1.py"

        # The product's own command builder — not a hand-rolled argv.
        cmd = _build_cmd(eval_script, run_dir, None)
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        assert out.returncode == 0, (
            "the generator and the runner disagree about argv: "
            f"rc={out.returncode} stdout={out.stdout.strip()[:200]!r}"
        )
        payload = json.loads(out.stdout.strip().splitlines()[-1])
        assert "error" not in payload, payload


class TestADeclaredGateIsNeverSilentlySkipped:
    """Break 3, correctly stated.

    A generated, framework-agnostic harness CANNOT load a model, so demanding it
    emit inference code (as the first version of this test did) asks for the
    wrong fix. Latency and VRAM are properties of the model executing.

    The contract's guarantee is narrower and achievable: a declared gate is
    either MEASURED or the shape is REFUSED. Never skipped. `_apply_gates` skips
    a constraint whose metric is None, so an evaluator that cannot measure a
    declared gate does not fail it — the run reports a pass it never earned.
    """

    LATENCY_GATES = [
        {"metric": "latency_cpu_4k_s", "op": "<", "threshold": 1.0, "scope": "all", "purpose": "floor"},
        {"metric": "vram_gb", "op": "<", "threshold": 10.0, "scope": "all", "purpose": "floor"},
    ]

    def test_the_generator_refuses_a_contract_it_cannot_measure(self, tmp_path: Path):
        run_dir = _run(tmp_path, gates=self.LATENCY_GATES)
        res = scaffold_evaluator(run_dir)

        assert "error" in res, (
            "the generator produced an evaluator for a contract gating on latency "
            "and VRAM, which it cannot measure — those gates would be skipped, "
            "not enforced"
        )
        assert res["required_shape"] == "authored"
        assert set(res["unmeasurable_metrics"]) == {"latency_cpu_4k_s", "vram_gb"}
        # And it must not leave a half-written evaluator behind to be sealed.
        assert not (run_dir / "eval-suites" / "v1.py").exists()

    def test_the_contract_names_the_shape_before_anything_is_generated(self, tmp_path: Path):
        from evor.eval_contract import SHAPE_AUTHORED, SHAPE_GENERATED, shape_for
        latency = {"metric_specs": [{"metric_name": "f", "constraints": self.LATENCY_GATES}]}
        plain = {"metric_specs": [{"metric_name": "f", "constraints": [
            {"metric": "precision", "op": ">=", "threshold": 0.5, "scope": "all", "purpose": "floor"}]}]}
        assert shape_for(latency) == SHAPE_AUTHORED
        assert shape_for(plain) == SHAPE_GENERATED


class TestTheSealCoversTheWholeEvaluator:
    """Break 4 (custody): the metric lives in a file the anchor does not cover."""

    def test_changing_the_metric_changes_what_the_seal_protects(self, tmp_path: Path):
        run_dir = _run(tmp_path)
        scaffold_evaluator(run_dir)
        plugin = run_dir / "eval-suites" / SCORE_PLUGIN_FILENAME
        plugin.write_text("def score(pred, gt, **kw):\n    return {'fmeasure': 0.1}\n")

        from evor.scaffold_evaluator import verify_harness_unmodified
        before = verify_harness_unmodified(run_dir)

        # Rewrite the metric to return a different score. The harness is untouched.
        plugin.write_text("def score(pred, gt, **kw):\n    return {'fmeasure': 0.9}\n")
        after = verify_harness_unmodified(run_dir)

        assert before != after or after.get("matches") is not True, (
            "the scoring function was replaced and custody still reports intact. "
            "The generated harness does `from score_plugin import score`, but the "
            "seal hashes only <eval_version>.py and regeneration compares only the "
            "harness — so the function that decides every score is outside the anchor "
            "whose stated purpose is that no one can shift the metric."
        )


class TestTheMissionOwnedFilesHaveAWriter:
    """Break 1: the file the design says the mission owns had no writer.

    The existing suite writes it with `Path.write_text` — substituting itself for
    the boundary an agent must cross, where PROTECTED_RUNS_RE denies Write and
    Edit for every role. So the absence of a writer was invisible. This crosses
    the real boundary: the owning tool.
    """

    def test_the_evaluator_can_be_written_through_its_owning_tool(self, tmp_path: Path):
        from evor.eval_contract_writer import write

        run_dir = _run(tmp_path)
        source = (
            "import json, os\n"
            "LABEL_SEMANTICS = os.environ.get('EVOR_LABEL_SEMANTICS', 'foreground_is_1')\n"
            "print(json.dumps({'metrics': {}, 'eval_version': 'v1'}))\n"
        )
        res = write(run_dir, "v1", source, "evaluator")
        assert res["ok"] is True, res
        assert (run_dir / "eval-suites" / "v1.py").read_text() == source

    def test_the_score_plugin_can_be_written_through_its_owning_tool(self, tmp_path: Path):
        from evor.eval_contract_writer import write

        run_dir = _run(tmp_path)
        scaffold_evaluator(run_dir)
        res = write(run_dir, "v1", "def score(pred, gt, **kw):\n    return {'fmeasure': 0.5}\n",
                    "score_plugin")
        assert res["ok"] is True, res
        # And the digest it reports covers BOTH files, not just the harness.
        assert set(res["files"]) == {"v1.py", SCORE_PLUGIN_FILENAME}

    def test_a_nonconformant_evaluator_is_refused_before_it_lands(self, tmp_path: Path):
        from evor.eval_contract_writer import write

        run_dir = _run(tmp_path)
        # The exact shape that exited 2 under the runner for every launch.
        res = write(run_dir, "v1",
                    "import sys\nsplit, pred = sys.argv[1], sys.argv[2]\nprint('{}')\n",
                    "evaluator")
        assert res["ok"] is False
        assert any("positional" in p for p in res["problems"]), res
        assert not (run_dir / "eval-suites" / "v1.py").exists(), (
            "a refused evaluator must not be left on disk to be sealed"
        )


class TestTheWholeLoopClosesWithoutAHuman:
    """The property the mission setup actually needed and did not have.

    Write the evaluator through the owning tool, then launch it through the
    product's own runner, and get a result. No `cp`, no hand-rolled argv.
    """

    def test_write_then_run_produces_a_result(self, tmp_path: Path):
        from evor.eval_contract_writer import write
        from evor.eval_contract import evaluator_digest

        run_dir = _run(tmp_path)
        # An authored evaluator that self-locates, exactly as the contract says.
        source = (
            "import json, os\n"
            "from pathlib import Path\n"
            "LABEL_SEMANTICS = 'foreground_is_1'\n"
            "run_dir = Path(os.environ.get('EVOR_RUN_DIR') or Path(__file__).resolve().parent.parent)\n"
            "split = run_dir / 'frozen-splits' / 'v1-test'\n"
            "n = len([p for p in split.iterdir() if p.is_file()])\n"
            "print(json.dumps({'metrics': {'fmeasure': 0.5}, 'scored_items': n,\n"
            "                  'eval_version': 'v1', 'label_semantics': LABEL_SEMANTICS}))\n"
        )
        assert write(run_dir, "v1", source, "evaluator")["ok"] is True

        eval_script = run_dir / "eval-suites" / "v1.py"
        out = subprocess.run(
            _build_cmd(eval_script, run_dir, None),
            capture_output=True, text=True, timeout=60,
            env={**__import__("os").environ, "EVOR_RUN_DIR": str(run_dir)},
        )
        assert out.returncode == 0, out.stderr
        payload = json.loads(out.stdout.strip().splitlines()[-1])
        assert payload["scored_items"] == 2
        assert payload["eval_version"] == "v1"

        # And the anchor covers what was written.
        digest = evaluator_digest(run_dir, "v1")
        assert digest["ok"] and "v1.py" in digest["files"]
