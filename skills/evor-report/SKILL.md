---
name: evor-report
description: Generate a final Evor mission report with tree visualization, frontier table, and static HTML export
argument-hint: "[run-id]"
level: 2
skills: [oh-my-evor:evor-mcp]
---

<Purpose>
evor-report generates the final mission report for a completed or paused Evor run. It reads tree.json, renders an ASCII + graphviz tree with frontier nodes highlighted and eval_version annotations, produces a frontier table with metric deltas vs baseline, aggregates LessonEntry items from the wiki, and exports a self-contained static HTML file. The rendered PNG is delivered to the user via `SendUserFile`.
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

Call `evor_state_read` to retrieve the active run from `active-run.json`, or use the run-id argument to resolve the run directory directly. Print the run_id being reported on.

## Step 2 — Read Run State

Call `evor_state_read` to load run-state.json (tick_count, best_score, frontier_ids, current_eval_version) and strategy.json (final meta_iteration, ucb1_c, wildness, wins_by_family). Call `evor_read_goal_contract` to load baseline_value, target_value, stop_condition, and metrics.

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

Call `evor_plot_report({ run_id, run_dir, format: "ascii", highlight_frontier: true })` to produce the ASCII tree. Print the output. Each node shows: node_id (truncated), approach_family, eval_version, fitness_value, integrity_status, status.

Then call `evor_plot_report({ run_id, run_dir, format: "png", output: "<run_dir>/report/tree.png", highlight_frontier: true })` to generate the PNG for the HTML export.

After the PNG is written, call `SendUserFile("<run_dir>/report/tree.png")` to deliver the evolution tree visualization.

## Step 4 — Render Frontier Table

For each node_id in frontier_ids, call `evor_read_artifact({ run_id, agent: "forge", tick: <node_tick> })` and load `nodes/<node_id>/results.json` to render:

```
| Rank | Node ID | Family | Val Acc | Delta vs Baseline | Eval Version | Integrity | Lessons |
|------|---------|--------|---------|-------------------|--------------|-----------|---------|
|  1   | abc123  | arch   |  0.851  |      +12.3%       |     v2       |  passed   |    3    |
|  2   | def456  | training| 0.839  |      +10.7%       |     v2       |  passed   |    2    |
```

If per_domain data is available in EvaluationResult, render a secondary per-domain breakdown table.

## Step 5 — Aggregate Wiki Lessons

Call `evor_wiki_summarize({ run_id, run_dir, confirmed_only: false })` to retrieve lessons grouped by approach_family and hypothesis_verdict. Print:

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

Call `evor_plot_report({ run_id, run_dir, format: "html", output: "<run_dir>/report/index.html", include_frontier_table: true, include_lessons: true, include_strategy_summary: true })`.

The static HTML is self-contained (inline CSS/JS, base64-encoded tree PNG). Print:
```
Static report exported to: <run_dir>/report/index.html
Open with: open <run_dir>/report/index.html
```

Call `SendUserFile("<run_dir>/report/index.html")` to deliver the final report.

## Step 8 — Write Report Manifest

Write `<run_dir>/report/manifest.json`:
```json
{
  "generated_at": "<ISO 8601>",
  "run_id": "<run_id>",
  "mission_id": "<mission_id>",
  "tick_count": "N",
  "best_score": "X",
  "baseline_value": "Y",
  "frontier_size": "Z",
  "files": {
    "html": "report/index.html",
    "tree_png": "report/tree.png"
  }
}
```

</Steps>

<Tool_Usage>
- `evor_state_read` — load run-state.json and strategy.json
- `evor_read_goal_contract` — load goal-contract.json fields
- `evor_read_artifact` — read forge artifacts for frontier node details
- `evor_wiki_summarize` — aggregate wiki lessons by approach_family and verdict
- `evor_wiki_query` — retrieve individual lesson entries for the summary
- `evor_plot_report` — render ASCII tree, PNG, and static HTML (three separate calls with format param)
- `SendUserFile` — deliver tree PNG and HTML report to the user at completion
- `Write` — report/manifest.json
</Tool_Usage>
