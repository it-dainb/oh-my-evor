#!/usr/bin/env bash
# Host-side entrypoint: build the isolated test image and run the plugin's
# auto-test suite inside a container (separate from your interactive Claude).
# The container's exit code gates CI; the JSON report lands in ci/out/report.json.
#
#   bash ci/docker-test.sh                 # deterministic layer only (no API)
#   ANTHROPIC_API_KEY=sk-... bash ci/docker-test.sh   # + agentic layer
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root
IMG="${EVOR_TEST_IMAGE:-evor-plugin-test}"

echo "▶ building image $IMG (context = repo root, refs/ excluded) ..."
docker build -f ci/docker/Dockerfile -t "$IMG" . || { echo "✗ build failed"; exit 2; }

mkdir -p ci/out
RUN_ARGS=(--rm -v "$PWD/ci/out:/plugin/ci/out")
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  RUN_ARGS+=(-e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
  echo "▶ agentic layer ENABLED (ANTHROPIC_API_KEY passed through)"
else
  echo "▶ agentic layer disabled (no ANTHROPIC_API_KEY) — deterministic checks only"
fi

echo "▶ running isolated tests ..."
docker run "${RUN_ARGS[@]}" "$IMG"
code=$?
echo "▶ done (exit $code) — machine report: ci/out/report.json"
exit $code
