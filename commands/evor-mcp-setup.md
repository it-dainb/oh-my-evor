---
description: Configure the hf-mcp (Hugging Face MCP) server and HF_TOKEN for authenticated access to Papers Search, Dataset Search, and Hub Repository Details
---

# /evor-mcp-setup

This command registers the Hugging Face MCP server with Claude Code and optionally stores
an HF_TOKEN for authenticated access.

## Dispatch

1. Read the bundled skill instructions with one deterministic read:
   ```bash
   cat "${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/skills/evor-mcp-setup/SKILL.md"
   ```
   `EVOR_PLUGIN_ROOT` is exported by this plugin's SessionStart hook and `CLAUDE_PLUGIN_ROOT` by Claude Code — either points at the plugin's install directory, so this resolves regardless of your current working directory.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If `$CLAUDE_PLUGIN_ROOT` happens to be unset, fall back to a **bounded** lookup only:

```bash
find "$HOME/.claude/plugins" -path "*oh-my-evor*/skills/evor-mcp-setup/SKILL.md" 2>/dev/null | head -1
```

**Never run `find /` or scan the whole filesystem.** The skill lives inside this plugin's own directory; a full-disk search is unnecessary and will hang the session.

## Quick Reference

- Usage: `/evor-mcp-setup [--anon]`
- Manual fallback for environments where the plugin's automatic userConfig token flow does not apply (older Claude Code versions, Bedrock, Vertex)
- Checks whether `CLAUDE_PLUGIN_OPTION_HF_TOKEN` is already set (userConfig active — no action needed)
- Prompts for an HF token (read-only scope sufficient) with link to https://huggingface.co/settings/tokens; Enter to skip → anonymous mode
- Writes `HF_TOKEN=<token>` to `.evor/.env` (gitignored) for harness/script use
- Token is NEVER written to any committed file
- After writing, run `/evor-doctor` to verify the full environment
