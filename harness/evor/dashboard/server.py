"""FastAPI dashboard server for Evor.

Reads only from the on-disk ``.evor/`` run store; never writes.

Usage::

    # Foreground (blocks):
    from evor.dashboard import serve
    serve(evor_root=".evor", port=8756)

    # Background daemon thread (non-blocking):
    from evor.dashboard import serve_in_background
    thread = serve_in_background(evor_root=".evor")

Pattern mirrors ``refs/sia/sia/web/server.py``:
``create_app(root)`` builds the app; ``serve()`` runs it; ``serve_in_background()``
starts it in a daemon thread so the orchestrator can expose a live dashboard during
a run without blocking the tick loop.
"""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Any

from ..run_status import read_run_status

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse

from evor.dashboard.store import RunStore

_STATIC_DIR = Path(__file__).parent / "static"


# ── Internal helpers ──────────────────────────────────────────────────────────


def _get_store(evor_root: Path, mission_id: str, run_id: str) -> RunStore:
    run_dir = evor_root / "runs" / mission_id / run_id
    if not run_dir.exists():
        raise HTTPException(
            status_code=404, detail=f"Run not found: {mission_id}/{run_id}"
        )
    return RunStore(run_dir)


# ── App factory ───────────────────────────────────────────────────────────────


def create_app(evor_root: str | Path) -> FastAPI:
    """Build the FastAPI application serving all runs under *evor_root*.

    *evor_root* is the ``.evor/`` directory; run directories are discovered at
    ``<evor_root>/runs/<mission_id>/<run_id>/``.
    """
    root = Path(evor_root).resolve()

    app = FastAPI(
        title="Evor Dashboard",
        description=(
            "Live evolution mission dashboard — reads the on-disk .evor/ store. "
            "Never writes."
        ),
        version="0.1.0",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )

    # ── List all runs ──────────────────────────────────────────────────────────

    @app.get("/api/runs", summary="List all missions with best-so-far summary")
    def list_runs() -> list[dict[str, Any]]:
        runs_dir = root / "runs"
        if not runs_dir.exists():
            return []
        result: list[dict[str, Any]] = []
        for mission_dir in sorted(runs_dir.iterdir()):
            if not mission_dir.is_dir():
                continue
            for run_dir in sorted(mission_dir.iterdir()):
                if not run_dir.is_dir():
                    continue
                store = RunStore(run_dir)
                state = store.run_state()
                gc = store.goal_contract()
                result.append(
                    {
                        "mission_id": mission_dir.name,
                        "run_id": run_dir.name,
                        "status": read_run_status(state),
                        "tick_count": state.get("tick_count", 0),
                        "best_score": state.get("best_score"),
                        "baseline_value": gc.get("baseline_value") if gc else None,
                        "target_value": gc.get("target_value") if gc else None,
                        "frontier_size": len(state.get("frontier_ids", [])),
                        "current_eval_version": state.get("current_eval_version"),
                        "mission_type": gc.get("mission_type") if gc else None,
                        "fitness_mode": gc.get("fitness_mode") if gc else None,
                    }
                )
        return result

    # ── Tree ──────────────────────────────────────────────────────────────────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/tree",
        summary="All TreeNode records in the evolution DAG",
    )
    def get_tree(mission_id: str, run_id: str) -> list[dict[str, Any]]:
        return _get_store(root, mission_id, run_id).all_nodes()

    # ── Frontier ──────────────────────────────────────────────────────────────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/frontier",
        summary="Best-so-far frontier nodes",
    )
    def get_frontier(mission_id: str, run_id: str) -> list[dict[str, Any]]:
        return _get_store(root, mission_id, run_id).frontier_nodes()

    # ── Strategy ──────────────────────────────────────────────────────────────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/strategy",
        summary="Current StrategyState (UCB1 params, wildness, family mix)",
    )
    def get_strategy(mission_id: str, run_id: str) -> dict[str, Any]:
        store = _get_store(root, mission_id, run_id)
        s = store.strategy()
        if s is None:
            raise HTTPException(status_code=404, detail="strategy.json not found")
        return s

    # ── Per-node detail ───────────────────────────────────────────────────────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/nodes/{node_id}",
        summary="Node detail: TreeNode + EvaluationResult + IntegrityReport",
    )
    def get_node(
        mission_id: str, run_id: str, node_id: str
    ) -> dict[str, Any]:
        store = _get_store(root, mission_id, run_id)
        nodes_by_id = {n["id"]: n for n in store.all_nodes()}
        node = nodes_by_id.get(node_id)
        if node is None:
            raise HTTPException(status_code=404, detail=f"Node not found: {node_id}")
        return {
            "node": node,
            "result": store.node_result(node_id),
            "integrity": store.integrity_report(node_id),
        }

    # ── Per-domain breakdown ──────────────────────────────────────────────────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/nodes/{node_id}/per-domain",
        summary="Per-domain metric breakdown tagged with eval_version",
    )
    def get_per_domain(
        mission_id: str, run_id: str, node_id: str
    ) -> dict[str, Any]:
        """
        Returns per_domain breakdown from results.json.  The dashboard
        refuses to display cross-version comparisons without the version label
        included here.
        """
        store = _get_store(root, mission_id, run_id)
        result = store.node_result(node_id)
        if result is None:
            raise HTTPException(
                status_code=404, detail=f"No evaluation results for node {node_id}"
            )
        per_domain: dict[str, Any] = result.get("per_domain", {})
        if not per_domain:
            raise HTTPException(
                status_code=404, detail=f"No per-domain data for node {node_id}"
            )
        return {
            "node_id": node_id,
            "eval_version": result.get("eval_version"),
            "fitness_value": result.get("fitness_value"),
            "fitness_mode": store.goal_contract().get("fitness_mode") if store.goal_contract() else None,
            "mutation_tier": None,  # enriched from TreeNode if needed by caller
            "per_domain": per_domain,
        }

    # ── Domain pivot / leaderboard ────────────────────────────────────────────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/domain-pivot",
        summary="Sorted leaderboard: all nodes × (eval_version, domain, metric)",
    )
    def get_domain_pivot(
        mission_id: str,
        run_id: str,
        metric: str = Query(..., description="Metric name to pivot on, e.g. 'accuracy'"),
        domain: str = Query(..., description="Domain ID, e.g. 'scanned'"),
        eval_version: str | None = Query(
            None,
            description=(
                "Filter to specific eval_version. "
                "Omit to default to GoalContract.eval_version (current version only)."
            ),
        ),
    ) -> list[dict[str, Any]]:
        store = _get_store(root, mission_id, run_id)
        return store.domain_pivot(metric, domain, eval_version)

    # ── Eval versions (benchmark upgrade timeline) ────────────────────────────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/eval-versions",
        summary="All EvalSuite snapshots in version order — benchmark upgrade history",
    )
    def list_eval_versions(mission_id: str, run_id: str) -> list[dict[str, Any]]:
        return _get_store(root, mission_id, run_id).eval_suites()

    # ── Coverage gauge (open_ended missions only) ─────────────────────────────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/coverage",
        summary="Coverage gauge for open_ended missions; 404 for fixed missions",
    )
    def get_coverage(mission_id: str, run_id: str) -> dict[str, Any]:
        """
        Returns::

            {
              "current_coverage": 0.5,
              "coverage_target": 0.90,
              "worst_angle_id": "handwritten",
              "per_angle": [{"angle_id": ..., "value": ..., "sota_bar": ..., "above_sota": ...}]
            }

        Returns HTTP 404 with an explanatory message for fixed missions.
        """
        store = _get_store(root, mission_id, run_id)
        gc = store.goal_contract()
        if gc is None:
            raise HTTPException(status_code=404, detail="goal-contract.json not found")
        if gc.get("mission_type") != "open_ended":
            raise HTTPException(
                status_code=404,
                detail=(
                    "Coverage endpoint is only available for open_ended missions. "
                    f"This mission has mission_type='{gc.get('mission_type')}'."
                ),
            )
        summary = store.coverage_summary()
        if summary is None:
            raise HTTPException(status_code=500, detail="Failed to compute coverage summary")
        return summary

    # ── Angle registry ────────────────────────────────────────────────────────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/angle-registry",
        summary="Full AngleRegistry including pretraining_contamination_risk flags",
    )
    def get_angle_registry(mission_id: str, run_id: str) -> dict[str, Any]:
        store = _get_store(root, mission_id, run_id)
        registry = store.angle_registry()
        if registry is None:
            raise HTTPException(status_code=404, detail="angle-registry.json not found")
        return registry

    # ── SSE: live telemetry stream ────────────────────────────────────────────

    @app.get(
        "/api/telemetry/{mission_id}/{run_id}/{node_id}",
        summary="SSE stream of TelemetryRecord lines from telemetry.jsonl",
    )
    async def stream_telemetry(
        mission_id: str,
        run_id: str,
        node_id: str,
        tail: bool = Query(
            False,
            description=(
                "When true, keep the connection open and stream new records as they "
                "arrive (live tail mode for in-progress training runs). "
                "When false (default), emit all existing records and close the stream — "
                "safe for replay and testing."
            ),
        ),
    ) -> StreamingResponse:
        """
        Server-Sent Events: emit existing telemetry.jsonl lines first, then
        optionally tail the file for new records (``?tail=true``).

        Pattern mirrors the SIA ``serve_in_background`` pattern from
        ``refs/sia/sia/web/server.py``.
        """
        store = _get_store(root, mission_id, run_id)
        tel_path = store.telemetry_path(node_id)

        async def _generate():
            if not tel_path.exists():
                yield f"data: {json.dumps({'error': 'telemetry.jsonl not found', 'node_id': node_id})}\n\n"
                return
            try:
                with open(tel_path) as fh:
                    # Emit all existing records first
                    for line in fh:
                        line = line.strip()
                        if line:
                            yield f"data: {line}\n\n"
                    if not tail:
                        # Finite replay mode: close after existing records
                        return
                    # Live tail mode: stream new records as training writes them
                    while True:
                        line = fh.readline()
                        if line and line.strip():
                            yield f"data: {line.strip()}\n\n"
                        else:
                            await asyncio.sleep(0.5)
            except (GeneratorExit, asyncio.CancelledError):
                # Client disconnected during live tail — exit cleanly
                pass

        return StreamingResponse(
            _generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    # ── Artifact download ─────────────────────────────────────────────────────

    @app.get(
        "/api/artifacts/{content_hash}",
        summary="Download a content-addressed artifact blob",
    )
    def get_artifact(content_hash: str) -> FileResponse:
        """
        Searches all run artifact stores under ``<evor_root>/runs/`` for the
        given content hash (``sha256[:2] / sha256[2:]``).
        """
        runs_dir = root / "runs"
        if runs_dir.exists():
            for mission_dir in runs_dir.iterdir():
                if not mission_dir.is_dir():
                    continue
                for run_dir in mission_dir.iterdir():
                    blob = run_dir / "artifacts" / content_hash[:2] / content_hash[2:]
                    if blob.exists():
                        return FileResponse(blob)
        raise HTTPException(status_code=404, detail=f"Artifact not found: {content_hash}")

    # ── Health + static frontend ──────────────────────────────────────────────

    @app.get("/health", summary="Server health check")
    def health() -> dict[str, str]:
        return {"status": "ok", "evor_root": str(root)}

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(_STATIC_DIR / "index.html")

    return app


# ── Blocking server ───────────────────────────────────────────────────────────


def serve(
    evor_root: str | Path = ".evor",
    host: str = "0.0.0.0",
    port: int = 8756,
    open_browser: bool = True,
) -> None:
    """Run the dashboard server in the foreground (blocks)."""
    import uvicorn

    app = create_app(evor_root)
    display_host = "localhost" if host in ("0.0.0.0", "::") else host
    url = f"http://{display_host}:{port}"
    print(f"[evor] Dashboard serving {Path(evor_root).resolve()} at {url}")
    if open_browser:
        _open_browser_after(url)
    uvicorn.run(app, host=host, port=port, log_level="info")


# ── Background daemon ─────────────────────────────────────────────────────────


def serve_in_background(
    evor_root: str | Path = ".evor",
    host: str = "127.0.0.1",
    port: int = 8756,
) -> threading.Thread | None:
    """Start the dashboard in a daemon thread; never raises if deps are missing.

    Returns the thread, or ``None`` if the server could not start.  Intended to
    give a live dashboard while the Evor tick loop is running.
    """
    try:
        import uvicorn

        app = create_app(evor_root)
    except Exception as exc:
        print(f"[evor] Live dashboard unavailable: {exc}")
        return None

    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)

    def _run() -> None:
        try:
            server.run()
        except Exception as exc:
            print(f"[evor] Live dashboard stopped: {exc}")

    thread = threading.Thread(target=_run, name="evor-dashboard", daemon=True)
    thread.start()
    print(f"[evor] Live dashboard: http://{host}:{port} (serving {Path(evor_root).resolve()})")
    return thread


def _open_browser_after(url: str, delay: float = 1.5) -> None:
    import webbrowser

    threading.Timer(delay, lambda: webbrowser.open(url)).start()
