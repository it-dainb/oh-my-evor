#!/usr/bin/env bash
# scripts/l3-e2e.sh — L3 end-to-end release-gate proof (M11-full)
#
# Delegates to scripts/l3-e2e.py which runs 3+ real tick iterations on the
# tabular-churn CPU benchmark (sklearn, seed=42). GPU/vision parts are gated
# — see KNOWN_GAPS.md#L3. Exit code mirrors the Python driver:
#   0 — GATED/PASS (tabular CPU e2e completed; GPU parts gated)
#   1 — FAIL (unexpected error)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python "${SCRIPT_DIR}/l3-e2e.py"
