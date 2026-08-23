---
name: evor-doctor
description: Check environment health and .evor integrity; auto-repair obvious issues
argument-hint: "[run-dir] [--repair]"
skills: [oh-my-evor:evor-mcp]
---

<Purpose>
evor-doctor is the diagnostic and repair tool for the oh-my-evor environment and active
run state.  It checks: Python version, torch availability (GPU paths gated), Node.js
(required by hooks), env vars, GNU patch, evolution tree format, mission state,
orphaned pending nodes, and frozen-split integrity.
</Purpose>

<Use_When>
- User says "evor doctor", "check evor health", "diagnose evor", or invokes `/evor-doctor`
- Environment issues (torch not available, node missing, GPU not found)
- After a failed /evor-setup to diagnose what went wrong
- When `/evor-validate` reports infrastructure issues (corrupt files, missing directories)
- When orphaned pending nodes are blocking the stop hook
</Use_When>

<Do_Not_Use_When>
- User wants contract/schema validation — use `/evor-validate`
- User wants to start or resume a run — use `/evor-run`
</Do_Not_Use_When>

<Steps>

## Step 1 — Resolve arguments

Parse the argument for an optional run-dir path and `--repair` flag:
- No argument: run env-only checks (no .evor inspection).
- `<run_dir>`: run env + .evor checks for that specific run directory.
- `--repair`: pass the repair flag to auto-fix repairable issues.

## Step 2 — Run doctor

Call `evor_doctor` with the applicable arguments:

```
evor_doctor({})                              // env-only check
evor_doctor({ run_id: "<run_dir>" })         // env + .evor integrity check
evor_doctor({ run_id: "<run_dir>", repair: true })  // env + .evor + auto-repair
```

## Step 3 — Present the report

Parse the JSON output and present a categorised summary:

```
=== evor-doctor report ===

Environment
  ✓  python_version   — Python 3.11.4
  ✓  torch            — torch 2.1.0 importable
  ✓  node             — node v20.5.1
  ✓  env_evor_root    — EVOR_ROOT not set (will use default .evor/)
  ✓  patch            — patch found at /usr/bin/patch

.evor integrity (run: <run_dir>)
  ✓  run_dir          — run directory found and accessible
  ✓  tree_json        — DICT format (12 nodes)
  ⚠  mission_state    — mission state not found — run /evor-setup
  ✓  orphan_pending   — no orphaned pending nodes
  ✓  frozen_hash      — frozen-splits integrity confirmed

Verdict: OK — no errors detected
```

Status icons:
  ✓  ok       — check passed
  ⚠  warn     — warning (non-blocking; action recommended)
  ✗  error    — error (must be resolved)
  🔧 repaired — issue was auto-fixed with --repair

## Step 4 — Actions on issues

For each ERROR item, provide the remediation:

| Error | Remediation |
|-------|-------------|
| `python_version` < 3.10 | Upgrade Python or activate a 3.10+ environment |
| `torch` not importable | `pip install torch` or use a GPU-enabled environment |
| `node` missing | Install Node.js (required for hooks) |
| `mission_state` missing | Re-run `/evor-setup` to initialize mission state |
| `orphan_pending_nodes` | Use `/evor-doctor --repair` to clear orphaned state, or resolve the pending nodes through the normal tick workflow |
| `frozen_split_integrity` | Frozen splits were modified after locking — re-run `/evor-setup` |
| `run_dir` missing | Verify the run directory path |

For WARN items:
- `torch` warn: GPU training paths gated, but CPU-only runs still work

## Step 5 — Repair confirmation

If `--repair` was passed and repairs were made, display:
```
Repaired:
  🔧 <item>: <description of repair performed>

Re-run /evor-validate to confirm the contract is now valid.
```

</Steps>

<Tool_Usage>
- `evor_doctor` — run environment and .evor integrity diagnostics; pass `repair: true` to auto-fix
</Tool_Usage>
