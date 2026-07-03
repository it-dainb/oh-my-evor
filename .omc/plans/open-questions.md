# Open Questions — oh-my-evor-plan

## Status summary

All substantive design decisions are resolved. Three cosmetic/build-time items remain deferred by design (non-blocking). See sections below.

---

## Resolved

### ADRs (pass 1 — original Architect/Critic review)

| ADR | Decision | Resolved by |
|-----|----------|-------------|
| ADR-001 | Monorepo TS+Python — single `plugin.json`, unified CI | Pass 1 Architect sign-off; DECIDED in plan §RALPLAN-DR |
| ADR-002 | Python harness owns tree engine; TS MCP = thin subprocess adapter | Pass 1 Architect sign-off; DECIDED in plan §RALPLAN-DR |
| ADR-003 | Custom content-hash store + `os.link()` hardlinks; DVC = optional post-v1 | Pass 1 Architect sign-off; DECIDED in plan §RALPLAN-DR |
| ADR-004 | UCB1 default (`ucb1_c=1.41`); MCTS via `strategy.json` override | Pass 1 Architect sign-off; DECIDED in plan §RALPLAN-DR |
| ADR-005 | FastAPI+SSE for live dashboard; static regen for `evor-report` export only | Pass 1 Architect sign-off; DECIDED in plan §RALPLAN-DR |
| ADR-006 | TS→Python bridge: subprocess JSON per call (gyoshu_bridge persistent-socket NOT chosen for v1) | Pass 1 Architect sign-off; R-7 corrected attribution; DECIDED in plan §ADR-006 |
| ADR-007 | 7-tag ML taxonomy (`arch, training, data-curation, data-augmentation, data-acquisition, algo, other`); legacy `augmentation` aliased | Pass 1 Critic; superseded in part by ADR-015; R-12 updated; DECIDED |
| ADR-008 | Release-gate benchmark: CIFAR-10 subset + tabular-churn (L3 CI, < 15 min) | Pass 1 Architect sign-off; confirmed in M11 |

### ADRs (pass 2 — Addendum v2 Architect/Critic review)

| ADR | Decision | Resolved by |
|-----|----------|-------------|
| ADR-011 | Modular seam genome (parametric + structural tiers; `genome-schema-registry.json` required) | Pass 2 Architect sign-off; R-5 added registry; DECIDED |
| ADR-012 | Superset eval_version + consent-gated BenchmarkUpgrade; BenchmarkUpgrade records created only by `apply_upgrade()`; `domains_removed` defensive invariant; SOTA regression surfaced via `flag_sota_regression()` | Pass 2 Architect sign-off; Q3, Q4, Risk D-2 consequences added; DECIDED |
| ADR-013 | Worst-angle coverage as primary fitness for open_ended; monotonic ratchet redefines "no shift" | Pass 2 Architect sign-off; DECIDED |
| ADR-014 | `mission_type: "fixed" \| "open_ended"` top-level dispatch; two clean code paths | Pass 2 Architect sign-off; DECIDED |

### Spec open items (originally from §Open)

| Item | Resolution |
|------|-----------|
| Selection-policy algorithm | UCB1 default confirmed; MCTS via `strategy.json` override; Architect sign-off pass 1 |

### Addendum v2 open design risks

| Risk | Closed by |
|------|-----------|
| Risk A — SOTA sourcing trust | R-8: auto-retrieved bars default to `trust_level="indicative"`; authoritative requires `sota_quorum_met=True` (≥2 sources, divergence ≤5%) or `human_provided`; monotonic write-lock in `angle_registry.py::update_angle()` |
| Risk B — Pretraining contamination for public benchmarks | R-9: `ExpansionPolicy.pretraining_canary_threshold_pp=5.0`; effective bar = `max(sota_bar, baseline_model_score_before_finetune)`; R-13: baseline timing in `apply_upgrade()` | 
| Risk C — Stale eval_version in crossover/GC | R-14: prune gate skips GC for nodes with stale eval_version or pending rescore; R-2: `rescore_deadline_ticks` hard-demote deadline; Q1: `StrategyState.rescore_mode` is the single source of truth for sync/async re-score choice |
| Risk D part 1 — Compute cost of full-suite re-score | R-6: BenchmarkRescore merge protocol; partial `--eval-domains {new}` run merged with cached v_old scores; fitness recomputed by TreeEngine, not eval script |
| Risk D-2 — BenchmarkUpgrade frequency cap | Resolved in this pass: `ExpansionPolicy.max_upgrades_per_N_ticks` default `{max_upgrades: 1, per_ticks: 5}`; M8 Step 9.5 defers proposal when cap exceeded |

### Open-questions resolution pass (Q1–Q5)

| Q | Resolution |
|---|-----------|
| Q1 | `StrategyState.rescore_mode: "sync" \| "async"` (default "sync") is the SINGLE source of truth for re-score mode; read by `benchmark.py::apply_upgrade()` and M8 Step 9.5; no separate `rescore_synchronous` param anywhere |
| Q2 | `GenomeSeedAdapterReport` added as schema 27; stored at `runs/<mission>/<run-id>/genome-seed-adapter-report.json`; written by Forge for seed-repo path; fields: seed_repo_path, detected_seams[{kind, file, symbol}], genome_mapping, unmapped_regions[], created_at |
| Q3 | `angle_registry.py::flag_sota_regression()` emits human-review milestone-ping when living-loop re-fetch finds a lower SOTA bar; monotonic write-lock (R-8) prevents any auto-lowering; noted in ADR-012 consequences |
| Q4 | `BenchmarkUpgrade` records created ONLY by `benchmark.py::apply_upgrade()`; agents submit `BenchmarkUpgradeProposal` (proposed_by, new_domains[], rationale, citations[]); `domains_removed` is a defensive invariant asserted empty by `apply_upgrade()`; documented in schema comment and ADR-012 |
| Q5 | Confirmed (no change needed): `post_upgrade_exploration_ticks` is already stated "capped at 15" in StrategyState schema (R-4) and in M8 Step 9.5 boost logic |

---

## Deferred (non-blocking)

These three items are intentionally left open by design. They do not block implementation and must not gate any milestone.

| Item | Why deferred | Where resolved |
|------|-------------|----------------|
| **Exact agent names** (genetics/evolution theme — Mutagen/Sage/Selector/Forge/Probe are placeholders) | User-reserved cosmetic pass; agent `.md` filenames + SKILL.md references must be updated in bulk once names are confirmed; zero architectural impact | User cosmetic pass after M3 |
| **Exact release-gate benchmark selection** (CIFAR-10 subset + tabular-churn proposed for L3 CI) | User must confirm compute-budget fit before L3 CI is wired; benchmark choice determines L3 wall-clock budget committed to `benchmarks/` at M11 | User confirmation at M11 start |
| **Exact numeric budget/scheduler defaults** (`max_iterations=50`, `plateau_window=8`, `circuit_breaker=5`, `util_target=0.90`) | Plan uses sensible defaults; user can override via GoalContract; wrong defaults on a long run = runaway GPU cost; requires real workload data to tune | User override via GoalContract at mission setup |
