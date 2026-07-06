#!/usr/bin/env bash
# oh-my-evor — one-time install bootstrap.
# Builds the MCP server bundle and installs the Python harness so the plugin
# is ready for Claude Code. Safe to re-run (idempotent).
#
#   Usage:  ./install.sh
#
# Prereqs (must already be on PATH):
#   - Node >= 18   (builds mcp/dist/index.cjs, which .mcp.json launches)
#   - Python >= 3.10 + pip   (the harness the MCP tools shell out to)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "==> oh-my-evor install (root: $ROOT)"

# --- prereq checks -----------------------------------------------------------
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found (need Node >= 18)"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "ERROR: npm not found"; exit 1; }
PY="${EVOR_PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "ERROR: $PY not found (need Python >= 3.10)"; exit 1; }
echo "    node $(node -v) | $($PY --version)"

# --- 1. build the MCP server bundle -----------------------------------------
echo "==> [1/2] Building MCP server (mcp/dist/index.cjs)"
cd "$ROOT/mcp"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
npm run build
test -f dist/index.cjs || { echo "ERROR: build did not produce mcp/dist/index.cjs"; exit 1; }
echo "    built: $(du -h dist/index.cjs | cut -f1) dist/index.cjs"

# --- 2. install the Python harness ------------------------------------------
echo "==> [2/2] Installing Python harness (editable)"
cd "$ROOT"
"$PY" -m pip install -e ./harness
"$PY" -c "import evor" >/dev/null 2>&1 || { echo "ERROR: 'import evor' failed after install"; exit 1; }
echo "    harness importable: $($PY -c 'import evor,os;print(os.path.dirname(evor.__file__))')"

cat <<EOF

==> Done. Next, register the plugin with Claude Code:

    /plugin marketplace add $ROOT
    /plugin install oh-my-evor@oh-my-evor

  (or point '/plugin marketplace add' at the git URL once pushed).
  For real ML runs, also install your compute deps (e.g. torch, transformers).
EOF
