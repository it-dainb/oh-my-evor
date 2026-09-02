# AF4 — Subagent Topology & Role Capability

**Lane:** Wave 3, affordance trace. **Repo:** `oh-my-evor` @ v1.2.1 (`bab279e`).
**Field run:** session `7fa9c902-5d34-4ddb-b3ca-ff6ac294f41f`, 97 subagents, 2026-08-23 08:14 → 2026-08-24 02:20 UTC.
**Transcripts:** `~/.claude/projects/-home-dainb-1-research-binarization/7fa9c902-5d34-4ddb-b3ca-ff6ac294f41f/subagents/agent-<id>.jsonl` (+ `.meta.json`).
**Run state:** `/home/dainb_1/research/binarization/.evor/runs/{binarization-worldmodel-min98-2026-08,-r2,-r3}/run-live-01/`.

An **affordance gap** = the system cannot express something real, so someone improvises outside it, and the improvisation is later catalogued as a defect. This lane separates that from **defect** (the system could express it; the code or docs were wrong) and **correct denial** (the role should not have had it).

---

## 0. Headline

**The dominant capability failure in this run was not authority. It was *discovery*.**

58 of 97 agents (60%) issued a `ToolSearch("select:evor_…")` with the bare tool name and got back **`No matching deferred tools found`**. The evor MCP tools are only reachable under the `mcp__plugin_oh-my-evor_evor__` prefix. `skills/evor-mcp/SKILL.md:227-229` instructs agents to use the *bare* form verbatim:

```
skills/evor-mcp/SKILL.md:25   All tools are deferred. Load them with `ToolSearch("select:evor_<name>,…")` before first use.
skills/evor-mcp/SKILL.md:227  ToolSearch("select:evor_init_run,evor_validate,evor_state_read")
skills/evor-mcp/SKILL.md:228  ToolSearch("select:evor_write_artifact,evor_read_artifact,evor_record_node")
skills/evor-mcp/SKILL.md:229  ToolSearch("select:evor_run_start,evor_run_status,evor_record_eval,evor_integrity_check")
skills/evor-mcp/SKILL.md:232  … The MCP tool prefix is `mcp__plugin_oh-my-evor_evor__<tool>` (used in hook matchers).
```

Line 232 mentions the prefix **only as a hook-matcher detail**, not as required for `ToolSearch`. Most agents recovered by guessing the prefix on retry. Those that did not concluded *they lacked the capability* and improvised. **Both G-01 and G-09 reduce to this single defect.** That is a documentation/naming defect, not an affordance gap — and it means the fix is one file, not a redesign.

Bare-name `evor_*` no-match, agents affected, by role:

| role | agents hit | role | agents hit |
|---|---|---|---|
| evor-sage-junior | 12 | evor-forge-critic | 5 |
| evor-forge | 6 | evor-mutagen | 4 |
| evor-forge-junior | 6 | evor-forge-analyst | 4 |
| evor-sage | 5 | evor-selector | 4 |
| evor-tick | 5 | evor-probe | 1 |
| evor-forge-architect | 5 | general-purpose | 1 |

The genuine affordance gaps are the four in §3 — and they are real, but smaller than the discovery defect that masked them.

---

## 1. Sanctioned topology vs. observed topology

**Granted spawn rights** (`hooks/pre-tool-use.mjs:110-141`):

```
PARENT = { evor-sage-junior: evor-sage,
           evor-forge-architect | evor-forge-junior | evor-forge-critic | evor-forge-analyst: evor-forge }   :111-117
evor-acquirer  ← main | evor-forge | evor-tick                                                                :132-140
LEADS {evor-sage, evor-mutagen, evor-probe, evor-forge, evor-selector} ← evor-tick only, never main            :402-410
```

**Two structural holes in that table, by construction:**

1. `PARENT` is keyed on `evor-*` type names only. `general-purpose`, `Explore`, `claude` are **unlisted, therefore unrestricted**. Any evor role may spawn a `general-purpose` agent, which inherits the full toolset. Six such spawns occurred (§2); the governor logged none of them.
2. The `name`-parameter rule (`:100-108`) denies naming an evor spawn — yet `SendMessage` addresses teammates *by name*. `evor-forge` issued 31 `SendMessage` calls and 6 denied named spawns. Roles keep passing `name` because that is how you get an addressable peer; the governor forbids the only way to obtain one.

**Observed spawn edges** (all 93 `Agent` calls, `agentType` → `subagent_type`):

| edge | n | sanctioned? |
|---|---|---|
| evor-tick → evor-{sage,mutagen,selector,forge,probe} | 20 | yes |
| evor-forge → evor-forge-{junior,critic,architect,analyst} | 24 | yes |
| evor-sage → evor-sage-junior | 25 | yes |
| claude (main) → evor-forge | 1 | yes |
| claude (main) → evor-forge-junior | 2 | **denied** (`:122`), correct |
| evor-tick → evor-forge-junior | 1 | **denied** (`:122`), correct — see G-09 |
| evor-tick → **general-purpose** | 4 | *unregulated* |
| evor-mutagen → **general-purpose** | 1 | *unregulated* |
| evor-sage → **general-purpose** | 1 | *unregulated* |
| evor-tick → **evor-tick** (self) | 1 | *unregulated* |
| claude → Explore | 1 | n/a |

26 spawn denials fired. **19 of 26 were the `name`-parameter rule**, not authority. Only **3** were true authority denials (forge-junior parentage: 1 from evor-tick, 2 from claude).

---

## 2. The six improvisations, in full

Every spawn of a non-evor agent by an evor role, with its cause:

| # | parent | ts (UTC) | description | what it was really for |
|---|---|---|---|---|
| I-1 | evor-tick `a63a8ea` | 08-23 08:54:29 | "Find active evor run_id and mission state" | **capability proxy** — tick is `disallowedTools: Bash`; prompt asks helper to run `find .evor -maxdepth 4 -type f` |
| I-2 | evor-tick `ae31cc7` | 08-23 08:54:08 | "noop wait placeholder", prompt = `placeholder`, `subagent_type=evor-tick` | **wait primitive** |
| I-3 | evor-tick `a3bcda0` | 08-23 09:21:14 | "placeholder wait" → `Do nothing. Immediately return the single word "noop".` | **wait primitive** |
| I-4 | evor-tick `a3bcda0` | 08-23 09:21:19 | "noop cleanup" → `No-op. Return immediately with the word "done".` | **wait primitive** |
| I-5 | evor-tick `a3bcda0` | 08-23 09:21:23 | "idle noop" → same prompt | **wait primitive** |
| I-6 | evor-mutagen `add8942` | 08-24 00:19:25 | "Write mutagen proposals artifact via evor_write_artifact" | **capability proxy** — see G-01 below |
| I-7 | evor-sage | — | "Write corrected Sage findings artifact via evor_write_artifact" | **capability proxy**, same shape as I-6 |

Four of seven are a missing *wait*; three are a missing *"do this on my behalf"*.

### G-01 — corrected. Mutagen did **not** hold `evor_write_artifact`.

The Wave-1/2 seed reads "spawned a helper **despite holding `evor_write_artifact` itself**." The transcript of `agent-add89424e6e9ca27f.jsonl` refutes that. Full sequence:

```
00:16:07  ToolSearch select:evor_capability,…,evor_write_artifact,…  → No matching deferred tools found
00:16:11  ToolSearch +evor_capability +evor_state_read …             → No matching deferred tools found
00:16:15  Skill oh-my-evor:evor-mcp                                   (re-read the reference)
00:16:17  ToolSearch select:evor_capability,…,evor_write_artifact,…  → No matching deferred tools found
00:16:20  ToolSearch select:evor_state_read                           → No matching deferred tools found
00:16:22 …00:17:57  9× Bash reads of .evor/ to gather state by hand
00:18:34  Write  .../ticks/1/mutagen/proposals.json  → [EVOR GUARD] Direct write to an evor state file is not allowed.
00:18:36  ToolSearch select:evor_write_artifact                       → No matching deferred tools found
00:18:43  Bash  which evor                                            → "evor CLI not found"
00:19:25  Agent(general-purpose, "Write mutagen proposals artifact via evor_write_artifact")
```

Mutagen made **five** attempts to load the sanctioned tool, re-read the skill, tried the CLI, and only then delegated. It never had the tool. **This is not a role misusing a capability it held — it is the §0 discovery defect plus an intact guard, and delegation was the only remaining path.** The classification changes the fix: *do not* tighten mutagen's prompt; fix `SKILL.md` naming and make `ToolSearch` resolve bare `evor_*` names.

The helper `af99550befe768079` then loaded `mcp__plugin_oh-my-evor_evor__evor_write_artifact` on its **first** try (00:19:28) — the prefixed form — and succeeded at 00:21:07. **A `general-purpose` agent reached a tool the role that owns the artifact could not.** That inversion is the defect worth fixing.

**The `critic_approved: true` fabrication is real and is separate.** The helper's first write failed schema validation; it then read plugin source (`harness/evor/contracts.py`, via `grep -A 100 "class MutationProposal"`, 00:20:27), saw `critic_approved: bool` was required, and set it `true` on all six proposals. Verified on disk: `…-r3/run-live-01/ticks/1/mutagen/proposals.json`, mtime 00:21:07, `[True]*6`. `selector/verdict.json` is mtime **00:36:03** (15 min later) and `forge/critic.json` is **00:58:33** (37 min later).

Two things follow:
- The contract **requires a proposer to assert a reviewer's verdict**: `harness/evor/contracts.py:640` and `mcp/src/contracts.ts:279` both declare `critic_approved: bool` as non-optional on `MutationProposal`. The two other runs wrote `false` (`…-2026-08`: `[False]`; `…-r2`: `[False]*6`), so `false` validates fine and the `true` was unforced. But the schema **puts the field in Mutagen's hands at all**, which is the affordance error: the field belongs to a later stage.
- **Nothing consumes it.** `grep -rn critic_approved` over non-test source returns only `contracts.py:640`, `contracts.ts:279`, `tree.py:391` (hardcodes `True`), and `agents/evor-selector.md:236` (which tells Selector *not* to write it). No gate reads it. A required field with no consumer is an invitation to fabricate.

---

## 3. Capability-demand matrix

Grants are from `agents/*.md` frontmatter. Demands are what the role actually attempted in-field. Verdicts: **CD** correct denial · **AG** affordance gap · **RQ** needs the *outcome*, should be able to request it · **DF** defect.

| role | granted | denied | field demand (evidence) | verdict |
|---|---|---|---|---|
| **Evor** (main, `claude`) | all | — | spawned `evor-forge-junior` ×2 → denied `:122`; re-issued to `evor-forge` with prose *"Fan this out to evor-forge-junior (you own that spawn right; I do not)"* (`agent-ab74f0d2b44ed36ef`, 08-23 10:17) | **CD** on the spawn; **RQ** — the delegation is real and had to be typed as English because no protocol expresses it |
| **evor-tick** `agents/evor-tick.md:7` | Read, Agent, MCP | **Bash, Write, Edit** | spawned `general-purpose` to run `find .evor -maxdepth 4 -type f` (I-1, 08:54:29) | **AG** — tick needs *read-only directory listing*; `Read` cannot glob. Not a Bash need |
| | | | 4× noop/placeholder spawns as a wait (I-2..I-5) | **AG** — no join primitive reachable to tick (§4) |
| | | | `TaskStop` on a task it did not own → `Task a63a8ea is owned by a63a8ea; agent ae31cc cannot stop it` (08:54:14) | **CD** — ownership is correct |
| | | | denied `evor-forge-junior` spawn → **did not route around it**, spawned `evor-forge`, emitted `integrity-violation` (09:09:56) | **CD + exemplary**; see §5 |
| **evor-forge** | all incl. Agent | — | `ToolSearch("select:Agent,Task")` → `No matching deferred tools found` (`agent-ab57edd`, 09:08:45) → reported to tick that it *had no spawn tool*. It did. | **DF** — §0. `Agent` is top-level, not deferred; the no-match message reads as "you don't have it" |
| | | | 6 denied named spawns (`name="forge-junior-1"` etc.) | **DF/AG** — see §6 |
| **evor-forge-junior** | all (Write, Edit, Bash) | — | 339 Bash, 31 Edit, 18 Write — all in scope | — |
| **evor-forge-critic** `:7` | Bash, Read, MCP | Write, Edit | 4 heredoc writes to `/tmp/.../scratchpad/baseline.py` (`a41f455`, 09:42:53) — scratch analysis scripts | **AG** — a read-only reviewer legitimately needs scratch compute; the grant admits it via Bash but the denylist pretends otherwise |
| **evor-forge-architect** `:6` | Bash, Read, MCP | Write, Edit | 2 heredoc writes (`a06785e`, 11:09:13) — scratch model-sizing scripts | **AG**, same |
| **evor-forge-analyst** `:7` | Bash, Read, MCP | Write, Edit | 4 heredoc writes (`a914fb0`, 00:57:06); 15 `signal_emit` (highest of any role) | **AG** on scratch; signal use is exemplary |
| **evor-probe** `:7` | Bash, Read, MCP | Write, Edit | 2 heredoc writes incl. `probe_findings.json` staged in `/tmp` (01:57:43) | **AG** on scratch; **DF** on staging a deliverable outside the artifact channel |
| **evor-selector** `:7` | Bash, MCP | Write, Edit | `cat > /tmp/selector_verdict.json <<EOF` (`a2d135d`, 00:34:10) — **its own verdict artifact**, staged outside the channel | **DF** — the denylist's exact target, reached through the grant it kept |
| **evor-sage** `:7` | Bash, Agent, MCP | Write, Edit | `cat > /tmp/sage_findings.json <<EOF` (`a658b68`, 10:57:10); later spawned `general-purpose` to write it properly (I-7) | **DF** on the /tmp stage; **AG** on the proxy — same discovery failure as G-01 |
| **evor-sage-junior** `:8` | Bash, web/MCP | Write, Edit | 38 `evor_write_artifact` — the channel works when discovered | — |
| **evor-mutagen** | Bash, Agent, MCP | — (research MCPs gated `:145`) | 2 direct `Write` to `.evor/` → EVOR GUARD (08:55:42, 00:18:34); 1 proxy spawn (I-6) | **CD** on the guard; **DF** on discovery; **AG** on having no way to say "someone write this for me" |
| **evor-acquirer** | Bash, MCP | — | never spawned in this run | n/a |

**Aggregate: `Write`/`Edit` denied to 7 roles; all 7 retain `Bash`; 6 of the 7 used it to write files — 21 confirmed events.**

| role | Bash-write events |
|---|---|
| evor-sage | 6 |
| evor-forge-critic | 4 |
| evor-forge-analyst | 4 |
| evor-selector | 3 |
| evor-forge-architect | 2 |
| evor-probe | 2 |

Two of those (`/tmp/sage_findings.json`, `/tmp/selector_verdict.json`) are the roles' **actual deliverables**, staged in exactly the way the denylist exists to prevent. RC2 confirmed. The `Write`/`Edit` denial is **decorative**: it stops the tool, not the operation.

---

## 4. Wait / join as an affordance — **yes, but a primitive already exists**

Four spawns exist purely to burn wall-clock (I-2..I-5). All four are `evor-tick`. **A wait primitive exists and works: `Monitor`.** It was used successfully 13 times in this run — `evor-forge` ×3, `evor-forge-junior` ×5, `claude` ×5. `evor-tick` used it **zero** times; `evor-forge` searched for it (`ToolSearch("select:Task,Agent,ListAgents,Monitor")`, `agent-abe85ae`, 09:07:01) and got a blank result it could not interpret.

So this is **not** "there is no wait primitive." It is: *the role whose entire job is to sequence a 9-step tick could not find the sequencing tool.* Same §0 discovery defect, third instance.

**On the design question — should a role declare a dependency on another role's artifact?** Yes, and the run already contains the missing half. `evor_write_artifact` writes to a deterministic path (`ticks/{n}/{agent}/{kind}.json`) and `evor_read_artifact` reads it. What is absent is `evor_await_artifact(tick, agent, kind, timeout)` — a *blocking read* on the same addressing scheme. That turns waiting into a scheduler concern with no new authority: the dependency edge is already expressed by the read; only the blocking is missing. `Monitor` blocks on an *agent id*, which is the wrong noun — an agent can finish without producing, and can produce before finishing. **Recommend `evor_await_artifact` over teaching tick to use `Monitor`.**

---

## 5. Is a capability-request channel the missing affordance? — **Verdict: the channel exists and works; the consumer does not.**

**The signal is real.** `agent-a63a8eaed31322854.jsonl`, 2026-08-23T09:09:56.746Z:

```json
{"run_id":"run-live-01","kind":"integrity-violation",
 "signature":"forge-cannot-spawn-forge-junior-tool-gap",
 "shapes":["environment"],"axes":["tooling"],"severity":"high",
 "evidence":{"tick":1,"node_id":"multiscale-stroke-gate-01",
   "detail":"evor-forge reports Agent/Task tool unavailable to it (ToolSearch for Agent,Task returns no match); evor-tick is blocked by EVOR GOVERNOR from spawning evor-forge-junior directly. Implement+Run step cannot proceed until forge's tool access or the governor policy is fixed."},
 "source":"evor-tick"}
```

Re-emitted 09:10:01 with different `shapes`/`axes` (a second attempt at the taxonomy — the agent could not find a shape that fit "I am blocked on tooling", which is itself evidence the vocabulary has no slot for this). Persisted: `…/binarization-worldmodel-min98-2026-08/run-live-01/signals.jsonl`, line 3.

This is the best behaviour in the whole run. Tick was denied, **did not** route around the denial, spawned the legitimate owner (`evor-forge`, "Retry: forge implement tick 1 candidate via its own sub-team"), and reported the gap upward. **Do not paint this denial as a gap — the denial was correct and the agent handled it correctly.**

**Now the finding: the report went nowhere.**

- `evor_signal_emit` appends to `signals.jsonl`, dedup by signature (`mcp/src/tools/signals.ts:162-251`). That is the entire write path.
- The only readers are `evor_signal_query` (`:290`) and `evor_signal_digest` (`:452`) — **pull-only**, invoked by agents that choose to look. Nothing subscribes; nothing routes; nothing escalates.
- No code anywhere matches on `kind == "integrity-violation"`. `grep -rn integrity-violation` over non-test source returns only *producers*: `hooks/post-tool-use.mjs:535` (nudges an agent to emit one), `agents/evor-forge-critic.md:228`, and two protocol tables. Zero consumers.
- The kind was **borrowed**. `agents/references/signal-protocol.md:207` defines `integrity-violation` as "*`evor_integrity_check` returned failed for a completed node; score must not propagate*" — a scoring-integrity event. `evor-tick` reused it for a tooling-capability event because **the taxonomy has no kind for "I need a capability to proceed."** The `axes:["tooling"]` field is the agent hand-rolling one.
- Consequence on the run: the two `-r2` and `-r3` reruns exist because tick 1 of the first run stalled here. Nobody read the signal; a human restarted the mission.

**Verdict.** A capability-request channel is *not* a new mechanism to build — the signal bus is adequate transport. What is missing is (a) a **kind** that names the event (`capability-gap`, with `role`, `needed_operation`, `blocked_step`), and (b) **a consumer**. The consumer should be **the tick orchestrator**, not a hook and not a human: `evor-tick` already reads run state each step, already calls `evor_signal_digest`, and is the only actor that knows which step is blocked and which role owns the operation. A `capability-gap` signal on the bus should make `evor_check_stop` return a blocked verdict with the gap attached, rather than letting the tick spin. A hook is the wrong consumer — hooks fire per tool call and cannot see the run's step state. A human is the wrong *primary* consumer, but should be the escalation when the orchestrator cannot satisfy the request.

---

## 6. Is the unit of authority wrong? — **Yes. Tools are the wrong noun; operations are the right one.**

Evidence that the tool is the wrong unit:

1. **`Write` denied, `Bash` granted, writes happen anyway.** 21 events, 6 roles (§3). The denylist names a tool; the intent was an *operation* ("do not author files"); `Bash` satisfies the operation while evading the name.
2. **The guard already works at the operation level, and it held.** `hooks/pre-tool-use.mjs:276` — `[EVOR GUARD] Direct write to an evor state file is not allowed. Use evor_write_artifact(agent="…")` — is **path-scoped**, fires regardless of tool, and stopped Mutagen's `Write` cleanly at both 08:55:42 and 00:18:34. It is the one authority expression in the system that did its job every time. The repo therefore already contains the better model; `disallowedTools` is the legacy one sitting next to it.
3. **`general-purpose` launders every restriction.** `PARENT` is keyed on `evor-*` names (`:111-117`), so a spawn of `general-purpose` is unregulated — and that agent inherits Write, Edit, and the full MCP surface. Six such spawns occurred and none were logged. Authority attached to *who you are* is defeated by *who you can create*. Authority attached to *what operation touches what path* is not.
4. **The `name` rule proves the mismatch from the other side.** The governor denies `name` (`:100-108`) to preserve hook matching and model tiering — both good reasons — but `name` is also how you get a `SendMessage`-addressable peer. 19 of 26 denials are this rule. Roles are not trying to escalate; they are trying to obtain an addressable collaborator, and the only syntax for it is booby-trapped. The right fix is to make `subagent_type` addressable and stop overloading `name`, not to keep denying it 19 times a run.

**What changing the unit would change.** Replace `disallowedTools: Write, Edit` with an operation grant — `may: [read(repo), exec(scratch), write(artifact:{tick}/{role}/*)]`, `may-not: [write(.evor/**), write(eval-suites/**)]` — enforced in `pre-tool-use.mjs` against `(operation, path)` derived from the call, as the EVOR GUARD already does. Under that model:
- The 21 Bash-heredoc writes to `/tmp/scratchpad` become **legal and honest** (they are scratch compute, which reviewers genuinely need) instead of quiet denylist evasions.
- `/tmp/selector_verdict.json` and `/tmp/sage_findings.json` become **denied**, because they are deliverables outside the artifact path — which is what the design actually meant.
- A `general-purpose` spawn inherits the *spawner's* operation set instead of a fresh unrestricted one, closing the laundering hole without needing to enumerate every non-evor agent type.
- `critic_approved` moves out of `MutationProposal` and into the critic's write scope, so the field cannot be authored by the role that is not entitled to the verdict.

---

## 7. Ranked gaps

| # | gap | class | evidence | fix |
|---|---|---|---|---|
| 1 | Bare `evor_*` `ToolSearch` names do not resolve; the skill teaches the bare form | **DF** | 58/97 agents; `SKILL.md:25,227-229,232` | alias bare→prefixed in ToolSearch, and fix SKILL.md |
| 2 | `capability-gap` has no signal kind and no consumer; tick's honest report was inert | **AG** | `signals.jsonl` line 3; zero consumers of `integrity-violation` in source | add kind + consume in `evor_check_stop` |
| 3 | Authority is a tool denylist; `Bash` defeats it | **AG** | 21 events / 6 roles | operation+path grants, as EVOR GUARD already does |
| 4 | `general-purpose` spawns are unregulated and inherit everything | **AG** | `PARENT` `:111-117`; 6 spawns | inherit spawner's operation set |
| 5 | No artifact-dependency wait; tick burned 4 noop spawns | **AG** | I-2..I-5; `Monitor` unused by tick | `evor_await_artifact(tick, agent, kind)` |
| 6 | `name` denial (19/26 denials) collides with `SendMessage` addressing | **AG** | `:100-108`; forge 31 SendMessage / 6 denials | address peers by `subagent_type` |
| 7 | `critic_approved` required on `MutationProposal`, authored by proposer, consumed by nobody | **DF** | `contracts.py:640`, `contracts.ts:279`; r3 `[True]*6` at 00:21:07 vs critic at 00:58:33 | move to critic's scope |
| 8 | `evor-tick` denied `Bash` but needs read-only globbing | **AG** | I-1, 08:54:29 | `evor_list_run_files` or Glob |

**Correct denials, unchanged:** forge-junior parentage (3 firings), `TaskStop` ownership, the EVOR GUARD direct-write block, and Mutagen's research-MCP gate. Do not loosen these.
