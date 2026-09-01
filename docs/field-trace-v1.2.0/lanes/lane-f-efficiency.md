# Lane F — Efficiency & Wasted Spend (Wave 1 inventory)

Run: oh-my-evor v1.2.0 autonomous run, `/home/dainb_1/research/binarization`, 2026-08-23T07:10Z → 2026-08-24T02:20Z (19h10m wall).
Sources: parent `7fa9c902-…f7f41f.jsonl` (1505 lines) + 97 subagent transcripts + 14 spilled tool-result files.
Read-only analysis. All dollar figures are **MODELLED, not billed** — treat as a floor.

## 0. Method and caveats

**Dedup is mandatory.** The JSONL files record streaming snapshots: 2072 of 2639 distinct `message.id` values appear 2–10× within the same file (histogram: 2×:1269, 3×:679, 4×:86, ≥5×:38). Naive summation of every record with a `message.usage` yields **$472.44** — that is a **2.17× over-count**. All numbers below dedupe by `message.id`, keeping the record with the largest `output_tokens` (253 ids have a truncated partial plus a final). No `message.id` ever appears in two different files, so parent and subagent sums do not overlap.

**Pricing used** (Anthropic first-party list, per MTok, as of 2026-09-01):

| Model | input | output | cache write (1.25×in) | cache read (0.1×in) |
|---|---|---|---|---|
| `claude-opus-5` | $5.00 | $25.00 | $6.25 | $0.50 |
| `claude-sonnet-5` | $3.00 | $15.00 | $3.75 | $0.30 |
| `claude-haiku-4-5` | $1.00 | $5.00 | $1.25 | $0.10 |

All observed `cache_creation` was `ephemeral_5m` (5-minute TTL) — this matters enormously, see F-01.

**Three reasons this is a floor, not the bill:**
1. This project has a documented modelled-vs-billed gap of ~1.14× (haiku) to ~1.26× (sonnet/opus). Mix-weighted, expect **≈$274 billed**.
2. Sonnet 5 was on intro pricing ($2/$10) through 2026-08-31, which covers this run. At intro rates the sonnet line drops from $62.49 to $41.66 and the total to **$196.87**. I report the current-list figure as instructed; the intro figure is the better estimate of what was actually charged before the gap multiplier.
3. Web-search/fetch server-tool call fees and any thinking-token surcharge beyond `output_tokens` are not modelled.

---

## 1. Spend census

### 1.1 By model (deduped, whole run: parent + 97 subagents)

| Model | assistant turns | input | cache_create | cache_read | output | modelled $ | share |
|---|---:|---:|---:|---:|---:|---:|---:|
| `claude-opus-5` | 1,569 | 3,133 | 9,685,980 | 165,543,274 | 340,493 | **$151.84** | 69.7% |
| `claude-sonnet-5` | 796 | 1,592 | 10,932,945 | 67,695,521 | 78,592 | **$62.49** | 28.7% |
| `claude-haiku-4-5` | 274 | 2,463 | 1,397,354 | 14,458,763 | 34,903 | **$3.37** | 1.5% |
| **Total** | **2,639** | **7,188** | **22,016,279** | **247,697,558** | **453,988** | **$217.70** | 100% |

### 1.2 By cost component — the dominant fact of this run

| Component | tokens | modelled $ | share |
|---|---:|---:|---:|
| Cache **write** (context re-ingestion) | 22.0M | $107.6 | 49.4% |
| Cache **read** (context re-ingestion) | 247.7M | $102.5 | 47.1% |
| Output (actual produced work) | 0.454M | $7.5 | 3.4% |
| Uncached input | 0.007M | $0.05 | <0.1% |

**96.6% of spend bought context re-ingestion. 3.4% bought generated tokens.** The run read 247.7M cached tokens and wrote 22.0M — a 270M-token context bill to produce 454K tokens of output. Every finding below is a variation on this.

### 1.3 By agent role

| Agent type | agents | turns | output tok | modelled $ | share | model |
|---|---:|---:|---:|---:|---:|---|
| `evor-forge` | 8 | 458 | 43,750 | **$58.54** | 26.9% | opus-5 |
| `evor-forge-junior` | 11 | 450 | 32,510 | **$41.45** | 19.0% | sonnet-5 (397) + opus-5 (53) |
| **parent orchestrator** | 1 | 165 | 176,080 | **$26.62** | 12.2% | opus-5 |
| `claude` (generic) | 15 | 383 | 46,990 | $25.07 | 11.5% | opus-5 |
| `evor-tick` | 5 | 216 | 11,362 | $17.45 | 8.0% | sonnet-5 |
| `general-purpose` | 15 | 254 | 33,278 | $11.84 | 5.4% | opus/sonnet/haiku |
| `evor-sage-junior` | 12 | 177 | 40,236 | $10.27 | 4.7% | sonnet-5 |
| `evor-forge-critic` | 5 | 103 | 19,463 | $7.59 | 3.5% | opus-5 |
| `evor-forge-analyst` | 4 | 75 | 5,107 | $5.95 | 2.7% | opus-5 |
| `evor-forge-architect` | 5 | 70 | 8,366 | $5.76 | 2.6% | opus-5 |
| `workspace-scout` | 1 | 24 | 3,924 | $3.23 | 1.5% | opus-5 |
| `evor-sage` | 5 | 126 | 8,531 | $1.66 | 0.8% | haiku-4-5 |
| `evor-mutagen` | 5 | 70 | 9,651 | $0.79 | 0.4% | haiku-4-5 |
| `Explore` | 1 | 12 | 1,582 | $0.76 | 0.3% | opus-5 |
| `evor-selector` | 4 | 42 | 6,271 | $0.52 | 0.2% | haiku-4-5 |
| `evor-probe` | 1 | 14 | 6,887 | $0.20 | 0.1% | haiku-4-5 |

**The forge family dominates: `evor-forge` + `-junior` + `-critic` + `-analyst` + `-architect` = $119.29 = 54.8% of all spend** across 33 agents and 1,156 turns, for 109K output tokens. Implementation-and-review is where the money went. The whole sage/mutagen/selector/probe research-and-decision side (haiku) cost $3.17 combined — 1.5%.

Depth-3 agents (juniors spawned by forge, spawned by tick, spawned by parent) account for a large share; the deepest chain observed is `parent → evor-tick → evor-forge → evor-forge-junior`, and each level re-carries a full mission context.

### 1.4 By phase (mission restart)

Attributed by the dominant `binarization-worldmodel-min98-2026-08[-rN]` run-id string in each transcript.

| Phase | agents | modelled $ | share | mission-state outcome |
|---|---:|---:|---:|---|
| r1 (base) | 33 | **$82.59** | 37.9% | `status: failed`, `superseded_by: …-r3`, reason: *"sealed evaluator scored paper as ink (inverted GT polarity); baseline_value 59.61 was not …"* |
| r2 | 19 | **$65.11** | 29.9% | `status: failed`, `superseded_by: …-r3`, reason: *"latency gates did not match the contract; superseded by r3 with GPU<500ms and quantization"* |
| r3 | 21 | **$48.85** | 22.4% | `status: running`, `current_tick: 0`, `best_score: null` |
| none/infra | 25 | $21.14 | 9.7% | harness repair, disk reclaim, evaluator patching |

**All three runs end with `current_tick: 0` and `best_score: null`.** Not one tick was ever accepted.

Hourly spend (subagent start hour): 07h $8.45 · 08h $30.15 · 09h $93.49 · 10h $41.68 · 11h $101.19 · **[7-hour gap, 14:47–21:47]** · 23h $20.82 · 00h $84.86 · 01h $10.56 · 02h $25.37.

---

## 2. Waste categories

### F-01 — POLLING / CACHE-MISS-CHURN (the single worst item): $17.89

Agent `agent-afabf9d873f2987bf.jsonl`, type `evor-forge-junior`, description *"Run training to completion"*, sonnet-5, 59 turns, **$19.81 total**.

It issues the identical Bash command **36 times**:
```
cd …/.evor/worktrees/iir-binnet-01 && EVOR_TELEMETRY_PATH=… python3 train/trainer.py --max-seconds 420
```
`--max-seconds 420` = **7 minutes**. The ephemeral prompt cache TTL is **5 minutes**. So every single poll landed after the cache expired. The per-turn usage trace is unambiguous — 38 consecutive turns from 12:00:26 to 23:07:15, ~7m12s apart:

```
12:00:26 cc=108598 cr=0 out=8
12:07:38 cc=109880 cr=0 out=6
12:14:49 cc=111181 cr=0 out=2
…
23:07:15 cc=156913 cr=0 out=2
```

`cache_read_input_tokens = 0` on all 38. The full ~108K→157K context was **re-written to cache from scratch 38 times**, for 2–8 output tokens each time. Cost of the 36 mid-agent cold turns: **$17.89** (90% of the agent's total). This is the most expensive subagent in the run, and its entire job was to wait.

Compounding: this agent also spans the 7-hour dead gap (14:46 → 21:47), so it was billing a full context re-cache every 7 minutes across a stall.

### F-02 — REWORK: $147.70 (67.8%)

r1 and r2 are both explicitly `status: failed` / `superseded_by: …-r3` in their own `mission-state.json`. Their combined spend of **$82.59 + $65.11 = $147.70** bought two runs that the system itself declared void. Neither failure was a modelling failure — both were **contract/harness defects discovered late**:
- r1: the sealed evaluator had inverted ground-truth polarity (scored paper as ink). ~15 hours of agent-hours' worth of forge work was measured against a broken oracle.
- r2: latency gates did not match the contract.

Both are pre-flight validation failures, i.e. this spend was avoidable by checking the evaluator and the gate spec **before** launching forge agents, not after.

### F-03 — CACHE-MISS-CHURN (beyond F-01): $36.39 total, 60 mid-agent cold turns (16.7%)

Separating unavoidable first-turn prefill (every subagent's turn 1 necessarily has `cache_read=0`; total **$7.02**, accepted cost) from mid-agent cold turns (`cache_read=0` with `cache_creation>20K` after turn 1 — a TTL expiry or a prefix invalidation):

| Agent | cold turns | $ churn | agent $ |
|---|---:|---:|---:|
| `evor-forge-junior` "Run training to completion" | 36 | $17.89 | $19.81 |
| `evor-forge` "Implement arch-iir-binnet" | 3 | $4.25 | $15.17 |
| **parent orchestrator** | 3 | $3.25 | $26.62 |
| `evor-tick` "Evor r2 tick 1" | 5 | $3.14 | $6.82 |
| `evor-forge` "Implement h001-iir-multidirectional" | 2 | $2.30 | $13.35 |
| `evor-tick` "Evor r3 tick 1" | 3 | $1.75 | $4.53 |
| `evor-forge-junior` "Implement IIR scan candidate" | 1 | $1.22 | $6.91 |
| `workspace-scout` | 2 | $1.06 | $3.23 |
| others (4 agents) | 5 | $1.53 | — |
| **Total** | **60** | **$36.39** | |

Parent churn spikes visible in the parent transcript: `2026-08-23T23:09:34` (cc=227,775, cr=0) and `2026-08-23T14:53:36` (cc=226,161, cr=0) — two full ~227K-token context rebuilds, $1.42 each. The 14:53 one sits inside the 7-hour dead gap; the whole hour 14h shows `cc=452,322 / cr=0` across 2 turns.

Parent aggregate cache health is otherwise good (cc/cr = 0.030). Sonnet subagents are the problem tier: cc/cr = **0.161** vs opus 0.059 — sonnet agents re-created 10.9M tokens of cache against only 67.7M reads.

### F-04 — CHATTY-TURNS: 2,159 of 2,639 turns (82%) produce <50 output tokens, costing $166.10 (76%)

Output-token histogram across all deduped turns:

| output tokens | turns | share |
|---|---:|---:|
| <10 | 1,784 | 68% |
| 10–49 | 375 | 14% |
| 50–199 | 90 | 3% |
| 200–999 | 255 | 10% |
| ≥1000 | 135 | 5% |

Two-thirds of every API call in this run generated **fewer than 10 output tokens** while dragging a 100–200K-token context. Worst offenders by ratio: `evor-forge` 398/458 tiny turns, `evor-forge-junior` 395/450, `evor-tick` 202/216, `claude` 327/383. The parent is the healthy exception (8/165 = 2% tiny; 176K output tokens, the largest single output producer in the run).

This is the mechanism behind §1.2: a tool-call-per-turn agent loop with a large context is billed almost entirely on context, not on work.

### F-05 — OVERSIZED-RESULT: 77 tool results >20K chars, 2.23M chars (~637K tokens) of the 7.04M-char (~2.01M-token) total result payload

The spill directory holds only 14 files / 708KB — a small share; the bulk of oversized results stayed inline. Deduped inline tool results total **7,038,188 chars ≈ 2.01M tokens**, i.e. the tool results alone account for roughly 0.8% of the 270M tokens re-ingested — but each large result is re-read on every subsequent turn of its agent, so a 12K-token result inside a 100-turn agent is paid for ~100 times.

Biggest single results:

| chars | ~tokens | source |
|---:|---:|---|
| 52,471 | 15K | `Read` of a `/tmp/…/tasks/*.output` task log |
| 46,709 | 13K | `Exa web_search_exa` — "synthetic degradation model palm leaf manuscript fiber texture…" |
| 44,948 | 13K | `semantic-scholar search_papers` — "ICFHR 2018 competition palm leaf manuscript binarization dataset…" |
| 43,177 ×3 | 12K ×3 | `Read` of `…/oh-my-evor/1.2.0/skills/evor/SKILL.md` (40,294B) — **the same skill file, read whole in three separate agents** |
| 42,171 | 12K | `Read` of `eval-suites/v1.py` (55,759B) |
| 41,581 | 12K | `semantic-scholar search_papers` — "AMADI_LontarSet dataset download ground truth binarization" |
| 38,476 | 11K | `arxiv download_paper` 1708.03276 |

MCP research tools (`semantic-scholar`, `Exa`, `arxiv`) dominate the top of the list: unfiltered search results dumped whole into context. The two `arxiv download_paper` spills (76,612B and 57,119B) are stored **twice each** in the spill dir under both a hashed and an MCP-named filename (2 of 14 files are exact md5 duplicates) — a storage duplicate, not a token duplicate.

Also notable: a 40KB `SKILL.md` re-read in full by three agents, and re-carried in each of their contexts for their entire lifetime. Across the forge family alone this is on the order of 12K tokens × ~450 turns of re-ingestion.

### F-06 — REDUNDANT-READ: 30 redundant `Read` calls (~164K tokens) + ~417KB re-`cat`ed via Bash

`Read` tool: 73 calls over 43 distinct paths → 30 reads beyond the first. Approx. 575,675 bytes re-ingested (~164K tokens at 3.5 B/token).

| reads | size | path |
|---:|---:|---|
| 7× | 24,911B | `.evor/worktrees/iir-binnet-01/train/trainer.py` |
| 5× | 6,702B | `.evor/worktrees/iir-binnet-01/data/builder.py` |
| 5× | 10,068B | `.evor/worktrees/iir-binnet-01/model/backbone.py` |
| 4× | 35,806B | `.evor/worktrees/multiscale-stroke-gate-01/evaluate.py` |
| 3× | 40,294B | `oh-my-evor/1.2.0/skills/evor/SKILL.md` |
| 3× | 55,759B | `eval-suites/v1.py` |
| 2× | 23,851B | `binarization/CLAUDE.md` |

Bash-side re-reads (`cat`/`head`/`sed -n` of the same absolute path) add ~417KB, led by 5× `hooks/pre-tool-use.mjs` (29,618B), 4× `datasets/prepared.py` (18,607B), 3× `worktrees/iir-binnet-01/evaluate.py` (55,759B).

Exact-duplicate Bash commands: 59 repeat calls beyond first over 1,372 unique commands (1,431 total) — 36 of those 59 are the F-01 poll. Absent F-01 this category is small.

This is the **smallest** waste category by dollars. Redundant reads are not this run's problem; context re-ingestion of a *static* context is.

### F-07 — MODEL-MISMATCH: ~$21–23 of expensive models on zero-reasoning work

- **F-01's polling agent runs on sonnet-5** ($19.81). Waiting for a subprocess needs no model at all — a `Monitor`/`until` loop or a background task would cost $0. This is the largest mismatch in the run.
- **`workspace-scout` runs on opus-5**: $3.23 / 24 turns for *"Map .evor state and models dir"*, a `ls`/`find`/`cat` task. 23 of its 24 turns produce <50 output tokens. On haiku the same traversal is ≈$0.65 — an ~$2.6 overpay.
- **15 generic `claude` agents all on opus-5** ($25.07) doing harness repair (*"Harden integrity gate"* $7.87, *"Fix telemetry_sane false negative"* $4.74, *"Patch tick boundary self-resume"* $3.94, *"Link evaluator into new run dir"* $0.28). Several are mechanical patch-and-verify jobs; `"Link evaluator into new run dir"` on opus for 5 turns is a symlink.
- **`Explore` on opus-5** ($0.76 for 12 turns) — search agent on the top tier.
- No evidence of the reverse pattern (cheap model failing repeatedly and being retried expensively). The haiku tier (`sage`, `mutagen`, `selector`, `probe`) completed its work for $3.17 total with no observed retry escalation.

Tool-call profile for context: Bash 1,431 · ToolSearch 295 · `evor_read_artifact` 126 · Agent 124 · `evor_write_artifact` 89 · SendMessage 77 · Read 73 · Edit 61. **295 ToolSearch calls** is a notable secondary signal — deferred-tool schema fetching happened ~11× per 100 turns, though the 30 turns that issued them cost only $1.49.

---

## 3. Headline

**Total modelled cost: $217.70** (list pricing, deduped). This is a **floor**:
- ×1.26 modelled-vs-billed gap for the opus/sonnet-dominated mix → **≈$274 likely billed**.
- Counter-adjustment: Sonnet 5 intro pricing was live on the run dates; at $2/$10 the modelled total is $196.87.

**Waste fraction — the arithmetic:**

*Conservative (explicitly discarded work only):*
```
r1 spend (mission-state: status=failed, superseded)   $ 82.59
r2 spend (mission-state: status=failed, superseded)   $ 65.11
                                                      -------
discarded                                             $147.70
                                                      / $217.70  =  67.8%
```

*Adding pure-overhead spend inside the surviving r3 + infra lanes (non-overlapping with the above — F-01 and most cold-cache churn sit inside r2/r3 but are counted once, in whichever bucket):*
```
mid-agent cold-cache churn outside r1/r2   ≈ $  8.0   (r3 tick agents, parent, forge h001)
                                             -------
conservative waste + overhead              ≈ $155.7  =  71.5%
```

*Strict, per the brief's definition ("spend on work that was discarded, redone, or produced no accepted artifact"):*
```
all three runs end at current_tick = 0, best_score = null
no candidate was ever accepted; no tick ever completed
                                    waste  =  $217.70  =  100%
```

I report **≥68% as the defensible figure** and note that under the brief's literal definition the run has no accepted artifact at all, so the strict answer is 100%. The honest summary: **$218–274 bought two self-declared-failed runs, a third that never completed a tick, and 454K output tokens against 270M tokens of context re-ingestion.**

**Categories with zero hits:** none of the seven requested categories was empty. The weakest are REDUNDANT-READ (F-06, ~$1–2 equivalent, dwarfed by static-context re-ingestion) and the *reverse* half of MODEL-MISMATCH (no cheap-model-retry-escalation pattern found anywhere in the run).

---

## 4. Ranked findings

| ID | Sev | Category | Locus | Quantified | Description | Wave-2 question |
|---|---|---|---|---|---|---|
| F-02 | CRIT | REWORK | r1 + r2 `mission-state.json` | **$147.70 / 67.8%** | Two full runs self-declared `failed`+`superseded` — inverted evaluator GT polarity (r1), latency gates off-contract (r2) | Why is the sealed evaluator's polarity and the gate contract not validated before any forge agent is spawned? Is there a pre-flight gate at all? |
| F-01 | CRIT | POLLING + CACHE-MISS | `agent-afabf9d873f2987bf` (`forge-junior`, "Run training to completion") | **$17.89** over 36 turns; 90% of the agent | `--max-seconds 420` poll interval vs 5-min cache TTL ⇒ 38 consecutive turns with `cache_read=0`, ~130K cc each, 2–8 out tokens | Is the 420s chunk configurable/coupled to cache TTL? Why is a subprocess wait modelled as an LLM turn instead of `Monitor`/background? |
| F-04 | HIGH | CHATTY-TURNS | whole run | 2,159/2,639 turns (82%) <50 out tok = **$166.10 / 76%** | 68% of all API calls emit <10 output tokens while carrying 100–200K context; forge family worst | Can forge batch tool calls per turn, or is one-tool-per-turn forced by the agent contract? |
| F-03 | HIGH | CACHE-MISS-CHURN | 12 agents, 60 mid-agent cold turns | **$36.39 / 16.7%** ($7.02 first-turn prefill excluded as unavoidable) | TTL expiry + prefix invalidation; sonnet tier cc/cr=0.161 vs opus 0.059; parent rebuilds 227K context twice | What invalidates the prefix on `evor-tick` (5 cold turns in one agent)? Is 1h-TTL caching available/considered for long-lived agents? |
| F-07 | MED | MODEL-MISMATCH | polling agent (sonnet), `workspace-scout` (opus), 15 generic `claude` (opus) | **≈$21–23**; ~$2.6 on scout alone | Top-tier models on wait loops, directory traversal, and symlink creation | Is there any tier-routing policy for spawned agents, or does every `Agent` call inherit the parent's model? |
| F-05 | MED | OVERSIZED-RESULT | MCP research tools + whole-file `Read`s | 77 results >20K chars = 2.23M chars (~637K tok) of 7.04M total | Unfiltered `semantic-scholar`/`Exa`/`arxiv` dumps 12–15K tokens each; 40KB `SKILL.md` read whole in 3 agents; each is re-ingested every subsequent turn | Do the evor MCP research tools have any result-size cap or summarization step? Why is the full SKILL.md loaded per-agent rather than referenced? |
| F-06 | LOW | REDUNDANT-READ | `iir-binnet-01/train/trainer.py` 7×, `builder.py` 5×, `backbone.py` 5×, `evaluate.py` 4× | 30 redundant `Read`s ≈164K tok + ~417KB Bash re-`cat` | Same worktree files re-read across turns/agents; 59 exact-duplicate Bash commands (36 of them F-01) | Low priority — but why do sibling agents at the same spawn depth each re-read the same worktree files instead of sharing an artifact? |

### Secondary observations for wave 2
- **7-hour dead gap** 2026-08-23T14:47 → 21:47 with near-zero activity; the F-01 poller kept billing a full context re-cache every 7 minutes across part of it. (Lane C territory, but it has a direct dollar cost.)
- **295 ToolSearch calls** (~11 per 100 turns) — deferred-tool schema fetching is frequent; cheap now ($1.49) but it is also a cache-prefix mutator worth checking against F-03.
- **Spend concentration**: 5 agents account for $76.66 (35%) of the run; 33 forge-family agents account for $119.29 (55%).
- **Streaming-snapshot duplication in the transcripts (2.17×)** is a measurement hazard, not a spend hazard — but any other lane or tool computing cost from these files without deduping by `message.id` will report roughly double the truth.
