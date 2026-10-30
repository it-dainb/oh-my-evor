---
name: evor-run
description: Load and validate the mission contract, set active run state, and invoke the Evor tick loop
argument-hint: "[mission-id or run-id]"
skills: [oh-my-evor:evor-mcp]
---

<Purpose>
evor-run is the launch skill for an Evor mission. It validates that a mission contract exists, checks for an existing run to resume, sets the EVOR_ACTIVE_RUN_ID environment variable, writes the active run state via `evor_state_write`, and delegates to the `evor` skill to start the tick loop. If no valid mission contract is found for the specified mission, it redirects to `evor-setup`.
</Purpose>

<Use_When>
- User says "run evor", "start evor", "evor run", or invokes `/evor-run`
- After `evor-setup` completes and prints "Start the tick loop with /evor-run"
- When the user wants to launch a mission by mission-id or run-id
</Use_When>

<Do_Not_Use_When>
- No initialized mission exists — redirect to `evor-setup` instead
- User wants to resume from a specific tick — use `evor-resume` which accepts a run-id
- User wants dashboard only — use `evor-dashboard`
</Do_Not_Use_When>

<Steps>

## Step 1 — Resolve Mission and Run ID

**While a mission is RUNNING, main may not call `evor_state_read` or `evor_tree_read`, or run
Bash: the governor reserves them for the tick boundary.** A resume therefore reads progress
from `evor_check_stop` and files with the Read tool, as below. (These steps used to call
`evor_state_read` three times; on a running mission every call was denied, as in the
2026-10-30 binarization resume.) When the mission is paused or locked, `evor_state_read` is
allowed.

If arguments were provided, treat them as mission-id or run-id. Otherwise:
1. Read `.evor/active-run.json` with the Read tool to find the current run. If the mission is
   not running, `evor_state_read` also works.
2. If found and mission-state shows a non-terminal `status` (not `completed`, `failed` or `superseded`): offer to resume that run. **Read mission-state, not run-state** — `run-state.status` was retired in v1.2.1 (item 1.9b), so a condition on it is vacuously true for every run and would offer to resume runs that are finished.
3. If not found: list available missions via `evor_state_read` and prompt the user to select one, or redirect to `/evor-setup`.

## Step 2 — Load and Validate Mission Contract

Call `evor_read_goal_contract({ run_id: "<run_dir>" })` to load and validate the contract.

If it reports missing or invalid fields, print the error and redirect to `/evor-setup`. Do not enumerate specific field names — let the tool report what is wrong.

## Step 2.5 — Phase-2 Lock Guard

Check whether the mission is locked. **A `running` mission is locked by construction**: the
state machine reaches `running` only from `locked`, so skip this check for a running mission.
Otherwise call `evor_state_read`, which is allowed when the mission is not running.

- **No mission state present**: print the error below and **stop immediately**. Do not proceed to Step 3.
  ```
  ERROR: Mission state not found — mission is not locked.
  The contract has not passed the Phase-2 validation gate.
  Run /evor-validate to validate and lock it, or /evor-setup to reinitialize.
  ```
- **Mission not locked**: print the error below and **stop immediately**. Do not proceed to Step 3.
  ```
  ERROR: Mission is not locked.
  The contract has not passed the Phase-2 validation gate.
  Run /evor-validate to validate and lock it, or /evor-setup to reinitialize.
  ```
- **Mission locked**: continue to Step 3.

## Step 3 — Check for Resume Path

Call `evor_check_stop({ run_id })`. It returns `tick_count`, `best_score`, `frontier_count`,
`budget_remaining` and `blocked`, which is everything the resume summary needs, and main may
call it while the mission runs. If it reports `blocked: true`, show `blocked_reason` and stop:
do not resume a run the plugin itself says cannot proceed.
- If run is unstarted (tick_count = 0): this is a fresh start. Print: "Starting fresh mission: <mission_id> (run_id: <run_id>)."
- If run is in progress (tick_count > 0): print resume summary:
  ```
  Resuming mission: <mission_id>
  Run ID: <run_id>
  Ticks completed: <tick_count>
  Best score so far: <best_score> (baseline: <baseline_value>)
  Frontier size: <len(frontier_ids)>
  Last eval version: <current_eval_version>
  ```
  Under an `aggressive-never-halt` autonomy charter, resume without asking: the user's
  `/evor-run` is the instruction, and the governor denies `AskUserQuestion` to main on such a
  mission. Otherwise ask: "Resume from tick <tick_count + 1>? (yes/no)"
  → "no": allow the user to specify a different run or abort.
- If **mission-state** `status` is terminal (`completed`, `failed` or `superseded`): print "This run is already complete. Use /evor-report to view results or /evor-setup to start a new mission." and stop. **Read mission-state, not run-state** — `run-state.status` was retired in v1.2.1 (item 1.9b), so this branch would never fire again if keyed on it.

## Step 4 — Set Active Run State

Call `evor_state_write` to record the active run and set status to running:

```
evor_state_write({
  mission_status: "running",
  active_run: {
    mission_id: "<mission_id>",
    run_id: "<run_id>",
    run_dir: "<run_dir>",
    started_at: "<ISO 8601>",
    status: "running"
  }
})
```

## Step 5 — Run-Watch Mode

Choose the appropriate run-watch mode based on context:

- **Attended** (interactive session, run expected ≤~4h): jobs are waited on INSIDE the tick with `evor_wait({ job_id })`; main waits for the tick's completion notice, and if a tick yields it calls `evor_wait` on what the tick named, then resumes it. Main may not use `Monitor` while the mission runs. The session stays live.
- **Scheduled / unattended** (multi-hour or overnight runs): the plugin job-status watcher (registered via `watchPaths` at run_start) fires a `FileChanged` wake when `jobs/<id>/status.json` changes. Use `CronCreate` to establish a recurring check-in cadence for multi-day missions. Session sleeps between check-ins.

The tick loop in the `evor` skill manages this automatically; this note is for orientation when choosing `/evor-run` vs a scheduled invocation.

## Step 6 — Invoke the evor Skill

Read the evor skill with the **Read tool** and follow it exactly. Its path is
`<this skill's base directory>/../evor/SKILL.md`; the base directory is printed at the top of
this skill. Do not resolve the path with Bash, which the governor denies while the mission runs.
Pass:
- `run_id` = the resolved run ID
- `resume` = true if tick_count > 0

The evor skill owns the tick loop from this point forward.

</Steps>

<Tool_Usage>
- `evor_state_read` — read active run state, mission lock status, and run progress
- `evor_read_goal_contract` — load and validate the mission contract
- `evor_state_write` — set mission_status="running" and active_run record
- Skill dispatch to `evor` — hand off tick loop execution
</Tool_Usage>
