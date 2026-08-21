#!/usr/bin/env bash
# Host entrypoint for the per-agent MODEL-TIER eval harnesses.
#
#   bash ci/agent-eval.sh
#   AGENT_EVAL_REPEATS=5 AGENT_EVAL_TIERS='haiku:high,sonnet:medium' bash ci/agent-eval.sh
#   bash ci/agent-eval.sh ci/forge-gate-eval.mjs      # evor-forge's capability gate
#   bash ci/agent-eval.sh ci/role-eval.mjs evals/probe/spec.json
#
# The optional argument selects WHICH harness runs inside the container. Every
# harness here has the same shape (a tier x case x repeat matrix over the real
# CLI, writing ci/out/agent-eval-<role>.json), so they share one container
# recipe rather than each growing a near-identical copy of this file.
#
# Requires credentials, since this drives real Claude calls: either
# CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the environment, or a
# subscription login at ~/.claude/.credentials.json (mounted read-only).
#
# Same container pattern as ci/bench-tick.sh: builds the existing bench image
# (which already has the pinned claude CLI installed and this repo copied to
# /plugin), runs as the HOST uid with a staged throwaway HOME, and mounts only
# ci/out back so a case run cannot touch the working checkout.
set -uo pipefail
cd "$(dirname "$0")/.."

EVAL_SCRIPT="${1:-ci/agent-eval.mjs}"
if [ ! -f "$EVAL_SCRIPT" ]; then
  echo "✗ no such harness script: $EVAL_SCRIPT"
  exit 2
fi
# Anything after the script name is forwarded to it. ci/role-eval.mjs takes the
# spec path this way, so a role is selected by argument rather than by yet
# another env var the container might silently ignore.
shift || true
SCRIPT_ARGS=("$@")
for a in "${SCRIPT_ARGS[@]}"; do
  if [ ! -e "$a" ]; then
    echo "✗ no such file passed to $EVAL_SCRIPT: $a"
    exit 2
  fi
done

IMG="evor-plugin-test"
echo "▶ building $IMG (CPU image, pinned CLI) ..."
docker build -f ci/docker/Dockerfile -t "$IMG" . || { echo "✗ build failed"; exit 2; }

mkdir -p ci/out

# Run as the HOST uid: the CLI refuses --dangerously-skip-permissions when run
# as root (the image's default user), and ci/out is a host-owned bind mount.
# An arbitrary uid has no /etc/passwd entry and no home, so HOME is pointed at
# a writable path under /tmp — same reasoning as ci/bench-tick.sh.
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
  echo "  Export CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or log in so that"
  echo "  ~/.claude/.credentials.json exists."
  exit 2
fi

# Forward every AGENT_EVAL_* / pricing override the caller set. Without this
# the container silently runs the DEFAULT role/tiers/cases no matter what the
# caller asked for — unreachable-config is the same shape ci/bench-tick.sh's
# BENCH_MISSION/BENCH_EFFORT comment already warns about.
for var in AGENT_EVAL_ROLE AGENT_EVAL_CASES AGENT_EVAL_AGENT_FILE AGENT_EVAL_TIERS \
           AGENT_EVAL_REPEATS AGENT_EVAL_MAX_TURNS AGENT_EVAL_TIMEOUT_MS \
           FORGE_GATE_CASES FORGE_GATE_AGENT_FILE FORGE_GATE_TIERS \
           FORGE_GATE_REPEATS FORGE_GATE_MAX_TURNS FORGE_GATE_TIMEOUT_MS \
           ROLE_EVAL_TIERS ROLE_EVAL_REPEATS ROLE_EVAL_MAX_TURNS \
           ROLE_EVAL_TIMEOUT_MS ROLE_EVAL_OUT \
           EVOR_PRICING_DATE; do
  if [ -n "${!var:-}" ]; then
    RUN_ARGS+=(-e "$var=${!var}")
  fi
done

echo "▶ running $EVAL_SCRIPT (tier x case x repeat) in an isolated container ..."
docker run "${RUN_ARGS[@]}" --entrypoint node "$IMG" "$EVAL_SCRIPT" "${SCRIPT_ARGS[@]}"
code=$?

echo "▶ done (exit $code) — report: ci/out/agent-eval-<role>.json"
exit $code
