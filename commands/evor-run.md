---
description: Load the active mission and launch the Evor tick loop
---

# /evor-run

This command loads the active mission and starts (or resumes) the Evor tick loop.

## Dispatch

1. Read the bundled skill instructions with one deterministic read — use the **Read
   tool**, not a shell command:
   ```
   Read("${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/evor-run/SKILL.md")
   ```
   This dispatch is also what an agent gets when it names this skill in its
   `skills:` frontmatter, because the command and the skill share a name and the
   command wins. `evor-tick` declares `disallowedTools: Bash` and was handed a
   `cat` — so for nine invocations across one mission it received this stub, could
   not execute it, and ran the tick without ever seeing the 9-step loop. Read is
   available to every agent; `cat` is not. If you do hold Bash, `cat` on the same
   path is equivalent.
   `EVOR_PLUGIN_ROOT` is exported by this plugin’s SessionStart hook and `CLAUDE_PLUGIN_ROOT` by Claude Code — either points at the plugin’s install directory, so this resolves regardless of your current working directory.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-run/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Usage: `/evor-run [mission-id or run-id]`
- If no argument given, reads `.evor/active-run.json` for the current run
- If no mission is set up, redirects to `/evor-setup`
- Detects existing runs automatically and offers to resume
