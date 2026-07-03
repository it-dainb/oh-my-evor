# oh-my-evor — Implementation Plan

**Status: pending approval**
**Plan ID:** omp-oh-my-evor-2026-07-03
**Spec source:** `.omc/specs/deep-interview-oh-my-evor.md` (di-oh-my-evor-2026-07-03, <1% substantive ambiguity) + `.omc/specs/deep-interview-oh-my-evor-addendum-v2.md` (four new pillars: mutation genome, dataset freeze, benchmark evolution, open-ended missions)
**Reference repos:** `refs/oh-my-claudecode` · `refs/sia` · `refs/ml-intern`
**Release gate:** L1 structural/lint · L2 vitest+pytest unit · L3 end-to-end proof-on-task

---

## Agent Roster (canonical names)

| Canonical Name | Role | Agent File |
|---|---|---|
| Sage | Researcher | `agents/evor-sage.md` |
| Mutagen | Dreamer | `agents/evor-mutagen.md` |
| Probe | EDA/Analyst | `agents/evor-probe.md` |
| Forge | Implementer | `agents/evor-forge.md` |
| Selector | Critic | `agents/evor-selector.md` |

*Orchestrator: Evor (main Claude Code session, Opus — not a subagent file).*
*Skills and commands remain `evor`-prefixed: `evor`, `evor-run`, `evor-setup`, `evor-dashboard`, `evor-resume`, `evor-report`.*

---

## Requirements Summary

Full requirements locked in spec. Key contract terms for traceability:

**What:** Standalone Claude Code plugin. Evor orchestrator + 5-agent roster evolves both model *and* dataset via a tree/DAG search over mutations, running real training, gating every gain through an Integrity Gate ("no shift" anti-cheat), logging unforgettably, and rendering a live FastAPI dashboard of the best-so-far frontier. (spec §One-Line Definition, §Goal)

**Two nested loops:** 9-step object-level tick (Select → Ideate → Hypothesis Registration → Critique → Implement+Run → Evaluate+Integrity → Analyze+Learn → Record → Prune/Promote → Loop/Stop) and a meta-evolution loop that evolves `strategy.json`. (spec §Core Algorithm)

**Five specialist agents:** Sage (Researcher), Mutagen (Dreamer), Probe (EDA/Analyst), Forge (Implementer), Selector (Critic) — all Sonnet. Evor = Opus, idles during compute-bound phases. Quick lookups = Haiku. (spec §Constraints: "Model-tiered cost control")

**Stack:** TypeScript for MCP server + hooks; Python for compute harness + FastAPI dashboard. (spec §Technical Context: "Plugin surface (locked, R18)")

**State root:** `.evor/runs/<mission-slug>/<run-id>/` (spec §Technical Context)

**11 JSON schemas:** GoalContract, TreeNode, MutationProposal, Hypothesis, EvaluationResult, IntegrityReport, TelemetryRecord, LessonEntry, StrategyState, ResourcePlan, DecisionLogEntry. (spec §Ontology)

**Standalone:** borrows OMC patterns from `refs/oh-my-claudecode`, zero runtime OMC dependency. (spec §Constraints, spec R13)

Spec sections referenced throughout: R1–R19, telemetry round, §Ontology, §Acceptance Criteria, §Core Algorithm, §Technical Context, §Non-Goals.

---

## RALPLAN-DR Summary

### Principles

1. **Cite, don't invent.** Every architectural pattern is grounded in a ref-repo file path. Deviation requires an explicit ADR entry.
2. **Unforgettable first.** Logging/recording infrastructure (MCP tools + hooks) is built before agents and loops, not after. Enforcement gaps found at M2 are cheap; found at M8 they corrupt run history. (spec R11)
3. **Integrity before speed.** IntegrityGate is implemented in M6, before the full tick loop in M8. A fast engine that produces cheatable results is worse than a slow honest one. (spec R4)
4. **Smallest viable tree engine first.** UCB1 + correctness in M5; MCTS extension and full parallel scheduling layered in M6 once harness is proven.
5. **Monorepo, single manifest.** One `.claude-plugin/plugin.json` governs both languages. No version drift between TS and Python. Mirrors `refs/oh-my-claudecode/.claude-plugin/plugin.json` structure.

### Decision Drivers

1. **Unforgettable logging constraint** (spec R11): logging must be action-coupled, hook-enforced, and dashboard-readable from the on-disk store. Architecture must make "skipping a record" harder than "writing it."
2. **Content-addressed storage** (spec R9): datasets and checkpoints must never be duplicated across candidates. CoW/hardlink/symlink strategy must be chosen before any training code is written.
3. **Compute-harness independence** (spec R3, R8): harness must be infra-agnostic from day 1 — no CUDA assumption, no PyTorch assumption in seed-repo mode. Preflight smoke-test required before committing to a run.

### Viable Options

#### (a) Monorepo TS+Python vs Two Packages

| Option | Pros | Cons |
|--------|------|------|
| **Monorepo** (chosen) | Single `plugin.json`; unified versioning; `refs/oh-my-claudecode` uses this layout; `package.json` + `harness/pyproject.toml` in one repo | Mixed-language CI; npm scripts must delegate to `uv run` for Python |
| Two packages | Cleaner language boundaries | Version drift; two manifests; two CI pipelines; spec R18 defines one plugin surface |

**Invalidation rationale:** Two packages would require a coordination layer the spec does not envision and would force separate install steps for a plugin that must deploy as one unit.

#### (b) Tree Engine in Python-Harness vs TS-MCP

| Option | Pros | Cons |
|--------|------|------|
| **Python harness** (chosen) | `numpy`/`networkx` available; natural for UCB1 math; same process as scheduler/evaluator; `refs/sia/sia/orchestrator.py` is pure Python | TS MCP tools call Python via per-call subprocess JSON (pattern: `refs/sia/sia/orchestrator.py`→evaluate.py); ~5ms overhead per select call is acceptable at per-tick cadence |
| TS-MCP | Co-located with hook logic | No graph libraries; numeric instability risk; mixes compute and protocol layers |

**Decision:** `tree.json` is the on-disk source of truth written by Python. TS MCP tools `evor_select` and `evor_tree_read` are thin adapters that spawn `python -m evor.tree <subcmd>` and format the result. Mirrors how `refs/sia/sia/orchestrator.py` calls `evaluate.py` as a subprocess.

#### (c) Artifact Store: Custom CoW vs DVC vs git-annex

| Option | Pros | Cons |
|--------|------|------|
| **Custom content-hash + hardlinks** (chosen) | Zero deps; sha256-addressed; `os.link()` + `os.symlink()` CoW on same filesystem; GC by refcount tracking; ~150 lines | Must implement refcount tracking; no built-in cloud sync |
| DVC | Battle-tested; cloud backends | Heavy dep; Forge must `pip install dvc` per worktree; DVC commands intrude into training code |
| git-annex | Good large-file tracking | Git dependency conflicts with worktree code isolation; very complex; binary required |

**Decision:** Spec says "CoW/hardlink/symlink" directly (spec R9). DVC noted as optional extension for remote artifact push post-v1.

#### (d) Dashboard: FastAPI+SSE vs Static Regen

| Option | Pros | Cons |
|--------|------|------|
| **FastAPI + SSE** (chosen) | Live telemetry streaming; spec says "SIA-style"; mirrors `refs/sia/sia/web/server.py`; live frontier updates during long training runs | Requires `uvicorn` background process |
| Static regen | Zero server; simpler | No live updates; spec R10 requires "live dashboard" |

**Decision:** FastAPI + SSE for the live dashboard. Static regen used for `evor-report` final export only.

#### (e) Selection Policy: MCTS vs UCB1 vs Beam

| Option | Pros | Cons |
|--------|------|------|
| **UCB1 default** (chosen) | Well-understood; O(n) selection; single tunable constant `ucb1_c`; degrades gracefully to greedy at c=0; meta-evolvable | No lookahead; can get stuck without diverse proposals (mitigated by H002/H003) |
| MCTS | Full lookahead | Requires rollout policy; expensive — each training run takes minutes; overkill for ≤50-node trees |
| Beam | Deterministic; easy to explain | No exploration; misses backtracking benefit spec requires |

**Decision:** UCB1 as M5 default. MCTS available as `selection_policy: "mcts"` in `strategy.json` (meta-evolution can switch). Beam available for debugging. All three fit the tree design spec R5 describes.

---

## Repository Layout

```
oh-my-evor/                               # CLAUDE_PLUGIN_ROOT
├── .claude-plugin/
│   └── plugin.json                       # manifest (mirror refs/oh-my-claudecode/.claude-plugin/plugin.json)
├── hooks/
│   └── hooks.json                        # PostToolUse · Stop · SessionStart (mirror refs/oh-my-claudecode/hooks/hooks.json)
├── skills/
│   ├── evor/SKILL.md                     # main 9-step tick loop + meta-evolution
│   ├── evor-setup/SKILL.md               # mission interview → GoalContract
│   ├── evor-run/SKILL.md                 # launch / resume
│   ├── evor-dashboard/SKILL.md           # start FastAPI dashboard
│   └── evor-report/SKILL.md              # final report + static export
├── agents/
│   ├── evor-sage.md                      # Sage (Researcher, Sonnet)
│   ├── evor-mutagen.md                   # Mutagen (Dreamer, Sonnet)
│   ├── evor-probe.md                     # Probe (EDA/Analyst, Sonnet)
│   ├── evor-forge.md                     # Forge (Implementer, Sonnet)
│   └── evor-selector.md                  # Selector (Critic, Sonnet)
├── commands/
│   ├── evor.md · evor-run.md · evor-setup.md · evor-dashboard.md · evor-resume.md
├── mcp/
│   ├── src/
│   │   ├── index.ts                      # MCP server entry, stdio transport
│   │   ├── tools/
│   │   │   ├── record.ts                 # evor_record_node, evor_record_eval
│   │   │   ├── tree.ts                   # evor_tree_read, evor_select
│   │   │   ├── schedule.ts               # evor_schedule
│   │   │   ├── wiki.ts                   # evor_wiki_add, evor_wiki_query
│   │   │   ├── state.ts                  # evor_state_read, evor_state_write
│   │   │   ├── integrity.ts              # evor_integrity_check
│   │   │   ├── cite.ts                   # evor_cite
│   │   │   └── telemetry.ts              # evor_telemetry_ingest
│   │   ├── schemas/
│   │   │   └── contracts.ts              # Zod schemas + TS interfaces for all 11 contracts
│   │   └── store/
│   │       ├── tree-store.ts             # tree.json atomic read/write (rename-swap)
│   │       └── run-store.ts              # .evor/runs/<mission>/<run-id>/ path resolver
│   ├── package.json · tsconfig.json
│   ├── vitest.config.ts                  # mirror refs/oh-my-claudecode/vitest.config.ts
│   └── tests/
│       ├── record.test.ts · tree.test.ts · integrity.test.ts · telemetry.test.ts
│       └── hooks.test.ts
├── harness/
│   ├── evor/
│   │   ├── __init__.py
│   │   ├── contracts.py                  # Pydantic v2 strict models (all 27 schemas incl. Addendum v2 + consensus pass 2 + Q2 GenomeSeedAdapterReport)
│   │   ├── tree.py                       # TreeEngine: UCB1, crossover, worst-angle/worst-domain fitness, MCTS stub
│   │   ├── store.py                      # ContentAddressedStore (hardlink/symlink/CoW + refcount GC)
│   │   ├── genome.py                     # Addendum v2 Pillar 1 — GenomeConfig loader/validator; genome adapter (seed-repo); crossover merge logic; validate_schema_extensions()
│   │   ├── genome-schema-registry.json   # R-5: maps schema_extensions name → {type, valid_range, introduced_by_node_id}
│   │   ├── freeze.py                     # Addendum v2 Pillar 2 — FrozenSplit creation (chmod 444); DataProvenance tracker; near-dup leakage check
│   │   ├── benchmark.py                  # Addendum v2 Pillar 3 — EvalSuite/EvalVersion management; BenchmarkUpgrade governance; MetricRegistry
│   │   ├── angle_registry.py             # Addendum v2 Pillar 4 — AngleRegistry CRUD; SOTA bar fetch (SotaSource); coverage computation
│   │   ├── scheduler.py                  # ResourceScheduler + throughput probe
│   │   ├── monitor.py                    # SelfHealMonitor (OOM/NaN/dep/checkpoint playbook)
│   │   ├── telemetry.py                  # TelemetryCallback SDK (PyTorch/plain-loop)
│   │   ├── evaluator.py                  # EvaluatorAdapter subprocess contract; per-domain result emission
│   │   ├── integrity.py                  # IntegrityGate (frozen-split hash, near-dup leakage, provenance, eval-version, shift, sanity)
│   │   ├── wiki.py                       # CompoundingWiki (append + keyword search + cross-run)
│   │   ├── plot_tree.py                  # ASCII + graphviz tree; frontier highlight; eval_version annotations
│   │   └── dashboard/
│   │       ├── server.py                 # FastAPI app + SSE telemetry streams
│   │       ├── routes/
│   │       │   ├── tree.py · artifacts.py · telemetry.py
│   │       └── static/index.html         # D3 tree + Chart.js telemetry curves
│   ├── pyproject.toml
│   └── tests/
│       ├── test_contracts.py · test_tree.py · test_store.py · test_scheduler.py
│       ├── test_monitor.py · test_telemetry.py · test_evaluator.py
│       ├── test_integrity.py · test_wiki.py · test_dashboard.py
├── benchmarks/
│   ├── cifar10-subset/
│   │   ├── baseline_trainer.py · evaluator.py · eval_lock.json · task.md
│   └── tabular-churn/
│       ├── baseline_trainer.py · evaluator.py · eval_lock.json · task.md
├── scripts/
│   ├── l1-check.mjs                      # validate plugin.json paths + SKILL.md frontmatter
│   ├── l2-test.sh                        # npm test && uv run pytest harness/tests/
│   └── l3-e2e.sh                         # install + full run + assert all AC checkboxes
├── package.json                          # root scripts: build, test, lint:l1
├── pyproject.toml                        # root Python: pytest, pydantic, fastapi, uvicorn, httpx
├── .mcp.json                             # {"mcpServers": {"evor": {"command":"node","args":["mcp/dist/index.cjs"]}}}
└── .gitignore                            # .evor/runs/*/artifacts/ node_modules/ dist/ __pycache__/
```

**Candidate genome structure** (Addendum v2 Pillar 1 — generated by Forge per approved MutationProposal):
```
.evor/worktrees/<node-id>/               # isolated git worktree; Forge writes here only
  genome.yaml                            # GenomeConfig — declarative genome; content-hashed → genome_ref
  data/                                  # dataset builder + augmentation pipeline
    builder.py                           # train data loading + curation
    aug.py                               # online/offline augmentation (train only; never touches test/val)
  model/                                 # backbone · neck · head assembled by build_model(genome)
    backbone.py · neck.py · head.py
  train/                                 # training strategy: optimizer, schedule, loss, regularization
    trainer.py
  evaluate.py                            # LOCKED — Forge mutations never touch this file
```

**Runtime state root** (gitignored):
```
.evor/runs/<mission-slug>/<run-id>/
  tree.json                              # full DAG; atomic-written by MCP evor_record_node
  run-state.json                         # status, tick count, best_score, frontier_ids, current eval_version
  strategy.json                          # StrategyState; updated by meta-evolution loop
  decision-log.md                        # DecisionLogEntry append-only markdown
  eval-suites/
    <eval_version>.json                  # Addendum v2 Pillar 3 — EvalSuite snapshot per version
  angle-registry.json                    # Addendum v2 Pillar 4 — AngleRegistry; updated by BenchmarkUpgrade
  genome-seed-adapter-report.json        # Addendum v2 Pillar 1 — GenomeSeedAdapterReport; seed-repo mode only; reproducibility artifact for genome adapter seam mapping (Q2)
  frozen-splits/
    <eval_version>-test.json             # Addendum v2 Pillar 2 — FrozenSplit (hash-locked, read-only)
    <eval_version>-val.json
  nodes/<node-id>/
    code/                                # git worktree ref (or patch file)
    genome.yaml                          # Addendum v2 Pillar 1 — snapshot of GenomeConfig at this node
    parent.patch                         # Addendum v2 Pillar 1 — git format-patch vs parent (diff stored, not full copy)
    data-version                         # content-hash pointer into artifacts/
    data-provenance.jsonl                # Addendum v2 Pillar 2 — DataProvenance records for augmented train samples
    telemetry.jsonl                      # append-only TelemetryRecord stream
    results.json                         # EvaluationResult (includes per_domain, eval_version, fitness_value)
    lessons.md                           # Probe output for this node
  evaluations/<node-id>.json             # IntegrityReport (includes frozen_split_read_only, near_dup_leakage, eval_version_consistent)
  artifacts/<sha256[:2]>/<sha256[2:]>    # content-addressed blobs (data + weights + genome.yaml + patches)
  wiki/<lesson-id>.md                    # LessonEntry files
.evor/wiki/                              # cross-run compounding wiki (outside run-id dir)
  index.jsonl                            # append-only LessonEntry index
  <lesson-id>.md
```

---

## Data Contracts

All 11 schemas defined in **both** `mcp/src/schemas/contracts.ts` (Zod + TS interfaces) and `harness/evor/contracts.py` (Pydantic v2 strict). Schema discipline mirrors `refs/oh-my-claudecode/skills/self-improve/data_contracts.md`.

### GoalContract
```typescript
interface GoalContract {
  mission_id: string;              // kebab-slug, e.g. "cifar10-improve-2026-07"
  mode: "seed-repo" | "from-scratch";
  mission_type: "fixed" | "open_ended"; // Addendum v2 Pillar 4 — fixed: frozen test; open_ended: monotonic benchmark ratchet
  task_description: string;
  dataset_ref: string;             // filesystem path or URI
  // Pillar 3: metric_specs supersedes flat metrics[]; legacy metrics[] retained for back-compat reading
  metrics: Array<{ name: string; direction: "higher" | "lower"; primary: boolean }>;
  metric_specs: MetricSpec[];      // Addendum v2 Pillar 3 — self-describing, domain-aware metric registry
  fitness_mode: "aggregate" | "worst-domain" | "weighted"; // Addendum v2 Pillar 3+4 — drives tree selection
  eval_version: string;            // Addendum v2 Pillar 3 — current active EvalSuite version id; bumped by BenchmarkUpgrade
  baseline_value: number;
  target_value?: number;
  coverage_target?: number;        // Addendum v2 Pillar 4 — open_ended stop: fraction of angles ≥ SOTA (0.0–1.0)
  stop_condition: {
    type: "beat-baseline" | "beat-sota" | "target" | "maximize-under-budget"
        | "evolve-n" | "evolve-until-plateau" | "evolve-until-regression"
        | "worst-angle-plateau" | "coverage-target"; // Addendum v2 Pillar 4
    n?: number;
  };
  wildness: number;               // 0.0–1.0, default 0.5; meta-evolvable
  budget: {
    max_iterations: number;       // default 50 (spec §Constraints)
    plateau_window: number;       // default 8
    circuit_breaker: number;      // default 5 consecutive failures
    max_cost_usd: number;         // default 0 = local-only until cloud configured
    max_wall_clock_hours?: number;
    max_gpu_hours?: number;
  };
  framework?: string;             // "pytorch" default for from-scratch; inherited for seed-repo
  seed_repo_path?: string;        // for seed-repo mode
  locked_split_hash: string;      // sha256(dataset_ref + split_config); set at mission start; Pillar 2 invariant
  eval_script_hash: string;       // sha256 of eval script; used by IntegrityGate no_eval_shift check
  expansion_policy?: ExpansionPolicy; // Addendum v2 Pillar 4 — required when mission_type=open_ended
  allowed_licenses: string[];     // allowlist for data-acquisition provenance; default ["MIT","Apache-2.0","BSD-2-Clause","BSD-3-Clause","CC-BY-4.0","CC0-1.0"] (R-3)
  created_at: string;             // ISO 8601
}
```

### TreeNode
```typescript
interface TreeNode {
  id: string;                      // uuid v4
  parent_ids: string[];            // [] = root; length 2 = crossover node
  approach_family: ApproachFamily;
  hypothesis_id: string;           // ref to registered Hypothesis
  code_ref: string;                // relative path: nodes/<id>/code/ or patch file
  parent_patch_ref?: string;       // Addendum v2 Pillar 1 — content-hash of git format-patch vs parent
  genome_ref: string;              // Addendum v2 Pillar 1 — content-hash of genome.yaml for this node
  mutation_tier?: "parametric" | "structural"; // Addendum v2 Pillar 1 — which mutation tier produced this node
  mutation_locus?: MutationLocus;  // Addendum v2 Pillar 1 — which seam was touched
  data_version_ref: string;        // content-hash in artifacts/
  config: Record<string, unknown>; // training hyperparameters (deprecated in favor of genome_ref; kept for back-compat)
  weights_ref?: string;            // content-hash; null until training done
  metrics: Record<string, number>; // {primary_metric: value, ...} — aggregate only; see eval_result for per-domain
  eval_version: string;            // Addendum v2 Pillar 3 — EvalSuite version under which this node was evaluated
  fitness_value?: number;          // Addendum v2 Pillar 3+4 — pre-computed per GoalContract.fitness_mode
  telemetry_ref?: string;          // nodes/<id>/telemetry.jsonl
  lesson_ids: string[];            // wiki/<lesson-id>.md refs
  citations: string[];
  integrity_status: "pending" | "passed" | "failed";
  status: "pending" | "running" | "done" | "pruned";
  is_crossover: boolean;
  ucb1_score?: number;
  visit_count: number;
  depth: number;
  created_at: string;
  completed_at?: string;
}

type ApproachFamily =
  | "arch"             // locus: model/
  | "training"         // locus: train/
  | "data-curation"    // locus: data/builder — clean/reweight/relabel/filter EXISTING train samples
  | "data-augmentation"// locus: data/aug    — transform EXISTING train samples (online/offline)
  | "data-acquisition" // locus: data/acquisition — bring in NEW external or synthetic data (see ADR-015)
  | "algo"             // locus: new module + genome extension
  | "other";
// Extends refs/oh-my-claudecode/skills/self-improve/data_contracts.md §6 taxonomy
// NOTE: legacy "augmentation" tag is aliased to "data-augmentation" on read; H002/H003
// comparisons treat them as the same family.
// DATA ACQUISITION ORIGINATION: any agent may source the proposal
//   Sage  → locates public/external datasets with citation
//   Mutagen → proposes creative/cross-domain sources
//   Forge   → generates synthetic data
// Flow is identical: Hypothesis→Critic→Forge→Ingestion Contamination Gate→integrity-gated eval.
// TWO-PATH RULE: acquired data targeting TRAIN → data-acquisition mutation (this path).
//   Acquired data targeting EVAL/TEST → BenchmarkUpgrade (Step 9.5, consent-gated). Never mixed.
```

### MutationProposal
```typescript
interface MutationProposal {
  proposal_id: string;
  parent_node_ids: string[];            // 1 for mutation, 2 for crossover
  approach_family: ApproachFamily;
  idea: string;
  hypothesis: Hypothesis;
  citations: string[];
  wildness: number;
  critic_approved: boolean;
  critic_review: {
    h001_one_hypothesis: "pass" | "fail";
    h002_family_streak: "pass" | "fail"; // no family wins 3 consecutive ticks
    h003_intra_tick_diversity: "pass" | "fail";
    integrity_risk: "pass" | "fail";
    instrumentation_check: "pass" | "fail"; // reject un-instrumented candidates
    schema_valid: "pass" | "fail";
    verdict: "approved" | "rejected";
    rejection_reason?: string;
  };
}

interface Hypothesis {
  id: string;
  statement: string;               // "Doing X will improve Y because Z"
  prediction: string;              // quantified: "val_acc +2–4%"
  confirmed?: boolean;             // set by Probe after evaluation
  evidence?: string;
}
```

### EvaluationResult
```typescript
interface EvaluationResult {
  node_id: string;
  run_id: string;
  eval_version: string;            // Addendum v2 Pillar 3 — EvalSuite version; gate refuses cross-version comparison
  metrics: Record<string, number>; // aggregate metrics (primary metric, secondary reported-only)
  // Addendum v2 Pillar 3 — per-domain breakdown; Probe pivots on (eval_version, domain, metric_name)
  per_domain: Record<string, Record<string, number>>; // { "scanned": { "accuracy": 0.91 }, "handwritten": { "accuracy": 0.78 } }
  fitness_value: number;           // Addendum v2 Pillar 3+4 — computed per GoalContract.fitness_mode
  worst_angle_coverage?: number;   // Addendum v2 Pillar 4 — fraction of angles ≥ their SOTA bar; null if fixed mission
  per_angle_vs_sota?: Record<string, { value: number; sota_bar: number; above_sota: boolean }>; // Pillar 4
  telemetry_summary: {
    final_train_loss?: number;
    best_val_metric?: number;
    grad_norm_median?: number;
    throughput_samples_per_sec?: number;
    total_steps: number;
  };
  status: "success" | "regression" | "error" | "timeout" | "oom";
  benchmark_raw: string;           // stdout verbatim (subprocess contract mirrors refs/sia evaluate.py)
  timestamp: string;
}
```

### IntegrityReport
```typescript
interface IntegrityReport {
  node_id: string;
  eval_version: string;            // Addendum v2 Pillar 3 — version this report evaluated under
  checks: {
    split_hash_match: boolean;     // recomputed hash == GoalContract.locked_split_hash (Pillar 2 layer 2)
    frozen_split_read_only: boolean; // Addendum v2 Pillar 2 layer 1 — chmod 444 on test/val confirmed
    no_test_leakage: boolean;      // train set ∩ test set == ∅ (index + content-hash level, 200 sampled pairs)
    near_dup_leakage: boolean;     // Addendum v2 Pillar 2 layer 3 — near-duplicate aug-of-test check
    data_provenance_valid: boolean; // Addendum v2 Pillar 2 layer 4 — augmented sample traces back to train, not test
    no_label_contamination: boolean; // index-level + sha256(sample) content-hash check (see R5)
    no_eval_shift: boolean;        // eval_script sha256 unchanged
    eval_version_consistent: boolean; // Addendum v2 Pillar 3 — node.eval_version matches GoalContract.eval_version
    telemetry_sane: boolean;       // loss not NaN/Inf/constant; grad_norm > 0 (conditional on field presence, R6)
    reward_hacking_probe: boolean; // val_metric jump >30% baseline in 1 step → flag
    // data-acquisition mutation checks (skipped for non-acquisition nodes)
    acquisition_contamination_clear: boolean | null; // null = not a data-acquisition node
      // true = no acquired/synthetic sample collides with ANY frozen eval split across ALL eval_versions
      //        (index + content-hash + near-dup/embedding-similarity)
    acquired_data_provenance_valid: boolean | null; // null = not a data-acquisition node
      // true = AcquisitionProvenance present with license + citation; synthetic → generator_config present
    acquisition_namespace_enforced: boolean | null; // null = not a data-acquisition node
      // true = DataStore confirms acquired samples landed in train namespace only, never eval namespace
  };
  verdict: "passed" | "failed";
  failure_reason?: string;
  verified_at: string;
}
```

### Addendum v2 — New Schema Entities

*These schemas are defined in both `mcp/src/schemas/contracts.ts` (Zod) and `harness/evor/contracts.py` (Pydantic v2 strict), following the same discipline as the 11 base schemas. Schema count grows from 11 to 26 (13 Addendum v2 + BenchmarkRescore + AngleVsSOTA added in consensus pass 2).*

#### GenomeConfig (Pillar 1)
```typescript
// Stored at candidate/genome.yaml; content-hashed into genome_ref on TreeNode
interface GenomeConfig {
  genome_version: string;          // schema version for this genome spec (semver)
  backbone?: string;               // model backbone identifier, e.g. "resnet9", "vit-small"
  head?: string;                   // task head identifier
  neck?: string;                   // optional neck/FPN
  optimizer: string;               // e.g. "adamw"
  lr: number;
  lr_schedule: string;             // e.g. "cosine", "one-cycle"
  batch_size: number;
  epochs: number;
  loss: string;                    // loss function identifier
  aug_set: string[];               // data-augmentation identifiers active for train (data-augmentation family)
  acquired_datasets: string[];     // data-acquisition: acquisition_ids from AcquisitionProvenance records; [] = no external/synthetic data
  regularization: Record<string, unknown>;
  // Structural mutations extend this schema by adding new keys; schema_extensions[] tracks them
  schema_extensions: string[];     // names of structurally-added keys (empty for gen-1 root)
  extra: Record<string, unknown>;  // open extension bag for Pillar-1 structural mutations
}
```

#### MutationLocus (Pillar 1, extended for data-acquisition)
```typescript
// Maps approach_family to the seam file/dir that Forge touches
type MutationLocus =
  | { family: "arch";              path: "model/" }
  | { family: "training";          path: "train/" }
  | { family: "data-curation";     path: "data/builder" }
  | { family: "data-augmentation"; path: "data/aug" }
  | { family: "data-acquisition";  path: "data/acquisition";
      acquisition_type: "external" | "synthetic";
      // external: Forge downloads/copies a licensed dataset; AcquisitionProvenance required
      // synthetic: Forge generates samples (e.g. model-generated, simulation); generator_config required
    }
  | { family: "algo";              path: string; genome_extension: string }; // extends GenomeConfig.extra
```

#### AcquisitionProvenance (data-acquisition)
```typescript
// Required for every data-acquisition mutation; carried in DataProvenance + IntegrityReport
interface AcquisitionProvenance {
  acquisition_id: string;
  acquisition_type: "external" | "synthetic";
  // external acquisitions
  source_name?: string;          // e.g. "Open Images v7", "HuggingFace cifar100"
  source_url?: string;
  license_identifier: string;    // SPDX identifier e.g. "CC-BY-4.0", "MIT", "proprietary-restricted" (R-3)
  license_in_allowlist: boolean; // true iff license_identifier ∈ GoalContract.allowed_licenses (R-3)
  citation: string;              // bib/arxiv/URL; required; consistent with "citation-backed" mandate
  // synthetic acquisitions
  generator_config?: Record<string, unknown>; // model/method used to generate; required if synthetic
  // shared
  sample_count: number;
  acquired_at: string;           // ISO 8601
  ingestion_contamination_cleared: boolean; // set by IntegrityGate after Ingestion Contamination Gate
}
```

#### FrozenSplit (Pillar 2)
```typescript
interface FrozenSplit {
  split_id: string;
  mission_id: string;
  split_type: "test" | "val";
  split_hash: string;              // sha256(sorted indices + content hashes); must match GoalContract.locked_split_hash
  per_sample_hashes: Record<string, string>; // { sample_index: sha256(sample) }
  item_count: number;
  frozen_at: string;               // ISO 8601; set once at mission start
  storage_path: string;            // absolute path; chmod 444 enforced
  eval_version: string;            // EvalSuite version this split belongs to
}
```

#### DataProvenance (Pillar 2)
```typescript
interface DataProvenance {
  sample_id: string;
  source_sample_id: string;        // original training sample ID this was derived from
  split_type: "train";             // DataProvenance only exists for train samples
  transform_applied: string[];     // ordered list of augmentation ops applied
  is_synthetic: boolean;
  verified_not_in_test: boolean;   // confirmed sha256(this) ∉ FrozenSplit.per_sample_hashes
}
```

#### EvalSuite / EvalVersion (Pillar 3)
```typescript
interface EvalSuite {
  eval_version: string;            // e.g. "v1", "v2"; bumped by BenchmarkUpgrade; never mutated in-place
  mission_id: string;
  parent_eval_version?: string;    // "v2" ⊇ "v1"; superset invariant: domains only added, never removed
  domains: Domain[];
  split_hashes: Record<string, string>; // { domain_id: sha256 } — each domain's frozen held-out split
  created_at: string;
  created_by: "user" | "policy";   // governance: Forge/agents cannot create EvalSuites
  consent_log_ref: string;         // DecisionLogEntry id recording user consent / policy authorization
}

interface Domain {
  domain_id: string;               // e.g. "scanned", "handwritten", "angle-reasoning"
  description: string;
  metric_specs: MetricSpec[];      // which metrics apply to this domain
  sota_source?: SotaSource;        // Pillar 4 — SOTA bar for this domain/angle
  added_at_eval_version: string;   // which EvalSuite version added this domain
}
```

#### MetricSpec / MetricRegistry (Pillar 3)
```typescript
interface MetricSpec {
  metric_name: string;             // e.g. "accuracy", "auc_roc", "f1_macro"
  direction: "higher" | "lower";
  domain_applicability: string[] | "all"; // which Domain ids this metric applies to
  aggregation_rule: "macro_avg" | "weighted_avg" | "min" | "max";
  role: "primary_fitness" | "secondary_reported";
  sota_bar?: number;               // Pillar 4 — current published SOTA value for this metric+domain
}

// MetricRegistry is the GoalContract's live view of all registered MetricSpecs
type MetricRegistry = Record<string, MetricSpec>; // keyed by metric_name
```

#### BenchmarkUpgrade (Pillar 3 + 4)
```typescript
// Governance record for every eval_version bump; consent-gated.
// CREATION RULE (Q4): BenchmarkUpgrade records are created ONLY by benchmark.py::apply_upgrade().
// Agents (Sage/Probe/Mutagen) submit a BenchmarkUpgradeProposal; apply_upgrade() validates and
// consent-gates it before materialising the BenchmarkUpgrade record.
interface BenchmarkUpgrade {
  upgrade_id: string;
  mission_id: string;
  from_eval_version: string;
  to_eval_version: string;         // always a superset: to ⊇ from
  proposed_by: "user" | "probe" | "sage" | "policy"; // original proposer, copied from BenchmarkUpgradeProposal
  proposal_citations: string[];    // must cite evidence (saturation, new angle discovery, etc.)
  consent_granted: boolean;        // false = proposal only; upgrade not applied
  consent_at?: string;
  new_domains_added: string[];     // domain_ids added in this upgrade
  domains_removed: string[];       // DEFENSIVE INVARIANT (Q4): MUST always be empty; apply_upgrade() asserts len==0 and no code path ever populates this; exists only to trip on a malformed/hand-authored record
  rescore_status: "pending" | "in_progress" | "complete" | "partial"; // Pillar 3
  rescore_deadline_ticks: number;  // tick count after which not-yet-rescored nodes are demoted to "v{old}-only" (R-2)
  decision_log_ref: string;        // DecisionLogEntry id
  created_at: string;
}

// Lightweight proposal submitted by Probe/Sage; consumed by benchmark.py::apply_upgrade() (Q4)
// Forge and Mutagen CANNOT submit BenchmarkUpgradeProposal.
interface BenchmarkUpgradeProposal {
  proposed_by: "probe" | "sage";
  new_domains: string[];           // domain_ids proposed to add
  rationale: string;               // why this upgrade is warranted (saturation / new angle evidence)
  citations: string[];             // evidence citations (papers, measurements, source URLs)
}
```

#### ExpansionPolicy / AngleRegistry / CoverageTarget / SotaSource (Pillar 4)
```typescript
interface ExpansionPolicy {
  auto_add_within_families: string[]; // approach_families where BenchmarkUpgrade is pre-authorized
  require_consent_for: string[];   // domain families requiring explicit user consent
  sota_sources: SotaSource[];      // which external sources count as authoritative SOTA
  max_angles_per_upgrade: number;  // governance cap — max new domains per BenchmarkUpgrade
  max_upgrades_per_N_ticks: { max_upgrades: number; per_ticks: number }; // default {max_upgrades: 1, per_ticks: 5}; at most 1 BenchmarkUpgrade per 5 ticks; prevents re-scoring from dominating compute over candidate evolution (Risk D-2)
  pretraining_canary_threshold_pp: number; // default 5.0; ABSOLUTE percentage-point residual (sota_bar - baseline_model_score_before_finetune < threshold) triggers high-contamination flag (R-9)
}

interface SotaSource {
  source_id: string;
  name: string;                    // e.g. "Papers With Code", "arXiv", "custom-human-eval"
  url?: string;
  retrieval_method: "mcp_search" | "web_fetch" | "human_provided";
  trust_level: "authoritative" | "indicative"; // authoritative = used as binding SOTA bar
}

interface AngleRegistry {
  mission_id: string;
  angles: Array<{
    angle_id: string;              // domain_id in the EvalSuite
    eval_version_added: string;
    sota_bar: number;
    sota_source_ids: string[];     // >=2 required for authoritative trust_level (R-1)
    sota_quorum_met: boolean;      // true iff >=2 distinct sources with divergence <=5% (R-1)
    baseline_model_score_before_finetune: number | null; // seed/foundation model score on this angle's held-out split before any fine-tuning; null until evaluated (R-1/R-13)
    sota_retrieved_at: string;
    held_out_split_hash: string;   // fresh split frozen when angle was added; never touches training side
    is_public_benchmark: boolean;  // flag for contamination risk; see Open Design Risks
    pretraining_contamination_risk: "low" | "medium" | "high" | "unknown";
  }>;
  updated_at: string;
}

interface CoverageTarget {
  target_fraction: number;         // e.g. 0.95 = ≥SOTA on ≥95% of angles
  current_worst_angle_id?: string; // angle with lowest current fitness_value
  current_coverage: number;        // fraction of angles currently ≥ their SOTA bar
}

// R-6: merge protocol for incremental BenchmarkUpgrade re-scoring
interface BenchmarkRescore {
  upgrade_id: string;              // ref to BenchmarkUpgrade record
  node_id: string;                 // node being re-scored
  cached_per_domain: Record<string, Record<string, number>>; // v_old per_domain scores, carried forward
  new_domains: string[];           // domain_ids evaluated with partial --eval-domains run
  merged_eval_version: string;     // the to_eval_version of the BenchmarkUpgrade
}

// R-11: per-angle comparison result returned by score_angles()
interface AngleVsSOTA {
  angle_id: string;
  value: number;                   // model's score on this angle's held-out split
  sota_bar: number;                // effective bar = max(sota_bar, baseline_model_score_before_finetune) (R-9)
  above_sota: boolean;             // value >= sota_bar (only counts if trust_level="authoritative")
  trust_level: "authoritative" | "indicative"; // authoritative = counts toward coverage stop condition (R-8)
}
```

#### GenomeSeedAdapterReport (Pillar 1 — seed-repo reproducibility artifact)
```typescript
// Schema 27 (Q2): written by Forge during seed-repo genome adapter step; stored at
// runs/<mission>/<run-id>/genome-seed-adapter-report.json
interface GenomeSeedAdapterReport {
  seed_repo_path: string;          // absolute path to the seed repository audited by Forge
  detected_seams: Array<{
    kind: "model_def" | "training_loop" | "data_pipeline"; // seam category
    file: string;                  // relative path within seed repo
    symbol: string;                // function/class name that serves as the seam
  }>;
  genome_mapping: Record<string, string>; // genome.yaml gene → seed-repo symbol it maps to
  unmapped_regions: string[];      // seed-repo files/symbols with no genome counterpart
  created_at: string;              // ISO 8601
}
```

---

### TelemetryRecord
```typescript
interface TelemetryRecord {
  step: number;
  epoch?: number;
  train_loss?: number;
  val_metric?: number;             // primary metric value at this step
  lr?: number;
  grad_norm?: number;
  param_norm?: number;
  update_ratio?: number;           // grad_norm / param_norm
  throughput?: number;             // samples/sec
  gpu_util?: number;               // 0–100
  mem_used_gb?: number;
  mem_total_gb?: number;
  node_id: string;
  run_id: string;
  timestamp: string;               // ISO 8601
}
// Mandatory schema from spec §Telemetry Instrumentation Contract
// Forge MUST emit; Selector MUST reject un-instrumented candidates
```

### LessonEntry
```typescript
interface LessonEntry {
  lesson_id: string;
  node_id: string;
  run_id: string;
  mission_id: string;              // enables cross-run wiki queries
  approach_family: ApproachFamily;
  hypothesis_verdict: "confirmed" | "refuted" | "inconclusive";
  observation: string;
  root_cause?: string;
  actionable_lesson: string;
  citations: string[];
  telemetry_evidence?: string;     // key curve observations from Probe EDA
  tags: string[];
  created_at: string;
}
```

### StrategyState
```typescript
interface StrategyState {
  meta_iteration: number;
  selection_policy: "ucb1" | "mcts" | "beam";
  ucb1_c: number;                  // default 1.41 (sqrt(2)); meta-evolvable
  beam_width?: number;
  wildness: number;                // current wildness dial; initially from GoalContract
  family_mix: Record<ApproachFamily, number>; // target probability weights; sums to 1
  winning_families: ApproachFamily[];         // last N tick winners
  wins_by_family: Record<ApproachFamily, number>;
  meta_loop_interval: number;      // ticks between meta-evolution updates; default 5
  post_upgrade_exploration_boost: number | null; // temporary wildness override applied after BenchmarkUpgrade; null = none active (R-4)
  post_upgrade_exploration_ticks: number;        // ticks remaining for boost; default max(5, frontier_size*2) capped at 15 (R-4)
  rescore_mode: "sync" | "async";               // SINGLE source of truth for BenchmarkUpgrade re-score mode; default "sync"; read by benchmark.py::apply_upgrade() and M8 Step 9.5; do NOT add a separate rescore_synchronous param (Q1)
  updated_at: string;
}
```

### ResourcePlan
```typescript
interface ResourcePlan {
  concurrency: number;             // current parallel candidate count
  gpu_ids: number[];               // detected GPU indices (empty = CPU-only)
  cpu_fallback: boolean;
  throughput_samples_per_sec: number;  // measured by throughput probe
  vram_per_job_gb: number;
  util_target: number;             // default 0.90 (back off at ~90% util)
  last_probed_at: string;
}
```

### DecisionLogEntry
```typescript
interface DecisionLogEntry {
  timestamp: string;
  tick: number;
  decision_type: "select" | "propose" | "critique" | "implement" | "evaluate"
               | "analyze" | "record" | "prune" | "stop" | "meta-evolve";
  rationale: string;
  node_ids: string[];
  strategy_delta?: Partial<StrategyState>;
}
```

---

## MCP Tool Signatures

All 12 tools in `mcp/src/tools/`. Server: `mcp/src/index.ts`, stdio transport.

```
evor_record_node(run_id: string, node: TreeNode) → { ok: boolean }
  — validate Zod schema; atomic write tree.json (rename-swap); append DecisionLogEntry

evor_record_eval(run_id: string, node_id: string, result: EvaluationResult) → { ok: boolean }
  — write nodes/<id>/results.json; auto-trigger evor_integrity_check if not already run

evor_tree_read(run_id: string, subtree_root?: string, depth?: number) → TreeNode[]
  — read tree.json; filter by subtree + depth limit

evor_select(run_id: string, strategy?: Partial<StrategyState>, count?: number) → {
    selected: string[]; scores: Record<string, number>
  }
  — exec `python -m evor.tree select --run-id <id> [--strategy <json>] [--count N]`
  — returns UCB1-ranked parent node IDs; crossover triggered if top-2 from distinct lineages

evor_schedule(run_id: string, node_id: string, job_spec: JobSpec) → {
    job_id: string; estimated_start: string
  }
  — delegate to ResourceScheduler.submit() via Python subprocess

evor_wiki_add(run_id: string, entry: LessonEntry) → { lesson_id: string }
  — write wiki/<lesson_id>.md; append to .evor/wiki/index.jsonl (cross-run)

evor_wiki_query(run_id: string, query: string, approach_family?: ApproachFamily,
                confirmed_only?: boolean, limit?: number) → LessonEntry[]
  — keyword search over .evor/wiki/index.jsonl; filter by family; cross-run scope

evor_state_read(run_id: string) → RunState
  — read .evor/runs/<mission>/<run-id>/run-state.json

evor_state_write(run_id: string, patch: Partial<RunState>) → { ok: boolean }
  — merge-patch run-state.json; append strategy delta to strategy.json if provided

evor_integrity_check(run_id: string, node_id: string) → IntegrityReport
  — exec `python -m evor.integrity check --run-id <id> --node-id <nid>`; parse stdout JSON result
  — writes IntegrityReport to `evaluations/<node-id>.json` (top-level run dir, not under nodes/)

evor_cite(run_id: string, node_id: string, citation: string) → { ok: boolean }
  — append citation to nodes/<id>/results.json citations[]

evor_telemetry_ingest(run_id: string, node_id: string, records: TelemetryRecord[]) → { count: number }
  — append JSONL lines to nodes/<id>/telemetry.jsonl; validate schema per record
```

TS→Python bridge: per-call subprocess JSON pattern as `refs/sia/sia/orchestrator.py` (evaluate.py subprocess pattern) for tools that delegate heavy computation to Python. Note: `refs/oh-my-claudecode/bridge/gyoshu_bridge.py` is the persistent-Unix-socket alternative (lower latency per-call, stateful connection) that was NOT chosen for v1 — see ADR-006.

---

## Agent Definitions

Five files in `agents/`. Frontmatter mirrors `refs/oh-my-claudecode/agents/` style (`name`, `description`, `model`, `level`).

| File | Name (Role) | Model | Core mandate |
|------|-------------|-------|-------------|
| `evor-sage.md` | Sage (Researcher) | sonnet | Citation-backed SOTA survey only; NO speculation; live academic MCP + web fallback; responds to Mutagen's investigation queries; outputs `CitationBackedFinding[]` |
| `evor-mutagen.md` | Mutagen (Dreamer) | sonnet | Unfiltered cross-domain divergence FIRST; then directs Sage with investigation queries; wildness dial governs how far proposals stray from parent's family; generates crossover proposals; outputs `MutationProposal[]` |
| `evor-probe.md` | Probe (EDA/Analyst) | sonnet | EDA on `telemetry.jsonl` (loss curves, gradient pathology, LR sensitivity, error clustering); confirms/refutes registered Hypothesis; outputs `LessonEntry` + `hypothesis_verdict` |
| `evor-forge.md` | Forge (Implementer) | sonnet | Materializes proposals into isolated git worktree; **MUST** inject `from evor.telemetry import TelemetryCallback` and `TelemetryCallback(node_id, run_id)` into every training run before execution; calls harness via `python -m evor.harness run` |
| `evor-selector.md` | Selector (Critic) | sonnet | 6-gate pre-execution check: H001 (one hypothesis), H002 (family streak), H003 (intra-tick diversity), integrity-risk probe, **instrumentation check** (rejects un-instrumented), schema validation; hard gate — all must pass |

Evor orchestrator runs in the main Claude Code session (Opus model); idles via Monitor during compute-bound phases; wakes on `job_complete` or `self_heal_event`.

---

## Phased Implementation Milestones

### M0 — Repo Scaffold + Plugin Manifest (L1)
**Goal:** Valid installable plugin. Every path referenced in `plugin.json` exists on disk. Build tooling runs without error.

**Files to create:**
- `.claude-plugin/plugin.json` — manifest, mirror `refs/oh-my-claudecode/.claude-plugin/plugin.json` structure:
  ```json
  {
    "name": "oh-my-evor",
    "version": "0.1.0",
    "description": "Autonomous ML research evolution engine for Claude Code",
    "skills": ["./skills/evor/", "./skills/evor-setup/", "./skills/evor-run/",
               "./skills/evor-dashboard/", "./skills/evor-report/"],
    "mcpServers": "./.mcp.json",
    "commands": "./commands/"
  }
  ```
- `hooks/hooks.json` — skeleton with PostToolUse, Stop, SessionStart entries; mirror event names from `refs/oh-my-claudecode/hooks/hooks.json`; commands point to `node dist/hooks/<hook>.cjs`
- `package.json` — root scripts: `build`, `test`, `lint:l1`
- `mcp/package.json` + `mcp/tsconfig.json` (strict) + `mcp/vitest.config.ts` (mirror `refs/oh-my-claudecode/vitest.config.ts` exactly)
- `pyproject.toml` — `[project]` with deps: pydantic>=2, fastapi, uvicorn, httpx; `[tool.pytest.ini_options]`
- Stub `SKILL.md` for all 5 skills (frontmatter: `name`, `description`, `level` only)
- Stub `agents/*.md` for all 5 agents (frontmatter: `name`, `description`, `model`, `level`)
- Stub `commands/*.md` for all 5 commands
- Stub `mcp/src/index.ts` (MCP server with zero tools registered)
- `scripts/l1-check.mjs` — parse `plugin.json`; verify all referenced paths exist; parse SKILL.md frontmatter; exit non-zero on first failure
- `.gitignore` — `.evor/runs/`, `node_modules/`, `dist/`, `__pycache__/`, `*.pyc`

**Dependencies:** none.
**Gate layers:** L1 (manifest + all paths exist + `npm run build` + `l1-check.mjs` green).

---

### M1 — Data Contracts Layer (L1+L2 foundation)
**Goal:** All 26 JSON schemas (11 base + 13 Addendum v2 + 2 consensus-pass-2: BenchmarkRescore, AngleVsSOTA) defined, importable, and round-trip tested in both TypeScript and Python.

**Files to create:**
- `mcp/src/schemas/contracts.ts` — Zod schemas + TS interfaces for all 27 contracts; ApproachFamily enum; export `z.infer<>` types. **Addendum v2 additions:** `GenomeConfig`, `MutationLocus`, `FrozenSplit`, `DataProvenance`, `EvalSuite`, `Domain`, `MetricSpec`, `MetricRegistry`, `BenchmarkUpgrade`, `BenchmarkUpgradeProposal`, `ExpansionPolicy`, `SotaSource`, `AngleRegistry`, `CoverageTarget`. **Consensus pass 2 additions:** `BenchmarkRescore`, `AngleVsSOTA`. **Open-questions resolution additions:** `GenomeSeedAdapterReport`. Updated `GoalContract` fields: `mission_type`, `metric_specs[]`, `fitness_mode`, `eval_version`, `coverage_target`, `expansion_policy`. Updated `TreeNode` fields: `parent_patch_ref`, `genome_ref`, `mutation_tier`, `mutation_locus`, `eval_version`, `fitness_value`. Updated `EvaluationResult`: `eval_version`, `per_domain`, `fitness_value`, `worst_angle_coverage`, `per_angle_vs_sota`. Updated `IntegrityReport`: `eval_version`, `frozen_split_read_only`, `near_dup_leakage`, `data_provenance_valid`, `eval_version_consistent`.
- `mcp/src/store/run-store.ts` — `RunStore` class: `resolvePaths(missionId, runId)` → typed path struct; `ensureRunDirs()` creates `nodes/`, `evaluations/`, `artifacts/`, `wiki/`, `eval-suites/`, `frozen-splits/` on first use
- `mcp/src/store/tree-store.ts` — `readTree(runId)`, `writeTree(runId, nodes)` with atomic rename-swap (`writeFileSync` to `.tree.json.tmp`, then `renameSync`)
- `harness/evor/contracts.py` — Pydantic v2 models: `model_config = ConfigDict(strict=True)` on all; mirrors all 27 TS schemas; `ApproachFamily` as `Literal["arch","training","data-curation","data-augmentation","data-acquisition","algo","other"]` (R-12; 7-tag taxonomy; legacy `"augmentation"` aliased to `"data-augmentation"` on read)
- `mcp/tests/schemas.test.ts` — round-trip every schema through Zod parse + `JSON.stringify` + re-parse; negative test for each required field missing. **Addendum v2:** add round-trip tests for all 13 new schemas; test GoalContract with `mission_type="open_ended"` + `expansion_policy`; test EvaluationResult `per_domain` non-empty; test IntegrityReport `near_dup_leakage` field present.

**Schema discipline reference:** `refs/oh-my-claudecode/skills/self-improve/data_contracts.md` — flat JSON objects, no deep nesting beyond 2 levels, all timestamps ISO 8601.

**Dependencies:** M0.
**Gate layers:** L1 (schemas importable), L2 (schema round-trip tests pass).

---

### M2 — MCP Server Skeleton + Hook Registration (L1)
**Goal:** MCP server starts; all 12 tools registered (returning stubs); hooks wired in `hooks.json`.

**Files to create:**
- `mcp/src/index.ts` — full MCP server with stdio transport; import and register all 12 tool handlers (stub implementations: each returns `{ok: true}`)
- `mcp/src/tools/*.ts` — all 8 tool files with stub handler functions (validate input schema, return stub)
- `hooks/post-tool-use.mjs` — skeleton: reads tool name from hook payload; exits 0 (no logic yet)
- `hooks/stop.mjs` — skeleton: reads `EVOR_ACTIVE_RUN_ID` env; exits 0 (no logic yet)
- `hooks/session-start.mjs` — skeleton: reads `.evor/active-run.json` if exists; sets env vars
- `.mcp.json` — `{"mcpServers": {"evor": {"command": "node", "args": ["mcp/dist/index.cjs"]}}}`

**L1 verification:** `node mcp/dist/index.cjs` + send `{"method":"tools/list"}` via stdin → 12 tool names returned. `cat hooks/hooks.json | node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))"` → valid.

**Dependencies:** M1.
**Gate layers:** L1 (all tools registered; hooks.json valid).

---

### M3 — Agent + Skill Definitions (L1)
**Goal:** All 5 agent `.md` files production-complete with full prompts. All 5 `SKILL.md` files production-complete (narrative content, not just stubs). Commands aliased.

**Files to complete:**

**`agents/evor-sage.md` (Sage, Researcher):** Citation mandate — every claim must cite a paper, repo, or measurement. No "I think" allowed. Output format: `CitationBackedFinding[]` with `{title, source_url, finding, evidence, confidence: "high|medium|low"}`. Tools to use: academic MCP search (with web fallback if unavailable), `evor_wiki_query` (check prior lessons before searching), `evor_cite`.

**`agents/evor-mutagen.md` (Mutagen, Dreamer):** Divergence mandate — generate ideas without SOTA filter first. Then emit `investigation_queries[]` for Sage. `wildness` interpretation: 0.0 = minor tweak of parent's approach, 0.5 = different family, 1.0 = entirely different paradigm or cross-domain transfer. Crossover trigger: when asked, recombine parent_a's architecture with parent_b's data pipeline. Output: `MutationProposal[]`.

**`agents/evor-probe.md` (Probe, EDA/Analyst):** EDA checklist: (1) loss curve shape — decreasing/plateaued/diverging; (2) gradient health — `grad_norm` trend, explosion/vanishing; (3) LR sensitivity — `lr` schedule vs loss correlation; (4) error clustering — group wrong predictions by class/feature; (5) telemetry sanity — `throughput` steady, `gpu_util` > 0. Hypothesis verdict protocol: compare prediction vs actual metrics; output `confirmed|refuted|inconclusive` with evidence string.

**`agents/evor-forge.md` (Forge, Implementer):** Worktree workflow: `git worktree add .evor/worktrees/<node_id> -b evor/<node_id>`; implement in worktree only; never touch main branch. **Addendum v2 Pillar 1 — Genome materialization mandate:** Forge's FIRST action for every approved MutationProposal is to materialize the candidate as modular seams in the worktree (`genome.yaml` + `data/` + `model/` + `train/` + locked `evaluate.py`). For from-scratch mode, generate the canonical PyTorch skeleton. For seed-repo mode, audit the repo for existing seams and fit a thin **genome adapter** (`harness/evor/genome.py`) over them — do NOT force a rewrite. After completing the genome adapter, Forge writes `runs/<mission>/<run-id>/genome-seed-adapter-report.json` (`GenomeSeedAdapterReport`) recording: `seed_repo_path`, `detected_seams[{kind, file, symbol}]` (kinds: model_def / training_loop / data_pipeline), `genome_mapping`, `unmapped_regions[]`, `created_at`. This is a reproducibility artifact for the seed-repo path only (Q2). For **parametric mutations**, update the target gene(s) in `genome.yaml` only (backbone swap, optimizer, LR, aug set); call `genome.py::merge_genomes(parent_a, parent_b, loci)` for crossover. For **structural mutations** (novel module not expressible in current schema), write the new module code AND extend `GenomeConfig.extra` + `schema_extensions[]` to expose it as a future knob. Store the mutation as `parent.patch` (`git format-patch` vs parent worktree) + updated `genome.yaml` — never store the full code copy. **Mandatory instrumentation:** after materializing genome seams, inject `TelemetryCallback` into `train/trainer.py` — this is non-negotiable. Harness invocation: `python -m evor.harness run --node-id <id> --run-id <id> --worktree .evor/worktrees/<node_id>`. On OOM: emit event, do NOT manually retry — SelfHealMonitor handles it. Forge **never touches** `evaluate.py` or any frozen-split path.

**`agents/evor-selector.md` (Selector, Critic):** 6-gate checklist (all must pass; mirrors `refs/oh-my-claudecode/skills/self-improve/data_contracts.md §critic_review` structure): H001 (exactly one `Hypothesis` per proposal), H002 (no `approach_family` streak ≥ 3 in `strategy.json.winning_families`), H003 (no two proposals in this tick share same family), integrity risk (no proposal that leaks test labels), instrumentation (`TelemetryCallback` import present in code stub or description), schema (all required fields present). Reject with `rejection_reason` if any gate fails.

**`skills/evor/SKILL.md`:** Full 9-step tick loop with all sub-steps. Model routing table. Doom-loop detection: if 3 consecutive ticks produce zero approved proposals OR zero tool calls from any agent → inject `[DOOM-LOOP DETECTED: forcing exploration mode]`, override wildness to 0.9 for next tick. Mirror `refs/ml-intern/agent/core/agent_loop.py` malformed-tool detection pattern. Coordination: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` for parallel candidate jobs; if this env var is unavailable, fall back to sequential candidate execution (concurrency=1) — Forge agents run one at a time; Evor manages shared task-board via `evor_state_write`. Meta-evolution: every `strategy.ucb1_meta_loop_interval` ticks (default 5), call `python -m evor.tree meta-evolve --run-id <id>`.

**`skills/evor-setup/SKILL.md`:** 8-question Socratic interview → `GoalContract`. **Addendum v2 additions — interview questions added (appended to existing 8):**
- Q9: "Is this a **fixed** mission (single frozen test suite) or **open-ended** (benchmark grows to cover discovered angles)?" → sets `GoalContract.mission_type`.
- Q10 (only if open_ended): "Which SOTA sources count as authoritative? (Papers With Code / arXiv / human-provided?) Should new angles be auto-added within a domain family or require consent per angle?" → populates `ExpansionPolicy`.
- Q11 (only if open_ended): "What is your coverage target? (e.g., ≥SOTA on 95% of angles before declaring success?)" → sets `CoverageTarget`.
- Q12 (always; R-3): "Which data licenses are acceptable for external/synthetic dataset acquisition? (Default allowlist: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, CC-BY-4.0, CC0-1.0 — confirm or customize.)" → sets `GoalContract.allowed_licenses`.
- Q13 (only if open_ended; R-16 — MUST be asked before consent checkpoint): "Compute budget review: based on the preflight ResourcePlan, estimated ticks-to-coverage-target = [computed from coverage_target / expected_ticks_per_angle_gain], estimated total cost = [GPU-hours × rate]. Do you confirm this budget is acceptable before the mission starts?" → requires explicit 'yes' to proceed; blocks mission start if declined.

After interview: env discovery: `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader` + `free -h` + `df -h .evor/`. **Addendum v2 Pillar 2 — frozen split setup:** call `harness/evor/freeze.py::freeze_splits(dataset_path, split_config)` → creates `FrozenSplit` records, `chmod 444` on test/val files, computes `locked_split_hash`; saves to `frozen-splits/<eval_version>-test.json` and `frozen-splits/<eval_version>-val.json`. **Addendum v2 Pillar 3 — initial EvalSuite:** create `EvalSuite v1` with initial domains derived from GoalContract task_description; save to `eval-suites/v1.json`; set `GoalContract.eval_version = "v1"`. Preflight smoke-train: 5 steps, verify loss < initial. One launch consent checkpoint (cannot be skipped, mirrors `refs/oh-my-claudecode/skills/self-improve/SKILL.md §Setup step 4`). For open_ended missions: print ExpansionPolicy summary and require explicit user confirmation before committing.

**`skills/evor-run/SKILL.md`:** Load GoalContract; check `.evor/runs/<mission>/` for existing run-id (resume path); set `EVOR_ACTIVE_RUN_ID`; write `.evor/active-run.json`; invoke `evor` skill tick loop.

**`skills/evor-dashboard/SKILL.md`:** Start `uvicorn evor.dashboard.server:app --port 8756` in background thread; print URL; attempt `xdg-open` / `open` for browser.

**`skills/evor-report/SKILL.md`:** Read tree.json; call `python -m evor.plot_tree --run-id <id> --format png`; render frontier table; export static HTML.

**Dependencies:** M0, M1, M2.
**Gate layers:** L1 (all .md files parse; `l1-check.mjs` green).

---

### M4 — Python Harness: ContentAddressedStore + ResourceScheduler (L2)
**Goal:** Artifact store, resource scheduler, and environment discovery pass unit tests.

**`harness/evor/store.py` — ContentAddressedStore:**
```python
class ContentAddressedStore:
    def put(self, src_path: Path) -> str:
        """sha256 of content; hardlink into artifacts/<sha[:2]>/<sha[2:]>;
        if same-device hardlink fails (cross-device), copy then chmod 444.
        Atomic refcount write: serialize updated dict to artifacts/.refcounts.json.tmp,
        then os.replace() → artifacts/.refcounts.json (mirrors tree.json rename-swap).
        Crash between tmp-write and os.replace() leaves .tmp behind; next put()/gc()
        cleans up the orphaned .tmp before proceeding."""
        
    def get(self, content_hash: str) -> Path:
        """Return path to blob; raise if missing."""
        
    def link(self, content_hash: str, target: Path) -> None:
        """Create hardlink at target; fallback to symlink if hardlink fails.
        Symlink fallback MUST increment the blob's refcount (same atomic write path as
        hardlink) to prevent GC from dangling the blob. Alternatively, prohibit symlink
        fallback entirely and use copy-only — see ADR-003 consequence note."""
        
    def gc(self, referenced_hashes: set[str]) -> int:
        """Delete all blobs not in referenced_hashes; return count deleted."""
        
    def put_delta(self, base_hash: str, patch_path: Path) -> str:
        """Store patch as blob; metadata links base→delta."""
        
    def apply_delta(self, base_hash: str, delta_hash: str) -> Path:
        """Reconstruct from base + delta into temp dir; return path."""

    # data-acquisition namespace enforcement (two-path rule, ADR-015)
    def register_acquired(self, acquisition_id: str, content_hashes: list[str],
                          namespace: Literal["train", "eval"]) -> None:
        """Register acquired sample hashes under an explicit namespace.
        Raises ValueError if namespace == "eval" — eval data must enter via BenchmarkUpgrade,
        never via ContentAddressedStore directly. This is the structural enforcement layer."""

    def verify_namespace(self, acquisition_id: str, expected_namespace: Literal["train"]) -> bool:
        """Return True iff ALL content_hashes registered under acquisition_id are in the
        train namespace and none appear in any frozen eval split namespace."""
```

**`harness/evor/scheduler.py` — ResourceScheduler:**
```python
class ResourceScheduler:
    def probe_throughput(self, run_id: str, job_spec: dict) -> ResourcePlan:
        """Run job_spec for 10 steps; measure samples/sec + GPU util via pynvml or
        'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader' subprocess.
        Start at concurrency=1; return ResourcePlan."""
        
    def next_concurrency(self, plan: ResourcePlan, new_util: float, new_throughput: float) -> int:
        """If util < 0.90 and throughput rising: concurrency += 1.
        If util >= 0.90 or throughput degraded >5%: concurrency -= 1 (min 1)."""
        
    def submit(self, node_id: str, job_spec: dict, run_id: str) -> asyncio.Future:
        """Add to subprocess pool; return Future resolved on job completion."""
```

**Preflight contract** (spec R3, spec §evor-setup): `python -m evor.preflight --run-id <id>` runs a 5-step micro-train (10 random samples, 2-layer MLP) and verifies: (1) loss at step 5 < loss at step 1; (2) GPU util > 0% if GPU detected; (3) no OOM or import errors. On failure, prints environment discovery report and prompts user to confirm/override.

**Addendum v2 Pillar 2 — `harness/evor/freeze.py` (new in M4):**
```python
class FrozenSplitManager:
    def freeze_splits(self, dataset_path: Path, split_config: dict,
                      eval_version: str, run_dir: Path) -> tuple[FrozenSplit, FrozenSplit]:
        """Create FrozenSplit records for test and val splits.
        1. Compute per_sample_hashes: {str(i): sha256(sample_bytes) for i in indices}
        2. Compute split_hash = sha256(sorted_indices_bytes + sorted_hashes_bytes)
        3. Copy files to frozen-splits/<eval_version>-{test,val}/ under run_dir
        4. chmod 444 on all files in frozen-splits/ (read-only enforcement, Pillar 2 layer 1)
        5. Write FrozenSplit JSON to frozen-splits/<eval_version>-{test,val}.json
        Returns (test_split, val_split); locked_split_hash = test_split.split_hash."""

    def verify_frozen_split(self, split: FrozenSplit, run_dir: Path) -> bool:
        """Recompute split_hash + per_sample_hashes and compare; return False on any mismatch.
        Called by IntegrityGate on every evaluation (Pillar 2 layer 2 invariant re-assertion)."""

    def check_read_only(self, split: FrozenSplit, run_dir: Path) -> bool:
        """Verify chmod 444 is still intact on all frozen-split files; return False if any file is writable."""

class DataProvenanceTracker:
    def record(self, sample_id: str, source_sample_id: str,
               transforms: list[str], is_synthetic: bool,
               frozen_test: FrozenSplit, frozen_val: FrozenSplit) -> DataProvenance:
        """Compute sha256(augmented_sample); confirm not in test or val per_sample_hashes.
        Write DataProvenance record to nodes/<node_id>/data-provenance.jsonl."""

    def check_near_dup(self, aug_samples: list[bytes], frozen_test: FrozenSplit,
                       similarity_threshold: float = 0.95) -> list[str]:
        """Near-duplicate check (Pillar 2 layer 3): compute perceptual/cosine similarity
        between augmented samples and frozen test samples; return sample_ids where
        similarity > threshold. Exact method is modality-dependent:
        image → dhash; text → shingle Jaccard; tabular → column-wise match fraction."""
```

**Tests:** `harness/tests/test_store.py` — put/get/gc/delta roundtrip; hardlink dedup (two identical files → same hash, one blob); GC removes unreferenced; `test_refcount_crash_safety`: simulate process kill between .tmp write and os.replace() (leave orphaned .refcounts.json.tmp on disk) → next put() cleans up .tmp and refcount file stays consistent; `test_symlink_refcount`: when hardlink fails and symlink fallback is used, blob refcount is incremented identically to hardlink path. `harness/tests/test_scheduler.py` — mock subprocess; throughput probe returns ResourcePlan; concurrency backs off at 90% util. **Addendum v2:** `harness/tests/test_freeze.py` — freeze_splits creates FrozenSplit with correct split_hash; chmod 444 verified; verify_frozen_split detects tampered sample; check_read_only fails when a file is chmod 644; DataProvenanceTracker.record rejects sample whose sha256 matches a frozen-test sample; check_near_dup catches near-identical aug-of-test image (seeded dhash collision).

**`harness/evor/genome.py` — GenomeConfig loader + validator (R-5 additions):**
```python
# genome-schema-registry.json (co-located in harness/evor/):
# { "schema_extensions": { "<name>": { "type": "<dtype>", "valid_range": [...], "introduced_by_node_id": "<id>" } } }
# Updated atomically on every structural mutation (rename-swap pattern).

def validate_schema_extensions(genome: GenomeConfig, registry_path: Path) -> list[str]:
    """Called on every structural-mutation path (mutation_tier='structural').
    Load genome-schema-registry.json; for each name in genome.schema_extensions[]:
      - verify name present in registry
      - verify genome.extra[name] value within valid_range if specified
    Returns list of validation errors (empty = valid)."""

def merge_genomes(a: GenomeConfig, b: GenomeConfig, loci: list[str]) -> GenomeConfig:
    """Combine genes across loci. For structural extensions: include only if both parents'
    schema_extensions[] agree (or one is a superset of the other). Calls validate_schema_extensions()
    on result before returning."""
```

**`harness/evor/benchmark.py` — EvalSuite/BenchmarkUpgrade governance (R-13, minor fix):**
```python
class BenchmarkManager:
    def apply_upgrade(self, upgrade: BenchmarkUpgrade, run_dir: Path,
                      seed_checkpoint_hash: str | None,
                      strategy_state: StrategyState) -> EvalSuite:
        """Create new EvalSuite version (strict superset of from_eval_version).
        ASSERTION: upgrade.domains_removed MUST be empty — raise IntegrityError if not (minor fix).
        CREATION GUARD (Q4): only this method creates BenchmarkUpgrade records; validate that
          the input upgrade was produced by apply_upgrade() itself (not hand-authored externally).
        RE-SCORE MODE (Q1): read strategy_state.rescore_mode — the SINGLE source of truth.
          "sync": block new ticks until all frontier nodes are re-scored before returning.
          "async": mark frontier nodes as stale (rescore_status="pending") and return immediately;
          ticks may continue with stale nodes flagged; staleness enforced in best_frontier() and
          propose_crossover(). Do NOT add a separate rescore_synchronous parameter here.
        For each new domain with contamination_risk != 'low' (R-13):
          Evaluate SEED/FOUNDATION MODEL checkpoint (seed_checkpoint_hash) on the new angle's
          held-out split → store result as AngleRegistry.angles[angle_id].baseline_model_score_before_finetune.
          From-scratch mode (seed_checkpoint_hash is None): use random-init model performance.
        Freeze fresh held-out split for each new domain via FrozenSplitManager.freeze_splits().
        Bump eval_version; write new EvalSuite snapshot to eval-suites/<to_eval_version>.json."""

    def get_eval_suite(self, eval_version: str, run_dir: Path) -> EvalSuite: ...

    def list_versions(self, run_dir: Path) -> list[str]: ...
```

**`harness/evor/angle_registry.py` — AngleRegistry CRUD + SOTA trust model (R-8, R-9, R-11):**
```python
class AngleRegistry:
    def add_angle(self, angle_id: str, sota_bar: number, sota_sources: list[SotaSource],
                  baseline_score: float | None, run_dir: Path) -> None:
        """Add new angle. Compute sota_quorum_met = (len(distinct sources) >= 2 AND divergence <= 5%).
        trust_level = 'authoritative' if quorum_met OR retrieval_method='human_provided', else 'indicative'.
        Store baseline_model_score_before_finetune. Monotonic SOTA bar invariant: cannot decrease.
        Tick-1 warning: if mission_type='open_ended' and 0 angles registered after tick 1,
        emit [EVOR WARNING: open_ended mission has 0 angles registered — coverage target unreachable] (minor fix)."""

    def update_angle(self, angle_id: str, new_sota_bar: float, new_sources: list[str],
                     run_dir: Path) -> None:
        """Monotonic write-lock (R-8): assert new_sota_bar >= existing sota_bar;
        raise ValueError if new bar would lower the existing bar.
        Recompute sota_quorum_met with updated sources."""

    def score_angles(self, result: EvaluationResult, eval_version: str,
                     run_dir: Path) -> tuple[dict[str, AngleVsSOTA], float]:
        """R-11: score_angles(result, registry, eval_version) → (per_angle_vs_sota, worst_angle_coverage).
        For each angle in registry.angles:
          effective_bar = max(sota_bar, baseline_model_score_before_finetune or 0.0) (R-9)
          If angle_id absent from result.per_domain → unscored (NOT failing); excluded from coverage denominator.
          above_sota = (value >= effective_bar) AND trust_level='authoritative'
        worst_angle_coverage = count(above_sota) / count(scored_angles)."""

    def get_coverage(self, result: EvaluationResult, run_dir: Path) -> float:
        """Convenience wrapper → worst_angle_coverage scalar."""

    def flag_sota_regression(self, angle_id: str, new_fetched_bar: float,
                              source: str, citation: str, run_dir: Path) -> None:
        """Called during living-loop SotaSource re-fetch when newly fetched bar is LOWER
        than the committed bar. NEVER lowers the committed bar — monotonic write-lock from
        R-8 forbids this. Instead surfaces a human-review milestone-ping containing:
          - old committed bar (existing sota_bar)
          - new fetched value (new_fetched_bar, which is lower)
          - source name + citation
          - timestamp
        Emits: [EVOR SOTA-REGRESSION ALERT: angle {angle_id} | committed={old} | fetched={new} |
                source={source} | citation={citation} | {timestamp}]
        to stdout and appends to decision-log.md. User decides if it is a legitimate
        leaderboard correction; system never auto-lowers (Q3)."""
```

**Tests additions:**
- `harness/tests/test_benchmark.py` — `apply_upgrade()` asserts domains_removed empty; baseline_model_score populated for contamination risk != low; superset invariant enforced.
- `harness/tests/test_angle_registry.py` — `update_angle()` monotonic write-lock rejects lower bar; `score_angles()` marks absent angles as unscored (not failing); `sota_quorum_met` computed correctly; tick-1 warning fires for open_ended with 0 angles.

**Dependencies:** M1.
**Gate layers:** L2 (test_store.py, test_scheduler.py, test_freeze.py, test_benchmark.py, test_angle_registry.py all green).

---

### M5 — Tree Engine: UCB1 + Crossover + Meta-Evolution (L2)
**Goal:** TreeEngine fully tested. UCB1 selection, branch-from-any-node, crossover, strategy.json meta-evolution all pass unit tests.

**`harness/evor/tree.py` — TreeEngine:**
```python
class TreeEngine:
    def select(self, count: int = 1) -> list[TreeNode]:
        """UCB1: score_i = normalized_i + C * sqrt(ln(N) / n_i)
        where N = total visits, n_i = node.visit_count, C = strategy.ucb1_c (default 1.41).

        CORRECTNESS CONTRACT (harness/evor/tree.py):
        Metric MUST be normalized to [0,1] before applying UCB1:
          If target_value present in GoalContract:
            normalized_i = clamp((metric_i - baseline) / (target - baseline + 1e-6), 0, 1)
          If target_value absent: normalize over observed min/max in current tree:
            normalized_i = clamp((metric_i - min_m) / (max_m - min_m + 1e-6), 0, 1)
        C=1.41 is valid on normalized [0,1] inputs (matches standard UCB1 analysis).

        Unvisited nodes: if node.visit_count == 0, UCB1 score = +inf (math.inf);
        unvisited nodes always rank first. Apply the formula only when n_i > 0.

        All non-pruned nodes eligible (backtrack enabled — any depth, not just leaves).
        Crossover trigger: if top-2 UCB1 nodes are from distinct lineages (no common ancestor),
        emit crossover proposal with parent_ids = [node_a.id, node_b.id]."""
        
    def propose_crossover(self, node_a: TreeNode, node_b: TreeNode) -> MutationProposal:
        """Addendum v2 Pillar 1 — genome-aware crossover:
        Load GenomeConfig from node_a.genome_ref and node_b.genome_ref.
        Call genome.py::merge_genomes(a.genome, b.genome, loci=[backbone_locus, head_locus, ...])
        to combine genes across modular seam boundaries. Only parametric genes can be cleanly
        merged; structural extensions from one parent are included only if the other parent's
        schema_extensions[] is a superset (else flag as structural-crossover, lower confidence).
        Set is_crossover=True; parent_ids=[a.id, b.id]; mutation_tier="parametric" for
        config-only merges; "structural" if schema_extensions diverge.
        IMPORTANT: crossover is only valid when both nodes share the same eval_version
        (refuse cross-version crossover; log refusal to decision-log.md)."""
        
    def prune(self, winner_id: str, losers: list[str], store: ContentAddressedStore) -> None:
        """Mark losers status=pruned; collect their artifact hashes; call store.gc()."""
        
    def meta_evolve(self, decision_log: list[DecisionLogEntry]) -> StrategyState:
        """Analyze last N ticks (strategy.meta_loop_interval):
        - If one family wins ≥ 3/N ticks: reduce its weight in family_mix by 0.3 (H002 extension)
        - If circuit_breaker_count rising: increase wildness by 0.1 (up to 1.0)
        - If throughput degrading: reduce concurrency_target in ResourcePlan
        - Tune ucb1_c: if exploration producing wins, keep C; if exploitation winning, lower C by 0.1
        - Post-BenchmarkUpgrade boost (R-4): if BenchmarkUpgrade was applied since last meta_evolve,
          set post_upgrade_exploration_boost = min(1.0, current_wildness + 0.3) and
          post_upgrade_exploration_ticks = min(15, max(5, len(frontier_ids) * 2)).
          Decrement post_upgrade_exploration_ticks each tick; when it reaches 0, clear boost.
          NOTE: visit counts (n_i) become stale after BenchmarkUpgrade because nodes scored under
          v_old have inflated visit counts relative to the new angle space. This is a known v1
          approximation; see ADR-004 follow-ups for v2 versioned-visit-count remedy.
        Persist to strategy.json via evor_state_write."""
        
    def compute_fitness(self, result: EvaluationResult, goal: GoalContract) -> float:
        """Addendum v2 Pillar 3+4 — compute fitness_value per GoalContract.fitness_mode:
        - "aggregate": use result.metrics[primary_metric] (normalized to [0,1])
        - "worst-domain": min(result.per_domain[d][primary_metric] for d in domains)
          — maximizes the worst domain; makes selection robustness-aware
        - "weighted": sum(weight_d * result.per_domain[d][primary_metric])
          — weights from MetricSpec.aggregation_rule per domain
        For open_ended missions (R-8, R-11): fitness_value = worst_angle_coverage as returned by
        AngleRegistry.score_angles(result, registry, eval_version). Only angles with
        trust_level='authoritative' count toward coverage / beat-SOTA stop conditions; indicative
        bars are advisory only and do not affect fitness_value. Effective bar per angle =
        max(sota_bar, baseline_model_score_before_finetune) (R-9). Falls back to aggregate if
        no angles registered yet."""

    def best_frontier(self) -> list[TreeNode]:
        """Pareto frontier over fitness_value (respects GoalContract.fitness_mode);
        also returns worst-angle breakdown for open_ended missions.
        All frontier nodes must share the same eval_version; mixed-version nodes are flagged."""
```

**CLI** (called by TS MCP tools):
```
python -m evor.tree select --run-id <id> [--strategy <json>] [--count N]
python -m evor.tree crossover --run-id <id> --node-a <id> --node-b <id>
python -m evor.tree prune --run-id <id> --winner <id> --losers <id,...>
python -m evor.tree frontier --run-id <id>
python -m evor.tree meta-evolve --run-id <id>
```

**Diversity enforcement** (mirrors `refs/oh-my-claudecode/skills/self-improve/data_contracts.md §critic_review`):
- H001: each `MutationProposal` must contain exactly one falsifiable `Hypothesis`
- H002: if `approach_family` X won the last 3 consecutive ticks, X is deprioritized (family_mix weight *= 0.3) until another family wins
- H003: within a single tick's proposal batch, no two proposals share the same `approach_family`

**`harness/evor/wiki.py` — CompoundingWiki:**
```python
class CompoundingWiki:
    def add(self, entry: LessonEntry, run_dir: Path) -> str:
        """Write wiki/<lesson_id>.md; append to .evor/wiki/index.jsonl (cross-run scope)."""
        
    def query(self, query: str, family: ApproachFamily | None = None,
              confirmed_only: bool = False, limit: int = 10) -> list[LessonEntry]:
        """Keyword scan over .evor/wiki/index.jsonl; filter by family; rank by recency."""
        
    def load_context(self, mission_id: str, limit: int = 5) -> list[LessonEntry]:
        """On mission start: return top-5 lessons matching task keywords; injected into Evor context."""
```

**Tests:** `test_tree.py` — UCB1 scores correct formula on normalized metric; backtrack selects depth-2 node over root when visit-count favors it; crossover `is_crossover=True`, `len(parent_ids)==2`; frontier is Pareto-correct; `meta_evolve` reduces over-winning family weight; `test_select_unvisited`: tree with 3 nodes all `visit_count=0` → `select()` returns one without raising (n_i=0 treated as +∞, no ZeroDivisionError); `test_ucb1_normalization`: with target_value present, normalized score clipped to [0,1] before C*sqrt term applied. **Addendum v2:** `test_genome_crossover`: two nodes with distinct genomes (backbone differs) → merge_genomes produces child genome with node_a.backbone + node_b.head; `mutation_tier="parametric"` when schemas compatible; `test_structural_crossover_flag`: nodes with divergent schema_extensions → crossover flagged as structural, lower confidence; `test_cross_eval_version_crossover_refused`: node_a.eval_version="v1", node_b.eval_version="v2" → crossover raises ValueError and logs refusal; `test_fitness_worst_domain`: fitness_mode="worst-domain", per_domain={"scanned": 0.91, "handwritten": 0.72} → fitness_value=0.72; `test_fitness_open_ended`: worst_angle_coverage=0.6 used as fitness_value when mission_type=open_ended; `test_frontier_mixed_versions`: frontier with v1 and v2 nodes → mixed-version flag set on result. `test_wiki.py` — add + query roundtrip; family filter; cross-run retrieval.

**Dependencies:** M1, M4.
**Gate layers:** L2 (test_tree.py, test_wiki.py green).

---

### M6 — Integrity Gate + EvaluatorAdapter + SelfHealMonitor + TelemetryCallback (L2)
**Goal:** IntegrityGate catches all seeded cheat patterns. EvaluatorAdapter subprocess contract working. Self-heal monitor recovers OOM. TelemetryCallback emits correct schema.

**`harness/evor/integrity.py` — IntegrityGate:**
```python
class IntegrityGate:
    def lock_splits(self, dataset_path: Path, split_config: dict) -> str:
        """sha256(sorted(train_indices) + sorted(val_indices) + sorted(test_indices));
        write to GoalContract.locked_split_hash at mission start."""
        
    def check(self, node: TreeNode, result: EvaluationResult,
              telemetry_path: Path, eval_script_path: Path,
              frozen_test: FrozenSplit, provenance_path: Path | None) -> IntegrityReport:
        """Run all 10 checks (6 base + 4 Addendum v2):
        ALIAS RESOLUTION (R-7b): at the top of check(), resolve mutation_locus.family through
        _canonicalize_family(family: str) -> str helper: maps "augmentation" → "data-augmentation";
        "data_augmentation" → "data-augmentation"; etc. All downstream conditionals use the
        canonicalized name. This helper is defined at module scope in integrity.py.

        BASE CHECKS:
        1. split_hash_match: recompute hash, compare to GoalContract.locked_split_hash
           SHORT-CIRCUIT (R-7a): if check-1 FAILS, checks 2 and 3 are SKIPPED (they depend on
           a valid split; running them on a corrupted split produces meaningless results). Return
           a partial IntegrityReport with split_hash_match=False, no_test_leakage=None,
           no_label_contamination=None. Checks 4–10 still run.
        2. no_test_leakage: sample 200 test indices; verify none appear in training data files
           (index-level + sha256(sample) content-hash check; detects copied samples regardless of label)
           [SKIPPED if check-1 failed — see short-circuit above]
        3. no_label_contamination: sha256(test_sample_i) ∉ {sha256(train_sample_j)} over 100 sampled pairs (R5)
           [SKIPPED if check-1 failed — see short-circuit above]
        4. no_eval_shift: sha256(eval_script) == GoalContract.eval_script_hash
        5. telemetry_sane: parse telemetry.jsonl; loss[0] != loss[-1]; no NaN/Inf;
           grad_norm > 0 ONLY if field present (R6 — skip for tabular/XGBoost)
        6. reward_hacking_probe: val_metric improved > 30% of baseline in single step → flag
        ADDENDUM v2 CHECKS:
        7. frozen_split_read_only (Pillar 2 layer 1): FrozenSplitManager.check_read_only() —
           confirm chmod 444 still intact on all frozen-split files
        8. near_dup_leakage (Pillar 2 layer 3): if provenance_path present, call
           DataProvenanceTracker.check_near_dup() on augmented train samples vs frozen test;
           skip if no augmentation in this node (canonicalized mutation_locus.family not in
           ("data-augmentation", "augmentation") — evaluated AFTER alias resolution; R-7b)
        9. data_provenance_valid (Pillar 2 layer 4): if provenance_path present, verify all
           DataProvenance.source_sample_id values trace to train split only
        10. eval_version_consistent (Pillar 3): node.eval_version == GoalContract.eval_version;
            if mismatch, reject — node must be re-scored under current eval_version before
            being eligible for frontier comparison
        INGESTION CONTAMINATION GATE (checks 11–13; active only when mutation_locus.family == "data-acquisition"):
        11. acquisition_contamination_clear: for every acquired/synthetic sample, verify:
            - index ∉ ANY frozen eval split (all eval_versions, not just current) — catches
              "I'll just add this benchmark as training data" attack
            - sha256(sample) ∉ per_sample_hashes across ALL FrozenSplit records
            - near-dup similarity < threshold vs ALL eval split samples (reuse
              DataProvenanceTracker.check_near_dup() from freeze.py)
            Overlapping samples → quarantine (remove from acquired set); if quarantine fraction
            exceeds 5% of acquired batch, reject the entire acquisition mutation (verdict=failed)
        12. acquired_data_provenance_valid: AcquisitionProvenance record present;
            for external: license_identifier != "" AND license_in_allowlist == True AND citation != "" (R-3);
            license_in_allowlist is True iff license_identifier ∈ GoalContract.allowed_licenses;
            for synthetic: generator_config != {} AND citation != "";
            license_identifier not in GoalContract.allowed_licenses → reject unless GoalContract has explicit license_override
        13. acquisition_namespace_enforced: call DataStore.verify_namespace(acquisition_id, "train")
            → True only if ALL acquired samples are registered under the train namespace;
            any sample registered under an eval namespace → reject entire acquisition"""
        
    def verification_rerun(self, node: TreeNode, goal: GoalContract,
                           evaluator: EvaluatorAdapter) -> EvaluationResult:
        """Re-evaluate tournament winner on locked splits; confirm no regression vs stored result."""
```

**`harness/evor/evaluator.py` — EvaluatorAdapter:**
Subprocess contract mirrors refs/sia evaluate.py pattern:
```python
class EvaluatorAdapter:
    def run(self, eval_script: Path, worktree: Path,
            goal: GoalContract, node: TreeNode, env: dict,
            rescore_context: BenchmarkRescore | None = None) -> EvaluationResult:
        """SUBPROCESS ISOLATION CONTRACT (mirrors refs/sia/evaluate.py output-to-stdout):
        - EvaluatorAdapter runs the evaluator in a subprocess; reads result from STDOUT only.
        - The eval script MUST NOT write to the artifact store or tree.json during evaluation;
          all artifact/tree writes are mediated through EvaluatorAdapter after result is parsed.
          This closes the 'Forge writes false results directly' integrity gap that hash-checks
          alone cannot detect.
        - On Linux: optional hardening via `unshare --mount` + read-only bind-mount of the
          worktree root (prevents fabricated writes by a compromised eval script; note this
          still allows writes to /tmp and the subprocess's own working directory).
        - Timeout from GoalContract.budget. Parse stdout JSON → EvaluationResult;
          stderr → benchmark_raw. Status: success/regression/error/timeout/oom.

        ADDENDUM v2 PILLAR 3 — Per-domain emission contract:
        - eval_script MUST emit EvaluationResult JSON to stdout including per_domain field.
          The per_domain key structure must match EvalSuite.domains[].domain_id.
          Eval scripts that predate this contract (base spec) emit only aggregate metrics;
          EvaluatorAdapter wraps them: per_domain = {"default": aggregate_metrics}.
        - eval_version is injected into the subprocess env as EVOR_EVAL_VERSION and MUST
          appear in the emitted EvaluationResult; mismatch between env value and emitted
          value → status=error (eval script cannot self-select its eval_version).
        - fitness_value is computed by EvaluatorAdapter post-parse via TreeEngine.compute_fitness()
          (not by the eval script); prevents eval script from gaming the fitness function.

        BENCHMARKRESCORE MERGE PROTOCOL (R-6): when rescore_context is not None (incremental
        BenchmarkUpgrade re-score path):
        - Run eval_script with --eval-domains {rescore_context.new_domains} only (partial run).
        - Parse partial stdout → partial EvaluationResult containing only new_domains in per_domain.
        - Merge: complete_per_domain = rescore_context.cached_per_domain | partial.per_domain
          (new_domains override cached entries if overlapping; union otherwise).
        - Build complete EvaluationResult with merged per_domain and eval_version = merged_eval_version.
        - Recompute fitness_value via TreeEngine.compute_fitness() on the merged result (NOT the
          eval script output and NOT the partial result — always the merged complete result).

        ADDENDUM v2 PILLAR 4 — Open-ended / angle scoring (R-11):
        - Only if goal.mission_type == "open_ended": after parsing per_domain, call
          AngleRegistry.score_angles(result, registry, eval_version) to compute
          per_angle_vs_sota and worst_angle_coverage. AngleRegistry loaded from
          run_dir/angle-registry.json at eval time.
        - For fixed missions: per_angle_vs_sota and worst_angle_coverage remain null."""
```

**`harness/evor/monitor.py` — SelfHealMonitor:**
```python
class SelfHealMonitor:
    """Wraps subprocess.Popen; tails stdout/stderr via asyncio.
    Playbook (applied in order, max 3 retries per node):
      CUDA OOM      → halve batch_size, double gradient_accumulation_steps, retry
      NaN loss      → restore last checkpoint; reduce lr by 0.5; retry
      ModuleNotFound → pip install <pkg> in worktree venv; retry once
      Missing ckpt  → restart from epoch 0
      ≥3 failures   → mark status=error; log to decision-log.md; do NOT retry
    Emits Monitor events on each recovery action (Evor wakes and logs)."""
```
Self-heal playbook from spec §Acceptance Criteria "Self-healing" and spec R19.

**`harness/evor/telemetry.py` — TelemetryCallback SDK:**
```python
class TelemetryCallback:
    """PyTorch Lightning / Keras / plain-loop compatible callback.
    Forge (evor-forge) injects this into every training run.
    Schema: exactly TelemetryRecord from contracts.py.
    Usage: cb = TelemetryCallback(node_id, run_id, run_dir)
    PyTorch Lightning: trainer.callbacks.append(cb)
    Plain loop:        cb.log(step=N, train_loss=L, lr=LR, grad_norm=GN, throughput=T)"""
    
    def on_train_batch_end(self, trainer, pl_module, outputs, batch, batch_idx): ...
    def on_validation_epoch_end(self, trainer, pl_module): ...
    def log(self, **kwargs) -> None:
        """Write TelemetryRecord to nodes/<node_id>/telemetry.jsonl (JSONL append).
        Required: step, node_id, run_id, timestamp. All metric fields optional but at least one required."""
```

**Probe Self-Authored EDA Contract (`harness/evor/eda/`):**

EDA cannot be hardcoded — the relevant analyses are modality- and task-specific:
- Image tasks: brightness/contrast/color-histogram distribution, per-class exemplars, class imbalance
- Text tasks: length distribution, vocabulary coverage, token-distribution shifts, OOV rates
- Tabular tasks: feature correlations, missingness patterns, leakage risk indicators
- Audio tasks: spectrograms, duration distribution, SNR estimates
- All modalities: output/error clustering (group misclassified/high-loss samples by pattern), telemetry curve pathology (loss spikes, LR sensitivity, gradient explosion/vanishing), and analysis tailored to the node's registered hypothesis and documented weak spots

Therefore Probe (EDA/Analyst, evor-probe.md) WRITES AND RUNS its own Python analysis code per iteration — exactly as Forge writes training code. Probe is a code-generating agent, not a fixed-analysis pipeline.

**`harness/evor/eda/` — Thin SDK primitives only (no fixed analyses):**
```python
# harness/evor/eda/__init__.py  — thin SDK; Probe generates analysis scripts on top of these

def load_artifact(content_hash: str, run_dir: Path) -> Path:
    """Resolve content-hash to blob path via ContentAddressedStore."""

def load_telemetry(node_id: str, run_dir: Path) -> list[dict]:
    """Read nodes/<node_id>/telemetry.jsonl; return parsed records."""

def save_finding(node_id: str, run_dir: Path, name: str,
                 data: dict | str | bytes, suffix: str = ".json") -> Path:
    """Write finding to nodes/<node_id>/eda/<name><suffix>; return path."""

def safe_plot(fig, node_id: str, run_dir: Path, name: str) -> Path:
    """Save matplotlib/plotly figure to nodes/<node_id>/eda/<name>.png; return path.
    Non-blocking: catches all rendering errors; falls back to saving data table."""

def safe_exec(script_path: Path, timeout_sec: int = 300,
              mem_limit_mb: int = 2048) -> tuple[str, str]:
    """Execute generated analysis script in subprocess under resource limits;
    return (stdout, stderr). Raises TimeoutError on timeout."""
```

**ProbeEDAContract — Probe agent flow per iteration:**
1. Classify data modality from GoalContract (image/text/tabular/audio/other)
2. Read the node's registered Hypothesis + weak spots from EvaluationResult
3. Generate bespoke analysis scripts targeting three layers:
   - data-EDA: dataset statistics and quality checks for the modality
   - output/error-analysis: cluster wrong predictions / high-loss samples by pattern
   - telemetry-EDA: curve shape diagnosis + gradient pathology tailored to the failure mode
4. Execute each script via `safe_exec()` under resource+timeout limits
5. Call `save_finding()` and `safe_plot()` to capture figures/tables/stats
6. Distill findings into `LessonEntry`; persist to CompoundingWiki via `evor_wiki_add`
7. Save generated scripts + outputs at `nodes/<node_id>/eda/analysis_<i>.py` + outputs
   (mirrors refs/sia saving improvement.md/feedback_prompt.md for reproducibility)

**New schema entity — `ProbeEDAContract`:**
```typescript
interface ProbeEDAContract {
  node_id: string;
  modality: "image" | "text" | "tabular" | "audio" | "other";
  scripts_generated: string[];   // relative paths: nodes/<id>/eda/analysis_*.py
  findings_paths: string[];      // relative paths: nodes/<id>/eda/*.json | *.png
  hypothesis_citations: string[];// which findings support/refute the registered Hypothesis
  lesson_id?: string;            // wiki entry ID after distillation
  completed_at: string;
}
```

**New store path:** `nodes/<node_id>/eda/` — analysis scripts + output artifacts.

**Acceptance criterion (L3):** Probe produces a modality-appropriate, reproducible EDA artifact (code + outputs) for at least one node in the L3 run, and at least one finding from that EDA is explicitly cited in a subsequent MutationProposal (verifiable via `proposal.citations[]`).

**`harness/evor/__main__.py` — `run` subcommand (Forge's primary invocation):**

This is the single entry point Forge (evor-forge) calls after materializing code in the worktree. Without this CLI, Forge's `python -m evor.harness run` call (spec'd in `agents/evor-forge.md`) has no implementation target.

```
python -m evor.harness run --node-id <id> --run-id <id> --worktree <path>
```

Responsibilities:
1. Load GoalContract + StrategyState from run-state.json
2. Inject TelemetryCallback into the training script entry point
3. Submit job to ResourceScheduler (returns Future)
4. Supervise execution via SelfHealMonitor (OOM/NaN/dep/checkpoint recovery)
5. On job completion: invoke EvaluatorAdapter → write EvaluationResult
6. Exit 0 on success; non-zero on error/timeout/oom (exit code maps to EvaluationResult.status)

Subcommand registry also supports `python -m evor.harness preflight --run-id <id>` (spec §evor-setup) for environment discovery + 5-step smoke-train.

**Tests:**
- `test_integrity.py` — seeded leakage → `no_test_leakage=False`; seeded NaN telemetry → `telemetry_sane=False`; eval script modified → `no_eval_shift=False`; clean node → all checks True; `verdict="passed"`. **Addendum v2:** `test_frozen_split_read_only_check`: frozen-split file chmod'd to 644 → `frozen_split_read_only=False`; `test_near_dup_leakage`: augmented image whose dhash collides with a test image → `near_dup_leakage=False`; FIXTURE MUST set `mutation_locus.family = "data-augmentation"` (canonical name, not legacy `"augmentation"`) to guard alias-resolution helper correctness (R-10 / guards C-1); `test_provenance_traces_to_test`: DataProvenance.source_sample_id references a test-split index → `data_provenance_valid=False`; `test_eval_version_mismatch`: node.eval_version="v1" but GoalContract.eval_version="v2" → `eval_version_consistent=False`, `verdict="failed"`. **Data-acquisition (ingestion gate):** `test_ingestion_contamination`: acquired batch containing 3 samples whose sha256 matches frozen eval split samples → those samples quarantined, `acquisition_contamination_clear=False`, `verdict="failed"`; `test_acquired_data_provenance`: acquisition with empty citation → `acquired_data_provenance_valid=False`; synthetic acquisition with missing generator_config → `acquired_data_provenance_valid=False`; valid external acquisition with license + citation → `acquired_data_provenance_valid=True`; `test_acquisition_namespace_enforcement`: DataStore.verify_namespace() called with "eval" namespace → returns False, `acquisition_namespace_enforced=False`, `verdict="failed"`; non-acquisition node → all three acquisition checks are `null` (skipped); `test_acquisition_cross_version_contamination_scan`: acquired sample matches a frozen eval split from an OLD eval_version (not the current one) → still caught (scan covers ALL eval_versions, not just current).
- `test_monitor.py` — inject `CUDA out of memory` in stderr → batch_size halved, retry; inject NaN loss in telemetry → lr halved; inject `ModuleNotFoundError` → pip install called; 3+ failures → status=error
- `test_telemetry.py` — `TelemetryCallback.log()` writes JSONL; required fields present; roundtrip parse matches input
- `test_evaluator.py` — mock subprocess returns valid JSON → EvaluationResult parsed; timeout → status=timeout. **Addendum v2:** `test_per_domain_emission`: mock eval script returns per_domain dict → EvaluatorAdapter maps domain_ids to EvalSuite domains; `test_eval_version_env_injection`: EVOR_EVAL_VERSION in subprocess env matches GoalContract.eval_version; `test_fitness_computed_post_parse`: fitness_value not taken from stdout, computed by TreeEngine.compute_fitness() post-parse; `test_angle_scoring`: open_ended mission → score_angles() produces per_angle_vs_sota + worst_angle_coverage.

**Dependencies:** M1, M4, M5.
**Gate layers:** L2 (test_integrity.py, test_freeze.py, test_monitor.py, test_telemetry.py, test_evaluator.py).

---

### M7 — MCP Tools Full Implementation + Hook Enforcement (L2)
**Goal:** All 12 MCP tools fully functional. PostToolUse hook auto-captures evals+telemetry. Stop hook blocks when tree DB not updated.

**`mcp/src/tools/record.ts` (full implementation):**
- `evor_record_node`: validate TreeNode against Zod schema; call `tree-store.writeTree()` atomic rename-swap; append `DecisionLogEntry` to `decision-log.md`
- `evor_record_eval`: write `nodes/<id>/results.json`; if IntegrityReport absent at `evaluations/<node-id>.json`, auto-invoke `evor_integrity_check` (which writes to `evaluations/<node-id>.json`)

**`mcp/src/tools/tree.ts` (full implementation):**
- `evor_tree_read`: read tree.json; filter by `subtree_root` (DFS from that node) and `depth`; return array
- `evor_select`: exec Python subprocess `python -m evor.tree select ...`; parse JSON result; handle subprocess timeout (5s default)

**`mcp/src/tools/schedule.ts`:** delegate to `python -m evor.scheduler submit`; return job_id

**`mcp/src/tools/wiki.ts`:** delegate add/query to `python -m evor.wiki add/query`

**`mcp/src/tools/state.ts`:** read/write `.evor/runs/<mission>/<run-id>/run-state.json` (JSON merge-patch for write)

**`mcp/src/tools/integrity.ts`:** exec `python -m evor.integrity check ...`; parse stdout JSON → IntegrityReport

**`mcp/src/tools/telemetry.ts`:** append `TelemetryRecord[]` to `nodes/<id>/telemetry.jsonl` (JSONL append, one line per record)

**`hooks/post-tool-use.mjs` (full implementation):**
```javascript
// Triggers on every tool call during active run (EVOR_ACTIVE_RUN_ID set)
// 1. If tool_name == "evor_record_eval": verify nodes/<id>/results.json written (mtime check);
//    if not → inject system-reminder warning
// 2. PRIMARY TELEMETRY PATH: TelemetryCallback writes directly to nodes/<id>/telemetry.jsonl
//    during training (file write, not stdout). Forge calls evor_telemetry_ingest explicitly
//    after training completes. The hook does NOT scan stdout for TelemetryRecord JSON lines —
//    that was dead code (TelemetryCallback never writes to stdout).
//    Hook validation: if tool_name == "evor_record_eval", verify nodes/<id>/telemetry.jsonl
//    exists and has > 0 bytes; if missing or empty → inject system-reminder warning.
//    Re-ingestion from stdout is NOT performed.
// 3. If tool_name == "evor_record_node": verify tree.json mtime changed; if not → warning
```

**`hooks/stop.mjs` (full implementation — continuation guard):**
```javascript
// On Stop event when EVOR_ACTIVE_RUN_ID is set:
// 1. Read run-state.json: check pending_node_ids[] field
// 2. If pending_node_ids.length > 0:
//    Output system-reminder: "[EVOR CONTINUATION GUARD] Tick N started but tree DB not updated.
//    Call evor_record_node for nodes: <ids>. Do not finish until tree is updated."
//    Exit with code 2 (blocks completion)
// Mirrors refs/ml-intern/agent/core/agent_loop.py:_no_tool_incomplete_plan_prompt() pattern
```

**`hooks/session-start.mjs` (full implementation):**
```javascript
// 1. Check .evor/active-run.json exists
// 2. If exists: set EVOR_ACTIVE_RUN_ID, EVOR_MISSION_ID, EVOR_RUN_DIR in output env
// 3. Load wiki context: python -m evor.wiki context --mission-id <id> --limit 5
// 4. Inject wiki lessons as system-reminder for Evor context priming
```

**MCP tests** (`mcp/tests/`):
- `record.test.ts` — write node; read back matches input; atomic: simulate crash between tmp and rename → no corruption
- `tree.test.ts` — `evor_tree_read` with subtree_root filters correctly; `evor_select` parses subprocess JSON
- `integrity.test.ts` — mocked Python subprocess returns IntegrityReport; schema validated
- `telemetry.test.ts` — append 100 records; read back 100 JSONL lines; schema validates all
- `hooks.test.ts` — simulate Stop with `pending_node_ids: ["n1"]` → exit code 2; with empty → exit 0; PostToolUse after `evor_record_eval` with telemetry.jsonl present → no warning; telemetry.jsonl missing → warning injected (stdout-scan path NOT tested; it is removed per R11)

**Dependencies:** M2, M4, M5, M6.
**Gate layers:** L2 (vitest mcp/tests/ all green).

---

### M8 — Evor Orchestration Skill (Full Tick Loop + Meta-Loop) (L2→L3)
**Goal:** `skills/evor/SKILL.md` production-complete with full 9-step tick loop, meta-evolution, all coordination patterns, doom-loop detection, and stop conditions.

**`skills/evor/SKILL.md` — complete specification:**

**Doom-loop detection** (mirrors `refs/ml-intern/agent/core/agent_loop.py` `_detect_repeated_malformed` + `_NO_TOOL_INCOMPLETE_PLAN_RETRY_LIMIT`):
> If 3 consecutive ticks all produce: (a) ALL proposals rejected by Critic, OR (b) no tool calls from any agent, OR (c) same proposal_id repeated twice → trigger `[DOOM-LOOP DETECTED]`: force wildness=0.9 override for next tick; log to decision-log.md.

**Full 9-step tick loop:**

```
### Step 1 — Select
Call evor_select(run_id, strategy=strategy_state, count=resource_plan.concurrency)
→ parent_node_ids[] (1 for mutation, 2 for crossover)
Update pending_node_ids in run-state.json via evor_state_write

### Step 2 — Ideate (bidirectional Dreamer↔Researcher, spec R17)
Spawn Mutagen (evor-mutagen) with: parent_node context, wildness from strategy.json,
  last 10 wiki lessons (evor_wiki_query), approach_family weights from strategy.json
Mutagen emits: raw_ideas[] + investigation_queries[] for Sage
Spawn Sage (evor-sage) with: investigation_queries from Mutagen + "find newest SOTA"
Sage returns: CitationBackedFinding[]
Mutagen synthesizes: N MutationProposal[] (N = resource_plan.concurrency)

Step 2.5 — Hypothesis Registration
For each proposal: register Hypothesis (statement, prediction)
Call evor_record_node(run_id, node{status:"pending", hypothesis_id, ...}) for each

### Step 3 — Critique (pre-execution gate)
Spawn Selector (evor-selector) with: proposals, strategy.json (family history), H002/H003 rules
Critic checks all 6 gates per proposal; outputs approved[] and rejected[]
If ALL rejected: append to decision-log.md; circuit_breaker_count++; goto Step 9

### Step 4 — Implement + Run
For each approved proposal (parallel via CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1;
if env var unavailable, fall back to sequential execution, concurrency=1):
  git worktree add .evor/worktrees/<node_id> -b evor/<node_id> [from parent worktree]
  Spawn Forge (evor-forge) with: proposal, worktree path, instrumentation requirement
  # Addendum v2 Pillar 1 — Genome materialization (Forge mandate, see M3):
  Forge materializes modular seam structure (genome.yaml + data/ + model/ + train/ + locked evaluate.py)
    For parametric mutations: update genome.yaml gene(s); call genome.py::validate_genome()
    For structural mutations: write new module code + extend GenomeConfig.extra + schema_extensions[]
    For crossover: call genome.py::merge_genomes(parent_a_genome, parent_b_genome, loci)
    Store mutation as parent.patch (git format-patch vs parent) + genome.yaml snapshot
    genome_ref = ContentAddressedStore.put(genome.yaml) → content-hash stored on TreeNode
  Forge instruments TelemetryCallback into train/trainer.py (non-negotiable)
  # Addendum v2 Pillar 2 — Data mutation guard:
  If proposal.approach_family == "data-augmentation" or "data-curation":
    Call DataProvenanceTracker.record() for each modified/augmented sample
    Provenance written to nodes/<node_id>/data-provenance.jsonl
    DataProvenanceTracker confirms: source_sample_id ∈ train split only
  If proposal.approach_family == "data-acquisition" (TWO-PATH RULE, ADR-015):
    Forge materializes acquired/synthetic data in data/acquisition/ seam
    Forge must populate AcquisitionProvenance (source, license, citation, generator_config)
    Forge calls ContentAddressedStore.register_acquired(acquisition_id, hashes, namespace="train")
      → store raises ValueError if anything attempts namespace="eval" (structural enforcement)
    BEFORE training: IntegrityGate runs Ingestion Contamination Gate (checks 11–13) eagerly
      → quarantine/remove overlapping samples; reject if quarantine fraction > 5%
      → reject if provenance invalid or namespace check fails
    Only after gate passes does the node proceed to ResourceScheduler.submit()
    NOTE: if user or Probe identifies that an acquired dataset should instead become a NEW
    EVAL ANGLE → that is a BenchmarkUpgrade proposal (Step 9.5), not a mutation. Forge must
    not smuggle eval data through the data-acquisition mutation path.
  Call evor_schedule(run_id, node_id, job_spec) → job submitted to ResourceScheduler
  SelfHealMonitor supervises each job (OOM/NaN/dep/checkpoint recovery)
  Evor idles via Monitor tool waiting for job_complete / self_heal_event events

### Step 5 — Evaluate (integrity-gated)
For each completed job:
  EvaluatorAdapter.run(eval_script, worktree, goal) → EvaluationResult
  Call evor_record_eval(run_id, node_id, result)  # triggers evor_integrity_check auto
  Read IntegrityReport from evaluations/<node-id>.json  # top-level path, NOT nodes/<id>/
  If integrity verdict == "failed": mark node integrity_status=failed; exclude from tournament

Step 5.5 — Verification re-run (tournament winner only)
  IntegrityGate.verification_rerun(winner_candidate) → confirm no regression
  If regression: reject winner; try next candidate

### Step 6 — Analyze + Learn
For each node (parallel):
  Spawn Probe (evor-probe) with: node.telemetry_ref, results.json, hypothesis,
    goal.modality (derived from GoalContract dataset_ref / task_description)
  Probe executes ProbeEDAContract flow (harness/evor/eda/):
    (1) Classify modality; (2) Generate bespoke analysis scripts for data-EDA +
        output/error-analysis + telemetry-EDA; (3) Execute via safe_exec() under limits;
        (4) Save outputs to nodes/<node_id>/eda/; (5) Distill findings
  Probe confirms/refutes registered Hypothesis using EDA evidence
  Call evor_wiki_add(run_id, lesson_entry)  # lesson cites EDA findings
  Call evor_cite(run_id, node_id, citations[])  # EDA finding paths as citations
  Update node hypothesis.confirmed via evor_record_node patch
  # Generated EDA scripts at nodes/<node_id>/eda/ are preserved for reproducibility

### Step 7 — Record
For each node:
  Call evor_record_node(run_id, completed_node{status:"done"})
  # PostToolUse hook validates tree.json was written
Call evor_state_write(run_id, {last_completed_tick: N, frontier_ids: [...]})
Append DecisionLogEntry for this tick
# Dashboard reads on-disk store automatically — no push needed

### Step 8 — Prune/Promote
Rank by primary metric (integrity_status=passed only)
No-regression check vs best_score

PRUNE GATE (R-14): before calling TreeEngine.prune(), check all BenchmarkUpgrade records:
  If any upgrade.rescore_status in ("pending", "in_progress"):
    Build skip_hashes = set of node ids where:
      (a) node.eval_version != GoalContract.eval_version  [stale — needs rescore first]
      OR (b) node.id in frontier_ids                      [currently on frontier]
    Pass skip_hashes to TreeEngine.prune() so GC skips those nodes' artifacts.
  Rescore deadline enforcement (R-2): for each upgrade where upgrade.rescore_deadline_ticks has elapsed
    (current_tick - upgrade.consent_at_tick >= upgrade.rescore_deadline_ticks):
      For each frontier node still on eval_version == upgrade.from_eval_version:
        Demote: set node.eval_version = "{upgrade.from_eval_version}-only"; exclude from frontier.
      Set upgrade.rescore_status = "partial"; log demotion in decision-log.md.

If winner: best_score = winner.metric; plateau_count = 0; circuit_breaker_count = 0
  Call TreeEngine.prune(winner.id, loser_ids, store, skip_hashes=skip_hashes) → GC losing artifacts
  Remove losing worktrees: git worktree remove .evor/worktrees/<id> --force; git worktree prune
If no winner (all integrity-failed OR all regression): circuit_breaker_count++
  Keep all worktrees temporarily for analysis
Remove winning worktree too: winner's code committed to tree via code_ref, not worktree

### Step 9 — Loop or Stop
Evaluate ALL conditions (spec §Constraints):
  - iterations >= max_iterations → stop
  - best_score meets target_value → stop  
  - plateau_count >= plateau_window → stop
  - circuit_breaker_count >= circuit_breaker → stop
  - max_cost_usd exceeded → stop
  - max_wall_clock_hours exceeded → stop
  - user cancel (EVOR_STOP=1 in env) → stop
  # Addendum v2 Pillar 4 — open_ended additional stop conditions:
  - mission_type=open_ended AND worst_angle_coverage >= GoalContract.coverage_target → stop
  - mission_type=open_ended AND worst-angle plateau (worst_angle_coverage unchanged for
    plateau_window ticks despite BenchmarkUpgrade opportunities) → stop
Milestone pings: if best_score crosses [10%, 25%, 50%, 75%, 100%] of target gap → print ping
  Open-ended: additionally ping when worst_angle_coverage crosses [25%, 50%, 75%, 95%] thresholds

Step 9.5 — BenchmarkUpgrade gate (Addendum v2 Pillar 3+4; runs every N ticks or on Probe/Sage proposal):
  # Probe or Sage may propose a BenchmarkUpgrade when EDA detects:
  #   - saturation on current eval_version (all frontier nodes scoring >95% of SOTA)
  #   - discovery of a new angle (open_ended only: Researcher finds a published benchmark the
  #     model hasn't been tested on; cites source via evor_cite)
  # Proposal is a BenchmarkUpgradeProposal (proposed_by, new_domains[], rationale, citations[])
  # AGENTS NEVER CREATE BenchmarkUpgrade records directly — apply_upgrade() creates them (Q4).
  # Governance check (Forge/Mutagen CANNOT submit BenchmarkUpgradeProposal):
  If upgrade_proposed:
    # Frequency cap (Risk D-2): check ExpansionPolicy.max_upgrades_per_N_ticks
    #   default {max_upgrades: 1, per_ticks: 5} — if cap would be exceeded, DEFER the proposal:
    upgrades_in_window = count BenchmarkUpgrade records in last max_upgrades_per_N_ticks.per_ticks ticks
    If upgrades_in_window >= max_upgrades_per_N_ticks.max_upgrades:
      Defer proposal: log [EVOR: BenchmarkUpgrade deferred — frequency cap reached]; goto Step 1
    If ExpansionPolicy.auto_add_within_families contains the domain family:
      auto-approve (consent_granted=True per policy); log to decision-log.md
    Else:
      Surface to user (milestone-ping decision): print upgrade proposal + citation + impact summary
      Await explicit user consent (cannot auto-approve)
  If consent_granted:
    Call benchmark.py::apply_upgrade(upgrade, strategy_state=strategy) → creates new EvalSuite v{n+1} (strict superset)
    For open_ended new angles: freeze fresh held-out split (FrozenSplitManager.freeze_splits)
      Fetch SOTA bar from SotaSource; log to AngleRegistry
      CRITICAL: new angle's held-out labels must be sourced from external provider or kept by user;
                they must NOT be visible to the training side (see Open Design Risks §b)
    Update GoalContract.eval_version → v{n+1}; GoalContract.locked_split_hash += new angle hash
    # Re-score mode (Q1): read strategy.rescore_mode — SINGLE source of truth
    Re-score live frontier nodes under v{n+1} per strategy.rescore_mode:
      "sync": block new ticks; re-run EvaluatorAdapter for ALL frontier nodes before continuing
      "async": mark frontier nodes rescore_status="pending"; ticks continue with stale nodes flagged;
               staleness enforced in best_frontier() and propose_crossover()
      For each frontier node re-scored: fitness_value drops if node fails new angle; "best-so-far" may change
      Nodes that cannot be re-scored (worktree GC'd): mark eval_version="v{old}-only" on TreeNode
    Append BenchmarkUpgrade record to decision-log.md
    Call evor_state_write(run_id, {eval_version: "v{n+1}", benchmark_upgrade_count: N+1})
    # Post-upgrade exploration boost (R-4): set on StrategyState immediately after upgrade
    boost = min(1.0, strategy.wildness + 0.3)
    ticks = min(15, max(5, len(frontier_ids) * 2))
    Call evor_state_write(run_id, {strategy: {post_upgrade_exploration_boost: boost,
                                               post_upgrade_exploration_ticks: ticks}})
    # Note: visit counts (n_i) are stale after upgrade — known v1 approximation; see ADR-004
    # Dashboard refreshes automatically (on-disk store update)
Else: goto Step 1

# Addendum v2 Pillar 4 — Living loop (open_ended missions):
# evor-run supports cron/scheduled invocation: when re-invoked after previous stop, it resumes
# the same AngleRegistry + EvalSuite, ingests new published SOTA bars (SotaSource re-fetch),
# and continues the tick loop. This allows "set it and run indefinitely" missions that keep
# pace with the published SOTA as the field advances.
# SOTA regression guard (Q3): during living-loop SotaSource re-fetch, if any newly fetched bar
# is LOWER than the committed bar, call angle_registry.py::flag_sota_regression() — the
# monotonic write-lock (R-8) prevents auto-lowering; the user receives a human-review
# milestone-ping with old bar, new fetched value, source + citation, and timestamp so they can
# decide if it is a legitimate leaderboard correction. The committed bar is NEVER auto-lowered.
```

**Meta-evolution loop** (after every `strategy.meta_loop_interval` ticks):
```
python -m evor.tree meta-evolve --run-id <id>
→ new StrategyState (ucb1_c, wildness, family_mix updated)
Call evor_state_write(run_id, {strategy: new_state})
Append DecisionLogEntry(type=meta-evolve, strategy_delta=delta)
```

**Dependencies:** M3, M5, M6, M7.
**Gate layers:** L2 (skill logic reviewable, doom-loop test) → L3 (full run).

---

### M9 — FastAPI Dashboard (L2→L3)
**Goal:** Dashboard renders tree + frontier + live telemetry SSE streams; reads only from on-disk `.evor/` store.

**`harness/evor/dashboard/server.py`:**
```python
app = FastAPI()

@app.get("/api/runs")
async def list_runs() -> list[dict]: ...              # missions + best-so-far

@app.get("/api/runs/{mission_id}/{run_id}/tree")
async def get_tree(mission_id, run_id) -> list[TreeNode]: ...

@app.get("/api/runs/{mission_id}/{run_id}/nodes/{node_id}")
async def get_node(mission_id, run_id, node_id) -> NodeDetail: ...

@app.get("/api/runs/{mission_id}/{run_id}/frontier")
async def get_frontier(mission_id, run_id) -> list[TreeNode]: ...

@app.get("/api/runs/{mission_id}/{run_id}/strategy")
async def get_strategy(mission_id, run_id) -> StrategyState: ...

# Addendum v2 Pillar 3 — Per-domain + eval_version endpoints
@app.get("/api/runs/{mission_id}/{run_id}/eval-versions")
async def list_eval_versions(mission_id, run_id) -> list[EvalSuite]:
    """List all EvalSuite snapshots for this run; shows upgrade history."""

@app.get("/api/runs/{mission_id}/{run_id}/nodes/{node_id}/per-domain")
async def get_per_domain(mission_id, run_id, node_id) -> dict:
    """Return per_domain breakdown from results.json; include eval_version tag.
    Dashboard refuses to display cross-version comparisons without version label."""

@app.get("/api/runs/{mission_id}/{run_id}/domain-pivot")
async def get_domain_pivot(mission_id, run_id, metric: str, domain: str,
                           eval_version: str | None = None) -> list[dict]:
    """Pivot: all nodes × (eval_version, domain, metric) → sorted leaderboard.
    If eval_version=None, returns only nodes matching current GoalContract.eval_version."""

# Addendum v2 Pillar 4 — Open-ended coverage view
@app.get("/api/runs/{mission_id}/{run_id}/coverage")
async def get_coverage(mission_id, run_id) -> dict:
    """Coverage view for open_ended missions:
    { current_coverage, coverage_target, worst_angle_id, per_angle: [{angle_id, value, sota_bar, above_sota}] }
    Returns 404 with message for fixed missions."""

@app.get("/api/runs/{mission_id}/{run_id}/angle-registry")
async def get_angle_registry(mission_id, run_id) -> AngleRegistry:
    """Full AngleRegistry including pretraining_contamination_risk flags."""

@app.get("/api/telemetry/{mission_id}/{run_id}/{node_id}")
async def stream_telemetry(mission_id, run_id, node_id):
    """SSE: tail telemetry.jsonl; emit new TelemetryRecord lines as Server-Sent Events.
    Pattern mirrors SIA server.py serve_in_background + background thread."""
    async def generate():
        path = f".evor/runs/{mission_id}/{run_id}/nodes/{node_id}/telemetry.jsonl"
        with open(path) as f:
            f.seek(0, 2)  # tail
            while True:
                line = f.readline()
                if line.strip(): yield f"data: {line}\n\n"
                else: await asyncio.sleep(0.5)
    return EventSourceResponse(generate())

@app.get("/api/artifacts/{content_hash}")
async def get_artifact(content_hash) -> FileResponse: ...
```

**`harness/evor/dashboard/static/index.html`:**
- D3.js tree layout: nodes colored by `approach_family`; size by `visit_count`; frontier nodes green border; pruned nodes grey; **Addendum v2:** nodes annotated with `eval_version` badge (v1/v2/…); v1-only nodes shown with hatching when current version is v2+
- Per-node sidebar: metrics table, hypothesis text, approach_family badge, lessons links, citation list; **Addendum v2:** per-domain breakdown table (domain rows × metric columns); `fitness_value` shown with mode label (aggregate/worst-domain/weighted); `mutation_tier` badge (parametric/structural)
- Live telemetry panel: Chart.js line charts for `train_loss`, `lr`, `grad_norm`, `throughput`; data fed via SSE
- Auto-refresh tree every 10s via `setInterval + fetch`; telemetry streams via `EventSource`
- **Addendum v2 Pillar 3 — Domain leaderboard panel:** table of all nodes × domains; color-coded by performance vs SOTA bar; eval_version filter dropdown; cross-version comparison shows warning banner
- **Addendum v2 Pillar 4 — Coverage gauge panel** (open_ended missions only): radial gauge for `worst_angle_coverage` vs `coverage_target`; per-angle bar chart showing value vs SOTA bar; `pretraining_contamination_risk` tooltip on each angle bar
- **Addendum v2 Pillar 3 — Benchmark upgrade timeline:** horizontal timeline of EvalSuite version bumps; each bump shows: new domains added, consent type (policy/user), date, re-score status

**CLI:** `python -m evor.dashboard --run-dir .evor/runs/<mission>/<run-id> --port 8756`

**Tests** (`test_dashboard.py`): FastAPI `TestClient`; GET /api/frontier returns best node from fixture; GET /api/tree returns all nodes; telemetry endpoint returns EventSource headers. **Addendum v2:** `test_per_domain_endpoint`: GET /api/runs/.../nodes/{id}/per-domain returns dict with domain keys matching EvalSuite; `test_domain_pivot`: GET /api/domain-pivot?metric=accuracy&domain=scanned returns nodes sorted by that metric; `test_eval_version_filter`: domain-pivot without eval_version param returns only current-version nodes; `test_coverage_endpoint_open_ended`: GET /coverage returns current_coverage + per_angle list; `test_coverage_endpoint_fixed_mission`: GET /coverage returns 404 with clear message; `test_angle_registry_endpoint`: GET /angle-registry returns AngleRegistry with contamination risk fields; `test_benchmark_upgrade_timeline`: GET /eval-versions returns list of EvalSuites in version order.

**Dependencies:** M4, M5.
**Gate layers:** L2 (test_dashboard.py) → L3 (visual check).

---

### M10 — L2 Full Test Suite (L2 gate)
**Goal:** All vitest + pytest suites pass; seeded negative test cases for every L3 acceptance criterion.

**Additional tests to close gaps:**

**Files to create (M10):**
- `harness/tests/test_tick_loop.py` — stop-condition matrix (AC-11): all 7 stop conditions fired correctly (target_value met, plateau_count >= plateau_window, circuit_breaker_count >= circuit_breaker, max_cost_usd exceeded, max_wall_clock_hours exceeded, user EVOR_STOP=1, max_iterations reached); doom-loop detection triggers after 3 all-rejected ticks and overrides wildness to 0.9.

**Additional tests to close gaps:**

`mcp/tests/hooks.test.ts` — Stop hook with `pending_node_ids: ["n1"]` → exit 2 + system-reminder; with empty → exit 0; PostToolUse after `evor_record_eval` with telemetry.jsonl present → no warning; telemetry.jsonl missing → warning injected (stdout-scan path removed per R11).

`harness/tests/test_integrity.py` — seeded test-set leakage fixture → `no_test_leakage=False`, `verdict="failed"`; seeded NaN in `telemetry.jsonl` → `telemetry_sane=False`; eval script sha256 modified → `no_eval_shift=False`; tabular candidate without grad_norm field → `telemetry_sane=True` (grad_norm sub-check skipped correctly per R6).

`harness/tests/test_monitor.py` — inject `RuntimeError: CUDA out of memory` in job stderr → `batch_size` halved, job retried; inject `NaN` in telemetry stream → lr halved, checkpoint restored; 3+ failures → `status=error` returned.

`harness/tests/test_tree.py` — H002: simulate 3 consecutive same-family wins → family deprioritized in `family_mix`; H003: duplicate family in proposals → `h003_intra_tick_diversity="fail"`.

`harness/tests/test_wiki.py` — cross-run: lessons added with `run_id="run-1"` retrievable when querying from `run_id="run-2"` same mission.

**Dependencies:** M7, M8, M9.
**Gate layers:** L2 (all vitest + pytest green).

---

### M11 — Release-Gate Benchmark + L3 End-to-End (L3 gate)
**Goal:** All 11 spec acceptance criteria checkboxes verified on the fixed benchmark.

**Benchmark setup:**
- `benchmarks/cifar10-subset/` — CIFAR-10 1000 train / 200 val / 200 test; ResNet-9 baseline (target: beat val_accuracy > 0.72); pre-committed `eval_lock.json` with split sha256
- `benchmarks/tabular-churn/` — UCI churn dataset; XGBoost baseline (target: beat AUC-ROC > 0.82)
- `benchmarks/cheat_injector.py` — injects 50 test samples into training data; used to validate Integrity Gate rejection

**`scripts/l3-e2e.sh`:**
```bash
# 1. Install plugin into test Claude Code session
# 2. Run: evor-setup (CIFAR-10, from-scratch, beat-baseline, wildness=0.5, max_iterations=10)
# 3. Run: evor-run (launch tick loop)
# 4. Assert: tree.json has >= 5 nodes; >= 1 node integrity_status=passed
# 5. Assert: at least one node.depth > 1 (branch from non-root)  → AC-04
# 6. Assert: at least one node.is_crossover == true              → AC-04
# 7. Inject cheat_injector.py as a mutation; assert integrity verdict=failed → AC-05
# 8. Simulate skipped evor_record_node; assert Stop hook exits 2 → AC-06
# 9. Submit un-instrumented proposal; assert Critic rejects      → AC-07
# 10. Inject PYTORCH_CUDA_OOM_TEST=1; assert SelfHealMonitor halves batch → AC-08
# 11. Run second run on same mission; query wiki → lessons from run 1 cited → AC-09
# 12. curl localhost:8756/api/tree; assert 200 + nodes populated → AC-10
# 13. Seed plateau scenario (8 stagnant ticks); assert stop fires → AC-11
# 14. Assert best_score > baseline in final run-state.json       → AC-03
# --- Addendum v2 + consensus pass 2 L3 assertions ---
# 15. Assert: genome_ref present on >= 1 parametric node AND >= 1 structural node;
#     crossover child has 2 parent_ids and genome from merge_genomes (genome.yaml diff) → AC-12
# 16. Tamper frozen-split file (chmod 644 + overwrite byte); run integrity check;
#     assert frozen_split_read_only=False OR split_hash_match=False → AC-13
# 17. Inject near-duplicate-of-test augmented image (seeded dhash collision);
#     assert near_dup_leakage=False, verdict=failed → AC-14
# 18. AC-15 mechanical assertion (R-15): for the node with Probe EDA output,
#     assert: (a) file exists matching nodes/<id>/eda/analysis_*.py,
#     (b) grep "from evor.eda" in that file returns >= 1 match,
#     (c) grep "domain_id" (or EvalSuite.domains) in that file returns >= 1 match
#     confirming domain_id is loaded at runtime, not hardcoded → AC-15
# 19. Trigger BenchmarkUpgrade (add 1 domain); assert: new eval_version created,
#     frontier node re-scored on new domain only (--eval-domains flag), prior best
#     may be demoted, consent logged in decision-log.md → AC-16
# 20. Open-ended mission run: add angle that prior best node fails;
#     assert: worst_angle_coverage decreases, node demoted from frontier → AC-17
# 21. Data-acquisition mutation with eval-overlapping batch: assert quarantine fires,
#     acquisition_contamination_clear=False, verdict=failed;
#     valid synthetic mutation: assert acquisition_namespace_enforced=True → AC-18
```

**CI files to create (added to M11):**
- `.github/workflows/l1-l2.yml` — triggered on: `pull_request`; runs `npm run build && node scripts/l1-check.mjs && npm test && uv run pytest harness/tests/ -v`; all L1+L2 checks must pass before merge.
- `.github/workflows/l3.yml` — triggered on: `push: tags: ['v*']` (version-tag gate only); runs `bash scripts/l3-e2e.sh`; L3 does NOT run on PRs (cost/time prohibitive).

**CI cadence contract:** L1+L2 gate every PR; L3 gates version tags only (triggered by `git tag v*`).

**Dependencies:** M0–M10 all complete; Claude Code with plugin installed.
**Gate layers:** L1 + L2 + L3 (all acceptance criteria).

---

---

## Addendum v2 — Milestone Deltas

*Per-milestone enumeration of what Addendum v2 adds or changes, so an executor can see all deltas in one place. Base-plan content for each milestone remains authoritative; these entries are strictly additive.*

| Milestone | Pillar | Files Added or Changed | What Changes |
|-----------|--------|------------------------|--------------|
| **M1** | P1,P2,P3,P4 | `mcp/src/schemas/contracts.ts`, `harness/evor/contracts.py`, `mcp/tests/schemas.test.ts` | 13 new schema types (GenomeConfig, MutationLocus, FrozenSplit, DataProvenance, EvalSuite, Domain, MetricSpec, MetricRegistry, BenchmarkUpgrade, ExpansionPolicy, SotaSource, AngleRegistry, CoverageTarget); updated GoalContract (+mission_type, metric_specs, fitness_mode, eval_version, coverage_target, expansion_policy); updated TreeNode (+parent_patch_ref, genome_ref, mutation_tier, mutation_locus, eval_version, fitness_value); updated EvaluationResult (+eval_version, per_domain, fitness_value, worst_angle_coverage, per_angle_vs_sota); updated IntegrityReport (+eval_version, frozen_split_read_only, near_dup_leakage, data_provenance_valid, eval_version_consistent); RunStore ensureRunDirs() adds eval-suites/, frozen-splits/ |
| **M3** | P1,P4 | `agents/evor-forge.md`, `skills/evor-setup/SKILL.md` | Forge (Implementer) mandate: genome materialization (modular seams, parametric vs structural tiers, parent.patch storage, merge_genomes for crossover, genome adapter for seed-repo); Forge never touches evaluate.py or frozen-split paths. evor-setup: 3 new interview questions (mission_type, ExpansionPolicy, CoverageTarget); freeze_splits() call at setup; EvalSuite v1 creation; ExpansionPolicy consent checkpoint for open_ended |
| **M4** | P2 | `harness/evor/freeze.py` (new), `harness/tests/test_freeze.py` (new) | FrozenSplitManager (freeze_splits, verify_frozen_split, check_read_only); DataProvenanceTracker (record, check_near_dup modality-aware); 6 new tests covering frozen split creation, chmod 444 enforcement, tamper detection, near-dup detection |
| **M4** | P1 | `harness/evor/genome.py` (new) | GenomeConfig loader/validator; genome adapter for seed-repo seam discovery; merge_genomes crossover logic; validate_genome schema check |
| **M4** | P3,P4 | `harness/evor/benchmark.py` (new), `harness/evor/angle_registry.py` (new) | EvalSuite/EvalVersion management; BenchmarkUpgrade governance (apply_upgrade, superset check, consent gate, re-score orchestration); MetricRegistry; AngleRegistry CRUD; SotaSource fetch; coverage computation (worst_angle_coverage, per_angle_vs_sota) |
| **M5** | P1 | `harness/evor/tree.py`, `harness/tests/test_tree.py` | propose_crossover: genome-aware merge via merge_genomes; mutation_tier set by schema compatibility; cross-version crossover refused + logged; 3 new crossover tests |
| **M5** | P3,P4 | `harness/evor/tree.py`, `harness/tests/test_tree.py` | compute_fitness() method: aggregate / worst-domain / weighted / worst_angle_coverage modes; best_frontier() eval_version consistency enforcement; 3 new fitness tests |
| **M6** | P2 | `harness/evor/integrity.py`, `harness/tests/test_integrity.py` | IntegrityGate.check() signature adds frozen_test + provenance_path params; 4 new checks (frozen_split_read_only, near_dup_leakage, data_provenance_valid, eval_version_consistent); 4 new seeded-failure tests |
| **M6** | P3,P4 | `harness/evor/evaluator.py`, `harness/tests/test_evaluator.py` | EvaluatorAdapter per-domain emission contract; eval_version injected as EVOR_EVAL_VERSION env var; fitness_value computed post-parse by TreeEngine (not eval script); open_ended: score_angles() call after parse; 4 new evaluator tests |
| **M8** | P1 | `skills/evor/SKILL.md` | Step 4 expanded: genome materialization mandate, DataProvenanceTracker.record() call for data mutations |
| **M8** | P3,P4 | `skills/evor/SKILL.md` | Step 9: 2 new open_ended stop conditions (coverage_target, worst-angle plateau); milestone pings for coverage; Step 9.5 BenchmarkUpgrade governance flow (proposal surfacing, consent gate, upgrade application, frontier re-score, node demotion); living loop description for open_ended cron/scheduled re-invocation |
| **M9** | P3,P4 | `harness/evor/dashboard/server.py`, `harness/evor/dashboard/static/index.html`, `harness/tests/test_dashboard.py` | 5 new API endpoints (eval-versions, per-domain, domain-pivot, coverage, angle-registry); domain leaderboard panel; coverage gauge panel (open_ended only); benchmark upgrade timeline UI; eval_version badge on tree nodes; v1-only node hatching; 7 new dashboard tests |
| **M10** | P1–P4 | `harness/tests/test_tick_loop.py` | Addendum v2 stop conditions in stop-condition matrix (coverage_target, worst-angle plateau); genome materialization verified in tick sequence; BenchmarkUpgrade consent gate tested (auto-approve vs user-require) |
| **M11** | P1–P4 | `scripts/l3-e2e.sh`, `benchmarks/cifar10-subset/` | L3 assertions for all 7 Addendum v2 acceptance criteria (AC-12 through AC-18); CIFAR-10 split frozen at setup, tamper test, per-domain emission, BenchmarkUpgrade consent flow, crossover from genomes, open_ended worst-angle coverage |
| **All** | ACQ | `harness/evor/contracts.py`, `mcp/src/schemas/contracts.ts` | ApproachFamily: `data-curation` and `augmentation` split into `data-curation`, `data-augmentation`, `data-acquisition`; legacy `augmentation` aliased; `AcquisitionProvenance` schema added; `GenomeConfig.acquired_datasets[]` added; `IntegrityReport` gains `acquisition_contamination_clear`, `acquired_data_provenance_valid`, `acquisition_namespace_enforced` (nullable) |
| **M4** | ACQ | `harness/evor/store.py`, `harness/tests/test_store.py` | `ContentAddressedStore.register_acquired()` and `verify_namespace()` added; `register_acquired(..., namespace="eval")` raises ValueError (structural enforcement) |
| **M6** | ACQ | `harness/evor/integrity.py`, `harness/tests/test_integrity.py` | Ingestion Contamination Gate (checks 11–13): acquisition_contamination_clear (cross-version eval scan + near-dup), acquired_data_provenance_valid (license + citation), acquisition_namespace_enforced; 5 new tests (`test_ingestion_contamination`, `test_acquired_data_provenance`, `test_acquisition_namespace_enforcement`, `test_acquisition_cross_version_contamination_scan`); check count 10 → 13 (3 conditional) |
| **M8** | ACQ | `skills/evor/SKILL.md` | Step 4 two-path rule: data-acquisition nodes run Ingestion Contamination Gate eagerly before training; namespace="eval" attempt structurally blocked by DataStore; Forge mandate updated for AcquisitionProvenance population |

---

## Addendum v2 — Open Design Risks

*These risks apply specifically to the open-ended / generality missions (Pillar 4) and the benchmark evolution mechanism (Pillar 3). They are not fully closed by the current spec and must be stress-tested by the Architect/Critic review pass. Mitigations are proposed; some require explicit design decisions before implementation.*

### Risk A — SOTA sourcing trust: the same agent that builds the model retrieves its own yardstick

**Description:** When an angle is added to the AngleRegistry, its `sota_bar` is fetched from a `SotaSource` (Papers With Code, arXiv, etc.) by Researcher/Sage — the same agents whose job is to find better mutations. A motivated Sage could cite a low-credibility or cherry-picked source to set an artificially low SOTA bar, making it trivially easy for the model to "beat SOTA" on that angle.

**Specific gap:** The current spec says Sage cites `CitationBackedFinding[]` with a confidence field, but there is no independent verification step for the SOTA bar value itself before it is committed to AngleRegistry.

**Proposed mitigations:**
1. **Separate SOTA retrieval from Sage's normal workflow:** create a dedicated `SotaVerifier` sub-step that re-fetches the same claim from ≥2 independent `SotaSource` entries (e.g., Papers With Code + arXiv + human-provided) and flags divergence >5%. Sage proposes; SotaVerifier confirms.
2. **User-anchored SOTA for high-stakes angles:** when `trust_level="authoritative"`, require `retrieval_method="human_provided"` (user pastes the value directly) or at minimum surface the fetched value to the user before the BenchmarkUpgrade is consented.
3. **Immutability of committed SOTA bars:** once an angle's `sota_bar` is committed to AngleRegistry, it can only increase (monotonic ratchet applies to the bar too) — Sage cannot retroactively lower it. Requires a write-lock check in `angle_registry.py::update_angle()`.
4. **Audit trail requirement:** every SOTA bar entry must include `sota_retrieved_at`, `source_url`, and the raw snippet from the source that was parsed. This makes post-hoc audits possible.

**Decision needed:** Who performs independent SOTA verification, and what quorum of sources is required before committing a new bar? Recommend: ≥2 sources or user confirmation for authoritative bars; indicative bars are advisory only.

---

### Risk B — Pretraining contamination: freshly added angle's "held-out" labels may be memorized in foundation-model pretraining

**Description:** For open_ended missions using foundation models (LLMs, vision transformers pretrained on internet-scale data), a "new angle" that is a public benchmark (e.g., MMLU, HumanEval, GSM8K) may have its labels memorized during the model's pretraining. When the AngleRegistry flags `is_public_benchmark=True`, a model can score near-SOTA on that angle without genuine generalization. The AngleRegistry `pretraining_contamination_risk` field acknowledges this, but it is currently just a label — there is no enforcement.

**Specific gap:** The held-out split for a public-benchmark angle is not truly "held-out" from the foundation model's perspective, even though it is frozen from the training side of evor's loop.

**Proposed mitigations:**
1. **Canary detection:** for each newly added public-benchmark angle, run the model in eval mode **before any fine-tuning on that mission** (using the seed/baseline model). If baseline score is already within 5% of the SOTA bar, flag the angle as `contamination_risk="high"` and surface a warning to the user before accepting it into AngleRegistry. High pre-fine-tuning scores are a contamination signal.
2. **Private angle splits:** prefer angles where the held-out labels are not publicly available (e.g., user-created evaluation sets, vendor-provided private test sets, newly collected data not yet in pretraining corpora). Distinguish `pretraining_cutoff_date` awareness in `AngleRegistry` — angles first published after the foundation model's training cutoff are lower-risk.
3. **De-contamination discount:** when `pretraining_contamination_risk="high"`, apply a discount to the fitness contribution of that angle: `effective_bar = max(sota_bar, baseline_model_score_before_finetune)`. This raises the effective yardstick to "beat what the base model already knows," not just beat published SOTA.
4. **Policy-level guard in ExpansionPolicy:** add a `reject_public_benchmarks_with_contamination_risk` boolean; when true, BenchmarkUpgrade for a high-contamination angle is auto-rejected and requires explicit user override.

**Decision needed:** Should evor accept high-contamination-risk public benchmarks with a discount, or require private/gated evaluations for open_ended missions? Recommend: accept with canary + discount as default; reject-unless-override as strict mode configurable in ExpansionPolicy.

---

### Risk C — Stale eval_version in crossover/backtrack: a node declared "general" under v1 may survive on the frontier despite v2 adding angles it would fail

**Description:** The base plan (M8 Step 9.5) re-scores frontier nodes on BenchmarkUpgrade. However, "re-score where feasible" is the current language — worktrees that have been GC'd are marked "v1-only" and allowed to remain on the frontier with that flag. A node that looks best under v1 may be the worst performer on the new v2 angle, but if its worktree is GC'd, it cannot be re-scored and remains visible as a frontier candidate. Future crossover targeting that node inherits its stale eval context.

**Specific gap:** `propose_crossover()` currently refuses cross-version crossover (node_a.eval_version != node_b.eval_version → ValueError). But if a v1-only node's worktree is GC'd, it cannot be updated to v2, so it is permanently excluded from crossover and from the frontier — which is correct behaviour, but the plan does not explicitly state this and the GC logic in M5/M8 Step 8 does not yet account for eval_version as a GC retention criterion.

**Proposed mitigations:**
1. **Explicit GC retention rule:** a node's worktree may not be GC'd if `node.eval_version != GoalContract.eval_version` AND the node is currently on the frontier. Retain the worktree until the node has been re-scored under the current eval_version or explicitly demoted.
2. **Re-score-before-GC obligation:** when BenchmarkUpgrade runs, re-score ALL current frontier nodes before pruning any worktree. Only after re-score is complete (or a node is explicitly demoted to "v{old}-only") may the worktree be GC'd.
3. **Frontier version gate:** `best_frontier()` must exclude any node where `node.eval_version != GoalContract.eval_version` unless the node is the only survivor on the frontier (in which case it is shown with a "stale eval" warning).
4. **Crossover version check extended:** the existing cross-version crossover refusal (see M5 tests) already covers this for live nodes. The additional rule: a node can only become a crossover parent if `node.eval_version == current_eval_version` OR if it has been freshly re-scored under the current version.

**Decision needed:** Should re-scoring all frontier nodes on BenchmarkUpgrade be a synchronous blocking step (no new ticks until re-score completes) or async (ticks continue; stale nodes are flagged but remain)? Recommend: synchronous for small frontiers (≤10 nodes); async with staleness flag for larger runs. Make configurable in StrategyState.

---

### Risk D — Compute cost of re-scoring the entire live frontier on every BenchmarkUpgrade

**Description:** As the AngleRegistry grows (N angles) and the frontier grows (F nodes), every BenchmarkUpgrade triggers F × 1 re-evaluations (one per frontier node, each running the full eval suite including all N angles). For large open_ended runs (F=20 nodes, N=15 angles), a single BenchmarkUpgrade could trigger 20 full evaluation runs — equivalent to 20 ticks of compute cost, paid not in expected-value exploration but in mandatory governance overhead.

**Proposed mitigations:**
1. **Incremental re-scoring:** BenchmarkUpgrade only needs to evaluate frontier nodes on the **newly added domains** (the upgrade is a superset: v_{n+1} ⊇ v_n, so existing-angle scores are already known). `EvaluatorAdapter` should support `eval_domains: list[str]` param to run a partial evaluation (new domains only). Final v2 score = cached v1 per_domain scores + new angle scores. This reduces re-score cost from F × (N angles) to F × (new_angles_only).
2. **Re-score prioritization:** re-score frontier nodes in descending fitness order (best node first). If the best node fails the new angle, it is immediately demoted and the frontier leader changes — subsequent re-scores may be skipped if the budget is tight.
3. **Budget cap on BenchmarkUpgrade frequency:** add `max_upgrades_per_N_ticks` in ExpansionPolicy to prevent rapid-fire upgrades in high-saturation periods. Default: 1 upgrade per 10 ticks.
4. **Lazy re-score for non-frontier nodes:** non-frontier nodes with `status=pruned` or `depth < current_frontier_min_depth` are NOT re-scored (already below the current best — re-scoring them does not change frontier membership). Only active, non-pruned, non-demoted nodes need re-scoring.

**Decision needed:** Should eval scripts support partial domain evaluation (new-angles-only) or must they always run the full suite? Recommend: support `--eval-domains` flag in eval_script interface; full suite is default for M11 benchmarks; partial is the performance optimization for large open_ended runs.

---

## Acceptance Criteria

All 11 checkboxes from spec §Acceptance Criteria v1:

| # | Criterion (verbatim from spec) | Gate | Primary test |
|---|------|------|------|
| AC-01 | `plugin.json` valid; every referenced skill/agent/command/hook/MCP entry exists and loads; SKILL.md frontmatter parses | L1 | `scripts/l1-check.mjs` |
| AC-02 | `vitest` over TS MCP tools + hooks; `pytest` over Python harness | L2 | `npm test` + `uv run pytest harness/tests/` |
| AC-03 | Full evolution on CIFAR-10 subset; verified integrity-gated improvement within tight compute budget; complete trace + tree/frontier rendered | L3 | `scripts/l3-e2e.sh` |
| AC-04 | Evolution search branches from non-latest node AND performs ≥1 crossover | L3 | Assert `node.depth>1` AND `is_crossover=True` node in tree.json |
| AC-05 | Integrity Gate rejects seeded cheating mutation (test-set leakage) | L2+L3 | `test_integrity.py::test_seeded_leakage`; L3 `cheat_injector.py` |
| AC-06 | Deliberately-skipped `evor_record_node` caught by Stop hook (turn blocked) | L2+L3 | `hooks.test.ts`; L3 negative test |
| AC-07 | Un-instrumented candidate rejected by Critic pre-execution; instrumented → telemetry curves on dashboard | L2+L3 | `test_dashboard.py`; L3 submission test |
| AC-08 | Seeded CUDA-OOM auto-recovered (batch halved, grad-accum doubled) | L2+L3 | `test_monitor.py`; L3 OOM injection |
| AC-09 | Wiki lessons from run N retrievable and cited in run N+1 | L2+L3 | `test_wiki.py::test_cross_run`; L3 chained run |
| AC-10 | Dashboard renders tree, per-node artifacts, best-so-far frontier, live telemetry, updating from on-disk store | L3 | `test_dashboard.py` (TestClient); L3 browser/curl check |
| AC-11 | All stop conditions fire correctly: target, plateau (8-window), circuit-breaker (5), budget, user-cancel | L2+L3 | `test_tick_loop.py` stop-condition matrix |
| AC-12 | A parametric mutation and a structural mutation both produce valid child nodes with correct genome_ref + parent.patch; a crossover child inherits genes from two distinct lineages via merge_genomes | L2+L3 | `test_tree.py::test_genome_crossover`; L3 genomic lineage assertion in l3-e2e.sh |
| AC-13 | Frozen split hash is verified on every eval; a seeded test-set tamper (file overwrite) is detected by IntegrityGate (frozen_split_read_only=False OR split_hash_match=False) | L2+L3 | `test_freeze.py::test_verify_frozen_split`; `test_integrity.py::test_frozen_split_tamper`; L3 tamper injection |
| AC-14 | A seeded near-duplicate-of-test augmentation (dhash collision) is caught by the leakage check (near_dup_leakage=False, verdict=failed) | L2+L3 | `test_freeze.py::test_near_dup`; `test_integrity.py::test_near_dup_leakage` |
| AC-15 | EvaluationResult carries per_domain + aggregate metrics tagged with eval_version; Probe's generated EDA script: (a) exists at `nodes/<id>/eda/analysis_*.py`, (b) imports from `evor.eda`, (c) references >=1 domain_id loaded from EvalSuite.domains at runtime (not hardcoded) | L2+L3 | `test_evaluator.py::test_per_domain_emission`; L3 mechanical assertion in l3-e2e.sh step 18 (R-15) |
| AC-16 | A BenchmarkUpgrade (add one domain) creates a superset eval_version, re-scores live frontier nodes via BenchmarkRescore merge protocol (partial --eval-domains {new} result merged with cached v_old per_domain; fitness recomputed by TreeEngine.compute_fitness() post-merge), can demote prior "best" node, is consent-gated, and is logged in decision-log.md | L2+L3 | `test_tick_loop.py::test_benchmark_upgrade_consent_gate`; `test_evaluator.py::test_benchmarkrescore_merge`; L3 BenchmarkUpgrade flow in l3-e2e.sh step 19 (R-6) |
| AC-17 | Open-ended mission optimizes worst-angle coverage; adding an angle demotes a prior best node that fails the new angle; expansion is monotonic (no removal permitted by AngleRegistry API; attempt raises IntegrityError) | L2+L3 | `test_tree.py::test_fitness_open_ended`; `test_tick_loop.py::test_angle_removal_rejected`; L3 open-ended demotion assertion |
| AC-18 | A data-acquisition mutation whose acquired batch overlaps a frozen eval split is caught and the overlapping samples quarantined by the Ingestion Contamination Gate (`acquisition_contamination_clear=False`, `verdict=failed`); a synthetic-data mutation with valid AcquisitionProvenance (generator_config + citation, no test-overlap) passes the gate and is accepted into the train namespace only (`acquisition_namespace_enforced=True`) | L2+L3 | `test_integrity.py::test_ingestion_contamination`; `test_integrity.py::test_acquisition_namespace_enforcement`; L3 acquisition flow in l3-e2e.sh |

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **Storage blowup** — GPU checkpoints (1–10 GB each) accumulate across candidates | High | Critical | ContentAddressedStore sha256 dedup + hardlinks (M4); GC on every prune (M5, M8 Step 8); `max_checkpoint_gb` cap in GoalContract; `store.gc()` called atomically with prune |
| **Compute cost runaway** — unconstrained parallel training × long jobs = unbounded GPU-hours | High | High | ResourceScheduler throughput-probe (M4); `circuit_breaker` stops at 5 zero-winner ticks; `max_gpu_hours` + `max_wall_clock_hours` hard caps; preflight smoke-test before committing to full run |
| **Reward hacking / eval shift** — Forge discovers eval shortcut (label memorization, split contamination) | Medium | Critical | IntegrityGate 6-check suite (M6); `locked_split_hash` at mission start; `eval_script_hash` no-shift check; verification re-run of tournament winner (Step 5.5, M8) |
| **Agent team coordination deadlock** — CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS races on `.evor/` shared state | Medium | High | `tree-store.ts` atomic rename-swap (M1); all tree writes serialized through single MCP server process; task-board tasks bound to unique `node_id` per agent; timeout on `asyncio.gather` (M8) |
| **Hook enforcement gap** — Forge writes un-instrumented training code; Critic approves | Medium | High | Critic instrumentation check is a blocking hard gate (M3); PostToolUse hook verifies `telemetry.jsonl` exists before accepting `evor_record_eval` (M7); L3 test deliberately submits un-instrumented → assert rejection |
| **Long-run resumability failure** — session crashes mid-tick; tree.json half-written | Medium | High | Atomic rename-swap on all `tree.json` writes (M1); `run-state.json` tracks `pending_node_ids` + `last_completed_step`; `evor-resume` command re-enters from saved step; mirrors `refs/oh-my-claudecode/skills/self-improve/SKILL.md §Resumability` pattern |
| **Doom loop — same family rejected repeatedly** | Low | Medium | H002 diversity enforcement (M5); meta-evolution increases `ucb1_c` (raises exploration) after stagnant ticks (M8); circuit_breaker fires at 5 consecutive zero-winner ticks |
| **SelfHealMonitor infinite retry on unrecoverable OOM** | Low | Medium | Hard retry cap: 3 attempts max per node (M6); after 3 failures → `status=error`, circuit_breaker_count++; monitor does NOT retry again |
| **Wiki pollution** — early failed runs flood wiki with incorrect lessons | Low | Medium | LessonEntry includes `hypothesis_verdict`; `evor_wiki_query` supports `confirmed_only=True` filter; Sage reviews lessons for consistency before citing |
| **Dashboard blocks evolution** — FastAPI crash halts main loop | Low | Low | Dashboard runs in `threading.Thread(daemon=True)` (SIA server pattern); crash is logged to decision-log.md but does NOT propagate to tick loop; evolution continues without dashboard |

---

## Verification Steps

1. **After M0:** `node scripts/l1-check.mjs` → all paths green; `npm run build` → zero TS errors; `python -c "import evor"` → no import errors.

2. **After M1:** `npm test mcp/tests/schemas.test.ts` → all Zod round-trips pass; `uv run pytest harness/tests/test_contracts.py harness/tests/test_store.py` → green.

3. **After M2:** `echo '{"method":"tools/list"}' | node mcp/dist/index.cjs` → 12 tool names in response; `node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8'))"` → valid.

4. **After M3:** `node scripts/l1-check.mjs` → all agent/skill/command .md files found; verify all 5 agents have `model` field in frontmatter; verify `skills/evor/SKILL.md` contains all 9 step headings.

5. **After M4:** `uv run pytest harness/tests/test_store.py harness/tests/test_scheduler.py -v` → green; manual: `python -m evor.preflight --dry-run` → environment discovery report printed.

6. **After M5:** `uv run pytest harness/tests/test_tree.py harness/tests/test_wiki.py -v` → green; manual: create 3-node fixture, run UCB1 select, verify non-root node selected with correct score formula.

7. **After M6:** `uv run pytest harness/tests/test_integrity.py harness/tests/test_monitor.py harness/tests/test_telemetry.py harness/tests/test_evaluator.py -v` → all green; seeded leakage test passes.

8. **After M7:** `npm test mcp/tests/` → all green; `mcp/tests/hooks.test.ts::stop_with_pending` exits code 2.

9. **After M8:** `uv run pytest harness/tests/test_tick_loop.py -v` → all stop conditions fire correctly; doom-loop detection triggers after 3 all-rejected ticks.

10. **After M9:** `uv run pytest harness/tests/test_dashboard.py -v` → green; manual: run dashboard with synthetic fixture, `curl localhost:8756/api/frontier` → returns node JSON.

11. **After M10:** `npm test && uv run pytest harness/tests/ -v` → zero failures across all L2 tests.

12. **After M11 (L3):** `bash scripts/l3-e2e.sh` → all 11 AC assertions print PASS; `decision-log.md` has ≥10 entries; `strategy.json` updated after tick 5 (meta-evolution); dashboard live during training run.

---

## ADR

*Consensus revision — all ADRs populated by Architect/Critic/User-refinement review (2026-07-03).*

---

### ADR-001: Monorepo TS+Python Structure
**Status:** APPROVED

**Context:** The plugin requires TypeScript for the MCP server and hooks (Claude Code plugin surface, spec R18) and Python for the compute harness and FastAPI dashboard (numpy/networkx/pytorch ecosystem). Two separate packages would require separate manifests, separate install steps, and a coordination layer the spec does not envision.

**Decision:** Single monorepo with one `.claude-plugin/plugin.json` manifest. `package.json` at root delegates Python work to `uv run`. `harness/pyproject.toml` governs the Python sub-package. One `npm install && uv sync` installs everything. Mirrors `refs/oh-my-claudecode/.claude-plugin/plugin.json` structure exactly.

**Decision Drivers:**
- Single plugin surface (spec R18) mandates one manifest
- OMC reference confirms viability of mixed-language monorepo under one plugin.json
- One install step reduces deployment friction

**Alternatives considered:**
- Two packages (TS plugin + Python harness as separate PyPI package): rejected — version drift, two manifests, separate CI, no single install step

**Consequences:** Mixed-language CI; npm scripts must delegate Python tasks via `uv run`. Acceptable overhead for v1.

**Follow-ups:** If Python harness grows into a standalone tool, extract to separate package post-v1.

---

### ADR-002: Python Harness Owns Tree Engine (UCB1 in Python; TS as Thin Adapter)
**Status:** APPROVED

**Context:** The UCB1 selection algorithm and tree operations require numerical computation (numpy, graph traversal). Implementing this in TypeScript would lose access to numpy/networkx, introduce numeric instability risk, and mix compute and protocol layers. The alternative (in-process TS) would add no latency but remove all scientific computing libraries.

**Decision:** Python owns `TreeEngine` (UCB1, crossover, meta-evolution, frontier). TypeScript MCP tools `evor_select` and `evor_integrity_check` are thin adapters that spawn `python -m evor.tree <subcmd>` and parse the JSON result. Pattern mirrors `refs/sia/sia/orchestrator.py` calling `evaluate.py` as a subprocess. ~5ms subprocess latency per select call is acceptable at per-tick cadence (each tick spans minutes of training).

**Decision Drivers:**
- numpy/networkx availability in Python for UCB1 math
- Clean separation of compute and protocol layers
- ~5ms latency is negligible vs per-tick training time

**Alternatives considered:**
- TS tree engine: no graph libraries, numeric instability risk, mixes compute and protocol — rejected
- Shared memory / mmap IPC: unnecessary complexity for per-tick frequency — rejected

**Consequences:** `tree.json` is the on-disk source of truth written by Python. TS reads it via `evor_tree_read` (direct file read, no subprocess needed for reads).

**Follow-ups:** If select latency becomes an issue at very high tick frequency, consider the persistent-socket approach (gyoshu_bridge.py pattern) as a v2 optimization.

---

### ADR-003: Custom Content-Hash Store vs DVC vs git-annex
**Status:** APPROVED WITH CONDITIONS

**Context:** Datasets and model checkpoints must not be duplicated across candidates (spec R9 "CoW/hardlink/symlink"). The store must be zero-dependency for local-first v1.

**Decision:** Custom `ContentAddressedStore` with sha256 addressing, `os.link()` hardlinks (same-device), copy fallback (cross-device), and refcount GC (~150 lines). DVC and git-annex both rejected (see below).

**Conditions (required for approval):**
1. Refcount writes must be atomic (`os.replace()` rename-swap, R4) — prevents GC dangling live blobs after crash.
2. Symlink fallback in `link()` MUST increment the blob's refcount identically to the hardlink path. Failure to do so allows GC to dangle a blob that has a live symlink. Implementers may alternatively prohibit the symlink fallback and use copy-only (simpler, correct).

**Decision Drivers:**
- Spec R9 directly names CoW/hardlink/symlink approach
- Zero extra dependencies (DVC = heavy dep; Forge must not pip install per worktree)
- ~150 lines — auditable, testable

**Alternatives considered:**
- DVC: battle-tested, cloud backends — rejected: heavy dep, Forge worktree contamination, intrudes into training code
- git-annex: good large-file tracking — rejected: git dependency conflicts with worktree isolation, binary required, very complex

**Consequences:** No built-in cloud sync (deferred to v2 via optional DVC remote push). GC correctness depends on refcount discipline.

**Follow-ups:** Optional DVC remote push layer post-v1 for cloud artifact storage.

---

### ADR-004: UCB1 as Default Selection Policy
**Status:** CONDITIONAL APPROVAL (conditions met by R1+R2)

**Context:** The selection policy governs which tree nodes are chosen as parents for the next mutation. UCB1 balances exploitation (high-scoring nodes) and exploration (rarely visited nodes) with a single tunable constant C.

**Decision:** UCB1 with C=1.41 (sqrt(2)) as the default `selection_policy` in `strategy.json`. MCTS available via `selection_policy: "mcts"` (post-v1, meta-evolution can switch). Beam available for debugging.

**Conditions for validity (both required):**
1. Metric normalization to [0,1] before applying UCB1 (R1): `normalized_i = clamp((metric_i - baseline) / (target - baseline + 1e-6), 0, 1)`. Without normalization, C=1.41 is not calibrated to the metric scale and the exploration bonus is meaningless.
2. Unvisited-node convention (R2): `visit_count == 0` → score = +∞. Without this, any division-by-zero handling that returns 0 or a small value prevents unvisited nodes from ever being explored first.

**Decision Drivers:**
- O(n) selection — suitable for ≤50 node trees in v1
- Single tunable C; meta-evolvable
- Degrades gracefully to greedy at C=0; maximum exploration at C→∞

**Alternatives considered:**
- MCTS: full lookahead but requires rollout policy; each training run takes minutes — prohibitively expensive for lookahead
- Beam search: deterministic, no backtracking — contradicts spec requirement for branching from non-latest node

**Consequences:** UCB1 can get stuck without diverse proposals — mitigated by H002/H003 diversity enforcement and meta-evolution wildness tuning. After BenchmarkUpgrade, visit counts n_i for nodes scored under v_old are stale relative to the new angle space (UCB1 stationarity assumption is violated); mitigated in v1 by post_upgrade_exploration_boost (R-4), which temporarily raises wildness to compensate. This is a known v1 approximation.

**Follow-ups:** MCTS stub in `tree.py` allows opt-in via strategy.json; meta-evolution can switch policies after sufficient data. **Option 1 — versioned visit counts (v2):** track `versioned_visit_counts: Record<eval_version, number>` on TreeNode so UCB1 uses only counts accumulated under the current eval_version. Eliminates post-upgrade stationarity bias without a wildness boost hack. Deferred to v2 because it requires a TreeNode schema migration and backward-compat read layer.

---

### ADR-005: FastAPI+SSE for Live Dashboard; Static Regen for Report Export
**Status:** APPROVED

**Context:** The spec requires a "live dashboard" (spec R10) that updates during training runs. Two approaches: live SSE streaming server, or static HTML regenerated on a timer.

**Decision:** `harness/evor/dashboard/server.py` — FastAPI app with SSE endpoint `GET /api/telemetry/{mission}/{run}/{node}` that tails `telemetry.jsonl` and streams new records as Server-Sent Events. Mirrors `refs/sia/sia/web/server.py` pattern (SSE + background thread). Static regen is used only for `evor-report` final export (offline artifact).

**Decision Drivers:**
- Spec R10 requires "live telemetry streaming" — static regen cannot satisfy this
- `refs/sia/sia/web/server.py` provides proven reference implementation
- SSE is simpler than WebSockets for one-directional streaming; no client-side polling needed

**Alternatives considered:**
- Static regen with polling: cannot stream live telemetry at sub-second granularity — rejected
- WebSockets: bidirectional protocol unnecessary for read-only telemetry feed — over-engineered

**Consequences:** Requires `uvicorn` background process during runs. Dashboard crash does not propagate to tick loop (daemon thread pattern). `evor-report` static export remains available when no server is running.

**Follow-ups:** Add WebSocket support if bidirectional interaction (user-triggered tree pruning from browser) is needed post-v1.

---

### ADR-006: TS→Python Bridge: Per-Call Subprocess vs Persistent Unix Socket
**Status:** APPROVED AS PER-CALL SUBPROCESS

**Context:** MCP tools that delegate to Python (`evor_select`, `evor_integrity_check`, `evor_schedule`, etc.) need an IPC mechanism. Two options: (a) spawn a fresh Python subprocess per call and parse stdout JSON, or (b) maintain a persistent Unix socket connection (JSON-RPC 2.0) that survives across calls.

**Decision:** Per-call subprocess pattern, as implemented in `refs/sia/sia/orchestrator.py` calling `evaluate.py`. Each MCP tool invocation spawns `python -m evor.<module> <subcmd> --run-id ...` and reads JSON from stdout. This is the correct reference for v1.

**Attribution note:** `refs/oh-my-claudecode/bridge/gyoshu_bridge.py` is the persistent-Unix-socket alternative. It was NOT chosen for v1 because: (a) per-tick cadence makes startup latency (~100ms) negligible, (b) stateless subprocess is crash-safe by default, (c) simpler to debug.

**Decision Drivers:**
- Per-tick call frequency makes 100ms subprocess startup negligible (each tick = minutes of training)
- Stateless: no connection state to manage or recover after crash
- Direct reference: `refs/sia/sia/orchestrator.py` → evaluate.py

**Alternatives considered:**
- Persistent Unix socket (gyoshu_bridge.py): lower per-call latency (~5ms vs ~100ms) — worthwhile only if MCP tools are called hundreds of times per minute; rejected for v1 cadence

**Consequences:** If a future tick design calls `evor_select` hundreds of times per second (e.g., Monte Carlo rollouts), the subprocess approach will bottleneck. Switch to persistent socket at that point.

**Follow-ups:** gyoshu_bridge.py pattern remains documented as the v2 performance upgrade path.

---

### ADR-007: Approach Family Taxonomy (6-Tag ML-Specific vs 8-Tag OMC Taxonomy)
**Status:** APPROVED — superseded in part by ADR-015 (data-acquisition ApproachFamily split; taxonomy is now 7 tags; R-12)

**Context:** OMC's self-improve skill uses an 8-tag taxonomy (`refs/oh-my-claudecode/skills/self-improve/data_contracts.md §6`) designed for general software engineering changes. oh-my-evor operates on ML research artifacts where the relevant dimensions are model architecture, training procedure, data pipeline, augmentation strategy, algorithm choice, and miscellaneous.

**Decision:** 7-tag ML-specific taxonomy (updated by ADR-015 / R-12): `"arch" | "training" | "data-curation" | "data-augmentation" | "data-acquisition" | "algo" | "other"`. Legacy `"augmentation"` tag aliased to `"data-augmentation"` on read. This is the `ApproachFamily` type used in all 27 contracts and the H002/H003 diversity gates.

**Decision Drivers:**
- ML-specific families map directly to the types of mutations Dreamer/Mutagen proposes
- H002/H003 diversity enforcement operates on this taxonomy — it must be expressive enough to detect same-family streaks meaningfully
- Simpler than OMC's 8-tag system; "other" absorbs edge cases

**Alternatives considered:**
- Inherit OMC 8-tag taxonomy: overfits to software engineering (e.g., "docs", "refactor" are irrelevant for ML mutations) — rejected
- Free-form string tags: breaks H002/H003 deterministic comparison — rejected

**Consequences:** Cross-run wiki queries can filter by `approach_family`; meta-evolution `family_mix` weights operate over exactly these 6 keys. If a future evor version handles non-ML tasks, taxonomy extension via ADR amendment.

**Follow-ups:** Consider adding "ensemble" and "inference" families in v2 if model-serving optimizations become common.

---

### ADR-008: Release-Gate Benchmark Selection (CIFAR-10 Subset + Tabular Churn)
**Status:** DECIDED

**Context:** The spec defers exact benchmark selection to the implementation plan. L3 CI must run within a tight time budget and validate the framework-agnostic claim (spec R3: no CUDA/PyTorch assumption in seed-repo mode).

**Decision:** Two benchmarks:
1. `benchmarks/cifar10-subset/` — CIFAR-10, 1000 train / 200 val / 200 test, ResNet-9 baseline, target val_accuracy > 0.72. Fast enough for L3 CI (≤10 min on CPU or single GPU).
2. `benchmarks/tabular-churn/` — UCI churn dataset, XGBoost baseline, target AUC-ROC > 0.82. Validates framework-agnostic claim (no PyTorch required).

**CI cadence (R8):** L1+L2 gate every PR (`.github/workflows/l1-l2.yml`); L3 gates version tags only (`.github/workflows/l3.yml`, triggered by `git tag v*`).

**Decision Drivers:**
- L3 must complete within CI time budget — CIFAR-10 subset satisfies this
- Framework-agnostic validation requires a non-PyTorch benchmark — tabular satisfies this
- Two benchmarks cover image and tabular modalities; future audio/text benchmarks deferred to v2

**Alternatives considered:**
- Full CIFAR-10 (50k samples): too slow for L3 CI without GPU — rejected for default
- Single benchmark: does not validate framework-agnostic claim — rejected

**Consequences:** L3 is not run on PRs (cost). Version-tag gate means L3 runs before every release. `benchmarks/cheat_injector.py` is shared across both benchmarks for Integrity Gate validation.

**Follow-ups:** Add text and audio benchmarks in v2 to expand modality coverage.

---

### ADR-009: Eval Subprocess Isolation (Structural Integrity — Required)
**Status:** DECIDED (elevated from recommended to required, R12)

**Context:** Hash-checks on eval scripts and dataset splits detect static tampering (eval_script_hash, locked_split_hash). However, a compromised or malicious Forge implementation could write false results directly to `nodes/<id>/results.json` or `tree.json` during the evaluation subprocess — bypassing all hash checks. This is the "fabricating results" threat model.

**Decision:** `EvaluatorAdapter.run()` enforces subprocess isolation: (1) reads evaluation result from STDOUT only, mirroring `refs/sia/evaluate.py` output-to-stdout contract; (2) the eval script runs in a subprocess that has no direct write access to the artifact store or tree.json — all writes are mediated through EvaluatorAdapter after result is parsed and validated; (3) on Linux, optional hardening via `unshare --mount` + read-only bind-mount of the worktree root.

**Decision Drivers:**
- Hash-checks alone cannot detect a Forge agent that fabricates results by writing directly to the store during training
- Structural isolation closes this gap at the architecture level
- The sia evaluate.py pattern (stdout-only output) is the established reference

**Alternatives considered:**
- Hash-only verification: insufficient — does not prevent writes during evaluation — rejected as sole defense
- Mandatory `unshare` on all platforms: not portable (macOS lacks unshare) — optional hardening only

**Consequences:** Eval scripts must write all output to stdout (JSON); they may not rely on side-effect file writes being picked up by EvaluatorAdapter. On Linux, `unshare` hardening is available as an opt-in configuration flag.

**Follow-ups:** Investigate sandbox alternatives (seccomp, container-based isolation) for v2 if stronger guarantees are needed.

---

### ADR-010: Probe Self-Authored EDA (Code-Generated per Mission, Thin SDK Only)
**Status:** DECIDED (Part B, user refinement)

**Context:** EDA/error-analysis requirements vary radically by modality, task, and failure mode. Hardcoded analysis pipelines would be correct for some tasks and useless for others (e.g., a brightness-histogram analysis is irrelevant for tabular data; correlation checks are irrelevant for image tasks). The Probe agent needs EDA capabilities that adapt to the node's actual failure mode and registered hypothesis.

**Decision:** Probe (evor-probe) generates and executes bespoke Python analysis scripts per iteration — same code-generation pattern as Forge generating training code. The `harness/evor/eda/` module provides a thin SDK of primitives only (`load_artifact`, `load_telemetry`, `save_finding`, `safe_plot`, `safe_exec`) with no fixed analyses. Probe classifies the data modality, generates analysis scripts targeting data-EDA + output/error-analysis + telemetry-EDA, executes them under resource/timeout limits, and distills findings into the CompoundingWiki.

**Decision Drivers:**
- EDA is inherently modality-specific; hardcoded analyses produce wrong or useless outputs for mismatched modalities
- Code-generation pattern (Forge model) is already established in the architecture — Probe follows the same pattern
- Generated scripts + outputs are preserved at `nodes/<node_id>/eda/` for full reproducibility

**Alternatives considered:**
- Fixed analysis pipeline per modality: requires upfront enumeration of all modality-specific checks; breaks for novel modalities or unusual failure modes — rejected
- No EDA (Probe only reads telemetry curves): insufficient — misses data-quality issues, output clustering, and modality-specific pathologies — rejected

**Consequences:** Probe EDA scripts are subject to the same sandbox/safe_exec resource limits as any other generated code. Findings become citations in subsequent MutationProposals, closing the analysis→hypothesis→mutation loop. New store path: `nodes/<node_id>/eda/`.

**Follow-ups:** Consider a curated library of EDA script templates that Probe can select from and customize (reduces generation burden while preserving flexibility).

---

### ADR-011: Mutation Genome Representation — Modular Seams + Extensible Genome vs Alternatives
**Status:** DECIDED (Addendum v2 Pillar 1)

**Context:** The original plan stored candidate code as a monolithic worktree with no internal structure. This prevented clean crossover (no shared schema between parents), made provenance tracking expensive (no diff — full code copy per node), and made the "what changed" from parent to child opaque. Three approaches were evaluated.

**Decision:** Modular seam structure (`genome.yaml` + `data/` + `model/` + `train/` + locked `evaluate.py`) as the canonical candidate representation. Two mutation tiers: (1) **parametric** — config-level changes to `genome.yaml` genes (backbone, optimizer, LR, augmentation set); cheap, composable, crossover-friendly. (2) **structural** — code-level changes writing new module code AND extending `GenomeConfig.extra` + `schema_extensions[]` to expose the new knob. Mutations stored as `git format-patch` diffs vs parent + resulting `genome.yaml` snapshot; not full code copies. For seed-repo mode, a genome adapter is fitted over existing seams without forcing a rewrite.

**Decision Drivers:**
1. Clean crossover requires a shared schema: `merge_genomes(a.genome, b.genome, loci)` is only possible because both parents have a common `GenomeConfig` structure.
2. Search space growth via structural mutations: when Forge writes a novel module and extends the genome schema, that extension becomes a future parametric knob — the search space grows as breakthroughs are discovered.
3. Provenance: `parent.patch` (diff) + `genome.yaml` snapshot gives full lineage audit at minimal storage cost (~KB vs ~GB for full code copy).

**Alternatives considered:**
- **Whole-file rewrite per node (monolith):** no shared schema between nodes → crossover impossible; full code copy per node → storage O(N × codebase_size); provenance opaque — rejected.
- **Fixed-schema config only (no structural tier):** eliminates the "structural mutation extends genome" mechanism → cannot discover new module types; search space is bounded at init time → contradicts the "break the boundary" goal — rejected. Structural tier is the mechanism that makes the genome open.

**Consequences:** Forge must implement and maintain `genome.py::merge_genomes()`. Crossover is only valid when both parents share compatible `schema_extensions[]`; structural-crossover requires explicit confidence downgrade. Seed-repo mode requires audit-first rather than assuming canonical structure. `genome-schema-registry.json` (R-5) is now **required** on the structural-mutation path: every structural mutation must register its new extension in the manifest, which is validated by `genome.py::validate_schema_extensions()` before the mutation is accepted. This makes the genome schema self-documenting and prevents unnamed extensions from silently accumulating across generations.

**Follow-ups:** Define a formal `GenomeConfig` version field and migration contract for when schema_extensions become stable enough to promote to first-class genome fields.

---

### ADR-012: Benchmark Versioning — Superset eval_version + Consent-Gated Upgrade vs In-Place Edit
**Status:** DECIDED (Addendum v2 Pillar 3)

**Context:** The spec forbids "goalpost shift" (silent benchmark changes). However, hardening the test — adding more domains, tougher slices — is a legitimate and desirable operation for open-ended missions. Two approaches: mutate the benchmark in place (update the same EvalSuite), or create a new versioned snapshot on every change (superset semantics).

**Decision:** Every benchmark change creates a **new `EvalSuite` version** (`eval_version` bumped; e.g., v1 → v2). New version is a **strict superset** of the old: `v_{n+1} ⊇ v_n` — domains only added, never removed. Old nodes retain their v1 scores; re-scoring under v2 is performed incrementally (new domains only, not full re-evaluation). The `BenchmarkUpgrade` governance record is **consent-gated**: Forge/Mutagen cannot initiate an upgrade; Probe/Sage may propose one with citations; user or pre-authorized `ExpansionPolicy` provides consent before the upgrade is applied. The `decision-log.md` records every upgrade with proposer, citation, and consent type.

**Decision Drivers:**
1. "No silent goalpost-moving": an in-place edit would invalidate historical node comparisons without any audit trail — rejected as integrity violation.
2. Superset invariant makes cross-version comparison safe: old scores are always valid lower bounds on the new version; re-scoring fills in the delta.
3. Consent gate: Forge/Mutagen cannot self-harden the test to make their own proposals look better — structural separation enforced at the governance level.

**Alternatives considered:**
- **In-place edit (mutate EvalSuite v1):** simpler to implement; but invalidates all historical comparisons silently, breaks `eval_version` integrity, and allows agents to inadvertently or deliberately shift the goalposts — rejected.
- **Separate immutable benchmarks (no version relationship):** no superset guarantee; cross-version comparison is entirely prohibited; makes the "build on existing knowledge" pattern impossible — rejected.

**Consequences:** `eval_version` field is mandatory on every `TreeNode`, `EvaluationResult`, and `IntegrityReport`. Cross-version comparison is gate-blocked in `IntegrityGate.check()` (eval_version_consistent check). Re-score compute cost is bounded by incremental domain evaluation (see Open Design Risk D). `benchmark.py` must enforce the superset invariant on every `apply_upgrade()` call. The `BenchmarkRescore` merge protocol (R-6) formalises incremental re-scoring: partial `--eval-domains {new}` result is merged with cached v_old per_domain to produce a complete v_new EvaluationResult; fitness is recomputed by `TreeEngine.compute_fitness()` on the merged result, never by the eval script. `BenchmarkUpgrade.rescore_deadline_ticks` (R-2) enforces a hard demote deadline for nodes that cannot be re-scored in time. **Creation path (Q4):** `BenchmarkUpgrade` records are created ONLY by `benchmark.py::apply_upgrade()`; agents (Sage/Probe) submit a `BenchmarkUpgradeProposal`; `apply_upgrade()` validates and consent-gates before materialising the record. `domains_removed` is a defensive invariant: `apply_upgrade()` asserts `len(domains_removed) == 0`; no code path ever populates it; it exists only to trip on a malformed/hand-authored record. **SOTA regression (Q3):** during living-loop SotaSource re-fetch, if a newly fetched bar is lower than the committed bar, `angle_registry.py::flag_sota_regression()` emits a human-review milestone-ping; the monotonic write-lock (R-8) prevents any auto-lowering of the committed bar. **Upgrade frequency cap (Risk D-2):** `ExpansionPolicy.max_upgrades_per_N_ticks` (default `{max_upgrades: 1, per_ticks: 5}`) caps BenchmarkUpgrade frequency in Step 9.5; a pending proposal is deferred rather than applied when the cap is exceeded.

**Follow-ups:** Define `--eval-domains` partial evaluation flag in eval_script interface (Open Design Risk D mitigation; required for BenchmarkRescore protocol). Investigate snapshot storage cost for large eval suites with many versions.

---

### ADR-013: Open-Ended Fitness — Worst-Angle Coverage vs Average; Monotonic Ratchet as "No-Shift" Redefinition
**Status:** DECIDED (Addendum v2 Pillar 4)

**Context:** For open-ended / generality missions, "no shift" in the base spec means the evaluation set does not change. But for a goal like "become general/world model," a single frozen test is Goodhart-susceptible: the model can overfit the static target. The fitness function must be chosen to resist this.

**Decision:** Two decisions together:
1. **Fitness mode = worst-angle coverage** for open_ended missions: `fitness_value = worst_angle_coverage = fraction of angles ≥ their SOTA bar`, with secondary metric `min(per_domain_scores)` (worst-domain). A model is only "general" when it simultaneously beats SOTA across all registered angles — not just on average. Average fitness would allow a model to specialise on easy angles while regressing on hard ones.
2. **Monotonic ratchet redefines "no shift":** for open_ended missions, "no shift" becomes "only ever harder" — new angles may only be added (never removed), and existing angle SOTA bars only increase. This is not goalpost-shift; it is the operational definition of "true generality" — the yardstick keeps pace with both the model's discovered weaknesses and the published SOTA as the field advances.

**Decision Drivers:**
1. Average fitness is Goodhart-vulnerable: a model specializing on 14/15 angles at 99% and failing 1/15 at 10% looks general by average (≈93%) but is not. Worst-angle coverage catches this.
2. Monotonic ratchet makes the benchmark harder, not easier, over time — this is the opposite of goalpost shift (which moves the bar to be easier to clear).
3. `CoverageTarget` gives a principled stopping criterion for open_ended missions: "≥SOTA on ≥95% of angles" is falsifiable and budget-bounded.

**Alternatives considered:**
- **Average metric across angles:** Goodhart-vulnerable; a model can improve average by abandoning weak angles — rejected as primary fitness for open_ended.
- **Fixed test + no expansion (treat open_ended as fixed):** prevents discovery of genuinely missing capabilities; the model appears general but has never been tested on angles the user simply forgot to include — rejected.
- **Weighted average (configurable per domain):** valid secondary mode (`fitness_mode="weighted"` in GoalContract); not the default for generality missions because the weights themselves become a source of gaming.

**Consequences:** `compute_fitness()` in `tree.py` must implement `worst_angle_coverage` as the primary fitness for open_ended missions. EvaluatorAdapter must produce `per_angle_vs_sota` for every evaluation (requires AngleRegistry to be loaded at eval time). Expansion re-scores + demotes nodes that previously looked best — this is correct and expected behaviour. `AngleRegistry.angles[].baseline_model_score_before_finetune` (R-1/R-13) is **required** for every angle with contamination risk != "low": it is populated by evaluating the seed/foundation model checkpoint on the angle's held-out split in `benchmark.py::apply_upgrade()`. The effective SOTA bar is `max(sota_bar, baseline_model_score_before_finetune)` (R-9), ensuring the model must beat what the foundation model already knows, not just published SOTA. UCB1 stationarity is violated after BenchmarkUpgrade (visit counts are stale); mitigated by `post_upgrade_exploration_boost` in StrategyState (R-4) as a v1 approximation; see ADR-004 follow-ups for v2 remedy.

**Follow-ups:** Consider a `min_coverage_per_angle` floor (e.g., no angle may score below 50% of SOTA) as an additional hard gate, separate from the optimization objective. Define plateau detection for worst-angle coverage.

---

### ADR-014: mission_type Dispatch — Fixed vs Open-Ended Regime Separation
**Status:** DECIDED (Addendum v2 Pillar 4)

**Context:** The base spec assumes a single regime: fixed frozen test, single GoalContract, single EvalSuite. Pillar 4 introduces a qualitatively different regime (open_ended) that requires different stop conditions, different fitness computation, a living loop, BenchmarkUpgrade governance, AngleRegistry, and ExpansionPolicy. These two regimes cannot share a single code path cleanly.

**Decision:** `GoalContract.mission_type: "fixed" | "open_ended"` is the top-level dispatch field. Fixed regime: all base-plan behaviour unchanged (frozen test, single eval_version, no BenchmarkUpgrade). Open-ended regime: activates AngleRegistry, ExpansionPolicy, worst_angle_coverage fitness, living loop, BenchmarkUpgrade Step 9.5, and `coverage_target` stop condition. The dispatch happens in:
- `evor-setup/SKILL.md`: 3 additional interview questions for open_ended; ExpansionPolicy captured at setup
- `skills/evor/SKILL.md`: Step 9 additional stop conditions; Step 9.5 BenchmarkUpgrade gate (no-op for fixed)
- `tree.py::compute_fitness()`: routes to worst_angle_coverage if open_ended, aggregate/worst-domain/weighted if fixed
- `evaluator.py::run()`: calls `score_angles()` only if open_ended
- `dashboard`: coverage panel shown only if open_ended; 404 otherwise
- `integrity.py::check()`: eval_version_consistent check is active for both; near_dup and provenance checks active for both

**Decision Drivers:**
1. The two regimes are behaviorally different enough that mixing them into one code path would require O(N) conditional checks dispersed across the codebase — clean dispatch at the mission level is safer.
2. The GoalContract is the single source of truth for mission configuration; `mission_type` belongs there rather than as a runtime flag.
3. Fixed missions must remain completely unaffected by Pillar 4 complexity — adding open_ended must not regress fixed-mission behaviour.

**Alternatives considered:**
- **Single regime with no mission_type:** treat all missions as open_ended with zero initial angles; fixed missions are open_ended with expansion disabled. Cleaner schema but requires all Pillar 4 infrastructure to be initialized even for fixed missions — unnecessary overhead and risk of accidental open_ended behaviour — rejected.
- **Separate plugin skill per regime:** `evor-fixed` vs `evor-open` skills; avoids if/else in shared code. But GoalContract would be different schemas — breaks the unified tree and record infrastructure — rejected.

**Consequences:** Every component that behaves differently between regimes must explicitly check `goal.mission_type`. The `evor-setup` interview must clearly surface the distinction to the user. `evor-run` resumes correctly for both regimes (run-state.json persists mission_type via GoalContract ref). `EvaluatorAdapter.run()` calls `AngleRegistry.score_angles()` only when `goal.mission_type == "open_ended"` (R-11); for fixed missions per_angle_vs_sota and worst_angle_coverage remain null — this prevents unnecessary AngleRegistry load and avoids false "no angles registered" warnings on fixed missions.

**Follow-ups:** Consider a `mission_type: "hybrid"` for missions that start fixed and may be promoted to open_ended after a saturation milestone. Define upgrade path from fixed → open_ended at runtime.

---

### ADR-015: Data Acquisition as a Gated Mutation (data-acquisition ApproachFamily)
**Status:** DECIDED (Addendum v2 data-acquisition extension)

**Context:** Sourcing new external datasets or generating synthetic data is a high-impact ML improvement lever ("send Researcher to find more training data so the model improves"). The original taxonomy (`data-curation`, `augmentation`) covered only transforms of existing data. Any agent (Sage, Mutagen, Forge) may originate an acquisition idea, but external/synthetic data is the #1 contamination vector — acquired data that overlaps the eval splits would defeat the entire integrity framework. Two governance questions: (1) should acquisition be allowed at all as a mutation? (2) if so, what gate is sufficient?

**Decision:** Data acquisition is a **legitimate first-class mutation** (`approach_family: "data-acquisition"`), flowing through the same Hypothesis→Critic→Forge→eval pipeline as any other mutation. A mandatory **Ingestion Contamination Gate** (IntegrityGate checks 11–13) runs **before training** for every data-acquisition node:
1. Contamination scan vs ALL frozen eval splits across ALL eval_versions (index + content-hash + near-dup); samples overlapping eval are quarantined; >5% quarantine fraction → reject entire acquisition.
2. AcquisitionProvenance required with license + citation (external) or generator_config + citation (synthetic); unlicensed → reject.
3. DataStore namespace enforcement: `register_acquired(..., namespace="eval")` raises ValueError at the structural layer; all acquired samples must land in the train namespace only.

**Two-path rule (enforced in M8 Step 4 and DataStore):**
- Acquired data targeting **TRAIN** → `data-acquisition` mutation (this ADR's path).
- Acquired data targeting **EVAL/TEST** (new benchmark angle) → `BenchmarkUpgrade` (Step 9.5, consent-gated). These paths are structurally separated: DataStore refuses eval-namespace writes from the mutation path; BenchmarkUpgrade refuses train-namespace writes.

The `ApproachFamily` type is split: `"data-curation"` (clean/reweight/filter existing) + `"data-augmentation"` (transform existing, formerly `"augmentation"`) + `"data-acquisition"` (new external or synthetic). Legacy `"augmentation"` tag aliased to `"data-augmentation"` on read.

**Decision Drivers:**
1. High-impact mutation class: finding a complementary public dataset or generating targeted synthetic samples for weak domains is a legitimate and powerful research move — forbidding it would cripple open-ended missions.
2. Contamination is the dominant risk: without the Ingestion Contamination Gate, an agent could trivially train on eval data by disguising it as a "new training dataset." The gate must scan all eval_versions (not just current) to prevent the "use the old v1 eval as training data" attack.
3. Citation mandate consistency: all acquisition requires a citable source, consistent with the "citation-backed" principle (RALPLAN-DR Principle 1).
4. Structural enforcement over policy: DataStore.register_acquired() raises ValueError for eval namespace — this cannot be bypassed by an agent that merely forgets to check; it requires an explicit architectural override.

**Alternatives considered:**
- **Forbid external/synthetic data entirely:** eliminates the contamination risk at the cost of cutting off a major improvement lever — especially damaging for open_ended missions targeting new angles where training data for that angle may be scarce — rejected.
- **Allow acquisition ungated (no Ingestion Contamination Gate):** maximally flexible but makes the eval framework trivially gameable — rejected. Even a well-intentioned Forge could inadvertently pull a public benchmark as training data.
- **Require BenchmarkUpgrade consent for all acquired data (not just eval):** safe but conflates two orthogonal operations; adding train data is a mutation and should scale without per-acquisition human consent — rejected. Gate on contamination + provenance, not on approval.

**Consequences:** `ApproachFamily` has 7 values (was 6); H002/H003 diversity gates treat `data-augmentation` and `data-curation` and `data-acquisition` as distinct families (no streak merging). `IntegrityGate.check()` now has 13 checks (10 base + 3 conditional acquisition checks, `null` for non-acquisition nodes). `ContentAddressedStore` gains `register_acquired()` and `verify_namespace()`. `GenomeConfig.acquired_datasets[]` tracks acquisition_ids. Ingestion Contamination Gate adds one extra eval pass before training for acquisition nodes (cost: one contamination-scan pass, not a full training run). `AcquisitionProvenance.license_verified: boolean` is **replaced** by `license_identifier: string` + `license_in_allowlist: boolean` (R-3): the boolean was not auditable; the SPDX identifier makes the license explicitly traceable and the allowlist check (`GoalContract.allowed_licenses`) is machine-verifiable. IntegrityGate check-12 condition is `license_identifier != "" AND license_in_allowlist == True AND citation != ""`. The default allowlist is `["MIT","Apache-2.0","BSD-2-Clause","BSD-3-Clause","CC-BY-4.0","CC0-1.0"]`; users may extend it at setup (Q12 in evor-setup interview).

**Follow-ups:** Define `license_override` mechanism in GoalContract for organizational datasets with non-standard licenses. Consider an acquisition quota per tick in StrategyState to prevent acquisition-only runs that skip model architecture exploration.

---

## Changelog (consensus revision — 2026-07-03)

Applied during Architect/Critic/User consensus review. All changes are surgical edits to the plan artifact; no source code was written.

### Addendum v2 pass (second consensus pass — 2026-07-03)

Four-pillar extension integrating mutation genome representation, dataset freeze + augmentation gating, benchmark evolution + per-domain metrics, and open-ended / generality missions. All edits are plan-artifact only; no source code written.

| # | Change | Source | Milestone |
|---|--------|--------|-----------|
| V2-01 | Spec source line updated to reference addendum-v2.md alongside base spec | Planner | Header |
| V2-02 | GoalContract: +mission_type, +metric_specs[], +fitness_mode, +eval_version, +coverage_target, +expansion_policy; metrics[] retained for back-compat | Addendum v2 P3+P4 | M1, Data Contracts |
| V2-03 | TreeNode: +parent_patch_ref, +genome_ref, +mutation_tier, +mutation_locus, +eval_version, +fitness_value; ApproachFamily→locus mapping documented | Addendum v2 P1 | M1, Data Contracts |
| V2-04 | EvaluationResult: +eval_version, +per_domain, +fitness_value, +worst_angle_coverage, +per_angle_vs_sota | Addendum v2 P3+P4 | M1, M6 |
| V2-05 | IntegrityReport: +eval_version, +frozen_split_read_only, +near_dup_leakage, +data_provenance_valid, +eval_version_consistent; check() expands to 10 checks | Addendum v2 P2+P3 | M1, M6 |
| V2-06 | 13 new schema entities added: GenomeConfig, MutationLocus, FrozenSplit, DataProvenance, EvalSuite, Domain, MetricSpec, MetricRegistry, BenchmarkUpgrade, ExpansionPolicy, SotaSource, AngleRegistry, CoverageTarget | Addendum v2 P1–P4 | M1 |
| V2-07 | Repository layout: +genome.py, +freeze.py, +benchmark.py, +angle_registry.py to harness/evor/; candidate worktree genome seam structure documented; runtime state adds eval-suites/, frozen-splits/, angle-registry.json, per-node genome.yaml + parent.patch + data-provenance.jsonl | Addendum v2 P1–P4 | M0 layout |
| V2-08 | M1 goal updated from "11 schemas" to "24 schemas"; RunStore ensureRunDirs() adds eval-suites/ + frozen-splits/; M1 schema tests extended for 13 new types | Addendum v2 P1–P4 | M1 |
| V2-09 | M3 Forge mandate: genome materialization (modular seams, parametric/structural tiers, merge_genomes crossover, seed-repo genome adapter, parent.patch diff storage); Forge never touches evaluate.py or frozen-split paths | Addendum v2 P1 | M3 |
| V2-10 | M3 evor-setup: 3 new interview questions (mission_type, ExpansionPolicy, CoverageTarget); freeze_splits() at setup; EvalSuite v1 creation | Addendum v2 P4+P2+P3 | M3 |
| V2-11 | M4: FrozenSplitManager + DataProvenanceTracker added to harness/evor/freeze.py; 6 new tests in test_freeze.py | Addendum v2 P2 | M4 |
| V2-12 | M4: genome.py, benchmark.py, angle_registry.py documented as new M4 deliverables | Addendum v2 P1+P3+P4 | M4 |
| V2-13 | M5 propose_crossover(): genome-aware merge via merge_genomes; mutation_tier set by schema compatibility; cross-version crossover refused + logged; 3 new tests | Addendum v2 P1 | M5 |
| V2-14 | M5 compute_fitness(): aggregate/worst-domain/weighted/worst_angle_coverage modes; best_frontier() version consistency; 3 new fitness tests | Addendum v2 P3+P4 | M5 |
| V2-15 | M6 IntegrityGate.check() signature + 4 new checks (frozen_split_read_only, near_dup_leakage, data_provenance_valid, eval_version_consistent); 4 new seeded-failure tests | Addendum v2 P2+P3 | M6 |
| V2-16 | M6 EvaluatorAdapter per-domain emission contract; eval_version env injection; fitness post-parse; open_ended angle scoring; 4 new evaluator tests | Addendum v2 P3+P4 | M6 |
| V2-17 | M8 Step 4: genome materialization mandate; DataProvenanceTracker.record() for data mutations | Addendum v2 P1+P2 | M8 |
| V2-18 | M8 Step 9: 2 new open_ended stop conditions; coverage milestone pings | Addendum v2 P4 | M8 |
| V2-19 | M8 Step 9.5 added: BenchmarkUpgrade governance flow (consent gate, superset creation, incremental re-score, frontier demotion, decision-log); living loop for cron/scheduled open_ended missions | Addendum v2 P3+P4 | M8 |
| V2-20 | M9: 5 new API endpoints (eval-versions, per-domain, domain-pivot, coverage, angle-registry); domain leaderboard, coverage gauge, benchmark timeline UI panels; 7 new dashboard tests | Addendum v2 P3+P4 | M9 |
| V2-21 | AC-12 through AC-17 added (6 new acceptance criteria from addendum §Acceptance Criteria (added)); mapped to L2+L3 gates with specific test references | Addendum v2 | AC section |
| V2-22 | "Addendum v2 — Milestone Deltas" summary table added | Planner | New section |
| V2-23 | "Addendum v2 — Open Design Risks" section added: 4 risks (SOTA sourcing trust, pretraining contamination, stale eval_version in crossover, BenchmarkUpgrade compute cost) with proposed mitigations and open decisions for Architect/Critic | Planner | New section |
| V2-24 | ADR-011 (mutation genome: modular seams vs monolith vs fixed-config); ADR-012 (benchmark versioning: superset eval_version vs in-place edit); ADR-013 (open-ended fitness: worst-angle coverage vs average; monotonic ratchet); ADR-014 (mission_type dispatch: fixed vs open_ended) | Addendum v2 P1–P4 | ADR section |
| V2-25 | data-acquisition sub-type: ApproachFamily split from 6 to 7 values (`data-curation`, `data-augmentation`, `data-acquisition`); legacy `augmentation` aliased; AcquisitionProvenance schema added; GenomeConfig.acquired_datasets[] added; MutationLocus extended with data-acquisition variant; IntegrityReport gains 3 nullable acquisition checks (checks 10→13 conditional); Ingestion Contamination Gate (checks 11–13) added to IntegrityGate with cross-version eval scan; DataStore.register_acquired()+verify_namespace() structural namespace enforcement; M8 Step 4 two-path rule wired; AC-18 added; ADR-015 added; Milestone Deltas rows added for ACQ | Coordinator delta (data-acquisition) | M1,M4,M6,M8,AC,ADR |

---

### Base plan consensus changelog (original pass)

| # | Change | Source |
|---|--------|--------|
| R1 | [M5] UCB1 metric normalized to [0,1] before applying UCB1 formula; `normalized_i = clamp((metric_i - baseline) / (target - baseline + 1e-6), 0, 1)`; min/max fallback when target_value absent; C=1.41 now valid; documented as correctness contract in `tree.py` | Architect |
| R2 | [M5 + M5 tests] Unvisited-node convention: `visit_count == 0` → score = +∞ (always ranks first); formula applied only when n_i > 0; added `test_select_unvisited` and `test_ucb1_normalization` tests | Architect |
| R3 | [M5 + M3] H002 threshold reconciled to ≥3 consecutive family wins everywhere; M5 diversity enforcement changed from "2" to "3" to match MutationProposal schema comment and evor-selector.md | Selector (Critic) |
| R4 | [M4] `ContentAddressedStore.put()` now uses atomic refcount writes (`os.replace()` rename-swap, mirrors tree.json pattern); `link()` symlink fallback documented to require refcount increment; `test_refcount_crash_safety` and `test_symlink_refcount` added to test_store.py | Architect |
| R5 | [M6] `no_label_contamination` check replaced: label-value comparison (no-op for classification) replaced with index-level + sha256(sample) content-hash comparison over 100 pairs | Critic |
| R6 | [M6] `telemetry_sane` grad_norm check made conditional on field presence; skip for XGBoost/scikit-learn/tabular candidates; prevents tabular L3 benchmark from failing systematically | Critic |
| R7 | [M7 + ADR-006] Bridge attribution corrected: reference changed from `refs/oh-my-claudecode/bridge/gyoshu_bridge.py` to `refs/sia/sia/orchestrator.py` (evaluate.py subprocess pattern); gyoshu_bridge.py documented as the persistent-socket alternative NOT chosen for v1 | Architect |
| R8 | [M11] L3 CI cadence specified: L3 gates version tags only (`git tag v*`); L1+L2 gate PRs; `.github/workflows/l1-l2.yml` and `.github/workflows/l3.yml` added to M11 files-to-create | User-refinement |
| R9 | [M6] `harness/evor/__main__.py` with `run` subcommand specified; Forge's primary invocation point; wires EvaluatorAdapter + SelfHealMonitor + ResourceScheduler + TelemetryCallback injection; `preflight` subcommand also registered | Critic |
| R10 | [M6 + M7 + M8] IntegrityReport path standardized to `evaluations/<node-id>.json` everywhere; M8 Step 5 read path corrected from `nodes/<id>/evaluation.json`; `evor_integrity_check` MCP signature updated with explicit write path; `evor_record_eval` M7 description updated | Critic |
| R11 | [M7] PostToolUse "check 2" (stdout TelemetryRecord regex scan) removed as dead code; replaced with: primary path = TelemetryCallback direct file write + explicit `evor_telemetry_ingest`; hook validates telemetry.jsonl existence post-write only; M7 and M10 hooks.test.ts descriptions updated | Architect |
| R12 | [M6] EvaluatorAdapter subprocess isolation elevated to required: reads result from STDOUT only (refs/sia/evaluate.py contract); eval script cannot write to artifact store or tree.json during evaluation; Linux `unshare --mount` hardening noted as optional; closes fabricated-result integrity gap | Architect (elevated from recommended) |
| B | [M6 + M8] Probe Self-Authored EDA Contract added: thin SDK at `harness/evor/eda/` with primitives only; Probe generates and executes bespoke per-iteration analysis scripts; `ProbeEDAContract` entity added; `nodes/<node_id>/eda/` store path; M8 Step 6 updated; L3 acceptance criterion for EDA reproducibility added | User-refinement |
| C | ADR-001 through ADR-008 populated with Decision/Drivers/Alternatives/Why-chosen/Consequences/Follow-ups; ADR-009 (eval subprocess isolation) and ADR-010 (Probe self-authored EDA) added as new required decisions | Architect/Critic/User-refinement |
| D-1 | [M10] `harness/tests/test_tick_loop.py` given explicit home in M10 files-to-create section (was referenced in AC-11 but had no creation milestone) | Critic |
| D-2 | [M3 + M8] `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` fallback documented in both coordination references: "if unavailable, fall back to sequential candidate execution (concurrency=1)" | Critic |

---

## Changelog (consensus pass 2 — 2026-07-03)

Applied during second Architect/Critic consensus review. All changes are surgical schema/spec edits to the plan artifact only; no source code written. Status "pending approval" maintained.

| # | Change | Source | Milestone |
|---|--------|--------|-----------|
| R-1 | AngleRegistry.angles[]: removed singular `sota_source_id`; added `sota_source_ids: string[]`, `sota_quorum_met: boolean`, `baseline_model_score_before_finetune: number\|null` | Architect | M1 schema, M4 angle_registry.py |
| R-2 | BenchmarkUpgrade: added `rescore_deadline_ticks: number`; M8 Step 8 prune guard wired with deadline enforcement — nodes demoted to "v{old}-only" when deadline expires | Architect | M1 schema, M8 Step 8 |
| R-3 | AcquisitionProvenance: replaced `license_verified: boolean` with `license_identifier: string` + `license_in_allowlist: boolean`; added `GoalContract.allowed_licenses: string[]` (default 6-entry allowlist); added evor-setup Q12 for allowlist; updated IntegrityGate check-12 condition; ADR-015 consequences updated | Critic | M1 schema, GoalContract, M3 setup, M6 check-12 |
| R-4 | StrategyState: added `post_upgrade_exploration_boost: number\|null` + `post_upgrade_exploration_ticks: number`; stale-n_i documented as known v1 approximation in meta_evolve() + ADR-004 follow-ups; Option 1 (versioned visit counts) added to ADR-004 follow-ups for v2; M8 Step 9.5 wires boost after BenchmarkUpgrade | Architect | M1 schema, M5 meta_evolve, M8 Step 9.5, ADR-004 |
| R-5 | `genome-schema-registry.json` manifest added to repo layout and harness/evor/; `genome.py::validate_schema_extensions()` specified and called on structural-mutation path; ADR-011 consequences updated to note registry is now required | Architect | M4 genome.py, repo layout, ADR-011 |
| R-6 | BenchmarkRescore merge protocol specified: partial `--eval-domains {new}` result merged with cached v_old per_domain → complete v_new EvaluationResult; fitness recomputed by TreeEngine.compute_fitness() post-merge; `EvaluatorAdapter.run(..., rescore_context: BenchmarkRescore \| None = None)` added; `BenchmarkRescore` added as 25th schema entity; AC-16 updated; ADR-012 consequences updated | Architect | M6 evaluator.py, M11 AC-16, ADR-012 |
| R-7 | integrity.py (CRITICAL): (a) short-circuit checks 2–3 on check-1 (split_hash) failure — partial IntegrityReport returned, checks 4–10 still run; (b) check-8 near-dup condition canonicalized to `mutation_locus.family not in ("data-augmentation","augmentation")`; alias-resolution helper `_canonicalize_family()` added at module scope before all conditionals | Architect | M6 integrity.py |
| R-8 | Auto-retrieved SOTA bars default to `trust_level="indicative"`; `authoritative` requires `retrieval_method="human_provided"` OR `sota_quorum_met=True` (≥2 sources, divergence ≤5%); only authoritative bars count toward coverage/beat-SOTA stop conditions; monotonic write-lock in `angle_registry.py::update_angle()` (new_bar ≥ existing_bar); compute_fitness() updated | Architect | M4 angle_registry.py, M5 compute_fitness |
| R-9 | Risk B mitigated: `ExpansionPolicy.pretraining_canary_threshold_pp: float = 5.0`; ABSOLUTE 5pp residual (sota_bar − baseline < 5pp) triggers high-contamination flag; `effective_bar = max(sota_bar, baseline_model_score_before_finetune)` in score_angles() and compute_fitness() | Critic | M1 ExpansionPolicy, M4 angle_registry.py |
| R-10 | `test_near_dup_leakage` fixture annotated to use canonical `"data-augmentation"` family name (not legacy `"augmentation"`) — guards alias-resolution helper correctness (C-1) | Critic | M6 test_integrity.py |
| R-11 | `score_angles(result, registry, eval_version) -> tuple[dict[str, AngleVsSOTA], float]` specified in angle_registry.py; absent angles = unscored not failing; `goal.mission_type == "open_ended"` conditional added to EvaluatorAdapter.run() spec; `AngleVsSOTA` added as 26th schema entity; ADR-014 consequences updated | Architect | M4 angle_registry.py, M6 evaluator.py, ADR-014 |
| R-12 | `contracts.py` ApproachFamily Literal updated to 7-tag taxonomy `["arch","training","data-curation","data-augmentation","data-acquisition","algo","other"]`; schema count corrected to 26; ADR-007 status updated "superseded in part by ADR-015"; ADR-007 body updated | Critic | M1, ADR-007 |
| R-13 | Baseline timing in `benchmark.py::apply_upgrade()`: for angles with contamination_risk != "low", seed/foundation model checkpoint is evaluated on new angle's held-out split; result stored as `baseline_model_score_before_finetune`; from-scratch mode uses random-init; seed checkpoint hash stored at setup for re-evaluation; ADR-013 consequences updated | Architect | M4 benchmark.py, M6 evaluator.py, ADR-013 |
| R-14 | M8 Step 8 prune gate: before TreeEngine.prune(), skip GC for nodes with eval_version != current OR on frontier if any upgrade rescore_status in ("pending","in_progress"); `skip_hashes` passed to prune(); rescore_deadline_ticks expiry demotes stale nodes to "v{old}-only" | Architect | M8 Step 8 |
| R-15 | AC-15 "without hardcoding" replaced with mechanical assertion: EDA script at `nodes/<id>/eda/analysis_*.py` exists, imports from `evor.eda`, references ≥1 domain_id loaded from EvalSuite.domains at runtime; l3-e2e.sh step 18 updated | Critic | M11 l3-e2e.sh, AC-15 |
| R-16 | evor-setup/SKILL.md Q13 (open_ended only): compute-budget-horizon confirmation added before consent checkpoint — estimates ticks-to-coverage-target + total cost/GPU-hours from preflight ResourcePlan; requires explicit user confirmation | Architect | M3 evor-setup/SKILL.md |
| MF-1 | Schema count corrected: "11→24" → "11→26" throughout (BenchmarkRescore + AngleVsSOTA added as schemas 25 and 26) | Planner | M1, Addendum v2 header |
| MF-2 | `BenchmarkUpgrade.domains_removed` MUST-be-empty assertion added to `benchmark.py::apply_upgrade()` spec (IntegrityError if non-empty) | Critic | M4 benchmark.py |
| MF-3 | Tick-1 warning added to `angle_registry.py::add_angle()`: if open_ended mission has 0 angles registered after tick 1, emit EVOR WARNING | Critic | M4 angle_registry.py |
| MF-4 | `benchmark.py` + `angle_registry.py` class/method skeletons added to M4 (were referenced in Addendum v2 delta table but had no implementation target in M4 body) | Critic | M4 |
| MF-5 | l3-e2e.sh steps 15–21 added for L3 assertions covering AC-12 through AC-18 (were listed in AC table but absent from l3-e2e.sh script) | Critic | M11 l3-e2e.sh |

---

## Changelog (open-questions resolution)

Applied after second Architect/Critic pass to resolve all open design decisions. Plan artifact edits only; no source code written. Status "pending approval" maintained.

| # | Resolution | Affected sections |
|---|-----------|-------------------|
| Q1 | `StrategyState.rescore_mode: "sync" \| "async"` (default "sync") added as the SINGLE source of truth for BenchmarkUpgrade re-score mode. `benchmark.py::apply_upgrade()` and M8 Step 9.5 both read from this field. No separate `rescore_synchronous` parameter added anywhere. | StrategyState schema, M4 apply_upgrade() docstring, M8 Step 9.5 re-score block |
| Q2 | `GenomeSeedAdapterReport` added as schema 27 (fields: seed_repo_path, detected_seams[{kind, file, symbol}], genome_mapping, unmapped_regions[], created_at). Stored at `runs/<mission>/<run-id>/genome-seed-adapter-report.json`; written by Forge as a reproducibility artifact for the seed-repo path only. Schema count incremented 26 → 27 in contracts.py, contracts.ts, and M1 reference. | Data Contracts (new schema block), Repo layout (runtime state root), M3 Forge mandate, contracts.py comment, contracts.ts M1 reference |
| Q3 | Living-loop SOTA regression: if a re-fetched SOTA bar is lower than the committed bar, `angle_registry.py::flag_sota_regression()` emits a human-review milestone-ping (old bar, new fetched value, source + citation, timestamp). Monotonic write-lock (R-8) already forbids auto-lowering; flag_sota_regression() surfaces the discrepancy for user decision. Noted in ADR-012 consequences. | M4 angle_registry.py (new method), M8 living-loop section, ADR-012 consequences |
| Q4 | `BenchmarkUpgrade` records created ONLY by `benchmark.py::apply_upgrade()`. Agents submit `BenchmarkUpgradeProposal` (new lightweight schema: proposed_by, new_domains[], rationale, citations[]). `apply_upgrade()` validates and consent-gates. `domains_removed` is a defensive invariant: apply_upgrade() asserts `len==0`; no code path populates it. Documented in BenchmarkUpgrade schema comment and ADR-012 consequences. | BenchmarkUpgrade schema comment, new BenchmarkUpgradeProposal schema, M8 Step 9.5 proposal line, ADR-012 consequences, contracts.ts M1 reference |
| Q5 | Confirmed: `post_upgrade_exploration_ticks` is already stated as "capped at 15" in StrategyState schema (R-4) and in M8 Step 9.5 boost logic (`ticks = min(15, ...)`). No text change required. | StrategyState schema (verified), M8 Step 9.5 boost block (verified) |
| Risk D-2 | `ExpansionPolicy.max_upgrades_per_N_ticks: { max_upgrades: number; per_ticks: number }` added with default `{max_upgrades: 1, per_ticks: 5}`. M8 Step 9.5 defers a pending upgrade proposal when the cap would be exceeded. Noted in ADR-012 consequences. | ExpansionPolicy schema, M8 Step 9.5 frequency-cap check, ADR-012 consequences |

---

## Changelog (naming pass)

Applied 2026-07-03. Documentation-only; no source code written. Status "pending approval" maintained.

Finalized agent roster (Scheme B): Sage (Researcher, `evor-sage.md`), Mutagen (Dreamer, `evor-mutagen.md`), Probe (EDA/Analyst, `evor-probe.md`), Forge (Implementer, `evor-forge.md`), Selector (Critic, `evor-selector.md`). Canonical "name (role)" format applied consistently throughout; role-first references in agent-identity contexts updated accordingly. Agent Roster legend added after plan header. Skills/commands (`evor`, `evor-run`, `evor-setup`, `evor-dashboard`, `evor-resume`, `evor-report`), MCP tool names (`evor_*`), Python module names, and schema field names left unchanged.
