# Lane D — Subagent Fleet Census & Failure Modes (wave 1, breadth)

Source: `/home/dainb_1/.claude/projects/-home-dainb-1-research-binarization/7fa9c902-5d34-4ddb-b3ca-ff6ac294f41f/`
97 subagents (`subagents/agent-*.{jsonl,meta.json}`), parent `7fa9c902-…jsonl` (1505 lines).
Wall clock: 2026-08-23T07:10:24Z → 2026-08-24T02:20:30Z (~19h11m).
Read-only inventory. No root-causing. Derived tables: `census.tsv`, `tool-errors.tsv`, `final-msgs.tsv`, `artifact-writes.tsv` in this directory.

Note on meta files: `agent-*.meta.json` carries only `{agentType, description, toolUseId, parentAgentId, spawnDepth}` — **no model, no timing, no turn count, no terminal state**. All of those were reconstructed from the transcripts (`.message.model`, first/last `timestamp`, assistant-line count, last-line type).

---

## 1. CENSUS

### 1a. Per-role table

| Role | N | Model actually run | Declared (agents/*.md) | Conform | tot min | avg min | max min | avg turns | Depths |
|---|---|---|---|---|---|---|---|---|---|
| oh-my-evor:evor-sage-junior | 12 | sonnet-5 (12) | sonnet, effort medium | OK | 48.0 | 4.0 | 5.1 | 35.8 | 3 |
| oh-my-evor:evor-forge-junior | 11 | sonnet-5 (10), **opus-5 (1)** | sonnet, effort low | **MISMATCH ×1** | 805.6 | 73.2 | 684.6 | 79.1 | 3 |
| oh-my-evor:evor-forge | 8 | opus-5 (8) | opus, effort high | OK | 935.0 | 116.9 | 729.4 | 123.8 | 2 |
| oh-my-evor:evor-tick | 5 | sonnet-5 (5) | sonnet, effort medium | OK (never benchmarked) | 956.9 | 191.4 | 774.9 | 89.4 | 1 |
| oh-my-evor:evor-sage | 5 | haiku-4-5 (5) | haiku | OK | 39.4 | 7.9 | 14.7 | 77.4 | 2 |
| oh-my-evor:evor-mutagen | 5 | haiku-4-5 (5) | haiku | OK | 12.5 | 2.5 | 5.7 | 37.8 | 2 |
| oh-my-evor:evor-forge-critic | 5 | opus-5 (5) | opus, effort medium | OK | 27.4 | 5.5 | 7.3 | 44.4 | 3 |
| oh-my-evor:evor-forge-architect | 5 | opus-5 (5) | opus, effort medium | OK | 21.8 | 4.4 | 7.2 | 27.4 | 3 |
| oh-my-evor:evor-selector | 4 | haiku-4-5 (4) | haiku | OK | 9.0 | 2.2 | 4.1 | 32.0 | 2 |
| oh-my-evor:evor-forge-analyst | 4 | opus-5 (4) | opus, effort medium | OK | 29.4 | 7.4 | 9.2 | 41.2 | 3 |
| oh-my-evor:evor-probe | 1 | haiku-4-5 (1) | haiku | OK | 2.7 | 2.7 | 2.7 | 49.0 | 1 |
| **oh-my-evor:evor-acquirer** | **0** | — | haiku | **NEVER SPAWNED** | — | — | — | — | — |
| claude (generic) | 15 | opus-5 (15) | n/a | n/a | 182.2 | 12.2 | 86.7 | 53.3 | 1–2 |
| general-purpose (generic) | 15 | opus-5 (9), sonnet-5 (4), haiku-4-5 (2) | n/a | n/a | 52.9 | 3.5 | 13.4 | 32.7 | 1–2 |
| workspace-scout | 1 | opus-5 (1) | n/a | n/a | 227.2 | 227.2 | 227.2 | 56.0 | 0 |
| Explore | 1 | opus-5 (1) | n/a | n/a | 2.5 | 2.5 | 2.5 | 30.0 | 1 |
| **TOTAL** | **97** | opus-5 49 / sonnet-5 31 / haiku-4-5 17 | | | | | | | |

Model mix: **opus-5 49 (50.5%), sonnet-5 31 (32.0%), haiku-4-5 17 (17.5%)**.
Evor-typed agents: 65 of 97 (67%). Generic (`claude` / `general-purpose` / `workspace-scout` / `Explore`): 32 of 97 (33%), and **31 of those 32 ran on opus-5 or sonnet-5** — i.e. the untiered generic fleet is where the expensive tokens went, not the retiered evor roles.

Spawn depth: 0→1, 1→28, 2→23, 3→45.

### 1b. Terminal state

| Terminal state (last transcript line) | N |
|---|---|
| assistant, no stop_reason recorded | 71 |
| assistant / `end_turn` | 8 |
| **user (tool_result) — no closing assistant turn** | **18** |

No `isApiErrorMessage` lines in any transcript (0/97) — nothing died from an API-level error.

---

## 2. TIER CONFORMANCE

Declared frontmatter as shipped in `/home/dainb_1/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/agents/`:

| Agent file | model | effort | disallowedTools |
|---|---|---|---|
| evor-acquirer.md | haiku | — | — |
| evor-forge-analyst.md | opus | medium | Write, Edit |
| evor-forge-architect.md | opus | medium | Write, Edit |
| evor-forge-critic.md | opus | medium | Write, Edit |
| evor-forge-junior.md | sonnet | low | — |
| evor-forge.md | opus | high | — |
| evor-mutagen.md | haiku | — | — |
| evor-probe.md | haiku | — | Write, Edit |
| evor-sage-junior.md | sonnet | medium | Write, Edit |
| evor-sage.md | haiku | — | Write, Edit |
| evor-selector.md | haiku | — | Write, Edit |
| evor-tick.md | sonnet | medium | Bash, Write, Edit |

Conformance verdict: **11 of 12 roles ran on exactly their declared tier.** The v1.2.0 retier landed as intended for sage, mutagen, probe, selector (all haiku), forge-junior (sonnet), and tick (sonnet).

Two deviations:
- **`evor-forge-junior` agent-a88bbc68c441df191 ran on `claude-opus-5`** while the other 10 ran on `claude-sonnet-5`. Description "Implement IIR scan candidate"; 171 lines, 106 assistant turns, 39 min, 2026-08-24T00:41→01:20. Upward deviation — the cheap-tier role escaped to the expensive tier on the single longest-lived implementation task. There is also a `evor-tick.md.bak-20260824-013931` backup file in the agents dir, timestamped 2026-08-24 01:39 — i.e. an agent definition was **edited mid-run**, ~19 min after this opus forge-junior started. Any tier measurement spanning that boundary is confounded.
- **`evor-acquirer` was retiered to haiku but never spawned once.** Its retier is unmeasured by this run, in either direction.

`evor-tick` shipped new on sonnet and was never benchmarked — this run is its first field exposure: 5 agents, 956.9 min total (the largest wall-clock share of any role), 89.4 avg turns, and the highest per-agent tool-discovery burden in the fleet (10.4 ToolSearch calls/agent).

---

## 3. FAILURE MODES

208 error-flagged tool results across 89 of 97 agents.

### 3.1 MISSING-TOOL (top priority) — 127 hits

Three distinct sub-modes.

**(a) GOVERNOR ROLE-BLOCKS — 104 hits, the dominant failure mode of the whole run.**
The EVOR governor rejected tool calls because the calling role is not permitted that action. These are not crashes; they are agents repeatedly attempting capabilities their role does not have.

| Block message | Role | Hits |
|---|---|---|
| "…does not run raw training code. Only evor-forge-junior runs candidate code." | claude | 22 |
| same | evor-forge | 19 |
| same | general-purpose | 18 |
| same | evor-forge-critic | 8 |
| same | evor-forge-analyst | 6 |
| same | evor-forge-architect | 4 |
| same | workspace-scout | 2 |
| same | evor-sage | 2 |
| same | evor-probe | 1 |
| "…does not author code. Only evor-forge-junior writes candidate code; emit your JSON artifact instead." | claude | 4 |
| same | general-purpose | 3 |
| "artifact slot is not accessible from your role. Use the correct evor_* tool for your role." | evor-forge-architect | 4 |
| same | evor-sage / evor-forge-critic / evor-forge-analyst | 1 each |
| "Direct write to an evor state file is not allowed. Use evor_write_artifact(agent=\"mutagen\")…" | evor-mutagen | 2 |
| "evor-forge-junior may be spawned ONLY by evor-forge. claude must not spawn it directly." | claude | 2 |
| same | evor-tick | 1 |
| "your current working directory is /home/dainb_1/research/binarization" (cwd guard) | evor-tick | 3 |

**82 of 104** are the single "does not run raw training code" block. It fires against **9 different roles**, and the top three offenders are `claude` (22), `evor-forge` (19), and `general-purpose` (18) — the orchestrator tier, not the workers. The governor is functioning; the agents are not reading it.

**(b) NON-EXISTENT TOOL NAMES — 5 hits, all on haiku-tier roles.**
Four of five are a **mangled MCP server prefix**: `mcp__plugin_oh-my_evor_evor__…` (underscore) instead of the real `mcp__plugin_oh-my-evor_evor__…` (hyphen).

| Agent | Role | Model | Tool attempted |
|---|---|---|---|
| agent-a60047ec408340f38 | evor-probe | haiku | `mcp__plugin_oh-my_evor_evor__evor_signal_emit` (×2; 6 occurrences of the mangled prefix in transcript) |
| agent-aeafb73a99ca56b8b | evor-sage | haiku | `mcp__plugin_oh-my_evor_evor__evor_wiki_add` (3 occurrences) |
| agent-a09ed84ed03e97b1d | evor-selector | haiku | `mcp__plugin_oh-my_evor_evor__evor_gotcha_query` (3 occurrences) |
| agent-aeafb73a99ca56b8b | evor-sage | haiku | `mcp__plugin_oh-my-evor_semantic-Scholar__search_papers` (server does not exist under that name) |

The mangled prefix appears in **exactly 3 agents, all haiku, all three of the retiered-to-haiku roles that emit signals** (probe, sage, selector). Zero occurrences on any sonnet or opus agent.

**(c) SCHEMA REJECTIONS — 11 hits (`MCP error -32602` / `InputValidationError`).**

| Role | Model | Hits | Tools |
|---|---|---|---|
| evor-tick | sonnet | 5 | `evor_gotcha_add`, `evor_signal_emit` ×2, `evor_validate_proposals`, `evor_wiki_add` |
| evor-sage-junior | sonnet | 4 | `evor_cite` ×2, `evor_write_artifact`, `web_fetch_exa` |
| evor-selector | haiku | 1 | `evor_validate_proposals` |
| evor-sage | haiku | 1 | `evor_signal_emit` |
| evor-forge-critic | opus | 1 | `evor_write_artifact` |

`evor-tick` (the new, never-benchmarked sonnet role) is the single worst schema offender at 5 hits from only 5 agents.

Other error buckets, for completeness: MISSING-FILE 5 (tick 3, forge-junior 2), RUNTIME-ERR 8, TIMEOUT 1 (forge-junior), user-rejected tool use 4.

### 3.2 EMPTY / DEGENERATE-RETURN — 10 agents

Final assistant text under 60 characters:

| Agent | Role | Final text |
|---|---|---|
| agent-a3c44e832c15c4cb7 | evor-sage-junior | *(empty — zero characters)* |
| agent-a63b6ea68a21c4774 | general-purpose | `done` |
| agent-ab07a43b2c508c1b0 | general-purpose | `done` |
| agent-ac7864a87c509c47a | general-purpose | `noop` |
| agent-a422f5b873de3ee7b | evor-forge-analyst | `Now writing the artifact.` |
| agent-ae032f685c8a49d35 | evor-forge-analyst | `Now writing the artifact.` |
| agent-a3340d607fe0dd28f | evor-forge-architect | `I have everything I need. Writing the verdict.` |
| agent-abcf43be6fb09796d | evor-mutagen | `Let me check the environment and the run state:` |
| agent-a0c0679c9d7c6c9ee | evor-sage-junior | `Let me try wiki query and start research in parallel.` |
| agent-a6189b43a4eb528ce | claude | `I'll stop polling and let the monitor fire.` |

Six of these are not summaries at all — they are **mid-plan sentences announcing work that never happened**. `Now writing the artifact.` appearing twice, verbatim, from two different forge-analyst agents is a repeating stall shape, not a one-off. No apologies or refusals were found in any final message.

### 3.3 TRUNCATED / ABORTED — 18 agents (18.6% of the fleet)

Transcript's last line is a `user` tool_result with no closing assistant turn — the agent was cut off after a tool returned and before it could speak.

| Role | N |
|---|---|
| evor-sage-junior | 5 |
| evor-forge-junior | 3 |
| evor-forge-analyst | 3 |
| evor-mutagen | 2 |
| evor-forge-architect | 2 |
| claude | 2 |
| evor-probe | 1 |

Full list with line counts: a06785e0 forge-architect 39 "Architect IIR-BinNet design"; a0c0679c sage-junior 59; a2b6461c mutagen 57 "Tick 1 proposals"; a2d4b08f forge-junior 91 "Fix reviewer-confirmed defects"; a3340d60 forge-architect 42 "Architect design review"; a3c44e83 sage-junior 70; a422f5b8 forge-analyst 92 "Analyst resource review"; a45104c2 sage-junior 82; a463e4ec sage-junior 81; a4d12a0b claude 40 "Wait for forge artifact"; a60047ec probe 78 "Analyze iir-scan-binnet-02"; a6189b43 claude 284 "Fix telemetry_sane false negative"; a8628ef7 forge-junior 185; a914fb0c forge-analyst 74 "Analyst resource review"; abcf43be mutagen 54; ac35af2f sage-junior 80; ae032f68 forge-analyst 85 "Forge-analyst review"; ae438092 forge-junior 49 "Apply EDIT 10 and run test_integrity".

The degenerate-return set (3.2) and the truncated set overlap heavily: 6 of the 10 degenerate finals are also truncated agents. **`evor-forge-analyst` was truncated on 3 of its 4 spawns (75%).**

Since zero API errors were recorded, these terminations were not API failures — likely turn caps (`maxTurns` is declared per-agent; evor-sage.md sets 22) or parent-side cancellation. Wave 2 question.

### 3.4 CONTRACT-VIOLATION — 7 agents produced no artifact

Roles whose contract is to emit a JSON artifact via `evor_write_artifact`, measured as: count `tool_use` blocks named `*evor_write_artifact` and subtract those whose `tool_use_id` came back `is_error:true`.

| Role | agents | wa calls | wa succeeded |
|---|---|---|---|
| evor-sage-junior | 12 | 38 | 37 |
| evor-forge | 8 | 18 | 18 |
| evor-forge-critic | 5 | 6 | 5 |
| evor-mutagen | 5 | 5 | 5 |
| evor-selector | 4 | 5 | 5 |
| evor-forge-analyst | 4 | 4 | 4 |
| evor-forge-architect | 5 | 4 | 4 |
| evor-sage | 5 | 4 | 4 |
| evor-probe | 1 | 1 | 1 |
| evor-tick | 5 | 1 | 1 |
| evor-forge-junior | 11 | 0 | 0 (by design — junior writes code, not artifacts) |

Agents in an artifact-emitting role that never landed a single artifact:

| Agent | Role | Model |
|---|---|---|
| agent-a2b6461cadd031510 | evor-mutagen | haiku |
| agent-abcf43be6fb09796d | evor-mutagen | haiku |
| agent-add89424e6e9ca27f | evor-mutagen | haiku |
| agent-a0883883915400a0d | evor-sage | haiku |
| agent-a658b68f9ea1110eb | evor-sage | haiku |
| agent-a06785e01abd654b6 | evor-forge-architect | opus |
| agent-a0c0679c9d7c6c9ee | evor-sage-junior | sonnet |

**5 of 7 are haiku, and they are 3/5 of all mutagen spawns (60%) and 2/5 of all sage spawns (40%)** — the two roles v1.2.0 retiered to haiku. Both haiku roles then required a rescue spawn (see 3.5). Sample size is small; this is a flag for wave 2, not a proven tier regression.

### 3.5 RETRY-SPAWN — 6 confirmed chains, plus 2 rescue spawns

Identical `description` strings spawned repeatedly for the same unit of work:

| Description | Role | Spawns | Note |
|---|---|---|---|
| "Tick 1 proposals" | evor-mutagen | **3** | + a 4th spawn "Tick 1 proposals retry" ⇒ **4 of 5 total mutagen spawns on one unit of work**; 3 of the 3 produced no artifact |
| "Tick 1 grounding research" | evor-sage | **3** | + a 4th "Tick 1 grounding research retry" ⇒ **4 of 5 total sage spawns**; 2 produced no artifact |
| "Tick 1 gate" | evor-selector | **3** | 3 of 4 total selector spawns |
| "Architect design review" | evor-forge-architect | **3** | 3 of 5 total; one produced no artifact, two truncated |
| "Analyst resource review" | evor-forge-analyst | **3** | 3 of 4 total; two ended on "Now writing the artifact." |
| "Critic review of candidate" | evor-forge-critic | 2 | |
| "Research public Khmer/Sanskrit palm-leaf manuscript datasets…" | evor-sage-junior | 2 | |
| "Research adversarial degradation-curriculum augmentation…" | evor-sage-junior | 2 | |

**Rescue spawns** — the parent gave up on the role and spawned a *generic* agent solely to write the artifact the role could not:

- `agent-a91b8131e435829f3` — **general-purpose**, "Write corrected Sage findings artifact via evor_write_artifact MCP tool"
- `agent-af99550befe768079` — **general-purpose**, "Write mutagen proposals artifact via evor_write_artifact"

Both rescues target exactly the two haiku roles with the worst artifact-emission rate. This is the clearest end-to-end signature in the data: haiku role fails to emit → retried 3× → retry-suffixed 4th spawn → finally handed to an opus generic agent.

### 3.6 OVERSPAWN — ~14 spawns of low or zero yield

- **Tick-1 alone consumed 4 mutagen + 4 sage + 3 selector = 11 spawns** for what the pipeline models as three single steps. Add the 2 rescues: **13 spawns for 3 units of work.**
- **Pure poll/wait agents (5)**, spawned only to block on another agent's output: `Wait for selector verdict` (claude), `Wait for mutagen artifact` (claude), `Wait for forge artifact` (claude, truncated at 40 lines), `Verify r3 eval anchor and close old missions` (claude), `Verify iir-binnet-01 artifacts on disk` (claude). One of these, `agent-a6189b43a4eb528ce`, burned 284 lines and 86.7 min before concluding "I'll stop polling and let the monitor fire."
- **Explicit placeholders (2)**: `noop wait placeholder` (evor-tick), `placeholder wait` (general-purpose). Two more generic agents returned only `done` and one returned only `noop`.
- `evor-forge` at 8 spawns and 935 min total, and `evor-forge-junior` at 11 spawns / 805 min, are the two heaviest roles; whether that count is warranted needs the tick structure from lane C.

---

## 4. UTILIZATION

Parent-level spawn accounting (`Agent` tool calls in the parent transcript): **32 direct spawns** — `claude` 15, `general-purpose` 10, `evor-tick` 4, `evor-forge` 2, `evor-probe` 1. The remaining 65 subagents were spawned by children (depth 2–3).

**Only 7 of the parent's 32 direct spawns (22%) were evor-typed roles.** 25 of 32 were untyped generic agents running on opus/sonnet — the orchestrator largely bypassed its own role fleet, which is why the governor's "does not run raw training code" block fired 40 times against `claude` and `general-purpose` combined.

Estimated wasted spawns (results not consumed, or consumed only to trigger a retry):

| Category | Count |
|---|---|
| Artifact-emitting agents that emitted nothing (§3.4) | 7 |
| Rescue spawns needed only because a role failed (§3.5) | 2 |
| Pure poll/wait agents producing no artifact (§3.6) | 5 |
| Explicit placeholder / `done` / `noop` returns (§3.6) | 5 |
| **Total (with overlap removed)** | **~17 of 97 ≈ 18%** |

Truncation adds a second, larger band: 18 agents ended without a closing turn, and for at least 6 of them the final text proves the deliverable was never produced. Upper bound on non-productive spawns is therefore closer to **25–30%**. Precise consumption tracing (matching each `Agent` tool_use_id to whether the parent's next turn referenced its output) is a wave-2 job.

The parent itself recorded 10 error tool_results out of ~100 tool calls, and used `AskUserQuestion` 11 times — this run was not fully autonomous.

---

## 5. CATEGORIES WITH ZERO HITS

- **API-level failures**: 0 of 97 transcripts contain an `isApiErrorMessage` line.
- **Refusals / apologies in final returns**: 0. No agent declined its task.
- **Genuinely empty returns**: 1 (agent-a3c44e832c15c4cb7, evor-sage-junior). The other degenerate returns had content, just the wrong content.
- **Tier violations in the "ran cheaper than declared" direction**: 0. The only tier deviation is *upward* (one forge-junior on opus).
- **Non-evor MCP server outages**: 0 beyond the single non-existent `semantic-Scholar` server name.
