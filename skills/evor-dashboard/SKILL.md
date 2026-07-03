---
name: evor-dashboard
description: Start the live FastAPI + SSE dashboard for the active Evor mission on port 8756
argument-hint: "[run-id]"
level: 2
---

<Purpose>
evor-dashboard starts the FastAPI dashboard server for the active Evor mission. The dashboard provides a live D3 tree visualization of the evolution DAG, Chart.js telemetry curves for each node, and a real-time frontier table. It reads from the run directory's `tree.json` and `telemetry.jsonl` files via SSE streams, requiring no database.
</Purpose>

<Use_When>
- User says "dashboard", "show dashboard", "open dashboard", or invokes `/evor-dashboard`
- During a running mission to monitor progress in real time
- After a completed mission to browse the evolution tree before generating a report
</Use_When>

<Do_Not_Use_When>
- User wants a static final report — use `evor-report`
- No active run exists (`.evor/active-run.json` absent) — redirect to `/evor-setup`
</Do_Not_Use_When>

<Steps>

## Step 1 — Resolve Run Directory

Read `.evor/active-run.json` to get `run_dir`. If a run-id argument was provided, resolve `run_dir = .evor/runs/<mission-slug>/<run-id>/` directly.

If no active run is found: print "No active run found. Start a mission with /evor-setup first." and stop.

## Step 2 — Check for Running Server

```bash
lsof -i :8756 2>/dev/null | grep LISTEN
```

If a server is already listening on port 8756: print "Dashboard already running at http://localhost:8756 (run-id: <run_id>)" and open the browser (Step 4). Do not start a second server.

## Step 3 — Start Dashboard Server

Launch the server in the background:

```bash
EVOR_RUN_DIR=<run_dir> uvicorn evor.dashboard.server:app \
  --host 0.0.0.0 \
  --port 8756 \
  --reload \
  --reload-dir <run_dir> \
  2>.evor/logs/dashboard.log &
```

Wait up to 5 seconds for the server to become ready:
```bash
for i in 1 2 3 4 5; do
  curl -s http://localhost:8756/health && break
  sleep 1
done
```

If health check fails after 5 attempts: print the last 20 lines of `.evor/logs/dashboard.log` and stop.

## Step 4 — Open Browser

Attempt to open the dashboard in the default browser:
```bash
xdg-open http://localhost:8756 2>/dev/null || open http://localhost:8756 2>/dev/null || true
```

Print:
```
Dashboard running at: http://localhost:8756
Run ID: <run_id>
Mission: <mission_id>
Log: .evor/logs/dashboard.log

Available views:
  /          — Evolution tree (D3 DAG, frontier highlighted)
  /telemetry — Live training curves (Chart.js, SSE stream)
  /frontier  — Frontier table (best-so-far nodes)
  /health    — Server health check

Press Ctrl+C or run /evor-dashboard --stop to shut down.
```

## Step 5 — Stop (optional, via --stop argument)

If the user passes `--stop` as an argument:
```bash
pkill -f "uvicorn evor.dashboard.server:app"
```
Print: "Dashboard server stopped."

</Steps>

<Tool_Usage>
- Bash — lsof, uvicorn background launch, curl health check, xdg-open/open
- Read — .evor/active-run.json
</Tool_Usage>
