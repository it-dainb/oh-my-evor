# Deep Interview Spec: oh-my-evor — Autonomous ML Research Evolution Plugin

## Metadata
- Interview ID: di-oh-my-evor-2026-07-03
- Rounds: 20 (+ 2-pass Round 0 topology gate)
- Final Ambiguity Score: <1% on substance (raw weighted ~3.2%; residual is user-deferred naming + build-time defaults now fixed)
- Type: greenfield plugin, brownfield-informed (patterned on 3 reference repos)
- Generated: 2026-07-03
- Threshold: 0.01 (1%)
- Threshold Source: user request (explicit "Target ambiguous < 1%"); settings default was 0.2, overridden
- Initial Context Summarized: no
- Status: PASSED (substantive threshold met; naming deferred by user as cosmetic)

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.98 | 0.40 | 0.392 |
| Constraint Clarity | 0.97 | 0.30 | 0.291 |
| Success Criteria | 0.95 | 0.30 | 0.285 |
| **Total Clarity** | | | **0.968** |
| **Ambiguity** | | | **0.032 raw / <0.01 substantive** |

---

## Agent Roster (canonical names)
*Sage (Researcher) · Mutagen (Dreamer) · Probe (EDA/Analyst) · Forge (Implementer) · Selector (Critic) — all Sonnet. Files: `evor-sage.md` · `evor-mutagen.md` · `evor-probe.md` · `evor-forge.md` · `evor-selector.md`. Skills/commands remain `evor`-prefixed and unchanged.*

---

## One-Line Definition
**oh-my-evor** is a standalone Claude Code plugin that turns a Claude Code session into an autonomous, multi-agent ML research team ("Evor" orchestrator + 5 specialist agents) which evolves a model **and** its dataset toward a user-defined goal via a **tree/DAG search of mutations** — running real training, gating every gain against cheating, tracking every step with an unforgettable logging spine, visualizing the best-so-far frontier on a live dashboard, and compounding what it learns across runs.

---

## Topology (8 confirmed top-level components — all active, none deferred)

| # | Component | Status | Description | Coverage |
|---|-----------|--------|-------------|----------|
| A | **Evor — Orchestrator** | active | The main agent; decides & guides only, never implements or researches. Runs both the object-level evolution loop and the meta-evolution loop. | Rounds 1,2,15,16,19 |
| B | **Agent Roster (5 specialists)** | active | Researcher (Sage), Dreamer (Mutagen), EDA/Analyst (Probe), Implementer (Forge), Critic/Verifier (Selector). | Rounds 0,12,16,17,19 + telemetry |
| C | **Mutation System** | active | Operator taxonomy (arch, training strategy, data-curation, online/offline augmentation, novel algo) + crossover; how ideas become code/data changes; approach-family diversity. | Rounds 5,14,16,17 |
| D | **Evaluation & Scoring** | active | Configurable Goal Contract, fitness signal, pluggable stop conditions, and the **Integrity Gate** ("no shift" anti-cheat). | Rounds 1,2,4,7 |
| E | **Tracking / Reporting / Lessons** | active | Append-only run store, decision logs, per-node reports, compounding lessons wiki, telemetry streams. | Rounds 10,11,12 + telemetry |
| F | **Evolution Graph / Visualization** | active | Live local web dashboard (SIA-style) rendering the tree + best-so-far frontier + per-node artifacts, reading the on-disk store. | Rounds 5,10,11 |
| G | **Plugin Packaging** | active | Standalone Claude Code plugin: manifest, skills, agents, commands, hooks, MCP server, Python harness. Patterned on oh-my-claudecode. | Rounds 6,7,13,18,19 |
| H* | **Compute Harness + Resource Scheduler** | active | (Sub-system spanning A/B/G) infra-agnostic execution, environment discovery + preflight verification, storage-aware artifact store, compute-saturation-aware scheduling, self-healing job monitor. | Rounds 1,3,5,9,19 |

\*H is tracked as a first-class subsystem though it was surfaced as a cross-cutting concern rather than a named Round-0 component.

---

## Goal

Build oh-my-evor: a **standalone Claude Code plugin** (borrowing oh-my-claudecode's patterns, no runtime dependency) that transforms Claude Code into an **autonomous ML research evolution engine**. Given a mission — either a **seed baseline repo** to improve or a **from-scratch task spec** (task + dataset + metric + baseline) — Evor coordinates a 5-agent roster to run a **tree/DAG evolutionary search** over *mutations of both model and data*, physically training and evaluating each candidate, honestly gating every metric gain, and driving toward a user-configured goal (beat baseline/SOTA, hit target, maximize-under-budget, or evolve-until-plateau/regression). It **tracks + reports + distills lessons** at every step, renders a **live evolution graph** of the best-so-far frontier and where each mutation sits, and **compounds knowledge across runs**. It is task-agnostic across ML from day one.

---

## Constraints

- **Fully autonomous execution:** Evor writes its own model/training code and runs real training/eval — no human implementer. (R1, R3)
- **No assumptions, ever:** every claim is audit/verify, **citation-backed**; when genuinely unsure, Evor **asks** rather than guesses. No "I think." (R3)
- **Infra-agnostic compute + discovery + preflight:** detect the environment ("I see 1 GPU"), ask which resource to use (this GPU / user-supplied SSH GPU cluster / CPU-only), then **smoke-test trainability before committing**. (R3)
- **Storage-aware isolation:** git worktree/branch isolates **code** per candidate; large **datasets & checkpoints live once in a content-addressed store**, referenced by copy-on-write/hardlink/symlink (never duplicated); dataset mutations stored as **versioned deltas**; losing candidates' artifacts **garbage-collected**. Containers opt-in (off by default to avoid data-copy blowup). (R9)
- **Data is a first-class evolving artifact:** each tree node = `(arch/code + training config + data-version + resulting weights + metrics + telemetry + lessons + citations)`. (R5, R9)
- **Integrity ("no shift"):** eval protocol + data splits locked at mission start; reject any gain from leakage/contamination/reward-hacking/eval-shift. A number not honestly earned is a failure. (R4)
- **Hard caps + circuit breakers:** `max_iterations` (default 50), `plateau_window` (8), `circuit_breaker` (5 consecutive failures), `max_cost_usd` (default 0 = local-only until cloud configured), `max_wall_clock` / `max_gpu_hours` (mission-set). (R7, R15, defaults fixed)
- **Compute-saturation-aware scheduling:** concurrency bounded by measured throughput, not VRAM; start at 1, add jobs while aggregate throughput rises, back off at ~90% compute-util or throughput degradation; VRAM is a hard ceiling. (R5)
- **Model-tiered cost control:** Evor = Opus (idles/sleeps during compute-bound phases, wakes on events); roster/Forge (Implementer) = Sonnet; quick lookups = Haiku. (R19)
- **Standalone plugin, OMC-patterned:** own manifest/MCP/agents/hooks/state; TS for MCP+hooks, Python for harness+dashboard. (R13, R18)
- **Unforgettable logging:** evaluation is action-coupled to recording (MCP tools), PostToolUse hooks auto-capture, continuation-guard hook blocks completion if the tree DB wasn't updated. (R11)
- **Mandatory Telemetry Instrumentation Contract:** Forge (Implementer) must instrument all training code with the plugin's fixed-schema telemetry SDK; Selector (Critic) rejects un-instrumented candidates pre-execution. (telemetry round)

---

## Non-Goals
- Not a general coding assistant (that's oh-my-claudecode) — focused on ML research/model/dataset evolution.
- Not human-in-the-loop for implementation (Evor writes + runs code itself); the only human touchpoints are launch consent + optional milestone-ping redirects.
- Not dependent on oh-my-claudecode at runtime (standalone).
- Not tied to one modality/framework (task-agnostic; PyTorch is only the from-scratch default).
- Not a linear generational chain (SIA-style) — it is a branching tree with backtracking + crossover.
- Not an `autoresearch`-skill mission on the current repo — despite the `--autoresearch` flag, the deliverable is a **build spec for the plugin**, not a stateful improvement loop on this directory. (Confirmed at interview start.)

---

## Acceptance Criteria (v1)

**Release gate = all three layers must pass every release (R7):**

- [ ] **L1 Structural/lint:** `.claude-plugin/plugin.json` valid; every referenced skill/agent/command/hook/MCP entry exists and loads; SKILL.md frontmatter parses.
- [ ] **L2 Unit tests:** `vitest` over the TS MCP tools + hooks; `pytest` over the Python harness (scheduler, telemetry SDK, evaluator adapters, integrity checks, plot_tree).
- [ ] **L3 End-to-end proof-on-task:** installed into Claude Code, oh-my-evor runs a full evolution on the fixed **release-gate benchmark** (e.g. CIFAR-10 subset + a small tabular task) and produces a **verified, integrity-gated improvement over a fixed baseline** within a tight compute budget, with a complete trace + rendered tree/frontier.
- [ ] Evolution search demonstrably **branches from a non-latest node** and performs at least one **crossover** (recombining two lineages).
- [ ] **Integrity Gate** demonstrably rejects a seeded cheating mutation (e.g. injected test-set leakage).
- [ ] **Logging is unforgettable:** a deliberately-skipped record is caught by the continuation-guard hook (turn blocked until tree updated).
- [ ] **Telemetry contract enforced:** an un-instrumented candidate is rejected by the Critic pre-execution; an instrumented one yields loss/lr/grad-norm curves on the dashboard.
- [ ] **Self-healing:** a seeded CUDA-OOM is auto-recovered (batch-size/grad-accum) rather than failing the candidate.
- [ ] **Compounding wiki:** lessons from run N are retrievable and cited in run N+1.
- [ ] Live **dashboard** renders the tree, per-node artifacts (code/data-version/metrics/telemetry), and the highlighted best-so-far frontier, updating from the on-disk store.
- [ ] Stop conditions all fire correctly (target, plateau, circuit-breaker, budget, user).

---

## Core Algorithm (locked, R16/R17)

**Two nested loops.**

**Object-level per-iteration ("tick") loop:**
1. **Select** — Evor's selection policy (MCTS/UCB/beam over the tree) picks parent node(s) to expand — *any* node (backtrack + crossover enabled). Resource Scheduler sets candidate count (compute-saturation-aware).
2. **Ideate** — bidirectional: **Mutagen (Dreamer)** generates raw, un-SOTA-filtered, cross-domain ideas AND *directs* **Sage (Researcher)** to investigate them; Sage independently surfaces newest SOTA to seed/recombine. Output: N **Mutation Proposals**, each tagged `approach_family` ∈ {arch, training, data-curation, augmentation, algo, other}. Wildness is a mission-configurable dial (meta-evolution can tune it).
   - **2.5 Hypothesis Registration** — each proposal registers a falsifiable hypothesis.
3. **Critique (pre-exec gate)** — **Selector (Critic)** rejects infeasible / duplicate / diversity-violating (a family that won K rounds straight, OMC H002-style) / integrity-risky / **un-instrumented** proposals.
4. **Implement + Run** — **Forge (Implementer)** materializes each approved proposal into code/data changes in an isolated worktree (artifacts referenced, not copied), instruments training with the **Telemetry Contract**, then trains+evals via the harness (scheduler throttles; **self-healing monitor** auto-recovers OOM/dep/NaN/checkpoint errors).
5. **Evaluate (integrity-gated)** — evaluator emits metrics + telemetry; **Integrity Gate** verifies honesty (locked splits, no leakage, "no shift", telemetry sanity).
   - **5.5 Verification Re-run** — tournament winner re-evaluated on locked splits (no-regression check) to catch false winners.
6. **Analyze + Learn** — **Probe (EDA/Analyst)** does EDA on data + outputs + **training telemetry** (learning-curve, gradient pathology, LR issues, error clustering), confirms/refutes the registered hypothesis, distills **lessons** into the compounding wiki, annotates the node.
7. **Record** — MCP recording-tools write node(s) to the tree DB `(arch+config+data-version+weights+metrics+telemetry+lessons+citations)`; hooks enforce completeness; dashboard updates live.
8. **Prune/Promote** — tournament + no-regression; update best-so-far frontier; GC losing artifacts; bump stop-condition counters.
9. **Loop or Stop** — Evor checks stop conditions + fires milestone pings; continue or finalize.

**Meta-evolution loop (R16):** Evor periodically evolves its *own* strategy — selection policy, exploration/wildness balance, mutation-family mix — based on what's producing wins and what the lessons-wiki reports. Stored in `strategy.json`.

**Coordination (R19):** Evor drives a **shared task-board using Claude Code implicit agent-teams** (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, OMC `/team` model) for both roster coordination and parallel candidate execution, with ml-intern-style doom-loop detection + continuation guards.

---

## Technical Context

### Reference-repo lineage (what oh-my-evor borrows)
- **oh-my-claudecode:** plugin structure (`.claude-plugin/plugin.json`, `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `hooks/`, MCP bridge), filesystem state pattern (`.omc/` → `.evor/`), `self-improve`'s approach-family taxonomy + H002/H003 diversity rules + tournament-with-re-benchmark + `data_contracts.md` JSON-schema discipline + `plot_progress.py`, `/team` + task-board coordination, Monitor-based guard/nudge, model routing.
- **sia:** `evaluate.py` subprocess evaluator contract, per-generation artifact layout, `context.md` cross-generation evolution log, live FastAPI dashboard, pluggable agent backends.
- **ml-intern:** async tool-loop, `asyncio.gather` parallel execution, doom-loop + malformed-tool recovery, plan-as-state continuation guard, event-stream progress, sandboxed execution.

### Plugin surface (locked, R18)
```
oh-my-evor/
  .claude-plugin/plugin.json     # manifest: skills, agents, commands, hooks, mcp
  skills/   evor/ · evor-setup/ (mission interview → Goal Contract) · evor-run/ ·
            evor-dashboard/ · evor-report/            (each a SKILL.md)
  agents/   evor-sage.md(Sage) · evor-mutagen.md(Mutagen) · evor-probe.md(Probe) ·
            evor-forge.md(Forge) · evor-selector.md(Selector)   # Evor = orchestrating session
  commands/ evor.md · evor-run.md · evor-dashboard.md · evor-resume.md · evor-setup.md
  hooks/    post-tool-use.mjs (auto-capture evals+telemetry) · stop.mjs (flush + continuation
            guard) · session-start.mjs (load run context)
  mcp/      TypeScript server: evor_record_node, evor_record_eval, evor_tree_read, evor_select,
            evor_schedule, evor_wiki_add/query, evor_state_read/write, evor_integrity_check,
            evor_cite, evor_telemetry_ingest
  harness/  Python: train/eval runners, evaluator adapters, telemetry SDK/callback,
            resource-probe + scheduler, self-heal monitor, plot_tree.py, dashboard (FastAPI)
  .evor/runs/<mission>/<run-id>/  tree.json · nodes/<id>/{code,data-version,telemetry.jsonl,
            results.json,lessons.md} · evaluations/ · decision-log.md ·
            artifacts/ (content-addressed data+weights) · wiki/ · strategy.json (meta)
```
- **Stack:** MCP + hooks in TypeScript; harness + dashboard in Python (FastAPI). Framework default = PyTorch for from-scratch; framework-agnostic (inherit seed's stack) when a repo is provided.
- **Data contracts (JSON schemas, OMC-style):** GoalContract, TreeNode, MutationProposal, Hypothesis, EvaluationResult, IntegrityReport, TelemetryRecord, LessonEntry, StrategyState, ResourcePlan, DecisionLogEntry.

---

## Ontology (Key Entities — final)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| GoalContract | core | task, dataset ref, metric(s), baseline/target, stop-condition, wildness, budget caps | drives Run; produced by evor-setup |
| Run/Mission | core | id, goal-contract, tree ref, status | has many TreeNodes |
| TreeNode | core | id, parent(s), arch/code, config, data-version, weights ref, metrics, telemetry ref, lessons, citations, approach_family | forms Tree; expanded by tick loop |
| MutationProposal | core | idea, approach_family, hypothesis, citations, wildness | becomes TreeNode via Implementer |
| Hypothesis | supporting | statement, prediction, confirmed/refuted | attached to proposal/node |
| Evor (orchestrator) | agent | selection policy, strategy state | coordinates Roster |
| Sage (Researcher) | agent | queries, citations | grounds Dreamer, feeds SOTA |
| Mutagen (Dreamer) | agent | divergent ideas, crossover | directs Sage; emits proposals |
| Probe (EDA/Analyst) | agent | EDA, error analysis, reflection | reads Telemetry; writes Lessons |
| Forge (Implementer) | agent | code/data materialization | instruments Telemetry; runs jobs |
| Selector (Critic) | agent | feasibility/diversity/integrity checks | gates proposals |
| Evaluator | mechanism | run+score contract, adapter | scored by IntegrityGate |
| IntegrityGate | mechanism | locked splits, leakage/shift checks | gates EvaluationResult |
| TelemetryContract | mechanism | schema: loss, lr, grad_norm, param_norm, throughput, util, mem | emitted by Forge, read by Probe/Dashboard/IntegrityGate |
| ContentAddressedStore | infra | data + checkpoint artifacts, CoW refs | referenced by TreeNodes |
| ResourceScheduler | infra | throughput probe, concurrency plan | throttles job execution |
| SelfHealMonitor | infra | Monitor tool, error playbook | supervises jobs |
| CompoundingWiki | infra | lessons, citations, cross-run | grown by Probe/Sage |
| EvolutionTree/Frontier | infra | nodes, edges, best-so-far | rendered by Dashboard |
| StrategyState | meta | selection policy, mix, wildness | evolved by meta-loop |

---

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability |
|-------|-------------|-----|---------|--------|-----------|
| 1 | 9 | 9 | - | - | N/A |
| 2 | 11 | 2 | 0 | 9 | 82% |
| 3 | 14 | 3 | 0 | 11 | 79% |
| 4 | 16 | 2 | 0 | 14 | 88% |
| 5 | 19 | 3 | 0 | 16 | 84% |
| 6 | 20 | 1 | 0 | 19 | 95% |
| 7–8 | 21 | 1 | 0 | 20 | 95% |
| 9 | 24 | 3 | 0 | 21 | 88% |
| 10–15 | ~26 | few | 0 | stable | ~95% |
| 16–17 | ~28 | 2 | 0 | 26 | 93% |
| 19 | ~30 | 2 | 0 | 28 | 93% |
| final (+telemetry) | ~31 | 1 | 0 | 30 | 97% |

Domain model converged; no entity renames/removals — pure additive growth, indicating stable understanding.

---

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| "It's just a mechanism" | Round 0 | It's a **multi-agent team**: Evor + 5 specialists (added Researcher, Dreamer, EDA/Analyst, Implementer, Critic). |
| Mutations are cheap to evaluate | Round 1 | No — it **runs real autonomous training**; needs a compute harness. |
| One fixed success definition | Round 2 | Objective is a **configurable Goal Contract** with pluggable stop conditions, elicited via a setup interview. |
| Assumes an environment | Round 3 | **No assumptions, citation-backed**; discovers env, asks, preflight-verifies. |
| "Break the boundary" = success | Round 4 (contrarian) | Success = **process value + verified metrics**; boundary-breaking is stretch, and gains must pass an **Integrity Gate** ("no shift"/no cheating). |
| Linear generational chain | Round 5 | **Tree/DAG with backtracking + crossover**; data evolves too; compute-saturation-aware scheduler. |
| Full complexity needed for v1 | Round 6 (simplifier) | Surfaced the real question: **how is a Claude Code plugin itself verified?** |
| Plugin "just works" once written | Round 7 | **Three-layer acceptance gates every release** (structural + unit + real proof-on-task). |
| Narrow domain | Round 8 | **Task-agnostic across ML from day one.** |
| Copy data per candidate is fine | Round 9 | **Storage-aware content-addressed store** (refs, not copies); data first-class. |
| Model will remember to log | Rounds 10–11 | **Unforgettable logging**: action-coupled MCP + hook backstop + continuation guard; dashboard reads store. |
| Offline/static knowledge | Round 12 | **Live academic MCPs + web + compounding wiki.** |
| Build on OMC | Round 13 | **Standalone**, borrowing OMC patterns. |
| Single mission-input mode | Round 14 | **Both** seed-repo and from-scratch. |
| Fully hands-off or fully gated | Round 15 | **Autonomous with milestone pings** (+ one launch consent). |
| Fixed loop | Rounds 16–17 | Added **meta-evolution**, hypothesis registration, verification re-run, bidirectional Dreamer↔Researcher, wildness dial. |
| Ad hoc coordination | Round 19 | **Shared task-board + agent-teams**; **self-healing monitor**; **model-tiered idle** orchestration. |
| Probe can analyze anything | telemetry | **Mandatory Telemetry Instrumentation Contract**, Critic-enforced, so EDA has uniform loss/lr/grad-norm/etc. to work from. |

---

## Interview Transcript
<details>
<summary>Full Q&A (Round 0 gate + 20 rounds)</summary>

- **R0 Topology:** User reshaped to an agent team — Evor orchestrates only; added Researcher, Dreamer, EDA/Analyst (+ implied Implementer).
- **R0b Topology v2:** Add Critic/Verifier; naming to match "evor", deferred. → 8 components, 5-agent roster locked.
- **R1 Substrate:** "It runs real training itself." → compute harness required.
- **R2 Objective:** All-of-above → configurable Goal Contract with pluggable stop conditions via a setup interview.
- **R3 Compute:** Infra-agnostic + env discovery + preflight verify; writes own training code; **no assumptions, citation-backed**.
- **R4 (Contrarian) Success bar:** Process value + metrics; anti-cheat **Integrity Gate** ("no shift").
- **R5 Search shape:** Tree/DAG + backtrack + crossover; compute-saturation-aware Resource Scheduler; data first-class.
- **R6 (Simplifier) v1:** Pivoted to "how is the plugin itself verified?"
- **R7 Acceptance:** All three layers gate every release.
- **R8 Domain:** Task-agnostic from day one.
- **R9 Safety (Claude decided):** Worktree code isolation + content-addressed artifact store + caps + circuit breakers; data-as-artifact.
- **R10 Viz:** Live dashboard — raised the "how does a plugin log reliably?" question.
- **R11 Log enforcement:** Full MCP write-API + hooks backstop + dashboard reader.
- **R12 Knowledge:** Live academic MCPs + web + compounding wiki.
- **R13 Dependency:** Standalone, borrowing OMC patterns.
- **R14 Mission input:** Both seed-repo OR from-scratch.
- **R15 Oversight:** Milestone pings, still autonomous.
- **R16 Core loop:** Confirmed + meta-evolution + hypothesis registration + verification re-run + Dreamer guides Researcher. Commands inherited from OMC.
- **R17 Dreamer:** Unfiltered divergence + grounded execution + bidirectional + mission-configurable wildness dial.
- **R18 Plugin surface + stack:** Locked (TS MCP/hooks + Python harness/dashboard, PyTorch default).
- **R19 Coordination:** Full team/task + agent-teams; + self-healing Monitor + model-tiered idle orchestration.
- **R20 Naming:** Genetics/evolution theme (Mutagen/Sage/Selector/Forge/Probe placeholders; exact TBD).
- **Telemetry (post-cap refinement):** Mandatory Telemetry Instrumentation Contract, Critic-enforced, so Probe's EDA has uniform training telemetry.

</details>

---

## Open (cosmetic / build-time only — do NOT block build)
- Exact agent names (genetics/evolution theme) — user reserved for a later cosmetic pass.
- Exact release-gate benchmark selection.
- Exact numeric budget defaults + scheduler thresholds (sensible defaults set above; user-overridable).
- Exact selection-policy algorithm (MCTS vs UCB vs beam) — pick during implementation; all fit the tree design.
