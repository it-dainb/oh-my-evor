# AF3 — Flow / Tick Pipeline: affordance trace and state-machine evaluation

Wave 3, lane AF3. Repo `oh-my-evor` @ `v1.2.1`. Read-only; this file is the only path created.

**Affordance gap** = the system cannot express something real, so someone improvises outside it,
and the improvisation is later catalogued as a defect.
**Defect** = the catalogued symptom. This lane separates them explicitly.

Evidence is `file:line`, commit sha, or field artifact. Claims without one are marked **INFERRED**
with the probe that would confirm.

---

## 1. The flow as actually built

### 1.1 The 9 steps and where they live

The tick pipeline is defined **in prose, in one file**: `skills/evor/SKILL.md:182-345`.

| Step | Name | Defined | Real actor | On-disk evidence it ran |
|---|---|---|---|---|
| 0 | Run startup (capability probe) | `SKILL.md:170-180` | orchestrator | capability profile |
| 1 | Select | `SKILL.md:182-190` | orchestrator (`evor_select`) | none |
| 2 | Ideate (Mutagen ∥ Sage) | `SKILL.md:192-251` | 2 sub-agents | `ticks/<n>/mutagen/proposals.json`, `ticks/<n>/sage/findings.json` |
| 3 | Hypothesis registration | `SKILL.md:253-258` | orchestrator | `hypotheses[]` in run-state |
| 4 | Critique (Selector) | `SKILL.md:260-271` | sub-agent | `ticks/<n>/selector/verdict.json` |
| 5 | Implement + Run (Forge) | `SKILL.md:273-283` | sub-agent + GPU job | `ticks/<n>/forge/forge-report.json`, `jobs/<id>/status.json` |
| 6 | Evaluate + Integrity | `SKILL.md:285-294` | orchestrator (MCP) | `evaluations/<id>.json` |
| 7 | Analyze + Learn (Probe) | `SKILL.md:296-316` | sub-agent | `ticks/<n>/probe/*`, wiki entry |
| 8 | Record | `SKILL.md:318-323` | orchestrator | `tree.json`, run-state patch |
| 9 | Prune / Promote / stop-check | `SKILL.md:325-331` | orchestrator (`evor_check_stop`) | frontier update |
| 9.5 | Benchmark rescore (conditional) | `SKILL.md:333-345` | orchestrator | eval version bump |

There is **no `tick.py`, no tick module, and no code that owns the step sequence.** The brief's
suggested `harness/evor/tick.py` does not exist (`ls harness/evor/` — 25 modules, none is a tick
driver). The nearest thing to an executable tick is `agents/evor-tick.md` (72 lines), which says at
`:28`: *"The 9-step loop is defined in the `oh-my-evor:evor` skill, loaded above. Follow it exactly."*

**Who advances the steps: an LLM, by writing a number into a JSON file.** `current_step` is written
only through `evor_state_write({tick_state:{…}})`, and every writer is a model following
`SKILL.md:361-389`. Grepping the whole repo for a non-test writer of `current_step` returns
**zero code sites** — only the Zod field declaration (`mcp/src/tools/state.ts:24`), four hook
*readers*, and the SKILL prose that instructs the model to write it.

### 1.2 The four state files and their writers

| File | Created by | Patched by | Also written by | Schema |
|---|---|---|---|---|
| `mission-state.json` | `harness/evor/init_run.py:218-227` (Python, bare dict) | `mcp/src/tools/state.ts:216-238` (TS) | `hooks/session-end.mjs:57-67` (JS) | **none — no model in either language** |
| `run-state.json` | `init_run.py` | `state.ts:158-190` via `RunStatePatchSchema` | hooks read only | patch-only; no whole-document schema |
| `tick-state.json` | first `evor_state_write` | `state.ts:241-251` | — | `TickStateSchema`, `state.ts:22-31`, **local to that file, not in `contracts.ts`** |
| `jobs/<id>/status.json` | `harness/evor/jobs.py:96` | `jobs.py:198-202` | — | none, but **the only status in the system a program transitions** |

`harness/evor/contracts.py` defines 58 models; `mcp/src/contracts.ts` exports 27 schemas
(`ALL_SCHEMAS`). Neither contains a `MissionState`, `RunState`, or `TickState`. Confirms RC4:
*"the run is not an entity in evor's ontology."* The three files that carry the run's lifecycle are
the three files with no contract.

### 1.3 The finished-predicate exists in five places, in three languages

| Site | Predicate | Reads `step_status`? |
|---|---|---|
| `hooks/stop.mjs:254-260` | `currentStep < 9 && runState.status==='running'` → debt | no |
| `hooks/stop.mjs:373-376` | `finished = step >= 9` | no (comment at `:374-376` says so deliberately) |
| `hooks/session-start.mjs:379-381` | `step >= 9 \|\| step === 0` → next tick | no |
| `hooks/post-compact.mjs:116` | `curStep === 0 \|\| curStep >= 9` → new tick | no |
| `skills/evor/SKILL.md:417` | `step_status=="running" && current_step < 9` → resume | **yes — the only one** |

Four of five copies discard the field that the schema marks required
(`state.ts:25-28`, no `.optional()`). The one that reads it is prose, executed by a model.
That asymmetry *is* C-02: the field state (`step 9 / running / integrity failed`) is
"interrupted" under the SKILL's rule and "finished" under all four code rules.

### 1.4 The Two-Loop diagram is not the shipped flow

`docs/ARCHITECTURE.md:12-22` documents inner (tick) and outer (meta-evolution, every 5 ticks)
loops. `ARCHITECTURE.md:133-135` claims *"Evor idles via the Monitor tool during compute-bound
Forge phases rather than polling, waking on `job_complete` or `self_heal_event` signals."*

`grep -rn job_complete` across the repo (excluding vendored dirs) returns **six hits, all prose**:
`ARCHITECTURE.md:134` and `skills/evor/SKILL.md:143,145,280,505,550`. **Zero producers.**
`SignalSchema.kind` is `z.string()` (`mcp/src/contracts.ts:771`) — unconstrained — so nothing
even reserves the name. The documented idle mechanism is a signal no code emits.

---

## 2. Ranked affordance gaps in flow

Ordered by (damage in the field) × (frequency of improvisation).

### F1 — No terminal-state writer, and no lease. *(defects: C-01, O-05)*

**Gap.** Nothing can express "this run is no longer being worked on." Every terminal transition
requires a live actor to execute a write, so the one case that matters — the actor dying — writes
nothing. Field: all three missions read `run-state.status: "running"` forever
(lane-o §O-05); `active-run.json` still says `status: running` for a session killed 2026-08-24
02:20:32 (lane-c §C-01). r3's `mission-state.json` last moved at 00:12:56 and was **2h07m stale**
against its own `tick-state.json`.

**What was invented instead.** (a) `hooks/session-end.mjs` — a hook that writes `paused` on clean
exit, which is not the failure case; (b) a human, hand-editing two `mission-state.json` files
**14h39m late** with a `.bak-20260824T001336Z` chain to prove it (lane-o §O-09).

**Why an FSM alone does not fix this:** a killed process executes no transition. What is missing is
a *timed* state — `entered_at` plus a max dwell, checked by an external reader (session-start hook
or `evor doctor`). See §4.2.

### F2 — No way to say "this step is blocked on an external job." *(defects: C-03, C-05, C-06, L-06)*

**Gap.** `step_status ∈ {pending, running, done, failed}` (`state.ts:26`). "Running" covers both
*I am computing* and *I am waiting for someone else*, so an 11h49m wait and a 200ms call are the
same state. There is no field naming what is being waited on.

**What was invented instead**, all four in the field:
1. **Proxy waiter agents** — full-privilege `claude` spawns whose entire job is to wait:
   `"Wait for mutagen artifact"` (00:18:03), `"Wait for selector verdict"` (00:35:22),
   `"Wait for forge artifact"` (00:53:51; still alive at kill) — lane-c §C-05.
2. **Identical-argument polling** — `evor-tick a78d6b64199b90219` polled `evor_read_artifact`
   13× over 12h34m; `a3bcda02926248171` polled `agent:"forge"` 6× over 32 min (lane-c §C-06).
3. **Busy-wait in Bash** — `forge-junior afff04fd9da2e3a8e`: `true` ×10, `sleep 1`, `echo idle`
   (lane-c §C-05); foreground `sleep` blocked 8× per the brief.
4. **Turn-ending** — MAIN ends its turn, the stop hook permits it (C-02), and the session sleeps
   8h16m until a notification wakes it (lane-c §C-03).

**Not a learning failure.** RC5 records zero `run_in_background` in any agent or skill file; the
`Monitor` idle is documented in five places (`SKILL.md:143,280,505,549`, `evor-run/SKILL.md:95`)
and keyed to a signal with no producer (§1.4). The affordance was *specified as an intention and
never as a mechanism*.

### F3 — No way to distinguish *failed but complete* from *incomplete*. *(defect: C-02)*

**Gap.** Position (`current_step`) and completion are the same variable in four of five readers
(§1.3). A tick that reached step 9 and failed integrity is indistinguishable from a tick that
reached step 9 and succeeded — and *both* are indistinguishable from a tick sitting at step 9 with
`step_status:"running"`, which is the exact field state at kill: `tick 1, current_step 9,
step_status "running", integrity_verdict "failed"`.

**What was invented instead.** `integrity_verdict` was written into `tick-state.json` — a field
absent from `TickStateSchema` (`state.ts:22-31`). The model needed to record "complete but bad" and
the schema had no slot, so it added one; no reader looks at it.

**Calibration is the proximate cause, not carelessness.** `6c713b7`: *"kept deliberately loose…
Demanding `step_status === 'done'` made three existing tests fail, all with tick-state that omits
the field."* RC5 notes those fixtures are unproducible by a sanctioned writer since the field is
required. **This lane found a real unsanctioned writer.** The committed artifact
`.evor/runs/frontier-1ms/run-live-01/tick-state.json` reads:

```json
{ "tick": 1, "current_step": 2, "phase": "ideate", "step": "sage-frontier-research" }
```

No `step_status` (required by schema), plus two fields (`phase`, `step`) the schema does not
define. Zod strips unknown keys on parse but nothing validates on write, and nothing validates
what is already on disk. So the fixtures were not artificial — they matched a shape the system
genuinely produces. The predicate was loosened to fit real garbage. **The fix is an owned format,
not a stricter predicate** (§4.3).

### F4 — A run's lifecycle is not an entity. *(defects: I-11, O-05, O-08, O-09)*

**Gap.** Status is *value*-validated, never *transition*-validated. `stateWrite` does
`ms.status = missionStatus` (`state.ts:234`) after a Zod enum check — any value to any value, from
any state, with no read of the prior value. The one guarded transition in project history is
`draft→locked` via `lockMission` (`state.ts:388-447`), and it guards the **contract seal**, not the
lifecycle.

Consequences all measured: three missions concurrently `running` (O-05); two tick counters that
disagree (`mission-state.current_tick: 0` vs `tick-state.tick: 1` in all three runs);
`started_at: null` in all three despite all three having run; `tick_count` never incremented for r1
because its orchestrator died before the explicit patch (O-08). Every one of these is a field the
schema declares and no code maintains.

**What was invented instead.** Hand-backfill (O-09) and `evor doctor`.

### F5 — No "superseded" relation. *(defects: O-09, C-04)*

**Gap.** Three missions, sequentially abandoned. Nothing expresses "r3 replaces r2." `git log
-S'superseded_by' --all` is empty (RC4) — the field does not exist in code.

**What was invented instead.** The operator invented the field on the fly:
`+ "superseded_by": "…-r3"`, `+ "superseded_reason": "…"` written by hand into r1 and r2, and — the
ordering matters — **r3's own state was written 40 seconds *before* its predecessors were marked
dead** (lane-o §O-09). The successor existed while the predecessors still read `running`.

The compounding case is C-04: r1's `evor-tick` **finished with a well-formed outcome**
(`{"tick":1,"outcome":"rejected","node_id":"multiscale-stroke-gate-01-2",…}`), MAIN never dequeued
it, and 36 minutes later called `evor_init_run` for a new mission. A completed unit of work was
discarded and the mission restarted without it — with nothing on disk recording that this happened.

### F6 — No recovery edge back to a runnable state. *(new in this lane; static, checkable)*

**Gap → deadlock.** `skills/evor-run/SKILL.md:52-66` (Step 2.5, the Phase-2 Lock Guard) is a hard
entry gate: *"Mission not locked: print the error below and **stop immediately**."* The only
accepted value is `locked`.

Now trace the reachable states:
- `evor-run` Step 4 (`SKILL.md:78-90`) writes `mission_status: "running"`.
- `hooks/session-end.mjs:57-67` writes `paused` on any clean session exit.
- `state.ts:53-60` deliberately **excludes `locked`** from the `mission_status` enum ("reachable
  only through `evor_lock_mission`").
- `/evor-resume` (`commands/evor-resume.md:12-20`) dispatches to **`evor-run/SKILL.md`** — i.e.
  straight back through Step 2.5.

So once a run leaves `locked` — which happens on the first thing `evor-run` does, and again on
every clean exit — **no sanctioned path returns it there**, and the documented resume command
re-enters through the gate that rejects it. The committed field artifact is the proof: the
`mission-state.json` in this very repo shows `- "status": "locked"` → `+ "status": "paused"`,
written by `paused_by: "session-end-hook"`, and it has stayed there since 2026-07-26.

**Compounding, in the opposite direction.** `hooks/stop.mjs:74-86` (§15E) exits 0 — silently, before
any guard — when mission status is `paused|completed|failed`. So the same hook write that makes a
run unresumable also **disables the entire stop-hook enforcement layer** for it. And
`stop.mjs:248-249` asserts *"mission-state.json stays 'locked' throughout active runs"*, which
contradicts `evor-run/SKILL.md:78-90` writing `running`. Two files disagree about the value of one
field during normal operation, and each was written correctly against its own belief.

**Relevance to the FSM proposal: this is what an under-specified guard already costs here.**
Guards without an explicit, logged override edge do not make the system safer; they make it
unrecoverable. See §4.4 risk 3.

### F7 — No expression of concurrency between siblings. *(defects: O-02, O-17; near-misses)*

**Gap.** The tick model is strictly sequential (steps 1→9) while Step 5 explicitly launches N Forge
agents in parallel (`SKILL.md:280`) and Step 2 runs Mutagen ∥ Sage. There is one `current_step` per
run, so N concurrent candidates share one position counter. `pending_subagent_ids[]` exists — but
only as a *forward-compatible* read in `stop.mjs:290-311`, guarded by "if the field is absent this
guard is a no-op." Nothing writes it.

Field: 97 sub-agents, depth 0-3, 9 concurrent sage-juniors. Lane-o concludes the run "cleared this
on luck" — no lost update occurred because the missions never overlapped in time (lane-o §0, §O-02).

### F8 — Liveness is structurally unobservable. *(defect: K-09)*

**Gap.** Every guard in the system is edge-triggered — hooks fire on Stop, SessionStart, PostToolUse.
A stall is the *absence* of edges. RC5: *"Liveness wasn't rejected — the question was unreachable
from the frame."* Field: 30 gaps > 5 min, one continuous 11h outage (14:53→23:09) broken by a single
event, and 54 stop-hook invocations that all returned `preventedContinuation: false`.

`evor_tick_resume` / `checkTickHealth` / `auto_resume_count` were built **mid-run** and exist only in
the plugin cache, never in this repo (lane-a §103-137, lane-c §379-383) — introduced ~40 min before
the kill and never exercised.

### F9 — Named affordances with no implementation. *(defects: L-09, and §1.4)*

Three confirmed: `job_complete` / `self_heal_event` signals (6 prose mentions, 0 producers, §1.4);
`evor_schedule({run_id, mode:"scheduled"})` documented in `skills/evor-schedule/SKILL.md` while the
real tool requires `node_id`+`job_spec` — *"that call has never been possible"* (RC5); and
`evor-resume` as a *distinct* recovery flow, which is a command file that `cat`s `evor-run`'s skill
(F6). Each is an affordance the system advertises and cannot honour, which is worse than a missing
one: the agent stops looking for an alternative.

---

## 3. Would an explicit FSM fix these? Finding-by-finding

Scored honestly. "FSM" here means: enumerated states, guarded transitions, one owner per state
variable, and an append-only transition log.

| Finding | FSM verdict | Why |
|---|---|---|
| **C-02** (step≥9 read as finished) | **Yes, but not *because* it is an FSM** | The cure is that `finished(tick)` becomes a *computed property of one owner* instead of a predicate re-derived in 5 files (§1.3). Any single-owner predicate does this. The FSM's contribution is that "step 9 + running" stops being expressible at all. |
| **C-01** (never terminated) | **Partial — needs timed states** | A killed session fires no transition. Add `entered_at` + `max_dwell` per state and an external sweeper, and `running` past its lease becomes `stale` deterministically. Without that clause the FSM changes nothing here. |
| **I-11 / O-09** (status untransitioned, hand-backfilled) | **Yes — this is the bullseye** | Exactly the missing capability: transition validation plus a legal `superseded` edge. The hand-edit becomes a tool call with a guard and a log entry. |
| **O-05 / O-08** (contradictory counters) | **Yes, conditionally** | Only if the FSM has *one* state variable per entity and the others become derived/removed. Adding a fifth status field alongside four unreconciled ones makes O-05 worse. This is the single most important implementation constraint. |
| **K-06** (empty angle registry unreachable-goal) | **No** | Data-model reachability, not control flow. Untouched. |
| **K-09** (no stall detection) | **Only with timed states** | Same clause as C-01. An untimed FSM is as edge-triggered as what it replaces. |
| **C-05 / L-06** (no wait primitive) | **Partial — legibility, not mechanism** | A `blocked{on:…, since:…}` state *names* the wait, lets the stop hook block correctly on a live job and force-fail a dead one, and makes proxy-waiter spawns detectable. It does not make anything actually block; that is a host affordance (`TaskOutput block:true`, `Monitor`). Do not claim the FSM solves C-05. |
| **C-04** (notifications dropped) | **No** | Host queue layer. Out of reach. |
| **C-03** (11h stall) | **Indirect** | Fixed only via F8/K-09's timed states, not by the transition table. |
| **F6** (locked→paused deadlock) | **Yes if drawn; worse if not** | An FSM forces you to draw the recovery edge. An FSM *without* an override edge is what already caused F6. |
| **O-02 / O-17** (cross-language races) | **No** | Locking and write-ownership. Orthogonal — and see §4.3, an FSM in one language *repeats* it. |

**Summary: 3 findings genuinely eliminated (C-02, I-11/O-09, O-05), 3 more only if timed states are
part of the design (C-01, K-09, C-03), 2 partially (C-05, F6), 4 untouched (K-06, C-04, O-02, O-17).**

---

## 4. Design decisions the proposal has to make

### 4.1 One state variable per entity, or it is a net loss

Today five status fields describe overlapping realities: `mission-state.status`,
`run-state.status`, `tick-state.step_status`, `TreeNode.status` + `integrity_status`
(`contracts.py:561-562`), and `jobs/<id>.state` (`jobs.py:96,198`). Three of them disagreed in the
field simultaneously (lane-o §O-05).

**Rule:** a new FSM must *replace* a field, never accompany it. Concretely: `mission-state.status`
becomes the mission FSM's only state; `run-state.status` is **deleted** (it duplicated the mission's
and was wrong in all three field runs); `tick-state` gains a real state and `current_step` becomes a
derived *label*, not a predicate input.

### 4.2 States must be timed

Every state carries `entered_at` and a `max_dwell_s`. The predicate the system never had —
"is this still alive?" — becomes `now - entered_at > max_dwell_s`, computable by any reader in any
language from the file alone, with no event. This one clause converts C-01, K-09 and C-03 from
unobservable to trivially observable, and it costs two fields.

### 4.3 Where it lives: the *format* is the authority, not either language

This is the lane's most important recommendation and it follows directly from RC3:
*"the lock became a TypeScript implementation detail rather than a property of the on-disk format…
There was never one owner of the on-disk format — only of the schemas."* Three languages read this
state (Python harness, TS MCP, JS hooks; `hooks/session-end.mjs` is a confirmed unlocked third-language
writer of `mission-state.json`).

**An FSM implemented in Python is invisible to `stop.mjs`, which is the component whose wrong
predicate caused C-02.** Implementing it in TS and letting Python re-derive is the `.tree.lock`
mistake verbatim.

Proposed layering:

| Layer | Artifact | Owner |
|---|---|---|
| **Definition** | one language-neutral table, e.g. `contracts/state-machines.json`: `{entity: {state: {event: {to, guard, max_dwell_s}}}}` | shipped with the contracts, versioned, diffable |
| **Enforcement** | the MCP write path only — `evor_state_write` / a new `evor_transition` refuses illegal edges | single writer |
| **Interpretation** | ~80-line reader in each of Python / TS / JS, all loading the same table | each language |
| **Audit** | append-only `transitions.jsonl` per run: `{entity, from, to, event, actor, at, guard_result}` | the MCP write path |

Hooks become *readers* that ask the table "is this state terminal / stale?" instead of hard-coding
`step >= 9` — which deletes four of the five predicate copies in §1.3.

The `transitions.jsonl` is not decoration: RC4's top prediction is that the decision log records the
*search* and never the *run*. This is the missing half, and it is what would have made the O-09
backfill visible as a backfill.

### 4.4 Risks the proposal adds

1. **A fifth status field** if §4.1 is not honoured. Highest-probability failure mode.
2. **Fail-open vs fail-closed collision.** `stop.mjs` has five explicit fail-open `catch` blocks
   (`:86, :230, :262, :311, :390`) — a deliberate, correct policy for a hook that can trap a user.
   A guard that must fail open in the reader is a suggestion, not a constraint. **Policy: guards are
   enforced at the writer (MCP), advisory at the readers (hooks).** Say this in the design or the
   two will drift the way `stop.mjs:249` and `evor-run/SKILL.md:78-90` already have.
3. **Guards deadlock recovery.** F6 is a live, shipped demonstration: one un-drawn edge
   (`paused → locked`) makes every paused run unresumable *and* silences the enforcement layer.
   Every entity needs a logged `force_transition(to, reason, actor)` edge. Forbidding the operator's
   move does not stop it — it just moves it to `vim`, 14 hours late, which is O-09.
4. **The actor is a language model.** A rejected transition returns an error to something that will
   retry in a different shape or route around the tool. Field precedent: the `oh-my_evor` typo got a
   hard error and was **never retried**, dropping two signals permanently (lane-o §O-07). Rejections
   must return the *legal transition set from the current state*, not "invalid" — the error is a
   prompt.
5. **Retrofit cost against 0 tick-completions.** The system has never completed a tick end-to-end in
   the field. An FSM formalizes a pipeline whose real-world behaviour is largely unobserved; some
   states will be wrong. Mitigate by shipping the mission FSM first (§6), where three attempts of
   evidence exist.

### 4.5 Dependency verdict: **do not take `python-statemachine`**

1. **It structurally recreates RC3.** The machine would be encoded in Python class syntax, which
   `stop.mjs` and `state.ts` cannot read. The authority must be a data file both other languages
   parse (§4.3). This alone is decisive.
2. **The repo pins nothing (R-03) and installs the harness editable** (`install.sh:37`), while
   MCP/skills/hooks ship from a copied cache (RC4, A-04/P-01). A new runtime import is a new field
   failure mode on machines you do not control, in a layer whose deployment story is already the
   subject of a BLOCKER finding.
3. **It solves the easy half.** What is needed is ~80 lines: a table, `assert_transition(entity,
   from, event)`, an append-only log, and a `is_stale(state)` helper. The hard parts — deciding who
   owns `mission-state.status`, writing the guards, drawing the recovery edges, deleting
   `run-state.status` — are exactly what no library provides.
4. Its genuine draw is diagram generation. Generate the diagram from the JSON table instead; ~30
   lines to Mermaid, no dep, and the diagram then provably matches what the code enforces.

**Verdict: hand-rolled transition table, defined in JSON, interpreted in three languages, enforced
in one.**

---

## 5. Drafted state machines

Notation: `state --event--> state [guard]`. `†` = new capability that does not exist today.
All states carry `entered_at`; `max_dwell_s` given where a lease is meaningful.

### 5.1 Mission (`mission-state.json`) — one state variable, replaces today's free-form `status`

| State | Meaning | Terminal | `max_dwell_s` |
|---|---|---|---|
| `draft` | contract written, not validated | no | — |
| `locked` | contract validated + sealed; runnable | no | — |
| `running` | a run is active under this mission | no | 21600 (6 h, lease) |
| `paused` | no active run; resumable | no | — |
| `blocked` † | needs a human/harness fix before it can run | no | — |
| `superseded` † | replaced by a successor mission | **yes** | — |
| `completed` | stop condition met | **yes** | — |
| `failed` | unrecoverable | **yes** | — |

| From | Event | To | Guard | Actor |
|---|---|---|---|---|
| `draft` | `validate` | `locked` | `evor validate` returns ok **and** contract hash recorded | `evor_lock_mission` |
| `draft` | `invalidate` | `draft` | — | validate failure |
| `locked` | `start_run` | `running` | active-run written **and** seal hash matches contract on disk | `evor-run` Step 4 |
| `running` | `pause` | `paused` | run has no live job | `session-end.mjs`, operator |
| **`paused`** | **`resume`** | **`running`** | **seal hash unchanged** | **`/evor-resume` † — the edge F6 is missing** |
| `paused` | `reseal` | `locked` | contract re-validates | `evor_lock_mission` † |
| `running` | `stop_ok` | `completed` | `evor_check_stop.should_stop` **and** final report artifact present | orchestrator |
| `running` | `fail` | `failed` | reason recorded | orchestrator / operator |
| `running` | `lease_expired` | `paused` | `now - entered_at > max_dwell_s` **and** no live job | **sweeper (session-start hook / `evor doctor`) † — fixes C-01** |
| `running`,`paused`,`blocked` | `supersede` | `superseded` | successor mission exists **and** successor.state ≥ `locked` **and** `superseded_by` recorded | operator † — replaces the O-09 hand-edit |
| `running` | `block` | `blocked` | blocking reason recorded (e.g. "evaluator returns false negatives") | operator † — see §6 |
| `blocked` | `unblock` | `locked` | re-validate | operator † |
| *any non-terminal* | `force` | *any* | reason + actor recorded in `transitions.jsonl` | operator escape hatch (§4.4.3) |

**Illegal today but currently performed:** `locked --pause--> paused` by `session-end.mjs` with no
run ever started (this repo's committed artifact, `git diff` on
`.evor/runs/frontier-1ms/run-live-01/mission-state.json`). Under this table that is
`locked --pause--> ?` with no edge; the correct fix is that `session-end` may only pause a mission
in `running`, and that `paused --resume--> running` exists.

### 5.2 Run (`run-state.json`) — **or delete this file's status entirely**

Recommendation: **delete `run-state.status`.** It held `"running"` in all three field runs including
two explicitly failed ones, it duplicates the mission state, and nothing transitions it. If a
run must remain a distinct entity (one mission may have several runs), then:

| State | Meaning | Terminal | `max_dwell_s` |
|---|---|---|---|
| `initialized` | dirs + contract written, no tick yet | no | — |
| `running` | a tick is in flight | no | 7200 |
| `blocked` † | waiting on an external job/agent | no | 14400 |
| `stopping` † | stop verdict true, finalization in progress | no | 900 |
| `completed` / `failed` / `abandoned` † | — | **yes** | — |

| From | Event | To | Guard |
|---|---|---|---|
| `initialized` | `tick_start` | `running` | mission is `running` |
| `running` | `block` | `blocked` | `blocked_on` populated (§5.4) |
| `blocked` | `unblock` | `running` | awaited artifact exists **or** job status terminal |
| `blocked` | `lease_expired` | `failed` | dwell exceeded **and** job status not terminal → **this is K-09's stall detector** |
| `running` | `tick_done` | `running` | tick FSM terminal **and** `tick_count` incremented **atomically with it** (fixes O-08) |
| `running` | `stop_verdict` | `stopping` | `evor_check_stop.should_stop` |
| `stopping` | `finalize` | `completed` | report + plot artifacts present |
| `running`,`blocked` | `abandon` | `abandoned` | successor run recorded → **the r1/r2 case, currently unrepresentable (F5)** |

`tick_count` must move *inside* the `tick_done` transition. Today it is a separate optional patch,
which is precisely why r1 reports 0 ticks after running one (O-08).

### 5.3 Tick (`tick-state.json`) — position and completion separated

| State | Meaning | Terminal |
|---|---|---|
| `not_started` | — | no |
| `in_step` | executing step N | no |
| `awaiting` † | step N is waiting on an external producer | no |
| `step_failed` † | step N failed, retry budget remains | no |
| `complete` | all 9 steps reached a terminal step-state, ≥1 node recorded | **yes** |
| `failed` † | a step exhausted retries; **the tick is over and it did not work** | **yes** |
| `superseded` † | run abandoned / benchmark re-versioned mid-tick | **yes** |

| From | Event | To | Guard |
|---|---|---|---|
| `not_started` | `begin` | `in_step`(1) | prior tick terminal; handoff + inbox drained |
| `in_step`(N) | `step_done` | `in_step`(N+1) | **the step's post-condition artifact exists** — already written as prose per step (`SKILL.md:200,251,271,281,305`); becomes the guard |
| `in_step`(N) | `await` | `awaiting`(N) | `blocked_on` populated |
| `awaiting`(N) | `arrive` | `in_step`(N) | artifact present |
| `awaiting`(N) | `timeout` | `step_failed`(N) | dwell exceeded |
| `step_failed`(N) | `retry` | `in_step`(N) | attempts < max (`shouldAbortForge`, `state.ts:374-376`, already exists for Forge) |
| `step_failed`(N) | `give_up` | `failed` | attempts exhausted |
| `in_step`(9) | `finish` | `complete` | step 9 terminal **and** ≥1 node in `tree.json` **and** `pending_node_ids` empty |
| *any* | `supersede` | `superseded` | run abandoned |

**`finished(tick) := state ∈ {complete, failed, superseded}`** — one definition, one owner. The five
copies of `step >= 9` (§1.3) all become a call into the shared table. The field state
`step 9 / running / integrity failed` maps to `in_step(9)` — **not terminal** — and the stop hook
blocks, which is C-02 resolved without the false-stop the `6c713b7` comment feared, because
`complete` requires an explicit `finish` event rather than the absence of one.

### 5.4 Step (sub-state of the tick) — where the wait affordance lands

`pending → running → {done, failed, blocked}`, where `blocked` carries:

```json
{ "state": "blocked",
  "blocked_on": { "kind": "job|subagent|artifact|human",
                  "id": "<job_id | task_id | artifact path>",
                  "since": "<ISO8601>", "max_dwell_s": 14400 } }
```

This is the smallest change that addresses F2's *legibility* half. With it:
`stop.mjs` can block a stop when a step is `blocked` on a **live** job and force-fail it when the
job's `status.json` is already terminal; a proxy-waiter spawn becomes a detectable anomaly (a
`claude` agent spawned while a step is `blocked`); and the 11h49m poll gap is a single record.
It does **not** provide blocking — that stays with `TaskOutput block:true` / `Monitor`.

### 5.5 Job — the model to copy

`jobs.py:96` writes `state:"running"`; `jobs.py:198-202` flips to `succeeded|failed` with
`exit_code` + `finished_at`, in the supervisor, on child exit. **This is the only status in the
system that a program transitions**, and it is the only one that was correct in every field run.
Two states, one owner, one writer, transition bound to a real event. That is the target shape for
the other four.

---

## 6. Does the 9-step tick match how the research actually proceeded?

**No.** Three mission attempts over 19h11m produced **tick 1 of a 200-tick target, zero recorded
node outcomes** (`best_score: null`, `frontier_ids: []` in r3; lane-c §0).

What actually consumed the session was a different loop entirely — *diagnose the evaluator → patch
it → restart the mission*. The evidence is in the agents alive at kill (lane-c §C-01): of five,
**three were harness repair, not search**:

- `"Fix telemetry_sane false negative"`
- `"Patch EVOR integrity telemetry check"`
- `"Apply EDIT 10 and run test_integrity"`

and the two mission restarts were triggered by that loop, not by a stop condition: r1 abandoned at
10:41:55 (36 min after its tick outcome was dropped), r2 abandoned at 23:51.

**None of this is representable.**
- `decision_type` is a closed enum that maps one-to-one onto the 9 tick steps
  (`contracts.py:838-849`, RC4/I-01). A harness fix has no decision type, so it is not loggable.
- The tree records candidate genomes, not evaluator versions — a mid-run integrity-check patch
  silently changes the meaning of every prior and subsequent score with no record. (Compare the
  frozen-split machinery, which takes contamination extremely seriously: the *code* that produces
  the verdict is unversioned while the *data* is hashed.)
- There is no entity above the mission. Three attempts at one research goal are three unrelated
  missions whose only link is a `superseded_by` string typed by hand 14 hours later.

**Implication for this lane's recommendation.** An FSM over the 9-step tick formalizes a loop that
has completed **zero** times in the field. The loop that ran three times — attempt, diagnose,
repair, re-attempt — has no schema at all. So:

> **Build the mission FSM first (§5.1), with `blocked` + `superseded` + the `resume` edge; build
> the tick FSM (§5.3) second.** The defect cluster supports this: C-01, I-11, O-05, O-08, O-09 and
> F6 all live at the mission/run level. C-02 is the only tick-level member, and its fix is a
> single-owner `finished()` predicate that does not require the full tick FSM to land first.

Also worth adding above the mission: a **Campaign** (or `MissionAttempt`) entity — an ordered list
of missions against one research goal, with per-attempt `abandoned_reason`. That is the object the
operator was actually manipulating, in `vim`, at 00:13:36.

---

## 7. Recommendations, ranked by (defects closed) / (cost)

1. **Single-owner `finished(tick)`** in the shared table; delete the four hard-coded `step >= 9`
   copies (§1.3). Closes C-02. Small, and independent of everything else.
2. **Draw the `paused → running` resume edge and reconcile `stop.mjs:249` with
   `evor-run/SKILL.md:78-90`.** Closes F6, which currently makes every paused run unresumable *and*
   silences the stop hook. Small, and it is a live shipped bug, not a design debt.
3. **`entered_at` + `max_dwell_s` on every state, with a sweeper in the SessionStart hook.**
   Converts C-01, K-09, C-03 from unobservable to trivial. Two fields plus ~40 lines.
4. **Mission FSM as a JSON table + `transitions.jsonl`** (§4.3, §5.1). Closes I-11, O-09, F5;
   makes O-05 fixable by deletion.
5. **`blocked_on` on steps** (§5.4). Makes F2 legible and gives the stop hook a correct wait rule.
6. **Delete `run-state.status`**, move `tick_count` inside the tick-completion transition. Closes
   O-05, O-08.
7. **Tick FSM** (§5.3). Last, for the reason in §6.

Not recommended: `python-statemachine` (§4.5); an FSM in a single language (§4.3); any guard
without a logged `force` edge (§4.4.3).

---

## 8. Evidence index

| Claim | Source |
|---|---|
| 9 steps defined only in prose; no tick module | `skills/evor/SKILL.md:182-345`; `agents/evor-tick.md:28`; `ls harness/evor/` |
| `current_step` has zero non-test code writers | repo-wide grep (`--include=*.py,*.ts,*.mjs`, excl. tests/ci) |
| `TickStateSchema` local to `state.ts`, absent from `contracts.ts` | `mcp/src/tools/state.ts:22-31`; `mcp/src/contracts.ts:791-803` (`ALL_SCHEMAS`) |
| No `MissionState`/`RunState` model in 58 Python / 27 TS models | `harness/evor/contracts.py`; `mcp/src/contracts.ts`; RC4 |
| `mission-state.json` created as a bare dict | `harness/evor/init_run.py:218-227` |
| `mission_status` assigned without reading prior value | `mcp/src/tools/state.ts:216-238` (`ms.status = missionStatus`) |
| `locked` excluded from the patch enum | `mcp/src/tools/state.ts:53-60` |
| Five copies of the finished-predicate | `stop.mjs:254,373`; `session-start.mjs:379`; `post-compact.mjs:116`; `SKILL.md:417` |
| Predicate deliberately loosened against fixtures | `6c713b7`, quoted in RC5 |
| A real writer omits required `step_status` and adds undeclared fields | `.evor/runs/frontier-1ms/run-live-01/tick-state.json` (committed) |
| `session-end.mjs` is a third-language `mission-state.json` writer | `hooks/session-end.mjs:42-67` |
| `locked → paused` performed in this repo, never reversed | `git diff .evor/runs/frontier-1ms/run-live-01/mission-state.json` |
| `paused` silences the whole stop hook | `hooks/stop.mjs:74-86` |
| `stop.mjs` and `evor-run` disagree on the running value | `hooks/stop.mjs:248-249` vs `skills/evor-run/SKILL.md:78-90` |
| `/evor-resume` re-enters through `evor-run`'s lock gate | `commands/evor-resume.md:12-20`; `skills/evor-run/SKILL.md:52-66` |
| `job_complete` / `self_heal_event`: 6 prose mentions, 0 producers | repo-wide grep; `ARCHITECTURE.md:134`; `SKILL.md:143,145,280,505,550` |
| `SignalSchema.kind` is unconstrained `z.string()` | `mcp/src/contracts.ts:771` |
| Jobs are the only code-transitioned status | `harness/evor/jobs.py:96,198-202` |
| `pending_subagent_ids` read but never written | `hooks/stop.mjs:290-311` |
| Proxy waiters, busy-waits, 11h49m poll gap, 54 non-blocking stop hooks | lane-c §C-01, C-03, C-05, C-06 |
| Three runs `running`; 2 tick counters; hand-backfill + `.bak` chain | lane-o §O-05, O-08, O-09 |
| Harness-repair agents alive at kill | lane-c §C-01 (kill message, 02:20:30.823Z) |
| `decision_type` enum mirrors the 9 steps | `contracts.py:838-849` via RC4/I-01 |
| On-disk format has no owner; hooks are an unlocked third writer | RC3 |
| No pins; harness installed editable | `pyproject.toml` (no lower/upper bounds beyond `>=`); `install.sh:37` via RC4 |

**INFERRED, not verified in this lane** (probe given):
- That an operator override edge would have prevented the `vim` backfill — behavioural, needs a live
  run. Probe: instrument `evor_state_write` to log rejected transitions and count how often a manual
  file edit follows within 10 min.
- That `blocked_on` would suppress proxy-waiter spawns — needs a live session. Probe: add the field,
  then count `Agent` calls whose description matches `/^Wait for /`.
- That `max_dwell_s` on `running` would have fired during the 8h16m stall — depends on whether a job
  was genuinely running in 12:09→23:09, which lane-c left open as its own Wave-2 question.
