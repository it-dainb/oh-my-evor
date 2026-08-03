# Isolated auto-test image for the oh-my-evor Claude Code plugin.
# Builds the MCP server, installs the Python harness, installs the claude CLI,
# and runs the deterministic (no-API) test suite. The agentic layer (a real
# headless Claude driving the plugin) runs only when ANTHROPIC_API_KEY is passed.
#
# Build context is the repo ROOT (see .dockerignore). Build from repo root:
#   docker build -f ci/docker/Dockerfile -t evor-plugin-test .
FROM node:24-slim

# Python (for the harness) + git/ca-certs (claude CLI + pip)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git ca-certificates patch \
    && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI (isolated from your host session)
RUN npm install -g @anthropic-ai/claude-code@2.1.220

# Runtime limits — declared, never inherited. The spawn-depth default has moved
# twice in released Claude Code (on in 2.1.172, off in 2.1.217, back at 3 in
# 2.1.219), and a silent flip to 1 would not error: it would make every lead
# spawn fail at runtime, mid-mission. Kept identical to .claude/settings.json;
# mcp/tests/runtime-limits.test.ts asserts the two agree.
ENV CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=4
ENV CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=8
ENV CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=2000

WORKDIR /plugin
COPY . /plugin
# The container runs as the HOST uid, not root, so every file it must read has to
# be world-readable. A source file created with restrictive perms (0771) copies in
# root-owned with others=--x, and node dies with EACCES on a file that is plainly
# present — which reads as a missing file, not a permissions problem. Normalise
# here rather than relying on whatever mode each file happened to be authored with.
RUN chmod -R a+rX /plugin

# Build the TypeScript MCP server -> mcp/dist/index.cjs
RUN cd mcp && npm ci --no-audit --no-fund && npm run build

# Isolated Python venv with the harness installed (pure-python core + pydantic + pytest)
RUN python3 -m venv /venv \
    && /venv/bin/pip install --quiet --upgrade pip \
    && /venv/bin/pip install --quiet -e harness \
    && /venv/bin/pip install --quiet pytest
ENV PATH="/venv/bin:${PATH}"
# Optional: the L3 sklearn fast-path (harness stays pure-python; this only speeds L3)
RUN /venv/bin/pip install --quiet numpy scikit-learn 2>/dev/null || echo "sklearn optional path skipped"

ENV EVOR_TEST_IN_DOCKER=1
ENTRYPOINT ["node", "ci/run-checks.mjs"]
