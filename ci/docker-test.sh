#!/usr/bin/env bash
# Host-side entrypoint: build the isolated test image and run the plugin's
# auto-test suite inside a container (separate from your interactive Claude).
#
#   bash ci/docker-test.sh              # slim image, deterministic layer only
#   bash ci/docker-test.sh --ml         # full ML image (torch/numpy/cv2)
#   CLAUDE_CODE_OAUTH_TOKEN=... bash ci/docker-test.sh --ml   # + real-Claude layer (subscription)
#   ANTHROPIC_API_KEY=...       bash ci/docker-test.sh        # + real-Claude layer (API key)
#
# Subscription token: generate once on the host with `claude setup-token`,
# then export CLAUDE_CODE_OAUTH_TOKEN before running. It uses your Max quota,
# not API billing. The container unsets ANTHROPIC_API_KEY so the token wins.
set -uo pipefail
cd "$(dirname "$0")/.."   # repo root

DOCKERFILE="ci/docker/Dockerfile"
IMG="evor-plugin-test"
if [ "${1:-}" = "--ml" ]; then
  DOCKERFILE="ci/docker/Dockerfile.ml"; IMG="evor-ml-test"
  echo "▶ FULL ML image (torch/numpy/cv2 + Claude CLI + Agent SDK)"
fi

echo "▶ building $IMG from $DOCKERFILE (context = repo root, refs/ excluded) ..."
docker build -f "$DOCKERFILE" -t "$IMG" . || { echo "✗ build failed"; exit 2; }

mkdir -p ci/out
RUN_ARGS=(--rm -v "$PWD/ci/out:/plugin/ci/out")
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  RUN_ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}")
  echo "▶ real-Claude layer ENABLED via SUBSCRIPTION token (CLAUDE_CODE_OAUTH_TOKEN)"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  RUN_ARGS+=(-e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
  echo "▶ real-Claude layer ENABLED via API key"
else
  echo "▶ real-Claude layer disabled (no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) — deterministic checks only"
fi

echo "▶ running isolated tests ..."
docker run "${RUN_ARGS[@]}" "$IMG"
code=$?
echo "▶ done (exit $code) — machine report: ci/out/report.json"
exit $code
