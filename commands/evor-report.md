---
description: Generate a final Evor mission report with tree visualisation, frontier table, and static HTML export
---

# /evor-report

This command generates the final mission report for a completed or paused Evor run.

## Dispatch

1. Read the full bundled skill instructions from `skills/evor-report/SKILL.md`.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If the file is not directly readable from the current working directory, locate it under the active plugin root (`CLAUDE_PLUGIN_ROOT` or the directory containing `.claude-plugin/plugin.json`), then continue.

## Quick Reference

- Usage: `/evor-report [run-id]`
- Reads `.evor/active-run.json` for the active run, or resolves from the given run-id argument
- Renders an ASCII evolution tree and generates a PNG via `python -m evor.plot_tree`
- Aggregates wiki lessons via `python -m evor.wiki summarize`
- Exports a self-contained static HTML report to `<run-dir>/report/index.html`
- Writes a `report/manifest.json` with metadata
- Called automatically by the `evor` tick loop when a stop condition is met
