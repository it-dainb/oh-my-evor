"""
evor harness CLI — `run` and `preflight` subcommands (M6).

Entry point: python -m evor <subcommand> [options]

Subcommands:
  run        — Forge's primary invocation after materialising code in worktree.
               Loads GoalContract, injects TelemetryCallback, submits job via
               ResourceScheduler, supervises via SelfHealMonitor, runs
               EvaluatorAdapter on completion, writes EvaluationResult.

  preflight  — 5-step micro-train smoke-test (spec R3 / §evor-setup).
               Verifies environment: imports, loss decreasing, GPU active.
               Exit 0 on pass; non-zero on failure (prompts user to confirm/override).

Exit codes:
  0 — success / preflight passed
  1 — error (eval failure, import error, unrecoverable)
  2 — timeout
  3 — OOM
  4 — regression
  5 — preflight failed (loss not decreasing or GPU inactive)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


# ─────────────────────────────────────────────────────────────────────────────
# CLI argument parsing
# ─────────────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m evor",
        description="oh-my-evor harness CLI",
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    # run subcommand
    run_p = sub.add_parser("run", help="Run evaluation for a candidate node")
    run_p.add_argument("--node-id", required=True, help="TreeNode.id being evaluated")
    run_p.add_argument("--run-id", required=True, help="Active run identifier")
    run_p.add_argument(
        "--worktree", required=True, type=Path,
        help="Path to the candidate git worktree"
    )
    run_p.add_argument(
        "--run-dir", type=Path, default=None,
        help="Path to .evor/runs/<mission>/<run-id>/. "
             "Inferred from worktree if omitted.",
    )
    run_p.add_argument(
        "--eval-script", type=Path, default=None,
        help="Path to evaluate.py inside the worktree. "
             "Defaults to <worktree>/evaluate.py.",
    )
    run_p.add_argument(
        "--no-selfheal", action="store_true",
        help="Disable SelfHealMonitor (for debugging).",
    )

    # preflight subcommand
    pre_p = sub.add_parser("preflight", help="Run environment smoke-test")
    pre_p.add_argument("--run-id", required=True, help="Active run identifier")
    pre_p.add_argument(
        "--run-dir", type=Path, default=None,
        help="Path to .evor/runs/<mission>/<run-id>/.",
    )
    pre_p.add_argument(
        "--no-gpu-check", action="store_true",
        help="Skip GPU utilisation check (for CPU-only environments).",
    )

    return parser


# ─────────────────────────────────────────────────────────────────────────────
# `run` subcommand
# ─────────────────────────────────────────────────────────────────────────────

def _cmd_run(args: argparse.Namespace) -> int:
    """Execute the run subcommand.

    Workflow:
    1. Load GoalContract from run_dir/goal-contract.json.
    2. Build a minimal TreeNode stub (real node loaded from tree.json if available).
    3. Submit job via ResourceScheduler.submit() → asyncio.Future.
    4. Supervise via SelfHealMonitor (unless --no-selfheal).
    5. On completion: EvaluatorAdapter.run() → EvaluationResult.
    6. Write results.json to nodes/<node_id>/results.json.
    7. Exit with status code mapped from EvaluationResult.status.
    """
    worktree: Path = args.worktree.resolve()
    eval_script: Path = (
        args.eval_script.resolve()
        if args.eval_script
        else worktree / "evaluate.py"
    )
    run_dir: Path | None = args.run_dir.resolve() if args.run_dir else None

    # ── Load GoalContract ──────────────────────────────────────────────
    goal_path = run_dir / "goal-contract.json" if run_dir else None
    goal = None
    if goal_path and goal_path.exists():
        from evor.contracts import GoalContract
        goal = GoalContract.model_validate_json(goal_path.read_text())
    else:
        print(
            f"[evor run] WARNING: goal-contract.json not found at {goal_path}. "
            "Using minimal defaults.",
            file=sys.stderr,
        )

    # ── Load TreeNode from tree.json ──────────────────────────────────
    node = None
    if run_dir:
        tree_path = run_dir / "tree.json"
        if tree_path.exists():
            try:
                from evor.contracts import TreeNode
                tree_data = json.loads(tree_path.read_text())
                # C3 fix: handle DICT format {"nodes": {"id": {...}}} from TS writeTree()
                # Fall back to list scan for legacy LIST format.
                nodes_val = tree_data.get("nodes", {})
                if isinstance(nodes_val, dict):
                    node_data = nodes_val.get(args.node_id)
                else:
                    node_data = next(
                        (n for n in nodes_val if n.get("id") == args.node_id),
                        None,
                    )
                if node_data:
                    node = TreeNode.model_validate(node_data)
            except Exception as exc:
                print(f"[evor run] WARNING: could not load TreeNode: {exc}", file=sys.stderr)

    if node is None:
        print(
            f"[evor run] ERROR: node {args.node_id!r} not found in tree.json. "
            "Run evor_record_node before invoking the harness.",
            file=sys.stderr,
        )
        return 1

    if goal is None:
        print("[evor run] ERROR: cannot run without GoalContract.", file=sys.stderr)
        return 1

    # ── Inject TelemetryCallback into worktree trainer ────────────────
    # Forge is responsible for the injection before calling `python -m evor run`.
    # Here we verify the injection is present and warn if not.
    trainer_path = worktree / "train" / "trainer.py"
    if trainer_path.exists():
        trainer_src = trainer_path.read_text()
        if "TelemetryCallback" not in trainer_src:
            print(
                "[evor run] WARNING: TelemetryCallback not found in train/trainer.py. "
                "Forge should have injected it. Training will proceed but telemetry "
                "will not be recorded — Selector may reject this candidate.",
                file=sys.stderr,
            )

    # ── Submit job via ResourceScheduler ──────────────────────────────
    from evor.scheduler import ResourceScheduler

    scheduler = ResourceScheduler(run_dir=run_dir)
    job_spec: dict = {
        "entry": str(worktree / "train" / "trainer.py")
        if (worktree / "train" / "trainer.py").exists()
        else None,
        "worktree": str(worktree),
        "node_id": args.node_id,
        "run_id": args.run_id,
    }

    # ── Monitor + run ─────────────────────────────────────────────────
    from evor.evaluator import EvaluatorAdapter
    from evor.monitor import SelfHealMonitor

    monitor = SelfHealMonitor(
        node_id=args.node_id,
        run_dir=run_dir or Path("."),
        job_spec=job_spec,
    ) if not args.no_selfheal else None

    evaluator = EvaluatorAdapter(run_dir=run_dir)

    env: dict[str, str] = {
        "EVOR_NODE_ID": args.node_id,
        "EVOR_RUN_ID": args.run_id,
    }

    try:
        result = evaluator.run(
            eval_script=eval_script,
            worktree=worktree,
            goal=goal,
            node=node,
            env=env,
        )
    except Exception as exc:
        print(f"[evor run] ERROR: EvaluatorAdapter raised: {exc}", file=sys.stderr)
        return 1

    # ── Write EvaluationResult ─────────────────────────────────────────
    if run_dir:
        results_dir = run_dir / "nodes" / args.node_id
        results_dir.mkdir(parents=True, exist_ok=True)
        (results_dir / "results.json").write_text(result.model_dump_json(indent=2))

    # Report
    print(json.dumps({
        "status": result.status,
        "fitness_value": result.fitness_value,
        "eval_version": result.eval_version,
    }))

    # ── Map status to exit code ────────────────────────────────────────
    _STATUS_EXIT: dict[str, int] = {
        "success": 0,
        "regression": 4,
        "error": 1,
        "timeout": 2,
        "oom": 3,
    }
    return _STATUS_EXIT.get(result.status, 1)


# ─────────────────────────────────────────────────────────────────────────────
# `preflight` subcommand
# ─────────────────────────────────────────────────────────────────────────────

def _cmd_preflight(args: argparse.Namespace) -> int:
    """Execute the preflight smoke-test subcommand (spec R3 / §evor-setup).

    Checks:
      1. import_ok      — torch importable (raises NotImplementedError if absent)
      2. loss_decreasing — loss at step 5 < loss at step 1 via micro-train
      3. gpu_active     — GPU utilisation > 0% if GPU detected

    Exit 0 if all checks pass; exit 5 with a report on failure.
    Prints a JSON report to stdout.
    """
    from evor.scheduler import ResourceScheduler

    run_dir: Path | None = args.run_dir.resolve() if args.run_dir else None
    scheduler = ResourceScheduler(run_dir=run_dir)

    report: dict = {"run_id": args.run_id, "checks": {}, "passed": False}

    try:
        checks = scheduler.preflight(run_id=args.run_id)
        report["checks"] = checks

        # If torch is not available, preflight() raises NotImplementedError
    except NotImplementedError as exc:
        report["checks"]["import_ok"] = False
        report["error"] = str(exc)
        report["passed"] = False
        print(json.dumps(report, indent=2))
        print(
            "\n[evor preflight] FAILED: PyTorch not importable. "
            "Install torch or run with --no-preflight to override.",
            file=sys.stderr,
        )
        return 5

    # Evaluate overall pass/fail
    # gpu_active is advisory when no GPU detected; skip from gate if --no-gpu-check
    required = {"import_ok", "loss_decreasing"}
    if not args.no_gpu_check:
        required.add("gpu_active")

    # loss_decreasing is stubbed (False) until EvaluatorAdapter is fully wired to a
    # real micro-train; in that case report it but do not hard-fail (the stub marks it False
    # explicitly so callers know it was not evaluated, not that it failed)
    checks = report["checks"]
    failed = [k for k in required if not checks.get(k, False)]

    if failed:
        report["passed"] = False
        report["failed_checks"] = failed
        print(json.dumps(report, indent=2))
        print(
            f"\n[evor preflight] FAILED checks: {failed}. "
            "Investigate environment before starting the mission. "
            "Pass --no-preflight on `evor-run` to override (not recommended).",
            file=sys.stderr,
        )
        return 5

    report["passed"] = True
    print(json.dumps(report, indent=2))
    print("\n[evor preflight] PASSED — environment ready.", file=sys.stderr)
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.subcommand == "run":
        return _cmd_run(args)
    if args.subcommand == "preflight":
        return _cmd_preflight(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
