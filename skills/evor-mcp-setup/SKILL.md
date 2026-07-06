---
name: evor-mcp-setup
description: Manual fallback for storing HF_TOKEN in .evor/.env when the plugin's automatic userConfig token flow is unavailable (older Claude Code versions, Bedrock, or Vertex deployments)
argument-hint: "[--anon]"
level: 2
---

<Purpose>
The oh-my-evor plugin prompts for your HF token at enable time via the built-in userConfig flow —
Claude Code stores it securely in the system keychain and exports it as
`CLAUDE_PLUGIN_OPTION_HF_TOKEN`. Sage and Acquirer pick it up automatically.

Use this skill only when that automatic flow does not apply:
- Older Claude Code versions that predate userConfig support.
- Bedrock / Vertex / Foundry deployments where plugin userConfig is not available.
- You want a local `.evor/.env` file for harness scripts that read `HF_TOKEN` from the environment
  directly (independent of Claude Code session context).

The HF token is NEVER written to any committed file. The only safe storage path covered here is
a gitignored `.evor/.env` file. Token with read-only scope is sufficient — write permissions are
not required.
</Purpose>

<Use_When>
- Sage or Acquirer reports authentication failures against Hugging Face MCP tools and
  `CLAUDE_PLUGIN_OPTION_HF_TOKEN` is not set in the session environment
- You are on an older Claude Code version or a non-first-party deployment (Bedrock/Vertex) where
  the plugin userConfig prompt did not run at enable time
- You want to write `HF_TOKEN` to `.evor/.env` for use by harness scripts outside Claude Code
</Use_When>

<Do_Not_Use_When>
- `CLAUDE_PLUGIN_OPTION_HF_TOKEN` is already set — userConfig is working; no action needed
- You want to set up the full Evor environment — use `/evor-setup`
- You only want to test the HF MCP tools — check `claude mcp list` directly
</Do_Not_Use_When>

<Steps>

## Step 1 — Check if userConfig token is already active

Check the session environment for `CLAUDE_PLUGIN_OPTION_HF_TOKEN`. If it is set and non-empty,
print:
```
HF token is already available via userConfig (CLAUDE_PLUGIN_OPTION_HF_TOKEN is set).
No manual setup needed. Sage and Acquirer will use it automatically.

If you still want to write it to .evor/.env for script use, continue; otherwise stop here.
```
and offer to proceed to Step 3 (optional .evor/.env write) or stop.

## Step 2 — Prompt for HF_TOKEN

Print exactly:
```
Hugging Face Token Setup (manual fallback)
==========================================
An HF token grants authenticated access to Papers Search, Dataset Search, and Hub
Repository Details. Read-only scope is sufficient.

Generate a token (read-only scope) at:
  https://huggingface.co/settings/tokens

Paste your token below, or press Enter to skip (anonymous access — public resources only,
lower rate limits):
```

Read the user's input:
- If the user provides a non-empty token string → `TOKEN=<provided value>`
- If the user presses Enter (empty input) → `TOKEN=""` (anonymous mode — skip to Step 4)

## Step 3 — Write token to .evor/.env

Create `.evor/` if absent:
```bash
mkdir -p .evor
```

Append (do not overwrite other entries):
```bash
echo "HF_TOKEN=<TOKEN>" >> .evor/.env
```

Print: "Written to .evor/.env. Ensure .evor/.env is listed in .gitignore before committing
(the Evor main agent adds this line during /evor-setup)."

Do NOT create or modify `.gitignore` yourself from this skill.

Harness reads the token via:
```
os.environ.get("HF_TOKEN") or os.environ.get("CLAUDE_PLUGIN_OPTION_HF_TOKEN", "")
```

## Step 4 — Verify and print next steps

Check whether `hf-mcp` appears in `claude mcp list`. Print:

```
=== HF token setup result ===

  Token stored:  .evor/.env  (or: skipped — anonymous mode)
  userConfig:    CLAUDE_PLUGIN_OPTION_HF_TOKEN <set | not set>

Next steps:
  - If on a supported Claude Code version, re-enable the oh-my-evor plugin to trigger
    the userConfig token prompt (preferred path — stores token in system keychain).
  - Run /evor-doctor to verify the full environment.
  - Sage and Acquirer discover hf-mcp tools automatically via ToolSearch.
```

</Steps>

<Security_Notes>
- The HF token MUST NEVER be written to any committed file — not plugin.json, not
  CLAUDE.md, not any agent prompt, not .mcp.json in the project root.
- `.evor/.env` is acceptable only when the user explicitly consents AND `.evor/.env` is
  listed in `.gitignore`. This skill does not add the .gitignore entry — the Evor main
  agent owns .gitignore.
- Read-only token scope is sufficient for all Sage and Acquirer use cases. Do not
  request or store tokens with write permissions.
- If the user pastes a token with write permissions, note: "Write-scope token detected.
  Consider downgrading to a read-only token at https://huggingface.co/settings/tokens
  for minimum-privilege access. The setup will proceed with the provided token."
</Security_Notes>

<Tool_Usage>
- `Bash` — `mkdir -p .evor`, `echo "HF_TOKEN=..." >> .evor/.env`, `claude mcp list`
- `Read` — verify .evor/.env after write (optional)
</Tool_Usage>
