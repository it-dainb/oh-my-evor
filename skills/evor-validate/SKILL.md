---
name: evor-validate
description: Run the Phase-2 contract/state validator against an active evor run directory and present the report
argument-hint: "[run-dir or run-id]"
level: 2
skills: [oh-my-evor:evor-mcp]
---

<Purpose>
evor-validate runs the deterministic Phase-2 enforcement gate against a run directory:
validates the goal contract (schema + gameability guards), frozen-splits (existence +
split integrity), evolution tree format, and run state.  The gate is
pass/fail with a structured JSON report and clear per-check reasons.

Two-layer gameability check:
  Layer 1 (rule-registry): fast metric-name pre-check — always runs.
  Layer 2 (empirical probe): degenerate-predictor probe over frozen eval labels —
    runs when the frozen test labels are present, skipped gracefully otherwise.
</Purpose>

<Use_When>
- User says "validate evor", "check evor contract", "evor validate", or invokes `/evor-validate`
- After `/evor-setup` completes, before starting `/evor-run` (called automatically by setup)
- When a run is suspected to have a broken or gameable contract
- Before submitting a run for review or sharing results
</Use_When>

<Do_Not_Use_When>
- User wants to run the tick loop — use `/evor-run`
- User wants environment / .evor integrity checks — use `/evor-doctor`
- No run directory exists yet — use `/evor-setup` first
</Do_Not_Use_When>

<Steps>

## Step 1 — Resolve the run directory

If an argument was provided, treat it as the run directory path or run-id.
Otherwise:
1. Call `evor_state_read` to retrieve the current active run.
2. If found: use `run_dir` from the result.
3. If not found: prompt the user to provide a run directory or run-id.

## Step 2 — Run the validator

Call `evor_validate({ run_id: "<run_dir>" })`.

The tool returns a structured report with `valid: true` or `valid: false` and per-check details.

## Step 3 — Present the report

Parse the JSON output and present a structured summary:

```
=== evor-validate report ===

Status: VALID ✓  /  INVALID ✗

Checks:
  ✓  goal_contract_exists          — goal contract found
  ✓  goal_contract_parseable       — JSON parsed
  ✓  goal_contract_schema          — schema validation passed
  ✓  goal_contract_required_fields — all required fields present
  ✓  goal_contract_stop_defined    — stop condition present
  ✓  metric_gameability_registry   — no unguarded gameable metrics (rule-registry)
  ✓  metric_gameability_probe      — no degenerate predictor reached threshold (probe)
  ✓  frozen_splits_dir             — frozen-splits directory found
  ✓  frozen_splits_test_json       — test split found
  ✓  frozen_splits_hash            — split integrity verified
  ✓  tree_json_exists              — evolution tree found
  ✓  tree_json_parseable           — JSON parsed
  ✓  tree_json_dict_format         — DICT format confirmed
  ✓  run_state_exists              — run state found
  ✓  run_state_well_formed         — required fields present
```

For failed checks, show the detail message prominently:
```
  ✗  metric_gameability_registry   — primary metric 'recall' is trivially gameable
     Detail: predict-all-positive achieves recall=1.0; add a precision constraint or
             fitness_formula guard. Suggested: constraints=[{metric:precision, op:>=, threshold:0.5}]
```

## Step 4 — Action on failure

If the report shows INVALID:
- List each failed check and its remediation.
- For gameability failures: show the suggested guard configuration.
- For schema failures: show the specific field that failed.
- Redirect to `/evor-setup` if the contract needs to be rebuilt.
- Redirect to `/evor-doctor` for infrastructure issues (missing files, corrupt JSON).

If the report shows VALID:
- Call `evor_lock_mission({ run_id })` to lock the mission so the tick loop can start.
- Print: "Contract is VALID. Mission is ready to run with /evor-run."

</Steps>

<Tool_Usage>
- `evor_state_read` — read active run for run resolution
- `evor_validate` — Phase-2 enforcement gate; returns structured pass/fail report
- `evor_lock_mission` — validate and lock the mission on pass
</Tool_Usage>
