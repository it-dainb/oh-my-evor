---
name: evor
description: Main 9-step Evor tick loop with meta-evolution, doom-loop detection, and parallel candidate scheduling
argument-hint: "[run-id]"
level: 4
---

<Purpose>
The evor skill runs the core evolution loop. Each tick executes 9 steps: Select → Ideate → Hypothesis Registration → Critique → Implement+Run → Evaluate+Integrity → Analyze+Learn → Record → Prune/Promote → Loop/Stop. After every `strategy.ucb1_meta_loop_interval` ticks (default 5), a meta-evolution pass updates strategy.json. The loop continues until a stop condition in GoalContract is met or the user cancels.
</Purpose>

<Use_When>
- The user runs `/evor` or `/evor-run` to start or continue a mission
- An active GoalContract exists in the current run state
- Called internally by `evor-run` after loading and validating the GoalContract
</Use_When>

<Do_Not_Use_When>
- No GoalContract exists — use `evor-setup` first
- The user wants to view the dashboard only — use `evor-dashboard`
- The user wants a final report — use `evor-report`
- The user wants to resume a paused run — use `evor-resume` (which calls this skill after restoring state)
</Do_Not_Use_When>

<Model_Routing>
| Agent | Model | Role |
|---|---|---|
| Evor (orchestrator) | opus | Tick coordination, meta-evolution decisions, doom-loop intervention |
| Sage | sonnet | Citation-backed SOTA research |
| Mutagen | sonnet | Mutation proposal generation |
| Probe | sonnet | Telemetry EDA, hypothesis verdict |
| Forge | sonnet | Genome materialization, code implementation |
| Selector | sonnet | 6-gate pre-execution critique |
| Quick lookups | haiku | Wiki queries, state reads, schema checks |
</Model_Routing>

<Parallel_Execution>
If `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set in the environment:
- Multiple Forge agents run in parallel, one per approved proposal (up to ResourcePlan.concurrency).
- Evor manages the shared task-board via `evor_state_write` for inter-agent coordination.
- Monitor tool is used to watch for `job_complete` or `self_heal_event` signals during compute-bound phases.

If the env var is unavailable, fall back to sequential candidate execution (concurrency=1): Forge agents run one at a time; Evor waits for each job_complete signal before starting the next.
</Parallel_Execution>

<Steps>

## Step 1 — Select

Read the current tree state via `evor_tree_read`. Apply UCB1 selection policy (or the current `strategy.json.selection_policy`) to choose the parent node(s) for this tick.

```
selected = evor_select(run_id, strategy=current_strategy, count=ResourcePlan.concurrency)
```

If the frontier has ≥2 nodes from distinct lineages with scores within 10% of each other, flag to Mutagen that a crossover proposal is eligible this tick.

## Step 2 — Ideate

Invoke Mutagen with the selected parent node(s) and current wildness:
- Mutagen generates N MutationProposal[] (N = concurrency, default 3).
- Mutagen emits investigation_queries[] for Sage.
- In parallel: invoke Sage with investigation_queries[] from Mutagen.
- Sage returns CitationBackedFinding[]; attach findings to the corresponding MutationProposal.citations[].

Run Mutagen and Sage in parallel when teams are available.

## Step 3 — Hypothesis Registration

For each MutationProposal returned by Mutagen:
- Confirm the Hypothesis is populated (statement + quantified prediction).
- Register the Hypothesis in the run state via `evor_state_write` (append to hypotheses[] list).
- Assign a hypothesis_id and set it on the MutationProposal.

## Step 4 — Critique

Invoke Selector with the full tick proposal set (all proposals from Step 2) and the current strategy.json:
- Selector evaluates all 6 gates for each proposal.
- Collect approved proposals. If zero proposals pass, trigger Doom-Loop_Detection.
- Log all rejections with rejection_reason to the decision log via `evor_state_write`.

## Step 5 — Implement + Run

For each approved proposal, invoke Forge:
- Forge materializes the genome, injects TelemetryCallback, stores delta, invokes harness.
- If parallel teams available: launch Forge agents concurrently; Monitor for job_complete signals.
- If sequential: run Forge agents one at a time.
- Append DecisionLogEntry for each node start: decision_type="implement", node_ids=[node_id].
- Call `evor_record_node` to register each new TreeNode in tree.json.

## Step 6 — Evaluate + Integrity

For each completed Forge job:
1. Harness writes EvaluationResult to nodes/<id>/results.json.
2. Call `evor_record_eval(run_id, node_id, result)` — this auto-triggers `evor_integrity_check`.
3. `evor_integrity_check` calls `integrity_bridge.py` via the MCP subprocess bridge and writes IntegrityReport to evaluations/<node-id>.json.
4. If IntegrityReport.verdict="failed": mark the node integrity_status="failed", skip promotion. Log failure_reason.
5. If passed: set node integrity_status="passed".

**Ingestion Contamination Gate** (data-acquisition nodes only):
- IntegrityGate checks acquisition_contamination_clear: no acquired sample collides with any frozen eval split.
- If false: node is rejected at integrity, never promoted to frontier.

## Step 7 — Analyze + Learn

For each node where integrity_status="passed":
- Invoke Probe with the node's telemetry.jsonl path and registered Hypothesis.
- Probe returns LessonEntry + hypothesis_verdict.
- Call `evor_wiki_add(run_id, lesson_entry)` to persist the LessonEntry.
- Update node.lesson_ids with the returned lesson_id.
- If Probe returns a BenchmarkUpgradeProposal:
  - Log it as a DecisionLogEntry (decision_type="meta-evolve").
  - Call BenchmarkManager.apply_upgrade() directly (Python method; no subprocess CLI — benchmark.py has no __main__ entry point).
  - If consent_granted=true (user confirmed): bump eval_version, rescore frontier nodes.

## Step 8 — Record

For all nodes this tick:
- Append DecisionLogEntry to decision-log.md (decision_type="record", node_ids=all_this_tick).
- Update run-state.json: increment tick count, update best_score if improved, update frontier_ids.
- Call `evor_state_write` with the run-state patch.

## Step 9 — Prune / Promote

1. **Promote** nodes with integrity_status="passed" to the frontier if fitness_value > current worst frontier node.
2. **Prune** nodes: remove nodes with status="done" AND integrity_status="failed" AND depth > pruning_depth_threshold (default 3) from active consideration. Never delete from tree.json — set status="pruned" only.
3. **Stop check**: evaluate GoalContract.stop_condition:
   - "beat-baseline": best_score > baseline_value → stop.
   - "target": best_score >= target_value → stop.
   - "maximize-under-budget": tick count >= budget.max_iterations → stop.
   - "worst-angle-plateau": worst-angle improvement < 1% over plateau_window ticks → stop.
   - "coverage-target": worst_angle_coverage >= coverage_target → stop.
   - "evolve-n": tick count >= n → stop.
   - "evolve-until-regression": best_score < previous best → stop.
   - Circuit breaker: budget.circuit_breaker consecutive failures → stop with warning.
4. If stop condition met: print final summary, call `evor-report` skill, exit loop.
5. If continuing: call Meta-Evolution check (see below), then return to Step 1.

## Step 9.5 — BenchmarkUpgrade Re-scoring (conditional)

If a BenchmarkUpgrade was applied in Step 7 and StrategyState.rescore_mode="sync":
- For all frontier nodes not yet scored under the new eval_version: run partial evaluation (`--eval-domains <new_domains>`).
- Merge cached per_domain scores (old domains) with new per_domain scores using BenchmarkRescore schema.
- Update fitness_value using GoalContract.fitness_mode.
- Nodes not re-scored within rescore_deadline_ticks are demoted to "v{old}-only" status.

If rescore_mode="async": schedule re-scoring jobs via evor_schedule without blocking the tick loop.

</Steps>

<Tick_Lifecycle>
Every tick follows this mandatory lifecycle wrapping all 9 steps.

**Tick Start — Read Prior Tick Handoff**
If `tick_count > 0`, read the prior tick's handoff before beginning Step 1:
```python
from evor.handoff import latest_tick_handoff
result = latest_tick_handoff(run_dir)
if result:
    prior_tick, handoff_text = result
    # incorporate handoff_text (lessons, dominant_family, next_tick_seed) into orchestrator context
```
This prevents re-proposing dead-end families and provides Mutagen with the `next_tick_seed` hint.

**Before Each Step N (1–9): Write tick-state.json**
Write `<run_dir>/tick-state.json` to mark the step in-progress before executing it:
```json
{
  "tick": <current_tick_number>,
  "current_step": <N>,
  "step_status": "running",
  "step_outputs": {},
  "updated_at": "<ISO 8601>"
}
```
Use `evor_state_write` or write directly. This enables step-level resumability: if the loop
is interrupted mid-tick, `evor-resume` reads `current_step` and restarts from that step.

**After Each Step N: Update step_status**
Update `tick-state.json` to mark the step done with a brief output summary:
```json
{
  "tick": <current_tick_number>,
  "current_step": <N>,
  "step_status": "done",
  "step_outputs": { "<key>": "<brief summary of step output>" },
  "updated_at": "<ISO 8601>"
}
```

**Tick End — Write Tick Handoff**
After Step 9 (before the stop-check / next-tick loop decision), write the tick handoff:
```python
from evor.handoff import write_tick_handoff
write_tick_handoff(run_dir, tick=current_tick_number, data={
    "tick": current_tick_number,
    "best_score": run_state["best_score"],
    "best_node_id": run_state.get("best_node_id"),
    "frontier_size": len(run_state.get("frontier_ids", [])),
    "nodes_this_tick": [n["node_id"] for n in nodes_this_tick],
    "lessons": [le["lesson_id"] for le in lessons_this_tick],
    "dominant_family": dominant_approach_family_this_tick,
    "next_tick_seed": "<brief hint for Mutagen: what to explore next based on Probe's lessons>",
    "strategy_state": {
        "wildness": strategy["wildness"],
        "selection_policy": strategy["selection_policy"],
        "meta_iteration": strategy["meta_iteration"]
    }
})
```
This handoff is read at the start of the next tick (above) and by Mutagen before proposing.

**Step-Level Resume Detection**
When the tick loop starts a new tick (or when `/evor-resume` invokes this skill), check
`tick-state.json` for an interrupted tick before executing Step 1:
```python
import json; from pathlib import Path
ts_path = Path(run_dir) / "tick-state.json"
if ts_path.exists():
    ts = json.loads(ts_path.read_text())
    resume_tick = ts.get("tick")
    resume_step = ts.get("current_step", 0)
    resume_status = ts.get("step_status", "done")
    current_tick = run_state.get("tick_count", 0)
    if resume_tick == current_tick and resume_status == "running" and resume_step < 9:
        # interrupted mid-tick — skip steps 1 through resume_step-1
        print(f"[evor] Resuming tick {resume_tick} from step {resume_step} (interrupted mid-tick)")
        start_step = resume_step  # re-run the interrupted step from the top
    else:
        start_step = 1  # fresh tick
else:
    start_step = 1
```
Re-run the interrupted step from its beginning (write tick-state with status="running" again).
Steps 1 through `start_step - 1` are treated as already completed for this tick.

**Why This Matters**
tick-state.json makes every tick resumable at the step level — an interrupted tick at step 5
restarts from step 5, not step 1. Tick handoffs compound learning across ticks: Mutagen reads
the prior handoff and avoids families proven ineffective; Probe's lessons accumulate across ticks
rather than being siloed to the current tick's context.
</Tick_Lifecycle>

<Meta_Evolution>
Every `strategy.json.meta_loop_interval` ticks (default 5), run:
```bash
python -m evor.tree meta-evolve --run-id <run_id>
```
This updates strategy.json fields: ucb1_c, wildness, family_mix, meta_iteration.
Log as DecisionLogEntry(decision_type="meta-evolve", strategy_delta=delta).

If a BenchmarkUpgrade was recently applied (post_upgrade_exploration_ticks > 0):
- Override wildness to strategy.post_upgrade_exploration_boost for post_upgrade_exploration_ticks remaining ticks.
- Decrement post_upgrade_exploration_ticks each tick.
- This exploration boost counteracts convergence risk after the benchmark expands (Risk D-2).
</Meta_Evolution>

<Doom_Loop_Detection>
Monitor for doom-loop conditions after Step 4 (Critique) in each tick:

**Trigger condition**: any of:
- 3 consecutive ticks where zero proposals passed Selector (all rejected).
- 3 consecutive ticks where Forge produced zero tool calls (harness never invoked).
- 3 consecutive ticks where all nodes were integrity_status="failed".

**Response**: immediately inject the following message into the orchestrator context before proceeding:

```
[DOOM-LOOP DETECTED: 3 consecutive ticks with no approved/runnable candidates. Forcing exploration mode.]
```

Then apply the following overrides for the next tick:
1. Set wildness override = 0.9 (maximum exploration) regardless of strategy.json.
2. Force approach_family diversity: require Mutagen to generate proposals from 3 distinct families.
3. If winning_families shows a monopoly (one family in last 5 entries), explicitly exclude that family for one tick.
4. Log the intervention as DecisionLogEntry(decision_type="meta-evolve", rationale="doom-loop intervention").

This pattern mirrors the malformed-tool detection pattern in `refs/ml-intern/agent/core/agent_loop.py`.
</Doom_Loop_Detection>

<Tool_Usage>
- `evor_tree_read` — read current tree state
- `evor_select` — UCB1 selection
- `evor_record_node` — write new TreeNode to tree.json
- `evor_record_eval` — write EvaluationResult, auto-trigger integrity check
- `evor_integrity_check` — run IntegrityGate
- `evor_wiki_add` — persist LessonEntry
- `evor_wiki_query` — query prior lessons (Sage uses this; orchestrator uses for context)
- `evor_state_read` / `evor_state_write` — run state management
- `evor_schedule` — submit jobs to ResourceScheduler
- `evor_cite` — attach citation to node
- `evor_telemetry_ingest` — validate + append TelemetryRecord[] to nodes/<id>/telemetry.jsonl
- Monitor — wait for job_complete or self_heal_event during compute-bound phases
- python_repl — meta-evolution, benchmark upgrade, preflight checks
</Tool_Usage>

<Execution_Policy>
- Evor (orchestrator) idles via Monitor during compute-bound Forge phases — do not poll.
- Wake on `job_complete` signal from harness or `self_heal_event` from SelfHealMonitor.
- Do not spawn more Forge agents than ResourcePlan.concurrency.
- Respect budget.max_wall_clock_hours and budget.max_gpu_hours if set.
- Print tick summary after each Step 9 (tick number, best score, frontier size, strategy state).
</Execution_Policy>
