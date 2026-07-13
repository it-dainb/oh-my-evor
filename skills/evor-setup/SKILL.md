---
name: evor-setup
description: Mission interview workflow that elicits all mission settings and launches a validated run via evor_init_run
argument-hint: "[mission description]"
level: 3
skills: [oh-my-evor:evor-mcp]
---

<Purpose>
evor-setup conducts a structured interview to elicit all mission settings, discovers the local compute environment, initializes the frozen data splits (Pillar 2), creates the initial EvalSuite v1 (Pillar 3), runs a preflight smoke-train, and gates launch on explicit user consent. ALL task-specific settings (metrics, constraints, budget, licenses, wildness) are asked and LOCKED during this interview — they cannot be changed after the mission starts without a full re-setup. evor_init_run writes all run artifacts atomically; the evor skill consumes them automatically.

Use `AskUserQuestion` to present each question to the user with structured multiple-choice options where applicable. This ensures clear, parseable responses rather than freeform input.

If `pyright` is not installed, the LSP pre-flight in Forge-junior operates in best-effort mode. Install it with `npm install -g pyright` for full LSP coverage.
</Purpose>

<Use_When>
- User says "setup evor", "new evor mission", "evor setup", or provides a task description and wants to start a new evolution run
- No initialized mission exists for the stated task, or the user explicitly wants to start fresh
- User invokes `/evor-setup` or `/oh-my-claudecode:evor-setup`
</Use_When>

<Do_Not_Use_When>
- An initialized mission already exists and the user wants to resume — use `evor-resume`
- The user wants to start the tick loop directly — use `evor-run` (which calls this if no contract exists)
- The user wants the dashboard or report only
</Do_Not_Use_When>

<Phase_0_Distillation>
## Phase 0 — Workspace distillation (runs BEFORE the interview)

Determine evorRoot: use `$EVOR_ROOT` if set, else `<cwd>/.evor`.

**Case A — `<evorRoot>/starting-point.json` already exists** (written by a prior `/evor-distill`):
  Read it. Proceed to "Pre-fill" below.

**Case B — No starting-point.json, but workspace looks brownfield** (any `*.pt`, `*.pth`,
`*.ckpt`, or `*.safetensors` file found, OR a `data/` or `datasets/` directory exists, OR
`train.py` / `trainer.py` is present in the working tree):
  Use `AskUserQuestion` to offer:
  ```
  This workspace has existing ML artifacts. Run /oh-my-evor:evor-distill first for a
  detailed scan, or choose 'skip' to continue the interview without pre-filling.
  ```
  - If the user agrees to distill: read and execute the evor-distill skill, then read the resulting `starting-point.json`. Proceed to "Pre-fill" below.
  - If the user chooses 'skip': proceed directly to the interview with no pre-fill.

**Case C — an active run is already underway** (detected by evor_state_read):
  Stop. Print:
  ```
  An active EVOR run is already underway.
  Use /evor-run to resume it, or use /evor-setup with a different mission to start a new one.
  ```

**Case D — Greenfield and no starting-point.json**:
  Proceed directly to the interview with no pre-fill.

---

### Pre-fill (applies when starting-point.json is available)

Read these fields from the report and present them to the user before question 1:

```
Pre-filled from starting-point.json — confirm each answer or type a new value:

  Q3  Mode:        seed-repo  (existing codebase detected at <root>)
  Q3a Seed path:   <root>
  Q2  Dataset:     <datasets[0].path>  [<datasets[0].kind>]
  Q7  Framework:   <framework or "unknown">
  Q5  Baseline:    <metric_name>=<claimed_value>
                   ** UNVERIFIED — scraped from repo; EVOR will re-measure on frozen split **
  Hint — Model:    <models[0].arch_guess> (<models[0].format>)  (if detected; not locked here)
```

If `baseline_candidate` is null or absent, omit the Q5 pre-fill row; the user will supply a
baseline value during Q5 as normal.

When conducting each pre-filled question in the interview, present it as:

  > "Q2 — Dataset [pre-filled: `<path>`]: Press Enter to accept, or provide a new path."

The user presses Enter to accept the pre-filled value or types a replacement. All other
(non-pre-filled) questions are asked exactly as specified in the interview below.

**Baseline integrity note** — display whenever a baseline_candidate is pre-filled:

```
Note on baseline: <metric>=<claimed_value> is a scraped claim with verified=false.
It has NOT been measured on a controlled evaluation split. The official baseline_value
used as the official baseline will be whatever EVOR measures on the frozen split during
setup — not this scraped number. Both the claimed value and the EVOR-measured value are
recorded; if they diverge by more than the tolerance threshold, EVOR will flag the
discrepancy in the decision log.
```

The scraped baseline value is unverified until evor measures it on the frozen split during setup. The officially measured value becomes the contract's baseline; evor flags discrepancies in the decision log.
</Phase_0_Distillation>

<Interview>
Conduct the following 14 questions in order using `AskUserQuestion` for each. Ask Q1–Q8 sequentially (Q4a is always asked after Q4). Ask Q9 after Q8. Ask Q10–Q11 only if mission_type=open_ended. Always ask Q12. Ask Q13 only if mission_type=open_ended.

Display a progress indicator: "Question N/14" at the start of each question.

---

**Q1 — Mission name and task description**
"What are you trying to optimize? Describe the task in one or two sentences. This will become the mission ID."
→ Derive `mission_id` as kebab-slug from the description + current date (e.g., "cifar10-improve-2026-07").
→ Set `task_description`.

**Q2 — Dataset**
"Where is your dataset? Provide a filesystem path or URI. Is it already split into train/val/test?"
→ Set `dataset_ref`.
→ Note whether splits are pre-defined or need to be created by the freeze step.

**Q3 — Mode: from-scratch or seed-repo**
Use `AskUserQuestion` with options:
- A) seed-repo (existing codebase)
- B) from-scratch (blank PyTorch skeleton)

→ Set `mode`: "seed-repo" | "from-scratch".
→ If seed-repo: ask for `seed_repo_path`.
→ If seed-repo: note that Forge will audit existing seams and produce a GenomeSeedAdapterReport.

**Q4 — Metrics**
"What is your primary metric (e.g., accuracy, AUC, F1)? Is higher better or lower better? Are there secondary metrics you want tracked but not used for selection?"
→ Populate `metrics[]` (primary: true for the primary, false for secondaries).
→ Populate initial `metric_specs[]` with domain_applicability="all" for each metric.
→ Set `fitness_mode`: "aggregate" by default; offer "worst-domain" and "weighted" as alternatives if the user mentions domain-level concerns.

**Q4a — Metric Scouting** (always ask after Q4)
"Let me scout the right metrics for your task before we lock the goal. One moment."

→ Sage researches candidate metrics for the stated task and model_family:
  1. Proposes ≥3 metric options with citations, covering where applicable:
     - **Single metric** — e.g., accuracy, AUC, BLEU (simple; document gameability risk)
     - **Composite-weighted** — e.g., `fitness_formula = "0.7*recall + 0.3*precision"` (harder to game)
     - **Preference with constraint** — maximize primary metric, hard floor on secondary (e.g., precision ≥ 0.5); violated constraint → fitness = 0.0
     - **F-beta** — `fbeta = 2.0` for F2 (recall-weighted), `fbeta = 0.5` for F0.5 (precision-weighted)
     - **Fully custom** — user-defined formula string over metric names
  2. FLAGS gameable/degenerate metrics and proposes guards:
     - recall-only → predict-all-positive gives recall=1 → guard: `constraints: [{metric: "precision", op: ">=", threshold: 0.5}]`
     - accuracy on imbalanced data → guard: switch to F1 or add per-class recall floor
     - loss-only → model can overfit silently → guard: add val accuracy as secondary metric
  3. Presents guards as constraint options — a violated constraint yields fitness=0.0.

Use `AskUserQuestion` to present options:
```
Metric options for your task:
  [A] Single:     accuracy  (warning: gameable on imbalanced datasets)
  [B] Composite:  0.7*f1 + 0.3*accuracy  (balanced; cite: Sokolova & Lapalme 2009)
  [C] Preference: maximize recall, constraint: precision >= 0.50  (anti-false-positive guard)
  [D] F-beta:     F2 (fbeta=2.0) — recall-weighted harmonic mean of precision/recall
  [E] Custom:     enter your own formula over metric names

  Gameability flags:
    [A] with recall primary: predict-all-positive gives recall=1
  Recommended guard: if using recall, add precision >= 0.50 constraint
```

→ User picks or customizes.
→ The selection is recorded in the metric configuration passed to evor_init_run.
→ If a formula or constraint is specified, update `fitness_mode` accordingly.
→ **LOCK NOTE:** These metric settings are finalized here. They cannot be changed after the mission starts without a full re-setup (see Lock Policy below).

**Q5 — Baseline and target**
"What is your current baseline score on the primary metric? Do you have a specific target value, or should Evor maximize under budget?"
→ Set `baseline_value`.
→ Set `target_value` if provided, else null.
→ Set `stop_condition.type`: "target" if target given, else "maximize-under-budget".

**Q6 — Budget**
"How many iterations (ticks) should Evor run at most? What is the plateau window (ticks with no improvement before stopping)? Do you want a circuit breaker (max consecutive failures)?"
→ Set `budget.max_iterations` (default 50).
→ Set `budget.plateau_window` (default 8).
→ Set `budget.circuit_breaker` (default 5).
→ Ask: "Is this local-only or do you have cloud GPU available?" → set `budget.max_cost_usd` (0 = local-only).
→ Optionally: set `budget.max_wall_clock_hours` and `budget.max_gpu_hours`.

**Q7 — Framework**
"What ML framework? (PyTorch is default for from-scratch; seed-repo inherits from the existing code.)"
→ Set `framework` (default "pytorch").

**Q8 — Wildness dial**
Use `AskUserQuestion` with a slider description:
"How adventurous should Evor be in proposing mutations?
  [A] 0.0 — conservative tweaks only
  [B] 0.5 — balanced exploration (default)
  [C] 1.0 — paradigm-shifting proposals
  [D] Custom value (0.0–1.0)"
→ Set `wildness` (default 0.5).

---

**Q9 — Mission type: fixed or open-ended** (always ask after Q8)
Use `AskUserQuestion` with options:
- A) fixed (one frozen test suite throughout)
- B) open-ended (Evor can discover new evaluation angles and expand the benchmark)

→ Set `mission_type`: "fixed" | "open_ended".
→ If fixed: proceed to Q12.
→ If open_ended: proceed to Q10.

**Q10 — SOTA sources and expansion policy** (only if open_ended)
Use `AskUserQuestion` to present sources as checkboxes:
"Which SOTA sources should count as authoritative for setting benchmark bars?
  (a) Papers With Code — leaderboard data, auto-retrieved
  (b) arXiv — paper-reported numbers, retrieved by Sage
  (c) Human-provided — you supply the bar manually
  (d) Custom URL — specify a leaderboard URL

Should new evaluation angles be auto-added within a domain family, or require your explicit consent per angle?"
→ Set the expansion policy configuration from the user's answers (SOTA sources, auto-add scope, consent scope, and cadence limits). This is passed to evor_init_run as the expansion_policy field.

**Q11 — Coverage target** (only if open_ended)
"What is your coverage target? For example, 0.95 means Evor stops when ≥95% of discovered evaluation angles meet or exceed their SOTA bar. (Default: 0.80)"
→ Set `coverage_target` (default 0.80).
→ Set `stop_condition.type`: "coverage-target".

**Q12 — License allowlist** (always ask)
Use `AskUserQuestion`:
"Which data licenses are acceptable for external dataset acquisition or synthetic data generation?

Default allowlist: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, CC-BY-4.0, CC0-1.0.

  [A] Confirm defaults
  [B] Provide a custom list (SPDX identifiers, comma-separated)"

Any acquired data with a license outside this list will be rejected by the Ingestion Contamination Gate.
→ Set `allowed_licenses` (default list if A, custom list if B). This is passed to evor_init_run.

**Q13 — Compute budget confirmation** (only if open_ended; MUST be asked before consent checkpoint)
Use `AskUserQuestion`:
"Compute budget review:
  - Coverage target: [coverage_target from Q11]
  - Estimated ticks to coverage: [estimated = coverage_target / expected_ticks_per_angle_gain (use 0.05 per tick as default estimate)]
  - Estimated total cost: [GPU-hours × GPU rate if cloud; 'local — no direct cost' if local-only]

Do you confirm this budget is acceptable before the mission starts?
  [A] Yes — proceed
  [B] No — abort (re-run /evor-setup with adjusted parameters)"

→ If B or any decline: abort setup. Print: "Mission not started. Re-run /evor-setup with adjusted budget parameters."

</Interview>

<Lock_Policy>
ALL task-specific settings collected during the interview are LOCKED at setup time. This means:

- **Metrics and constraints** (Q4 + Q4a): `metric_specs[]`, `fitness_formula`, `fbeta`, `constraints[]`, `custom_metrics[]`, `fitness_mode` — immutable after the mission is initialized.
- **Dataset and splits** (Q2): `dataset_ref` — immutable; the frozen split anchors are sealed by evor_freeze_splits and cannot be altered after lock.
- **Budget** (Q6): `budget.*` — cannot be expanded mid-run; requires re-setup to increase.
- **Wildness** (Q8): changing wildness mid-run invalidates the strategy baseline; locked.
- **License allowlist** (Q12): data acquired under a rejected license is blocked by the Ingestion Contamination Gate; the gate uses the locked list.
- **Mission type** (Q9): fixed vs. open_ended cannot be changed mid-run.
- **Coverage target** (Q11, open_ended only): locked into the stop condition.

**Rationale:** Evor's fitness comparisons are only valid when the evaluation contract is constant. Changing metrics or data splits mid-run would make candidate scores incomparable, invalidating the evolution tree.

**Override path:** If a setting must change, create a new mission with `/evor-setup`. The old run directory is preserved for reference.
</Lock_Policy>

<Environment_Discovery>
After the interview is complete, run environment discovery:

```bash
nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader 2>/dev/null || echo "no-gpu"
free -h
df -h .evor/
```

Parse output to populate a ResourcePlan:
- `gpu_ids`: indices of detected GPUs (empty if none).
- `cpu_fallback`: true if no GPU detected.
- `vram_per_job_gb`: estimated from free GPU memory / concurrency.
- Set `budget.max_cost_usd=0` if local-only (no cloud configured).

Print a summary:
```
Environment discovered:
  GPUs: [names] or CPU-only
  Free VRAM: Xgb / Total: Ygb
  Disk available for .evor/: Zgb
  Estimated concurrency: N
```
</Environment_Discovery>

<Setup_Mechanics_Order>
## MANDATORY setup sequence

The setup tools have a strict dependency order. Run them in EXACTLY this order — the
sections below detail each step, but THIS ordering governs (do not follow section order
blindly):

1. **`evor_init_run`** (see Run_Initialization) — creates the run and its contract. This runs
   FIRST; every other setup tool takes the `run_id` it returns. Freezing or sealing before the
   run exists silently does nothing.
2. **`evor_freeze_splits`** (see Frozen_Split_Setup) — freeze the splits and seal the split
   anchor into the run's contract. Runs AFTER step 1 so the contract exists to seal into.
3. **Write `eval-suites/<eval_version>.py`, then `evor_seal_eval_script`** (see
   EvalSuite_Initialization) — materialize the canonical evaluator and seal its anchor. This is
   MANDATORY. If you skip writing the evaluator, the seal reports it missing — write it, then
   seal. Do not continue with an unsealed evaluator.
4. **`evor_preflight`** — environment smoke-test.
5. **`evor_lock_mission`** (see Validate_And_Lock) — validates and locks. It will REFUSE to lock
   unless BOTH the split anchor (step 2) and the evaluator anchor (step 3) are sealed. If it
   reports a missing anchor, complete that step and retry — never proceed without a clean lock.

Re-running `evor_init_run` after steps 2–3 preserves already-sealed anchors, but is unnecessary.
</Setup_Mechanics_Order>

<Frozen_Split_Setup>
After the run is created (step 1 above), initialize frozen data splits (Addendum v2 Pillar 2).

Call `evor_freeze_splits` with the dataset path and eval version:

```
evor_freeze_splits({
  dataset_path: "<dataset_ref>",
  eval_version: "v1"
})
```

Call evor_freeze_splits with the dataset path and eval version. It freezes the test and val splits, makes them read-only, and seals the integrity anchors server-side. On success it returns a confirmation; the harness owns all hash computation internally.

Print confirmation: "Frozen splits initialized. Files are read-only."
</Frozen_Split_Setup>

<Materialize_Anchors>
## Materialize anchors

evor_freeze_splits seals the split integrity anchors server-side. Never attempt to compute or write anchor values yourself — if evor_freeze_splits returns an error, surface it and stop; there is no agent-side fallback.

The canonical evaluator anchor is sealed separately by evor_seal_eval_script after the evaluator script is written. Verify that call returns ok before proceeding to lock.

If evor_seal_eval_script reports the evaluator is missing, write eval-suites/<eval_version>.py first, then re-call evor_seal_eval_script.

**Class→domain mapping guard:**

If any metric constraint or guard in the contract references a class→domain mapping file (e.g., `class_domain_map.json`):
- Materialize that file now, from the available dataset.
- If it cannot be built at setup time, REMOVE the guard from the contract entirely. Only lock guards that are satisfiable from tick 1. A guard that references a file that does not exist will block every tick.
</Materialize_Anchors>

<EvalSuite_Initialization>
Create the initial EvalSuite v1 (Addendum v2 Pillar 3).

Call `evor_init_eval_suite` with the mission details:

```
evor_init_eval_suite({
  mission_id: "<mission_id>",
  eval_version: "v1",
  task_description: "<task_description>"
})
```

This derives initial domains from `task_description`, creates an EvalSuite record, and initializes the angle registry with one entry per initial domain.

## Materialize and seal the canonical evaluator

The integrity gate's eval-shift check compares each node's `evaluate.py` against the mission's sealed canonical evaluator anchor. That anchor must be sealed BEFORE the tick loop starts, or every node fails the integrity check and nothing is ever promoted.

Write `eval-suites/<eval_version>.py` now — the ONE evaluation script every node will share. It defines the fixed evaluation contract that Forge's models must conform to. It must:
- Load the frozen test split (never re-split, never touch train/val for scoring). The frozen split path is provided via the run environment — do not hardcode it.
- Import the node's model through the standard worktree interface (e.g. `from model import build_model`) and load its trained weights.
- Run inference over the frozen test set and compute the primary metric from the mission contract.
- Print exactly ONE JSON evaluation result object to stdout; all logs go to stderr.

This evaluator is authored ONCE, here, and then frozen. Forge copies it verbatim into every node worktree and is forbidden to modify it — so keep it model-agnostic (it depends only on the fixed `build_model` / weights interface, not on any one architecture).

Then seal the evaluator anchor into the contract:

```
evor_seal_eval_script({ run_id: "<run_id>", eval_version: "v1" })
```

Verify the call returns `ok`. If it reports the evaluator is missing, write eval-suites/<eval_version>.py first, then re-call evor_seal_eval_script. Do NOT proceed to lock if evor_seal_eval_script did not return ok.
</EvalSuite_Initialization>

<Preflight_Smoke_Train>
Run a 5-step smoke-train to verify the environment is functional.

Call `evor_preflight({ mission_id: "<mission_id>" })`.

The preflight runs a micro-train (10 random samples, 2-layer MLP, 5 steps) and verifies:
1. Loss at step 5 < loss at step 1 (training is working).
2. GPU util > 0% if GPU detected (GPU is accessible).
3. No OOM or import errors.

**On failure:** Use `AskUserQuestion`:
"Preflight failed: <error>. Do you want to override and proceed anyway?
  [A] Yes — note override and proceed
  [B] No — abort setup"
→ If B: abort setup.
→ If A: note the override in the mission metadata and proceed.

**On success:** Print: "Preflight passed. Training pipeline verified."
</Preflight_Smoke_Train>

<Launch_Consent_Checkpoint>
Before initializing the run, display a summary and require explicit consent via `AskUserQuestion`. This checkpoint CANNOT be skipped.

```
=== Evor Mission Setup Summary ===

Mission ID:         <mission_id>
Mode:               <from-scratch | seed-repo>
Mission type:       <fixed | open_ended>
Task:               <task_description>
Dataset:            <dataset_ref>
Primary metric:     <metric name> (<higher|lower> is better)
Baseline:           <baseline_value>
Target:             <target_value or "maximize under budget">
Budget:             <max_iterations> ticks, plateau_window=<n>, circuit_breaker=<n>
Wildness:           <wildness>
License allowlist:  <allowed_licenses>
GPUs:               <detected GPUs or CPU-only>
Frozen splits:      initialized
EvalSuite:          v1 initialized (<N> initial domains)
Preflight:          passed | overridden
```

For open_ended missions, additionally display:
```
Coverage target:    <coverage_target * 100>% of angles ≥ SOTA
SOTA sources:       <list>
Expansion policy:   auto-add within [<families>], consent required for [<families>]
Estimated ticks:    ~<estimate>
```

Use `AskUserQuestion`:
"Type 'start' to launch the mission, or 'abort' to cancel.
  [A] start
  [B] abort"
→ A: proceed to Run_Initialization.
→ B or any other response: abort. Print "Mission not started."
</Launch_Consent_Checkpoint>

<Run_Initialization>
After consent:

1. Assemble the interview-answer fields into an `answers` object. Every field must be plain JSON — nested models (Budget, StopCondition, MetricSpec, ExpansionPolicy, etc.) are plain dicts, not Python objects. Include only the fields collected during the interview:

   ```json
   {
     "mission_id": "<kebab-slug>",
     "mode": "seed-repo",
     "mission_type": "fixed",
     "task_description": "<full task description>",
     "dataset_ref": "<path or URI>",
     "metric_specs": [
       {
         "metric_name": "<metric>",
         "direction": "higher",
         "domain_applicability": "all",
         "role": "primary_fitness",
         "fitness_formula": null,
         "fbeta": null,
         "constraints": [],
         "custom_metrics": []
       }
     ],
     "fitness_mode": "aggregate",
     "baseline_value": 0.85,
     "target_value": null,
     "coverage_target": null,
     "stop_condition": {"type": "maximize-under-budget"},
     "wildness": 0.5,
     "budget": {
       "max_iterations": 50,
       "plateau_window": 8,
       "circuit_breaker": 5,
       "max_cost_usd": 0,
       "max_wall_clock_hours": null,
       "max_gpu_hours": null
     },
     "framework": "pytorch",
     "seed_repo_path": null,
     "expansion_policy": null,
     "allowed_licenses": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "CC-BY-4.0", "CC0-1.0"]
   }
   ```

   Do NOT include internal fields such as integrity anchors, version stamps, or aggregation rules — `evor_init_run` constructs all run artifacts server-side from the interview answers and the frozen splits already initialized.

   `autonomy_charter` may be omitted — the tool defaults to fully autonomous posture with data acquisition enabled.

   Print: "Mission will run FULLY AUTONOMOUS to the goal — the monotonic-honesty invariant auto-decides every mid-run choice with no human questions."

2. Call `evor_init_run` to write all run artifacts atomically. It generates and returns `run_id` — do not generate `run_id` yourself:

   ```
   evor_init_run({ answers: <answers object>, mission_id: "<mission_id>" })
   ```

   On success it returns `run_id` and atomically writes all run artifacts. Surface any `{error}` result to the user — do not attempt to write any artifacts manually.

3. Call `evor_state_write({ mission_status: "draft", active_run: { mission_id, run_id, run_dir, status: "initialized" } })` using the `run_id` returned by `evor_init_run`.

Print: "Mission initialized. Run ID: <run_id>. Running Phase-2 validation gate..."
Then proceed to Validate_And_Lock.
</Run_Initialization>

<Validate_And_Lock>
Run the Phase-2 enforcement gate and lock the contract before `/evor-run` is possible.

Call `evor_validate({ run_id: "<run_id>" })`.

**On pass:**
Call `evor_lock_mission({ run_id })` to validate and lock the mission. On success it returns a locked confirmation.
Print: "Phase-2 validation PASSED. Mission locked. Run ID: <run_id>. Start the tick loop with /evor-run."

**On fail:**
Do NOT proceed. Print the failed check details from the validator report (each `ok: false` check with its detail).
Print: "Phase-2 validation FAILED. Mission is NOT locked. Resolve the issues above, then re-run /evor-setup."

Remediation by failure type:
- `metric_gameability_*` failures → revise metric config (return to Q4a and pick a guarded metric)
- `goal_contract_schema` / `goal_contract_required_fields` → revisit the relevant interview question
- `frozen_splits_*` failures → re-run the Frozen_Split_Setup step
- tree or run-state failures → re-run evor_init_run to atomically re-initialize all run artifacts

Setup CANNOT complete without a locked mission. `/evor-run` will refuse to start until the mission is locked.
</Validate_And_Lock>

<Tool_Usage>
- `AskUserQuestion` — drive the interview with structured multiple-choice questions (Q3, Q4a, Q8, Q9, Q12, Q13, preflight override, consent checkpoint)
- `Bash` — nvidia-smi, free, df (environment discovery only)
- `evor_freeze_splits` — freeze test and val splits; seals integrity anchors server-side
- `evor_init_eval_suite` — create initial EvalSuite v1 and angle registry
- `evor_seal_eval_script` — seal the canonical evaluator anchor into the contract
- `evor_preflight` — 5-step smoke-train to verify training pipeline
- `evor_init_run` — atomically write all run artifacts; returns run_id (the ONLY path to create run state)
- `evor_validate` — Phase-2 enforcement gate (schema + gameability + splits + tree + run-state)
- `evor_lock_mission` — validate and lock the mission after passing Phase-2 gate
- `evor_state_write` — set active_run after init; set mission_status="draft" before validate
- `evor_state_read` — read active run state for run resolution
</Tool_Usage>
