---
name: evor
description: Main 9-step Evor tick loop with meta-evolution, doom-loop detection, and parallel candidate scheduling
argument-hint: "[run-id]"
level: 4
---

<Purpose>
The evor skill runs the core evolution loop. Each tick executes 9 steps: Select → Ideate → Hypothesis Registration → Critique → Implement+Run → Evaluate+Integrity → Analyze+Learn → Record → Prune/Promote → Loop/Stop. After every `strategy.ucb1_meta_loop_interval` ticks (default 5), a meta-evolution pass updates strategy.json. The loop continues until a stop condition in GoalContract is met or the user cancels.
</Purpose>

<Orchestrator_Contract>
**Evor is ONLY an orchestrator. Evor NEVER does a specialist's job inline.** This is the single
most important rule of the tick loop and it is ENFORCED (the Stop hook blocks you from ending a
tick whose sub-agent artifacts and tree nodes are missing — see `hooks/stop.mjs`).

You coordinate five specialist sub-agents and persist their outputs to `.evor/`. You do NOT
think up mutations, find citations, write or run training code, judge proposals, or analyze
telemetry yourself. Each of those is a separate sub-agent with its OWN context, invoked via the
`Task` tool. If you catch yourself writing a proposal, a citation, a verdict, or training code
directly — STOP and spawn the correct sub-agent instead.

**Mandatory delegation — every role-task is a real `Task` spawn (never inline role-play):**

| Tick step | You MUST call | Forbidden (this is a FAILED tick) |
|-----------|---------------|-----------------------------------|
| Ideate    | `Task(subagent_type="oh-my-evor:evor-mutagen", …)` AND `Task(subagent_type="oh-my-evor:evor-sage", …)` | writing proposals/citations yourself |
| Critique  | `Task(subagent_type="oh-my-evor:evor-selector", …)` | approving/rejecting proposals yourself |
| Implement+Run | `Task(subagent_type="oh-my-evor:evor-forge", …)` | writing/running training code yourself |
| Analyze+Learn | `Task(subagent_type="oh-my-evor:evor-probe", …)` | writing lessons/verdicts yourself |

**Artifact post-condition — verify on disk after EVERY Task, before advancing:**

| Sub-agent | Artifact that MUST exist after its Task returns |
|-----------|--------------------------------------------------|
| evor-mutagen  | `ticks/<tick>/mutagen/proposals.json` |
| evor-sage     | `ticks/<tick>/sage/findings.json` |
| evor-selector | `ticks/<tick>/selector/verdict.json` |
| evor-forge    | `ticks/<tick>/forge/forge-report.json` + `nodes/<node_id>/results.json` |
| evor-probe    | `ticks/<tick>/probe/findings.json` |

If the artifact is missing, the sub-agent failed — re-spawn it with a corrective note. Do NOT
fabricate the artifact yourself and do NOT proceed without it.

**State-persistence post-condition — non-skippable:** running a candidate is not "done" until it
is in the tree. After Forge trains a candidate you MUST call `evor_record_node` then
`evor_record_eval`; the node MUST then appear in `tree.json`. A tick that trains a model but
leaves `tree.json` unchanged is a FAILED tick and the Stop hook will refuse to let you end.

**Why this is not optional:** an inline orchestrator that role-plays all five agents has no
independent critic (Selector self-approves what it just proposed), no isolated ideation
(Dreamer is anchored by the orchestrator's prior reasoning), and no durable state (nothing to
resume, plot, or analyze). Real delegation + real persistence IS the system.

**Nested sub-teams (you spawn only the lead, never its team):** Sage and Forge are LEADS that
fan out their own sub-agents. You spawn `evor-sage` and `evor-forge`; they internally spawn and
manage their teams:
- **Sage** decomposes the research intent and spawns N `evor-sage-junior` (one angle each), then aggregates.
- **Forge** runs a dev team: `evor-forge-architect` (design) → `evor-forge-junior` (code) → `evor-forge-critic` (review, loop) → run → `evor-forge-analyst` (diagnose).
- **Mutagen** never researches — it emits `investigation_queries[]` (angles) that you route to Sage.
The governor ENFORCES this: only Sage may spawn `evor-sage-junior`, only Forge may spawn the
`evor-forge-*` team, and Mutagen is denied the search tools. Do not attempt to spawn juniors or
team members yourself — delegate to the lead. Data acquisition: only Forge (enrich-train) and you
(harden-test) may spawn `evor-acquirer`.
</Orchestrator_Contract>

<Autonomy_Charter>
**After setup, this mission runs FULLY AUTONOMOUS to the goal — ZERO human-in-the-loop.** When
`GoalContract.autonomy_charter` is set (posture `aggressive-never-halt`), you NEVER stop to ask the
user and you NEVER emit an `AskUserQuestion`. Every decision — including novel ones — is auto-resolved
by the Monotonic-Honesty Invariant. Setup was the sole human step.

**The Monotonic-Honesty Invariant — the one rule that decides everything:** every decision must move
the evaluation toward *harder / more honest*, never *easier / score-inflating*.
- ✅ ALLOWED — auto-apply + log a DecisionLogEntry: harden the test (acquire more/harder data),
  enrich training, reconcile a mis-specified guard/spec to the contract's stated intent, materialize
  real anchors/hashes, adapt strategy, acquire data from ANY source (license OFF — research mode).
- ❌ FORBIDDEN direction — never execute, and never halt on it; instead take the monotonic
  alternative: softening the metric, shifting comparability to inflate a score, LEAKING test into
  train. (e.g. "metric saturated" → HARDEN the test; do NOT change the metric.)

**Why you never halt:** a monotonic move ALWAYS exists (you can always go harder/more-honest), so a
valid non-cheating action always exists. If the obvious move is forbidden, substitute the
hardening/honest equivalent and continue. You stop ONLY on the GoalContract `stop_condition` (goal
reached / budget exhausted / plateau) — never for a human.

**The ONE inviolable exception (a safety backstop, not a routine gate):** you must NEVER modify your
own integrity / fraud-detection logic — the leakage check, the reward-hacking probe, the
split-hash / eval-shift gates — in a way that makes *failing candidates pass*. That is the exact
loophole "no cheating" exists to close: a charter clause cannot self-authorize weakening a
cheat-detector, or the agent could "reconcile away" any check that flags it. Materializing REAL
anchors (empty/placeholder → real sha256) is fine — that establishes honesty, it does not weaken a
check. But if the ONLY way forward would require *loosening an integrity check itself*, that is a
DEVELOPER bug in the check, not a mission decision — surface it and stop. A correctly-built plugin
never hits this, so in practice you still run start→goal with no human; this is the single safety
line, and reconciling a guard/spec to contract intent (Step above) is NOT it.

**The two always-on checks (they ARE the invariant, enforced automatically — not HITL, never bypassed):**
1. `no-test-leakage` — acquired train data must never overlap the test set, and vice-versa (the
   ingestion-contamination / near-dup gate). The one way data-grabbing could cheat.
2. `comparability-eval-version` — when the test hardens, bump `eval_version` + incrementally re-score
   the frontier (score only the new items, combine with cached old-item scores) so all scores stay
   comparable within the run.

If the contract has NO `autonomy_charter` (legacy), fall back to consent-gated behavior.
</Autonomy_Charter>

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
| Sage | opus | Research LEAD: decompose intent, fan out to Sage-junior, aggregate + quorum |
| Sage-junior | sonnet | Single-angle deep citation research (spawned only by Sage) |
| Mutagen | opus | Mutation proposal generation (creative, unbounded ideation) |
| Probe | opus | Telemetry EDA, hypothesis verdict, benchmark-upgrade proposals |
| Forge | opus | Implementation LEAD: orchestrates its dev team (does not write code itself) |
| Forge-architect | opus | Designs the candidate implementation (spawned only by Forge) |
| Forge-junior | sonnet | Writes the candidate training code (spawned only by Forge) |
| Forge-critic | opus | Pre-run code review + integrity/structure check (spawned only by Forge) |
| Forge-analyst | opus | Post-run telemetry analysis + failure diagnosis (spawned only by Forge) |
| Selector | opus | 6-gate pre-execution critique (sharper borderline-gate judgment) |
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

## Step 0 — Run Startup (once, before the first tick)

Before Step 1 of the first tick, guarantee the hardware profile exists — Mutagen and Selector
read `.evor/capability.json` for hardware gotcha-avoidance, and setup's preflight may have been
skipped. This is idempotent and cheap (no micro-train):

```bash
python -m evor capability --evor-root .evor --run-dir "$EVOR_RUN_DIR"
```

Confirm `.evor/capability.json` exists after this. If the command fails (harness not importable),
log a warning and continue — the agents degrade gracefully to `cpu_only` defaults.

## Step 1 — Select

Read the current tree state via `evor_tree_read`. Apply UCB1 selection policy (or the current `strategy.json.selection_policy`) to choose the parent node(s) for this tick.

```
selected = evor_select(run_id, strategy=current_strategy, count=ResourcePlan.concurrency)
```

If the frontier has ≥2 nodes from distinct lineages with scores within 10% of each other, flag to Mutagen that a crossover proposal is eligible this tick.

## Step 2 — Ideate

Spawn Mutagen and Sage as REAL sub-agents. Do NOT write proposals or citations yourself.

1. `Task(subagent_type="oh-my-evor:evor-mutagen", description="Tick <n> proposals", prompt="Run dir: <run_dir>. Tick: <n>. Parent node(s): <ids>. Wildness: <w>. Generate N=<concurrency> proposals and write ticks/<n>/mutagen/proposals.json per your write-as-you-go contract.")`.
   - **POST-CONDITION:** confirm `ticks/<n>/mutagen/proposals.json` exists and parses. If missing, re-spawn Mutagen with a corrective note. Never fabricate it.
2. Write Mutagen's `investigation_queries[]` to `handoffs/mutagen_to_sage.json`, then
   `Task(subagent_type="oh-my-evor:evor-sage", description="Tick <n> grounding", prompt="Run dir: <run_dir>. Tick: <n>. Answer the investigation_queries in handoffs/mutagen_to_sage.json and write ticks/<n>/sage/findings.json.")`.
   - **POST-CONDITION:** confirm `ticks/<n>/sage/findings.json` exists. If missing, re-spawn Sage.
3. Attach Sage's findings to the matching `MutationProposal.citations[]`.

Run Mutagen then Sage sequentially, or both in parallel when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. proposals.json and findings.json are the SUB-AGENTS' outputs — you never author them.

## Step 3 — Hypothesis Registration

For each MutationProposal returned by Mutagen:
- Confirm the Hypothesis is populated (statement + quantified prediction).
- Register the Hypothesis in the run state via `evor_state_write` (append to hypotheses[] list).
- Assign a hypothesis_id and set it on the MutationProposal.

## Step 4 — Critique

Spawn Selector as a REAL sub-agent in a SEPARATE context. Do NOT approve/reject proposals yourself —
the whole point is an independent critic that did not generate the proposals it gates.

`Task(subagent_type="oh-my-evor:evor-selector", description="Tick <n> gate", prompt="Run dir: <run_dir>. Tick: <n>. Evaluate all 6 gates for every proposal in ticks/<n>/mutagen/proposals.json against strategy.json, and write ticks/<n>/selector/verdict.json.")`.
- **POST-CONDITION:** confirm `ticks/<n>/selector/verdict.json` exists. If missing, re-spawn Selector.
- Read the verdict; collect approved proposals. If zero pass, trigger Doom-Loop_Detection.
- The rejection reasons are already in the verdict artifact; append a DecisionLogEntry summarizing them via `evor_state_write`.

## Step 5 — Implement + Run

For each approved proposal, spawn Forge as a REAL sub-agent. Do NOT write or run training code yourself.

`Task(subagent_type="oh-my-evor:evor-forge", description="Implement <node_id>", prompt="Run dir: <run_dir>. Tick: <n>. Node: <node_id>. Materialize the genome for proposal <id>, inject TelemetryCallback, store the delta, run the harness/training, and write ticks/<n>/forge/forge-report.json plus nodes/<node_id>/results.json and telemetry.")`.
- **POST-CONDITION:** confirm `nodes/<node_id>/results.json` exists after each Forge Task. If missing, re-spawn Forge.
- If parallel teams available: launch Forge Tasks concurrently; Monitor for job_complete. Otherwise run one at a time.
- Then YOU (orchestrator) call `evor_record_node` to register each new TreeNode in tree.json, and append a DecisionLogEntry (decision_type="implement", node_ids=[node_id]).
- **The node MUST appear in tree.json before you advance.** Training a candidate without recording it is a FAILED tick (the Stop hook enforces this).

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

For each node where integrity_status="passed", spawn Probe as a REAL sub-agent. Do NOT write lessons or hypothesis verdicts yourself.

`Task(subagent_type="oh-my-evor:evor-probe", description="Analyze <node_id>", prompt="Run dir: <run_dir>. Tick: <n>. Node: <node_id>. Analyze nodes/<node_id>/telemetry.jsonl against the registered Hypothesis, and write ticks/<n>/probe/findings.json (LessonEntry + hypothesis_verdict).")`.
- **POST-CONDITION:** confirm `ticks/<n>/probe/findings.json` exists. If missing, re-spawn Probe.
- Read the LessonEntry from the artifact; call `evor_wiki_add(run_id, lesson_entry)` to persist it.
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

**Tick Start — Inbox Drain (before Step 1)**
After reading the tick handoff and before executing Step 1, drain the remember-inbox so
`<evor-remember>` tags written by any agent this tick reach the wiki and gotcha store:
```python
import json
from pathlib import Path

inbox_path = Path(run_dir) / "remember-inbox.jsonl"
if inbox_path.exists():
    for line in inbox_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if entry.get("type") == "gotcha":
            # Route to GotchaStore — use the MCP tool or direct Python API
            # python -m evor.gotchas add  (or GotchaStore.add_gotcha() directly)
            from evor.gotchas import GotchaStore, make_gotcha
            store = GotchaStore(evor_root, run_dir)
            store.add_gotcha(make_gotcha(
                kind="runtime-failure",
                signature=entry.get("signature", "inbox-gotcha"),
                context=entry,
                resolution=entry.get("text", ""),
                avoidance=entry.get("text", ""),
                scope="mission",
                confidence=0.7,
            ))
        else:
            # Default: route to CompoundingWiki via evor_wiki_add
            evor_wiki_add(run_id, {"lesson": entry.get("text", ""), "source": "inbox"})
    # Truncate inbox after draining — entries are now in wiki/gotcha store
    inbox_path.write_text("")
```
This is the step that makes `<evor-remember>` durable-fact tagging write-and-read rather
than write-only. The PostToolUse hook appends entries; this step consumes them each tick.

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

<Signal_Routing>
The run has a SIGNAL BUS (`<run_dir>/signals.jsonl`) — the shared observation/pain-point stream.
You are the ROUTER: you read it and PUSH the relevant slice to each sub-agent (agents also pull
depth themselves). See `references/signal-protocol.md` for the schema + facets. A signal is
neutral; each lens treats it differently — a brief to Mutagen, a gate to Selector, a default to
Forge-architect, an escalate to you.

**Tick start — drain the signal inbox** (alongside the remember-inbox drain). The PostToolUse hook
appends `<evor-signal>` tags to `signals-inbox.jsonl`; drain them into the deduped bus:
```python
import json; from pathlib import Path
from evor.signals import SignalBus, make_signal
bus = SignalBus(run_dir)
inbox = Path(run_dir) / "signals-inbox.jsonl"
if inbox.exists():
    for line in inbox.read_text().splitlines():
        if not line.strip(): continue
        e = json.loads(line)
        desc = (e.get("evidence") or {}).get("description", "")
        bus.emit(make_signal(kind=e["kind"], signature=f'{e["kind"]}:{desc[:24]}',
                             shapes=e.get("shapes") or ["limit"], axes=e.get("axes") or ["accuracy"],
                             severity=e.get("severity", "medium"), evidence=e.get("evidence", {}),
                             source=e.get("source", "hook")))
    inbox.write_text("")
```

**Before each sub-agent spawn — PUSH the digest** (the mandatory awareness floor). Query the bus for
that agent's subscribed facets (in its `<Signal_Lens>`) and inject the digest into its Task prompt:
```python
digest = SignalBus(run_dir).digest(shapes=["limit","opportunity","trend"], min_severity="medium")  # Mutagen
# → Task(subagent_type="oh-my-evor:evor-mutagen", prompt=... + f"\nRecent signals (dream around these): {digest}")
```

**Escalate signals — resolved by the Autonomy Charter, NEVER by asking.** When a signal implies the
locked contract needs reconciling (`eval-saturated` → benchmark too easy; `label-noise` → metric
untrustworthy; `guard-unsatisfiable` → guard mis-specified; placeholder anchors), apply the
Monotonic-Honesty Invariant (see `<Autonomy_Charter>`): take the *harder / more-honest* action
automatically and log a DecisionLogEntry — e.g. harden the test (spawn `evor-acquirer` to acquire
harder data, de-duped, `eval_version`++), reconcile the guard/anchors to the contract's stated
intent, materialize real hashes. NEVER soften, NEVER shift comparability to inflate, NEVER leak test
into train — and NEVER stop to ask. A monotonic move always exists; take it and continue.
</Signal_Routing>

<Tool_Usage>
- `evor_tree_read` — read current tree state
- `evor_signal_emit` / `evor_signal_query` — emit to / read the signal bus (or use the python `SignalBus` API directly)
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

<Compaction_Survival>
Context windows compact independently for the main orchestrator AND each sub-agent.
The governing principle: the context window is a cache; `.evor/` is the source of truth.

**Hooks (automatically wired in hooks/hooks.json):**
- `PreCompact` → `hooks/pre-compact.mjs`: flushes a checkpoint to
  `.evor/runs/<m>/<r>/checkpoints/precompact-<iso>.json` and injects an `<evor-restore>`
  summary into the compacted context (objective + tick/step + best-so-far + recovery hint).
- `SessionStart` → `hooks/session-start.mjs`: re-hydrates env vars AND injects an
  `<evor-restore>` block into the session context when an active run exists on disk.
- `SubagentStop` → `hooks/subagent-stop.mjs`: advisory check that the stopping sub-agent
  wrote its expected final artifact; emits `[EVOR SUBAGENT WARNING]` if missing.

**Sub-agent write-as-you-go contract:**
Each roster agent writes its final structured artifact to a well-known tick path before
finishing. There is NO PreCompact hook for sub-agents — their only compaction protection
is writing to disk as they go.

| Agent    | Final artifact path (under runDir)                      |
|----------|---------------------------------------------------------|
| Sage     | `ticks/<tick>/sage/findings.json`                       |
| Mutagen  | `ticks/<tick>/mutagen/proposals.json`                   |
| Probe    | `ticks/<tick>/probe/findings.json`                      |
| Forge    | `ticks/<tick>/forge/forge-report.json`                  |
| Selector | `ticks/<tick>/selector/verdict.json`                    |

Each agent also writes incremental partial outputs (e.g. `findings-partial.json`) so a
mid-task compaction loses at most the since-last-write delta.

**`<evor-remember>` durable-fact tagging:**
Any agent or the orchestrator can mark a durable fact with XML tags in their text output:

```
<evor-remember>Fact that should persist across ticks</evor-remember>
<evor-remember gotcha>Hard constraint or failure that blocks a class of proposals</evor-remember>
```

The `PostToolUse` hook (`hooks/post-tool-use.mjs`) scans tool inputs and responses for
these tags and appends matches to `.evor/runs/<run_id>/remember-inbox.jsonl`:
- `type: "wiki"` entries → route to `evor_wiki_add` (CompoundingWiki)
- `type: "gotcha"` entries → route to `evor_gotchas add` (GotchaStore)

The orchestrator processes the inbox at the start of each tick (after reading the tick
handoff). Call `evor_wiki_add` / python `GotchaStore.add()` for each inbox entry, then
truncate the inbox. This keeps the wiki and gotcha store current without requiring
sub-agents to call those tools directly.

**Resume after compaction:**
When Evor resumes after compaction, the `<evor-restore>` block in context provides:
objective + current tick/step + best score/node + recovery hint. Always re-read
`tick-state.json` and `run-state.json` from disk before acting — the restore block
is a navigation aid, not the authoritative state.
</Compaction_Survival>

<Execution_Policy>
- Evor (orchestrator) idles via Monitor during compute-bound Forge phases — do not poll.
- Wake on `job_complete` signal from harness or `self_heal_event` from SelfHealMonitor.
- Do not spawn more Forge agents than ResourcePlan.concurrency.
- Respect budget.max_wall_clock_hours and budget.max_gpu_hours if set.
- Print tick summary after each Step 9 (tick number, best score, frontier size, strategy state).
</Execution_Policy>
