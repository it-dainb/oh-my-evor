#!/usr/bin/env bash
# scripts/l3-e2e.sh — L3 end-to-end release-gate proof (M11-full)
#
# Tries to install numpy + scikit-learn for the best-path sklearn backend,
# but CONTINUES to the pure-Python stdlib fallback if pip is offline or the
# install fails — never fails for missing deps; always runs real training.
#
# Exit codes mirror the Python driver:
#   0 — tabular CPU e2e completed (GPU/vision parts gated — see KNOWN_GAPS.md#L3)
#   1 — FAIL (unexpected error in the driver itself)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Best-effort install: silently skip if pip is unavailable or network is offline.
pip install -q numpy scikit-learn 2>/dev/null || true

python "${SCRIPT_DIR}/l3-e2e.py"
