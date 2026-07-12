#!/usr/bin/env node
/**
 * run-watcher.mjs — plugin monitor for the active EVOR training job.
 *
 * Discovery: EVOR_RUN_DIR is NOT inherited by a plugin monitor, so the run is
 * discovered from disk — .evor/active-run.json → run_dir + job_id → wait for
 * job completion. Emits structured progress events to Claude; never surfaces
 * raw log lines, FS paths, or UUIDs in agent-facing output.
 *
 * Fails open: any missing file / unset field → emit one JSON line + exit 0.
 * Attended runs only (interactive CLI); scheduled/multi-day runs use FileChanged/Cron.
 */
"use strict";
const { readFileSync, existsSync } = require("fs");
const { spawnSync } = require("child_process");
const { resolve } = require("path");

const EVOR_ROOT = process.env.EVOR_ROOT || ".evor";
const ACTIVE_RUN_PATH = resolve(EVOR_ROOT, "active-run.json");
const POLL_MS = 3000;
const MAX_WAIT_SECS = 60;

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function sleep(ms) { const r = spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`], { timeout: ms + 2000 }); return r; }

function waitForFields(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ar = readJson(ACTIVE_RUN_PATH);
    if (ar && ar.job_id && ar.run_dir) return ar;
    sleep(POLL_MS);
  }
  return null;
}

let ar = readJson(ACTIVE_RUN_PATH);
if (!ar) { emit({ event: "no-active-run", msg: "No active run found; run-watcher exiting." }); process.exit(0); }

if (!ar.job_id || !ar.run_dir) {
  emit({ event: "waiting", msg: "Waiting for job to be registered in active-run.json ..." });
  ar = waitForFields(MAX_WAIT_SECS * 1000);
  if (!ar) { emit({ event: "timeout", msg: "Job not registered after 60s; run-watcher exiting." }); process.exit(0); }
}

const logPath = resolve(ar.run_dir, "jobs", ar.job_id, "log.jsonl");
const statusPath = resolve(ar.run_dir, "jobs", ar.job_id, "status.json");
if (!existsSync(logPath)) {
  // Log not yet present — emit a structured event without exposing the path
  emit({ event: "no-log", msg: "Job log not yet available; run-watcher exiting. Use evor_run_status to poll." });
  process.exit(0);
}

// Emit watch-start with run_id only — no job_id UUID, no log path
emit({ event: "watch-start", run_id: ar.run_id });

// Parse the log for structured progress events and emit them without leaking raw lines.
// stdio is fully suppressed so no subprocess output reaches agent stdout directly.
// The log is tailed internally; on completion the final status is emitted as a structured event.
spawnSync("bash", ["-c",
  `tail -n +1 -f "${logPath}" | grep -qE ` +
  `'succeeded|failed|exit_code|FAILED|Traceback|RuntimeError|OOM|CUDA out of memory|Killed'`
], { stdio: ["ignore", "ignore", "ignore"] });

const finalStatus = readJson(statusPath);
if (finalStatus) {
  // Emit a clean structured event: state + metrics only, no internal paths or ids
  const { state, status: st, metrics, error, reason } = finalStatus;
  emit({ event: "run-complete", state: state ?? st, metrics: metrics ?? null, error: error ?? reason ?? null });
}
