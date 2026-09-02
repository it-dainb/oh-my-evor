# Lane Q — Context Window Management & Compaction Survival (Wave 1 inventory)

Session: `7fa9c902-5d34-4ddb-b3ca-ff6ac294f41f` (parent, 1505 lines) + 97 subagent transcripts.
Window: 2026-08-23T07:09:59Z → 2026-08-24T02:20:32Z (19h10m). Model: `claude-opus-5` (parent) /
`claude-sonnet-5` / `claude-haiku-4-5` (subagents). The `[1m]` long-context variant appears 132×
in-transcript, so the effective ceiling was ~1M tokens.

All token arithmetic below is deduped by `message.id` (streaming snapshots repeat records).
Deduped totals reproduce Lane F exactly: **22,016,279 cache-creation / 247,697,558 cache-read /
453,988 output** over **2,639 assistant turns** across 98 transcripts.

---

## Headline

**Zero compaction events occurred anywhere in this run.** No `isCompactSummary` record, no
"conversation is being continued" marker, no summary-type record in the parent or in any of the 97
subagent transcripts. Peak single-turn context was 364,320 tokens (parent) against a ~1M ceiling —
36% utilisation. The `2026-06-23-…-this-session-is-being-continued…txt` file in the research
directory is from a *different* project (`~/researchs/binarization`, kimi-k2.5, oh-my-claudecode's
pre-compact hook) and is not evidence about this run.

Consequences:

* **POST-COMPACTION-LOSS: zero hits.** There is no compaction boundary to compare across. Nothing
  in this lane can be attributed to compaction.
* The entire compaction-survival layer (`pre-compact.mjs`, `post-compact.mjs`,
  `test_compaction_survival.py`, checkpoints/, `<evor-restore>`) was **never exercised in anger**.
  Zero `checkpoints/` directories exist under `/home/dainb_1/research/binarization/.evor/`.
* **Context exhaustion is refuted as the cause of the 18 truncated agents** (see Q-04).

The real continuity finding is worse than compaction loss: the hook layer that is supposed to
preserve state was reading a *different project's* `.evor/` for the entire 19 hours (Q-01).

---

## Q-01 — BLOCKER — Every hook resolved `.evor/` to the plugin cache, not the project

`hooks/lib/active-run.mjs:29`:

```js
if (process.env.EVOR_ROOT) return process.env.EVOR_ROOT;
return join(process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd(), '.evor');
```

`CLAUDE_PLUGIN_ROOT` is always set for plugin hooks, so the `process.cwd()` fallback is dead code.
`EVOR_ROOT` was unset for this session — confirmed in-transcript by an agent that probed it:
*"EVOR_ROOT is unset and cwd is /home/dainb_1/research/binarization"*.

Direct evidence (parent transcript line 4, the very first SessionStart hook payload):

```
"runDir":".../plugins/cache/oh-my-evor/oh-my-evor/1.2.0/.evor/runs/frontier-1ms/run-live-01"
"message":"[EVOR CONTEXT] Active mission in progress — spawn evor-tick to resume the loop.
<evor-restore>
Mission: Beat the CIFAR-10 accuracy/latency frontier: max test accura
Objective: Beat the CIFAR-10 accuracy/latency frontier: max test accuracy with single-image CPU inference <= 1m
Tick 1 step 2 | Best: unknown
...
```

That mission is `frontier-1ms`, a leftover self-test run living inside the installed plugin at
`.../1.2.0/.evor/runs/frontier-1ms/run-live-01/mission-state.json` (`"status":"paused"`,
`"paused_by":"session-end-hook"`). It has nothing to do with binarization.

All **14** hooks import this resolver (`session-start`, `pre-compact`, `post-compact`,
`subagent-start`, `subagent-stop`, `stop`, `session-end`, `pre-tool-use`, `post-tool-use`,
`post-tool-use-failure`, `post-tool-batch`, `permission-denied`, `user-prompt-submit`,
`job-status-watcher`). So for 19 hours:

* the restore payload named the wrong mission,
* `pre-compact.mjs` would have checkpointed the wrong run (moot — never fired),
* `subagent-stop.mjs`'s missing-artifact advisory was checking the wrong run dir. **`[EVOR SUBAGENT
  WARNING]` never fired once across 97 agents.** The only three transcript hits for that string are
  SKILL.md documentation text being read, not hook output — including for the 18 agents that died
  without confirming a deliverable (Q-03/Q-04).

Design-vs-reality: `test_compaction_survival.py` passes because **all 16 of its hook invocations set
`EVOR_ROOT` explicitly**. The default branch — the one every real session takes — has no test.

Blast radius is cross-project: the `oh-my-evor` working tree currently shows
`M .evor/runs/frontier-1ms/run-live-01/mission-state.json`, i.e. the binarization session mutated
the plugin repo's own state files. (Overlaps Lane A / Lane P; reported here because it is the
mechanism by which the continuity layer was defeated.)

## Q-02 — HIGH — 5-minute cache TTL against a 19-hour run: 45% of all cache writes were re-ingestion

100% of cache creation was `ephemeral_5m_input_tokens` (50,589,016 counted over raw snapshots;
22,016,279 deduped). No `ephemeral_1h` bucket appears anywhere.

* 103 of 2,639 assistant turns (3.9%) were preceded by >5 min of agent idleness.
* Those 103 turns carry **9,951,245 cache-creation tokens = 45.2% of all cache writes.**
  Split: `claude-sonnet-5` 6,661,291 / `claude-opus-5` 3,289,954 / `haiku` 0.
* Read:write ratio overall 11.25:1.

Worst individual rebuilds (`cache_read` = 0 means the whole prefix was re-written):

| agent | timestamp | cache_creation | idle gap |
|---|---|---:|---:|
| a8bc4572fe9a3ff7d | 23T23:10:41Z | 288,670 | 11h18m |
| a8bc4572fe9a3ff7d | 23T11:47:20Z | 265,509 | 5m40s |
| a3eefc87d38c24d06 | 24T01:27:53Z | 248,987 | 15m03s |
| a3eefc87d38c24d06 | 24T01:09:18Z | 228,644 | 6m14s |
| PARENT | 23T23:09:57Z | 227,775 | 8h16m |
| PARENT | 23T14:53:39Z | 226,161 | 3h01m |

**Pathological case — `agent-afabf9d873f2987bf`.** It is the only agent whose read:write ratio is
inverted (cache_write 5,090,944 vs cache_read 2,398,905 = **0.47**). It rebuilt ~155k tokens of
prefix on a metronome: 22:45:40, 22:52:53, 23:00:06, 23:07:17 — gaps of 432.2s, 433.0s, 431.3s. A
poll loop with a ~7.2-minute period against a 5-minute TTL misses the cache **every single cycle**.
This one agent burned 23% of the run's total cache writes.

Modeled saving from a 1h TTL, using the standard multipliers (5m write 1.25×in, 1h write 2.0×in,
read 0.1×in): converting the 9.95M re-creation tokens to reads is worth ≈1.15× base-input on 9.95M
≈ 11.4M input-equivalent tokens ≈ **$57 (opus share) + $23 (sonnet share) ≈ $80**. Treat as a
modeled floor, not a billed figure — this project has a known history of modeled-vs-billed gaps.

## Q-03 — HIGH — 8 oversized tool results (363 KB) were spilled to disk and never retrieved

14 files in `…/7fa9c902-…/tool-results/`. Two pairs are byte-identical or near-identical duplicates
of the same arXiv download (`balojrl2i.txt` 57,122 ≈ `mcp-…arxiv-download_paper-1787482245287.txt`
57,119; `bohus97l5.txt` 76,615 ≈ `…1787531050690.txt` 76,612), and `bg92g7xpg.txt` / `btsowkkhe.txt`
are md5-identical (`cbaef5f2…`, 36,441 bytes each) — the same paper fetched twice.

Read-back audit (searching every transcript for the spill path appearing in a later tool input):

| spill | size | producer | ever read back? |
|---|---:|---|---|
| b9bl1lj4i.txt | 60,264 | a3eefc87d38c24d06 | **no** |
| boihdarz6.txt | 53,420 | a24bcce31dc6cb52c | **no** |
| byjxnsuy4.txt | 52,308 | aa7ecba96a8a47c4a | **no** |
| bhts9lbjj.txt | 49,709 | a5cbc0575f444880b | **no** |
| bqu4sshwl.txt | 41,322 | a9b82d0cf328af266 | **no** |
| bkjkxmz7y.txt | 39,113 | a6c7da2e6f9c015ea | **no** |
| bftyho2qe.txt | 35,799 | abe85ae76b84397a4 | **no** |
| brazkru1g.txt | 31,502 | a8bc4572fe9a3ff7d | **no** |
| bohus97l5.txt + arxiv twin | 76,615 | a45104c20dc6c64a2 | yes (Bash `cat`, 8×) |
| bg92g7xpg/btsowkkhe.txt | 36,441 | a12e6dab8b80f08e2 | yes (Bash `cat`) |
| balojrl2i.txt + arxiv twin | 57,122 | a0c0679c9d7c6c9ee | yes via twin (Bash, 9×) |

**8 spills totalling 363,437 bytes were never opened.** Those agents saw only the inlined 2 KB
preview and proceeded as if that were the result. This is silent data loss: no error, no warning,
and the agent has no signal that it is reasoning on 3% of a document.

Related durability gap: every subagent's final report was spooled to
`/tmp/claude-1006/…/7fa9c902-…/tasks/<agent>.output`. **That directory no longer exists** — `/tmp`
was reaped. The only durable record of what 97 agents concluded is the transcripts plus whatever
they wrote into `.evor/`; the harness's own designated output channel is ephemeral.

## Q-04 — HIGH — The 18 truncated agents: context exhaustion REFUTED; user-stop confirmed for 3, undetermined for 15

Truncation defined as: the last assistant message in the transcript ends with a `tool_use` block and
carries no text, and no matching `tool_result` follows. That yields exactly **18** agents, matching
Lane D's count.

**Context exhaustion is refuted.**

| cohort | n | peak-context median | mean | max | mean turns |
|---|---:|---:|---:|---:|---:|
| truncated | 18 | 111,278 | 98,913 | **151,320** | 21.6 |
| finished-with-text | 79 | 90,486 | 102,301 | **312,072** | 26.4 |

Mann-Whitney on peak context p = 0.455; on turn count p = 0.875. **Zero of the 18 exceeded the
finished cohort's p90 (202,986).** The largest surviving agent reached 312,072 tokens — 2.06× the
largest truncated one — and finished normally. Truncated agents also had *fewer* turns on average, so
a turn cap is not indicated either.

**What is confirmed.** The parent's final user record is
`2026-08-24T02:20:32.091Z [Request interrupted by user]`, preceded at `02:20:30.894Z` by
`"5 background agents were stopped by the user"`. Three truncated agents die inside that same second
— `a6189b43a4eb528ce` 02:20:30.843, `a4d12a0b7e85550fd` 02:20:30.833, `ae4380923d6ee781b`
02:20:30.931 — and carry the marker `Request interrupted by user for tool use`. Those three are
unambiguously user cancellation.

**What cannot be distinguished, and a specific new signal.** For the remaining 15 there is no
interrupt marker. But their pending tool call is not random:

* 5 died pending `evor_write_artifact`, 1 pending `evor_read_artifact`, 1 pending
  `evor_signal_emit` — **7 of 18 died awaiting an evor MCP call.**
* 6 pending `Bash`, 4 pending `ToolSearch`, 1 pending `SendMessage`.

For four of the `evor_write_artifact` cases the file *does* exist on disk, with an mtime that
precedes the agent's last transcript timestamp by well under a second:

| agent | died | artifact written |
|---|---|---|
| ac35af2f78bd40577 | 23T09:03:16.052 | `…2026-08/…/juniors/progressive-training-domain-weighting.json` 09:03:15.838 |
| a463e4ec31f49e15e | 24T00:27:44.854 | `…r3/…/juniors/quant-aware-training-4k.json` 00:27:44.684 |
| a45104c20dc6c64a2 | 24T00:28:34.796 | `…r3/…/juniors/genuine-iir-mechanisms.json` 00:28:34.631 |
| a3340d607fe0dd28f | 23T11:35:05.413 | `…r2/…/forge/architect.json` 11:35:05.125 |

So the MCP side-effect landed and the agent vanished at the instant the tool returned — before it
could emit closing text. The fifth, **`a3c44e832c15c4cb7`** (`kind: "palm-leaf-data-sources"`, died
00:26:32.912) has **no corresponding file** in the r3 juniors directory; that artifact is genuinely
lost.

Compounding this: 16 of the 18 nevertheless produced a task-notification to their spawner reading
`<status>completed</status>` / `Agent "…" finished`. The orchestration layer reported agents that
never delivered a report as *completed*. Whether the underlying process was killed, hung, or merely
lost its transcript tail **cannot be determined from these artefacts alone** — the `.output` spool
that would settle it is gone (Q-03). What can be stated: it was not context pressure, and it was not
a turn cap.

## Q-05 — MEDIUM — Cross-mission handoffs cannot be read; continuity came from the parent's un-compacted context

Three sequential missions ran against the same objective: `binarization-worldmodel-min98-2026-08`
(r1, 07:09–~09:50), `…-r2` (10:47–23:38), `…-r3` (23:51–02:20). Handoff inventory:

* r1: `handoffs/1-0.json` only. **No `1-1.json`** — r1 never reached end-of-tick, so its tick-close
  state was never serialised.
* r2: `1-0.json` (to sage) + `1-1.json` (tick close, 23:38:39).
* r3: `1-0.json` (to sage) + `1-1.json` (tick close, 02:00:18).

Handoff traffic across all 98 transcripts: **5 `evor_write_handoff`, 8 `evor_read_handoff`.** Every
single read is scoped `{"run_id":"run-live-01","tick":1}` and targets the *`to: sage`* handoff
(`1-0.json`) inside the reader's own mission. **No agent, in the entire run, ever read a `1-1`
tick-close handoff.**

This is structural, not incidental: handoffs live under `runs/<mission_id>/run-live-01/handoffs/`,
so r2's `1-1.json` is unreachable from r3 by construction. Its `next_tick_seed` held the run's most
expensive lessons:

> "Fix GPU latency first (81ms vs 10ms ceiling) via fewer/larger ops, not just fewer MACs. Audit and
> fix data/builder.py leakage before reuse." + "Queue a genuine IIR-recurrence sibling
> (hyp-iir-binnet-lightweight untested)"

Those lessons **did** reach r3 — but only because the parent orchestrator, which was never
compacted, restated them by hand in prose. Parent at 00:22:18Z:

> "h001-iir-multidirectional describes IIR only in PROSE … the forward pass must contain a loop or
> associative-scan primitive carrying state along a spatial axis, or it gets rejected regardless of
> what the proposal claims. That's checkable before compute is spent, **which is where the last two
> attempts failed**."

The designed durable mechanism transferred nothing across the mission boundary. The single point of
failure for 19 hours of accumulated knowledge was one context window that happened not to fill up.

## Q-06 — LOW — Redundant rediscovery is real but modest, and smaller than Lane D reported

Deduped by `tool_use.id` (streaming snapshots inflate naive counts):

* **2,816 unique tool calls.** Top: `Bash` 1431, `ToolSearch` 295, `evor_read_artifact` 126,
  `Agent` 124, `evor_write_artifact` 89, `SendMessage` 77, `Read` 73.
* `ToolSearch`: **295 calls across 70 agents = 4.2 mean per using agent**, 10.5% of all tool calls.
  Worst: `ae31cc72f7e5fa1d4` 19, `a658b68f9ea1110eb` 13, `a3bcda02926248171` 11,
  `a21027faa06f1af3f` 10.
* Exact-duplicate `ToolSearch` queries (same agent, byte-identical query): **17** total. Worst
  offender `a658b68f9ea1110eb` issued `select:…evor_read_handoff` **5×**; nine other agents repeated
  a query twice — notably three sage-juniors each re-issuing
  `select:evor_wiki_query,evor_write_artifact,evor_cite`.
* Repeated `Read` of the same path: 7× `iir-binnet-01/train/trainer.py`, 5× `model/backbone.py`,
  5× `data/builder.py`, 4× `multiscale-stroke-gate-01/evaluate.py` (4 of those by one agent,
  `a12e6dab8b80f08e2`), 3× `skills/evor/SKILL.md`.

**Discrepancy to flag:** Lane D reports 10.4 ToolSearch calls per agent; deduped by tool_use id I
measure 4.2 per using agent (3.0 averaged over all 97). The gap is consistent with counting
streaming snapshots. Wave 2 should reconcile before either number is cited.

Given zero compactions, none of this rediscovery is post-compaction amnesia — it is agents that were
never given a persistent tool roster, re-deriving the same schemas from scratch on each spawn.

## Categories with zero hits — stated explicitly

* **COMPACTION EVENTS: 0.** None in the parent, none in any of 97 subagents.
* **POST-COMPACTION-LOSS: 0.** No boundary exists to measure loss across. Any behaviour a sibling
  lane attributed to "forgetting after compaction" must have another cause.
* **CONTEXT-EXHAUSTION-AS-ROOT-CAUSE: 0 supported cases.** Refuted with p=0.455 and a 2× counter-
  example (Q-04).

## Design-vs-reality summary for `test_compaction_survival.py`

| The test guarantees | Reality in this run |
|---|---|
| pre-compact writes a well-formed `checkpoints/precompact-*.json` | Never fired (no compaction). Zero checkpoint dirs exist under the project `.evor/`. |
| `<evor-restore>` ≤500 chars with mission objective + `Tick N` + `evor_state_read` | Emitted at SessionStart, well-formed, **and naming the wrong mission** (Q-01). |
| session-start rehydrates from nested `runs/<mission>/<run>/` | It did — from the *plugin cache's* nested layout, not the project's. |
| subagent-stop warns when a role's artifact is missing | Fired **0 times** in 97 agents, including 18 that died without a deliverable. |
| All of the above tested end-to-end | All 16 hook invocations in the test set `EVOR_ROOT` explicitly; the unset-`EVOR_ROOT` path that every real session takes is untested. |
