#!/usr/bin/env bash
# cross_domain_eval.sh — feed Dreamer a Researcher finding from domain A,
# assert >=1 genuine A->B transfer proposal is returned.
#
# Usage:
#   cd /path/to/oh-my-evor
#   bash ci/agentic-quality/cross_domain_eval.sh
#
# Outputs:
#   ci/out/cross-domain-raw.json     — raw Claude output
#   ci/out/cross-domain-report.json  — scored report (PASS/FAIL + transfer analysis)
#
# Requirements:
#   - Docker with image evor-ml-test
#   - $HOME/.claude/.credentials.json mounted
#
# Quota: ~$0.02–0.08 per run (1 Claude call)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$PLUGIN_DIR/ci/out"
SCENARIO="$SCRIPT_DIR/scenarios/cross_domain.txt"

mkdir -p "$OUT_DIR"

if [[ ! -f "$HOME/.claude/.credentials.json" ]]; then
  echo "ERROR: $HOME/.claude/.credentials.json not found." >&2
  exit 1
fi

# ── Run cross-domain eval ────────────────────────────────────────────────────
echo "=== Cross-Domain Transfer Eval ==="
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
  --max-turns 5 \
  > "$OUT_DIR/cross-domain-raw.json"

echo "Saved: $OUT_DIR/cross-domain-raw.json"

# ── Score ─────────────────────────────────────────────────────────────────────
echo "=== Scoring ==="
python3 "$SCRIPT_DIR/score_cross_domain.py" \
  --input "$OUT_DIR/cross-domain-raw.json" \
  --out   "$OUT_DIR/cross-domain-report.json"

echo "Report: $OUT_DIR/cross-domain-report.json"
