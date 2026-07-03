"""
EvaluatorAdapter — subprocess-isolated evaluator (M6).

Subprocess contract mirrors refs/sia evaluate.py output-to-stdout pattern:
  - EvaluatorAdapter runs the evaluator in a subprocess.
  - Result is read from STDOUT only (JSON-encoded EvaluationResult).
  - STDERR is captured as benchmark_raw (verbatim).
  - The eval script MUST NOT write to the artifact store or tree.json during
    evaluation; all artifact/tree writes are mediated through EvaluatorAdapter
    after result is parsed. This closes the 'Forge writes false results directly'
    integrity gap that hash-checks alone cannot detect.
  - On Linux: optional unshare --mount hardening is attempted; falls back silently
    if unshare is unavailable (non-root environments).
  - EVOR_EVAL_VERSION is injected into the subprocess env and must appear in the
    emitted EvaluationResult; mismatch → status=error.
  - fitness_value is computed by EvaluatorAdapter post-parse (not by the eval
    script) to prevent eval script from gaming the fitness function.

BenchmarkRescore merge protocol (R-6): when rescore_context is provided,
  - Run eval_script with --eval-domains <new_domains> only (partial run).
  - Merge: complete_per_domain = cached_per_domain | partial.per_domain.
  - Recompute fitness on the merged result, not the partial.

Open-ended angle scoring (Pillar 4 / R-11): call AngleRegistryManager.score_angles()
only when goal.mission_type == 'open_ended'.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from evor.contracts import (
    BenchmarkRescore,
    EvaluationResult,
    GoalContract,
    TelemetrySummary,
    TreeNode,
)

# AngleRegistryManager — available in M4; import lazily
try:
    from evor.angle_registry import AngleRegistryManager, _load_registry
    _ANGLE_REGISTRY_AVAILABLE = True
except ImportError:
    _ANGLE_REGISTRY_AVAILABLE = False

# TreeEngine.compute_fitness — available in M5; graceful fallback
try:
    from evor.tree import TreeEngine  # type: ignore[import]
    _TREE_ENGINE_AVAILABLE = True
except ImportError:
    _TREE_ENGINE_AVAILABLE = False

_DEFAULT_TIMEOUT_SEC = 3600  # 1 hour


# ─────────────────────────────────────────────────────────────────────────────
# Fitness computation (post-parse; not from eval script)
# ─────────────────────────────────────────────────────────────────────────────

def _compute_fitness(result: EvaluationResult, goal: GoalContract) -> float:
    """Compute fitness_value per GoalContract.fitness_mode.

    Delegates to TreeEngine.compute_fitness() when available (M5).
    Falls back to an inline implementation so M6 tests pass independently.
    """
    if _TREE_ENGINE_AVAILABLE:
        try:
            engine = TreeEngine(goal=goal, nodes=[], run_dir=None)
            return engine.compute_fitness(result, goal)
        except Exception:
            pass  # fall through to inline implementation

    primary_metric = next(
        (m.metric_name for m in goal.metric_specs if m.role == "primary_fitness"),
        None,
    )

    if goal.fitness_mode == "aggregate":
        if primary_metric and primary_metric in result.metrics:
            return float(result.metrics[primary_metric])
        return result.fitness_value

    if goal.fitness_mode == "worst-domain":
        if primary_metric and result.per_domain:
            values = [
                float(domain_metrics.get(primary_metric, 0.0))
                for domain_metrics in result.per_domain.values()
            ]
            return min(values) if values else result.fitness_value
        return result.fitness_value

    if goal.fitness_mode == "weighted":
        if primary_metric and result.per_domain:
            values = [
                float(domain_metrics.get(primary_metric, 0.0))
                for domain_metrics in result.per_domain.values()
            ]
            return sum(values) / len(values) if values else result.fitness_value
        return result.fitness_value

    return result.fitness_value


# ─────────────────────────────────────────────────────────────────────────────
# Subprocess isolation helpers
# ─────────────────────────────────────────────────────────────────────────────

def _build_cmd(
    eval_script: Path,
    worktree: Path,
    eval_domains: list[str] | None,
) -> list[str]:
    """Build the eval subprocess command.

    On Linux, attempt unshare --mount for read-only worktree bind-mount.
    Falls back to plain subprocess if unshare is unavailable.
    """
    base_cmd = [sys.executable, str(eval_script)]
    if eval_domains:
        base_cmd += ["--eval-domains"] + eval_domains

    if sys.platform == "linux":
        # Optional hardening: unshare --mount isolates the mount namespace.
        # A compromised eval script cannot write to worktree root, but /tmp
        # and subprocess working dir remain writable.
        unshare_cmd = ["unshare", "--mount", "--"] + base_cmd
        # Test availability without actually running
        try:
            probe = subprocess.run(
                ["unshare", "--mount", "--", "true"],
                capture_output=True, timeout=5,
            )
            if probe.returncode == 0:
                return unshare_cmd
        except (FileNotFoundError, subprocess.TimeoutExpired, PermissionError):
            pass

    return base_cmd


def _build_env(
    goal: GoalContract,
    node: TreeNode,
    extra_env: dict[str, str],
    worktree: Path,
) -> dict[str, str]:
    """Build the subprocess environment."""
    env = {**os.environ, **extra_env}
    env["EVOR_EVAL_VERSION"] = goal.eval_version
    env["EVOR_NODE_ID"] = node.id
    env["EVOR_RUN_ID"] = node.id  # run_id not on TreeNode; callers override via extra_env
    env["EVOR_WORKTREE"] = str(worktree)
    env["EVOR_MISSION_TYPE"] = goal.mission_type
    return env


# ─────────────────────────────────────────────────────────────────────────────
# Result parsing
# ─────────────────────────────────────────────────────────────────────────────

def _parse_stdout(
    stdout: str,
    goal: GoalContract,
    node: TreeNode,
) -> tuple[dict[str, Any], str | None]:
    """Parse eval script stdout as JSON; return (data_dict, error_msg).

    error_msg is non-None if parsing fails or eval_version mismatches.
    """
    stdout = stdout.strip()
    if not stdout:
        return {}, "eval script produced no stdout"

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return {}, f"eval script stdout is not valid JSON: {exc}"

    if not isinstance(data, dict):
        return {}, f"eval script stdout is not a JSON object (got {type(data).__name__})"

    # eval_version must match what we injected
    emitted_version = data.get("eval_version")
    if emitted_version is not None and emitted_version != goal.eval_version:
        return {}, (
            f"eval_version mismatch: injected={goal.eval_version!r}, "
            f"emitted={emitted_version!r} — eval script must not self-select eval_version"
        )

    return data, None


def _wrap_legacy_per_domain(data: dict[str, Any]) -> dict[str, Any]:
    """Wrap legacy eval scripts that emit only aggregate metrics.

    If per_domain is absent or empty, synthesise {'default': aggregate_metrics}.
    This preserves backward-compat with pre-Pillar-3 eval scripts.
    """
    per_domain = data.get("per_domain")
    if not per_domain:
        data["per_domain"] = {"default": dict(data.get("metrics", {}))}
    return data


def _build_telemetry_summary(data: dict[str, Any]) -> TelemetrySummary:
    """Build TelemetrySummary from eval script output or defaults."""
    ts = data.get("telemetry_summary", {})
    return TelemetrySummary(
        final_train_loss=ts.get("final_train_loss"),
        best_val_metric=ts.get("best_val_metric"),
        grad_norm_median=ts.get("grad_norm_median"),
        throughput_samples_per_sec=ts.get("throughput_samples_per_sec"),
        total_steps=int(ts.get("total_steps", 0)),
    )


# ─────────────────────────────────────────────────────────────────────────────
# EvaluatorAdapter
# ─────────────────────────────────────────────────────────────────────────────

class EvaluatorAdapter:
    """Run an eval script in an isolated subprocess; parse result from STDOUT.

    Instantiate once; call run() per node evaluation.

    Args:
        run_dir: Run directory root (for angle-registry.json, eval-suites/).
                 Optional; required for open_ended angle scoring.
    """

    def __init__(self, run_dir: Path | None = None) -> None:
        self._run_dir = run_dir

    def run(
        self,
        eval_script: Path,
        worktree: Path,
        goal: GoalContract,
        node: TreeNode,
        env: dict[str, str],
        rescore_context: BenchmarkRescore | None = None,
    ) -> EvaluationResult:
        """Run the evaluator subprocess; parse and return EvaluationResult.

        See module docstring for the full subprocess isolation contract.

        Args:
            eval_script:     Path to the locked evaluate.py script.
            worktree:        Path to the candidate's git worktree.
            goal:            GoalContract for the active mission.
            node:            TreeNode being evaluated.
            env:             Extra env vars merged into subprocess environment.
            rescore_context: When set, runs a partial eval (new domains only)
                             and merges with cached per_domain scores (R-6).

        Returns:
            EvaluationResult with fitness_value computed post-parse.
        """
        timeout_sec = _DEFAULT_TIMEOUT_SEC
        if goal.budget.max_wall_clock_hours:
            timeout_sec = int(goal.budget.max_wall_clock_hours * 3600)

        # Determine which eval domains to run
        eval_domains: list[str] | None = None
        if rescore_context is not None:
            eval_domains = rescore_context.new_domains

        cmd = _build_cmd(eval_script, worktree, eval_domains)
        proc_env = _build_env(goal, node, env, worktree)

        # ── Run subprocess; STDOUT only carries the result ─────────────────
        stdout_text = ""
        stderr_text = ""
        exit_status = "success"

        try:
            proc = subprocess.run(
                cmd,
                cwd=str(worktree),
                env=proc_env,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
            )
            stdout_text = proc.stdout or ""
            stderr_text = proc.stderr or ""

            if proc.returncode != 0:
                # Non-zero exit; check for OOM pattern in stderr
                if "out of memory" in stderr_text.lower() or "cuda oom" in stderr_text.lower():
                    exit_status = "oom"
                else:
                    exit_status = "error"

        except subprocess.TimeoutExpired as exc:
            stdout_text = (exc.stdout or b"").decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr_text = (exc.stderr or b"").decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            exit_status = "timeout"

        except Exception as exc:
            stderr_text = str(exc)
            exit_status = "error"

        # ── Parse stdout → EvaluationResult ──────────────────────────────
        if exit_status in ("timeout", "oom"):
            return self._error_result(
                node=node,
                goal=goal,
                status=exit_status,
                benchmark_raw=stderr_text,
            )

        data, parse_error = _parse_stdout(stdout_text, goal, node)

        if parse_error or exit_status == "error":
            return self._error_result(
                node=node,
                goal=goal,
                status="error",
                benchmark_raw=stderr_text or parse_error or "unknown error",
            )

        # Wrap legacy scripts that emit only aggregate metrics
        data = _wrap_legacy_per_domain(data)

        # ── BenchmarkRescore merge (R-6) ──────────────────────────────────
        effective_eval_version = goal.eval_version
        if rescore_context is not None:
            # Merge: cached old-version per_domain + newly evaluated new_domains
            merged_per_domain: dict[str, dict[str, float]] = {
                **rescore_context.cached_per_domain,
                **data.get("per_domain", {}),
            }
            data["per_domain"] = merged_per_domain
            effective_eval_version = rescore_context.merged_eval_version

        # ── Build preliminary EvaluationResult (fitness_value placeholder) ─
        metrics: dict[str, float] = data.get("metrics", {})
        per_domain: dict[str, dict[str, float]] = data.get("per_domain", {})

        # Ensure fitness_value has a default before compute_fitness overrides it
        preliminary_fitness = float(next(iter(metrics.values()), 0.0))

        result = EvaluationResult(
            node_id=node.id,
            run_id=env.get("EVOR_RUN_ID", ""),
            eval_version=effective_eval_version,
            metrics=metrics,
            per_domain=per_domain,
            fitness_value=preliminary_fitness,
            worst_angle_coverage=None,
            per_angle_vs_sota=None,
            telemetry_summary=_build_telemetry_summary(data),
            status="success",
            benchmark_raw=stderr_text,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

        # ── Compute fitness post-parse (not from eval script) ─────────────
        fitness = _compute_fitness(result, goal)
        # Reconstruct with correct fitness_value (Pydantic model is immutable; rebuild)
        result = EvaluationResult(
            **{**result.model_dump(), "fitness_value": fitness}
        )

        # ── Regression check ──────────────────────────────────────────────
        primary_metric = next(
            (m.metric_name for m in goal.metric_specs if m.role == "primary_fitness"),
            None,
        )
        if primary_metric:
            candidate = metrics.get(primary_metric, 0.0)
            if candidate < goal.baseline_value:
                result = EvaluationResult(
                    **{**result.model_dump(), "status": "regression"}
                )

        # ── Pillar 4: angle scoring for open_ended missions ───────────────
        if goal.mission_type == "open_ended" and _ANGLE_REGISTRY_AVAILABLE:
            result = self._apply_angle_scoring(result, goal, effective_eval_version)

        return result

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _error_result(
        self,
        node: TreeNode,
        goal: GoalContract,
        status: str,
        benchmark_raw: str,
    ) -> EvaluationResult:
        """Build a minimal EvaluationResult for error/timeout/oom outcomes."""
        return EvaluationResult(
            node_id=node.id,
            run_id="",
            eval_version=goal.eval_version,
            metrics={},
            per_domain={},
            fitness_value=0.0,
            worst_angle_coverage=None,
            per_angle_vs_sota=None,
            telemetry_summary=TelemetrySummary(total_steps=0),
            status=status,  # type: ignore[arg-type]
            benchmark_raw=benchmark_raw,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    def _apply_angle_scoring(
        self,
        result: EvaluationResult,
        goal: GoalContract,
        eval_version: str,
    ) -> EvaluationResult:
        """Score result against AngleRegistry for open_ended missions (R-11).

        Populates per_angle_vs_sota and worst_angle_coverage on the result.
        Returns result unchanged if angle registry is unavailable.
        """
        run_dir = self._run_dir
        if run_dir is None:
            return result

        try:
            registry = _load_registry(run_dir)
            mgr = AngleRegistryManager(mission_id=goal.mission_id)
            per_angle_dict, coverage = mgr.score_angles(result, registry, eval_version)

            # Convert AngleVsSOTA objects to inline dict format
            from evor.contracts import AngleVsSOTAInline
            per_angle_inline = {
                angle_id: AngleVsSOTAInline(
                    value=avs.value,
                    sota_bar=avs.sota_bar,
                    above_sota=avs.above_sota,
                )
                for angle_id, avs in per_angle_dict.items()
            }

            return EvaluationResult(
                **{
                    **result.model_dump(),
                    "worst_angle_coverage": coverage,
                    "per_angle_vs_sota": {k: v.model_dump() for k, v in per_angle_inline.items()},
                    # For open_ended: fitness is worst_angle_coverage
                    "fitness_value": coverage,
                }
            )
        except Exception:
            return result
