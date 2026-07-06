---
name: evor-validate
description: Run the Phase-2 contract/state validator against an active evor run directory and present the report
argument-hint: "[run-dir or run-id]"
level: 2
---

<Purpose>
evor-validate runs the deterministic Phase-2 enforcement gate against a run directory:
validates goal-contract.json (schema + gameability guards), frozen-splits (existence +
split_hash), tree.json (DICT format), and run-state.json (well-formed).  The gate is
pass/fail with a structured JSON report and clear per-check reasons.

Two-layer gameability check:
  Layer 1 (rule-registry): fast metric-name pre-check — always runs.
  Layer 2 (empirical probe): degenerate-predictor probe over frozen eval labels —
    runs when frozen-splits/*-test/labels.json is present, skipped gracefully otherwise.
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
1. Check `.evor/active-run.json` for the current active run.
2. If found: use `run_dir` from that file.
3. If not found: list available runs under `.evor/runs/` and prompt the user.

## Step 2 — Run the validator

```bash
PYTHONPATH="${EVOR_PLUGIN_ROOT:-$CLAUDE_PLUGIN_ROOT}/harness${PYTHONPATH:+:$PYTHONPATH}" python -m evor validate --run-id <run_dir>
```

The validator exits 0 (VALID) or 1 (INVALID) and prints a JSON report to stdout.

## Step 3 — Present the report

Parse the JSON output and present a structured summary:

```
=== evor-validate report ===

Status: VALID ✓  /  INVALID ✗

Checks:
  ✓  goal_contract_exists          — goal-contract.json found
  ✓  goal_contract_parseable       — JSON parsed
  ✓  goal_contract_schema          — schema validation passed
  ✓  goal_contract_required_fields — all required fields present
  ✓  goal_contract_stop_defined    — stop condition present
  ✓  metric_gameability_registry   — no unguarded gameable metrics (rule-registry)
  ✓  metric_gameability_probe      — no degenerate predictor reached threshold (probe)
  ✓  frozen_splits_dir             — frozen-splits/ directory found
  ✓  frozen_splits_test_json       — test split JSON found
  ✓  frozen_splits_hash            — split_hash present
  ✓  tree_json_exists              — tree.json found
  ✓  tree_json_parseable           — JSON parsed
  ✓  tree_json_dict_format         — DICT format confirmed
  ✓  run_state_exists              — run-state.json found
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
- If `mission-state.json` status is `"draft"`: prompt the user to flip it to `"locked"`:
  ```bash
  python -c "
  import json; from pathlib import Path; from datetime import datetime, timezone
  p = Path('<run_dir>/mission-state.json')
  d = json.loads(p.read_text()); d['status'] = 'locked'; d['updated_at'] = datetime.now(timezone.utc).isoformat()
  p.write_text(json.dumps(d, indent=2))
  print('Mission state locked.')
  "
  ```
- Print: "Contract is VALID. Mission is ready to run with /evor-run."

</Steps>

<Tool_Usage>
- Bash — run `python -m evor validate --run-id <run_dir>`
- Read — parse the JSON output
- evor_state_read — read active-run.json for run resolution
</Tool_Usage>
