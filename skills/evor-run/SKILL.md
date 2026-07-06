---
name: evor-run
description: Load GoalContract, set active run state, and invoke the Evor tick loop
argument-hint: "[mission-id or run-id]"
level: 3
skills: [oh-my-evor:evor-mcp]
---

<Purpose>
evor-run is the launch skill for an Evor mission. It validates that a GoalContract exists, checks for an existing run to resume, sets the EVOR_ACTIVE_RUN_ID environment variable, writes the active-run state via `evor_state_write`, and delegates to the `evor` skill to start the tick loop. If no GoalContract is found for the specified mission, it redirects to `evor-setup`.
</Purpose>

<Use_When>
- User says "run evor", "start evor", "evor run", or invokes `/evor-run`
- After `evor-setup` completes and prints "Start the tick loop with /evor-run"
- When the user wants to launch a mission by mission-id or run-id
</Use_When>

<Do_Not_Use_When>
- No GoalContract exists — redirect to `evor-setup` instead
- User wants to resume from a specific tick — use `evor-resume` which accepts a run-id
- User wants dashboard only — use `evor-dashboard`
</Do_Not_Use_When>

<Steps>

## Step 1 — Resolve Mission and Run ID

If arguments were provided, treat them as mission-id or run-id. Otherwise:
1. Call `evor_state_read` to check for a current active run.
2. If found and run-state shows `status != "completed"`: offer to resume that run.
3. If not found: list available missions under `.evor/runs/` and prompt the user to select one, or redirect to `/evor-setup`.

## Step 2 — Load and Validate GoalContract

Call `evor_read_goal_contract({ run_id: "<run_dir>" })` to load and validate the contract.

Validate:
- `mission_id`, `dataset_ref`, `baseline_value`, `locked_split_hash`, `eval_script_hash` are all present.
- `eval_version` matches the latest `eval-suites/<version>.json` file.
- `allowed_licenses` is non-empty.
- If validation fails: print the specific missing/invalid fields and redirect to `/evor-setup`.

## Step 2.5 — Phase-2 Lock Guard

Call `evor_state_read` to read mission-state for the resolved run directory.

- **No mission-state present**: print the error below and **stop immediately**. Do not proceed to Step 3.
  ```
  ERROR: mission-state.json not found — mission is not locked.
  The contract has not passed the Phase-2 validation gate.
  Run /evor-validate to validate and lock it, or /evor-setup to reinitialize.
  ```
- **mission_state.status != "locked"**: print the error below and **stop immediately**. Do not proceed to Step 3.
  ```
  ERROR: mission-state.status=<status> — mission is not locked.
  The contract has not passed the Phase-2 validation gate.
  Run /evor-validate to validate and lock it, or /evor-setup to reinitialize.
  ```
- **mission_state.status == "locked"**: continue to Step 3.

## Step 3 — Check for Resume Path

Call `evor_state_read` to check run-state.json:
- If `status = "initialized"` or `tick_count = 0`: this is a fresh start. Print: "Starting fresh mission: <mission_id> (run_id: <run_id>)."
- If `status = "running"` and `tick_count > 0`: print resume summary:
  ```
  Resuming mission: <mission_id>
  Run ID: <run_id>
  Ticks completed: <tick_count>
  Best score so far: <best_score> (baseline: <baseline_value>)
  Frontier size: <len(frontier_ids)>
  Last eval version: <current_eval_version>
  ```
  Ask: "Resume from tick <tick_count + 1>? (yes/no)"
  → "no": allow the user to specify a different run or abort.
- If `status = "completed"`: print "This run is already complete. Use /evor-report to view results or /evor-setup to start a new mission." and stop.

## Step 4 — Set Active Run State

Call `evor_state_write` to record the active run and set status to running:

```
evor_state_write({
  mission_status: "running",
  active_run: {
    mission_id: "<mission_id>",
    run_id: "<run_id>",
    run_dir: ".evor/runs/<mission-slug>/<run-id>/",
    started_at: "<ISO 8601>",
    status: "running"
  }
})
```

## Step 5 — Run-Watch Mode

Choose the appropriate run-watch mode based on context:

- **Attended** (interactive session, run expected ≤~4h): after `evor_run_start` fires inside the tick loop, the `evor` skill watches the job with the native `Monitor` tool (`tail -f <log_path> | grep -E --line-buffered "elapsed_steps=|val_|Traceback|Error|OOM|Killed|FAILED"`). Session stays live.
- **Scheduled / unattended** (multi-hour or overnight runs): the plugin job-status watcher (registered via `watchPaths` at run_start) fires a `FileChanged` wake when `jobs/<id>/status.json` changes. Use `CronCreate` to establish a recurring check-in cadence for multi-day missions. Session sleeps between check-ins.

The tick loop in the `evor` skill manages this automatically; this note is for orientation when choosing `/evor-run` vs a scheduled invocation.

## Step 6 — Invoke the evor Skill

Read and follow `skills/evor/SKILL.md` exactly, passing:
- `run_id` = the resolved run ID
- `goal_contract` = the loaded GoalContract
- `resume` = true if tick_count > 0

The evor skill owns the tick loop from this point forward.

</Steps>

<Tool_Usage>
- `evor_state_read` — read active-run, mission-state, and run-state
- `evor_read_goal_contract` — load and validate GoalContract
- `evor_state_write` — set mission_status="running" and active_run record
- Skill dispatch to `evor` — hand off tick loop execution
</Tool_Usage>
