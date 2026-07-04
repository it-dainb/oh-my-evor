#!/usr/bin/env bash
# dreamer_eval.sh — run Mutagen at wildness=0.2 and wildness=0.9, then score.
#
# Usage:
#   cd /path/to/oh-my-evor
#   bash ci/agentic-quality/dreamer_eval.sh
#
# Outputs:
#   ci/out/dreamer-w02.json      — raw Claude output (wildness=0.2)
#   ci/out/dreamer-w09.json      — raw Claude output (wildness=0.9)
#   ci/out/dreamer-report.json   — scored report (PASS/FAIL + metrics)
#
# Requirements:
#   - Docker with image evor-ml-test
#   - $HOME/.claude/.credentials.json mounted for real Claude subscription
#   - ANTHROPIC_API_KEY env var (can be empty string; credentials.json takes precedence)
#
# Quota: ~$0.05–0.15 per run (2 Claude calls, max-turns=5 each)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$PLUGIN_DIR/ci/out"
SCENARIO="$SCRIPT_DIR/scenarios/dreamer.txt"

mkdir -p "$OUT_DIR"

if [[ ! -f "$HOME/.claude/.credentials.json" ]]; then
  echo "ERROR: $HOME/.claude/.credentials.json not found." >&2
  echo "Mount the credentials file to run agentic evals against the real Claude." >&2
  exit 1
fi

if [[ ! -f "$SCENARIO" ]]; then
  echo "ERROR: scenario file not found: $SCENARIO" >&2
  exit 1
fi

# ── Helper: build prompt with wildness substituted ────────────────────────────
make_prompt() {
  local wildness="$1"
  sed "s/WILDNESS_PLACEHOLDER/$wildness/g" "$SCENARIO"
}

# ── Run wildness=0.2 ─────────────────────────────────────────────────────────
echo "=== Dreamer Eval: wildness=0.2 ==="
PROMPT_W02="$(make_prompt 0.2)"

docker run --rm \
  -v "$HOME/.claude/.credentials.json:/root/.claude/.credentials.json:rw" \
  -v "$PLUGIN_DIR:/plugin" \
  -w /plugin \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --entrypoint claude \
  evor-ml-test \
  --plugin-dir /plugin \
  -p "$PROMPT_W02" \
  --output-format json \
  --max-turns 5 \
  > "$OUT_DIR/dreamer-w02.json"

echo "Saved: $OUT_DIR/dreamer-w02.json"

# ── Run wildness=0.9 ─────────────────────────────────────────────────────────
echo "=== Dreamer Eval: wildness=0.9 ==="
PROMPT_W09="$(make_prompt 0.9)"

docker run --rm \
  -v "$HOME/.claude/.credentials.json:/root/.claude/.credentials.json:rw" \
  -v "$PLUGIN_DIR:/plugin" \
  -w /plugin \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --entrypoint claude \
  evor-ml-test \
  --plugin-dir /plugin \
  -p "$PROMPT_W09" \
  --output-format json \
  --max-turns 5 \
  > "$OUT_DIR/dreamer-w09.json"

echo "Saved: $OUT_DIR/dreamer-w09.json"

# ── Score ─────────────────────────────────────────────────────────────────────
echo "=== Scoring ==="
python3 "$SCRIPT_DIR/score_dreamer.py" \
  --w02 "$OUT_DIR/dreamer-w02.json" \
  --w09 "$OUT_DIR/dreamer-w09.json" \
  --out "$OUT_DIR/dreamer-report.json"

echo "Report: $OUT_DIR/dreamer-report.json"
