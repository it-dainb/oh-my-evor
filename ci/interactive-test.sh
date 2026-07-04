#!/usr/bin/env bash
# Drive a REAL interactive Claude Code session (the actual TUI, not `claude -p`)
# with the oh-my-evor plugin loaded, type a scripted sequence of commands as a
# user would, then validate against the session's JSONL transcript + hook log.
#
# This reflects real user behavior far better than headless -p. It needs auth:
#   subscription:  export CLAUDE_CODE_OAUTH_TOKEN=$(on host: claude setup-token)
#   or API key:    export ANTHROPIC_API_KEY=...
#
# Usage (host or inside the ML container which has tmux):
#   CLAUDE_CODE_OAUTH_TOKEN=... bash ci/interactive-test.sh
set -uo pipefail
cd "$(dirname "$0")/.."
PLUGIN_DIR="$PWD"
SESSION="evor-cc-$$"
OUT="ci/out"; mkdir -p "$OUT"
PANE_LOG="$OUT/interactive-pane.txt"
AUDIT_LOG="$OUT/hook-audit.jsonl"; : > "$AUDIT_LOG"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]; then
  echo "✗ no auth. Set CLAUDE_CODE_OAUTH_TOKEN (subscription, from 'claude setup-token') or ANTHROPIC_API_KEY."; exit 3
fi
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && unset ANTHROPIC_API_KEY  # force subscription

command -v tmux >/dev/null || { echo "✗ tmux not installed (apt-get install tmux)"; exit 3; }

# A test settings.json that appends every hook event to the audit log — a
# deterministic, structured record of what the plugin/agent actually did.
SETTINGS_DIR="$(mktemp -d)"; mkdir -p "$SETTINGS_DIR/.claude"
cat > "$SETTINGS_DIR/.claude/settings.json" <<JSON
{ "hooks": {
    "PostToolUse": [ { "hooks": [ { "type": "command", "command": "cat >> $PWD/$AUDIT_LOG" } ] } ],
    "Stop":        [ { "hooks": [ { "type": "command", "command": "cat >> $PWD/$AUDIT_LOG" } ] } ] } }
JSON

wait_idle() { # poll capture-pane for the prompt cursor (idle) up to $1 sec
  for _ in $(seq 1 "${1:-60}"); do
    tmux capture-pane -p -t "$SESSION" 2>/dev/null | grep -qE '❯|>' && return 0
    sleep 1
  done; return 1
}

echo "▶ launching interactive Claude (TUI) with oh-my-evor loaded ..."
tmux new-session -d -s "$SESSION" -x 220 -y 50 \
  "CLAUDE_CONFIG_DIR='$SETTINGS_DIR/.claude' claude --plugin-dir '$PLUGIN_DIR' --permission-mode bypassPermissions"
wait_idle 30 || { echo "✗ TUI did not become ready"; tmux capture-pane -p -t "$SESSION" | tail -20; tmux kill-session -t "$SESSION" 2>/dev/null; exit 1; }

send() { echo "  › typing: $1"; tmux send-keys -t "$SESSION" "$1" Enter; wait_idle "${2:-90}"; }

# ── scripted user session ────────────────────────────────────────────────
send "/help"                              20    # do the plugin's commands appear?
send "What oh-my-evor slash-commands are available? Name them." 60
send "/oh-my-evor:evor-setup"             120   # exercise a real skill

tmux capture-pane -p -t "$SESSION" -S - > "$PANE_LOG"
tmux kill-session -t "$SESSION" 2>/dev/null

# ── validate: transcript JSONL + rendered pane + hook audit ──────────────
SLUG=$(echo "$PLUGIN_DIR" | sed 's/[^a-zA-Z0-9]/-/g')
TRANSCRIPT=$(ls -t "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$SLUG/"*.jsonl 2>/dev/null | head -1 || true)
[ -z "$TRANSCRIPT" ] && TRANSCRIPT=$(ls -t "$SETTINGS_DIR/.claude/projects/$SLUG/"*.jsonl 2>/dev/null | head -1 || true)

pass=0; fail=0
check() { if eval "$2"; then echo "  [PASS] $1"; pass=$((pass+1)); else echo "  [FAIL] $1"; fail=$((fail+1)); fi; }
echo "▶ validating ..."
check "plugin commands visible in /help"       "grep -qi 'evor' '$PANE_LOG'"
check "assistant named evor skills"            "grep -qiE 'evor-setup|evor-run|evor-dashboard' '$PANE_LOG'"
check "transcript JSONL was written"           "[ -n '$TRANSCRIPT' ] && [ -s '$TRANSCRIPT' ]"
check "hook audit captured events"             "[ -s '$AUDIT_LOG' ]"

echo "▶ artifacts: pane=$PANE_LOG  transcript=${TRANSCRIPT:-<none>}  audit=$AUDIT_LOG"
echo "▶ interactive result: $pass passed / $fail failed"
[ "$fail" -eq 0 ]
