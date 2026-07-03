---
name: evor-run
description: Load GoalContract, set active run state, and invoke the Evor tick loop
argument-hint: "[mission-id or run-id]"
level: 3
---

<Purpose>
evor-run is the launch skill for an Evor mission. It validates that a GoalContract exists, checks for an existing run to resume, sets the EVOR_ACTIVE_RUN_ID environment variable, writes `.evor/active-run.json`, and delegates to the `evor` skill to start the tick loop. If no GoalContract is found for the specified mission, it redirects to `evor-setup`.
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
1. Check `.evor/active-run.json` for a current active run.
2. If found and run-state.json shows `status != "completed"`: offer to resume that run.
3. If not found: list available missions under `.evor/runs/` and prompt the user to select one, or redirect to `/evor-setup`.

## Step 2 — Load and Validate GoalContract

```bash
cat .evor/runs/<mission-slug>/<run-id>/goal-contract.json
```

Validate:
- `mission_id`, `dataset_ref`, `baseline_value`, `locked_split_hash`, `eval_script_hash` are all present.
- `eval_version` matches the latest `eval-suites/<version>.json` file.
- `allowed_licenses` is non-empty.
- If validation fails: print the specific missing/invalid fields and redirect to `/evor-setup`.

## Step 3 — Check for Resume Path

Check `.evor/runs/<mission-slug>/<run-id>/run-state.json`:
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

```bash
export EVOR_ACTIVE_RUN_ID=<run_id>
```

Write `.evor/active-run.json`:
```json
{
  "mission_id": "<mission_id>",
  "run_id": "<run_id>",
  "run_dir": ".evor/runs/<mission-slug>/<run-id>/",
  "started_at": "<ISO 8601>",
  "status": "running"
}
```

Update `run-state.json` via `evor_state_write`: set `status = "running"`.

## Step 5 — Invoke the evor Skill

Read and follow `skills/evor/SKILL.md` exactly, passing:
- `run_id` = the resolved run ID
- `goal_contract` = the loaded GoalContract
- `resume` = true if tick_count > 0

The evor skill owns the tick loop from this point forward.

</Steps>

<Tool_Usage>
- Read / Bash — load and validate GoalContract, run-state.json
- evor_state_read — read current run state
- evor_state_write — set status=running
- Skill dispatch to `evor` — hand off tick loop execution
</Tool_Usage>
