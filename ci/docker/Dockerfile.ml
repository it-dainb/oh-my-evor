# Full ML dev/test container for oh-my-evor: real Claude Code CLI + Agent SDK +
# a standard ML stack (torch, numpy, opencv, scikit-learn, pandas). This is the
# environment where oh-my-evor can run REAL training missions (the vision path
# that is GPU-gated in the slim image becomes runnable on CPU here, and on GPU
# if the image is built on a CUDA base + run with `--gpus all`).
#
# Auth: pass your Claude SUBSCRIPTION via `-e CLAUDE_CODE_OAUTH_TOKEN=...`
#   (generate once on the host with `claude setup-token`). ANTHROPIC_API_KEY is
#   explicitly unset so the subscription token wins the auth precedence.
#
# Build from repo root:  docker build -f ci/docker/Dockerfile.ml -t evor-ml-test .
# CPU by default. For GPU: change base to nvidia/cuda:12.4.1-runtime-ubuntu22.04,
#   install python+node, use the cu124 torch wheel, and run with `--gpus all`.
FROM python:3.11-slim

# System deps: node (for claude CLI + MCP server), patch (apply_delta), git, libs for opencv
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl git ca-certificates patch build-essential \
        libglib2.0-0 libgl1 tmux \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Real Claude Code CLI + the official Agent SDK (best path for scripted agentic tests)
RUN npm install -g @anthropic-ai/claude-code@2.1.193 @anthropic-ai/claude-agent-sdk

WORKDIR /plugin
COPY . /plugin

# Build the MCP server
RUN cd mcp && npm ci --no-audit --no-fund && npm run build

# Standard ML stack (CPU torch) + the harness
RUN pip install --no-cache-dir -e harness pytest \
    && pip install --no-cache-dir numpy scikit-learn pandas pyyaml matplotlib opencv-python-headless \
    && pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# Subscription auth: unset API key so CLAUDE_CODE_OAUTH_TOKEN (passed at run) wins.
ENV ANTHROPIC_API_KEY=""
ENV EVOR_TEST_IN_DOCKER=1
ENV EVOR_ML_ENV=1

# Default: the deterministic + (if a token is present) agentic suite.
ENTRYPOINT ["node", "ci/run-checks.mjs"]
