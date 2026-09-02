# Lane P — Cross-Project Sweep (Wave 1, read-only)

Question: is binarization representative of oh-my-evor/OMC systemic defects, or an outlier?

Method notes:
- All token/cost figures dedupe by `message.id`, keeping the record with the largest `output_tokens`.
- **Contamination warning:** project dir `-home-dainb-1-research-oh-my-evor` contains the CURRENT session `930a4051`. Every sibling lane's prompt and report text lives there, so naive greps for signature strings (e.g. the mangled MCP prefix) hit this session's own chatter. All cross-project claims below were re-verified as *structural* occurrences (tool_use `name` fields, tool_result `is_error` payloads), not text mentions.

## 1. Inventory — all 12 project dirs

| Project dir | Size | jsonl files | Activity span | evor active? | OMC present? | Era |
|---|---|---|---|---|---|---|
| -home-dainb-1-research-oh-my-evor | 306 MB | 2403 | 2026-07-26 → 09-01 | **YES** (dogfood + eval harness) | yes (2401 files) | v1.2.0-era + pre |
| -home-dainb-1-projects-table-cell-det | 97 MB | 20 | 2026-08-17 → 08-19 | no | yes (20) | pre-1.2.0 |
| -home-dainb-1-research-digi-skip | 41 MB | 21 | 2026-08-07 → 08-12 | no | yes (21) | pre-1.2.0 |
| -home-dainb-1-research-binarization | 37 MB | 101 | 2026-08-23 03:46 → 08-24 02:20 | **YES** (only project-scoped install) | yes (10) | **v1.2.0-era** |
| -home-dainb-1-hackathon-viettel-ai-race-llm-2026 | 13 MB | 13 | 2026-07-24 → 07-26 | no | yes (13) | pre-1.2.0 |
| -home-dainb-1 | 4 MB | 6 | 2026-08-07 → 09-01 | no | yes (5) | spans |
| -mnt-…-Files-MA-…-table-cell-det | 4 MB | 2 | 2026-08-12 → 08-17 | no | yes (2) | pre |
| -mnt-…-innovation-lab-…-ultralytics-mgiou | 3 MB | 1 | 2026-08-11 | no | yes (1) | pre |
| -home-dainb-1-tna-table-cells | 1 MB | 2 | 2026-08-26 → 08-28 | no | no | post-1.2.0 |
| -home-dainb-1--claude | 1 MB | 2 | 2026-08-02 → 08-05 | no | yes (1) | pre |
| -home-dainb-1-multi-user-setup | 1 MB | 1 | 2026-08-12 | no | no | pre |
| -home-dainb-1-projects-meetily | 1 MB | 0 | — | no | no | empty |

Reference dates: oh-my-evor 1.2.0 lastUpdated 2026-08-23T03:47Z (project scope, `/home/dainb_1/research/binarization` only); OMC 4.15.8 since 2026-08-03.

`.evor/` directories on disk: exactly three —
- `/home/dainb_1/research/binarization/.evor` (the live mission),
- `/home/dainb_1/research/oh-my-evor/.evor` (dogfood mission `frontier-1ms/run-live-01`),
- `/home/dainb_1/.claude/plugins/marketplaces/oh-my-evor/.evor` (**runtime state inside the marketplace git clone** — see P-02),
plus a fourth copy inside the installed plugin cache `…/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/.evor/` containing `mission-state.json`, `user-prompt-throttle.json`, `post-advisory-throttle.json`, `.deps-ok` and `__pycache__` trees.

### The oh-my-evor project dir decomposes into two very different corpora
1. **`ee74204e` (36 MB main + 21 MB / 63 subagents, 2026-07-26 → 08-23T03:42)** — the real dogfooding/development session that culminated in the 1.2.0 release. Opus-5 main, Sonnet-5 subagents. 2526 unique main messages, 1732 Bash calls, 60 `Agent` spawns, 49 tool errors.
2. **2320 near-empty sessions dated 2026-08-21/22** — the forge-eval tier-matrix harness. Each is one prompt + one JSON answer, **zero tool calls**, 1767 on 08-21 and 535 on 08-22. Models: haiku-4.5 (2298 msgs), sonnet-5 (2085), opus-5 (290). Aggregate 128 M tokens, 91.7 % cache, 8.3 % output.

## 2. Triage targets

Traced in depth: **`ee74204e`** (oh-my-evor dogfood), the **2320-session eval corpus** (oh-my-evor), **hackathon-viettel** (12 subagents, pre-evor), **digi-skip** (19 subagents), **projects-table-cell-det** (19 subagents).

Not traced (justification): `-home-dainb-1`, `--claude`, `multi-user-setup`, `tna-table-cells`, both `-mnt-…` dirs, `projects-meetily` — 0–6 files each, ≤8 tool errors total across all of them, no subagent fan-out, no evor. They contribute to the inventory table and to the cost baseline (below) and nothing else.

## 3. Signature recurrence

### S1 — Governor/guard refusals dominating the error budget
Binarization: 144 / 220 errors. Elsewhere: **zero**. Full `is_error` tool_result taxonomies:

| Project | total errors | governor/guard | dominant class |
|---|---|---|---|
| binarization | 220 | 144 (65 %) | `[EVOR GOVERNOR]` / `[EVOR GUARD]` |
| oh-my-evor (all) | 79 | 0 | "Subagents should return findings as text" (6), `Exit code 144` (4) |
| projects-table-cell-det | 51 | 0 | ordinary shell/python failures |
| digi-skip | 24 | 0 | `maxContentLength … exceeded` (6) |
| hackathon | 14 | 0 | "File has not been read yet" (3), `Exit code 144` (3) |
| -home-dainb-1 | 8 | 0 | `Exit code 143` timeouts |

**LOCAL.** But read this correctly: evor's governor only *exists* in binarization, so its absence elsewhere is definitional, not exculpatory. The transferable observation is the *ratio*: no other project spends 65 % of its error budget on its own tooling refusing itself. Every other project's errors are about the work.

Notable: the refusals are self-inflicted role checks — the top three are `claude` (22), `general-purpose` (19) and `evor-forge` (19) being told "does not run raw training code". The orchestrator repeatedly attempts an action its own contract forbids.

### S2 — Agent-spawn rejected for passing `name=`
**NOT REPRODUCED anywhere, including binarization**, with the search shapes available to me. Structural probes across all 12 dirs for `Agent failed due to the following issues`, `TaskCreate failed`, `name: Unrecognized`, `Unrecognized key`, `not addressable`, and for `is_error` tool_results matching `\bname\b` + (`Unrecogni|nexpected|not allowed|invalid|Validation`) returned: 1 hit in this session (`930a4051`, i.e. lane chatter), 1 `TaskCreate failed` in hackathon, and unrelated matches (`transformers: Unrecognized keys in rope_parameters`, `repository name must be lowercase`). The 22 hits reported by the sibling lane are either a non-tool_result surface (system-reminder / hook stderr) or a different literal. **UNVERIFIED — recommend the originating lane publish the exact string.** No evidence of recurrence elsewhere either way.

### S3 — Mangled MCP prefix `mcp__plugin_oh-my_evor_evor__` (underscore for hyphen)
Raw text hits: 104 occurrences across 10 files. After removing this session's self-references, **occurrences as an actual `"name":"…"` tool_use field exist in exactly 3 files, all in binarization session `7fa9c902`**:
- `agent-a09ed84ed03e97b1d.jsonl` — model `claude-haiku-4-5-20251001`
- `agent-a60047ec408340f38.jsonl` — model `claude-haiku-4-5-20251001`
- `agent-aeafb73a99ca56b8b.jsonl` — model `claude-haiku-4-5-20251001`

All 6 oh-my-evor hits are in `930a4051/subagents/` (lanes b, c, d, i, n, p) plus the main `930a4051.jsonl` — i.e. **this investigation quoting the string**, not a real call. The correct prefix `mcp__plugin_oh-my-evor_evor__` appears in 101 binarization files and 22 oh-my-evor files (the latter concentrated in dogfood session `ee74204e`).

**The haiku correlation survives the cross-check: 3/3 mangled emitters are haiku-4.5, and no non-haiku tier anywhere emitted it.** Caveat on power: evor's MCP was only reachable in two sessions (`7fa9c902` binarization, `ee74204e` oh-my-evor), and `ee74204e`'s subagents are all Sonnet-5, so the "haiku-only" claim rests on 3 positive haiku cases and a Sonnet/Opus negative set from a single other session. Directionally confirmed, not yet powered. **SYSTEMIC-plausible (tier-dependent tool-name transcription), evidence still thin.**

### S4 — Subagent truncation (last assistant turn ends on a `tool_use` block)

| Project | subagents | truncated | rate | evor? |
|---|---|---|---|---|
| hackathon-viettel | 12 | 6 | **50.0 %** | no (2026-07, pre-1.2.0) |
| binarization | 98 | 18 | 18.4 % | yes |
| digi-skip | 19 | 3 | 15.8 % | no |
| oh-my-evor | 81 | 7 | 8.6 %* | yes |
| projects-table-cell-det | 19 | 0 | 0 % | no |

\* inflated — 6 of the 7 are lanes still *running* in this session at scan time (including lane-p itself).

**SYSTEMIC (harness-level, not evor).** Truncation occurs at a *higher* rate in a July hackathon project that never had evor installed than in binarization. Whatever cuts subagents mid-turn is not an evor defect. It is also not uniform — table-cell-det's 19 subagents all terminated cleanly — so the driver is likely per-session (long tool chains / context pressure) rather than per-product.

### S5 — Cost profile dominated by cache re-ingestion
Deduped by `message.id` across every message with a `usage` block:

| Project | uniq msgs | output | cache (read+write) | cache % | output % | evor? |
|---|---|---|---|---|---|---|
| binarization | 2664 | 0.46 M | 271.0 M | 99.8 % | 0.17 % | yes |
| projects-table-cell-det | 2008 | 2.17 M | 300.8 M | 99.3 % | 0.72 % | **no** |
| hackathon | 622 | 0.90 M | 143.9 M | 99.4 % | 0.62 % | **no** |
| digi-skip | 751 | 0.73 M | 83.3 M | 99.1 % | 0.87 % | **no** |
| -home-dainb-1 | 235 | 0.30 M | 24.7 M | 98.8 % | 1.21 % | **no** |
| oh-my-evor (all) | 6402 | 12.29 M | 933.4 M | 98.7 % | 1.30 % | yes |
| — of which `ee74204e` main | 2526 | 1.94 M | 709.2 M | **99.7 %** | 0.27 % | yes |
| — of which `ee74204e` subagents | 1151 | 0.77 M | 91.1 M | 99.2 % | 0.83 % | yes |

**SYSTEMIC, and NOT attributable to evor.** Every project sits at 98.7–99.8 % cache. Projects that never loaded evor (table-cell-det 99.3 %, hackathon 99.4 %) are indistinguishable from binarization. The tool's own development session is the *worst* in the corpus at 99.7 % — 672 M cache-read tokens in one session.

This directly qualifies the sibling finding "96.6 % of binarization spend was cache": that number is baseline Claude Code agentic economics on this machine, not an evor regression. Any wave-2 remediation aimed at evor's cache behaviour would be aimed at the wrong layer. (My dedupe yields 99.8 % for binarization vs the sibling lane's 96.6 %; the discrepancy is worth reconciling, but under *either* number the cross-project comparison holds, because I computed all six columns identically.)

### S6 — In-place patching of an installed plugin, uncommitted
Edit/Write tool calls whose `file_path` lands under `plugins/cache`: binarization 1, **every other project 0**. On the transcript surface this is LOCAL.

On the *filesystem* surface it is much larger than the transcripts show — see P-01/P-02 below. Most of the mutation was done by Bash, not by Edit, which is why transcript-level counting undercounts it.

### S7 — Degenerate final messages
Final assistant text that is a bare token or <40 chars: binarization 3 (`noop`, `done`, `done`); oh-my-evor 1 (`I have what I need. Writing the report.` — a lane still mid-flight); digi-skip, hackathon, table-cell-det **0**.

**LOCAL to binarization.** The three degenerate finishers are evor-role subagents. No non-evor project produced a subagent that signed off with `done`/`noop`.

## 4. New findings unique to non-binarization projects

### P-01 (HIGH) — The v1.2.0 plugin was patched in place in *two* locations, and neither is the dev repo
`/home/dainb_1/.claude/plugins/marketplaces/oh-my-evor` is a git clone at HEAD `bab279e` (the released 1.2.0 commit). Its working tree is dirty:

- **15 modified tracked files, `+2989 / −1013`** — `agents/evor-tick.md`, `harness/evor/{contracts,freeze,integrity}.py`, `harness/tests/{test_bench_evaluator,test_tabular_ladder}.py`, `hooks/stop.mjs`, `mcp/bridge/integrity_bridge.py`, `mcp/dist/index.cjs`, `mcp/src/{contracts.ts,tools/compute.ts,tools/record.ts,tools/state.ts}`, `skills/evor/SKILL.md`, `skills/evor-mcp/SKILL.md`
- **26 untracked `*.bak-2026082{3,4}-*` files** left behind by the patch process, including `…bak-prepatch-…` variants

`diff -rq` shows the installed cache `…/plugins/cache/oh-my-evor/oh-my-evor/1.2.0` carries the **identical** patched content for those files (spot-checked byte-identical on `hooks/stop.mjs` and `mcp/src/tools/state.ts`). Meanwhile the developer repo `/home/dainb_1/research/oh-my-evor` is at the same HEAD `bab279e` with **none** of these changes — md5 differs on all three files I compared, and `git status` there shows only `.omc`/`.evor` state churn.

So the behaviour actually running for users diverges from the released source by ~3000 inserted lines, in two copies, with the marketplace clone — the thing a `claude plugin update` reconciles against — also dirty. This is the same defect class lane A found (17 files / ~1500 lines in the cache), but **larger, present in a second location, and measurable against git** because the marketplace copy is a real checkout. Timestamps (`bak-20260823-083205` … `bak-20260824-021010`) place the patching in the window between the 1.2.0 install and the end of the binarization run.

### P-02 (MEDIUM) — Runtime mission state is written inside the installed plugin and inside the marketplace clone
Both `…/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/.evor/` and `…/plugins/marketplaces/oh-my-evor/.evor/` contain live run state: `active-run.json`, `capability.json`, `runs/frontier-1ms/run-live-01/mission-state.json` (differing between the two copies), throttle files, `.deps-ok`, and compiled `__pycache__` trees under `benchmarks/` and `harness/`. Mission state belongs in the *project*, never in the installed artifact; this makes the plugin directory stateful, makes reinstall destructive of run history, and leaks one project's mission into every future project that installs the plugin.

### P-03 (MEDIUM) — The tool's own dogfood mission never produced a result and has been dead for five weeks
`/home/dainb_1/research/oh-my-evor/.evor/runs/frontier-1ms/run-live-01/mission-state.json`:
```
"status": "paused", "best_score": null, "best_node_id": null,
"paused_at": "2026-07-26T18:10:31.144Z", "paused_by": "session-end-hook"
```
The only self-hosted mission ("beat the CIFAR-10 accuracy/latency frontier, ≤1 ms CPU inference") was auto-paused by the session-end hook on 2026-07-26 with a null best score and never resumed, through the entire 1.2.0 development cycle and release. The product has never completed its own core loop end-to-end on its own repo. Two releases shipped in that window.

### P-04 (MEDIUM) — The 2320-session eval corpus exercises zero tools
The tier-matrix harness (2026-08-21/22, 2320 sessions, 128 M tokens) contains **not one `tool_use` block**. Sampled sessions are one `<Agent_Prompt>` in, one fenced-JSON artifact out (`wildness_used`/`proposals…`, `eda_summary`/`hypothesis_verdict`…). The prompts instruct the agent to call `evor_capability()` and `evor_gotcha_query(...)`, but the evor MCP server is not attached in these runs, so those instructions are inert text and the agent answers from the prompt alone.

Consequence: the tier comparison that motivated the v1.2.0 "model-tier optimization" release measured **prompt-completion quality only**. Every failure mode this whole investigation is about — governor refusals, mangled tool prefixes, guard collisions, mid-turn truncation on long tool chains — is by construction invisible to that eval. Combined with the existing memory notes (`eval-harness-grades-artifacts`, `forge-eval-timeout-confound`, `underpowered-at-n30`), this is the third independent reason the tier evidence does not support the claim it was released under. Also: 91.7 % of those 128 M tokens are cache read/write for a workload with no tool loop at all — 2320 cold-ish process launches each re-ingesting the full attachment set.

### P-05 (LOW) — `Exit code 144` recurs across four unrelated projects
`Exit code 144` with no stderr appears in oh-my-evor (4), hackathon (3), table-cell-det (2), digi-skip (2). Nothing evor-specific; likely a background-process/timeout signal path in the harness. Noted only so a wave-2 lane does not mistake it for a product defect.

### P-06 (LOW) — The `sleep`-then-read guard fires in evor and non-evor projects alike
`<tool_use_error>Blocked: sleep N followed by: …` appears in binarization (2) and digi-skip (3). Harness-level polling guard, SYSTEMIC, benign, and correctly firing.

## 5. Verdict table

| # | Signature | binarization | elsewhere | Verdict |
|---|---|---|---|---|
| S1 | Governor/guard dominates error budget | 144/220 = 65 % | 0 in 5 projects | **LOCAL** (definitionally — evor only ran there) |
| S2 | Agent-spawn rejected for `name=` | not reproduced | not found | **UNVERIFIED** |
| S3 | Mangled `oh-my_evor_evor` prefix | 3 files, all haiku-4.5 | 0 real calls | **haiku correlation holds; underpowered** |
| S4 | Subagent truncation | 18/98 = 18.4 % | hackathon 6/12 = 50 % (no evor) | **SYSTEMIC — harness, not evor** |
| S5 | Cache-dominated cost | 99.8 % | 98.7–99.4 % everywhere incl. non-evor | **SYSTEMIC — baseline, not a defect** |
| S6 | In-place plugin patching | 1 Edit + heavy Bash | 0 elsewhere | **LOCAL, but far larger than transcripts show → P-01** |
| S7 | Degenerate final messages | 3 | 0 | **LOCAL** |

## 6. What this means for wave 2
Two of the seven binarization signatures (S4 truncation, S5 cache cost) reproduce in projects that never had evor installed, and one of them (S4) reproduces *worse*. Those are Claude Code harness properties and fixing them in evor would be fixing the wrong layer. The genuinely evor-specific findings are S1, S6, S7 — plus P-01/P-02, which are worse in the tool's own installation than anything found in binarization, and P-03/P-04, which undercut the release evidence rather than the runtime.
