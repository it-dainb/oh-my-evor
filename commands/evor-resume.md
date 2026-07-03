---
description: Resume a paused Evor mission from where it left off
---

# /evor-resume

This command resumes a paused or interrupted Evor mission by restoring run state and continuing from the last completed tick.

## Dispatch

1. Read the full bundled skill instructions from `skills/evor-run/SKILL.md`.
2. Follow that SKILL.md exactly with the resume flag active, treating the user's arguments as:

```text
$ARGUMENTS
```

The `evor-run` skill handles resume detection: if `run-state.json` shows `tick_count > 0` and `status != "completed"`, it enters resume mode automatically.

If the file is not directly readable from the current working directory, locate it under the active plugin root, then continue.

## Quick Reference

- Usage: `/evor-resume [run-id]`
- If no run-id given, reads `.evor/active-run.json` for the last active run
- Prints a resume summary (ticks completed, best score, frontier size) before continuing
- Resumes from tick N+1 where N is the last completed tick
- If the run is already complete, suggests `/evor-report` instead
