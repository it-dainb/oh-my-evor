# Lane L — Autonomy vs Human-in-the-Loop

**Scope:** oh-my-evor v1.2.0, binarization mission, 2026-08-23 → 2026-08-24. Read-only; nothing modified.

**VERDICT: NOT autonomous. 15 genuine human interventions, 12 of them AFTER the mission was
supposedly locked. The charter recorded in the run is `aggressive-never-halt`, whose own skill text
says "you NEVER stop to ask the user and you NEVER emit an `AskUserQuestion`". The orchestrator
emitted 11 blocking `AskUserQuestion` calls, 5 of them after `/evor-run`, and a human answered every
one. Two of the three mission restarts were caused by those answers.**

---

## 1. Session identification (timeline)

| Session | Span (UTC) | Lines | What it is |
|---|---|---|---|
| `8289a9d7-dedd-4aeb-a1af-0efd2bbb45fb` | 08-23 03:46:46 → 03:53:09 | 66 | **Plugin maintenance, not mission setup.** `/plugin` (→ "Updated oh-my-evor"), `/plugin`, `/reload-plugins`, then the human pastes a Semantic Scholar API key ("Jelp me update API key of…"). 2 genuine human turns. |
| `3f780be1-5c62-4415-942b-af30c300fde4` | 08-23 03:53:19 → 03:54:36 | 33 | **MCP smoke test.** One typed turn: "Tets mcp oh-my-evor:semantic-scholar with domain Diffusion LLM search". 1 genuine human turn. |
| `7fa9c902-5d34-4ddb-b3ca-ff6ac294f41f` | 08-23 07:09:29 → 08-24 02:20:32 | 1505 | **The mission run.** `/oh-my-evor:evor-setup` AND `/oh-my-evor:evor-run` both happen inside this one session — setup was not a separate earlier session. 15 genuine human interventions. |

Correction to the brief: neither small session is "the earlier setup session". Setup ran inside the
main session at 07:09:59, ~3h15m after the plugin was updated.

The two saved `.txt` transcripts in the project (`2026-06-23-…`, `2026-07-07-…`) are from June and
July 2026 (Claude Code v2.1.193, Opus 4.8 era) — a *previous* evor era, not this run. Useful for
what setup promised historically; not evidence about this run's autonomy.

---

## 2. Classification rule (auditable)

A JSONL entry counts as a **genuine human turn** only if it is one of:

1. `type == "user"` AND `promptSource` is absent/`"typed"` AND the content is a typed prompt or a
   `<command-name>` slash-command wrapper **that is not `isMeta`** (the `isMeta` twin is the skill
   body the harness expands, not human text); or
2. a `tool_result` for an `AskUserQuestion` `tool_use` (the answer text is literally the human's
   click / free-text — this is the trap in the *opposite* direction from the one the brief warned
   about: excluding all `tool_result` entries would have hidden 11 of the 15 interventions); or
3. a human abort: `toolDenialKind == "user-rejected"`, `type=="system" subtype=="agents_killed"`,
   or the `[Request interrupted by user]` marker. Multiple such records sharing one second are ONE
   intervention.

**Excluded** (all verified non-human): `promptSource == "system"` (50 entries — `<task-notification>`
subagent-completion wakes and `<agent-message>` relays), all other `tool_result` carriers, `isMeta`
skill-body expansions, `queue-operation` records, `<local-command-caveat>` wrappers, and the four
"Another Claude session sent a message … not typed by your user" teammate idle notifications from
`workspace-scout`.

**Also excluded, and important:** the 7 entries with `toolDenialKind == "permission-rule"` are the
**EVOR GOVERNOR PreToolUse hook**, not a human. Their payloads all begin `[EVOR GOVERNOR]`. The
session ran `permissionMode: bypassPermissions` for all 63 mode records, so the harness never showed
a permission prompt at all.

### Raw counts both ways — main session

| Measure | Count |
|---|---|
| All `type=="user"` JSONL entries | **172** |
| … carrying `tool_result` | 111 |
| … `promptSource=="system"` (harness/task-notification injected) | 50 |
| … remaining 11: slash-command wrappers (2 real + 4 `isMeta` twins), teammate idle notifications (4), interrupt marker (1) | 11 |
| Naive "user-role, non-tool_result, non-system-source" | 11 → collapses to **3** real |
| **Genuine human interventions (rule above)** | **15** |
| — typed prompts / slash commands | 3 |
| — `AskUserQuestion` answers | 11 |
| — standalone ESC abort | 1 |

(3 + 11 + 1 = 15; the terminal ESC at 02:20:30 is one of the 3 typed-lane items — see timeline.)

---

## 3. Human-intervention timeline (main session)

| # | UTC | Kind | Trigger | What it changed |
|---|---|---|---|---|
| H1 | 08-23 07:09:59 | typed `/oh-my-evor:evor-setup` | mission start | Whole mission spec (1853-char prompt). |
| H2 | 07:37:43 | AGENT-ASKED (waited 20m25s) | "Disk is at 100% (4.5 GB free). Training cannot proceed…" | Free-text "Other": prune corpora + restructure to centralized `images/`/`masks/`. |
| H3 | 07:42:58 | AGENT-ASKED (4m47s) | "Where is the in-house 4k data?" | Answered "its unlabeled"; **set budget = 200 ticks**. |
| H4 | 08:01:11 | AGENT-ASKED (17m34s) | Re-ask: still no data path | "Let the scout find it"; picked SOTA sources. |
| H5 | 08:06:31 | AGENT-ASKED (4m28s) | "Approve the cleanup + restructure plan?" | "Approve, and restructure v10 too". |
| H6 | 08:12:54 | AGENT-ASKED (4m32s) — **Launch Consent Checkpoint** | "Launch the mission with this contract? Everything above locks at init…" | **"start but add a per domain precision score >= 0 8"** — human edited the contract at the consent gate. This clause is the same one that later zeroed all fitness (H14). |
| H7 | 08:30:14 | AGENT-ASKED (3m51s) | `evor_freeze_splits` can't express 132/128 split | **"patch only no wdit CLAUDE"** — human authorized patching the *plugin harness* mid-setup. |
| H8 | 08:51:37 | typed `/oh-my-evor:evor-run` | run start | Tick loop begins. **Everything after this point should have been zero-human.** |
| H9 | 10:05:23 | AGENT-ASKED (32m50s) | "How should I correct the inverted GT polarity in the sealed evaluator?" | "Fix v1.py and re-seal as v1" — **re-sealed the sealed evaluator mid-run**. |
| H10 | 10:41:10 | AGENT-ASKED (26m44s) | "baseline_value=59.61 is locked but like-for-like is 0.22" | **"Re-setup with baseline 0.0"** → r1 marked failed, **r2 created 10:41:56**. |
| H11 | 10:56:13 | HUMAN-INITIATED-TRIAGE / ABORT | ESC on `evor-sage`'s Bash: `timeout 180 … for i in {1..30}; do sleep 4` poll of `sage/juniors/` | Killed a 3-minute foreground poll. Agent recovered and finished at 11:02:44. |
| H12 | 23:16:23 | AGENT-ASKED (40s) | "Evaluator forces `torch.set_num_threads(32)`, 15-24s @4k; at 8 threads 0.58s. Which latency should the contract gate on?" | "8 threads, gate at <1.0s" — **rewrote a locked contract gate**. |
| H13 | 23:41:54 | AGENT-ASKED (1m54s) | "GPU latency is memory-bandwidth-bound … the ~6 kMAC/px guidance I gave Mutagen is the wrong constraint" | "relax GPU gate up to …" → r2 marked failed, **r3 created 23:51:15**. |
| H14 | 08-24 01:37:45 | AGENT-ASKED (26m55s) | "Per-domain precision floor >=0.80 zeroes fitness … selection has no gradient across 199 ticks" | "Graded penalty instead" — **changed the fitness function 199 ticks into a 200-tick budget**. |
| H15 | 02:20:30 | **ABORT (terminal)** | Human ESC | `agents_killed`: 5 background agents stopped; 3 in-flight tool calls returned `user-rejected` at 02:20:30.830 / .842 / .930; `[Request interrupted by user]` at 02:20:32.091. **Run ends here.** |

Human wall-clock spent *blocking the system* at `AskUserQuestion` gates: **8,680 s = 2 h 24 m 40 s**
across 11 answers (min 40 s, max 32 m 50 s, median ~4 m 47 s → later gates skew much longer).

---

## 4. Longest unattended stretch — the headline number

Gaps between consecutive genuine human interventions (assistant-message count in each):

| From → To | Wall clock | Assistant turns |
|---|---|---|
| H8 `/evor-run` → H9 | 1 h 13 m 46 s | 24 |
| H9 → H10 | 35 m 47 s | 15 |
| H10 → H11 | 15 m 03 s | 18 |
| **H11 → H12** | **12 h 20 m 10 s** | **41** |
| H12 → H13 | 25 m 31 s | 16 |
| H13 → H14 | 1 h 55 m 51 s | 71 |
| H14 → H15 | 42 m 46 s | 33 |

**Headline: 12 h 20 m / 41 assistant turns.** But that number is mostly dead air, and reporting it
unqualified would flatter the system. Inside that window the orchestrator emitted **nothing at all**
for two long stretches:

- 08-23 11:52:38 → 14:53:36 — **3 h 00 m 58 s** silent
- 08-23 14:53:39 → 23:09:34 — **8 h 15 m 55 s** silent

i.e. **11 h 17 m of the 12 h 20 m (91 %) was the orchestrator idle**, parked waiting for one training
job. It did eventually self-wake via a `<task-notification>` at 23:09:34 — no human was needed for
the wake — but within 6 minutes of waking it asked a human a question (H12).

**The honest number: the longest stretch of actual autonomous *work* between human touches is
1 h 55 m 51 s / 71 assistant turns (H13 → H14).** Median inter-intervention gap across the whole
post-`/evor-run` phase: ~42 minutes.

Corroborating harness record: the final `turn_duration` system entry is
`durationMs: 68868550` (**19 h 08 m**) with `messageCount: 742` — the harness itself treated the
whole post-setup period as one turn. That is the "it ran for 19 hours" framing; it is true only in
the sense that no *new prompt* was typed. Eleven blocking questions were answered inside it.

---

## 5. Interrupt-reason taxonomy

| Category | Count | Notes |
|---|---|---|
| **AGENT-ASKED** | **11** | All `AskUserQuestion` from the main orchestrator. Zero from any of the 97 subagents. |
| **RESTART/REDIRECT** | **7** (overlay, not disjoint) | H1 (mission), H6 (added precision floor at the consent gate), H8 (`/evor-run`), H9 (re-seal evaluator), H10 (→ r2), H12+H13 (→ r3), H14 (fitness function). |
| **HUMAN-INITIATED-TRIAGE** | **1** | H11 — human ESC'd a sleep-poll nobody asked them to. |
| **ABORT** | **2** | H11 (one tool call), H15 (terminal, 5 agents + 3 in-flight calls). |
| **PERMISSION-PROMPT** | **0 — explicitly zero.** | `permissionMode: bypassPermissions` on all 63 mode records; the harness never prompted. The 7 `permission-rule` denials are the EVOR GOVERNOR hook. |

**Correction to Lane B's seed:** the 4 `"The user doesn't want to proceed with this tool use"` events
are **not 4 independent refusals**. Three of them (`agent-a4d12a0b…` 02:20:30.830 Bash,
`agent-a6189b43…` 02:20:30.842 Bash, `agent-ae4380923…` 02:20:30.930 SendMessage) fire within
100 ms of each other and within 7 ms of the `agents_killed` record at 02:20:30.823 — they are the
collateral of **one** human ESC. Only `agent-a658b68f…` at 2026-08-23T10:56:13.520Z is a separate
event. So: **2 human aborts, not 4 refusals.**

---

## 6. BLOCKED-ON-HUMAN

**Every one of the 11 `AskUserQuestion` calls is a hard block** — the tick loop cannot advance until
a human clicks. There is no autonomous fallback: no timeout, no default option, no "proceed with
recommended after N minutes". The `(Recommended)` label on several options proves the agent already
knew the answer it wanted and asked anyway. Five of these gates (H9, H10, H12, H13, H14) sit
*inside* the tick loop, after `/evor-run`, under `posture: aggressive-never-halt`.

Consequences that were decided by a human, not the invariant:
- **r1 → r2** (`superseded_reason: "sealed evaluator scored paper as ink (inverted GT polarity);
  baseline_value 59.61 was not like-for-like"`) — decided at H9 + H10.
- **r2 → r3** (`superseded_reason: "latency gates did not match the contract; superseded by r3 with
  GPU<500ms and quantization angle"`) — decided at H12 + H13.

**Did the terminal rejected SendMessage stop the run?** No — cause and effect are the other way
round. The `SendMessage` from `evor-forge-junior` to `evor-forge` was rejected *because* the human
pressed ESC 107 ms earlier; `agents_killed` (02:20:30.823) precedes it (02:20:30.930). The run did
not end on a refusal of that message; the run ended on a human abort that happened to catch that
message in flight. It was also **not** ending on its own: `.evor/active-run.json` still reads
`"status": "running"`, r3's `mission-state.json` still reads `"status": "running"`, and the run was
at tick 1 of a 200-tick budget. **The run was killed, not completed.**

---

## 7. Autonomy-defeating patterns

- **Foreground sleep-polling (8 blocked calls).** Agents repeatedly tried `sleep 30/60/90/180/240`
  to wait for their own long jobs; the harness blocked all 8 with
  `<tool_use_error>Blocked: sleep N followed by: …`. Timestamps: 09:21:17, 09:33:32, 11:09:31,
  11:16:39, 11:27:56, 11:31:12, 00:04:38, 02:08:17. These are `toolDenialKind: null` harness errors —
  distinct from the human `user-rejected` events. The system's default instinct for "wait for my own
  training run" was a blocking sleep, i.e. it could not wait properly unattended.
- **Monitor used, but as a poll, not a wake.** 13 `Monitor` calls, all `until`-loops over the
  *filesystem* — e.g. `until [ -f "$D/.../forge-report.json" ]`, `until grep -q
  "TestTelemetrySaneHardened" …`. Agents wait on *peer agents' artifacts* by spinning on files;
  there is no wake protocol between agents. Three of the last four Monitor calls (02:08, 02:15,
  02:16, 02:16) are the same grep retried with a longer sleep — a spin loop right before the abort.
- **The Stop hook never forced continuation.** All 54 `stop_hook_summary` records have
  `preventedContinuation: false`, `hasOutput: false`, `level: "suggestion"`. So the session's
  continuation was NOT hook-driven: it was driven by 50 `promptSource:"system"`
  `<task-notification>` / `<agent-message>` wakes when subagents finished. To the system's credit,
  that mechanism worked unattended — including the 8h15m training wait. The autonomy failure is not
  the wake mechanism; it is the 11 questions.
- **The designed unattended path was never used.** `evor-schedule` (the skill whose description is
  literally "Set up unattended, multi-day EVOR operation") was never invoked, and `CronCreate` was
  called **0** times, despite `evor-run/SKILL.md` Step 5 prescribing exactly that for
  "multi-hour or overnight runs". The run took the *attended* branch and then ran 19 hours on it.
- **Agent yielding control expecting a human to be watching.** `agent-a4d12a0b7e85550fd`'s last text
  before being killed: *"A `probe/` stage directory appeared in the tick dir at 01:59 while `forge/`
  is unchanged since 01:10. Continuing the wait."* — 50 minutes of no progress, reported as a status
  update rather than escalated or resolved.

---

## 8. DESIGN vs REALITY

**Claim** — `skills/evor/SKILL.md:67`:
> "**After setup, this mission runs FULLY AUTONOMOUS to the goal — ZERO human-in-the-loop.** When the
> autonomy charter posture is `aggressive-never-halt`, you NEVER stop to ask the user and you NEVER
> emit an `AskUserQuestion`. Every decision — including novel ones — is auto-resolved by the
> Monotonic-Honesty Invariant. Setup was the sole human step."

**Recorded posture** — `runs/…-r3/run-live-01/goal-contract.json`:
```json
"autonomy_charter": { "posture": "aggressive-never-halt", "license_gate": false,
                      "data_acquisition_enabled": true, … }
```

**Reality:** 5 `AskUserQuestion` calls after `/evor-run` (09:32:33, 10:14:27, 23:15:43, 23:39:59,
01:10:50), all answered by a human, all changing the run. Direct, unambiguous charter violation.

---

**Claim** — `skills/evor/SKILL.md:91`, on the single safety backstop:
> "A correctly-built plugin never hits this, so in practice you still run start→goal with no human."

**Reality:** the run hit human-blocking decisions at least 5 times mid-loop, and none of them were
the integrity backstop. They were ordinary engineering ambiguities — thread count, GPU gate,
baseline, evaluator polarity, fitness shape. Notably H14 ("if nothing ever clears 22/22, every node
scores 0.0 and selection has no gradient") is *exactly* the kind of "make it easier" decision the
Monotonic-Honesty Invariant forbids the agent from taking alone — so the charter's claim that "a
monotonic move ALWAYS exists" is false in practice: here the only viable move was to *soften* the
fitness floor, the invariant forbade it, and the agent's only escape was to ask a human. **The
charter's no-halt guarantee and its no-softening rule are in direct contradiction.**

---

**Claim** — `skills/evor-setup/SKILL.md:402` (Launch Consent Checkpoint):
> "Before initializing the run, display a summary and require explicit consent … This checkpoint
> CANNOT be skipped."
and `SKILL.md:489`: Print *"Mission will run FULLY AUTONOMOUS to the goal — the monotonic-honesty
invariant auto-decides every mid-run choice with no human questions."*

**Reality:** the consent gate worked (H6), and the system *printed* the fully-autonomous promise —
then asked 5 more questions. Worse, the human used the consent gate as a *free-text contract editor*
("start but add a per domain precision score >= 0 8"), and that unvalidated clause is what zeroed all
fitness and forced H14 seventeen hours later. The gate accepts arbitrary contract mutations with no
feasibility check.

---

**Claim** — `skills/evor-setup/SKILL.md:396`: on preflight failure → "abort setup".
**Reality (H7):** the freeze-splits blocker was resolved by asking the human, who authorized
patching the plugin's own harness (`"patch only no wdit CLAUDE"`). Neither "abort" nor "proceed"
was the outcome; a third path — mutate the tool — was invented at an `AskUserQuestion`.

---

## 9. Findings

| ID | Sev | Category | Timestamp (UTC) | Finding | Wave-2 question |
|---|---|---|---|---|---|
| **L-01** | **BLOCKER** | Design-vs-reality | 09:32:33, 10:14:27, 23:15:43, 23:39:59, 01:10:50 | `posture: aggressive-never-halt` forbids `AskUserQuestion`; the orchestrator emitted 5 of them post-`/evor-run` and blocked on all 5. The charter is unenforced prose. | Is there ANY mechanism (hook, governor rule, tool gate) that blocks `AskUserQuestion` when posture is `aggressive-never-halt`? The PreToolUse governor gates Bash/Write/Agent — why not this? |
| **L-02** | **BLOCKER** | Blocked-on-human | 01:10:50 → 01:37:45 | The Monotonic-Honesty Invariant is *incomplete*: the per-domain precision floor made every node score 0.0, and the only fix (graded penalty) is a forbidden "softening" move. Charter says "a monotonic move ALWAYS exists" — here none did, and the agent halted for a human. | Enumerate other contract shapes where no monotonic move exists. Should the invariant have a "contract is infeasible → auto-relax with a logged DecisionLogEntry" branch? |
| **L-03** | HIGH | Blocked-on-human | all 11 asks | No timeout, no default, no auto-select-Recommended on any `AskUserQuestion`. Several options are literally labelled `(Recommended)` — the agent knew the answer. 2 h 24 m 40 s of pure human-wait, one gate blocking 32 m 50 s. | Would auto-selecting `(Recommended)` after a timeout have produced the same run? Replay H9/H10/H12/H13 with the recommended option. |
| **L-04** | HIGH | Restart/redirect | 10:41:10 (→r2), 23:41:54 (→r3) | Both mission restarts were human decisions at `AskUserQuestion`. `.evor` state shows r1 and r2 `superseded_reason` strings that paraphrase the human's chosen option. The system did not self-heal; a human triaged and redirected it twice. | Could the polarity bug (r1) and the latency-gate mismatch (r2) have been caught by a preflight/consent-time feasibility check instead of 2 h and 13 h into the run? |
| **L-05** | HIGH | Design-vs-reality | 08:12:54 | The "CANNOT be skipped" consent gate accepts free-text contract mutations ("start but add a per domain precision score >= 0 8") with zero feasibility validation. That clause directly caused L-02. | Does `evor_init_run` validate that a human-added gate is satisfiable against the measured baseline? (Incumbent scored min-domain precision 0.0040 against a 0.80 floor — trivially detectable at init.) |
| **L-06** | HIGH | Autonomy-defeating | 09:21:17 … 02:08:17 (8 events) | Agents' default wait primitive is a foreground `sleep` (30–240 s); the harness blocked all 8. Agents cannot wait for their own long jobs without external help. | Why do the agent files not prescribe `run_in_background` + task-notification? The block message teaches it every time and the lesson never propagated across 97 subagents. |
| **L-07** | MED | Autonomy-defeating | 11:09–02:16 (13 Monitor calls) | Inter-agent coordination is filesystem spin-polling (`until [ -f forge-report.json ]`). No wake protocol between peer agents. One agent spun on the same grep 3× in 90 s right before the abort. | Is there a designed agent-to-agent completion signal (`evor_signal_emit`?) that these agents should have used instead of `until [ -f … ]`? |
| **L-08** | MED | Autonomy-defeating | 11:52:38 → 23:09:34 | 11 h 17 m of total orchestrator silence inside the "longest unattended" window. The wake did eventually fire, but nothing checked liveness for 8 h 16 m — a hung trainer would have looked identical. | Is there a heartbeat/staleness detector on a running job? What is the timeout on `jobs/<id>/status.json` before the run is declared stalled? |
| **L-09** | MED | Design-vs-reality | whole run | `evor-schedule` — the skill explicitly for "unattended, multi-day operation" — was never invoked and `CronCreate` was called 0 times, yet the run went 19 h. The attended branch was used for an unattended workload. | Should `/evor-run` refuse (or auto-escalate to schedule mode) when `budget.max_iterations` × est. tick time exceeds the ~4 h attended threshold named in `evor-run/SKILL.md:96`? |
| **L-10** | MED | Reporting integrity | 02:20:30 | Run terminated by human ESC at tick 1 of 200, yet `.evor/active-run.json` and r3's `mission-state.json` both still read `"status": "running"`. No SessionEnd/abort reconciliation. | Does `session-end.mjs` write a terminal status? If so why did it not fire on ESC-kill? |
| **L-11** | LOW | Fact correction | 02:20:30.823–.930 | Lane B's "4 refusals" are 2 human aborts: 3 of the 4 are collateral of the single terminal ESC (all within 107 ms of `agents_killed`). The terminal `SendMessage` rejection is an *effect* of the abort, not its cause. | — (correction to sibling lane; no wave-2 work) |
| **L-12** | LOW | Human-turn census | 07:10:03, 07:10:14, 08:07:03, 08:07:21, 08:07:58, 08:51:45, 00:17:48 | 7 `toolDenialKind: permission-rule` events are the EVOR GOVERNOR hook, not human refusals. `permissionMode` was `bypassPermissions` for all 63 records — **PERMISSION-PROMPT interventions: zero**. | — (baseline for other lanes) |

**Categories with zero hits, stated explicitly:**
- **PERMISSION-PROMPT: 0.** The harness never prompted the user to approve a tool call. `bypassPermissions` throughout.
- **Subagent `AskUserQuestion`: 0** across all 97 subagent transcripts. Only the top-level orchestrator asked.
- **Stop-hook forced continuation: 0.** All 54 `stop_hook_summary` records have `preventedContinuation: false`. The loop was driven by task-notification wakes, not by a hook refusing to let it stop.
- **`CronCreate` / scheduled operation: 0.**

---

## 10. Direct answer

**Was it fully autonomous after setup? No.**

After `/evor-run` at 08:51:37 the system ran for 17 h 28 m 53 s and required **7 human
interventions** in that window (5 blocking questions, 1 mid-run ESC, 1 terminal ESC). It never went
longer than **1 h 55 m of active work** without a human, changed its own locked contract **twice**
on human instruction, restarted the mission **twice** on human instruction, reached **tick 1 of
200**, and ended when a human killed it — with its own state files still claiming `"running"`.

The wake/notification plumbing genuinely is unattended-capable: it self-woke across an 8-hour
training job with no human. The failure is not plumbing. It is that the `aggressive-never-halt`
charter is prose in a skill file with nothing enforcing it, and the decision policy it describes
(never soften) has no defined behaviour for the case the run actually hit (nothing but softening
works) — so the agent did the only thing left and asked a person.
