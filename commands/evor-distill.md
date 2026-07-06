---
description: Scan an existing ML workspace for EVOR; produces a starting-point report that pre-fills the setup interview
---

# /evor-distill

This command scans an existing ML repository to classify the workspace, detect datasets/models/configs/entry-points, and scrape any claimed metrics — producing `<evorRoot>/starting-point.json` that pre-fills `/evor-setup`.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/evor-distill/SKILL.md"
   ```
   `EVOR_PLUGIN_ROOT` is exported by this plugin's SessionStart hook and `CLAUDE_PLUGIN_ROOT` by Claude Code — either points at the plugin's install directory, so this resolves regardless of your current working directory.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-distill/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Usage: `/evor-distill [workspace-path]`
- Classifies the workspace: `greenfield`, `brownfield`, `evor-active`, or `possibly-training`
- Detects datasets, checkpoints, configs, entry points, and experiment logs
- Scraped baseline candidates are always `verified: false` — EVOR re-measures on the frozen split
- Output: `<evorRoot>/starting-point.json`
- After distill completes, run `/evor-setup` — the interview answers will be pre-filled from the report
