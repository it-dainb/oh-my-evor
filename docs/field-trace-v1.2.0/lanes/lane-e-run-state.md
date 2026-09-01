# Lane E — evor run-state and mission integrity (wave 1 inventory)

Read-only sweep of `/home/dainb_1/research/binarization/.evor/`. Nothing was modified.
`RUNS=/home/dainb_1/research/binarization/.evor/runs`; each run's state lives at `$RUNS/<mission>/run-live-01/`.

## 1. Three-run outcome summary

| | r1 `…min98-2026-08` | r2 `…-r2` | r3 `…-r3` (active) |
|---|---|---|---|
| created / last write | 08-23 08:14 / 08-24 00:13 | 08-23 10:41 / 08-24 00:13 | 08-23 23:51 / 08-24 02:00 |
| mission-state.status | `failed` (set retroactively) | `failed` (set retroactively) | `running` (stale 8 days) |
| superseded_reason | "sealed evaluator scored paper as ink (inverted GT polarity); baseline_value 59.61 was not like-for-like" | "latency gates did not match the contract; superseded by r3 with GPU<500ms and quantization angle" | — |
| run-state.tick_count | **0** | 1 | 1 |
| tick-state | tick 1, step 6, `failed` | tick 1, step 9, `done` | tick 1, step 9, **`running`** |
| mission-state.current_tick / started_at | 0 / `null` | 0 / `null` | 0 / `null` |
| max_ticks (contract budget) | 200 | 200 | 200 |
| tree.json nodes | 2, both `status: running` forever | 1, `done` | 1, `done` |
| evaluations/*.json | **0 files** | 1, verdict `failed` | 1, verdict `failed` |
| jobs | 3 — all `failed` (exit 1,1,2) | 2 — 1 `failed`, 1 `succeeded` | 1 — `succeeded` |
| best_score / best_node_id | null / null | null / null | null / null |
| frontier_ids | `[]` | `[]` | `[]` |
| angles registered | `[]` | `[]` | `[]` |
| fitness achieved | n/a (eval errored) | 0.0 | 0.0 |
| headline metric | none — evaluator could not map 132 test items to domains | min-domain F **48.72**, 10/22 domains under the 0.80 precision floor | min-domain F **3.53** (palmleaf_khmer), 4 domains under floor |
| baseline_value in contract | 59.61 | 0 | 0 |
| contract eval_script_hash | `8d7107cf…` | `f123d17c…` | `a3776de4…` |
| actual eval-suites/v1.py sha256 | `a3776de4…` **(mismatch)** | `a3776de4…` **(mismatch)** | `a3776de4…` |
| signals emitted | 16 (7 critical) | 8 (3 critical) | 9 (0 critical, 5 high) |
| handoffs | `1-0.json` only (no tick summary) | `1-0`, `1-1` | `1-0`, `1-1` |
| disk | 80 MB | 81 MB | 82 MB |

Net: **~18 h wall clock across three missions produced 1 tick each, 3 candidate nodes, 0 nodes with
non-zero fitness, 0 promotions, 0 frontier entries, and 0 registered angles.** The stop condition is
`coverage-target` with `coverage_target: 1.0`, evaluated over an angle registry that is empty in all
three runs, so the mission had no reachable termination criterion either.

## 2. Findings by category

### MISSION-ABORT
- **r1 → r2**: r1's own `superseded_reason` blames GT polarity — the sealed evaluator's `load_gt`
  (`eval-suites/v1.py:534-542`) returned `a>=0.5`, i.e. treated white/paper as ink, while the corpus
  stores ink=0 (DIBCO). Two `integrity-violation` signals (critical) and a `metric-degeneracy` signal
  independently confirm it; `mask_positive_fraction_train = 0.908` means a trivial all-ones prediction
  scores F 94.7. `baseline_value: 59.61` in r1's contract was measured under that inverted convention.
  r1 also never got a score at all: every node returned `status: error` because `label_domains` raised
  `EvalError: 132 test item(s) could not be mapped to a domain via manifest.json`.
- **r2 → r3**: `superseded_reason` = "latency gates did not match the contract". r2's forge measured
  the sealed evaluator at `LATENCY_CPU_4K_S_MAX = 0.1` and GPU 10 ms while the goal contract and the
  mission brief stated CPU < 1.0 s. The current file on disk has `LATENCY_CPU_4K_S_MAX = 1.0`,
  `LATENCY_GPU_MS_MAX = 500.0`, `LAT_CPU_THREADS = 8` — i.e. the gate was rewritten between r2 and r3.
- Both aborts were recorded **after the fact**: `mission-state.json.bak-20260824T001336Z` in r1 and r2
  show `"status": "running"`, and the `failed` + `superseded_by` fields were added by hand at
  2026-08-24 00:13 — 14 h after r1 stopped and 40 min after r3 started.
- Implied (not stated) reason common to both: the missions were restarted to change the *evaluator*,
  not the search. Each restart re-froze a new 79 MB split copy and reset the tree to empty.

### PROGRESS-STALL
- Tick counts: r1 `ticks/1` only (step 6 of the tick pipeline, `failed`), r2 `ticks/1` (step 9, done),
  r3 `ticks/1` (step 9, **still `running`**, last touched 2026-08-24 02:05Z). 1 of 200 budgeted ticks
  in each run.
- `run-state.tick_count` is 0 in r1 despite a tick directory, two tree nodes and three jobs.
- `mission-state.current_tick` is 0 and `started_at` is `null` in **all three**, including the run
  that `active-run.json` claims is executing. These fields are apparently never written by the tick loop.
- No progress was made against the objective: r2's best node scored min-domain F 48.72 (constrained
  fitness 0.0 — precision floor + gates), and r3's successor scored min-domain F **3.53**, a large
  regression, with `hypothesis-refuted` logged for the h001 IIR hypothesis (predicted 60-65, actual 3.5).

### CONTRACT / INTEGRITY-FAILURE
- **The "sealed" evaluator is a single shared inode.** `eval-suites/v1.py` in all three runs is inode
  28705681 with link count 5, also hardlinked as
  `/home/dainb_1/research/binarization/eval-suites/v1.py` and
  `/home/dainb_1/research/binarization/.evor/worktrees/iir-binnet-01/evaluate.py`. Its mtime is
  2026-08-23 23:49 — *after* r1 and r2 finished. Rewriting the evaluator once retroactively rewrote the
  archived, supposedly-sealed evaluator of both completed runs. r1's and r2's `eval_script_hash`
  (`8d7107cf…`, `f123d17c…`) no longer match the file that now sits in their run directories, so neither
  run's recorded results are reproducible or auditable.
- **`eval_lock` is tautological.** r3's evaluation records
  `eval_lock_detail: lock(...evaluate.py.lock)=a3776de4… ; scoring(...evaluate.py)=a3776de4… ;
  contract.eval_script_hash=a3776de4…` and passes — but the scoring script *is* the same inode as the
  sealed suite, so lock==scoring==contract is a fixed point that cannot detect tampering.
- **Harness patched minutes after a failing verdict.** `.bak` timestamps on the plugin harness:
  `integrity.py.bak-20260823-2350`, `…-20260824-020302`, `…-20260824-021010`;
  `contracts.py.bak-20260823-2350`, `…-20260824-020302`, `…-20260824-021010`;
  `freeze.py.bak-20260823-083205`. The r3 evaluation was written at 01:56:05 with verdict `failed`;
  `integrity.py` and `contracts.py` were then rewritten at 02:03 and again at 02:10. Whether the patch
  softened the gate is a wave-2 question, but the sequencing (fail → patch the gate that failed) is
  exactly the "monotonic, never easier" invariant the contract's `autonomy_charter` forbids.
- Signal counts by run: r1 16 signals / 7 critical (3 × `integrity-violation`, `metric-degeneracy`,
  `evaluator-corpus-incompatibility`, `latency-gate-infeasible`, `latency-gate-violation`,
  `constraint-violation-latency`); r2 8 / 3 critical (`cpu-latency-hard-gate-active`,
  `cpu-latency-gate-unreachable-on-contended-host`, `integrity-violation`); r3 9 / 0 critical, 5 high
  (`telemetry-summary-underreport`, `harness-defect-telemetry-summary`, `hypothesis-refuted`,
  `class-confusion`, `latency-gate-risk`, `genuine-iir-vs-fake`).
- Contract/evaluator divergence (r2, critical): "the sealed evaluator computes fitness, so 0.1 is
  authoritative" — candidates were being designed against a documented gate 10× looser than the one
  that scored them. r1's whole node was condemned for a 73× violation of a 0.1 s gate that no longer exists.
- `no_test_leakage: false` in r2 — forge used a private `data/builder.py` reading
  `corpora/v10/{train,val,test}.txt` directly instead of the central loader. r3 fixed it
  (`0 image sha256 overlap, train=370 vs eval=260`).
- `frozen_split_read_only` passed in both recorded evaluations; the frozen split files are chmod 444
  and `locked_split_hash` is identical (`86c6462a…`) in all three contracts. No frozen-split violation found.

### EVALUATOR-PROBLEM
- **`telemetry_sane` is the only gate that ever fires, and it fires on every node that reached it**
  (r2 `a0d33fe8`, r3 `afb204f4`) — 2 of 2. In r3 it is the *sole* reason for `verdict: failed` on a run
  that passed every other check; `signals.jsonl` records `reported_total_steps: 0` vs
  `actual_telemetry_jsonl_lines: 12000` and labels it `harness-defect-telemetry-summary`. This matches
  the known prior pathology in this codebase. Note the tension: the current `integrity.py` docstring says
  telemetry_sane parses "the FILE, never a summary field", and `results.json` for r3 does carry
  `telemetry_summary.total_steps: 12000` — so the recorded verdict came from a code path that no longer
  exists, or the diagnosis in the signal is wrong. Either way the recorded verdict is not reproducible.
- The recorded `checks` dicts also differ in shape between r2 and r3 (r3 has `eval_lock_stale`,
  `*_status`/`*_detail` sidecars, `verdict_source: computed`; r2 has none), and neither has
  `telemetry_sane_status`/`_detail` even though the current integrity module always emits them —
  further evidence the evaluations were written by different harness versions.
- Degenerate always-pass gates: `split_hash_match`, `frozen_split_read_only`, `data_provenance_valid`,
  `no_eval_shift`, `eval_version_consistent` are `true` in 2/2 evaluations; `near_dup_leakage` and
  `reward_hacking_probe` are `false` in 2/2 — `near_dup_leakage` is hard-coded to `False` unless the
  node's family is `data-augmentation` (`integrity.py:472`), and both nodes were `arch`, so it is
  recorded as a passed check that never ran.
- Mixed boolean polarity inside one flat dict: `no_test_leakage`/`telemetry_sane` are true=good while
  `near_dup_leakage`/`reward_hacking_probe`/`eval_lock_stale` are true=bad. Any consumer that treats
  the dict uniformly will misread it.
- r1: the evaluator was structurally incompatible with the corpus from setup — `manifest.json` is a
  flat path→sha map, `domains.json` indexed 0 path fields, and `frozen_index.json` (which has the
  right `{domain,image_path,mask_path}` records) was not consulted. Every candidate in r1 was
  guaranteed `status: error, fitness_value: 0.0` before a single model was trained.

### JOB / SCHEDULER-FAILURE
- 6 jobs total; 3 succeeded, 3 failed. No orphaned or unreaped jobs — every `status.json` has a
  terminal `state`, `exit_code` and `finished_at`.
- r1 `fe6281bb` exit 2: `python -m evor: error: unrecognized arguments: --eval-version v1` — the
  caller passed a flag the harness CLI does not accept (caller/CLI version drift).
- r1 `06ca7248` and `7f2ae025` exit 1: both logged `{"status":"error","fitness_value":0.0}` from the
  domain-mapping EvalError. Both ran against the *same* worktree `multiscale-stroke-gate-01` under two
  different node UUIDs.
- r2 `3679dbc8` exit 1: `ERROR: node 'iir-binnet-01' not found in tree.json. Run evor_record_node
  before invoking the harness.` — the slug was passed where a UUID was required (see STATE-INCONSISTENCY).
- **The active job `c4a5e447` DID finish**: `state: succeeded`, `exit_code: 0`, `finished_at`
  2026-08-24T01:30:33Z, 24.5 s after start. `active-run.json` has not been updated since 01:30:08 and
  still reports the mission as `running`.

### HANDOFF-LOSS
- r1 wrote `handoffs/1-0.json` (orchestrator→sage) but never a `1-1` tick-summary handoff — the tick
  died at step 6, so the tick's outputs were never handed back. r2 and r3 both have `1-0` and `1-1`.
- r2's `1-1` cites `lessons: ["iir-binnet-01 gpu-latency+precision-floor+test-leakage"]`, but the only
  lesson file written that tick is `wiki/.md` — a file whose name is literally the extension, whose
  title, Node, Run and Mission fields are all empty, and whose verdict is "inconclusive". r1 has the
  same bug (`wiki/.md`, Node `multiscale-stroke-gate-01-2`, Run and Mission blank). The lesson slug
  generator accepts an empty title and produces a hidden file; the handoff's lesson reference cannot be
  resolved to it. r3's lesson file is correctly named `iir-scan-binnet-02-tick1.md`.
- r3's `1-1` is the only handoff carrying a `to` field (`orchestrator`); r2's `1-1` has none — schema
  drift in the handoff record itself.
- No handoff was written-and-never-consumed in a way that could be proven from state alone.

### STATE-INCONSISTENCY
- `active-run.json` says `status: running`, job `c4a5e447` — that job exited 0 eight days ago.
  `tick-state.json` for r3 says `step_status: running` as of 02:05Z; `run-state.json` was last written
  at 02:00Z. Nothing has advanced since. The mission is stranded, not running.
- `run-state.status` is `"running"` in **all three** runs including the two whose `mission-state.status`
  is `failed`. The two files disagree in r1 and r2.
- r1: `run-state.tick_count: 0` vs `tick-state.tick: 1` vs two nodes in `tree.json` vs three jobs.
- `mission-state.current_tick: 0` and `started_at: null` in all three; `best_score`/`best_node_id` null
  everywhere including runs that produced scored nodes (r2 min-domain F 48.72 is in `results.json` but
  never propagated to `run-state.best_score` or `mission-state.best_score`).
- **Two node namespaces.** `tree.json` and `evaluations/*.json` are keyed by UUID; `nodes/`, the
  worktrees, `telemetry.jsonl`, `decision-log.md` records and `tick-state.step_outputs.node` use human
  slugs. `nodes/` therefore contains *both* — `nodes/<uuid>/results.json` and
  `nodes/<slug>/telemetry.jsonl` as separate directories for the same candidate. r2's job `3679dbc8`
  failed outright because a slug was passed where the tree expects a UUID. r1's
  `nodes/multiscale-stroke-gate-01/` (450 telemetry lines) has no corresponding tree entry under that name.
- r1's two tree nodes are permanently `status: running` with `fitness: null` and no evaluation record,
  even though both their jobs terminated with exit 1 — nothing reconciles job death back into the tree.
- `angle-registry.json` is `{"angles": []}` in all three, yet r3's `results.json` gained
  `per_angle_vs_sota` and `worst_angle_coverage` fields and the stop condition is `coverage-target: 1.0`.
  Coverage over an empty registry is undefined; the run cannot terminate successfully by design.
- r3 has `ticks/1/forge/forge-report-partial.json` but **no** `forge-report.json`, yet the tick advanced
  to step 9 and a node was recorded. r1 has both. The tick pipeline does not require its own step output.
- `results.json` schema drifts run to run: r3 adds `per_angle_vs_sota`/`worst_angle_coverage`; r2's
  `telemetry_summary` has `final_train_loss`, r3's does not; r1's `run_id` is `""` while r2/r3's is
  `run-live-01`.
- Per-mission gotcha store exists only in r1 (`gotchas/mission.jsonl`, 9.5 KB). r2's selector cites
  `gotcha-518faad283fd`, which lives only in `.evor/wiki/gotchas/global.jsonl` (24 KB). r2 and r3 have
  no `gotchas/` directory at all.

### COST / EFFICIENCY
- **No cost or token accounting exists anywhere in run state.** `budget.max_cost_usd` is `0` in all
  three contracts, and there is no `cost`/`usd`/`tokens` field in any state file. The 18 h of
  three-mission agent work cannot be costed from these artifacts. Every `"axes":["compute","cost"]`
  hit in `signals.jsonl` is a *compute* signal (latency, VRAM, disk), not spend.
- **Disk: 243 MB total, 98.7 % of it triplicated frozen splits.** Per run: `frozen-splits/` 79 MB
  (522 files), `nodes/` 2.9 MB (telemetry), `ticks/` 176 KB, `artifacts/` 84 KB, everything else < 64 KB.
  All three runs have the same `locked_split_hash` `86c6462a…` — the identical corpus — but the files
  are separate inodes (link count 1), i.e. physically copied three times rather than hardlinked the way
  `eval-suites/v1.py` is. This is exactly backwards: the file that *should* be per-run-immutable is
  shared, and the files that *are* provably identical are duplicated.
- r1 recorded a `disk-pressure` signal: root fs 95 % used, 28 GB free at the time. 158 MB of the 243 MB
  is redundant.
- Wasted compute inside the ticks: r1 `compute-waste` (9× redundant loss evaluations per step,
  `train/trainer.py:259-269`), r1 `eval-harness-cost` (the sealed CPU-latency probe predicted at
  600–2700 s, 5–20× longer than the 127 s of training it was gating), r2 `training-too-slow`
  (20,000 steps configured = 833 epochs over 370 images).
- Efficiency of the run as a whole: 3 candidate models trained, 20,450 telemetry steps total,
  0 promotions, 0 frontier entries, 3 mission restarts.

## 3. Categories with zero hits
- **Frozen-split violation**: none. `frozen_split_read_only` and `split_hash_match` pass in both
  recorded evaluations; all three contracts carry the same `locked_split_hash`; the files are chmod 444.
- **Orphaned / never-reaped jobs**: none. All 6 jobs have terminal state, exit code and finish time.
- **JSON schema parse errors**: none. Every `signals.jsonl` line and every state JSON parses cleanly.
- **Handoff consumed with missing fields**: not provable from state; the losses found are a missing
  tick-summary handoff (r1) and an unresolvable lesson reference (r2), listed above.
