"""FastAPI dashboard server for Evor.

Reads the on-disk ``.evor/`` run store. The one write is ``POST .../steer``,
which appends a single ``human-steer`` line to the run's ``signals-inbox.jsonl``
(the inbox the tick loop drains); it can be switched off with
``allow_steer=False``.

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

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse

from evor.dashboard.insights import SIGNAL_AXES, RunInsights, append_steer
from evor.dashboard.store import RunStore

_STATIC_DIR = Path(__file__).parent / "static"


# ── Internal helpers ──────────────────────────────────────────────────────────


def _get_store(evor_root: Path, mission_id: str, run_id: str) -> RunStore:
    runs = (evor_root / "runs").resolve()
    run_dir = (runs / mission_id / run_id).resolve()
    # Both segments must name a directory exactly two levels under runs/.
    if run_dir.parent.parent != runs or not run_dir.is_dir():
        raise HTTPException(
            status_code=404, detail=f"Run not found: {mission_id}/{run_id}"
        )
    return RunStore(run_dir)


# ── App factory ───────────────────────────────────────────────────────────────


def create_app(
    evor_root: str | Path,
    default_run_dir: str | Path | None = None,
    allow_steer: bool = True,
) -> FastAPI:
    """Build the FastAPI application serving all runs under *evor_root*.

    *evor_root* is the ``.evor/`` directory; run directories are discovered at
    ``<evor_root>/runs/<mission_id>/<run_id>/``. *default_run_dir* marks the run
    the page opens on; *allow_steer* enables the steer inbox endpoint.
    """
    root = Path(evor_root).resolve()
    default_run = Path(default_run_dir).resolve() if default_run_dir else None

    def _insights(mission_id: str, run_id: str) -> RunInsights:
        store = _get_store(root, mission_id, run_id)
        return RunInsights(store.run_dir, evor_root=root)

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
                        "default": default_run is not None and run_dir.resolve() == default_run,
                    }
                )
        return result

    # ── Researcher views: progress, recipes, alerts, timeline, learnings ──────

    @app.get(
        "/api/runs/{mission_id}/{run_id}/bundle",
        summary="Everything the main view needs in one payload",
    )
    def get_bundle(mission_id: str, run_id: str) -> dict[str, Any]:
        b = _insights(mission_id, run_id).bundle()
        b["steer_enabled"] = allow_steer
        return b

    @app.get("/api/runs/{mission_id}/{run_id}/overview", summary="'Right path?' verdict, robust best, best node")
    def get_overview(mission_id: str, run_id: str) -> dict[str, Any]:
        ins = _insights(mission_id, run_id)
        return {"overview": ins.overview(), "progress": ins.progress()}

    @app.get("/api/runs/{mission_id}/{run_id}/points", summary="One figure point per evaluated node, with lineage")
    def get_points(mission_id: str, run_id: str) -> dict[str, Any]:
        ins = _insights(mission_id, run_id)
        return {"metrics": ins.metric_specs(), "baseline": ins.primary_metric()["baseline"], "points": ins.points()}

    @app.get("/api/runs/{mission_id}/{run_id}/recipes", summary="Seed siblings grouped into recipes with median, spread and verdict")
    def get_recipes(mission_id: str, run_id: str) -> list[dict[str, Any]]:
        return _insights(mission_id, run_id).recipes()

    @app.get("/api/runs/{mission_id}/{run_id}/alerts", summary="Health alerts: gaming, seed spread, integrity, plateau, stall")
    def get_alerts(mission_id: str, run_id: str) -> list[dict[str, Any]]:
        return _insights(mission_id, run_id).alerts()

    @app.get("/api/runs/{mission_id}/{run_id}/timeline", summary="Per-tick plain-language account of every artifact")
    def get_timeline(mission_id: str, run_id: str) -> list[dict[str, Any]]:
        return _insights(mission_id, run_id).timeline()

    @app.get("/api/runs/{mission_id}/{run_id}/learnings", summary="What the run has learned: lessons, artefacts, gotchas, decisions")
    def get_learnings(mission_id: str, run_id: str) -> dict[str, Any]:
        return _insights(mission_id, run_id).learnings()

    @app.get("/api/runs/{mission_id}/{run_id}/nodes/{node_id}/evidence", summary="Node drill-down: makeup, per-domain vs parent, telemetry, samples")
    def get_evidence(mission_id: str, run_id: str, node_id: str) -> dict[str, Any]:
        ev = _insights(mission_id, run_id).node_evidence(node_id)
        if ev is None:
            raise HTTPException(status_code=404, detail=f"Node not found: {node_id}")
        return ev

    @app.get("/api/runs/{mission_id}/{run_id}/nodes/{node_id}/samples/{name:path}", summary="A sample image stored with the node")
    def get_sample(mission_id: str, run_id: str, node_id: str, name: str) -> FileResponse:
        p = _insights(mission_id, run_id).sample_path(node_id, name)
        if p is None:
            raise HTTPException(status_code=404, detail="Sample not found")
        return FileResponse(p)

    # ── Steer inbox ────────────────────────────────────────────────────────────

    @app.get("/api/runs/{mission_id}/{run_id}/steer", summary="Human steer notes and whether a tick has drained them")
    def get_steer(mission_id: str, run_id: str) -> dict[str, Any]:
        ins = _insights(mission_id, run_id)
        return {"enabled": allow_steer, "axes": list(SIGNAL_AXES), "notes": ins.steer_notes()}

    @app.post("/api/runs/{mission_id}/{run_id}/steer", summary="Append a human-steer note to the run's signals inbox", status_code=201)
    def post_steer(
        mission_id: str,
        run_id: str,
        request: Request,
        payload: dict[str, Any] = Body(..., examples=[{"note": "Stop tuning ckpt selection; test a recall floor in the loss.", "author": "dai"}]),
    ) -> dict[str, Any]:
        if not allow_steer:
            raise HTTPException(status_code=403, detail="Steering is disabled on this dashboard")
        # Cross-site guard: a page on another origin must not be able to post
        # notes into the run's inbox through a researcher's browser.
        origin = request.headers.get("origin")
        if origin:
            from urllib.parse import urlparse

            if urlparse(origin).netloc != request.headers.get("host", ""):
                raise HTTPException(status_code=403, detail="Cross-origin steer rejected")
        store = _get_store(root, mission_id, run_id)
        try:
            line = append_steer(
                store.run_dir,
                note=str(payload.get("note") or ""),
                author=str(payload.get("author") or ""),
                axis=str(payload.get("axis") or "accuracy"),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"ok": True, "line": line}

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
    default_run_dir: str | Path | None = None,
    allow_steer: bool = True,
) -> None:
    """Run the dashboard server in the foreground (blocks)."""
    import uvicorn

    app = create_app(evor_root, default_run_dir=default_run_dir, allow_steer=allow_steer)
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


# ── ``uvicorn evor.dashboard.server:app`` ─────────────────────────────────────


def _app_from_env() -> FastAPI:
    """Build the app from ``EVOR_RUN_DIR`` (a run dir) or ``EVOR_ROOT`` (a .evor root).

    ``EVOR_DASHBOARD_NO_STEER=1`` disables the steer endpoint.
    """
    import os

    run_dir = os.environ.get("EVOR_RUN_DIR")
    root = os.environ.get("EVOR_ROOT")
    default_run = None
    if run_dir:
        p = Path(run_dir).resolve()
        if (p / "tree.json").exists() or (p / "run-state.json").exists():
            default_run = p
            root = root or str(p.parent.parent.parent)
        else:
            root = root or str(p)
    return create_app(
        root or ".evor",
        default_run_dir=default_run,
        allow_steer=os.environ.get("EVOR_DASHBOARD_NO_STEER", "") not in ("1", "true", "yes"),
    )


def __getattr__(name: str) -> Any:
    # Built lazily on first access so importing this module stays side-effect free.
    if name == "app":
        global app
        app = _app_from_env()
        return app
    raise AttributeError(name)
