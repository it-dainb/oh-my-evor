# Lane C — Loops, Stalls, Non-termination (Wave 1 inventory)

Run: oh-my-evor v1.2.0, `/home/dainb_1/research/binarization`, 2026-08-23 07:09:29Z → 2026-08-24 02:20:32Z (**19h11m**).
MAIN = `.../7fa9c902-5d34-4ddb-b3ca-ff6ac294f41f.jsonl` (1505 lines). SUBAGENTS = 97 transcripts.
Read-only inventory. No root-causing, no fixes.

## 0. Session shape

| metric | value |
|---|---|
| MAIN records | 1505 (445 queue-operation, 324 assistant, 191 attachment, 172 user, 58 system) |
| tool_use in MAIN | 111 (32 Agent, 21 SendMessage, 11 AskUserQuestion, 29 evor MCP) |
| subagents spawned | 97 — depth0=1, depth1=28, depth2=23, depth3=45 |
| agent types | 15 general-purpose, 15 claude, 12 sage-junior, 11 forge-junior, 8 forge, 5 each tick/sage/mutagen/forge-critic/forge-architect, 4 selector, 4 forge-analyst, 1 each workspace-scout/probe/Explore |
| stop hook invocations | 54 — **`preventedContinuation: false` on all 54**, zero hookErrors, max 299 ms |
| missions attempted | 3 (r1 `…-2026-08`, r2 `…-r2`, r3 `…-r3`) — r1/r2 marked `failed`, r3 left `running` |
| nodes with a recorded outcome in r3 `tree.json` | **0** |

Three sequential missions were created and two abandoned; the run produced no promoted node
(`best_score: null`, `frontier_ids: []`, `pending_node_ids: []` in r3 `run-state.json`).

---

## C-01 — BLOCKER — NEVER-TERMINATED

`/home/dainb_1/research/binarization/.evor/active-run.json` still reads:

    "status": "running", "started_at": "2026-08-24T00:05:00Z", "run_id": "run-live-01"

Reconciliation against the transcript:

| artifact | last write | value |
|---|---|---|
| `active-run.json` | — | `status: running` |
| r3 `run-state.json` | 2026-08-24 02:00 | `status: running`, `tick_count: 1`, `best_score: null` |
| r3 `mission-state.json` | 2026-08-24 **00:12:56** | `status: running`, `tick: null` — **stale by 2h07m** |
| r3 `tick-state.json` | 2026-08-24 02:05:00 | `tick 1, current_step 9, step_status "running"`, `integrity_verdict "failed"` |
| MAIN last event | 2026-08-24 02:20:32 | session killed by user |

The session did not terminate — it was **killed**. The final MAIN queue event (02:20:30.823Z) is:

    5 background agents were stopped by the user: "Read-only reconnaissance of /home/dainb_1/research...",
    "Wait for forge artifact", "Fix telemetry_sane false negative", "Patch EVOR integrity telemetry check",
    "Apply EDIT 10 and run test_integrity".

Five live agents orphaned mid-flight; run state never closed. `mission-state.json` for r3 was
last touched at 00:12:56 and never updated across the following two hours of work, so even the
in-repo record of the mission is 2 hours behind the tick record it is supposed to summarize.

**Wave-2 question:** what is supposed to write the terminal `status` — `session-end.mjs`, an
MCP call, or nothing? And why does `mission-state.json` stop tracking `tick-state.json` after 00:12?

---

## C-02 — BLOCKER — STOP-HOOK-LOOP: **ZERO HITS, AND THAT IS THE DEFECT**

The task asked for evidence of a Stop hook re-prompting the agent. **There is none.** The
inverse happened, which is worse.

- 54 `stop_hook_summary` records in MAIN. `preventedContinuation` is `false` on **all 54**.
- `grep` for `EVOR CONTINUATION`, `EVOR DRIFT GUARD`, `blockStop`, `boulder` in MAIN → **0 hits each**.
- The hook ran (149–299 ms each) and never once blocked a stop.

The continuation guard in `hooks/stop.mjs:367..380` computes:

    const step = typeof ts?.current_step === 'number' ? ts.current_step : 0;
    const finished = step >= 9;
    if (started && !finished) { blockStop(...) }

Final r3 `tick-state.json` is `current_step: 9, step_status: "running"`. `step >= 9` ⇒
`finished = true` ⇒ guard silent — despite `step_status` explicitly saying `running` and
`integrity_verdict: "failed"`. The guard's own source comment anticipates this
("Also requiring `step_status === 'done'` would block runs whose tick-state omits that field
— a false-stop"), i.e. the leniency is deliberate and it is exactly what let the run drift.

Consequence: at every one of the 54 stop points the orchestrator was free to end its turn,
which is the direct cause of C-03's dead time.

**Wave-2 question:** how long did r3 sit at `current_step: 9 / step_status: "running"`, and would
a `step_status === "done"` conjunct have fired without introducing the false-stop the comment fears?

---

## C-03 — BLOCKER — STALL: 11h00m of dead wall-clock in one window

30 gaps > 5 min between consecutive MAIN events. Total dead time dwarfs the productive time.

Top stalls:

| duration | window | MAIN lines | preceded by |
|---|---|---|---|
| **495.8 min (8h16m)** | 2026-08-23 14:53:39 → 23:09:25 | L875→L876 | `stop_hook_summary` (not blocked) |
| **164.1 min (2h44m)** | 2026-08-23 12:09:25 → 14:53:29 | L868→L869 | queue enqueue |
| 32.8 min | 09:32:33 → 10:05:23 | L545→L546 | assistant turn end (awaiting AskUserQuestion) |
| 26.9 min | 01:10:50 → 01:37:45 | L1327→L1328 | assistant turn end (awaiting AskUserQuestion) |
| 26.7 min | 10:14:27 → 10:41:10 | L624→L625 | assistant turn end (awaiting AskUserQuestion) |
| 20.4 min | 07:17:18 → 07:37:43 | L111→L112 | AskUserQuestion |
| 18.8 / 17.6 / 16.8 / 16.6 / 16.5 min | various | | stop_hook / assistant |

The 12:09→23:09 block is one continuous 11-hour outage broken by a single event at 14:53.
Pattern in both mega-stalls: MAIN ends its turn, the stop hook permits it (C-02), and the
session sleeps until a background task notification wakes it. Nothing was blocking on anything.

Seen from inside the tick agent, the same stall is a polling gap: `a78d6b64199b90219`
(`evor-tick`, depth 1) polls `evor_read_artifact{tick:1, agent:"forge"}` at 11:19:19 and
11:20:06, then **next poll is 23:10:05** — an 11h49m gap inside a single agent's wait loop.
That agent's transcript spans 10:43:51 → 23:38:45 (12h55m) for one tick.

**Wave-2 question:** during 12:09–23:09 was a training job genuinely running (check job
`c4a5e447-…` and forge worktrees), or was every participant idle waiting on every other?

---

## C-04 — HIGH — SUBAGENT-WAIT-FAILURE (a): results enqueued then discarded

Queue accounting in MAIN: **226 enqueue, 57 dequeue, 162 remove.**
`dequeue` = delivered into context; `remove` = dropped. **~72% of all completion
notifications never entered the orchestrator's context.**

Two distinct discard mechanisms, both confirmed:

**(i) Enqueue-then-immediate-remove** (dominant). The notification is dropped within ~15 ms
of arriving because MAIN is mid-turn. Spot check, MAIN L379–L382:

    L379 enqueue 08:54:43.521Z aa592895de9fb340b
    L380 remove  08:54:43.534Z aa592895de9fb340b     (13 ms)
    L381 enqueue 08:55:44.907Z a2b6461cadd031510
    L382 remove  08:55:44.925Z a2b6461cadd031510     (18 ms)

**(ii) User-turn queue flush.** When an `AskUserQuestion` answer lands, pending notifications
are purged. MAIN L546–L549, all at 2026-08-23 10:05:23:

    L546 user   tool_result "Your questions have been answered: …Fix v1.py and re-seal as v1"
    L547 remove <agent-message from="oh-my-evor:evor-forge-critic">
                "VERDICT FLIPPED: approved -> REJECTED. My 09:30 review passed genome.yaml.
                 forge-junior edited genome.yaml at 09…"
    L548 remove task afec7e78c7ac3e2b3 "Implement worst-domain-prioritized-design" completed
    L549 remove task a3bcda02926248171 "Resume Evor tick 1" completed

A critic's verdict reversal and a completed tick were both discarded by the same user answer.

**Depth-controlled orphan counts** (depth 2/3 report to their own parent, so their absence
from MAIN's context is expected and is *not* counted as a fault):

| depth | spawned | notif enqueued in MAIN | consumed into MAIN context |
|---|---|---|---|
| 1 | 28 | 26 | 22 |
| 2 | 23 | 23 | 5 |
| 3 | 45 | 45 | 1 |

**4 genuine depth-1 orphans** — direct children of MAIN whose completion never reached it:

| agent | type | enqueued | removed | summary |
|---|---|---|---|---|
| **`a3bcda02926248171`** | **evor-tick** | 09:53:29 | 10:05:23 | "Resume Evor tick 1" |
| `ab74f0d2b44ed36ef` | claude | 10:24:11 | 10:41:10 | "Apply verified evaluator fixes" |
| `add99ed2ffed782fc` | claude | 23:15:22 | 23:16:23 | "Verify iir-binnet-01 artifacts on disk" |
| `a87b6c7cf6fb23dbb` | claude | 00:21:39 | 00:21:52 | "Wait for mutagen artifact" |

The first is the significant one. `a3bcda02926248171` is an `evor-tick` — the mission's unit of
work. It ran 09:20:04 → 09:53:29 (138 lines) and finished with a real, well-formed outcome:

    {"tick":1,"outcome":"rejected","node_id":"multiscale-stroke-gate-01-2",
     "pointers":[{…"agent":"forge"},{…"agent":"selector"},{…"agent":"mutagen"}]}

MAIN never read it. 36 minutes later (10:41:55) MAIN called `evor_init_run` for a brand-new
mission `…-r2`, abandoning r1. **A completed tick result was discarded and the mission restarted
without it.** The same shape recurs at 23:51 when r2 is abandoned for r3.

Note also the irony of `a87b6c7cf6fb23dbb`: an agent whose entire job was *"Wait for mutagen
artifact"* had its own result dropped.

**Wave-2 question:** is `remove` a deliberate "drop while busy" policy or a queue bug? And does
any code path re-deliver a removed notification — because the r1 tick outcome was never re-read.

---

## C-05 — HIGH — SUBAGENT-WAIT-FAILURE (b): no blocking primitive, so agents busy-wait

MAIN never used a blocking wait. Instead it spawned **proxy waiter agents** — three of the 32
Agent calls exist solely to wait:

    L1158  2026-08-24T00:18:03Z  "Wait for mutagen artifact"
    L1212  2026-08-24T00:35:22Z  "Wait for selector verdict"
    L1266  2026-08-24T00:53:51Z  "Wait for forge artifact"

("Wait for forge artifact" was still alive when the user killed the session — see C-01.)

Inside subagents the same gap produces spin-waiting. `afff04fd9da2e3a8e` (`evor-forge-junior`)
burns turns to stay alive, 2026-08-23 11:25:28 → 11:28:48:

    11:25:28…11:25:50   6× identical Bash (cd .evor/worktrees/iir-binnet-01 …)
    11:27:56            sleep 60; cat …/tasks/…output
    11:28:14            echo waiting
    11:28:19            true          ← 10× total in this transcript
    11:28:22            sleep 1
    11:28:48            echo idle

**Wave-2 question:** does the harness expose a blocking wait (`TaskOutput block:true`, `Monitor`)
that these agents could reach, and if so why did none of them use it?

---

## C-06 — HIGH — HARD-LOOP: identical-argument polling for sibling artifacts

Top repeated tool calls with byte-identical arguments, per agent (N ≥ 3):

| N | agent | type | call |
|---|---|---|---|
| 10 | `afff04fd9da2e3a8e` | forge-junior | `Bash {"command":"true"}` |
| 6 | `a3bcda02926248171` | **evor-tick** | `evor_read_artifact {run_id:"run-live-01", tick:1, agent:"forge"}` |
| 5 | `a78d6b64199b90219` | **evor-tick** | `evor_read_artifact {…, agent:"forge"}` |
| 5 | `a658b68f9ea1110eb` | evor-sage | `ToolSearch {query:"select:…evor_read_handoff", max_results:1}` |
| 5 | `a4d12a0b7e85550fd` | claude | `Bash {"command":"R=/home/…/-r3/run…"}` |
| 4 | `aa7ecba96a8a47c4a` | evor-forge | `evor_read_artifact {…, agent:"forge-analyst"}` |
| 4 | `a12e6dab8b80f08e2` | forge-junior | `Bash {"command":"sleep 1"}` |
| 3 | `a21027faa06f1af3f` | **evor-tick** | `evor_read_artifact {…, agent:"mutagen"}` |

`a3bcda02926248171` poll timeline (identical args, `agent:"forge"`): 09:20:13, 09:21:41,
09:22:00, 09:32:16, 09:32:35, 09:52:36 — 6 polls over 32 min with unbounded backoff.
`a78d6b64199b90219`: 10:45:05 → 23:19:01, 13 polls over 12h34m across mutagen/sage/selector/forge.

Every one of these is the same shape: a coordinator agent has no way to *await* a sibling's
artifact, so it re-reads the same key until it appears or the agent dies.

**Wave-2 question:** is `evor_read_artifact` returning `{ok:false, not_found}` or an error on a
miss — i.e. does the poller have any way to distinguish "not yet written" from "never coming"?

---

## C-07 — MEDIUM — HARD-LOOP: `evor_init_run` schema-guessing, 4 attempts

MAIN L183–L204, 2026-08-23 08:13:25 → 08:14:20 (55 s), 4 calls, same `mission_id`, near-identical
payloads. Each rejected with a *different* validation error; the model reshapes and retries:

| line | ts | result |
|---|---|---|
| 183 | 08:13:25 | `ok:false` — `metric_specs.{1,2,3,4}.role` must be `primary_fitness`/`secondary_reported` |
| 189 | 08:13:43 | `ok:false` — `expansion_policy.sota_sources.*.{source_id,retrieval_method,trust_level}` required |
| 198 | 08:14:02 | `ok:false` — `sota_sources.*.name` required; `retrieval_method` must be `mcp_search`/`web_fetch`/`human_provided`; `trust_level` must be `authoritative`/`indicative` |
| 202 | 08:14:20 | `ok:true` |

Payload grew 5081 → 5572 → 5698 → 5833 bytes. Also note the sibling shape at L250/L298
(`evor_freeze_splits`, identical args, 16 min apart, straddling an AskUserQuestion about the
tool being unable to express the required split) and L307/L321 (`evor_seal_eval_script`,
identical args, 45 s apart, straddling an agent spawned to move a file the tool expected).
Bounded (each terminated), hence MEDIUM — but this is Lane B's error surface leaking into control flow.

**Wave-2 question:** why are the schema violations revealed one layer at a time rather than
all at once — is validation short-circuiting on first failing subtree?

---

## C-08 — MEDIUM — SUBAGENT-DIED: 15 agents end mid-tool-loop with no final turn

18 of 97 transcripts end on a `user` record (a tool_result) with **no assistant turn after it** —
the agent received a result and never spoke again, so it returned no report to its parent.
3 of those are the user's terminal kill (`[Request interrupted by user for tool use]`,
`stoppedByUser: true`); the remaining **15 died silently**:

| agent | type | d | lines | last ts | last tool_result |
|---|---|---|---|---|---|
| `a2b6461cadd031510` | mutagen | 2 | 57 | 08-23 08:55:44 | `No matching deferred tools found` |
| `abcf43be6fb09796d` | mutagen | 3 | 54 | 08-23 08:59:43 | meta_iteration JSON |
| `ac35af2f78bd40577` | sage-junior | 3 | 80 | 08-23 09:03:16 | `{"ok":true,…}` |
| `a8628ef79260f4327` | forge-junior | 3 | 185 | 08-23 09:40:14 | skeletonization source |
| `ae032f685c8a49d35` | forge-analyst | 3 | 85 | 08-23 09:49:57 | `{"ok":true,…}` |
| `a422f5b873de3ee7b` | forge-analyst | 3 | 92 | 08-23 09:50:30 | `tool_reference: SendMessage` |
| `a0c0679c9d7c6c9ee` | sage-junior | 3 | 59 | 08-23 10:51:32 | paper text |
| `a06785e01abd654b6` | forge-architect | 3 | 39 | 08-23 11:11:07 | scan-brightness stats |
| `a3340d607fe0dd28f` | forge-architect | 3 | 42 | 08-23 11:35:05 | `{"ok":true,…}` |
| `a2d4b08ff91a0035d` | forge-junior | 3 | 91 | 08-23 11:40:50 | `No matching deferred tools found` |
| `a3c44e832c15c4cb7` | sage-junior | 3 | 70 | 08-24 00:26:32 | `{"ok":false,"error":"payload validation failed…"}` |
| `a463e4ec31f49e15e` | sage-junior | 3 | 81 | 08-24 00:27:44 | `{"ok":true,…}` |
| `a45104c20dc6c64a2` | sage-junior | 3 | 82 | 08-24 00:28:34 | `{"ok":true,…}` |
| `a914fb0c52c3713ab` | forge-analyst | 3 | 74 | 08-24 01:01:41 | `tool_reference: SendMessage` |
| `a60047ec408340f38` | evor-probe | 2 | 78 | 08-24 01:59:29 | `<tool_use_error>No such tool available: mcp__plugin_oh-my_evor_evor__evor_signal_emit` |

14 of 15 are depth 2–3. Two died immediately after a `tool_reference: SendMessage` result and
two after `No matching deferred tools found`. The last one died on a **misspelled tool name**
(`oh-my_evor` vs `oh-my-evor`) — hand to Lane B.

**Wave-2 question:** is there a turn/token cap that silently terminates deep agents, or did these
hit a tool-resolution dead end they had no recovery branch for?

---

## C-09 — MEDIUM — Repeated false-completion notifications for one agent

`<note>A task-notification fires each time this agent stops with no live background children of
its own</note>` — agents stop, get resumed, stop again, each cycle emitting `status: completed`.

**`a3eefc87d38c24d06`** (`evor-forge`, depth 2, "Implement h001-iir-multidirectional") emitted
**7 `completed` notifications in 37 min**, then 4 removes at once:

    enqueue 00:53:07  completed      remove  00:53:07  completed
    enqueue 01:03:04  completed
    enqueue 01:10:18  completed
    enqueue 01:11:07  completed
    enqueue 01:12:50  completed
    enqueue 01:28:18  completed
    enqueue 01:30:28  completed
    remove ×4 at 01:37:45.479 (single flush)

**`a78d6b64199b90219`** (`evor-tick`, depth 1): 6 `completed` notifications spanning **11h49m** —
11:19:33, 11:20:13, 23:10:34, 23:12:50, 23:19:45, 23:38:45.

Repeat counts across the run: 7, 6, 5, 5, 5, 4, 4, 3, 3, 3, 3, 3 for the top twelve task-ids
(154 distinct task-ids produced 226 enqueues). "Completed" is not a reliable terminal signal —
this is precisely the failure `stop.mjs` describes as "a background child was mistaken for a
completed return."

**Wave-2 question:** does anything downstream treat the first `completed` as terminal? If MAIN
acted on notification #1 of 7, what did it conclude?

---

## C-10 — MEDIUM — OSCILLATION: plugin patched, reverted, re-patched (02:03 → 02:10)

Confirmed via `.bak` chains in `/home/dainb_1/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0`.
Five files carry 3–5 backups each. Three rounds on 08-24: **01:39:31, 02:03:02, 02:10:10**
(plus 02:18:46 on `harness/tests/test_integrity.py`).

The 02:03:02 → 02:10:10 pair is a true oscillation — **the backups taken 7 minutes apart are
byte-identical** for three files, and each differs from the current file by the same amount:

| file | bak-020302 vs bak-021010 | difflines vs current (020302 / 021010) |
|---|---|---|
| `harness/evor/contracts.py` | **identical** | 4 / 4 |
| `harness/evor/integrity.py` | **identical** | 203 / 203 |
| `mcp/bridge/integrity_bridge.py` | **identical** | 23 / 23 |
| `mcp/src/contracts.ts` | differs | 5 / 5 (8 at 013931) |

For the three identical pairs the file state at 02:03:02 equals the file state at 02:10:10: the
02:03 edit round produced **zero net change** (applied and reverted, or never landed), and the
same patch was reapplied at 02:10. Seven minutes of the run's last twenty made no progress.

**Wave-2 question:** which agent ran each round, and did the 02:03 round fail a test and get
`git checkout`-reverted, or was the write silently lost?

---

## C-11 — MEDIUM — Governor-rejection retry with capability downgrade

`[EVOR GOVERNOR]` appears **8 times in MAIN** and in **44 of 97 subagent transcripts**
(~230 blocks total). The recurring pattern is retry-until-permitted, ending in a downgrade to a
*less* constrained agent — which defeats the governor's purpose.

MAIN L148–L161, 2026-08-23 08:07:03 → 08:07:41, "Reclaim disk + restructure corpora":

    L148 Agent evor-forge (name="corpus-restructure")
      → [EVOR GOVERNOR] Spawn oh-my-evor:evor-forge WITHOUT the `name` parameter…
    L151 Agent evor-forge (name dropped)
      → [EVOR GOVERNOR] evor-forge is spawned by the tick boundary, not by the mission orchestrator…
    L160 Agent general-purpose (same task body)
      → Async agent launched successfully.

Identical shape at L29/L36 ("Fetch evor-setup SKILL.md": `evor-probe` blocked → `general-purpose`
succeeds). Most-blocked agents: `a6189b43a4eb528ce` (claude, 10), `aa5154bc02b3470cb` (claude, 8),
`a24bcce31dc6cb52c` (evor-forge, 8), `a6a838a858465691f` (general-purpose, 7),
`a63a8eaed31322854` (evor-tick, 7). Top messages: *"claude does not run raw training code"* (44),
*"evor-forge does not run raw training code"* (38), *"general-purpose does not run raw training
code"* (36), *"Spawn … WITHOUT the `name` parameter"* (24).

**Wave-2 question:** does the governor's advice text itself invite the downgrade, and did any
work that the governor intended to confine to `evor-forge-junior` actually execute under
`general-purpose`?

---

## Categories with ZERO hits — stated explicitly

- **STOP-HOOK-LOOP — 0 occurrences.** 54 stop-hook runs, `preventedContinuation: false` on every
  one; no `EVOR CONTINUATION` / `EVOR DRIFT GUARD` / `boulder` text anywhere in MAIN. The stop
  hook never forced a continuation. Filed as the inverse defect, C-02.
- **Stop-hook edit changing termination control — 0.** `stop.mjs.bak-20260824-013931` is
  **byte-identical to the pristine `git show bab279e:hooks/stop.mjs`** (0 diff lines). The single
  mid-run edit (01:39:31) is additive only: a `staleNote` string (age of `tick-state.updated_at`,
  `auto_resume_count`) plus a new instruction to call `evor_tick_resume({run_id})` first. **The
  block condition `started && !finished` was not touched.** The edit changed the *wording* of a
  block that never fired. `evor_tick_resume` and `auto_resume_count` were introduced in the same
  round (`mcp/src/tools/state.ts.bak-20260824-013931`) — a self-heal mechanism authored 41 minutes
  before the run was killed, and never exercised (`evor_tick_resume` appears 3× in MAIN, all in
  ToolSearch/agent-file text, never as a completed call).
- **Parent blocked forever on a subagent — 0.** The opposite: the parent never blocked at all (C-05).
- **Hook errors / hook crashes — 0.** All 54 `hookErrors` arrays empty; max duration 299 ms.

---

## TIMELINE

    2026-08-23
    07:09:29  session start (evor-setup skill)
    07:10:03  [C-11] governor block #1 (orchestrator-only: no Bash)
    07:10:14  [C-11] evor-probe blocked → general-purpose retry
    07:17:18  AskUserQuestion  ──[C-03 20.4m stall]──
    08:01:11  ──[C-03 17.6m stall]──
    08:07:03  [C-11] forge blocked ×2 → general-purpose downgrade
    08:13:25  [C-07] evor_init_run ×4 schema-guess loop ────────── 08:14:20 ok
    08:21:14  freeze_splits → blocker → AskUserQuestion 08:26 → retry 08:37 [C-07]
    08:38:33  r1 preflight full; mission r1 locked
    08:52:32  Agent "Evor tick 1"  (a ROOT evor-tick, d1)
    08:54:43  [C-04i] enqueue→remove pairs begin (13-18 ms discards)
    08:55:44  [C-08] mutagen a2b6461cadd031510 dies (no final turn)
    09:03:16  [C-08] sage-junior ac35af2f78bd40577 dies
    09:20:04  Agent "Resume Evor tick 1" → a3bcda02926248171
    09:20:13  [C-06] read_artifact(forge) poll #1 of 6 ──────────┐
    09:32:33  AskUserQuestion  ──[C-03 32.8m stall]──            │
    09:40:14  [C-08] forge-junior a8628ef79260f4327 dies         │
    09:52:36  [C-06] poll #6 ─────────────────────────────────────┘
    09:53:29  a3bcda02926248171 RETURNS: tick 1 outcome "rejected"  → enqueued
    10:05:23  ★ [C-04ii] user answer flushes queue: tick-1 outcome + critic's
              "VERDICT FLIPPED: approved -> REJECTED" both REMOVED, never read
    10:41:55  ★ r1 ABANDONED — evor_init_run for mission …-r2   (r1 → status "failed")
    10:43:51  Agent "Evor r2 tick 1" → a78d6b64199b90219
    10:45:05  [C-06] a78d6b64199b90219 begins 12h34m polling loop
    11:19:33  [C-09] a78d6b64199b90219 "completed" notif #1 of 6
    11:25:28  [C-05] forge-junior afff04fd9da2e3a8e busy-waits (true ×10, sleep 1, echo idle)
    11:52:38  stop_hook #n — preventedContinuation:false  [C-02]
    12:09:25  ══════════ [C-03] 164m STALL ══════════
    14:53:39  single wake (val_min_domain_f=47.22), stop_hook not blocked
    14:53:39  ══════════ [C-03] 496m (8h16m) STALL ══════════
    23:09:25  wake on task notification
    23:10:34  [C-09] a78d6b64199b90219 "completed" #3 (11h49m after #1)
    23:38:45  [C-09] "completed" #6
    23:51:14  ★ r2 ABANDONED — evor_init_run for mission …-r3  (r2 → status "failed")

    2026-08-24
    00:05:00  active-run.json started_at (r3) — status "running", never changed
    00:12:56  r3 mission-state.json last write ─── stale from here on [C-01]
    00:14:43  Agent "Evor r3 tick 1" → a21027faa06f1af3f
    00:18:03  [C-05] proxy waiter "Wait for mutagen artifact"
    00:26:32  [C-08] sage-junior ×3 die 00:26–00:28
    00:35:22  [C-05] proxy waiter "Wait for selector verdict"
    00:53:07  [C-09] a3eefc87d38c24d06 "completed" #1 of 7 ──┐
    00:53:51  [C-05] proxy waiter "Wait for forge artifact"   │ (still alive at kill)
    01:10:50  AskUserQuestion ──[C-03 26.9m stall]──          │
    01:30:28  [C-09] "completed" #7 ────────────────────────────┘
    01:37:45  [C-09] 4 removes in one flush
    01:39:31  ★ stop.mjs EDITED (additive only; block condition untouched) [C-02]
              + evor_tick_resume / auto_resume_count added to mcp/src/tools/state.ts
    01:59:29  [C-08] evor-probe dies on misspelled tool "mcp__plugin_oh-my_evor_evor__…"
    02:00:24  a21027faa06f1af3f (r3 tick) last activity
    02:03:02  ★ [C-10] plugin patch round — NET ZERO on 3 files
    02:05:00  r3 tick-state.json final: step 9 / "running" / integrity "failed"
              → stop guard sees step>=9 = finished, stays silent [C-02]
    02:10:10  ★ [C-10] SAME patch reapplied (baks byte-identical to 02:03:02)
    02:18:46  test_integrity.py patched (3rd round)
    02:20:30  ★ USER KILLS 5 LIVE AGENTS — session ends, run state left "running" [C-01]
    02:20:32  last transcript event

## Wave-2 handoff, ranked

1. **C-02 / C-01** — the `step >= 9` finished-test and the missing terminal state write. One
   guard predicate explains both the silent stop hook and the run that never closed.
2. **C-04** — queue `remove` semantics. 162 dropped notifications; establish whether the drop is
   policy or bug, and whether anything re-delivers.
3. **C-03 / C-05 / C-06** — one root: no blocking wait primitive. Polling, proxy waiters, spin
   loops and 11h of dead clock are all downstream of it.
4. **C-09** — `completed` emitted up to 7× per agent; determine whether any consumer trusts it.
5. **C-08** — 15 silent deep-agent deaths; look for a turn cap.
6. **C-10 / C-11 / C-07** — no-op patch round, governor downgrade path, schema short-circuit.
