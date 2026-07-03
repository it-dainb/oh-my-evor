---
name: evor-report
description: Generate a final Evor mission report with tree visualization, frontier table, and static HTML export
argument-hint: "[run-id]"
level: 2
---

<Purpose>
evor-report generates the final mission report for a completed or paused Evor run. It reads tree.json, renders an ASCII + graphviz tree with frontier nodes highlighted and eval_version annotations, produces a frontier table with metric deltas vs baseline, aggregates LessonEntry items from the wiki, and exports a self-contained static HTML file.
</Purpose>

<Use_When>
- User says "report", "generate report", "final report", or invokes `/evor-report`
- The evor tick loop exits due to a stop condition (called automatically by the evor skill after Step 9)
- User wants a snapshot report of a running mission's current state
</Use_When>

<Do_Not_Use_When>
- User wants a live dashboard — use `evor-dashboard`
- No run directory exists — redirect to `/evor-setup`
</Do_Not_Use_When>

<Steps>

## Step 1 — Resolve Run Directory

Read `.evor/active-run.json` for the active run, or use the run-id argument to resolve `.evor/runs/<mission-slug>/<run-id>/`. Print the run_id being reported on.

## Step 2 — Read Run State

Load:
- `run-state.json` — tick_count, best_score, frontier_ids, current_eval_version
- `goal-contract.json` — baseline_value, target_value, stop_condition, metrics
- `strategy.json` — final meta_iteration, ucb1_c, wildness, wins_by_family

Print run summary header:
```
=== Evor Mission Report ===
Mission:        <mission_id>
Run ID:         <run_id>
Status:         <status>
Ticks:          <tick_count>
Best score:     <best_score> (baseline: <baseline_value>, delta: +X%)
Frontier size:  <len(frontier_ids)>
Eval version:   <current_eval_version>
Stop reason:    <from run-state or "in-progress snapshot">
```

## Step 3 — Render Evolution Tree

```bash
python -m evor.plot_tree \
  --run-id <run_id> \
  --run-dir <run_dir> \
  --format ascii \
  --highlight-frontier
```

Print the ASCII tree output. Each node shows: node_id (truncated), approach_family, eval_version, fitness_value, integrity_status, status.

Then generate a PNG for the HTML export:
```bash
python -m evor.plot_tree \
  --run-id <run_id> \
  --run-dir <run_dir> \
  --format png \
  --output <run_dir>/report/tree.png \
  --highlight-frontier
```

## Step 4 — Render Frontier Table

For each node_id in frontier_ids, load `nodes/<node_id>/results.json` and render:

```
| Rank | Node ID | Family | Val Acc | Delta vs Baseline | Eval Version | Integrity | Lessons |
|------|---------|--------|---------|-------------------|--------------|-----------|---------|
|  1   | abc123  | arch   |  0.851  |      +12.3%       |     v2       |  passed   |    3    |
|  2   | def456  | training| 0.839  |      +10.7%       |     v2       |  passed   |    2    |
```

If per_domain data is available in EvaluationResult, render a secondary per-domain breakdown table.

## Step 5 — Aggregate Wiki Lessons

```bash
python -m evor.wiki summarize \
  --run-id <run_id> \
  --run-dir <run_dir> \
  --confirmed-only false
```

Group lessons by approach_family and hypothesis_verdict. Print:

```
=== Compounding Wiki Summary ===
Confirmed hypotheses: N
Refuted hypotheses: M
Inconclusive: K

Top lessons by family:
  arch:
    - [lesson-id] "Residual connections improved gradient flow..." (confirmed)
  training:
    - [lesson-id] "Cosine LR schedule outperformed step decay..." (confirmed)
```

## Step 6 — Strategy Evolution Summary

Print how strategy.json evolved over the run:
```
=== Strategy Evolution ===
Meta iterations: <meta_iteration>
Final UCB1 c: <ucb1_c>
Final wildness: <wildness>
Wins by family: arch=12, training=8, data-augmentation=5, ...
```

## Step 7 — Export Static HTML

```bash
python -m evor.plot_tree \
  --run-id <run_id> \
  --run-dir <run_dir> \
  --format html \
  --output <run_dir>/report/index.html \
  --include-frontier-table \
  --include-lessons \
  --include-strategy-summary
```

The static HTML is self-contained (inline CSS/JS, base64-encoded tree PNG). Print:
```
Static report exported to: <run_dir>/report/index.html
Open with: open <run_dir>/report/index.html
```

## Step 8 — Write Report Manifest

Write `<run_dir>/report/manifest.json`:
```json
{
  "generated_at": "<ISO 8601>",
  "run_id": "<run_id>",
  "mission_id": "<mission_id>",
  "tick_count": N,
  "best_score": X,
  "baseline_value": Y,
  "frontier_size": Z,
  "files": {
    "html": "report/index.html",
    "tree_png": "report/tree.png"
  }
}
```

</Steps>

<Tool_Usage>
- Bash — python -m evor.plot_tree, python -m evor.wiki summarize
- Read — run-state.json, goal-contract.json, strategy.json, nodes/<id>/results.json
- evor_wiki_query — retrieve lesson entries for the summary
- evor_state_read — read final run state
- Write — report/manifest.json
</Tool_Usage>
