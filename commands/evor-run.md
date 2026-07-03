---
description: Load GoalContract and launch the Evor tick loop for a mission
---

# /evor-run

This command loads the GoalContract for a mission and starts (or resumes) the Evor tick loop.

## Dispatch

1. Read the full bundled skill instructions from `skills/evor-run/SKILL.md`.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If the file is not directly readable from the current working directory, locate it under the active plugin root, then continue.

## Quick Reference

- Usage: `/evor-run [mission-id or run-id]`
- If no argument given, reads `.evor/active-run.json` for the current run
- If no GoalContract found, redirects to `/evor-setup`
- Detects existing runs automatically and offers to resume
