#!/usr/bin/env bash
# Host entrypoint for the execution-graded forge-junior MODEL-TIER eval.
#
#   bash ci/forge-eval.sh
#   FORGE_EVAL_TIERS='haiku:high' FORGE_EVAL_REPEATS=1 \
#     FORGE_EVAL_CASES=evals/forge-junior/cases.json bash ci/forge-eval.sh
#
# Same container pattern and the same reasoning as ci/agent-eval.sh: pinned CLI,
# host uid (the CLI refuses --dangerously-skip-permissions as root), throwaway
# HOME, only ci/out mounted back.
#
# DIFFERENT FROM agent-eval.sh IN ONE IMPORTANT WAY: this role WRITES FILES. The
# agent is pointed at a candidate worktree under /tmp inside the container, which
# is discarded with the container. Nothing it writes can reach the working
# checkout — which matters more here than for the Selector eval, where the agent
# only ever emitted text.
set -uo pipefail
cd "$(dirname "$0")/.."

IMG="evor-plugin-test"
echo "▶ building $IMG (CPU image, pinned CLI) ..."
docker build -f ci/docker/Dockerfile -t "$IMG" . || { echo "✗ build failed"; exit 2; }

mkdir -p ci/out

CONTAINER_HOME=/tmp/home
BENCH_HOME="$(mktemp -d)"
mkdir -p "$BENCH_HOME/.claude"
cleanup() { rm -rf "$BENCH_HOME"; }
trap cleanup EXIT

RUN_ARGS=(--rm
  --user "$(id -u):$(id -g)"
  -e "HOME=$CONTAINER_HOME"
  -e "CLAUDE_PLUGIN_ROOT=/plugin"
  -e "EVOR_PLUGIN_ROOT=/plugin"
  -e "FORGE_EVAL_WORKROOT=/tmp/forge-eval"
  -v "$BENCH_HOME:$CONTAINER_HOME"
  -v "$PWD/ci/out:/plugin/ci/out")

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  RUN_ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}")
  echo "▶ auth: subscription token"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  RUN_ARGS+=(-e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
  echo "▶ auth: API key"
elif [ -f "$HOME/.claude/.credentials.json" ]; then
  cp "$HOME/.claude/.credentials.json" "$BENCH_HOME/.claude/.credentials.json"
  chmod 600 "$BENCH_HOME/.claude/.credentials.json"
  echo "▶ auth: subscription credentials staged into a throwaway container HOME"
else
  echo "✗ no credentials — this harness drives real Claude calls and cannot run without them."
  exit 2
fi

# Forward every FORGE_EVAL_* / pricing override the caller set. Without this the
# container silently runs the DEFAULT tiers/cases no matter what was asked for —
# the same unreachable-config bug BENCH_MISSION/BENCH_EFFORT already hit.
for var in FORGE_EVAL_CASES FORGE_EVAL_AGENT_FILE FORGE_EVAL_TIERS FORGE_EVAL_ARMS FORGE_EVAL_REPEATS \
           FORGE_EVAL_MAX_TURNS FORGE_EVAL_TIMEOUT_MS FORGE_EVAL_EVAL_TIMEOUT_MS \
           FORGE_EVAL_CONCURRENCY EVOR_PRICING_DATE; do
  if [ -n "${!var:-}" ]; then
    RUN_ARGS+=(-e "$var=${!var}")
  fi
done

echo "▶ running the tier x case x repeat matrix in an isolated container ..."
docker run "${RUN_ARGS[@]}" --entrypoint node "$IMG" ci/forge-eval.mjs
code=$?

echo "▶ done (exit $code) — report: ci/out/forge-eval-evor-forge-junior.json"
exit $code
