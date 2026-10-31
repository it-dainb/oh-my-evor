"""Metric hardening: a mission evolves its evaluator to a STRICTER one mid-run.

The Monotonic-Honesty Invariant allows "reconcile a mis-specified guard/spec to
the contract's stated intent" and forbids softening the metric. These tests pin
both halves where they are enforced:

  * BenchmarkManager.apply_hardening — the only way a hardened EvalSuite is
    created, and the preconditions that keep it a reconciliation, not a rewrite;
  * `python -m evor run` — scores a node under the sealed PARENT evaluator too,
    so the hardened score always has its comparison beside it;
  * IntegrityGate check 15 (not_softer_than_parent) — fails a node whose
    hardened score exceeds its parent score, or that carries none.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

from evor.benchmark import (
    BenchmarkManager,
    IntegrityError,
    hardening_parent,
    sealed_script,
    split_version,
)
from evor.contracts import (
    BenchmarkUpgrade,
    EvalSuite,
    EvaluationResult,
    FrozenSplit,
    GoalContract,
    StrategyState,
    TelemetrySummary,
    TreeNode,
)
from evor.integrity import IntegrityGate

HARNESS = Path(__file__).resolve().parent.parent
MISSION = "harden-mission"
NODE = "node-harden-0001"
INTENT = "Faint strokes must be preserved: never trade ink recall for stroke-width match."

# The parent scores the number in the worktree's score.txt. A hardened evaluator
# applies a gate on top; a "softened" one inflates it — the shape the integrity
# gate exists to refuse.
PARENT_SRC = """\
import json, os
from pathlib import Path
LABEL_SEMANTICS = "foreground_is_1"
v = float(Path(os.environ["EVOR_WORKTREE"], "score.txt").read_text())
print(json.dumps({"metrics": {"accuracy": v}, "per_domain": {}, "eval_version": os.environ["EVOR_EVAL_VERSION"]}))
"""
HARDENED_SRC = PARENT_SRC.replace('{"accuracy": v}', '{"accuracy": v * 0.5}')
SOFTENED_SRC = PARENT_SRC.replace('{"accuracy": v}', '{"accuracy": min(1.0, v + 0.05)}')


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _contract() -> dict:
    return {
        "mission_id": MISSION,
        "mode": "from-scratch",
        "mission_type": "fixed",
        "task_description": f"Binarize scanned pages. {INTENT}",
        "dataset_ref": "/data/x",
        "metric_specs": [{
            "metric_name": "accuracy", "direction": "higher", "domain_applicability": "all",
            "aggregation_rule": "macro_avg", "role": "primary_fitness", "sota_bar": None,
        }],
        "fitness_mode": "aggregate",
        "eval_version": "v1",
        "baseline_value": 0.1,
        "target_value": 1.0,
        "stop_condition": {"type": "target"},
        "wildness": 0.5,
        "budget": {"max_iterations": 20, "plateau_window": 5, "circuit_breaker": 20, "max_cost_usd": 50.0},
        "locked_split_hash": "deadbeef",
        "allowed_licenses": ["MIT"],
    }


def _node(eval_version: str = "v1") -> dict:
    return {
        "id": NODE, "name": "n1-seed", "parent_ids": [], "approach_family": "arch",
        "hypothesis_id": "h1", "code_ref": "c", "genome_ref": "g", "data_version_ref": "d",
        "config": {}, "metrics": {"accuracy": 0.8}, "eval_version": eval_version,
        "fitness_value": 0.8, "integrity_status": "passed", "status": "done",
    }


@pytest.fixture()
def run_dir(tmp_path: Path) -> Path:
    rd = tmp_path / ".evor" / "runs" / MISSION / "r1"
    (rd / "eval-suites").mkdir(parents=True)
    (rd / "goal-contract.json").write_text(json.dumps(_contract(), indent=2))
    (rd / "mission-state.json").write_text(json.dumps({"status": "running"}))
    (rd / "run-state.json").write_text(json.dumps({
        "run_id": "r1", "tick_count": 4, "frontier_ids": [NODE], "current_eval_version": "v1",
    }))
    (rd / "tree.json").write_text(json.dumps({"nodes": {NODE: _node()}, "updated_at": "x"}))
    BenchmarkManager(rd).create_initial_suite(MISSION, "v1", "task", rd)
    v1 = rd / "eval-suites" / "v1.py"
    v1.write_text(PARENT_SRC)
    (rd / "eval-suites" / "v1.sealed.json").write_text(json.dumps({
        "eval_version": "v1", "hash": _sha(v1), "files": {"v1.py": _sha(v1)},
    }))
    return rd


def _harden(rd: Path, source: str = HARDENED_SRC, **kw) -> dict:
    args = dict(
        source=source,
        from_eval_version="v1", to_eval_version="v2",
        rationale="recall floor on the worst domain: S is zeroed below r_skel 0.9",
        contract_grounding="never trade ink recall for stroke-width match",
        evidence=["lesson-faint-ink-erasure", "probe@tick4"],
    )
    args.update(kw)
    return BenchmarkManager(rd).apply_hardening(**args)


# ── apply_hardening ──────────────────────────────────────────────────────────


def test_hardening_records_a_stricter_version_with_the_same_domains(run_dir: Path) -> None:
    out = _harden(run_dir, tick=4)

    suite = EvalSuite.model_validate_json((run_dir / "eval-suites" / "v2.json").read_text())
    parent = EvalSuite.model_validate_json((run_dir / "eval-suites" / "v1.json").read_text())
    assert suite.kind == "metric_hardening"
    assert suite.parent_eval_version == "v1"
    assert [d.domain_id for d in suite.domains] == [d.domain_id for d in parent.domains]
    assert suite.created_by == "policy"

    contract = json.loads((run_dir / "goal-contract.json").read_text())
    state = json.loads((run_dir / "run-state.json").read_text())
    assert contract["eval_version"] == "v2"
    assert contract["task_description"] == _contract()["task_description"], "nothing else moves"
    assert state["current_eval_version"] == "v2"

    upgrade = BenchmarkUpgrade.model_validate_json(
        (run_dir / "benchmark-upgrades" / f"{out['upgrade_id']}.json").read_text()
    )
    assert upgrade.kind == "metric_hardening"
    assert upgrade.new_domains_added == [] and upgrade.domains_removed == []
    assert upgrade.consent_granted is True, "pre-authorized by the invariant"
    assert upgrade.rescore_node_ids == [NODE] and upgrade.rescore_status == "pending"
    assert out["rescore"] == ["n1-seed"], "the agent surface is name-keyed"

    log = (run_dir / "decision-log.md").read_text()
    assert "Metric hardening" in log and '"decision_type":"harden-eval"' in log
    entry = json.loads(log.split("- entry: ", 1)[1].splitlines()[0])
    assert entry["evidence"] == ["lesson-faint-ink-erasure", "probe@tick4"]
    assert entry["rationale"].startswith("v2 hardens v1:"), "the entry names its parent"
    assert "never trade ink recall" in entry["rationale"]
    assert upgrade.proposal_citations == ["lesson-faint-ink-erasure", "probe@tick4"]
    assert (run_dir / "eval-suites" / "v1.py").read_text() == PARENT_SRC, "v1 is untouched"

    assert hardening_parent(run_dir, "v2") == "v1"
    assert hardening_parent(run_dir, "v1") is None
    assert split_version(run_dir, "v2") == "v1", "a hardening scores its parent's split"


def test_a_hardening_needs_evidence(run_dir: Path) -> None:
    with pytest.raises(IntegrityError, match="evidence"):
        _harden(run_dir, evidence=[" "])


def test_grounding_must_quote_the_contract(run_dir: Path) -> None:
    with pytest.raises(IntegrityError, match="contract_grounding"):
        _harden(run_dir, contract_grounding="maximise the leaderboard number")
    assert json.loads((run_dir / "goal-contract.json").read_text())["eval_version"] == "v1"
    assert not (run_dir / "eval-suites" / "v2.json").exists()


def test_only_the_version_in_force_is_hardened(run_dir: Path) -> None:
    _harden(run_dir)
    (run_dir / "eval-suites" / "v3.py").write_text(HARDENED_SRC)
    with pytest.raises(IntegrityError, match="current eval_version"):
        BenchmarkManager(run_dir).apply_hardening(
            from_eval_version="v1", to_eval_version="v3", rationale="x",
            contract_grounding="never trade ink recall", evidence=["probe@tick5"],
            source=HARDENED_SRC,
        )


def test_an_unsealed_parent_cannot_be_hardened(run_dir: Path) -> None:
    (run_dir / "eval-suites" / "v1.py").write_text(PARENT_SRC + "# edited after the seal\n")
    assert sealed_script(run_dir, "v1") is None
    with pytest.raises(IntegrityError, match="changed after its seal"):
        _harden(run_dir)


def test_a_version_is_created_once(run_dir: Path) -> None:
    _harden(run_dir)
    contract = json.loads((run_dir / "goal-contract.json").read_text())
    contract["eval_version"] = "v1"  # even if the contract were walked back
    (run_dir / "goal-contract.json").write_text(json.dumps(contract))
    with pytest.raises(IntegrityError, match="already exists"):
        _harden(run_dir)


def test_apply_upgrade_refuses_a_hardening_and_still_adds_domains(run_dir: Path) -> None:
    mgr = BenchmarkManager(run_dir)
    now = datetime.now(timezone.utc).isoformat()
    base = dict(
        upgrade_id="u1", mission_id=MISSION, from_eval_version="v1", to_eval_version="v2",
        proposed_by="probe", proposal_citations=[], consent_granted=True,
        new_domains_added=["handwritten"], domains_removed=[], rescore_status="pending",
        rescore_deadline_ticks=3, decision_log_ref="decision-log.md", created_at=now,
    )
    strategy = StrategyState.model_validate({
        "meta_iteration": 0, "selection_policy": "ucb1", "ucb1_c": 1.41, "wildness": 0.5,
        "family_mix": {"arch": 1.0}, "winning_families": [], "wins_by_family": {},
        "meta_loop_interval": 5, "post_upgrade_exploration_ticks": 0, "rescore_mode": "async",
        "updated_at": now,
    })
    with pytest.raises(IntegrityError, match="apply_hardening"):
        mgr.apply_upgrade(BenchmarkUpgrade(**base, kind="metric_hardening"), run_dir, None, strategy)

    suite = mgr.apply_upgrade(BenchmarkUpgrade(**base), run_dir, None, strategy)
    assert suite.kind == "domain_upgrade"
    assert "handwritten" in [d.domain_id for d in suite.domains]
    assert hardening_parent(run_dir, "v2") is None, "a domain upgrade is not a hardening"


# ── check 15: not_softer_than_parent ─────────────────────────────────────────


def _check(
    rd: Path, *, eval_version: str, fitness: float, parent: float | None, status: str = "success",
    metric: float | None = None, parent_metric: float | None = None, inputs_match: bool = True,
):
    result = EvaluationResult(
        node_id=NODE, eval_version=eval_version,
        metrics={"accuracy": fitness if metric is None else metric}, per_domain={},
        fitness_value=fitness, telemetry_summary=TelemetrySummary(total_steps=0),
        status=status, benchmark_raw="",
        **({
            "parent_eval_version": "v1", "parent_fitness_value": parent,
            "parent_metrics": {"accuracy": parent if parent_metric is None else parent_metric},
            "parent_inputs_match": inputs_match,
        } if parent is not None else {}),
    )
    goal = GoalContract.model_validate(json.loads((rd / "goal-contract.json").read_text()))
    split = FrozenSplit(
        split_id="s", mission_id=MISSION, split_type="test", split_hash="deadbeef",
        per_sample_hashes={}, item_count=0, frozen_at="x", storage_path="", eval_version="v1",
    )
    return IntegrityGate().check(
        node=TreeNode.model_validate(_node(eval_version)), result=result, goal=goal,
        telemetry_path=rd / "nope.jsonl", eval_script_path=rd / "eval-suites" / f"{eval_version}.py",
        frozen_test=split, provenance_path=None, run_dir=rd,
    )


def test_a_hardened_score_above_its_parent_fails_integrity(run_dir: Path) -> None:
    _harden(run_dir)
    report = _check(run_dir, eval_version="v2", fitness=0.85, parent=0.80)
    assert report.checks.not_softer_than_parent is False
    assert report.verdict == "failed"
    assert "not_softer_than_parent" in (report.failure_reason or "")


def test_a_hardened_score_at_or_below_its_parent_passes_the_check(run_dir: Path) -> None:
    _harden(run_dir)
    assert _check(run_dir, eval_version="v2", fitness=0.40, parent=0.80).checks.not_softer_than_parent is True
    assert _check(run_dir, eval_version="v2", fitness=0.80, parent=0.80).checks.not_softer_than_parent is True


def test_a_missing_parent_score_is_not_a_pass(run_dir: Path) -> None:
    _harden(run_dir)
    report = _check(run_dir, eval_version="v2", fitness=0.40, parent=None)
    assert report.checks.not_softer_than_parent is False
    assert "carries no 'v1' score" in (report.failure_reason or "")


def test_the_check_does_not_apply_outside_a_hardening(run_dir: Path) -> None:
    assert _check(run_dir, eval_version="v1", fitness=0.9, parent=None).checks.not_softer_than_parent is None
    _harden(run_dir)
    errored = _check(run_dir, eval_version="v2", fitness=0.0, parent=None, status="error")
    assert errored.checks.not_softer_than_parent is None


# ── the runner scores the parent beside the hardened evaluator ───────────────


def _evor_run(rd: Path, worktree: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "evor", "run", "--node-id", NODE, "--run-id", "r1",
         "--worktree", str(worktree), "--run-dir", str(rd), "--no-selfheal", *extra],
        capture_output=True, text=True, cwd=str(HARNESS), timeout=120,
    )


@pytest.mark.parametrize("source,softer", [(HARDENED_SRC, False), (SOFTENED_SRC, True)])
def test_a_rescore_under_the_hardened_version_carries_the_parent_score(
    run_dir: Path, tmp_path: Path, source: str, softer: bool,
) -> None:
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / "score.txt").write_text("0.8")
    (wt / "evaluate.py").write_text(PARENT_SRC)
    proc = _evor_run(run_dir, wt, "--eval-version", "v1")
    assert proc.returncode in (0, 4), proc.stderr
    v1_result = json.loads((run_dir / "nodes" / NODE / "results.json").read_text())

    _harden(run_dir, source=source)
    (wt / "evaluate.py").write_text(source)
    proc = _evor_run(run_dir, wt, "--eval-version", "v2")
    assert proc.returncode in (0, 4), proc.stderr

    # Evidence, not override: the v1 score survives the v2 re-score.
    nodes = run_dir / "nodes" / NODE
    for name in ("results.v1.json", "results.evaluator.v1.json"):
        kept = json.loads((nodes / name).read_text())
        assert kept["eval_version"] == "v1"
        assert kept["fitness_value"] == v1_result["fitness_value"]
    assert json.loads((nodes / "results.v2.json").read_text())["eval_version"] == "v2"

    result = EvaluationResult.model_validate_json((run_dir / "nodes" / NODE / "results.json").read_text())
    assert result.eval_version == "v2"
    assert result.parent_eval_version == "v1"
    assert result.parent_fitness_value is not None
    assert (result.fitness_value > result.parent_fitness_value) is softer
    evaluator_copy = json.loads((run_dir / "nodes" / NODE / "results.evaluator.json").read_text())
    assert evaluator_copy["parent_fitness_value"] == result.parent_fitness_value

    verdict = _check(
        run_dir, eval_version="v2", fitness=result.fitness_value, parent=result.parent_fitness_value,
    ).checks.not_softer_than_parent
    assert verdict is (not softer)


def test_the_runner_refuses_a_version_not_in_force(run_dir: Path, tmp_path: Path) -> None:
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / "score.txt").write_text("0.8")
    (wt / "evaluate.py").write_text(PARENT_SRC)
    proc = _evor_run(run_dir, wt, "--eval-version", "v2")
    assert proc.returncode == 1
    assert "not the contract's current eval_version" in proc.stderr


def test_harden_cli_reports_refusals_as_json(run_dir: Path) -> None:
    (run_dir / "eval-suites" / "v2.py").write_text(HARDENED_SRC)
    proc = subprocess.run(
        [sys.executable, "-m", "evor.benchmark", "harden", "--run-dir", str(run_dir),
         "--from-version", "v1", "--to-version", "v2", "--rationale", "gate",
         "--contract-grounding", "something the contract never said", "--evidence", "p@t1", "--stdin-source"],
        input=HARDENED_SRC,
        capture_output=True, text=True, cwd=str(HARNESS),
    )
    assert proc.returncode == 1
    assert json.loads(proc.stdout)["ok"] is False


# ── review fixes: one test per finding, each failing without its fix ─────────


PLUGIN_SRC = "def score(p, g, **k):\n    return {'f': 0.5}\n"


def _seal_v1_with_plugin(rd: Path) -> None:
    plugin = rd / "eval-suites" / "score_plugin.py"
    plugin.write_text(PLUGIN_SRC)
    v1 = rd / "eval-suites" / "v1.py"
    (rd / "eval-suites" / "v1.sealed.json").write_text(json.dumps({
        "eval_version": "v1", "hash": _sha(v1), "plugin_hash": _sha(plugin),
        "files": {"v1.py": _sha(v1), "score_plugin.py": _sha(plugin)},
    }))


def test_1_a_swapped_plugin_unseals_the_parent(run_dir: Path) -> None:
    _seal_v1_with_plugin(run_dir)
    assert sealed_script(run_dir, "v1") is not None
    (run_dir / "eval-suites" / "score_plugin.py").write_text(PLUGIN_SRC.replace("0.5", "0.99"))
    assert sealed_script(run_dir, "v1") is None, "the parent is scored only with its sealed plugin"
    with pytest.raises(IntegrityError, match="score_plugin"):
        _harden(run_dir)


def test_1_the_sealed_plugin_cannot_be_rewritten(run_dir: Path) -> None:
    from evor.eval_contract_writer import write

    _seal_v1_with_plugin(run_dir)
    out = write(run_dir, "v2", PLUGIN_SRC.replace("0.5", "0.99"), target="score_plugin")
    assert out["ok"] is False and "sealed into v1" in out["error"]
    assert (run_dir / "eval-suites" / "score_plugin.py").read_text() == PLUGIN_SRC
    assert write(run_dir, "v1", PLUGIN_SRC, target="score_plugin")["ok"] is True, "same bytes are fine"


def test_2_best_score_restarts_under_the_hardened_version(run_dir: Path) -> None:
    state = json.loads((run_dir / "run-state.json").read_text())
    state.update(best_score=0.97, best_node_id=NODE)
    (run_dir / "run-state.json").write_text(json.dumps(state))
    _harden(run_dir)
    after = json.loads((run_dir / "run-state.json").read_text())
    assert "best_score" not in after and "best_node_id" not in after
    assert "best_score under v1: 0.97" in (run_dir / "decision-log.md").read_text()


def test_2_the_primary_metric_is_bounded_not_only_fitness(run_dir: Path) -> None:
    _harden(run_dir)
    report = _check(run_dir, eval_version="v2", fitness=0.40, parent=0.80, metric=0.95, parent_metric=0.80)
    assert report.checks.not_softer_than_parent is False
    assert "accuracy 0.95" in (report.failure_reason or "")


def test_3_lower_is_better_inverts_the_bound(run_dir: Path) -> None:
    contract = json.loads((run_dir / "goal-contract.json").read_text())
    contract["metric_specs"][0]["direction"] = "lower"
    contract.pop("target_value")
    (run_dir / "goal-contract.json").write_text(json.dumps(contract))
    _harden(run_dir)
    # Lower is better: a LOWER hardened score is a softening.
    assert _check(run_dir, eval_version="v2", fitness=0.30, parent=0.50).checks.not_softer_than_parent is False
    assert _check(run_dir, eval_version="v2", fitness=0.70, parent=0.50).checks.not_softer_than_parent is True


def test_4_missing_suite_metadata_fails_closed(run_dir: Path) -> None:
    _harden(run_dir)
    (run_dir / "eval-suites" / "v2.json").unlink()
    report = _check(run_dir, eval_version="v2", fitness=0.40, parent=0.80)
    assert report.checks.not_softer_than_parent is False
    assert "missing or unreadable" in (report.failure_reason or "")
    (run_dir / "eval-suites" / "v2.json").write_text("{not json")
    assert _check(run_dir, eval_version="v2", fitness=0.4, parent=0.8).checks.not_softer_than_parent is False


@pytest.mark.parametrize("fail_at", ["decision_log", "contract"])
def test_5_adoption_is_all_or_nothing(run_dir: Path, monkeypatch, fail_at: str) -> None:
    import evor.benchmark as bm

    draft = run_dir / "eval-suites" / "v2.py"
    draft.write_text("# an unsealed draft a tick wrote earlier\n")
    before = {p.name: p.read_bytes() for p in (run_dir / "goal-contract.json", run_dir / "run-state.json")}

    def boom(*_a, **_k):
        raise OSError("disk full")

    if fail_at == "contract":
        monkeypatch.setattr(bm, "_write_contract", boom)
    else:
        monkeypatch.setattr(bm._Transaction, "append", boom)
    with pytest.raises(OSError):
        _harden(run_dir)
    for p in (run_dir / "goal-contract.json", run_dir / "run-state.json"):
        assert p.read_bytes() == before[p.name], f"{p.name} must be put back"
    assert draft.read_text() == "# an unsealed draft a tick wrote earlier\n", "nothing that existed is deleted"
    assert not (run_dir / "eval-suites" / "v2.sealed.json").exists()
    assert not (run_dir / "eval-suites" / "v2.json").exists()
    assert not list((run_dir / "benchmark-upgrades").glob("*.json"))
    assert "Metric hardening" not in ((run_dir / "decision-log.md").read_text() if (run_dir / "decision-log.md").exists() else "")


def test_6_a_presealed_version_is_adopted_only_as_the_reviewed_bytes(run_dir: Path) -> None:
    v2 = run_dir / "eval-suites" / "v2.py"
    v2.write_text(SOFTENED_SRC)
    (run_dir / "eval-suites" / "v2.sealed.json").write_text(json.dumps({
        "eval_version": "v2", "hash": _sha(v2), "files": {"v2.py": _sha(v2)},
    }))
    with pytest.raises(IntegrityError, match="different bytes"):
        _harden(run_dir, source=HARDENED_SRC)
    with pytest.raises(IntegrityError, match="reviewed hardened evaluator"):
        _harden(run_dir, source=None)
    assert _harden(run_dir, source=SOFTENED_SRC)["adopted_sealed"] is True


def test_7_a_stored_version_never_builds_a_path(run_dir: Path, tmp_path: Path) -> None:
    nodes = run_dir / "nodes" / NODE
    nodes.mkdir(parents=True)
    (nodes / "results.json").write_text(json.dumps({"eval_version": "../../../escape", "fitness_value": 1.0}))
    wt = tmp_path / "wt"
    wt.mkdir()
    (wt / "score.txt").write_text("0.8")
    (wt / "evaluate.py").write_text(PARENT_SRC)
    assert _evor_run(run_dir, wt, "--eval-version", "v1").returncode in (0, 4)
    assert not list(run_dir.parent.parent.rglob("*escape*")), "no file named by the stored version"
    with pytest.raises(IntegrityError, match="not an eval version"):
        _harden(run_dir, to_eval_version="../v2")


def test_10_a_receiptless_parent_is_told_to_verify_first(run_dir: Path) -> None:
    (run_dir / "eval-suites" / "v1.sealed.json").unlink()
    with pytest.raises(IntegrityError, match="Verify eval-suites/v1.py against the contract"):
        _harden(run_dir)


def test_11_unknown_proposer_is_refused_and_deadline_is_a_parameter(run_dir: Path) -> None:
    with pytest.raises(IntegrityError, match="proposed_by"):
        _harden(run_dir, proposed_by="mutagen")
    out = _harden(run_dir, rescore_deadline_ticks=7)
    upgrade = json.loads((run_dir / "benchmark-upgrades" / f"{out['upgrade_id']}.json").read_text())
    assert upgrade["rescore_deadline_ticks"] == 7


def test_12_a_paused_mission_is_not_hardened(run_dir: Path) -> None:
    (run_dir / "mission-state.json").write_text(json.dumps({"status": "paused"}))
    with pytest.raises(IntegrityError, match="paused, not running"):
        _harden(run_dir)


def test_open_question_inputs_must_match(run_dir: Path) -> None:
    _harden(run_dir)
    report = _check(run_dir, eval_version="v2", fitness=0.40, parent=0.80, inputs_match=False)
    assert report.checks.not_softer_than_parent is False
    assert "same inputs" in (report.failure_reason or "")


def test_open_question_frontier_order_before_is_logged(run_dir: Path) -> None:
    out = _harden(run_dir)
    assert out["frontier_order_before"] == ["n1-seed"]
    assert "frontier order under v1: n1-seed" in (run_dir / "decision-log.md").read_text()
