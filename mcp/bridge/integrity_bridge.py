#!/usr/bin/env python3
"""
integrity_bridge.py — bridge between TS MCP tool and Python IntegrityGate.

Usage:
  python integrity_bridge.py \\
    --run-id <id> --node-id <nid> [--run-dir <path>]

Reads on-disk artefacts for the given node, runs IntegrityGate.check(),
writes IntegrityReport to evaluations/<node_id>.json, prints report JSON
to stdout.

Missing artefacts (goal-contract.json, frozen split, eval script) cause
the affected checks to degrade gracefully — no exception is raised.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def _stub_frozen_split(mission_id: str, eval_version: str):
    """Minimal FrozenSplit with empty hashes (checks 1,2,3 will degrade)."""
    from evor.contracts import FrozenSplit
    return FrozenSplit(
        split_id="stub",
        mission_id=mission_id,
        split_type="test",
        split_hash="",
        per_sample_hashes={},
        item_count=0,
        frozen_at=datetime.now(timezone.utc).isoformat(),
        storage_path="",
        eval_version=eval_version,
    )


def _resolve_run_dir(run_id: str) -> Path:
    """Infer run directory from EVOR_ROOT + run-id by scanning runs/<mission>/<run-id>."""
    evor_root = Path(os.environ.get("EVOR_ROOT", Path.cwd() / ".evor"))
    runs_base = evor_root / "runs"
    if runs_base.exists():
        for candidate in runs_base.iterdir():
            if candidate.is_dir():
                deep = candidate / run_id
                if deep.is_dir():
                    return deep
    return runs_base / run_id


def main() -> int:
    parser = argparse.ArgumentParser(prog="integrity_bridge")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--node-id", required=True)
    parser.add_argument(
        "--run-dir", default=None, type=Path,
        help="Explicit run directory; inferred from EVOR_ROOT + run-id if omitted",
    )
    parser.add_argument(
        "--eval-script", default=None, type=Path,
        help="Path to the canonical eval script (.py); overrides the default "
             "<run_dir>/eval-suites/<eval_version>.py",
    )
    parser.add_argument(
        "--split-path", default=None, type=Path,
        help="Path to the frozen test split JSON; tried before the default "
             "candidate list",
    )
    args = parser.parse_args()

    # ── Resolve run_dir ───────────────────────────────────────────────────────
    run_dir: Path = args.run_dir.resolve() if args.run_dir else _resolve_run_dir(args.run_id)

    # ── Load node from tree.json ──────────────────────────────────────────────
    from evor.contracts import (
        EvaluationResult, FrozenSplit, GoalContract, TreeNode,
    )

    tree_path = run_dir / "tree.json"
    node: TreeNode | None = None
    if tree_path.exists():
        try:
            tree_data = json.loads(tree_path.read_text())
            raw_nodes = tree_data.get("nodes", {})
            if isinstance(raw_nodes, dict):
                raw_node = raw_nodes.get(args.node_id)
            else:
                # list format (legacy)
                raw_node = next(
                    (n for n in raw_nodes if n.get("id") == args.node_id), None
                )
            if raw_node:
                node = TreeNode.model_validate(raw_node)
        except Exception as exc:
            print(f"[integrity_bridge] WARNING: could not load node: {exc}", file=sys.stderr)

    if node is None:
        print(json.dumps({
            "error": f"Node {args.node_id!r} not found in tree.json at {run_dir}",
            "node_id": args.node_id,
        }))
        return 1

    # ── Load EvaluationResult ─────────────────────────────────────────────────
    results_path = run_dir / "nodes" / args.node_id / "results.json"
    result: EvaluationResult | None = None
    if results_path.exists():
        try:
            result = EvaluationResult.model_validate_json(results_path.read_text())
        except Exception as exc:
            print(
                f"[integrity_bridge] WARNING: could not parse results.json: {exc}",
                file=sys.stderr,
            )

    if result is None:
        print(json.dumps({
            "error": f"results.json not found at {results_path}",
            "node_id": args.node_id,
        }))
        return 1

    # ── Load GoalContract ─────────────────────────────────────────────────────
    goal: GoalContract | None = None
    for goal_path in [
        run_dir / "goal-contract.json",
        run_dir.parent.parent / "goal.json",
    ]:
        if goal_path.exists():
            try:
                goal = GoalContract.model_validate_json(goal_path.read_text())
                break
            except Exception:
                pass

    if goal is None:
        print(json.dumps({
            "error": "goal-contract.json not found; cannot run integrity gate",
            "node_id": args.node_id,
        }))
        return 1

    # ── Load FrozenSplit (degrade gracefully if absent) ───────────────────────
    frozen_test: FrozenSplit | None = None
    frozen_dir = run_dir / "frozen-splits"
    candidates: list[Path] = []
    if args.split_path:
        candidates.append(args.split_path)
    candidates += [
        frozen_dir / f"{goal.eval_version}-test.json",  # canonical (matches freeze.py output)
        frozen_dir / "test.json",                        # legacy
        frozen_dir / "frozen-test.json",                 # legacy
    ]
    for candidate in candidates:
        if candidate.exists():
            try:
                frozen_test = FrozenSplit.model_validate_json(candidate.read_text())
                break
            except Exception:
                pass
    if frozen_test is None:
        mission_id = getattr(goal, "mission_id", "unknown") or "unknown"
        frozen_test = _stub_frozen_split(
            mission_id=mission_id, eval_version=goal.eval_version
        )

    # ── Support paths ─────────────────────────────────────────────────────────
    telemetry_path = run_dir / "nodes" / args.node_id / "telemetry.jsonl"
    # Prefer an explicitly-passed --eval-script when it actually exists; otherwise
    # fall back to the canonical <run_dir>/eval-suites/<eval_version>.py path (which
    # the downstream check treats as an eval-shift if absent).
    eval_script_path = run_dir / "eval-suites" / f"{goal.eval_version}.py"
    if args.eval_script is not None and args.eval_script.exists():
        eval_script_path = args.eval_script
    provenance_path: Path | None = run_dir / "nodes" / args.node_id / "provenance.jsonl"
    if not (provenance_path and provenance_path.exists()):
        provenance_path = None

    # ── Run gate ──────────────────────────────────────────────────────────────
    from evor.integrity import IntegrityGate

    gate = IntegrityGate()
    report = gate.check(
        node=node,
        result=result,
        goal=goal,
        telemetry_path=telemetry_path,
        eval_script_path=eval_script_path,
        frozen_test=frozen_test,
        provenance_path=provenance_path,
        run_dir=run_dir,
    )

    # ── Write to evaluations/<node_id>.json ───────────────────────────────────
    evals_dir = run_dir / "evaluations"
    evals_dir.mkdir(parents=True, exist_ok=True)
    (evals_dir / f"{args.node_id}.json").write_text(report.model_dump_json(indent=2))

    print(report.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
