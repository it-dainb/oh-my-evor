#!/usr/bin/env python3
"""
r11_score_probe.py — test-only helper for field-trace finding R-11.

Takes a telemetry.jsonl produced by a REAL training process (one that may have
been killed mid-run) plus the step count that process was configured for, builds
an otherwise-clean set of IntegrityGate inputs around it, runs the REAL gate,
and prints the verdict as JSON.

This exists so the live lifecycle test in
``mcp/tests/wave1-environment-secrets-live-eval.test.ts`` can ask the actual
harness "would you score this?" about artifacts a real killed process left on
disk, rather than about a fabricated fixture.

Not collected by pytest: the filename does not match ``test_*.py``.

Usage:
    PYTHONPATH=harness python3 harness/tests/fixtures/r11_score_probe.py \
        --telemetry <path/to/telemetry.jsonl> --max-steps 450
"""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import sys
import tempfile
from pathlib import Path

from evor.contracts import (
    EvaluationResult,
    FrozenSplit,
    GoalContract,
    MutationLocusArch,
    TelemetrySummary,
    TreeNode,
)
from evor.freeze import _compute_split_hash
from evor.integrity import IntegrityGate


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _build_clean_inputs(work: Path):
    """Every gate input except the telemetry is deliberately clean, so the only
    thing that can fail the node is a trainer-completion check."""
    samples = {str(i): f"sample-{i}".encode() for i in range(8)}
    per_sample_hashes = {k: _sha256(v) for k, v in samples.items()}
    split_hash = _compute_split_hash(per_sample_hashes)

    split_dir = work / "frozen-splits" / "v1-test"
    split_dir.mkdir(parents=True, exist_ok=True)
    for idx, data in samples.items():
        f = split_dir / str(idx)
        f.write_bytes(data)
        f.chmod(stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)

    frozen = FrozenSplit(
        split_id="r11-probe-v1-test",
        mission_id="r11-probe",
        split_type="test",
        split_hash=split_hash,
        per_sample_hashes=per_sample_hashes,
        item_count=len(samples),
        frozen_at="2026-07-03T00:00:00Z",
        storage_path=str(work / "frozen-splits" / "v1-test.json"),
        eval_version="v1",
    )
    (work / "frozen-splits" / "v1-test.json").write_text(frozen.model_dump_json(indent=2))

    eval_script = work / "eval-suites" / "v1.py"
    eval_script.parent.mkdir(parents=True, exist_ok=True)
    eval_script.write_text("# eval")
    eval_hash = _sha256(b"# eval")

    goal = GoalContract(
        mission_id="r11-probe",
        mode="from-scratch",
        mission_type="fixed",
        task_description="R-11 completion probe",
        dataset_ref="/data/test",
        metrics=[{"name": "accuracy", "direction": "higher", "primary": True}],
        metric_specs=[{
            "metric_name": "accuracy",
            "direction": "higher",
            "domain_applicability": "all",
            "aggregation_rule": "macro_avg",
            "role": "primary_fitness",
            "sota_bar": None,
        }],
        fitness_mode="aggregate",
        eval_version="v1",
        baseline_value=0.72,
        stop_condition={"type": "target"},
        wildness=0.5,
        budget={
            "max_iterations": 50, "plateau_window": 8,
            "circuit_breaker": 5, "max_cost_usd": 0.0,
        },
        locked_split_hash=split_hash,
        eval_script_hash=eval_hash,
        allowed_licenses=["MIT", "Apache-2.0", "CC-BY-4.0"],
        created_at="2026-07-03T00:00:00Z",
    )
    return frozen, eval_script, goal


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--telemetry", required=True, type=Path)
    ap.add_argument("--max-steps", required=True, type=int)
    args = ap.parse_args(argv)

    if not args.telemetry.exists():
        print(json.dumps({"error": f"telemetry not found: {args.telemetry}"}))
        return 1

    steps_observed = sum(
        1 for line in args.telemetry.read_text(errors="replace").splitlines() if line.strip()
    )

    with tempfile.TemporaryDirectory() as td:
        work = Path(td)
        frozen, eval_script, goal = _build_clean_inputs(work)

        node = TreeNode(
            id="node-r11-probe",
            parent_ids=[],
            approach_family="arch",
            hypothesis_id="hyp-r11",
            code_ref="nodes/node-r11-probe/code/",
            genome_ref="genome-r11",
            data_version_ref="data-v1",
            config={"max_steps": args.max_steps},
            metrics={"accuracy": 0.85},
            eval_version="v1",
            lesson_ids=[],
            citations=[],
            integrity_status="pending",
            status="done",
            is_crossover=False,
            visit_count=1,
            depth=0,
            created_at="2026-07-03T00:00:00Z",
            mutation_locus=MutationLocusArch(family="arch", path="model/"),
        )
        result = EvaluationResult(
            node_id="node-r11-probe",
            run_id="run-r11",
            eval_version="v1",
            metrics={"accuracy": 0.85},
            per_domain={"default": {"accuracy": 0.85}},
            fitness_value=0.85,
            telemetry_summary=TelemetrySummary(total_steps=steps_observed),
            status="success",
            benchmark_raw="",
            timestamp="2026-07-03T02:00:00Z",
        )

        report = IntegrityGate().check(
            node=node,
            result=result,
            goal=goal,
            telemetry_path=args.telemetry,
            eval_script_path=eval_script,
            frozen_test=frozen,
            provenance_path=None,
            run_dir=work,
        )
        checks = report.checks.model_dump(exclude_none=False)

    print(json.dumps({
        "telemetry": str(args.telemetry),
        "steps_observed": steps_observed,
        "max_steps": args.max_steps,
        "trainer_ran_to_completion": steps_observed >= args.max_steps,
        "verdict": report.verdict,
        "telemetry_sane": checks.get("telemetry_sane"),
        "has_completion_check": "trainer_completed" in checks,
        "completion_check_value": checks.get("trainer_completed"),
        "checks": sorted(checks),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
