---
name: evor-distill
description: Scan an existing ML workspace to produce a starting-point report; pre-fills the evor-setup interview
argument-hint: "[workspace-path]"
level: 3
---

<Purpose>
evor-distill scans an existing ML repository and produces a StartingPointReport written to `<evorRoot>/starting-point.json`. It classifies the workspace (greenfield / brownfield / evor-active / possibly-training), detects datasets, checkpoints, configs, and entry points, and scrapes any claimed metrics from READMEs or experiment logs. ALL scraped metrics and baseline candidates carry `verified: false` — EVOR will re-measure the baseline on the frozen split during setup and again on the first tick. The report pre-fills the evor-setup interview so the user confirms or edits pre-populated answers rather than typing from scratch.
</Purpose>

<Use_When>
- User says "distill evor", "evor distill", "scan my ML repo", or invokes `/evor-distill`
- An existing ML codebase is present and the user wants to start an EVOR mission on it
- The session-start hook emits a brownfield nudge suggesting `/oh-my-evor:evor-distill`
- User wants to understand what EVOR detected before committing to the setup interview
</Use_When>

<Do_Not_Use_When>
- A `.evor/active-run.json` already exists — the workspace is already an active EVOR mission; use `/evor-run` to resume
- The workspace is greenfield (no ML artifacts) — `evor-setup` works directly without distillation
- User wants contract/schema validation — use `/evor-validate`
- User wants environment health checks — use `/evor-doctor`
</Do_Not_Use_When>

<Steps>

## Step 1 — Resolve workspace and evor-root

Determine the workspace root and evor-root from arguments or defaults:
- `<workspace>`: use the argument if provided, else the current working directory.
- `<evorRoot>`: use `$EVOR_ROOT` if set, else `<workspace>/.evor`.

If `python -m evor` is not importable, stop and tell the user:
```
Module 'evor' not found. The harness must be on PYTHONPATH.
Run: bash install.sh   (or: pip install -e harness)
then retry /evor-distill.
```
Do not attempt to install automatically.

## Step 2 — Run the scanner

```bash
python -m evor.distill scan --root <workspace> --evor-root <evorRoot>
```

This writes `<evorRoot>/starting-point.json` and prints a human summary. Exit 0 on success — bad or permission-denied paths are skipped; the scanner never throws on malformed input.

If the command fails with a Python traceback (not an import error), show the last 20 lines of stderr and stop with:
```
evor-distill scan failed. Check that the workspace path is accessible and retry.
```

## Step 3 — Read starting-point.json

Read `<evorRoot>/starting-point.json` and present a concise brief to the user:

```
=== evor-distill report ===

Workspace:    <root>
Class:        <workspace_class>
Framework:    <framework or "unknown">
Task guess:   <task_guess or "—">

Datasets (<count>):
  <list up to 3 notable entries: path  (kind, ~size)>

Models (<count>):
  <list up to 3 notable entries: path  (format, arch_guess if known)>

Configs (<count>):
  <list up to 3 notable entries: path — notable hyperparams if present>

Entry points: <entry_points joined by ", " or "none detected">

Scraped metrics:
  <for each: source_path — metric=value (split_hint if present)  [UNVERIFIED]>
  (none found)

Baseline candidate:
  Model:  <model_path or "none">
  Metric: <metric_name>=<claimed_value>  [UNVERIFIED — scraped from repo]
  Source: <source>
  — or —
  (none detected)
```

If `warnings` in the report is non-empty, print each entry prefixed with `  ⚠ `.

## Step 4 — State the integrity framing

If a `baseline_candidate` is present (non-null), state clearly:

```
IMPORTANT: The baseline candidate value (<metric_name>=<claimed_value>) is UNVERIFIED.
It was scraped from the repository and has NOT been measured on a controlled split.
EVOR will re-measure it on the frozen split during /evor-setup (and on the first tick)
before it becomes the official baseline_value in the GoalContract.
Never treat a scraped metric as a proven starting point.
```

If `workspace_class` is `possibly-training`, add this warning:

```
WARNING: A checkpoint or experiment log was modified within the last 10 minutes.
A training run may currently be active. EVOR will not touch any files.
Wait for the active run to finish, then re-run /evor-distill and /evor-setup.
```

## Step 5 — Hand off to evor-setup

Print:

```
Starting-point report saved to: <evorRoot>/starting-point.json

Next step: run /oh-my-evor:evor-setup
evor-setup will read this report and pre-fill the interview (framework, dataset path,
model family hint, and baseline candidate) for you to confirm or edit.
```

</Steps>

<Tool_Usage>
- Bash — run `python -m evor.distill scan --root <workspace> --evor-root <evorRoot>`
- Read — parse starting-point.json
</Tool_Usage>
