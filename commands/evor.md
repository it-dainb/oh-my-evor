---
description: Start or continue the Evor 9-step evolution tick loop for the active mission
---

# /evor

This command starts or continues the Evor evolution loop for the active mission.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "$CLAUDE_PLUGIN_ROOT/skills/evor/SKILL.md"
   ```
   Claude Code sets `CLAUDE_PLUGIN_ROOT` to this plugin's install directory, so this resolves no matter what your current working directory is.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Runs the 9-step tick loop: Select → Ideate → Hypothesis Registration → Critique → Implement+Run → Evaluate+Integrity → Analyze+Learn → Record → Prune/Promote → Loop/Stop
- Meta-evolution runs every 5 ticks by default
- Stop with Ctrl+C or cancel with `/oh-my-claudecode:cancel`
- Requires an active GoalContract — run `/evor-setup` first if none exists
