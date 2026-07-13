---
name: evor
description: Main 9-step Evor tick loop with meta-evolution, doom-loop detection, and parallel candidate scheduling
argument-hint: "[run-id]"
level: 4
skills: [oh-my-evor:evor-mcp]
---

<Purpose>
The evor skill runs the core evolution loop. Each tick executes 9 steps: Select → Ideate → Hypothesis Registration → Critique → Implement+Run → Evaluate+Integrity → Analyze+Learn → Record → Prune/Promote → Loop/Stop. After a configurable interval of ticks, a meta-evolution pass updates the selection strategy. The loop continues until a stop condition in the mission contract is met or the user cancels.
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

**Artifact post-condition — verify via MCP after EVERY Task, before advancing:**

| Sub-agent | Artifact check |
|-----------|----------------|
| evor-mutagen  | `evor_read_artifact({ run_id, tick, agent: "mutagen" })` — `{error:"not found"}` → re-spawn |
| evor-sage     | `evor_read_artifact({ run_id, tick, agent: "sage" })` — `{error:"not found"}` → re-spawn |
| evor-selector | `evor_read_artifact({ run_id, tick, agent: "selector" })` — `{error:"not found"}` → re-spawn |
| evor-forge    | `evor_read_artifact({ run_id, tick, agent: "forge" })` — `{error:"not found"}` → re-spawn |
| evor-probe    | `evor_read_artifact({ run_id, tick, agent: "probe" })` — `{error:"not found"}` → re-spawn |

If an artifact is missing, the sub-agent failed — re-spawn it with a corrective note. Do NOT
fabricate the artifact yourself and do NOT proceed without it.

**State-persistence post-condition — non-skippable:** running a candidate is not "done" until it
is recorded. After Forge trains a candidate you MUST call `evor_record_node` then
`evor_record_eval`. After calling `evor_record_node`, verify the returned node_name is non-null — a null or error result means the record failed. Do not advance the tick without a confirmed node_name from `evor_record_node`.

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
**After setup, this mission runs FULLY AUTONOMOUS to the goal — ZERO human-in-the-loop.** When the autonomy charter posture is `aggressive-never-halt`, you NEVER stop to ask the user and you NEVER emit an `AskUserQuestion`. Every decision — including novel ones — is auto-resolved by the Monotonic-Honesty Invariant. Setup was the sole human step.

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
hardening/honest equivalent and continue. You stop ONLY when the mission stop condition is met (goal
reached / budget exhausted / plateau) — never for a human.

**The ONE inviolable exception (a safety backstop, not a routine gate):** you must NEVER modify your
own integrity / fraud-detection logic — the leakage check, the reward-hacking probe, the integrity
gates — in a way that makes *failing candidates pass*. That is the exact loophole "no cheating"
exists to close: a charter clause cannot self-authorize weakening a cheat-detector, or the agent
could "reconcile away" any check that flags it. Materializing real anchors where only placeholders
exist is fine — that establishes honesty, it does not weaken a check. But if the ONLY way forward
would require *loosening an integrity check itself*, that is a DEVELOPER bug in the check, not a
mission decision — surface it and stop. A correctly-built plugin never hits this, so in practice
you still run start→goal with no human; this is the single safety line, and reconciling a
guard/spec to contract intent (Step above) is NOT it.

**The two always-on checks (they ARE the invariant, enforced automatically — not HITL, never bypassed):**
1. `no-test-leakage` — acquired train data must never overlap the test set, and vice-versa (the
   ingestion-contamination / near-dup gate). The one way data-grabbing could cheat.
2. `comparability-eval-version` — when the test hardens, bump `eval_version` + incrementally re-score
   the frontier (score only the new items, combine with cached old-item scores) so all scores stay
   comparable within the run.


</Autonomy_Charter>

<Use_When>
- The user runs `/evor` or `/evor-run` to start or continue a mission
- An initialized, locked mission exists in the current run state
- Called internally by `evor-run` after loading and validating the mission contract
</Use_When>

<Do_Not_Use_When>
- No initialized mission exists — use `evor-setup` first
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
- Use `Monitor` to watch for `job_complete` or `self_heal_event` signals during compute-bound phases.

If the env var is unavailable, fall back to sequential candidate execution (concurrency=1): Forge agents run one at a time; Evor waits for each job_complete signal before starting the next.
</Parallel_Execution>

<Steps>

## Step 0 — Run Startup (once, before the first tick)

Before Step 1 of the first tick, guarantee the hardware profile exists — Mutagen and Selector
read the capability profile for hardware gotcha-avoidance, and setup's preflight may have been
skipped. Call `evor_capability` to probe hardware and write the capability profile. This is
idempotent and cheap (no micro-train).

Confirm capability detection succeeded — if it failed, log a warning and continue with cpu_only defaults.

Use `TaskCreate` to open a tracking task for this run (title: "Mission <mission_id> — tick loop").
Use `TaskUpdate` to mark each tick's step progress as the loop advances.

## Step 1 — Select

Read the current tree state via `evor_tree_read`. Apply UCB1 selection policy (or the current selection policy from run state) to choose the parent node(s) for this tick.

```
selected = evor_select(run_id, strategy=current_strategy, count=ResourcePlan.concurrency)
```

If the frontier has ≥2 nodes from distinct lineages with scores within 10% of each other, flag to Mutagen that a crossover proposal is eligible this tick.

## Step 2 — Ideate

Spawn Mutagen and Sage as REAL sub-agents. Do NOT write proposals or citations yourself.

1. `Task(subagent_type="oh-my-evor:evor-mutagen", description="Tick <n> proposals", prompt="Run dir: <run_dir>. Tick: <n>. Parent node(s): <ids>. Wildness: <w>. Generate N=<concurrency> proposals and write ticks/<n>/mutagen/proposals.json per your write-as-you-go contract.")`.
   - **POST-CONDITION:** call `evor_read_artifact({ run_id, tick: n, agent: "mutagen" })`. If it returns `{error:"not found"}`, re-spawn Mutagen with a corrective note. Never fabricate the artifact.
2. Write Mutagen's `investigation_queries[]` to the tick handoff via `evor_write_handoff({ run_id, tick: n, data: { to: "sage", investigation_queries: [...] } })`.

   **P1-8 — Conditional Sage gate (wiki+gotcha first; Sage only when needed):**
   Before spawning Sage, call `evor_wiki_query` and `evor_gotcha_query` for each angle in
   `investigation_queries[]`. Classify each query as wiki-resolved, gotcha-resolved, or unresolved.

   **Skip Sage entirely** (and mark all queries resolved from wiki/gotcha) when ALL of the
   following hold:
   - All investigation_queries are wiki-resolved (wiki returned a confirmed lesson for each angle)
   - The proposal's approach_family is a known recipe already run this mission (not new to the run)
   - wildness < 0.7 (parametric / familiar territory; low surprise risk)
   - approach_family != "data-acquisition" (no sourcing due diligence needed)

   **Spawn Sage** when ANY of the following is true:
   - One or more investigation_queries are NOT wiki-resolved after the wiki+gotcha check
   - approach_family is new to this run (first tick using this family in this mission)
   - wildness >= 0.7 (structural or high-exploration proposal; external grounding adds value)
   - approach_family == "data-acquisition" (license sourcing requires Sage's Tier-1 search)

   When spawning Sage (narrowed scope): pass the UNRESOLVED angles only; wiki-resolved angles
   are already handled. Include the wiki hit IDs in the spawn prompt so Sage skips them.

   `Task(subagent_type="oh-my-evor:evor-sage", description="Tick <n> grounding", prompt="Run dir: <run_dir>. Tick: <n>. Read the tick handoff via evor_read_handoff and answer the UNRESOLVED investigation_queries (wiki-resolved angle IDs already handled: [<ids>]). Write ticks/<n>/sage/findings.json.")`.
   - **POST-CONDITION:** call `evor_read_artifact({ run_id, tick: n, agent: "sage" })`. If it returns `{error:"not found"}`, re-spawn Sage.
3. Attach Sage's findings to the matching proposal's citations.

Run Mutagen then Sage sequentially, or both in parallel when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. proposals.json and findings.json are the SUB-AGENTS' outputs — you never author them.

## Step 3 — Hypothesis Registration

For each proposal returned by Mutagen:
- Confirm the Hypothesis is populated (statement + quantified prediction).
- Register the Hypothesis in the run state via `evor_state_write` (append to hypotheses[] list).
- Assign a hypothesis_id and set it on the proposal.

## Step 4 — Critique

**P1-7/P1-13 — Deterministic pre-screen before spawning Selector:**
Call `evor_validate_proposals({ run_id, tick })` to run deterministic checks (field presence, numeric types, schema, H001/H002/H003/H004 fast-path) on all proposals BEFORE spawning Selector. The result classifies each proposal as `"fast_pass"`, `"fast_reject"`, or `"needs_llm"`. Pass the classification result in Selector's spawn prompt. Selector skips full LLM gate evaluation for `fast_pass` proposals (write approved verdict immediately) and only runs the complete 7-gate loop for `needs_llm` ones. `fast_reject` proposals are dropped before Selector is invoked. This eliminates full LLM evaluation cost for structurally clean, low-risk proposals.

Spawn Selector as a REAL sub-agent in a SEPARATE context. Do NOT approve/reject proposals yourself —
the whole point is an independent critic that did not generate the proposals it gates.

`Task(subagent_type="oh-my-evor:evor-selector", description="Tick <n> gate", prompt="Run dir: <run_dir>. Tick: <n>. Read proposals via evor_read_artifact(run_id, tick=<n>, agent='mutagen'). evor_validate_proposals result: <classification_json>. fast_pass proposals: write approved verdict immediately. needs_llm proposals: run full 7-gate evaluation. Write your verdict via evor_write_artifact.")`.
- **POST-CONDITION:** call `evor_read_artifact({ run_id, tick: n, agent: "selector" })`. If it returns `{error:"not found"}`, re-spawn Selector.
- Read the verdict; collect approved proposals. If zero pass, trigger Doom-Loop_Detection.
- The rejection reasons are already in the verdict artifact; append a DecisionLogEntry summarizing them via `evor_state_write`.

## Step 5 — Implement + Run

For each approved proposal, spawn Forge as a REAL sub-agent. Do NOT write or run training code yourself.

`Task(subagent_type="oh-my-evor:evor-forge", description="Implement <proposal_name>", prompt="Run dir: <run_dir>. Tick: <n>. Proposal name: <proposal_name>. Materialize the genome for this proposal, instrument telemetry via EVOR_TELEMETRY_PATH env-path append, store the delta, run the harness/training, and write your artifacts via evor_write_artifact.")`.
- Pass the proposal by NAME. Do NOT pass raw `node_id` UUIDs or internal path literals. Forge derives its own artifact paths and writes via `evor_write_artifact`.
- **POST-CONDITION:** call `evor_read_artifact({ run_id, tick: n, agent: "forge" })`. If it returns `{error:"not found"}`, re-spawn Forge.
- If parallel teams available: launch Forge Tasks concurrently; use `Monitor` for job_complete. Otherwise run one at a time.
- **P0-4 — Forge atomic completion contract:** `evor_read_artifact({ run_id, tick: n, agent: "forge" })` returning successfully is the ONLY signal that Forge's full turn is done. Individual forge-* sub-agent completions (forge-critic, forge-architect, forge-analyst, forge-junior completing their Tasks) are Forge's INTERNAL delegation — they are NOT signals that Forge itself has finished. Do NOT advance to Step 6 until the forge-report artifact is confirmed present. Treating a forge-critic or forge-analyst Task completion as "Forge done" is a protocol violation that corrupts the tick.
- Then YOU (orchestrator) call `evor_record_node` to register each new node, and append a DecisionLogEntry (decision_type="implement", node_ids=[node_id]) via `evor_state_write`.
- **Verify the returned node_name is non-null before advancing.** Training a candidate without a confirmed node record is a FAILED tick (the Stop hook enforces this).

## Step 6 — Evaluate + Integrity

For each completed Forge job:
1. Call `evor_record_eval(run_id, node_id, result)` — this auto-triggers the integrity check.
2. If the integrity check fails, the node is rejected and its integrity_status is set to "failed" — skip promotion. Log failure_reason via `evor_state_write`.
3. If the integrity check passes, integrity_status is "passed" and promotion is eligible.

**Ingestion Contamination Gate** (data-acquisition nodes only):
- The integrity check verifies acquisition_contamination_clear: no acquired sample collides with any frozen eval split.
- If false: node is rejected at integrity, never promoted to frontier.

## Step 7 — Analyze + Learn

For each node where integrity_status="passed", spawn Probe as a REAL sub-agent. Do NOT write lessons or hypothesis verdicts yourself.

`Task(subagent_type="oh-my-evor:evor-probe", description="Analyze <node_name>", prompt="Run dir: <run_dir>. Tick: <n>. Node name: <node_name>. Read telemetry via evor_read_artifact, analyze against the registered Hypothesis, and write your findings via evor_write_artifact (lesson entry + hypothesis_verdict).")`.
- Pass the node by NAME (as returned by `evor_record_node`). Probe reads via `evor_read_artifact` and writes via `evor_write_artifact`; it derives its own paths.
- **POST-CONDITION:** call `evor_read_artifact({ run_id, tick: n, agent: "probe" })`. If it returns `{error:"not found"}`, re-spawn Probe.
- Read the lesson entry from the artifact; call `evor_wiki_add(run_id, lesson_entry)` to persist it.
- Update node.lesson_ids with the returned lesson_id.

**P1-4 — Prediction bias tracking (close the producer gap; Mutagen reads this every tick):**
After the probe artifact is confirmed, extract `actual_delta_pp` (the numeric metric change Probe measured) and the `predicted_gain` midpoint from the original proposal's hypothesis. Record the sample:
```
evor_state_write({ prediction_bias_sample: { predicted_gain: <midpoint_pp>, actual_gain: <actual_delta_pp> } })
```
Skip this write ONLY when `hypothesis_verdict="inconclusive"` (no valid prediction error). The server accumulates the bias history; Mutagen reads it each tick via `evor_state_read` to self-calibrate its quantified predictions — this write is mandatory.

- If Probe returns a benchmark upgrade proposal:
  - Log it as a DecisionLogEntry (decision_type="meta-evolve") via `evor_state_write`.
  - Apply the benchmark upgrade.
  - If consent_granted=true (user confirmed): bump eval_version via `evor_state_write`, rescore frontier nodes.

## Step 8 — Record

For all nodes this tick:
- Append DecisionLogEntry to the run state (decision_type="record", node_ids=all_this_tick) via `evor_state_write`.
- Update run state: increment tick count, update best_score if improved, update frontier_ids.
- Call `evor_state_write` with the run-state patch.

## Step 9 — Prune / Promote

1. **Promote** nodes with integrity_status="passed" to the frontier if fitness_value > current worst frontier node.
2. **Prune** nodes: remove nodes with status="done" AND integrity_status="failed" AND depth > pruning_depth_threshold (default 3) from active consideration. Never delete a node record — set status="pruned" only.
3. **Stop check**: call `evor_check_stop({ run_id })`. If it returns `{ should_stop: true }`, proceed to step 4; otherwise continue the loop.
4. If stop condition met: print final summary, invoke `evor-report` skill, call `evor_plot_report({ run_id })` to render the final tree PNG and HTML, then deliver via `SendUserFile`. Exit loop.
5. If continuing: call Meta-Evolution check (see below), use `TaskUpdate` to mark tick complete, then return to Step 1.

## Step 9.5 — BenchmarkUpgrade Re-scoring (conditional)

If a BenchmarkUpgrade was applied in Step 7 and the rescore mode is "sync":
- For all frontier nodes not yet scored under the new eval_version: run partial evaluation on the new domains only.
- Merge cached per-domain scores (old domains) with new per-domain scores to maintain comparability.
- Update fitness_value using the contract's fitness mode.
- Nodes not re-scored within rescore_deadline_ticks are demoted to version-specific status.

If rescore mode is "async": schedule re-scoring jobs via `evor_schedule` without blocking the tick loop.

</Steps>

<Tick_Lifecycle>
Every tick follows this mandatory lifecycle wrapping all 9 steps.

**Tick Start — Read Prior Tick Handoff**
If `tick_count > 0`, call `evor_read_handoff({ run_id, to_agent: "orchestrator" })` before beginning Step 1. Incorporate the result's lessons, dominant_family, and next_tick_seed hint into orchestrator context before Step 1. This prevents re-proposing dead-end families and provides Mutagen with the `next_tick_seed` hint.

**Tick Start — Inbox Drain (before Step 1)**
After reading the tick handoff and before executing Step 1, drain both inboxes:

```
evor_drain_inbox({ run_id, kind: "remember" })
evor_drain_inbox({ run_id, kind: "signals" })
```

The `remember` drain routes `<evor-remember>` entries to the wiki and gotcha store. The `signals` drain routes `<evor-signal>` entries into the deduped signal bus. Both calls return the count drained and atomically truncate the inbox.

**Before Each Step N (1–9): Write tick-state**
Call `evor_state_write` with a `tick_state` payload before executing each step:
```json
{
  "tick_state": {
    "tick": "<current_tick_number>",
    "current_step": "<N>",
    "step_status": "running",
    "step_outputs": {},
    "updated_at": "<ISO 8601>"
  }
}
```
This enables step-level resumability: if the loop is interrupted mid-tick, `evor-resume` reads `current_step` and restarts from that step.

**After Each Step N: Update step_status**
Call `evor_state_write` with an updated `tick_state` payload to mark the step done:
```json
{
  "tick_state": {
    "tick": "<current_tick_number>",
    "current_step": "<N>",
    "step_status": "done",
    "step_outputs": { "<key>": "<brief summary of step output>" },
    "updated_at": "<ISO 8601>"
  }
}
```

**Tick End — Write Tick Handoff**
After Step 9 (before the stop-check / next-tick loop decision), call `evor_write_handoff` with the tick summary:
```json
{
  "tick": "<current_tick_number>",
  "best_score": "<run_state.best_score>",
  "best_node_name": "<name returned by evor_record_node for the best node>",
  "frontier_size": "<len(frontier_ids)>",
  "nodes_this_tick": ["<node_name>"],
  "lessons": ["<lesson_id>"],
  "dominant_family": "<dominant_approach_family_this_tick>",
  "next_tick_seed": "<brief hint for Mutagen: what to explore next based on Probe's lessons>",
  "strategy_state": {
    "wildness": "<strategy.wildness>",
    "selection_policy": "<strategy.selection_policy>",
    "meta_iteration": "<strategy.meta_iteration>"
  }
}
```

`best_node_name` and `nodes_this_tick` use node NAMES as returned by `evor_record_node`. `evor_write_handoff` accepts names. Do not carry raw UUIDs across tick boundaries.

At milestones (every 5 ticks, or when best_score improves by ≥5%): call `evor_plot_report({ run_id })` then deliver the tree PNG via `SendUserFile`.

**Step-Level Resume Detection**
When the tick loop starts a new tick (or when `/evor-resume` invokes this skill), call `evor_state_read` to retrieve the current `tick_state` before executing Step 1:

- If `tick_state.tick == current_tick` AND `tick_state.step_status == "running"` AND `tick_state.current_step < 9`: an interrupted tick is detected — skip steps 1 through `tick_state.current_step - 1` and re-run the interrupted step from the top.
- Otherwise: start at Step 1 (fresh tick).

Re-run the interrupted step from its beginning (write tick-state with `step_status: "running"` again via `evor_state_write`).

**Why This Matters**
tick-state makes every tick resumable at the step level — an interrupted tick at step 5 restarts from step 5, not step 1. Tick handoffs compound learning across ticks: Mutagen reads the prior handoff and avoids families proven ineffective; Probe's lessons accumulate across ticks rather than being siloed to the current tick's context.
</Tick_Lifecycle>

<Meta_Evolution>
**Adaptive meta-evolve trigger (P1-3):** At the end of Step 9 (after promote/prune), ALWAYS call `evor_check_plateau({ run_id })` first:
- If `plateau=true` OR `consecutive_regression=true` in the result → call `evor_meta_evolve({ run_id })` IMMEDIATELY, regardless of the tick interval. Log as DecisionLogEntry(decision_type="meta-evolve", rationale="plateau/regression-triggered", strategy_delta=delta) via `evor_state_write`.
- Otherwise → check the fixed interval: if the configured meta-loop interval has elapsed → call `evor_meta_evolve({ run_id })` and log normally.

At the configured interval (default 5 ticks) — fixed-interval fallback if no plateau/regression detected. `evor_meta_evolve` updates the selection strategy. Log as DecisionLogEntry(decision_type="meta-evolve", strategy_delta=delta) via `evor_state_write`.

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
1. Set wildness override = 0.9 (maximum exploration) regardless of current strategy settings.
2. Force approach_family diversity: require Mutagen to generate proposals from 3 distinct families.
3. If winning_families shows a monopoly (one family in last 5 entries), explicitly exclude that family for one tick.
4. Log the intervention as DecisionLogEntry(decision_type="meta-evolve", rationale="doom-loop intervention") via `evor_state_write`.
</Doom_Loop_Detection>

<Signal_Routing>
The run has a SIGNAL BUS — the shared observation/pain-point stream.
You are the ROUTER: you read it and PUSH the relevant slice to each sub-agent (agents also pull
depth themselves). A signal is neutral; each lens treats it differently — a brief to Mutagen,
a gate to Selector, a default to Forge-architect, an escalate to you.

**Tick start — drain the signal inbox** (handled by `evor_drain_inbox({ run_id, kind: "signals" })` in the Inbox Drain step above). The PostToolUse hook appends `<evor-signal>` tags to the signal inbox; the drain call routes them into the deduped bus.

**Before each sub-agent spawn — PUSH the digest** (the mandatory awareness floor). Call `evor_signal_digest({ run_id })` to retrieve the compact top-slice (severity≥medium), then inject the result into each sub-agent's Task prompt:
```
Task(subagent_type="oh-my-evor:evor-mutagen", prompt=... + "\nRecent signals (dream around these): " + digest)
```

**Escalate signals — resolved by the Autonomy Charter, NEVER by asking.** When a signal implies the
locked contract needs reconciling (`eval-saturated` → benchmark too easy; `label-noise` → metric
untrustworthy; `guard-unsatisfiable` → guard mis-specified; placeholder anchors), apply the
Monotonic-Honesty Invariant (see `<Autonomy_Charter>`): take the *harder / more-honest* action
automatically and log a DecisionLogEntry — e.g. harden the test (spawn `evor-acquirer` to acquire
harder data, de-duped, `eval_version`++), reconcile the guard/anchors to the contract's stated
intent, materialize real anchors where only placeholders exist. NEVER soften, NEVER shift
comparability to inflate, NEVER leak test into train — and NEVER stop to ask. A monotonic move
always exists; take it and continue.
</Signal_Routing>

<Tool_Usage>
- `evor_capability` — probe hardware at run startup (Step 0)
- `evor_tree_read` — read current tree state
- `evor_select` — UCB1 selection
- `evor_signal_emit` / `evor_signal_query` — emit to / read the signal bus
- `evor_signal_digest` — compact bus top-slice for sub-agent spawn-prompt injection
- `evor_drain_inbox` — drain remember-inbox and signals-inbox at tick start
- `evor_record_node` — register a new node in the evolution tree; returns node_name
- `evor_record_eval` — record evaluation result and auto-trigger integrity check
- `evor_integrity_check` — run the integrity checks
- `evor_wiki_add` — persist a lesson entry from Probe
- `evor_wiki_query` — query prior lessons
- `evor_state_read` / `evor_state_write` — run state, tick-state, and tick_state writes
- `evor_read_artifact` / `evor_write_artifact` — post-condition artifact checks; tick artifact writes
- `evor_write_handoff` / `evor_read_handoff` — write and read per-tick handoffs
- `evor_meta_evolve` — update selection strategy after meta-loop interval
- `evor_schedule` — submit jobs to the run scheduler
- `evor_cite` — attach citation to node
- `evor_telemetry_ingest` — validate and append telemetry records for a node
- `evor_gotcha_add` — record a gotcha surfaced by inbox drain routing
- `evor_plot_report` — render the evolution tree at milestones and stop
- `Monitor` — watch for job_complete or self_heal_event during compute-bound phases; idle here, do not poll
- `TaskCreate` / `TaskList` / `TaskUpdate` — track per-tick candidates and phase progress as a visible task list
- `SendUserFile` — deliver evolution-tree PNG and metrics plot at milestones and mission stop
</Tool_Usage>

<Compaction_Survival>
Context windows compact independently for the main orchestrator AND each sub-agent.
The governing principle: the context window is a cache; `.evor/` is the source of truth.

**Hooks (automatically wired):**
- `PreCompact`: flushes a checkpoint automatically and injects an `<evor-restore>`
  summary into the compacted context (objective + tick/step + best-so-far + recovery hint).
- `SessionStart`: re-hydrates env vars AND injects an `<evor-restore>` block into the
  session context when an active run exists on disk.
- `SubagentStop`: advisory check that the stopping sub-agent wrote its expected final
  artifact; emits `[EVOR SUBAGENT WARNING]` if missing.

**Sub-agent write-as-you-go contract:**
Each roster agent writes its final structured artifact before finishing. The orchestrator
confirms completion exclusively via `evor_read_artifact` — do not read artifact files directly.
Write incremental partial outputs as you go so a mid-task compaction loses at most the
since-last-write delta.

**`<evor-remember>` durable-fact tagging:**
Any agent or the orchestrator can mark a durable fact with XML tags in their text output:

```
<evor-remember>Fact that should persist across ticks</evor-remember>
<evor-remember gotcha>Hard constraint or failure that blocks a class of proposals</evor-remember>
```

The `PostToolUse` hook scans tool inputs and responses for these tags and appends matches to
the remember-inbox. The orchestrator calls `evor_drain_inbox({ run_id, kind: "remember" })` at
the start of each tick — it routes wiki entries to `evor_wiki_add` and gotcha entries to
`evor_gotcha_add`, then atomically truncates the inbox. This keeps the wiki and gotcha store
current without requiring sub-agents to call those tools directly.

**Resume after compaction:**
When Evor resumes after compaction, the `<evor-restore>` block in context provides:
objective + current tick/step + best score/node + recovery hint. Always call `evor_state_read`
before acting — the restore block is a navigation aid, not the authoritative state.
</Compaction_Survival>

<Execution_Policy>
- Evor (orchestrator) idles via `Monitor` during compute-bound Forge phases — do not poll.
- Wake on `job_complete` signal from harness or `self_heal_event` from the harness.
- Do not spawn more Forge agents than ResourcePlan.concurrency.
- Respect budget.max_wall_clock_hours and budget.max_gpu_hours if set.
- Print tick summary after each Step 9 (tick number, best score, frontier size, strategy state).
- Use `TaskUpdate` to mark each tick complete in the task list after Step 9.

**P2-16 — Narration reduction (one-line HUD; push only on milestone).**
Emit ONE concise status line per tick step, not a multi-paragraph essay. Format:
  `[T{tick} S{step}] {verb}: {object} → {outcome}` (e.g. `[T3 S2] Mutagen: 3 proposals → written`)

Do NOT emit:
- "Holding..." or "Waiting..." turns (idle silently via Monitor instead)
- Intermediate reasoning paragraphs or "I will now..." preambles
- Redundant recaps of what was already logged in the previous step
- Full JSON payloads in orchestrator text output (those belong in artifacts, not narration)

**Push notification (PushNotification tool) ONLY for these milestones:**
1. New best score achieved (best_score improved by any amount)
2. Integrity check failed on a node (integrity violation detected)
3. Run blocked (doom-loop detected, or budget exhausted, or all proposals rejected)
4. Tick complete (end of Step 9) — one line only

For all other transitions (step start, sub-agent spawned, artifact written, etc.), update
`TaskUpdate` silently; do not output narrative text.
</Execution_Policy>
