#!/usr/bin/env bash
# researcher_eval.sh — run Sage researcher scenario and score the output.
#
# Usage:
#   cd /path/to/oh-my-evor
#   bash ci/agentic-quality/researcher_eval.sh
#
# Outputs:
#   ci/out/researcher-raw.json      — raw Claude output
#   ci/out/researcher-report.json   — scored report (PASS/FAIL + finding analysis)
#
# Requirements:
#   - Docker with image evor-ml-test
#   - $HOME/.claude/.credentials.json mounted for real Claude subscription
#   - --permission-mode bypassPermissions required: Sage uses academic MCPs
#     (Consensus) and WebSearch to verify citations; without bypass, those
#     tool calls will be denied and the research will be incomplete.
#
# Quota: ~$0.05–0.20 per run (1 Claude call, max-turns=12)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$PLUGIN_DIR/ci/out"
SCENARIO="$SCRIPT_DIR/scenarios/researcher.txt"

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

# ── Run researcher eval ───────────────────────────────────────────────────────
echo "=== Researcher (Sage) Eval ==="
PROMPT="$(cat "$SCENARIO")"

docker run --rm \
  -v "$HOME/.claude/.credentials.json:/root/.claude/.credentials.json:rw" \
  -v "$PLUGIN_DIR:/plugin" \
  -w /plugin \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --entrypoint claude \
  evor-ml-test \
  --plugin-dir /plugin \
  -p "$PROMPT" \
  --output-format json \
  --permission-mode bypassPermissions \
  --max-turns 12 \
  > "$OUT_DIR/researcher-raw.json"

echo "Saved: $OUT_DIR/researcher-raw.json"

# ── Score ─────────────────────────────────────────────────────────────────────
echo "=== Scoring ==="
python3 "$SCRIPT_DIR/score_researcher.py" \
  --input "$OUT_DIR/researcher-raw.json" \
  --out   "$OUT_DIR/researcher-report.json"

echo "Report: $OUT_DIR/researcher-report.json"
