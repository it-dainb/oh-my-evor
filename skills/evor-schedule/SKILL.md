---
name: evor-schedule
description: Set up unattended, multi-day EVOR operation. Auto-suggest when the user asks to run a mission overnight, unattended, for days, on a schedule, or while away. Establishes a poll-and-advance cadence so the session sleeps between ticks and wakes to advance the search, then notifies on milestones and completion.
user-invocable: true
---

# EVOR Schedule — unattended, multi-day operation

An EVOR mission can run for hours or days. A training run is far longer than any single tool call, so
holding a live watch open for the whole mission wastes the session. Scheduled mode lets the session
**sleep between ticks and wake to advance** — poll the active job, and when it finishes, record its result
and launch the next candidate.

## When to use
Use this when the user wants the mission to progress without them watching: "run overnight", "run
unattended", "run for days", "keep evolving while I'm away", "schedule the mission". For attended runs the
user is watching, the `evor` orchestrator's native `Monitor` watch is the right choice instead.

## Set the execution mode
Record the mode so the loop and reflexes pick the sleep-and-wake path instead of a live watch:
- Call `evor_state_write({ run_id, tick_state: { execution_mode: "scheduled" } })`.
- Attended is the default; this flips the active run to scheduled.

## Pick the cadence — probe availability, degrade gracefully
Scheduling surfaces vary by platform and plan. Probe what is available and pick the best, then state which
one is active and what the fallback is. Never assume; a missing scheduler must never block the run.

1. **RemoteTrigger (truly remote)** — create a claude.ai Routine to advance or repeat the mission on a
   schedule. Requires a Pro/Max/Team/Enterprise plan; unavailable on Bedrock/Vertex/Foundry. Best when the
   user closes their machine entirely.
2. **CronCreate (session alive)** — schedule a recurring "advance the mission" prompt. Session-scoped and
   restored on `--resume`/`--continue`. Use when the session stays open (a persistent or web session).
3. **ScheduleWakeup (self-paced loop)** — pace the next check between one minute and one hour, matched to the
   expected run time. Use inside a `/loop`-style advance.
4. **Manual (last resort)** — if none are available, tell the user the mission advances each time they resume
   the session, and how to resume.

State the choice plainly: which scheduler is active, the cadence, and how to stop it.

## The poll-and-advance step (what each firing does)
Each scheduled firing runs ONE step, then reschedules:
1. `evor_run_status({ run_id })` for the active job. The tool looks up the active job internally from `run_id` — do not carry or pass `job_id` across schedule firings.
2. If still running → reschedule the next check (cadence matched to expected run time); do nothing else.
3. If succeeded → `evor_record_eval` → `evor_integrity_check` → `evor_wiki_add` → `evor_select` → `evor_run_start`
   for the next candidate → reschedule → `PushNotification` (progress) + `SendUserFile` (tree/metrics plot)
   at milestones.
4. If failed → `evor_signal_emit` (runtime-failure) + `PushNotification`, then advance or pause per the
   autonomy posture.
5. If the mission stop-condition is met → cancel the schedule (`CronDelete` / stop the loop) +
   `PushNotification` (complete) + `SendUserFile` (final report via `evor_plot_report`).

## Cadence guidance
Match the check interval to how long a run actually takes. For a run expected to finish in minutes, poll
often enough to advance promptly; for a multi-hour run, check back on a coarse cadence so the session isn't
woken needlessly. Watching a status file for completion (via the run-watcher / FileChanged) is preferable to
tight polling when available.

## Stop / cancel
Tell the user how to stop unattended operation: cancel the schedule (`CronDelete` the recurring task, or stop
the `/loop`), or set the mission status to paused with `evor_state_write({ run_id, mission_status: "paused" })`.

## Availability notes
`RemoteTrigger`, `PushNotification`, and `SendUserFile` require a claude.ai plan and are unavailable on
Bedrock/Vertex/Foundry; `CronCreate`/`ScheduleWakeup` require an interactive session. When a surface is
unavailable, fall through to the next option and say so — the mission still advances, just with a coarser
notification or resume path.
