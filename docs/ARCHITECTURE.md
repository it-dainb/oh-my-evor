# oh-my-evor — Architecture

This document describes the internal structure of oh-my-evor for contributors and
integrators. For the user-facing overview see [README.md](../README.md).

---

## Two-Loop Design

oh-my-evor runs two nested loops:

```
Outer loop (meta-evolution)  — every meta_loop_interval ticks (default 5)
│
│  Inner loop (object-level tick)  — every tick
│   Select → Ideate → Hypothesis Registration → Critique
│   → Implement+Run → Evaluate+Integrity → Analyze+Learn
│   → Record → Prune/Promote → stop-condition check
│
└─ updates strategy.json: UCB1 c, wildness, family_mix, meta_iteration
```

The inner loop evolves ML candidates. The outer loop evolves the search strategy
itself (how exploration is balanced, which mutation families are favoured, how
aggressively the wildness dial is set).

---

## Repository Layout

```
oh-my-evor/
  .claude-plugin/
    plugin.json          single manifest: skills, agents, MCP servers, commands
  agents/                5 specialist agent definitions (.md)
  commands/              slash command aliases (.md)
  skills/                5 skill definitions (SKILL.md)
  mcp/                   TypeScript MCP server (tools + hooks)
    src/
      tools/             evor_tree_read, evor_select, evor_record_node, …
      hooks/             continuation-guard, auto-capture hooks
  harness/               Python compute harness
    evor/
      contracts.py       27 data models (single source of truth)
      store.py           content-addressed artifact store
      scheduler.py       ResourcePlan + job submission (GPU-gated, see KNOWN_GAPS.md)
      tree.py            UCB1 selection, crossover, meta-evolve
      genome.py          genome scaffold materialization
      freeze.py          frozen split creation + hash enforcement
      benchmark.py       EvalSuite versioning + angle-registry
      integrity.py       13-check IntegrityGate
      dashboard/         FastAPI + SSE dashboard (server.py, store.py, static/)
    tests/               pytest fixtures + endpoint tests
  scripts/               l1-check.mjs, l3-e2e.sh
  KNOWN_GAPS.md          intentional, tracked deferrals
```

---

## Data Contracts (Single Source of Truth)

All data shapes are defined once in `harness/evor/contracts.py` and
mirrored as TypeScript Zod schemas in `mcp/src/schemas/`. Neither side invents
shapes; changes must land in both.

Core models used in the tick loop:

| Model | Purpose |
|---|---|
| Mission spec | Frozen after `evor-setup` |
| Candidate node | One candidate in the evolution DAG |
| `MutationProposal` | Mutagen's output — what Forge will implement |
| `Hypothesis` | Quantified prediction registered before training |
| Evaluation result | Post-training metrics + per-domain breakdown |
| Integrity verdict | 13-check verdict for a node |
| `TelemetryRecord` | One step's training metrics (streamed via SSE) |
| `LessonEntry` | Probe's EDA conclusion — persisted to CompoundingWiki |
| Strategy state | UCB1 params + wildness + family mix (updated by meta-evolution) |
| `EvalSuite` | One version of the evaluation benchmark (open_ended missions) |
| `AngleRegistry` | Per-angle SOTA bars and coverage status |

---

## MCP Server (TypeScript)

The MCP server exposes tool functions that the Claude Code session calls during
the tick loop. It wraps on-disk reads/writes in a consistent interface.

Key tools:
- `evor_tree_read` / `evor_record_node` — read/write the candidate tree
- `evor_select` — UCB1 selection
- `evor_record_eval` — record an evaluation result; auto-triggers integrity check
- `evor_integrity_check` — run the 13-check integrity gate
- `evor_wiki_add` / `evor_wiki_query` — CompoundingWiki CRUD
- `evor_state_read` / `evor_state_write` — run state management
- `evor_schedule` — submit a training job to the ResourceScheduler
- `evor_cite` — attach a citation to a tree node

Hooks enforce the unforgettable-logging constraint: certain Forge actions
automatically write to `decision-log.md` via hook, making it structurally hard
to skip a record.

---

## Agent Interaction in a Single Tick

```
Evor (Opus, orchestrator)
 │
 ├─ Step 2: Mutagen ──────────────────────────── parallel ──┐
 │    generates MutationProposal[]                           │
 │    returns investigation_queries[]                        │
 │                                                           │
 ├─ Step 2: Sage ─────────────────────────────── parallel ──┘
 │    queries evor_wiki first (prior lessons), then external search
 │    returns CitationBackedFinding[] → attached to proposals
 │
 ├─ Step 4: Selector
 │    6 gates: hypothesis quantified · family streak · tick diversity
 │             integrity risk · TelemetryCallback present · schema valid
 │    data-acquisition proposals get ingestion contamination gate too
 │
 ├─ Step 5: Forge (one per approved proposal, sequential or parallel)
 │    genome.yaml scaffold → TelemetryCallback injection → train
 │    parent.patch stored · worktree isolated in .evor/worktrees/<node-id>/
 │
 └─ Step 7: Probe (after each Forge job completes)
      reads telemetry.jsonl · runs 5 EDA checks in python_repl
      returns LessonEntry + hypothesis_verdict
      may return BenchmarkUpgradeProposal (open_ended only)
```

Evor idles via the Monitor tool during compute-bound Forge phases rather than
polling, waking on `job_complete` or `self_heal_event` signals.

---

## Doom-Loop Detection

If any of the following occur for 3 consecutive ticks:
- Zero proposals pass Selector
- Forge produces zero tool calls
- All nodes fail the integrity gate

…Evor injects an exploration override: wildness → 0.9, requires 3 distinct
mutation families, excludes the monopoly family if one dominates, and logs
a `meta-evolve` decision entry. This mirrors the malformed-tool detection
pattern in the `refs/ml-intern` reference implementation.

---

## Genome Scaffold

Forge materializes every candidate as a modular seam structure before writing
training logic:

```
.evor/worktrees/<node-id>/
  genome.yaml          gene registry — maps seam names to file paths
  data/                data pipeline seam
  model/               architecture seam
  train/
    trainer.py         training loop (TelemetryCallback injected here, unconditionally)
  evaluate.py          LOCKED — chmod 444, hash verified by the integrity gate
```

For `seed-repo` mode, Forge audits the existing codebase and produces a
`GenomeSeedAdapterReport` that maps existing files to genome seams rather than
generating a blank skeleton. Mutations in seed-repo mode are thin adapters layered
on top of the existing code, not rewrites.

Structural mutations extend `genome.yaml.extra` and add entries to
`schema_extensions[]`. Parametric mutations change only the target gene's file.

---

## Integrity Gate — 13 Checks

Implemented in `harness/evor/integrity.py`, called via `evor_integrity_check`
after every evaluation:

1. `split_hash_match` — frozen split hash still matches frozen-splits/
2. `frozen_split_read_only` — all frozen-split files are mode 444
3. `no_test_leakage` — no training sample appears in the test split
4. `near_dup_leakage` — no near-duplicate within hamming distance threshold
5. `data_provenance_valid` — all data files have recorded provenance
6. `no_label_contamination` — test labels not visible during training
7. `no_eval_shift` — metric computation matches the locked evaluate.py script
8. `eval_version_consistent` — node's eval_version matches the mission spec
9. `telemetry_sane` — telemetry.jsonl has ≥1 record and monotone step count
10. `reward_hacking_probe` — loss and metric move in consistent directions
11. `acquisition_contamination_clear` — (data-acquisition only) no acquired sample in eval split
12. `acquired_data_provenance_valid` — (data-acquisition only) license within allowlist
13. `acquisition_namespace_enforced` — (data-acquisition only) data written only to allowed paths

A `failed` verdict on any check excludes the node from the frontier permanently.
The node remains in the candidate tree with a failed integrity status for auditability.

---

## Dashboard Architecture

The dashboard (`harness/evor/dashboard/`) is a read-only FastAPI app that serves
the on-disk `.evor/` store. It never writes to the store.

```
python -m evor.dashboard --run-dir .evor --port 8756

Endpoints:
  GET /api/runs                              list all missions with summary
  GET /api/runs/{mission}/{run}/tree         all TreeNodes
  GET /api/runs/{mission}/{run}/frontier     best-so-far nodes
  GET /api/runs/{mission}/{run}/strategy     StrategyState
  GET /api/runs/{mission}/{run}/nodes/{id}   node + result + integrity
  GET /api/runs/{mission}/{run}/nodes/{id}/per-domain   per-domain breakdown
  GET /api/runs/{mission}/{run}/domain-pivot            sorted leaderboard
  GET /api/runs/{mission}/{run}/eval-versions           benchmark timeline
  GET /api/runs/{mission}/{run}/coverage     (open_ended only; 404 for fixed)
  GET /api/runs/{mission}/{run}/angle-registry
  GET /api/telemetry/{mission}/{run}/{node}  SSE stream (?tail=true for live)
  GET /api/artifacts/{content_hash}          content-addressed blob download
  GET /health
  GET /                                      D3 + Chart.js frontend (index.html)
```

The SSE telemetry endpoint operates in two modes:
- Default (`tail=false`): emit existing records and close — safe for replay and tests.
- Live (`tail=true`): tail the file for new records as training writes them.

The dashboard can also be embedded in a running mission via `serve_in_background()`,
which starts it in a daemon thread without blocking the tick loop.

---

## Content-Addressed Artifact Store

Datasets, model checkpoints, and other blobs are stored once using sha256-based
addressing under `.evor/runs/<mission>/<run>/artifacts/<sha256[:2]>/<sha256[2:]>/`.
Duplicate content across candidates is hardlinked, not copied.

`harness/evor/store.py` manages reads, writes, and delta application. Git
format-patch application (for parent → child deltas) is handled by Forge inside
the candidate worktree via `git apply` — this is a design boundary, not a gap.

---

## Known Gaps

Intentional deferrals are tracked in [KNOWN_GAPS.md](../KNOWN_GAPS.md). The short
version: GPU execution of training runs is gated (the machinery is real and tested
against fixtures; only the actual model forward/backward pass requires a GPU). L3
end-to-end CI is a placeholder until the full engine lands and a GPU is available.

No bare `TODO`/`FIXME` appears in core module code — every deferral raises a
descriptive `NotImplementedError` pointing to `KNOWN_GAPS.md`.
