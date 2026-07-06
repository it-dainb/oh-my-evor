---
description: Generate a final Evor mission report with tree visualisation, frontier table, and static HTML export
---

# /evor-report

This command generates the final mission report for a completed or paused Evor run.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "$CLAUDE_PLUGIN_ROOT/skills/evor-report/SKILL.md"
   ```
   Claude Code sets `CLAUDE_PLUGIN_ROOT` to this plugin's install directory, so this resolves no matter what your current working directory is.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-report/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Usage: `/evor-report [run-id]`
- Reads `.evor/active-run.json` for the active run, or resolves from the given run-id argument
- Renders an ASCII evolution tree and generates a PNG via `python -m evor.plot_tree`
- Aggregates wiki lessons via `python -m evor.wiki summarize`
- Exports a self-contained static HTML report to `<run-dir>/report/index.html`
- Writes a `report/manifest.json` with metadata
- Called automatically by the `evor` tick loop when a stop condition is met
