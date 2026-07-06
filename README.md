<div align="center">

# 🧬 oh-my-evor

### Autonomous ML-research evolution engine for Claude Code — *that proves its own results are real.*

[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-plugin-8A2BE2)](https://code.claude.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-842_passing-brightgreen)](#-proof-it-works)
[![MCP tools](https://img.shields.io/badge/MCP_tools-14-blue)](#architecture)
[![Agents](https://img.shields.io/badge/agents-11-orange)](#the-agent-roster)
[![Python](https://img.shields.io/badge/python-3.10+-blue)](#requirements)
[![Node](https://img.shields.io/badge/node-18+-green)](#requirements)

<img src="ci/out/evor-tree.png" alt="An evolution tree produced by oh-my-evor" width="620" />

<sub>*A real evolution tree from a run — each node is a candidate model (approach family + score), and every score shown has already survived the integrity gate. Rendered by `evor tree render`.*</sub>

</div>

---

oh-my-evor turns Claude Code into a team of specialist AI agents that **autonomously evolve a machine-learning model** — proposing, critiquing, implementing, training, and evaluating candidates through an iterative mutation **tree search**. After a single setup conversation, it runs to your goal with **zero human-in-the-loop**.

But autonomy is cheap. The hard part is *trust*. So oh-my-evor is built around one non-negotiable idea:

> **Every reported gain must be provably real.** No test-set leakage. No reward-hacking. No irreproducible flukes. No moving the goalposts.

---

## ⭐ Why oh-my-evor?

Most "AI improves your model" tools hand you a number and ask you to trust it. An autonomous agent optimizing a metric will happily — and invisibly — **cheat**: peek at the test set, overfit the validation split, silently swap the eval, or report a lucky seed. oh-my-evor is engineered so it *structurally cannot*:

| The trap | How oh-my-evor closes it |
|---|---|
| 🕵️ **Test-set leakage** | Frozen splits are `chmod 444`; a 13-check **integrity gate** flags near-perfect scores and per-step val spikes as leakage signatures |
| 🎰 **Reward hacking** | Direction-aware anti-gaming checks (works for higher- *and* lower-is-better metrics); the gate may never auto-weaken its own fraud detection |
| 🔒 **Agents editing the referee** | A **hook-enforced capability governor** makes it impossible for any agent to write the evaluator, touch frozen splits, or run training out of turn — enforced at the tool-call layer, not by prompt politeness |
| 📉 **Comparability drift** | Eval-version is pinned; changing the benchmark requires explicit consent, never a silent swap |
| 📎 **Hand-wavy research** | Every SOTA claim the research agent makes is **anchored to a source URL** — no citation, no claim |

The result is an engine you can point at a real dataset and *leave alone* — and still defend the number it gives you.

---

## 🚀 Quick Start

**Install in two commands** (verified end-to-end in a clean container — see [Proof](#-proof-it-works)):

```text
/plugin marketplace add https://github.com/it-dainb/oh-my-evor
/plugin install oh-my-evor
```

The MCP server ships **prebuilt**, so there's no Node build step on your machine. The Python harness needs its deps once (Claude Code can't `pip install` for you):

```bash
# one time, on the target machine — or run ./install.sh which does this for you
pip install -e <plugin>/harness       # pydantic, pyyaml, fastapi, …
```

> If the deps are missing, oh-my-evor tells you exactly what to run on your next session — it never fails cryptically.

Then start a mission — **one setup conversation** locks the goal, metrics, and benchmark; after that it runs autonomously:

| Command | What it does |
|---|---|
| `/oh-my-evor:evor-setup` | New mission: interview → GoalContract → freeze splits → consent. **The only human-in-the-loop step.** |
| `/oh-my-evor:evor-run` | Launch (or resume) the autonomous tick loop toward the goal |
| `/oh-my-evor:evor-resume` | Restore a specific paused run by id and continue |
| `/oh-my-evor:evor-dashboard` | Live **FastAPI + SSE dashboard** — D3 evolution tree, telemetry charts, coverage gauge |
| `/oh-my-evor:evor-report` | Final report: tree, frontier table, lessons, static HTML export |

---

## How it works

Each **tick** of the outer loop runs a disciplined pipeline, and the loop repeats until the goal is met:

```
   research → dream → gate → implement → train → evaluate → integrity → select → learn
   (Sage)   (Mutagen)(Selector)(Forge)         (harness)   (gate)    (Selector) (wiki)
      └──────────────────────────── repeat until goal reached ───────────────────────┘
```

- **Tree search**, not greedy hill-climbing — candidates branch, cross over, and get pruned via UCB1 scoring, so the engine explores the frontier instead of chasing one lucky lineage.
- **Signals** flow to every agent: OOM, slow-training, class-confusion and other pain-points are captured, deduped, and routed through a shared bus so the next proposal *reacts* to what actually happened.
- **Compaction-survival**: state is flushed before context compaction and re-hydrated after, so long autonomous runs don't lose their thread.
- **A live dashboard** streams the evolving tree and telemetry over SSE while the loop runs — watch the frontier move in real time.

### The Agent Roster

The orchestrator (**Evor**) runs as the main Claude Code session. It spawns specialist leads — and those leads spawn their *own* sub-teams (a real hierarchy, not one agent role-playing six):

| Agent | Role | What it does |
|---|---|---|
| **Evor** | Orchestrator | Runs the tick loop, meta-evolution, doom-loop detection; spawns leads. Opus. |
| **Sage** → *Sage-juniors* | Research lead | Citation-backed SOTA findings; fans out research by angle. Every claim carries a source URL. |
| **Mutagen** | Dreamer | Mutation proposals across `arch / training / data-* / algo`, driven by a wildness dial. |
| **Probe** | EDA / Analyst | Structured telemetry checks (loss curve, gradient health, LR sensitivity, error clustering) to confirm or refute the hypothesis. |
| **Forge** → *architect / junior / critic / analyst* | Implementation lead | A dev-team that scaffolds the genome in an isolated git worktree and runs the harness. **Only the junior writes code.** |
| **Selector** | Critic | Hard gates on every proposal before a training run is spent. Errs toward rejection. |
| **Acquirer** | Data | Fetches enrichment/hardening data under strict no-leakage rules. |

*Children are spawnable **only** by their parent — enforced by the governor hook.*

---

## 🛡️ The Integrity Gate — the part that makes it trustworthy

This is the heart of the project. Before any candidate's result is allowed to count, it passes a **13-check integrity gate** in the Python harness. A few of the checks:

- **Leakage detection** — near-ceiling scores on a hard task, or a sudden per-step validation spike, are flagged as test-leakage signatures.
- **Reward-hacking, direction-aware** — a legitimate jump from a weak baseline is *allowed*; a near-perfect leak is *rejected* — and the check knows whether higher or lower is better.
- **Frozen-split & eval-version** — the test split hash and eval script are locked; results only compare within the same evaluation contract.
- **Ingestion contamination** — for `data-acquisition` candidates, acquired data must share zero samples with the frozen eval split or the node is rejected.
- **Reproducibility & structure** — outputs must match the declared shape and re-derive.

A `failed` verdict marks the node and permanently excludes it from the frontier — `failed` nodes are never deleted from `tree.json`, only marked. Paired with the **capability governor** (a `PreToolUse` hook that denies out-of-scope writes/tools per agent) and a **monotonic-honesty invariant** (the engine may never weaken its own fraud detection), the gate is what lets oh-my-evor be *aggressive and autonomous* without becoming *untrustworthy*.

---

## 🔬 Proof it works

We hold ourselves to the same standard we hold the agents to — **claims are backed by evidence you can reproduce**:

**✅ 842 automated tests pass** — the safety-critical logic is covered, not asserted.
```bash
cd mcp && npx vitest run          # 304 passing  (MCP server, tools, hooks, governor, locks)
python -m pytest harness/tests -q # 538 passing  (integrity gate, signals, tree search, evaluator)
```

**✅ Verified installable in a clean container.** In a fresh environment with no repo mounted, the two-command marketplace install produced a working plugin: `plugin:oh-my-evor:evor · ✔ connected · 14 tools`, 11 agents, 6 hooks — and the Node→Python bridge round-tripped with **no `pip install` of `evor` itself** (the server injects the harness onto `PYTHONPATH`).

**✅ Real evolution artifacts.** The tree at the top of this page is not a mock-up — it's a rendered run where candidates were scored and integrity-gated, and the best emerged from a genuine branching search.

**✅ Adversarially audited.** The codebase was put through a multi-agent audit that found and root-cause-fixed 25 real defects (silent data loss, a dead signal pipeline, dead circuit-breakers, leakage-check false-negatives) — each fix locked in by a proving test.

---

## Architecture

| Layer | What | Detail |
|---|---|---|
| **Orchestration** | Skills + agents | `/oh-my-evor:*` skills, 11 hierarchical agents, Autonomy Charter (never-halt, monotonic-honesty) |
| **MCP server** | 14 tools (TypeScript, prebuilt bundle) | `record_node`, `record_eval`, `integrity_check`, `select`, `signal_emit/query`, `state_*`, `tree_read`, `cite`, `wiki_*`, … |
| **Compute harness** | Python | Integrity gate (13 checks), tree engine (UCB1 + crossover + prune), SignalBus, evaluator, telemetry, live dashboard |
| **Enforcement** | 6 hooks | `PreToolUse` capability governor, signal capture, compaction flush/rehydrate, stop-guards |
| **Bridge** | Node ↔ Python | Per-call subprocess JSON; harness auto-resolved onto `PYTHONPATH` so it works after a bare install |

State for every mission lives under `.evor/runs/<mission>/<run-id>/` — `goal-contract.json` (immutable spec), `tree.json` (all candidates, never deleted), `run-state.json`, `decision-log.md`, `frozen-splits/`, and content-addressed `artifacts/`.

---

## Requirements

- **Claude Code** (the plugin host)
- **Node ≥ 18** — runs the MCP server + hooks (ships prebuilt; no build needed)
- **Python ≥ 3.10** — the compute harness (`pip install -e harness` once)
- For real training missions: your own compute stack (e.g. `torch`, `torchvision`); GPU optional (CPU fallback supported)

---

## References

oh-my-evor's search and integrity machinery build on established work:

1. Auer, Cesa-Bianchi & Fischer. *Finite-time Analysis of the Multiarmed Bandit Problem.* Machine Learning, 2002. — the UCB1 scoring behind node selection.
2. Kocsis & Szepesvári. *Bandit Based Monte-Carlo Planning.* ECML, 2006. — the UCT / Monte-Carlo tree-search framing of the evolution tree.

The research agent (**Sage**) additionally anchors every in-run SOTA claim to a live source URL — citation is a hard requirement of the pipeline, not a nicety.

---

## License

MIT — see [LICENSE](LICENSE).

<div align="center">
<sub>Built for <a href="https://code.claude.com">Claude Code</a>. Autonomous research you can actually trust.</sub>
</div>
