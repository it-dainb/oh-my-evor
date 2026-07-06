---
description: Inspect accumulated Gotchas (failures + hardware limits) and the hardware capability profile
---

# /evor-gotchas

This command lists the accumulated failure knowledge and hardware capability profile for
the current .evor workspace — so you can see what constraints and failures the Evor engine
has encountered and what future ticks/mutations must avoid.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/evor-gotchas/SKILL.md"
   ```
   `EVOR_PLUGIN_ROOT` is exported by this plugin’s SessionStart hook and `CLAUDE_PLUGIN_ROOT` by Claude Code — either points at the plugin’s install directory, so this resolves regardless of your current working directory.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-gotchas/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

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
