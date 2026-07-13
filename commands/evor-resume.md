---
description: Resume a paused Evor mission from where it left off
---

# /evor-resume

This command resumes a paused or interrupted Evor mission by restoring run state and continuing from the last completed tick.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/evor-run/SKILL.md"
   ```
   `EVOR_PLUGIN_ROOT` is exported by this plugin’s SessionStart hook and `CLAUDE_PLUGIN_ROOT` by Claude Code — either points at the plugin’s install directory, so this resolves regardless of your current working directory.
2. Follow that SKILL.md exactly with the resume flag active, treating the user's arguments as:

```text
$ARGUMENTS
```

The `evor-run` skill handles resume detection automatically: if the run has completed ticks and is not yet finished, it enters resume mode.

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-run/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Usage: `/evor-resume [run-id]`
- If no run-id given, reads `.evor/active-run.json` for the last active run
- Prints a resume summary (ticks completed, best score, frontier size) before continuing
- Resumes from tick N+1 where N is the last completed tick
- If the run is already complete, suggests `/evor-report` instead
