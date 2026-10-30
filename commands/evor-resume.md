---
description: Resume a paused Evor mission from where it left off
---

# /evor-resume

This command resumes a paused or interrupted Evor mission by restoring run state and continuing from the last completed tick.

## Dispatch

Invoke the `oh-my-evor:evor-run` skill with the **Skill tool**, passing the user's arguments:

```text
$ARGUMENTS
```

The skill loads with its own base directory and runs the resume flow: if the run has completed
ticks and is not finished, it resumes. Do not `Read` a path written with shell variables such
as `${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/…`: the Read tool cannot expand them.

## Quick Reference

- Usage: `/evor-resume [run-id]`
- If no run-id given, reads `.evor/active-run.json` for the last active run
- Prints a resume summary (ticks completed, best score, frontier size) before continuing
- Resumes from tick N+1 where N is the last completed tick
- If the run is already complete, suggests `/evor-report` instead
