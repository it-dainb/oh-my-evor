---
description: Run the Phase-2 contract/state validator against an active evor run directory
---

# /evor-validate

This command runs the deterministic Phase-2 enforcement gate (validate.py) against a run
directory and presents the structured pass/fail report.

## Dispatch

1. Read the full bundled skill instructions from `skills/evor-validate/SKILL.md`.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If the file is not directly readable from the current working directory, locate it under the active plugin root, then continue.

## Quick Reference

- Usage: `/evor-validate [run-dir or run-id]`
- If no argument given, reads `.evor/active-run.json` for the current run
- Exits 0 (VALID) or 1 (INVALID); prints a JSON report to stdout
- On VALID + status=draft: flips mission-state.json to "locked" and confirms
- On INVALID: lists each failed check with remediation guidance
- Redirects to `/evor-doctor` for infrastructure issues, `/evor-setup` for contract issues
