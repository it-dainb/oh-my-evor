"""Read-only on-disk store for a single Evor run directory.

All paths are derived from the ``run_dir`` passed to ``RunStore``; nothing
relies on the caller's working directory.  The store never writes.

On-disk layout under ``run_dir`` (== ``.evor/runs/<mission>/<run-id>/``)::

    tree.json                          # {"nodes": [...], "root_ids": [...], "version": 1}
    run-state.json                     # status, tick_count, best_score, frontier_ids, ...
    strategy.json                      # StrategyState
    goal-contract.json                 # GoalContract
    eval-suites/<version>.json         # EvalSuite per version
    angle-registry.json                # AngleRegistry (open_ended missions)
    nodes/<node-id>/results.json       # EvaluationResult
    nodes/<node-id>/telemetry.jsonl    # TelemetryRecord stream (append-only)
    evaluations/<node-id>.json         # IntegrityReport
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


# ── Helpers ───────────────────────────────────────────────────────────────────


def _read_json(path: Path) -> Any | None:
    """Read and parse a JSON file; return None if missing or malformed."""
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


# ── RunStore ──────────────────────────────────────────────────────────────────


class RunStore:
    """Read-only view of a single Evor run directory."""

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = run_dir.resolve()

    # ── Core run files ────────────────────────────────────────────────────────

    def goal_contract(self) -> dict[str, Any] | None:
        return _read_json(self.run_dir / "goal-contract.json")

    def run_state(self) -> dict[str, Any]:
        return _read_json(self.run_dir / "run-state.json") or {}

    def strategy(self) -> dict[str, Any] | None:
        return _read_json(self.run_dir / "strategy.json")

    # ── Tree ──────────────────────────────────────────────────────────────────

    def all_nodes(self) -> list[dict[str, Any]]:
        """All TreeNode dicts from tree.json."""
        data = _read_json(self.run_dir / "tree.json")
        if not data:
            return []
        return data.get("nodes", [])

    def frontier_nodes(self) -> list[dict[str, Any]]:
        """Nodes whose IDs appear in run-state.frontier_ids, in order."""
        frontier_ids: list[str] = self.run_state().get("frontier_ids", [])
        if not frontier_ids:
            return []
        by_id = {n["id"]: n for n in self.all_nodes()}
        return [by_id[fid] for fid in frontier_ids if fid in by_id]

    # ── Per-node data ─────────────────────────────────────────────────────────

    def node_result(self, node_id: str) -> dict[str, Any] | None:
        return _read_json(self.run_dir / "nodes" / node_id / "results.json")

    def integrity_report(self, node_id: str) -> dict[str, Any] | None:
        return _read_json(self.run_dir / "evaluations" / f"{node_id}.json")

    def telemetry_path(self, node_id: str) -> Path:
        """Absolute path to the node's telemetry.jsonl (may not exist yet)."""
        return self.run_dir / "nodes" / node_id / "telemetry.jsonl"

    # ── Eval suites ───────────────────────────────────────────────────────────

    def eval_suites(self) -> list[dict[str, Any]]:
        """All EvalSuite snapshots sorted lexicographically by filename (v1 < v2 …)."""
        suites_dir = self.run_dir / "eval-suites"
        if not suites_dir.exists():
            return []
        suites = []
        for p in sorted(suites_dir.glob("*.json")):
            data = _read_json(p)
            if data is not None:
                suites.append(data)
        return suites

    # ── Angle registry (open_ended) ───────────────────────────────────────────

    def angle_registry(self) -> dict[str, Any] | None:
        return _read_json(self.run_dir / "angle-registry.json")

    # ── Coverage summary (open_ended) ─────────────────────────────────────────

    def coverage_summary(self) -> dict[str, Any] | None:
        """
        Compute coverage from the best frontier node's per_angle_vs_sota.
        Returns None if goal-contract is missing or mission_type != 'open_ended'.
        """
        gc = self.goal_contract()
        if gc is None or gc.get("mission_type") != "open_ended":
            return None

        coverage_target: float = gc.get("coverage_target") or 0.80
        frontier = self.frontier_nodes()
        per_angle: list[dict[str, Any]] = []
        worst_angle_id: str | None = None
        current_coverage: float = 0.0

        if frontier:
            best = max(frontier, key=lambda n: (n.get("fitness_value") or 0.0))
            result = self.node_result(best["id"])
            if result and result.get("per_angle_vs_sota"):
                raw: dict[str, dict[str, Any]] = result["per_angle_vs_sota"]
                above_count = 0
                worst_score = float("inf")
                for angle_id, entry in raw.items():
                    value = float(entry.get("value", 0.0))
                    per_angle.append(
                        {
                            "angle_id": angle_id,
                            "value": value,
                            "sota_bar": entry.get("sota_bar", 0.0),
                            "above_sota": bool(entry.get("above_sota", False)),
                        }
                    )
                    if entry.get("above_sota"):
                        above_count += 1
                    if value < worst_score:
                        worst_score = value
                        worst_angle_id = angle_id
                if per_angle:
                    current_coverage = above_count / len(per_angle)

        return {
            "current_coverage": current_coverage,
            "coverage_target": coverage_target,
            "worst_angle_id": worst_angle_id,
            "per_angle": per_angle,
        }

    # ── Domain pivot ──────────────────────────────────────────────────────────

    def domain_pivot(
        self,
        metric: str,
        domain: str,
        eval_version: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Sorted leaderboard: all nodes × (eval_version, domain, metric).

        If *eval_version* is None, defaults to the current version in the
        GoalContract.  Nodes that lack per_domain[domain][metric] are omitted.
        """
        gc = self.goal_contract()
        active_version = eval_version or (gc.get("eval_version") if gc else None)

        rows: list[dict[str, Any]] = []
        for node in self.all_nodes():
            node_ev = node.get("eval_version")
            if active_version and node_ev != active_version:
                continue
            result = self.node_result(node["id"])
            if result is None:
                continue
            domain_metrics: dict[str, float] = result.get("per_domain", {}).get(domain, {})
            value = domain_metrics.get(metric)
            if value is None:
                continue
            rows.append(
                {
                    "node_id": node["id"],
                    "eval_version": node_ev,
                    "approach_family": node.get("approach_family"),
                    "fitness_value": node.get("fitness_value"),
                    "domain": domain,
                    "metric": metric,
                    "value": value,
                    "integrity_status": node.get("integrity_status"),
                }
            )

        rows.sort(key=lambda r: r["value"], reverse=True)
        return rows
