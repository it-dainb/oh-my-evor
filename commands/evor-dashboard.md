---
description: Start the live FastAPI + SSE dashboard for the active Evor mission on port 8756
---

# /evor-dashboard

This command starts the live evolution dashboard for the active Evor mission.

## Dispatch

1. Read the full bundled skill instructions from `skills/evor-dashboard/SKILL.md`.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If the file is not directly readable from the current working directory, locate it under the active plugin root, then continue.

## Quick Reference

- Usage: `/evor-dashboard [--stop]`
- Dashboard URL: http://localhost:8756
- Views: `/` (tree), `/telemetry` (live curves), `/frontier` (best nodes)
- Pass `--stop` to shut down a running dashboard server
- Reads from `.evor/active-run.json`; pass a run-id argument to view a specific run
