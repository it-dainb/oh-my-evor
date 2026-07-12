"""
evor harness CLI — `run`, `preflight`, `validate`, `doctor`, `setup-gates`,
and `export-telemetry` subcommands.

Entry point: python -m evor <subcommand> [options]

Subcommands:
  run              — Forge's primary invocation after materialising code in
                     worktree. Loads GoalContract, verifies EVOR_TELEMETRY_PATH
                     instrumentation, submits job via ResourceScheduler,
                     supervises via SelfHealMonitor, runs EvaluatorAdapter on
                     completion, writes EvaluationResult.
                     Requires mission-state.json status=="locked" (Phase-2 gate).

  preflight        — 5-step micro-train smoke-test (spec R3 / §evor-setup).
                     Verifies environment: imports, loss decreasing, GPU active.
                     --mode env_only: skip loss_decreasing (use at setup time
                     before any candidate worktree exists).
                     Exit 0 on pass; non-zero on failure.

  setup-gates      — Run corpus-layout and config-drift gates; print JSON
                     pass/fail report. Use before committing to a training run
                     to verify the dataset split and architecture are consistent.
                     --split-dir: check image/gt pair count match.
                     --declared-arch + --checkpoint-hparams-json: detect
                     arch drift between GoalContract and a resume checkpoint.

  export-telemetry — Export wandb run data to telemetry.csv inside the given
                     job directory. Reads .wandb/history.jsonl or
                     .wandb/wandb-summary.json; no wandb package required.
                     Prints the CSV path on success or null if no wandb data.

  validate         — Contract and state validator (Phase 2). Checks goal-contract.json
                     schema, MetricSpec gameability guards (two-layer), frozen-splits,
                     tree.json DICT format, and run-state.json. Exit 0 = VALID.
                     Prints a JSON ValidationReport to stdout.

  doctor           — Environment and .evor integrity doctor (Phase 2). Checks Python,
                     torch, Node.js, env vars, tree.json format, mission-state,
                     orphan pending nodes, and frozen-split hash integrity.
                     Use --repair to auto-convert list-format tree.json to DICT.

Exit codes:
  0 — success / preflight passed / validate VALID / doctor OK
  1 — error (eval failure, import error, unrecoverable, INVALID contract)
  2 — timeout
  3 — OOM
  4 — regression
  5 — preflight failed (loss not decreasing or GPU inactive)
  6 — mission not locked (run attempted before contract was validated+locked)
"""

from __future__ import annotations

import argparse
import json
import os
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

    # validate subcommand
    val_p = sub.add_parser("validate", help="Validate goal-contract and run state")
    val_p.add_argument(
        "--run-id", required=True, metavar="RUN_DIR",
        help="Path to the run directory (.evor/runs/<mission>/<run-id>/) to validate",
    )

    # doctor subcommand
    doc_p = sub.add_parser("doctor", help="Check environment and .evor integrity")
    doc_p.add_argument(
        "--run-id", default=None, metavar="RUN_DIR",
        help="Path to the run directory to inspect (optional; omit for env-only check)",
    )
    doc_p.add_argument(
        "--repair", action="store_true",
        help="Attempt to repair obvious issues (e.g. rewrite list-format tree.json to DICT)",
    )

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
        "--evor-root", type=Path, default=None,
        help="Path to .evor/ root. Defaults to .evor/ in cwd.",
    )
    pre_p.add_argument(
        "--no-gpu-check", action="store_true",
        help="Skip GPU utilisation check (for CPU-only environments).",
    )
    pre_p.add_argument(
        "--mode", choices=["full", "env_only"], default="full",
        help=(
            "Preflight scope. 'env_only': check import_ok + gpu_active only "
            "(skip loss_decreasing — use at setup time before any candidate "
            "worktree is materialised). 'full' (default): run all checks."
        ),
    )

    # setup-gates subcommand — corpus layout + config drift checks
    gates_p = sub.add_parser(
        "setup-gates",
        help="Run corpus-layout and config-drift gates; print JSON pass/fail",
    )
    gates_p.add_argument(
        "--split-dir", type=Path, default=None, metavar="SPLIT_DIR",
        help=(
            "Root of a corpus split to verify (must contain images/ and gt/ "
            "subdirectories with matching file counts)."
        ),
    )
    gates_p.add_argument(
        "--declared-arch", default=None, metavar="ARCH",
        help="Architecture name from the active GoalContract / config.",
    )
    gates_p.add_argument(
        "--checkpoint-hparams-json", default=None, metavar="JSON",
        help=(
            "Inline JSON object of checkpoint hyperparameters "
            "(e.g. '{\"arch\": \"small_unet\"}'). Required with --declared-arch."
        ),
    )

    # export-telemetry subcommand — wandb → CSV export
    export_p = sub.add_parser(
        "export-telemetry",
        help="Export wandb run data (.wandb/) to telemetry.csv inside JOB_DIR",
    )
    export_p.add_argument(
        "--job-dir", required=True, type=Path, metavar="JOB_DIR",
        help=(
            "Directory that contains (or should contain) a .wandb/ subdirectory "
            "written by the training job."
        ),
    )

    # gotchas subcommand
    got_p = sub.add_parser("gotchas", help="List accumulated gotchas and capability profile")
    got_p.add_argument(
        "--kind", default=None,
        choices=["runtime-failure", "hardware-constraint", "approach-deadend"],
        help="Filter by gotcha kind.",
    )
    got_p.add_argument(
        "--scope", default=None, choices=["global", "mission"],
        help="Filter by scope.",
    )
    got_p.add_argument(
        "--min-confidence", type=float, default=0.0,
        help="Minimum confidence threshold (0.0–1.0).",
    )
    got_p.add_argument(
        "--evor-root", type=Path, default=None,
        help="Path to .evor/ root. Defaults to .evor/ in cwd.",
    )
    got_p.add_argument(
        "--run-dir", type=Path, default=None,
        help="Path to run directory for mission-scoped gotchas.",
    )

    # capability subcommand — lightweight hardware probe + persist (no micro-train)
    cap_p = sub.add_parser(
        "capability",
        help="Probe hardware and write .evor/capability.json (+ seed hardware gotchas)",
    )
    cap_p.add_argument(
        "--evor-root", type=Path, default=None,
        help="Path to .evor/ root. Defaults to .evor/ in cwd.",
    )
    cap_p.add_argument(
        "--run-dir", type=Path, default=None,
        help="Optional run directory for mission-scoped gotcha writes.",
    )

    # distill subcommand — brownfield workspace classification and deep scan
    dist_p = sub.add_parser(
        "distill",
        help="Classify and deep-scan a workspace for brownfield onboarding",
    )
    dist_sub = dist_p.add_subparsers(dest="distill_action", required=True)

    dist_scan_p = dist_sub.add_parser(
        "scan", help="Deep-scan workspace → StartingPointReport",
    )
    dist_scan_p.add_argument(
        "--root", required=True, type=Path,
        help="Workspace root directory to scan",
    )
    dist_scan_p.add_argument(
        "--evor-root", type=Path, default=None,
        help="EVOR root (.evor/ dir). Defaults to <root>/.evor/",
    )
    dist_scan_p.add_argument(
        "--json", action="store_true",
        help="Print JSON report to stdout (default: human summary)",
    )

    dist_cls_p = dist_sub.add_parser(
        "classify", help="Fast workspace classification (globs only)",
    )
    dist_cls_p.add_argument(
        "--root", required=True, type=Path,
        help="Workspace root directory",
    )

    # init-run subcommand — write all 7 mission run artifacts
    init_p = sub.add_parser(
        "init-run",
        help="Initialise a mission run: validate GoalContract and write all 7 artifacts",
    )
    init_p.add_argument(
        "--answers", required=True, metavar="ANSWERS_JSON",
        help="Path to a JSON file containing GoalContract fields (nested models as plain dicts)",
    )
    init_p.add_argument(
        "--run-dir", default=None, metavar="RUN_DIR",
        help="Path to the run directory (default: <evor-root>/runs/<mission-id>/<run-id>)",
    )
    init_p.add_argument(
        "--run-id", default=None, metavar="RUN_ID",
        help="Run identifier (default: <mission-id>-<UTC compact timestamp>)",
    )
    init_p.add_argument(
        "--mission-id", default=None, metavar="MISSION_ID",
        help="Mission identifier (overrides answers.mission_id)",
    )
    init_p.add_argument(
        "--evor-root", type=Path, default=None,
        help="Path to .evor/ root (default: EVOR_ROOT env var or .evor in cwd)",
    )

    # signals subcommand — manage the run's SignalBus
    sig_p = sub.add_parser("signals", help="Manage the run's SignalBus")
    sig_sub = sig_p.add_subparsers(dest="signals_action", required=True)
    drain_p = sig_sub.add_parser(
        "drain",
        help="Drain signals-inbox.jsonl (hook captures) into signals.jsonl",
    )
    drain_p.add_argument(
        "--run-dir", type=Path, required=True,
        help="Path to the run directory containing signals-inbox.jsonl",
    )

    # jobs subcommand — detached training-run manager
    jobs_p = sub.add_parser("jobs", help="Detached job manager for training runs")
    jobs_sub = jobs_p.add_subparsers(dest="jobs_action", required=True)

    js_p = jobs_sub.add_parser(
        "start", help="Launch a detached job; print {job_id, status_path, log_path}",
    )
    js_p.add_argument(
        "--run-dir", required=True, type=Path,
        help="Run directory — jobs/<job_id>/ will be created inside",
    )
    js_p.add_argument(
        "--cmd-json", required=True,
        help="JSON array of the full command + args to run",
    )

    jst_p = jobs_sub.add_parser("status", help="Read jobs/<job_id>/status.json")
    jst_p.add_argument("--job-id", required=True, help="Job identifier")
    jst_p.add_argument(
        "--run-dir", required=True, type=Path,
        help="Run directory containing the jobs/ subtree",
    )

    jsv_p = jobs_sub.add_parser(
        "supervise",
        help="[internal] Run child command, capture log, flip status on exit",
    )
    jsv_p.add_argument("--job-id", required=True)
    jsv_p.add_argument("--run-dir", required=True, type=Path)
    jsv_p.add_argument(
        "--cmd-json", required=True,
        help="JSON array of the full command + args to run as child",
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

    # ── C-1 fix: infer run_dir when --run-dir is absent ───────────────
    # Forge's evor-forge.md invocation block includes --run-dir, but older
    # invocations may omit it.  Fall back to EVOR_RUN_DIR (set by
    # session-start.mjs) and then try treating --run-id as a filesystem path
    # (mirrors how _cmd_validate resolves run_dir = Path(args.run_id)).
    if run_dir is None:
        _env_run_dir = os.environ.get("EVOR_RUN_DIR")
        if _env_run_dir:
            _candidate = Path(_env_run_dir).resolve()
            if _candidate.exists():
                run_dir = _candidate
        if run_dir is None:
            _run_id_path = Path(args.run_id)
            if _run_id_path.is_dir():
                run_dir = _run_id_path.resolve()

    # ── Phase-2 lock guard ────────────────────────────────────────────
    # mission-state.json must exist and status must be "locked" before running.
    if run_dir:
        ms_path = run_dir / "mission-state.json"
        if not ms_path.exists():
            print(
                "[evor run] ERROR: mission-state.json not found. "
                "Run /evor-setup to complete contract validation and lock the mission.",
                file=sys.stderr,
            )
            return 6
        try:
            ms = json.loads(ms_path.read_text())
            ms_status = ms.get("status", "")
            if ms_status != "locked":
                print(
                    f"[evor run] ERROR: mission-state.status={ms_status!r}. "
                    "Contract must be locked before running. "
                    "Re-run /evor-setup to complete contract validation and lock the mission.",
                    file=sys.stderr,
                )
                return 6
        except Exception as exc:
            print(
                f"[evor run] WARNING: could not read mission-state.json: {exc}. "
                "Proceeding (fail-open for infra errors).",
                file=sys.stderr,
            )

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
                # DICT format {"nodes": {"id": {...}}} from TS writeTree()
                nodes_val = tree_data.get("nodes", {})
                node_data = nodes_val.get(args.node_id) if isinstance(nodes_val, dict) else None
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

    # ── Verify telemetry instrumentation in worktree trainer ─────────
    # Forge is responsible for the instrumentation before calling `python -m evor run`.
    # Required pattern: EVOR_TELEMETRY_PATH + open() (§19-clean env-path write).
    trainer_path = worktree / "train" / "trainer.py"
    if trainer_path.exists():
        trainer_src = trainer_path.read_text()
        _has_env_path = "EVOR_TELEMETRY_PATH" in trainer_src and "open(" in trainer_src
        if not _has_env_path:
            print(
                "[evor run] WARNING: no telemetry instrumentation found in train/trainer.py. "
                "Expected EVOR_TELEMETRY_PATH + open() (env-path pattern). "
                "Training will proceed but telemetry may not be recorded — "
                "Selector may reject this candidate.",
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

    # M-1 fix: derive evor_root so gotcha capture fires in real runs.
    # Pattern mirrors _cmd_preflight: run_dir is .evor/runs/<mission>/<run_id>/,
    # so evor_root = run_dir.parent.parent.parent = .evor/
    evor_root: Path | None = run_dir.parent.parent.parent if run_dir else None

    monitor = SelfHealMonitor(
        node_id=args.node_id,
        run_dir=run_dir or Path("."),
        job_spec=job_spec,
        evor_root=evor_root,
    ) if not args.no_selfheal else None

    evaluator = EvaluatorAdapter(run_dir=run_dir, evor_root=evor_root)

    env: dict[str, str] = {
        "EVOR_NODE_ID": args.node_id,
        "EVOR_RUN_ID": args.run_id,
    }
    # Export telemetry path so the candidate can append records via stdlib only (§19).
    if run_dir is not None:
        _tel_path = run_dir / "nodes" / args.node_id / "telemetry.jsonl"
        _tel_path.parent.mkdir(parents=True, exist_ok=True)
        env["EVOR_TELEMETRY_PATH"] = str(_tel_path)

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
    evor_root: Path = (
        args.evor_root.resolve() if args.evor_root
        else (run_dir.parent.parent.parent if run_dir else Path(".evor"))
    )
    scheduler = ResourceScheduler(run_dir=run_dir)

    # Probe + persist hardware capability profile
    try:
        from evor.capability import probe_capability
        cap = probe_capability(evor_root, run_dir)
        print(
            f"[evor preflight] Capability profile written to {evor_root / 'capability.json'} "
            f"(cpu_only={cap.cpu_only}, gpu_arch={cap.gpu_arch!r})",
            file=sys.stderr,
        )
    except Exception as cap_exc:
        print(f"[evor preflight] WARNING: capability probe failed: {cap_exc}", file=sys.stderr)

    report: dict = {"run_id": args.run_id, "checks": {}, "passed": False}

    try:
        checks = scheduler.preflight(run_id=args.run_id, mode=args.mode)
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

    # Evaluate overall pass/fail.
    # import_ok always gates. gpu_active gates unless --no-gpu-check.
    # loss_decreasing gates ONLY when it was actually evaluated (a candidate worktree
    # was supplied); at setup it is None (deferred to the first real training run) and
    # must NOT fail the environment smoke-test.
    checks = report["checks"]
    required = {"import_ok"}
    if not args.no_gpu_check:
        required.add("gpu_active")
    if checks.get("loss_decreasing") is not None:
        required.add("loss_decreasing")

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
# `validate` subcommand
# ─────────────────────────────────────────────────────────────────────────────

def _cmd_validate(args: argparse.Namespace) -> int:
    """Execute the validate subcommand (Phase 2).

    Validates goal-contract.json schema + gameability guards (two layers),
    frozen-splits, tree.json DICT format, and run-state.json.

    Exit 0 = VALID; exit 1 = INVALID.
    Prints a JSON ValidationReport to stdout.
    """
    from evor.validate import validate_run

    run_dir = Path(args.run_id)
    report = validate_run(run_dir)
    print(json.dumps(report.to_dict(), indent=2))

    if not report.ok:
        print(f"\n[evor validate] {report.verdict}", file=sys.stderr)
        return 1

    print(f"\n[evor validate] {report.verdict}", file=sys.stderr)
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# `doctor` subcommand
# ─────────────────────────────────────────────────────────────────────────────

def _cmd_doctor(args: argparse.Namespace) -> int:
    """Execute the doctor subcommand (Phase 2).

    Checks environment (Python, torch, Node.js, env vars, patch) and
    .evor integrity (tree.json format, mission-state, orphan pending nodes,
    frozen-split hash).  With --repair: auto-converts list-format tree.json
    to DICT format.

    Exit 0 = OK (no errors); exit 1 = errors found.
    Prints a JSON DoctorReport to stdout.
    """
    from evor.doctor import run_doctor

    run_dir = Path(args.run_id) if args.run_id else None
    report = run_doctor(run_dir=run_dir, repair=args.repair)
    print(json.dumps(report.to_dict(), indent=2))

    if not report.ok:
        print(f"\n[evor doctor] {report.verdict}", file=sys.stderr)
        return 1

    print(f"\n[evor doctor] {report.verdict}", file=sys.stderr)
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def _cmd_gotchas(args: argparse.Namespace) -> int:
    """Execute the gotchas subcommand.

    Lists accumulated gotchas and the capability profile in a readable table.
    Reads from .evor/wiki/gotchas/global.jsonl and optionally the run-scoped
    mission.jsonl.

    Exit 0 always (informational).
    """
    from evor.capability import read_capability
    from evor.gotchas import GotchaStore

    evor_root: Path = (
        args.evor_root.resolve() if args.evor_root else Path(".evor")
    )
    run_dir: Path | None = args.run_dir.resolve() if args.run_dir else None

    store = GotchaStore(evor_root, run_dir)
    gotchas = store.query_gotchas(
        kind=args.kind,
        scope=args.scope,
        min_confidence=args.min_confidence,
    )

    cap = read_capability(evor_root)

    report = {
        "capability_profile": cap.model_dump() if cap else None,
        "gotchas": [g.model_dump() for g in gotchas],
        "total": len(gotchas),
    }
    print(json.dumps(report, indent=2))
    print(
        f"\n[evor gotchas] {len(gotchas)} gotcha(s) found "
        f"(kind={args.kind!r}, scope={args.scope!r}, min_confidence={args.min_confidence})",
        file=sys.stderr,
    )
    return 0


def _cmd_capability(args: argparse.Namespace) -> int:
    """Probe hardware and persist .evor/capability.json (lightweight; no micro-train).

    Idempotent: safe to call at tick-loop startup to guarantee Mutagen/Selector have
    a hardware profile for gotcha-avoidance even when setup's preflight was skipped.
    """
    evor_root = (args.evor_root or Path(".evor")).resolve()
    run_dir = args.run_dir.resolve() if args.run_dir else None
    from evor.capability import probe_capability

    profile = probe_capability(evor_root, run_dir)
    print(
        f"[evor capability] wrote {evor_root / 'capability.json'} "
        f"(cpu_only={profile.cpu_only}, gpu_arch={profile.gpu_arch}, "
        f"dtypes={profile.supported_dtypes})"
    )
    return 0


def _cmd_distill(args: argparse.Namespace) -> int:
    """Execute the distill subcommand (classify or scan).

    Delegates to evor.distill for the actual logic so both
    ``python -m evor distill ...`` and ``python -m evor.distill ...`` work.
    """
    from evor.distill import classify_workspace, scan_workspace, _format_summary

    if args.distill_action == "classify":
        root = Path(args.root).resolve()
        wclass, counts = classify_workspace(root)
        print(json.dumps({"workspace_class": wclass, "counts": counts}))
        return 0

    if args.distill_action == "scan":
        root = Path(args.root).resolve()
        evor_root = (
            Path(args.evor_root).resolve() if args.evor_root else root / ".evor"
        )
        report = scan_workspace(root)
        try:
            evor_root.mkdir(parents=True, exist_ok=True)
            out_path = evor_root / "starting-point.json"
            out_path.write_text(report.model_dump_json(indent=2))
            print(f"[evor-distill] wrote {out_path}", file=sys.stderr)
        except (PermissionError, OSError) as exc:
            print(
                f"[evor-distill] WARNING: could not write starting-point.json: {exc}",
                file=sys.stderr,
            )
        if args.json:
            print(report.model_dump_json(indent=2))
        else:
            print(_format_summary(report))
        return 0

    return 1


def _cmd_init_run(args: argparse.Namespace) -> int:
    """Execute the init-run subcommand.

    Delegates all logic to evor.init_run.run_init_run — validates GoalContract
    and writes all 7 mission run artifacts atomically.

    Exit 0 on success; exit 1 on validation or I/O failure.
    Prints a JSON object to stdout in both cases.
    """
    from evor.init_run import run_init_run

    return run_init_run(
        args.answers,
        run_dir_arg=str(args.run_dir) if args.run_dir else None,
        run_id_arg=args.run_id,
        mission_id_arg=args.mission_id,
        evor_root_arg=str(args.evor_root) if args.evor_root else None,
    )


def _cmd_signals(args: argparse.Namespace) -> int:
    from evor.signals import SignalBus, drain_inbox  # local import — keep startup fast
    if args.signals_action == "drain":
        run_dir = Path(args.run_dir)
        if not run_dir.is_dir():
            print(json.dumps({"ok": False, "error": f"run-dir not found: {run_dir}"}))
            return 1
        bus = SignalBus(run_dir)
        count = drain_inbox(run_dir, bus)
        print(json.dumps({"ok": True, "drained": count}))
        return 0
    return 1


def _cmd_jobs(args: argparse.Namespace) -> int:
    """Dispatch jobs sub-actions to evor.jobs."""
    from evor import jobs as _jobs  # local import — keep startup fast

    if args.jobs_action == "start":
        cmd_args: list[str] = json.loads(args.cmd_json)
        run_dir = Path(args.run_dir).resolve()
        result = _jobs.start_job(cmd_args, run_dir)
        print(json.dumps(result))
        return 0

    if args.jobs_action == "status":
        run_dir = Path(args.run_dir).resolve()
        result = _jobs.status(args.job_id, run_dir)
        print(json.dumps(result))
        return 0 if result.get("state") not in ("error", "unknown") else 1

    if args.jobs_action == "supervise":
        cmd_args = json.loads(args.cmd_json)
        run_dir = Path(args.run_dir).resolve()
        return _jobs._supervise(args.job_id, run_dir, cmd_args)

    return 1


def _cmd_setup_gates(args: argparse.Namespace) -> int:
    """Execute the setup-gates subcommand.

    Runs corpus-layout and/or config-drift checks and prints a JSON report.
    At least one of --split-dir or (--declared-arch + --checkpoint-hparams-json)
    must be provided; prints an error and exits 1 otherwise.

    Exit 0 = all supplied checks passed; exit 1 = any check failed or error.
    """
    from evor.scheduler import check_config_drift, check_corpus_layout

    if not args.split_dir and not args.declared_arch:
        print(
            "[evor setup-gates] ERROR: supply at least one of "
            "--split-dir or --declared-arch (with --checkpoint-hparams-json).",
            file=sys.stderr,
        )
        return 1

    report: dict = {"checks": {}, "passed": True}
    any_failed = False

    if args.split_dir:
        split_dir = Path(args.split_dir).resolve()
        ok, detail = check_corpus_layout(split_dir)
        report["checks"]["corpus_layout"] = {"ok": ok, "detail": detail, "split_dir": str(split_dir)}
        if not ok:
            any_failed = True

    if args.declared_arch:
        if not args.checkpoint_hparams_json:
            print(
                "[evor setup-gates] ERROR: --declared-arch requires --checkpoint-hparams-json.",
                file=sys.stderr,
            )
            return 1
        try:
            hparams = json.loads(args.checkpoint_hparams_json)
        except json.JSONDecodeError as exc:
            print(
                f"[evor setup-gates] ERROR: --checkpoint-hparams-json is not valid JSON: {exc}",
                file=sys.stderr,
            )
            return 1
        ok, detail = check_config_drift(args.declared_arch, hparams)
        report["checks"]["config_drift"] = {"ok": ok, "detail": detail, "declared_arch": args.declared_arch}
        if not ok:
            any_failed = True

    report["passed"] = not any_failed
    print(json.dumps(report, indent=2))

    if any_failed:
        print("[evor setup-gates] FAILED — fix issues before starting the run.", file=sys.stderr)
        return 1

    print("[evor setup-gates] PASSED — all gates green.", file=sys.stderr)
    return 0


def _cmd_export_telemetry(args: argparse.Namespace) -> int:
    """Execute the export-telemetry subcommand.

    Reads .wandb/history.jsonl or .wandb/wandb-summary.json inside JOB_DIR
    and writes telemetry.csv there. The real wandb package is NOT required.

    Prints a JSON result to stdout:
      {"csv_path": "<path>"}  on success
      {"csv_path": null}      when no wandb data found

    Exit 0 always (wandb data is optional; absence is not an error).
    """
    from evor.telemetry import export_wandb_to_csv

    job_dir = Path(args.job_dir).resolve()
    if not job_dir.is_dir():
        print(
            f"[evor export-telemetry] ERROR: --job-dir does not exist: {job_dir}",
            file=sys.stderr,
        )
        return 1

    csv_path = export_wandb_to_csv(job_dir)

    if csv_path is not None:
        print(json.dumps({"csv_path": str(csv_path)}))
        print(f"[evor export-telemetry] wrote {csv_path}", file=sys.stderr)
    else:
        print(json.dumps({"csv_path": None}))
        print(
            f"[evor export-telemetry] no wandb data found under {job_dir}/.wandb/",
            file=sys.stderr,
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    if args.subcommand == "init-run":
        return _cmd_init_run(args)
    if args.subcommand == "run":
        return _cmd_run(args)
    if args.subcommand == "capability":
        return _cmd_capability(args)
    if args.subcommand == "preflight":
        return _cmd_preflight(args)
    if args.subcommand == "setup-gates":
        return _cmd_setup_gates(args)
    if args.subcommand == "export-telemetry":
        return _cmd_export_telemetry(args)
    if args.subcommand == "validate":
        return _cmd_validate(args)
    if args.subcommand == "doctor":
        return _cmd_doctor(args)
    if args.subcommand == "gotchas":
        return _cmd_gotchas(args)
    if args.subcommand == "signals":
        return _cmd_signals(args)
    if args.subcommand == "distill":
        return _cmd_distill(args)
    if args.subcommand == "jobs":
        return _cmd_jobs(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
