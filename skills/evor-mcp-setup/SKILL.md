---
name: evor-mcp-setup
description: Configure the hf-mcp (Hugging Face MCP) server and HF_TOKEN for Evor — sets up authenticated access to Papers Search, Dataset Search, and Hub Repository Details
argument-hint: "[--anon]"
level: 2
---

<Purpose>
evor-mcp-setup registers the Hugging Face MCP server (`hf-mcp`) with Claude Code and
optionally stores an HF_TOKEN for authenticated access.  Authenticated access raises
rate limits and unlocks gated model/dataset metadata.  Anonymous (no-token) access works
for public resources at reduced rate limits — always a valid fallback.

The HF token is NEVER written to any committed file.  The only two safe storage paths are:
  1. `claude mcp add --scope user` → writes to `~/.claude.json` (user-level, gitignored)
  2. A gitignored `.evor/.env` file (the main Evor agent ensures `.evor/.env` is in
     `.gitignore`; do NOT create or commit `.gitignore` yourself from this skill)

Token with read-only scope is sufficient — write permissions are not required.
</Purpose>

<Use_When>
- User says "setup hf-mcp", "configure hf token", "evor mcp setup", or invokes `/evor-mcp-setup`
- `claude mcp list` does not show `hf-mcp`
- Sage or Acquirer reports authentication failures against Hugging Face MCP tools
- User wants to upgrade from anonymous to authenticated HF access
</Use_When>

<Do_Not_Use_When>
- `hf-mcp` already appears in `claude mcp list` and the user only wants to test it — use
  `claude mcp list` directly
- User wants to set up the full Evor environment — use `/evor-setup` (which calls this if
  needed)
</Do_Not_Use_When>

<Steps>

## Step 1 — Check current MCP state

```bash
claude mcp list
```

If `hf-mcp` is already present, print:
```
hf-mcp is already registered. To re-configure, remove it first:
  claude mcp remove hf-mcp --scope user
Then re-run /evor-mcp-setup.
```
and stop.

## Step 2 — Prompt for HF_TOKEN

Print exactly:
```
Hugging Face MCP Setup
======================
An HF token grants authenticated access to Papers Search, Dataset Search, and Hub
Repository Details.  Read-only scope is sufficient.

Generate a token (read-only scope) at:
  https://huggingface.co/settings/tokens

Paste your token below, or press Enter to skip (anonymous access — public resources only,
lower rate limits):
```

Read the user's input:
- If the user provides a non-empty token string → `TOKEN=<provided value>`
- If the user presses Enter (empty input) → `TOKEN=""` (anonymous mode)

## Step 3 — Register hf-mcp with Claude Code

**Option A — Token provided (recommended):**
```bash
claude mcp add --scope user --transport http hf-mcp https://huggingface.co/mcp \
  --header "Authorization: Bearer <TOKEN>"
```
This writes the server entry (including the token in the header) to `~/.claude.json`.
The token is stored at user scope — it is never in the project directory and never
committed to git.

**Option B — Anonymous (Enter was pressed):**
```bash
claude mcp add --scope user --transport http hf-mcp https://huggingface.co/mcp
```
No Authorization header is set.  Public HF resources are accessible at anonymous rate
limits.

Run the appropriate command, then proceed to Step 4.

## Step 4 — Optional: write token to .evor/.env (token provided only)

If a token was provided AND the user wants a local `.evor/.env` fallback (for scripts or
harness runs that read `HF_TOKEN` from the environment), offer:

```
Would you also like to write HF_TOKEN to .evor/.env for harness/script use?
This file must be gitignored — Evor's main agent manages the .gitignore entry.
Type 'yes' to write, or press Enter to skip:
```

If the user says yes:
  1. Create `.evor/` if absent: `mkdir -p .evor`
  2. Append (do not overwrite other entries):
     ```bash
     echo "HF_TOKEN=<TOKEN>" >> .evor/.env
     ```
  3. Print: "Written to .evor/.env. Ensure .evor/.env is listed in .gitignore before
     committing (the Evor main agent adds this line during /evor-setup)."

Do NOT create or modify `.gitignore` yourself from this skill.

## Step 5 — Verify registration

```bash
claude mcp list
```

Check that `hf-mcp` appears in the output.  Print:

```
=== hf-mcp registration result ===

  Status:   registered  (or: NOT found — see below)
  Scope:    user  (~/.claude.json)
  Transport: http
  URL:      https://huggingface.co/mcp
  Auth:     Bearer token  (or: anonymous)

Next steps:
  - Restart your Claude Code session so the new MCP server is loaded.
  - Run /evor-doctor to verify the full environment.
  - Sage and Acquirer will discover the hf-mcp tools in their tool list automatically.
```

If `hf-mcp` does NOT appear in `claude mcp list` after registration, print the error
from the `claude mcp add` command and suggest:
```
Registration failed. Common causes:
  - claude CLI not in PATH: ensure Claude Code CLI is installed and on PATH
  - --scope user not supported in this Claude Code version: try without --scope user
    (omitting scope writes to project .claude/settings.json instead of ~/.claude.json)
  - Network error: check internet connectivity
```

</Steps>

<Security_Notes>
- The HF token MUST NEVER be written to any committed file — not plugin.json, not
  CLAUDE.md, not any agent prompt, not .mcp.json in the project root.
- `~/.claude.json` (user scope via `claude mcp add --scope user`) is the preferred
  storage location — it is outside the project tree and never committed.
- `.evor/.env` is an acceptable secondary store only when the user explicitly consents
  (Step 4) AND `.evor/.env` is listed in `.gitignore`.  This skill does not add the
  .gitignore entry — the Evor main agent owns .gitignore.
- Read-only token scope is sufficient for all Sage and Acquirer use cases.  Do not
  request or store tokens with write permissions.
- If the user pastes a token with write permissions, note: "Write-scope token detected.
  Consider downgrading to a read-only token at https://huggingface.co/settings/tokens
  for minimum-privilege access.  The setup will proceed with the provided token."
</Security_Notes>

<Tool_Usage>
- Bash — `claude mcp list`, `claude mcp add`, `mkdir -p .evor`, `echo ... >> .evor/.env`
- Read — verify .evor/.env after write (optional)
</Tool_Usage>
