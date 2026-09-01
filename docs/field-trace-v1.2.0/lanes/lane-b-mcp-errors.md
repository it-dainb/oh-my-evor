# Wave 1 — Lane B: tool-call and MCP error inventory

Sources (read-only):
- MAIN `/home/dainb_1/.claude/projects/-home-dainb-1-research-binarization/7fa9c902-5d34-4ddb-b3ca-ff6ac294f41f.jsonl` (1505 lines)
- ALT `8289a9d7-dedd-4aeb-a1af-0efd2bbb45fb.jsonl` (2 errors), ALT `3f780be1-…jsonl` (0 errors)
- 97 subagent transcripts under `…/7fa9c902-…/subagents/` (70 files contain at least one error)

Extraction: every `tool_result` with `is_error:true`, joined back to its `tool_use` by `tool_use_id`
to recover the tool name and arguments. Script + raw dump:
`/tmp/claude-1006/-home-dainb-1-research-oh-my-evor/930a4051-f31f-4940-a1b0-57f0beb688fc/scratchpad/wave1/extract.py`
and `…/wave1/errors.json`.

## Headline numbers

- **2822** tool calls with results across all transcripts; **220** returned `is_error:true` → **7.8 %** failure rate.
- Window: `2026-08-23T03:51:10.124Z` → `2026-08-24T02:20:32.091Z`.
- **144 of 220 (65 %)** of all failures are the evor governor/guard hook refusing the call.
  Only ~35 % are "real" errors (schema, IO, shell, network).
- Failure by tool: Bash 142, Agent 27, evor MCP 18, Read 5, Write 6, Edit 4,
  external MCP (semantic-scholar/arxiv/exa) 8, TaskStop 2, WebFetch 1, SendMessage 1.

## Category tallies

| Category | Count | Notes |
|---|---|---|
| PERMISSION-DENIED (evor governor/guard hook) | 144 | dominant failure mode |
| PERMISSION-DENIED (harness `Blocked: sleep`) | 8 | foreground `sleep` refused by Claude Code |
| PERMISSION-DENIED (user/permission reject) | 4 | 3 Bash + 1 SendMessage |
| MCP-SCHEMA/VALIDATION | 17 | 11 evor, 6 external MCP |
| BASH/HARNESS-ERROR | 22 | 7 python tracebacks, 12 non-zero exits, 2 `fatal: not a git repository` |
| FILE-IO (ENOENT) | 14 | 5 Read + 9 Bash `ls/cat: No such file` |
| MCP-TOOL-ERROR (non-hook) | 2 | `evor_doctor` resolveRunPaths, `arxiv read_paper` not-in-storage |
| MISSING-TOOL | 5 | hallucinated tool names, see B-06 |
| TIMEOUT/ABORT | 4 | 1 Bash 2m timeout, 2 TaskStop ownership/finished, 1 WebFetch ECONNRESET |
| **Total** | **220** | |

Zero-hit categories: **no EACCES/permission-denied filesystem errors**, **no OOM/CUDA errors**,
**no disk-full errors**, **no MCP transport errors other than `-32602`** (all 28 MCP protocol errors
are `-32602 Input validation error`), **no pytest FAILED summaries surfaced as `is_error`**.

---

## B-01 — PERMISSION-DENIED: "<agent> does not run raw training code" (Bash)

Count **82** (claude 22, evor-forge 19, general-purpose 18, evor-forge-critic 8,
evor-forge-analyst 6, evor-forge-architect 4, evor-sage 2, workspace-scout 2, evor-probe 1).
First `2026-08-23T08:08:48.681Z` (general-purpose) → last `2026-08-24T02:19:41.309Z` (evor-forge).

Verbatim (agent-afec7e78c7ac3e2b3 / evor-forge, L?; MAIN L1149):
```
[EVOR GOVERNOR] evor-forge does not run raw training code. Launch evaluation with the evor_run_start tool; candidate cod…
```
```
[EVOR GOVERNOR] claude does not run raw training code. Only evor-forge-junior runs candidate code.
```

Nine distinct agent roles hit the same wall. The message names the *role*, so it is one hook rule
with a role-substituted string, fired 82 times.

## B-02 — PERMISSION-DENIED: `Agent` spawn rejected for passing `name=`

Count **22**. Tool: `Agent`. Callers: evor-sage 12, evor-forge 6, claude 2, evor-tick 1, MAIN 1.
First `2026-08-23T08:07:03.619Z` (MAIN, L149) → last `2026-08-24T02:09:35.967Z` (agent-a24bcce31dc6cb52c/evor-forge L42).

```
[EVOR GOVERNOR] Spawn oh-my-evor:evor-sage-junior WITHOUT the `name` parameter (got name="junior-iir-mechanisms").
Passing `name` makes it an in-process teammate: the hook matchers stop matching it and it inherits the session model
instead of its own `model:` frontmatter, so both enforcement and model tiering are s…
```
Retry behaviour: **always corrected on the immediately following call** — the agent re-issues the
identical spawn minus `name` and it succeeds. Cost is one wasted round-trip per spawn, forever
(the rule is not learned across ticks; evor-sage alone paid it 12 times over 16 hours).

## B-03 — PERMISSION-DENIED: `[EVOR GUARD] This operation is not permitted. Use the appropriate evor_* MCP tool instead.`

Count **13** (Bash). Callers span 11 distinct agents: evor-forge-critic 5, claude 3, evor-forge 2,
evor-selector 1, evor-sage 1, general-purpose 1.
First `2026-08-23T08:33:54.027Z` → last `2026-08-24T02:13:57.067Z`.
Generic message — does not tell the agent *which* evor_* tool to use, so it is the weakest guard string.

## B-04 — MCP-TOOL-ERROR: `evor_read_artifact` role/slot guard

Count **7**, all `mcp__plugin_oh-my-evor_evor__evor_read_artifact`.
Callers: evor-forge-architect 4, evor-forge-analyst 1, evor-forge-critic 1, evor-sage 1.
First `2026-08-23T09:41:11.774Z` (agent-a274664a06be89852 L18) → last `2026-08-24T00:56:09.675Z` (agent-aa9b9b2599c7f2b28 L49).

```
[EVOR GUARD] This artifact slot is not accessible from your role. Use the correct evor_* tool for your role.
```
Rejected reads: architect→`agent:"forge-critic"`, architect→`agent:"forge"`,
architect→`agent:"sage-junior", kind:"genuine-iir-mechanisms"`, analyst→`agent:"forge-critic"`,
critic→`agent:"forge-architect"`. The forge sub-team members cannot read each other's artifacts;
architect retried twice in a row (agent-aa9b9b2599c7f2b28 L45 then L49, 5 s apart) with a different
slot, failed again, and proceeded without the data.

## B-05 — MCP-SCHEMA/VALIDATION on evor tools

Count **11**. All `MCP error -32602: Input validation error` except 2 `InputValidationError` (unparsed JSON).

| tool | n | signature | line/ts |
|---|---|---|---|
| `evor_signal_emit` | 3 | missing required `kind`; `shapes:["environment"]` not in enum `limit/opportunity/failure/trend`; 728-byte payload not parseable as JSON | agent-a63a8eaed31322854 L104 `09:09:49.217Z`, L107 `09:09:57.016Z`; agent-a496b010bf8dfc377 L127 `2026-08-24T00:30:34.065Z` |
| `evor_validate_proposals` | 2 | `proposals` "Array must contain at least 1 element(s)" *while an array was sent* | agent-ae31cc72f7e5fa1d4 L140 `09:05:21.511Z` |
| `evor_cite` | 2 | sent `citations` (array-as-string); schema wants singular `citation` string | agent-a463e4ec31f49e15e L54 `2026-08-24T00:25:07.834Z` |
| `evor_write_artifact` | 2 | `payload` sent as JSON string, schema wants object; one 16100-byte payload unparseable | agent-a463e4ec31f49e15e L69; agent-a68b7855a3355b99e L59 `11:45:35.724Z` |
| `evor_gotcha_add` | 1 | missing `signature` + object field | agent-a78d6b64199b90219 L246 `23:37:58.642Z` |
| `evor_wiki_add` | 1 | `entry.created_at` "Invalid datetime" | agent-a78d6b64199b90219 L251 `23:38:20.774Z` |

Two recurring shapes: (a) **stringified JSON where an object/array is required**
(`payload`, `citations`, `shapes`, `axes`) — the agent is serialising nested args;
(b) **large payloads arriving unparseable** (728 B and 16.1 kB), i.e. tool input truncation/streaming
corruption, not an agent mistake.

## B-06 — MISSING-TOOL: hallucinated tool names

Count **5** distinct calls, 3 signatures. All `Error: No such tool available: …`.

| bad name | correct name | caller agent | line/ts |
|---|---|---|---|
| `mcp__plugin_oh-my_evor_evor__evor_signal_emit` (x2) | `…oh-my-evor_evor…` | evor-probe (agent-a60047ec408340f38 L74, L78) | `2026-08-24T01:59:22.170Z`, `01:59:29.404Z` |
| `mcp__plugin_oh-my_evor_evor__evor_wiki_add` | same fix | evor-sage (agent-aeafb73a99ca56b8b L91) | `2026-08-23T08:58:32.345Z` |
| `mcp__plugin_oh-my_evor_evor__evor_gotcha_query` | same fix | evor-selector (agent-a09ed84ed03e97b1d L46) | `2026-08-23T09:00:49.023Z` |
| `mcp__plugin_oh-my-evor_semantic-Scholar__search_papers` | `semantic-scholar` (lowercase s) | evor-sage (agent-aeafb73a99ca56b8b L67) | `2026-08-23T08:57:03.124Z` |

Pattern: the **hyphen in `oh-my-evor` becomes an underscore** in one call of a parallel batch — the
surrounding calls in the same assistant turn use the correct name (e.g. agent-a60047ec408340f38
emits L69 ✓, L71 ✓, L73 ✗, L75 ✓, L77 ✗). Same for the capital-S `semantic-Scholar` (L60-62 ✓, L63 ✗, L70 ✓).
All self-corrected on the next call; none blocked progress. This is per-call name corruption in
batched tool_use blocks, not a stale tool list.

## B-07 — MCP-SCHEMA/VALIDATION on external MCP servers

Count **6**.
- `semantic-scholar search_papers` x2 and `get_paper` x2: `fields` sent as a comma-joined **string**,
  server (pydantic) requires a list; plus `year:"2021-2026"` where an int is required.
  `2026-08-23T08:59:04.474Z` (agent-affa136465b46873e L17) → `2026-08-24T00:23:49.929Z` (agent-a463e4ec31f49e15e L21).
  ```
  Error executing tool search_papers: 1 validation error for search_papersArguments fields Input should be a valid list [type=list_type, input_value='title,url,year,citationC…
  ```
- `arxiv read_paper`: sent `id`, schema requires `paper_id` (agent-ac35af2f78bd40577 L52 `09:00:40.288Z`);
  retried correctly 2 s later and got a **second, different** error:
  `{"status":"error","message":"Paper 2311.00476v1 not found in storage. You may need to download it first using download_paper."}` (L54).
- `mcp__claude_ai_Exa__web_fetch_exa`: called with `query` instead of required `urls` array
  (agent-a1cc25ed1e41eed71 L34 `2026-08-23T10:58:08.413Z`).

## B-08 — MCP-TOOL-ERROR: `evor_doctor` cannot resolve the run

Count **1**, MAIN L75 `2026-08-23T07:13:00.940Z`, input `{}`:
```
resolveRunPaths: run "run-live-01" not found under runs/<mission>/<run-id>/ layout — pass missionId explicitly or ensure active-run.json is present
```
Fired at minute 4 of the run, i.e. **before** the mission directory existed. Related: MAIN L361
`08:51:45.924Z` `evor_state_read` → `[EVOR GOVERNOR] evor_state_read belongs inside the tick boundary,
not in the mission orchestrator`.

## B-09 — BASH/HARNESS-ERROR

Count **22** non-governor Bash/Write/Edit failures.
- **7 python tracebacks** `2026-08-23T09:05:32.846Z` → `2026-08-24T01:47:38.897Z`. Two are ad-hoc
  verification asserts in the plugin cache (`agent-a3a4d844bd5220590 L115`:
  `Traceback … File "<string>", line 45, in <module> AssertionError`;
  `agent-a5cbc0575f444880b L64`: `AssertionError: (0, …)`). One is a real trainer abort:
  `agent-afabf9d873f2987bf L31 2026-08-23T11:51:10.800Z` →
  `File ".../worktrees/iir-binnet-01/train/trainer.py", line 587, in <module> raise SystemEx…`
- **2 `Exit code 128 fatal: not a git repository`** — `git status` run inside
  `/home/dainb_1/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0` (agent-a0a43b8a88247b4cd L55
  `2026-08-23T09:21:34.814Z`; agent-aa7ecba96a8a47c4a L34 `2026-08-24T02:12:25.977Z`). The plugin
  cache is not a repo, so agents auditing "did we mutate the plugin?" get no git evidence.
- 12 assorted non-zero exits (mostly `ls`/`cat` probes).

## B-10 — FILE-IO (ENOENT)

Count **14**, `2026-08-23T07:10:19.279Z` → `2026-08-24T02:13:53.142Z`.
Notable: MAIN L34 `Read /home/dainb_1/.claude/plugins/oh-my-evor/skills/evor-setup/SKILL.md` →
`File does not exist` (the plugin lives under `plugins/cache/oh-my-evor/oh-my-evor/<ver>/`, not
`plugins/oh-my-evor/`); MAIN L66 `Read .evor/state.json` → does not exist;
agent-a0a43b8a88247b4cd L25 probes the **1.1.0** cache dir which is absent (only 1.2.0 exists).

## B-11 — TIMEOUT / ABORT

Count **4**.
- `Bash` `Exit code 143 Command timed out after 2m 0s` — evor-forge-junior worktree training run,
  agent-a88bbc68c441df191 L96 `2026-08-24T00:54:16.660Z`. Only one such timeout in the whole run.
- `TaskStop` x2 from evor-tick (agent-ae31cc72f7e5fa1d4): L94 `2026-08-23T08:54:14.568Z`
  `Task a63a8eaed31322854 is owned by a63a8eaed31322854; agent ae31cc72f7e5fa1d4 cannot stop it.`
  then L173 `09:10:17.087Z` `Task … is not running (status: completed)`. evor-tick tried and failed
  to cancel a child it had spawned.
- `WebFetch` `read ECONNRESET` (agent-a3c44e832c15c4cb7 L40 `2026-08-24T00:23:49.929Z` region).

## B-12 — Harness `Blocked: sleep` and user rejects

- **8** Bash calls refused with `<tool_use_error>Blocked: sleep N followed by: …` (sleep 30/60/90/180/240).
  Agents were polling for training completion with foreground `sleep`; the harness blocks it, so the
  poll loop had to be re-expressed each time.
- **3** Bash + **1** SendMessage refused with
  `The user doesn't want to proceed with this tool use…` — last one is
  agent-ae4380923d6ee781b (evor-forge-junior) L48 `2026-08-24T02:20:30.930Z`, the final event of the
  run: a `SendMessage` back to evor-forge was rejected, i.e. **the run ends on a blocked message**.

---

## Retry behaviour (aggregate)

Measured over all 2822 tool calls: after a failing call,

| outcome | n |
|---|---|
| agent re-issued the **same tool** within the next 3 calls | 176 |
| … and that next same-tool call **succeeded** | 135 |
| … and that next same-tool call **failed again** | 41 |
| agent switched tool immediately (no same-tool retry) | 44 |

Consecutive-error run lengths: 147 runs of 1, 27 of 2, 5 of 3, **1 of 4**. No agent ever got stuck
in a long retry loop; the governor messages are actionable enough that one correction suffices.
The cost is throughput, not deadlock: **~5 % of every agent's turns are spent being told no and
retrying.**

### Top 10 most-repeated failing calls

| # | count | tool | signature | first → last |
|---|---|---|---|---|
| 1 | 22 | Bash | `[EVOR GOVERNOR] claude does not run raw training code…` | 08-23T10:15:18 → 08-24T02:14:17 |
| 2 | 19 | Bash | `[EVOR GOVERNOR] evor-forge does not run raw training code. Launch evaluation with evor_run_start…` | 08-23T09:04:43 → 08-24T02:19:41 |
| 3 | 18 | Bash | `[EVOR GOVERNOR] general-purpose does not run raw training code…` | 08-23T08:08:48 → 08-23T10:08:39 |
| 4 | 13 | Bash | `[EVOR GUARD] This operation is not permitted. Use the appropriate evor_* MCP tool instead.` | 08-23T08:33:54 → 08-24T02:13:57 |
| 5 | 8 | Agent | `Spawn oh-my-evor:evor-sage-junior WITHOUT the \`name\` parameter` | 08-23T08:58:49 → 08-24T00:23:20 |
| 6 | 8 | Bash | `[EVOR GOVERNOR] evor-forge-critic does not run raw training code…` | 08-23T09:21:50 → 08-24T00:56:13 |
| 7 | 7 | `evor_read_artifact` | `[EVOR GUARD] This artifact slot is not accessible from your role.` | 08-23T09:41:11 → 08-24T00:56:09 |
| 8 | 6 | Bash | `[EVOR GOVERNOR] evor-forge-analyst does not run raw training code…` | 08-23T09:42:15 → 08-24T00:57:06 |
| 9 | 5 | Read | `File does not exist. Note: your current working directory is /home/dainb_1/research/binarization.` | 08-23T07:10:19 → 08-23T11:00:32 |
| 10 | 4 | Bash | `[EVOR GOVERNOR] evor-forge-architect does not run raw training code…` | 08-23T09:43:08 → 08-24T00:55:53 |

### Workaround-by-plugin-edit (correlation only — Lane A owns the depth)

At `2026-08-24T02:04:16.806Z` agent-a6189b43a4eb528ce (`claude`) issued
`Edit /home/dainb_1/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/harness/evor/integrity.py`
and was refused 0.14 s later with `[EVOR GOVERNOR] claude does not author code…`. It then
(a) wrote `scratchpad/patch_integrity.py` at `02:04:05.844Z`, and
(b) at `02:05:32.430Z` and `02:06:19.027Z` tried twice to spawn `evor-forge-junior` to apply the
patch — blocked both times (first for `name=`, then
`evor-forge-junior may be spawned ONLY by evor-forge. claude must not spawn it directly`).
So a blocked direct edit was escalated into a script + a delegation attempt, both of which the
governor also blocked. Files edited under the plugin cache anywhere in the run:
`skills/evor/SKILL.md` (3), `skills/evor-run/SKILL.md` (1), `mcp/src/tools/proposals.ts` (1),
`harness/evor/integrity.py` (1).
