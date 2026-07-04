#!/usr/bin/env bash
# judge.sh — LLM judge eval: score Dreamer proposals on a 1-10 rubric.
#
# Usage:
#   cd /path/to/oh-my-evor
#   bash ci/agentic-quality/judge.sh [path/to/proposals.json]
#
# If no proposals path is provided, uses ci/out/dreamer-w09.json (wildness=0.9
# output from dreamer_eval.sh).
#
# Outputs:
#   ci/out/judge-raw.json       — raw Claude judge output
#   ci/out/judge-report.json    — parsed judge scores + ranking
#
# Requirements:
#   - Docker with image evor-ml-test
#   - $HOME/.claude/.credentials.json mounted
#
# Quota: ~$0.03–0.10 per run (1 Claude call, max-turns=3)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$PLUGIN_DIR/ci/out"
JUDGE_PROMPT_TEMPLATE="$SCRIPT_DIR/scenarios/judge.txt"
PROPOSALS_PATH="${1:-$OUT_DIR/dreamer-w09.json}"

mkdir -p "$OUT_DIR"

if [[ ! -f "$HOME/.claude/.credentials.json" ]]; then
  echo "ERROR: $HOME/.claude/.credentials.json not found." >&2
  exit 1
fi

if [[ ! -f "$PROPOSALS_PATH" ]]; then
  echo "ERROR: proposals file not found: $PROPOSALS_PATH" >&2
  echo "Run dreamer_eval.sh first to generate ci/out/dreamer-w09.json" >&2
  exit 1
fi

# ── Extract proposals JSON and embed in judge prompt ─────────────────────────
echo "=== Preparing judge prompt ==="
# Extract the .result field (Claude's response text) from the raw output
PROPOSALS_JSON="$(python3 -c "
import json, sys
raw = json.load(open('$PROPOSALS_PATH'))
text = raw.get('result', '')
# Try to parse as JSON; fallback to raw text
try:
    data = json.loads(text)
    proposals = data.get('proposals', [])
    print(json.dumps(proposals, indent=2))
except:
    print(text[:4000])
")"

PROMPT="$(sed "s|{{PROPOSALS_JSON}}|${PROPOSALS_JSON}|g" "$JUDGE_PROMPT_TEMPLATE")"

# ── Run judge eval ────────────────────────────────────────────────────────────
echo "=== Judge Eval ==="

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
  --max-turns 3 \
  > "$OUT_DIR/judge-raw.json"

echo "Saved: $OUT_DIR/judge-raw.json"

# ── Parse and print summary ───────────────────────────────────────────────────
echo "=== Judge Summary ==="
python3 - <<'PYEOF'
import json, sys
from pathlib import Path

raw = json.loads(Path("ci/out/judge-raw.json").read_text())
if raw.get("is_error"):
    print(f"ERROR: Claude returned an error: {raw.get('result', '')}", file=sys.stderr)
    sys.exit(1)

text = raw.get("result", "")
try:
    # Strip markdown code fence if present
    import re
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    data = json.loads(m.group(1) if m else text)
except Exception as e:
    print(f"WARNING: could not parse judge output as JSON: {e}", file=sys.stderr)
    print(text[:1000])
    sys.exit(0)

Path("ci/out/judge-report.json").write_text(json.dumps(data, indent=2))
print(f"Top pick:  {data.get('top_pick', 'N/A')}")
print(f"Rationale: {data.get('top_pick_rationale', '')[:200]}")
print()
for p in data.get("proposals_judged", []):
    print(f"  [{p['proposal_id']}] composite={p.get('composite_score', '?'):.2f}  "
          f"rec={p.get('recommendation', '?')}")
if data.get("red_flags"):
    print("\nRed flags:")
    for rf in data["red_flags"]:
        print(f"  [WARN] {rf}")
print(f"\nReport: ci/out/judge-report.json")
PYEOF
