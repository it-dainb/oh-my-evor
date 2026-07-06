#!/usr/bin/env node
/**
 * run-watcher.mjs — plugin monitor for the active EVOR training job.
 *
 * Discovery: EVOR_RUN_DIR is NOT inherited by a plugin monitor, so the run is
 * discovered from disk — .evor/active-run.json → run_dir + job_id → tail the job
 * log. Every matching stdout line is delivered to Claude as a notification, so the
 * model reacts to progress and failures without invoking a watch itself.
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
  emit({ event: "waiting", msg: "Waiting for run_dir + job_id in active-run.json ..." });
  ar = waitForFields(MAX_WAIT_SECS * 1000);
  if (!ar) { emit({ event: "timeout", msg: "job_id not found after 60s; run-watcher exiting." }); process.exit(0); }
}

const logPath = resolve(ar.run_dir, "jobs", ar.job_id, "log.jsonl");
const statusPath = resolve(ar.run_dir, "jobs", ar.job_id, "status.json");
if (!existsSync(logPath)) {
  emit({ event: "no-log", job_id: ar.job_id, msg: `Log not yet at ${logPath}; run-watcher exiting.` });
  process.exit(0);
}

emit({ event: "watch-start", job_id: ar.job_id, run_id: ar.run_id, log: logPath });

// Stream progress + every failure signature. Line-buffered so each event lands promptly.
spawnSync("bash", ["-c",
  `tail -n +1 -f "${logPath}" | grep -E --line-buffered ` +
  `'elapsed_steps=|val_|step=|loss=|Traceback|RuntimeError|Error:|OOM|CUDA out of memory|Killed|FAILED|succeeded|failed|exit_code'`
], { stdio: ["ignore", "inherit", "ignore"] });

const finalStatus = readJson(statusPath);
if (finalStatus) emit({ event: "run-complete", ...finalStatus });
