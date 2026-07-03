---
description: Run the Evor mission setup interview to create a GoalContract and initialize run state
---

# /evor-setup

This command conducts the Evor mission setup interview, producing a GoalContract and initializing all run infrastructure.

## Dispatch

1. Read the full bundled skill instructions from `skills/evor-setup/SKILL.md`.
2. Follow that SKILL.md exactly, treating the user's arguments as:

```text
$ARGUMENTS
```

If the file is not directly readable from the current working directory, locate it under the active plugin root, then continue.

## Quick Reference

- Usage: `/evor-setup [mission description]`
- Conducts a 13-question Socratic interview covering: task, dataset, mode, metrics, baseline/target, budget, wildness, mission type (fixed vs open-ended), SOTA sources (open-ended only), coverage target (open-ended only), license allowlist, and compute budget confirmation (open-ended only)
- Initializes frozen data splits (Pillar 2) — files set to chmod 444
- Creates initial EvalSuite v1 (Pillar 3)
- Runs a preflight smoke-train to verify the environment
- Requires explicit "start" confirmation before writing any run state
- Output: `GoalContract` at `.evor/runs/<mission-slug>/<run-id>/goal-contract.json`
- After setup completes, run `/evor-run` to start the tick loop
