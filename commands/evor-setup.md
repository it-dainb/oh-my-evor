---
description: Run the Evor mission setup interview to set up a mission and its run
---

# /evor-setup

This command conducts the Evor mission setup interview, setting up the mission and initializing all run infrastructure.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/evor-setup/SKILL.md"
   ```
   `EVOR_PLUGIN_ROOT` is exported by this plugin’s SessionStart hook and `CLAUDE_PLUGIN_ROOT` by Claude Code — either points at the plugin’s install directory, so this resolves regardless of your current working directory.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-setup/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Usage: `/evor-setup [mission description]`
- Conducts a 13-question Socratic interview covering: task, dataset, mode, metrics, baseline/target, budget, wildness, mission type (fixed vs open-ended), SOTA sources (open-ended only), coverage target (open-ended only), license allowlist, and compute budget confirmation (open-ended only)
- Initializes frozen data splits (Pillar 2) — files set to chmod 444
- Creates initial EvalSuite v1 (Pillar 3)
- Runs a preflight smoke-train to verify the environment
- Requires explicit "start" confirmation before writing any run state
- After setup completes, the mission and its run are fully initialized and ready to use
- After setup completes, run `/evor-run` to start the tick loop
