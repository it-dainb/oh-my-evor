---
description: Start or continue the Evor 9-step evolution tick loop for the active mission
---

# /evor

This command starts or continues the Evor evolution loop for the active mission.

## Dispatch

1. Read the full bundled skill instructions from `skills/evor/SKILL.md`.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If the file is not directly readable from the current working directory, locate it under the active plugin root (`CLAUDE_PLUGIN_ROOT` or the directory containing `.claude-plugin/plugin.json`), then continue.

## Quick Reference

- Runs the 9-step tick loop: Select → Ideate → Hypothesis Registration → Critique → Implement+Run → Evaluate+Integrity → Analyze+Learn → Record → Prune/Promote → Loop/Stop
- Meta-evolution runs every 5 ticks by default
- Stop with Ctrl+C or cancel with `/oh-my-claudecode:cancel`
- Requires an active GoalContract — run `/evor-setup` first if none exists
