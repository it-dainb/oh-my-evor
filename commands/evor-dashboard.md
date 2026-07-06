---
description: Start the live FastAPI + SSE dashboard for the active Evor mission on port 8756
---

# /evor-dashboard

This command starts the live evolution dashboard for the active Evor mission.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "$CLAUDE_PLUGIN_ROOT/skills/evor-dashboard/SKILL.md"
   ```
   Claude Code sets `CLAUDE_PLUGIN_ROOT` to this plugin's install directory, so this resolves no matter what your current working directory is.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-dashboard/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Usage: `/evor-dashboard [--stop]`
- Dashboard URL: http://localhost:8756
- Views: `/` (tree), `/telemetry` (live curves), `/frontier` (best nodes)
- Pass `--stop` to shut down a running dashboard server
- Reads from `.evor/active-run.json`; pass a run-id argument to view a specific run
