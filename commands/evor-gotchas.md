---
description: Inspect accumulated Gotchas (failures + hardware limits) and the hardware capability profile
---

# /evor-gotchas

This command lists the accumulated failure knowledge and hardware capability profile for
the current .evor workspace — so you can see what constraints and failures the Evor engine
has encountered and what future ticks/mutations must avoid.

## Dispatch

1. Read the full bundled skill instructions from `skills/evor-gotchas/SKILL.md`.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If the file is not directly readable from the current working directory, locate it under the active plugin root, then continue.

## Quick Reference

- Usage: `/evor-gotchas [--kind K] [--scope S] [--min-confidence C] [--evor-root DIR] [--run-dir DIR]`
- No arguments: show all gotchas + capability profile from `.evor/`
- `--kind runtime-failure`: only show OOM/NaN/dep/checkpoint failures
- `--kind hardware-constraint`: only show hardware limit gotchas
- `--kind approach-deadend`: only show proven-ineffective approach families
- `--scope global`: cross-mission gotchas only (machine-level)
- `--scope mission`: current-run gotchas only
- `--min-confidence 0.8`: show only high-confidence (hard-block) gotchas
- After `/evor-setup`: preflight writes capability.json; run `/evor-gotchas` to confirm hardware constraints were seeded
