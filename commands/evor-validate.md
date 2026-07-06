---
description: Run the Phase-2 contract/state validator against an active evor run directory
---

# /evor-validate

This command runs the deterministic Phase-2 enforcement gate (validate.py) against a run
directory and presents the structured pass/fail report.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/evor-validate/SKILL.md"
   ```
   `EVOR_PLUGIN_ROOT` is exported by this plugin’s SessionStart hook and `CLAUDE_PLUGIN_ROOT` by Claude Code — either points at the plugin’s install directory, so this resolves regardless of your current working directory.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-validate/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Usage: `/evor-validate [run-dir or run-id]`
- If no argument given, reads `.evor/active-run.json` for the current run
- Exits 0 (VALID) or 1 (INVALID); prints a JSON report to stdout
- On VALID + status=draft: flips mission-state.json to "locked" and confirms
- On INVALID: lists each failed check with remediation guidance
- Redirects to `/evor-doctor` for infrastructure issues, `/evor-setup` for contract issues
