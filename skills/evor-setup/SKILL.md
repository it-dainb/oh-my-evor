---
name: evor-setup
description: Mission interview workflow that produces a GoalContract and initializes run state for an Evor evolution mission
argument-hint: "[mission description]"
level: 3
---

<Purpose>
evor-setup conducts a 14-question Socratic interview to elicit all GoalContract fields, discovers the local compute environment, initializes the frozen data splits (Pillar 2), creates the initial EvalSuite v1 (Pillar 3), runs a preflight smoke-train, and gates launch on explicit user consent. ALL task-specific settings (metrics, constraints, budget, licenses, wildness) are asked and LOCKED during this interview — they cannot be changed after the mission starts without a full re-setup. The output is a valid GoalContract written to `.evor/runs/<mission-slug>/<run-id>/` that the `evor` tick loop can consume.
</Purpose>

<Use_When>
- User says "setup evor", "new evor mission", "evor setup", or provides a task description and wants to start a new evolution run
- No GoalContract exists for the stated mission, or the user explicitly wants to start fresh
- User invokes `/evor-setup` or `/oh-my-claudecode:evor-setup`
</Use_When>

<Do_Not_Use_When>
- A GoalContract already exists and the user wants to resume — use `evor-resume`
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
  Offer the user a choice before continuing:
  ```
  This workspace has existing ML artifacts. Run /oh-my-evor:evor-distill first for a
  detailed scan, or type 'skip' to continue the interview without pre-filling.
  ```
  - If the user agrees to distill: read and execute the evor-distill skill (equivalent to
    running `/evor-distill`), then read the resulting `starting-point.json`. Proceed to
    "Pre-fill" below.
  - If the user types 'skip': proceed directly to the interview with no pre-fill.

**Case C — `<evorRoot>/active-run.json` exists** (workspace_class = evor-active):
  Stop. Print:
  ```
  An active EVOR run was found in <evorRoot>/active-run.json.
  Use /evor-run to resume it, or delete active-run.json to start a new mission.
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
  Q5  Baseline:    <baseline_candidate.metric_name>=<baseline_candidate.claimed_value>
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
written into the GoalContract will be whatever EVOR measures on the frozen split during
setup — not this scraped number. Both the claimed value and the EVOR-measured value are
recorded; if they diverge by more than the tolerance threshold, EVOR will flag the
discrepancy in the decision log.
```

This is consistent with the Integrity Model: `BaselineCandidate.verified` stays `false`
until `verify_baseline_claim()` runs during setup / the first tick and produces the
measured value that becomes `GoalContract.baseline_value`.
</Phase_0_Distillation>

<Interview>
Conduct the following 14 questions in order. Ask Q1–Q8 sequentially (Q4a is always asked after Q4). Ask Q9 after Q8. Ask Q10–Q11 only if mission_type=open_ended. Always ask Q12. Ask Q13 only if mission_type=open_ended.

Display a progress indicator: "Question N/14" at the start of each question.

---

**Q1 — Mission name and task description**
"What are you trying to optimize? Describe the task in one or two sentences. This will become the mission ID."
→ Derive `mission_id` as kebab-slug from the description + current date (e.g., "cifar10-improve-2026-07").
→ Set `task_description`.

**Q2 — Dataset**
"Where is your dataset? Provide a filesystem path or URI. Is it already split into train/val/test?"
→ Set `dataset_ref`.
→ Note whether splits are pre-defined or need to be created by freeze.py.

**Q3 — Mode: from-scratch or seed-repo**
"Do you have an existing codebase (seed-repo mode) or are we starting from a blank PyTorch skeleton (from-scratch mode)?"
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
  3. Presents guards as `MetricConstraint` options — a violated constraint yields fitness=0.0.

Present options to the user:
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
→ Populate `MetricSpec.fitness_formula`, `MetricSpec.fbeta`, `MetricSpec.constraints[]`, and `MetricSpec.custom_metrics[]` as appropriate from the user's choice.
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
"How adventurous should Evor be in proposing mutations? 0.0 = conservative tweaks only, 0.5 = balanced exploration (default), 1.0 = paradigm-shifting proposals."
→ Set `wildness` (default 0.5).

---

**Q9 — Mission type: fixed or open-ended** (always ask after Q8)
"Is this a **fixed** mission (one frozen test suite throughout) or an **open-ended** mission (Evor can discover new evaluation angles and expand the benchmark as it evolves)?"
→ Set `mission_type`: "fixed" | "open_ended".
→ If fixed: proceed to Q12.
→ If open_ended: proceed to Q10.

**Q10 — SOTA sources and expansion policy** (only if open_ended)
"Which SOTA sources should count as authoritative for setting benchmark bars?
  (a) Papers With Code — leaderboard data, auto-retrieved
  (b) arXiv — paper-reported numbers, retrieved by Sage
  (c) Human-provided — you supply the bar manually
  (d) Custom URL — specify a leaderboard URL

Should new evaluation angles be auto-added within a domain family, or require your explicit consent per angle?"
→ Build `ExpansionPolicy.sota_sources[]`.
→ Set `auto_add_within_families[]` and `require_consent_for[]` based on user preference.
→ Set `ExpansionPolicy.max_angles_per_upgrade` (default 3).
→ Set `ExpansionPolicy.max_upgrades_per_N_ticks` (default {max_upgrades: 1, per_ticks: 5}).
→ Set `GoalContract.expansion_policy`.

**Q11 — Coverage target** (only if open_ended)
"What is your coverage target? For example, 0.95 means Evor stops when ≥95% of discovered evaluation angles meet or exceed their SOTA bar. (Default: 0.80)"
→ Set `coverage_target` (default 0.80).
→ Set `stop_condition.type`: "coverage-target".

**Q12 — License allowlist** (always ask)
"Which data licenses are acceptable for external dataset acquisition or synthetic data generation?

Default allowlist: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, CC-BY-4.0, CC0-1.0.

Type 'confirm' to accept defaults, or provide your custom list (SPDX identifiers, comma-separated). Any acquired data with a license outside this list will be rejected by the Ingestion Contamination Gate."
→ Set `GoalContract.allowed_licenses` (default list if confirmed, custom list if provided).

**Q13 — Compute budget confirmation** (only if open_ended; MUST be asked before consent checkpoint)
"Compute budget review:
  - Coverage target: [coverage_target from Q11]
  - Estimated ticks to coverage: [estimated = coverage_target / expected_ticks_per_angle_gain (use 0.05 per tick as default estimate)]
  - Estimated total cost: [GPU-hours × GPU rate if cloud; 'local — no direct cost' if local-only]

Do you confirm this budget is acceptable before the mission starts? (yes/no)

If you decline, the mission will not start. You can re-run evor-setup with a smaller coverage_target or fewer max_iterations."
→ Requires explicit "yes" to proceed.
→ If "no" or any decline: abort setup. Print: "Mission not started. Re-run /evor-setup with adjusted budget parameters."

</Interview>

<Lock_Policy>
ALL task-specific settings collected during the interview are LOCKED at setup time. This means:

- **Metrics and constraints** (Q4 + Q4a): `metric_specs[]`, `fitness_formula`, `fbeta`, `constraints[]`, `custom_metrics[]`, `fitness_mode` — immutable after GoalContract is written.
- **Dataset and splits** (Q2): `dataset_ref`, `locked_split_hash`, `eval_script_hash` — immutable; the frozen splits enforce this at the filesystem level (chmod 444).
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

<Frozen_Split_Setup>
After environment discovery, initialize frozen data splits (Addendum v2 Pillar 2):

```python
# Call via python_repl or subprocess:
PYTHONPATH="${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/harness${PYTHONPATH:+:$PYTHONPATH}" python -m evor.freeze freeze-splits \
  --dataset-path <dataset_ref> \
  --eval-version v1 \
  --run-dir .evor/runs/<mission-slug>/<run-id>/
```

This:
1. Creates FrozenSplit records for test and val splits.
2. Computes `per_sample_hashes` and `split_hash`.
3. Copies files to `frozen-splits/v1-test/` and `frozen-splits/v1-val/`.
4. Sets `chmod 444` on all frozen-split files (read-only enforcement).
5. Writes `frozen-splits/v1-test.json` and `frozen-splits/v1-val.json`.
6. Returns `locked_split_hash` = sha256 of the test split.

Set `GoalContract.locked_split_hash` from the returned value.
Compute `eval_script_hash` = sha256 of the evaluate.py script in the dataset/benchmark directory.
Set `GoalContract.eval_script_hash`.

Print confirmation: "Frozen splits initialized. locked_split_hash: <hash>. Files are read-only (chmod 444)."
</Frozen_Split_Setup>

<Materialize_Anchors>
## Materialize anchors (MANDATORY — no placeholders)

This step produces the real cryptographic anchors written into the GoalContract. NEVER write human-readable labels, version strings, or any non-hex text into `locked_split_hash` or `eval_script_hash`. The tick loop's integrity gate will reject them.

**locked_split_hash — real sha256 of the frozen test split:**

If `python -m evor.freeze freeze-splits` ran successfully it already returns this value — use it.
If the freeze module is unavailable or splits are baked into cached features/index arrays rather than files, compute from the sorted index list:

```bash
python -c "
import hashlib, json
# Replace with the actual sorted list of integer test-split indices
indices = sorted(<test_split_indices>)
blob = json.dumps(indices, separators=(',', ':')).encode()
print(hashlib.sha256(blob).hexdigest())
"
```

Set `GoalContract.locked_split_hash` to the 64-hex-char result.

**eval_script_hash — sha256 of the evaluate.py bytes (after any patches):**

```bash
python -c "
import hashlib
print(hashlib.sha256(open('<path_to_evaluate.py>', 'rb').read()).hexdigest())
"
```

Set `GoalContract.eval_script_hash` to the 64-hex-char result.

**Frozen-split manifests — must carry real hashes, not empty fields:**

After `freeze-splits`, verify:
- `frozen-splits/v1-test.json` exists and its `split_hash` field is a 64-hex-char string.
- `eval-suites/v1.json` will be written by EvalSuite_Initialization immediately after this section.

If `frozen_test.split_hash` is empty or absent, recompute from the sorted test index list (see above) and patch the file before continuing. An empty `split_hash` will fail the Phase-2 `frozen_splits_*` check.

**Class→domain mapping guard:**

If any `MetricConstraint` or guard in the contract references a class→domain mapping file (e.g., `class_domain_map.json`):
- Materialize that file now, from the available dataset.
- If it cannot be built at setup time, REMOVE the guard from the contract entirely. Only lock guards that are satisfiable from tick 1. A guard that references a file that does not exist will block every tick.

**POST-CONDITION (assert before proceeding to Validate_And_Lock):**

```python
import re

for field_name, field_val in [
    ("locked_split_hash", goal_contract.locked_split_hash),
    ("eval_script_hash",  goal_contract.eval_script_hash),
]:
    assert re.fullmatch(r'[0-9a-f]{64}', field_val or ''), (
        f"SETUP FAILED: {field_name}='{field_val}' is not a valid sha256 hex digest. "
        "Replace the placeholder with a real hash before continuing."
    )
```

Setup halts with a clear error if either field contains a label, a version string, an empty string, or any non-64-hex value. Do NOT proceed to `Validate_And_Lock` with a placeholder — the validator will reject it and the mission will not lock.
</Materialize_Anchors>

<EvalSuite_Initialization>
Create the initial EvalSuite v1 (Addendum v2 Pillar 3):

```python
PYTHONPATH="${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/harness${PYTHONPATH:+:$PYTHONPATH}" python -m evor.benchmark init-eval-suite \
  --mission-id <mission_id> \
  --eval-version v1 \
  --task-description "<task_description>" \
  --run-dir .evor/runs/<mission-slug>/<run-id>/
```

This:
1. Derives initial domains from `task_description` (e.g., for an image classification task: one domain per class cluster or data source if multi-source).
2. Creates an EvalSuite record with `created_by="user"`, `consent_log_ref` pointing to this setup session.
3. Writes `eval-suites/v1.json`.
4. Initializes `angle-registry.json` with one entry per initial domain.

Set `GoalContract.eval_version = "v1"`.
</EvalSuite_Initialization>

<Preflight_Smoke_Train>
Run a 5-step smoke-train to verify the environment is functional:

```bash
PYTHONPATH="${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/harness${PYTHONPATH:+:$PYTHONPATH}" python -m evor preflight --run-id <run_id>
```

The preflight runs a micro-train (10 random samples, 2-layer MLP, 5 steps) and verifies:
1. Loss at step 5 < loss at step 1 (training is working).
2. GPU util > 0% if GPU detected (GPU is accessible).
3. No OOM or import errors.

**On failure:** Print the full environment discovery report and prompt:
"Preflight failed: <error>. Do you want to override and proceed anyway? (yes/no)"
→ If "no": abort setup.
→ If "yes": note the override in the GoalContract metadata and proceed.

**On success:** Print: "Preflight passed. Training pipeline verified."
</Preflight_Smoke_Train>

<Launch_Consent_Checkpoint>
Before writing the final GoalContract and initializing the run, display a summary and require explicit consent. This checkpoint CANNOT be skipped.

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
Frozen splits:      initialized (locked_split_hash: <hash>)
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

Print: "Type 'start' to launch the mission, or 'abort' to cancel."
→ "start": proceed to Run_Initialization.
→ Any other response: abort. Print "Mission not started."
</Launch_Consent_Checkpoint>

<Run_Initialization>
After consent:

1. Generate `run_id` = `<mission_id>-<timestamp>` (e.g., "cifar10-improve-2026-07-20260703T142300").
2. Create run directory: `.evor/runs/<mission-slug>/<run-id>/`.
3. Write `GoalContract` to `.evor/runs/<mission-slug>/<run-id>/goal-contract.json`.
   Before writing, set the autonomy charter on the contract:
   ```python
   goal_contract.autonomy_charter = AutonomyCharter(
       posture="aggressive-never-halt",
       license_gate=False,
       data_acquisition_enabled=True,
   )
   ```
   Print: "Mission will run FULLY AUTONOMOUS to the goal — the monotonic-honesty invariant auto-decides every mid-run choice with no human questions."
4. Initialize `run-state.json`:
   ```json
   {
     "status": "initialized",
     "tick_count": 0,
     "best_score": null,
     "frontier_ids": [],
     "current_eval_version": "v1",
     "hypotheses": []
   }
   ```
5. Initialize `strategy.json` with defaults:
   ```json
   {
     "meta_iteration": 0,
     "selection_policy": "ucb1",
     "ucb1_c": 1.41,
     "wildness": <from GoalContract>,
     "family_mix": {"arch": 0.2, "training": 0.2, "data-curation": 0.15, "data-augmentation": 0.15, "data-acquisition": 0.1, "algo": 0.15, "other": 0.05},
     "winning_families": [],
     "wins_by_family": {},
     "meta_loop_interval": 5,
     "post_upgrade_exploration_boost": null,
     "post_upgrade_exploration_ticks": 0,
     "rescore_mode": "sync",
     "updated_at": "<ISO 8601>"
   }
   ```
6. Write `.evor/active-run.json`: `{"mission_id": "<id>", "run_id": "<id>", "run_dir": "<path>"}`.
7. Set environment variable `EVOR_ACTIVE_RUN_ID=<run_id>`.
8. Initialize empty `tree.json`: `{"nodes": {}, "updated_at": "<ISO 8601>"}`.
   (M2 fix: matches the DICT format written by mcp/src/tree-store.ts::writeTree())
9. Initialize `decision-log.md` with a header entry recording this setup session.
10. Write `mission-state.json` (Phase-2 gate — status starts as "draft", locked only after validate passes):
   ```json
   {
     "status": "draft",
     "objective": "<task_description from the GoalContract>",
     "current_tick": 0,
     "max_ticks": <budget.max_iterations>,
     "best_score": null,
     "best_node_id": null,
     "started_at": null,
     "updated_at": "<ISO 8601>"
   }
   ```

Print: "Mission initialized. Run ID: <run_id>. Running Phase-2 validation gate..."
Then proceed to Validate_And_Lock.
</Run_Initialization>

<Validate_And_Lock>
Run the Phase-2 enforcement gate and lock the contract before `/evor-run` is possible.

```bash
PYTHONPATH="${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/harness${PYTHONPATH:+:$PYTHONPATH}" python -m evor validate --run-id <run_dir>
```

**On pass (exit 0):**
Flip `mission-state.json` status `"draft"` → `"locked"`:
```bash
python -c "
import json; from pathlib import Path; from datetime import datetime, timezone
p = Path('<run_dir>/mission-state.json')
d = json.loads(p.read_text()); d['status'] = 'locked'
d['updated_at'] = datetime.now(timezone.utc).isoformat()
p.write_text(json.dumps(d, indent=2))
print('Mission locked.')
"
```
Print: "Phase-2 validation PASSED. Mission locked. Run ID: <run_id>. Start the tick loop with /evor-run."

**On fail (exit 1):**
Do NOT flip status. The mission stays at `"draft"` and cannot be started with `/evor-run`.
Print the failed check details from the validator JSON report (each `ok: false` check with its detail).
Print: "Phase-2 validation FAILED. Mission is NOT locked. Resolve the issues above, then re-run /evor-setup."

Remediation by failure type:
- `metric_gameability_*` failures → revise metric config (return to Q4a and pick a guarded metric)
- `goal_contract_schema` / `goal_contract_required_fields` → revisit the relevant interview question
- `frozen_splits_*` failures → re-run the Frozen_Split_Setup step
- `tree_json_*` failures → re-initialize tree.json with the DICT skeleton above
- `run_state_*` failures → re-initialize run-state.json above

Setup CANNOT complete with a draft/invalid contract. `/evor-run` will refuse to start until
`mission-state.status == "locked"`.
</Validate_And_Lock>

<Tool_Usage>
- python_repl — run freeze.py, benchmark init, preflight
- Bash — nvidia-smi, free, df, sha256sum
- Read / Write — goal-contract.json, run-state.json, strategy.json, tree.json
- evor_state_write — update run state after initialization
</Tool_Usage>
