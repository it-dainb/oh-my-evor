#!/usr/bin/env bash
# Host entrypoint for the Phase 2 measurement: one real tick, in the container.
#
#   bash ci/bench-tick.sh              # slim CPU image
#   BENCH_MAX_TURNS=200 bash ci/bench-tick.sh
#
# Requires credentials, since this drives a real Claude: either
# CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the environment, or a
# subscription login at ~/.claude/.credentials.json (mounted read-only).
#
# The tick runs under --permission-mode bypassPermissions, which is deliberate:
# that is the mode the failed run used, and the mode `permissionDecision: "deny"`
# has to survive to be worth anything. It is also why this does not run on the
# host. Inside the container the mission lives in /bench, the working directory is
# /bench, and /plugin is the image's own copy of the repo — so an agent authoring
# code (which evor-forge-junior is supposed to do) cannot reach your checkout.
#
# Only ci/out is mounted back, and only to collect the telemetry.
set -uo pipefail
cd "$(dirname "$0")/.."

IMG="evor-plugin-test"
echo "▶ building $IMG (CPU image, pinned CLI) ..."
docker build -f ci/docker/Dockerfile -t "$IMG" . || { echo "✗ build failed"; exit 2; }

mkdir -p ci/out

# Run as the HOST uid, for two reasons:
#   1. the CLI refuses --dangerously-skip-permissions (which bypassPermissions
#      maps to) when running as root, and the image's default user is root;
#   2. ci/out is a host-owned bind mount, so writes must come from that uid.
# An arbitrary uid has no /etc/passwd entry and no home, so HOME is pointed at a
# writable path under /tmp.
CONTAINER_HOME=/tmp/home

# A host-side HOME, staged and mounted whole. Mounting only the credentials FILE
# made docker create its parent (/tmp/home/.claude) as root, so the container user
# could not create ~/.claude/session-env and EVERY Bash call failed preflight —
# the agent could read and write files but could not run a single command.
# Mounting the directory keeps it owned by the host uid, and it also means the
# session transcripts survive the container so they can be analysed afterwards.
BENCH_HOME="$(mktemp -d)"
mkdir -p "$BENCH_HOME/.claude"
cleanup() { rm -rf "$BENCH_HOME"; }
trap cleanup EXIT

RUN_ARGS=(--rm
  --user "$(id -u):$(id -g)"
  -e "HOME=$CONTAINER_HOME"
  -e "BENCH_DIR=/tmp/bench"
  # .mcp.json resolves its stdio servers through ${CLAUDE_PLUGIN_ROOT}. Unset, the
  # evor MCP server silently does not start (only the HTTP one does) and the tick
  # loop has no evor_* tools at all — the agent is left with file reads. The skill
  # dispatch in commands/ resolves through the same variable.
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
  echo "✗ no credentials — this benchmark drives a real Claude and cannot run without them."
  echo "  Export CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or log in so that"
  echo "  ~/.claude/.credentials.json exists."
  exit 2
fi

[ -n "${BENCH_TICKS:-}" ] && RUN_ARGS+=(-e "BENCH_TICKS=${BENCH_TICKS}")
[ -n "${BENCH_MAX_TURNS:-}" ] && RUN_ARGS+=(-e "BENCH_MAX_TURNS=${BENCH_MAX_TURNS}")
[ -n "${BENCH_TIMEOUT_MS:-}" ] && RUN_ARGS+=(-e "BENCH_TIMEOUT_MS=${BENCH_TIMEOUT_MS}")

echo "▶ running one tick in an isolated container ..."
docker run "${RUN_ARGS[@]}" --entrypoint node "$IMG" ci/bench-tick.mjs
code=$?

# Transcripts live in the staged HOME, which the trap is about to delete — copy
# the analysis input out first so a failed run can still be diagnosed.
if [ -d "$BENCH_HOME/.claude/projects" ]; then
  # Fresh each run, because this directory is what every downstream analysis reads
  # and leaving the previous run's files in it silently blends two runs into one
  # set of numbers — which already produced one wrong measurement.
  #
  # ARCHIVED, not deleted. The first version of this deleted, and the very next
  # A/B destroyed the transcripts of the arm it was supposed to be compared
  # against. Keeping the current run's set unambiguous does not require throwing
  # the previous one away.
  if [ -d ci/out/bench-transcripts ] && [ -n "$(ls -A ci/out/bench-transcripts 2>/dev/null)" ]; then
    prev="ci/out/bench-archive/$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$prev"
    mv ci/out/bench-transcripts/* "$prev"/ 2>/dev/null
    echo "▶ previous transcripts archived: $prev"
  fi
  mkdir -p ci/out/bench-transcripts
  find "$BENCH_HOME/.claude/projects" -name "*.jsonl" -exec cp {} ci/out/bench-transcripts/ \; 2>/dev/null
  echo "▶ transcripts: ci/out/bench-transcripts/ ($(ls ci/out/bench-transcripts 2>/dev/null | wc -l) file(s))"
fi
echo "▶ done (exit $code) — report: ci/out/bench-tick-report.json"
exit $code
