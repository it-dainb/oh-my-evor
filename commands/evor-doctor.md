---
description: Check environment health and .evor integrity; auto-repair list-format tree.json
---

# /evor-doctor

This command runs environment and .evor integrity diagnostics (doctor.py) and optionally
auto-repairs repairable issues such as legacy list-format tree.json.

## Dispatch

1. Read the full bundled skill instructions from `skills/evor-doctor/SKILL.md`.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If the file is not directly readable from the current working directory, locate it under the active plugin root, then continue.

## Quick Reference

- Usage: `/evor-doctor [run-dir] [--repair]`
- No argument: environment-only checks (Python version, torch, Node.js, patch tool, env vars)
- With run-dir: adds .evor integrity checks (tree format, mission-state, orphan pending nodes, split hash)
- With `--repair`: auto-converts legacy list-format tree.json to DICT format
- After repair: re-run `/evor-validate` to confirm contract validity
