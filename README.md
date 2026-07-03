# oh-my-evor

Autonomous ML research evolution engine for Claude Code.

oh-my-evor is a Claude Code plugin that orchestrates a team of specialist AI agents
to automatically improve a machine learning model — or co-evolve both the model and
its evaluation benchmark — through an iterative mutation tree search. Each tick
proposes, critiques, implements, trains, and evaluates a candidate; the integrity gate
ensures every reported gain is real and reproducible; the live dashboard lets you
watch the frontier evolve in real time.

---

## Agent Roster

The orchestrator (Evor) runs as the main Claude Code session on Opus. Five Sonnet
specialists handle bounded work in each tick.

| Agent | Role | Description |
|---|---|---|
| **Evor** | Orchestrator | Runs the 9-step tick loop, manages meta-evolution, detects doom loops, coordinates all sub-agents. Opus. |
| **Sage** | Researcher | Produces citation-backed SOTA findings anchored to papers, leaderboards, or experiments. Every claim must have a source URL. |
| **Mutagen** | Dreamer | Generates creative mutation proposals across the `arch / training / data-curation / data-augmentation / data-acquisition / algo` family space, driven by a wildness dial (0.0–1.0). |
| **Probe** | EDA/Analyst | Reads `telemetry.jsonl`, runs 5 structured checks (loss curve, gradient health, LR sensitivity, error clustering, telemetry sanity), and confirms or refutes the registered hypothesis. |
| **Forge** | Implementer | Materializes the genome scaffold in an isolated git worktree, injects `TelemetryCallback`, stores the parent delta as `parent.patch`, and invokes the harness. Never touches `evaluate.py` or frozen splits. |
| **Selector** | Critic | Runs 6 hard gates on every proposal before Forge sees it. One failure rejects the proposal. False approvals cost a full training run; false rejections cost one re-proposal. Errs toward rejection. |

---

## Install

oh-my-evor is installed as a **Claude Code plugin** via the `.claude-plugin` manifest.

```bash
# From the repo root — Claude Code loads the plugin automatically on next start
git clone <repo-url> oh-my-evor
cd oh-my-evor
npm install          # MCP server (TypeScript)
cd harness && uv sync  # Python compute harness
```

Claude Code discovers the plugin through `.claude-plugin/plugin.json`, which declares
the skills, agents, MCP servers, and command aliases. No separate registration step
is required once the directory is on Claude Code's plugin path.

**Dependencies:**
- Claude Code (any recent version)
- Node.js ≥ 18 (MCP server)
- Python ≥ 3.10 with `uv` (compute harness + dashboard)
- GPU optional — see [Compute Model](#compute-model) and [KNOWN_GAPS.md](KNOWN_GAPS.md)

---

## Mission Flow

```
/evor-setup
    │  13-question interview → GoalContract
    │  Environment discovery → ResourcePlan
    │  Freeze data splits (chmod 444, locked_split_hash)
    │  Init EvalSuite v1
    │  Preflight smoke-train (5 steps)
    │  Consent checkpoint — type "start" to proceed
    ▼
.evor/runs/<mission-slug>/<run-id>/
    goal-contract.json  run-state.json  strategy.json  tree.json

/evor-run  (or  /evor-resume  to restore a paused run)
    │  Validates GoalContract, sets EVOR_ACTIVE_RUN_ID
    ▼
Tick loop  ──────────────────────────────────────────────────────────
 1. Select        UCB1 node selection from the frontier tree
 2. Ideate        Mutagen proposes mutations; Sage grounds them in citations (parallel)
 3. Register      Each approved proposal gets a hypothesis_id in run-state.json
 4. Critique      Selector runs 6 gates; doom-loop detector monitors for 3× all-reject
 5. Implement     Forge materializes genome → injects TelemetryCallback → trains
 6. Evaluate      Harness writes EvaluationResult; IntegrityGate runs 13 checks
 7. Analyze       Probe runs EDA; lesson persisted to CompoundingWiki
 8. Record        tree.json / run-state.json / decision-log.md updated
 9. Prune/Promote Frontier updated; stop condition checked
 9.5 (conditional) BenchmarkUpgrade re-scoring when eval_version bumped
   └─ every 5 ticks: meta-evolution updates strategy.json (UCB1 c, wildness, family_mix)
   └─ stop condition met → /evor-report called automatically
─────────────────────────────────────────────────────────────────────

/evor-dashboard   (runs concurrently — does not block the tick loop)
    FastAPI + SSE at http://localhost:8756
    D3 evolution tree · Chart.js telemetry · domain leaderboard · coverage gauge

/evor-report
    ASCII + graphviz tree · frontier table · lesson summary · static HTML export
```

---

## Mission Types

### Fixed

One frozen test suite throughout the mission. Evor evolves the model against a
single, immutable evaluation benchmark. The stop condition is typically
`beat-baseline`, `target`, or `maximize-under-budget`.

This is the default and the simpler path. All integrity checks apply from tick 1.

### Open-Ended (Generality Ratchet)

Evor can discover new evaluation angles and expand the benchmark as the model
improves. When Probe detects saturation (< 1% improvement on the primary metric
for 3 consecutive ticks) or discovers a genuinely new angle, it submits a
`BenchmarkUpgradeProposal`. With user consent (or via `auto_add_within_families`
policy), the EvalSuite version is bumped, frontier nodes are re-scored under the
expanded benchmark, and the exploration wildness is temporarily boosted to prevent
premature convergence post-upgrade.

The stop condition for open-ended missions is `coverage-target`: Evor stops when
a configurable fraction of discovered angles (e.g., 90%) each meet or exceed their
SOTA bar. The live dashboard shows a coverage gauge for open-ended runs.

SOTA bars are retrieved by Sage from configurable sources (Papers With Code, arXiv,
human-provided, custom URL) and must meet a quorum of ≥ 2 independent sources
within 5% divergence before being marked "authoritative."

---

## Integrity Model

Every candidate's gain must be earned against the same frozen test set, evaluated
by the same locked script. Three mechanisms enforce this:

**Frozen splits.** At setup, `evor-setup` calls `python -m evor.freeze` to hash
every sample in the test and validation splits, copy them to
`frozen-splits/v{n}-test/`, and set `chmod 444` on all files. The resulting
`locked_split_hash` and `eval_script_hash` are embedded in `GoalContract`.

**13-check IntegrityGate.** Before any node is promoted to the frontier, the gate
verifies: split hash matches, frozen split is still read-only, no test leakage, no
near-duplicate leakage, data provenance valid, no label contamination, no eval shift,
eval version consistent, telemetry sane, reward hacking probe clear. A verdict of
`failed` marks the node and permanently excludes it from the frontier —
`failed` nodes are never deleted from `tree.json`, only marked.

**Ingestion contamination gate.** For nodes in the `data-acquisition` family: before
any acquired external data enters training, the gate verifies it shares no samples
with the frozen eval split. Failure immediately rejects the node.

The operating principle: a single "no shift" rule. If the test distribution can
drift between candidates, reported improvements are meaningless. oh-my-evor makes
drift structurally impossible rather than relying on discipline.

---

## Compute Model

oh-my-evor is **infra-agnostic by design**. The harness launches training via
`python -m evor.harness run` — a subprocess boundary that works equally well on
a local CPU, a local GPU, or a cloud machine with GPUs. No CUDA assumption is
baked into the orchestration layer.

**GPU-gated operations.** Several harness calls require a GPU to execute the actual
training step. The surrounding machinery (subprocess launch, isolation, parsing,
resource plan, flow wiring) is real and tested against fixture data. Only the
model-weight operations are gated. See [KNOWN_GAPS.md](KNOWN_GAPS.md) for the
full table (G1–G3).

The `evor-setup` preflight runs a 5-step smoke-train to detect environment issues
before committing to a full run. If no GPU is available, the mission proceeds with
`cpu_fallback=true` and concurrency=1.

Parallelism is controlled by `ResourcePlan.concurrency`. When
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set, multiple Forge agents run
concurrently (one per approved proposal, up to the concurrency limit). Without it,
Forge agents run sequentially.

---

## Release Gate

| Layer | Tool | What it checks | Status |
|---|---|---|---|
| **L1** | `node scripts/l1-check.mjs` | File presence, schema structure, manifest validity, no bare TODO/FIXME in core | Built |
| **L2** | `npm test` + `uv run pytest` | Unit tests for all contracts (Zod + Pydantic), MCP tool stubs, dashboard endpoints, store logic | Built |
| **L3** | `scripts/l3-e2e.sh` | End-to-end training run on the release-gate benchmark | Placeholder — GPU + full engine required (see KNOWN_GAPS.md#L3) |

CI runs L1 + L2 on every push. L3 is a manual gate run on GPU-equipped hardware
before a version tag.

---

## State Directory Layout

```
.evor/
  active-run.json                  points to the current mission + run
  runs/
    <mission-slug>/
      <run-id>/
        goal-contract.json         GoalContract — the mission spec (immutable after setup)
        run-state.json             live: tick_count, best_score, frontier_ids, eval_version
        strategy.json              UCB1 params, wildness, family_mix — updated by meta-evolution
        tree.json                  all TreeNodes (never deleted, only status-changed)
        decision-log.md            unforgettable append-only human-readable log
        frozen-splits/             chmod 444 — never modified after setup
        eval-suites/               v1.json, v2.json … — benchmark upgrade snapshots
        angle-registry.json        open_ended only — per-angle SOTA bars and coverage
        nodes/
          <node-id>/
            results.json           EvaluationResult
            telemetry.jsonl        live-tailed by the dashboard SSE endpoint
        evaluations/
          <node-id>.json           IntegrityReport
        artifacts/                 content-addressed (sha256) blobs — hardlinked
```

---

## Key Commands

| Command | What it does |
|---|---|
| `/evor-setup` | Start a new mission: 13-question interview → GoalContract → frozen splits → consent |
| `/evor-run` | Launch or resume the tick loop for the active (or specified) mission |
| `/evor-resume` | Restore a specific run by run-id and resume the tick loop |
| `/evor-dashboard` | Open the live FastAPI + SSE dashboard at http://localhost:8756 |
| `/evor-report` | Generate the final report (tree, frontier table, lessons, static HTML) |

---

## License

MIT.
