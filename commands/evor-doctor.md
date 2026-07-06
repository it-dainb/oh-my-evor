---
description: Check environment health and .evor integrity; auto-repair list-format tree.json
---

# /evor-doctor

This command runs environment and .evor integrity diagnostics (doctor.py) and optionally
auto-repairs repairable issues such as legacy list-format tree.json.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "$CLAUDE_PLUGIN_ROOT/skills/evor-doctor/SKILL.md"
   ```
   Claude Code sets `CLAUDE_PLUGIN_ROOT` to this plugin's install directory, so this resolves no matter what your current working directory is.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-doctor/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Usage: `/evor-doctor [run-dir] [--repair]`
- No argument: environment-only checks (Python version, torch, Node.js, patch tool, env vars)
- With run-dir: adds .evor integrity checks (tree format, mission-state, orphan pending nodes, split hash)
- With `--repair`: auto-converts legacy list-format tree.json to DICT format
- After repair: re-run `/evor-validate` to confirm contract validity
