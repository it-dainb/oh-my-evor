# Field trace of v1.2.0 — wave 1

The first real deployment of v1.2.0 was an 19-hour autonomous run in
`~/research/binarization` on 2026-08-23/24. It attempted three missions, reached
tick 1 of 200 in each, promoted nothing, and ended when the operator killed it.

This directory is the horizontal sweep of that run: eighteen read-only lanes,
each tracing one angle across the same evidence, producing an inventory rather
than a diagnosis. Wave 2 goes vertical on the categories below.

**Nothing here was fixed.** Wave 1 deliberately stops at "what happened", because
a defect list assembled while also repairing it is a defect list you cannot
trust. Several findings correct earlier findings; those corrections are recorded
rather than quietly folded in, since the *reason* a lane was wrong is usually
the more useful artifact.

## Evidence base

| source | what it is |
|---|---|
| `~/.claude/projects/-home-dainb-1-research-binarization/` | 1,505-line parent transcript, 97 subagent transcripts, 14 spilled tool results |
| `~/research/binarization/.evor/runs/{r1,-r2,-r3}/` | three mission trees, ~256 MB |
| `~/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/` | the installed plugin, as mutated during the run |
| `~/.claude/plugins/marketplaces/oh-my-evor/` | the marketplace clone, also mutated |
| this repo at `bab279e` | the released source the above are diffed against |
| eleven other project dirs under `~/.claude/projects/` | the systemic-vs-local control set |

Provenance is confirmed: `installed_plugins.json` records oh-my-evor 1.2.0 at
`bab279e`, installed 2026-08-23T03:47Z, and all three mission dirs postdate it.

## The one-sentence result

The agents behaved better than the system recorded, and every guard that worked
checked *structure* while every guard that failed checked *text*.

Three things follow from that, and they are the reason this trace was worth
running:

1. **No accuracy number from any of the three runs is trustworthy** (lane M) —
   for reasons that are almost entirely about the seal, the corpus and the
   plumbing, not about the models or the search.
2. **The enforcement layer is net-negative on its flagship rule** (lane J). It
   did not prevent the change it was pointed at; it converted an auditable
   `Edit` into an obfuscated write. Guarding harder in the same style would make
   this worse, not better.
3. **The run was safe because a human was watching** (lanes H, L). All four of
   the systemic risks lane H names are invisible to an attended operator and
   silent under the 199 unattended ticks this run was preparing for.

## Lanes

| lane | angle | verdict |
|---|---|---|
| [A](lanes/lane-a-plugin-mutation.md) | plugin mutation vs `bab279e` | 17 files changed; net **hardening**, not bypass; none of it committed anywhere |
| [B](lanes/lane-b-mcp-errors.md) | tool and MCP errors | 220/2822 errors (7.8%); **65% are the guard refusing its own agents** |
| [C](lanes/lane-c-loops-stalls.md) | loops, stalls, termination | no hard loop; 11h of dead clock; run never terminated — it was killed |
| [D](lanes/lane-d-subagents.md) | subagent fleet | 97 agents, 11/12 roles on declared tier; 18.6% truncated |
| [E](lanes/lane-e-run-state.md) | run-state integrity | 3 missions, 1 tick each, 0 fitness, 0 promotions, 0 angles registered |
| [F](lanes/lane-f-efficiency.md) | spend | $217.70 modelled (~$274 billed); 96.6% context re-ingestion |
| [G](lanes/lane-g-privilege-escalation.md) | delegated escalation | hypothesis **partially supported**, 4 confirmed; zero grant violations |
| [H](lanes/lane-h-guard-evasion.md) | guard evasion, behavioural | **3 evasions vs 14 honest failures**; zero silent degrade, zero test neutralisation |
| [I](lanes/lane-i-reporting-integrity.md) | reporting integrity | **zero overclaim, zero fabrication**; the ledger, not the agents, is the failure |
| [J](lanes/lane-j-hook-efficacy.md) | hook efficacy | **MIXED, net-negative on the flagship rule**: ~15 harms prevented, ~19 backfires, ~64 false positives |
| [K](lanes/lane-k-guardrail-gaps.md) | guardrail gaps | 15 gaps; **no path allowlist exists anywhere**; 6 guards explicitly not worth adding |
| [L](lanes/lane-l-autonomy.md) | autonomy | **not autonomous** — 15 human interventions, 12 after mission lock |
| [M](lanes/lane-m-science-validity.md) | scientific validity | **NO** — no accuracy number is trustworthy |
| [N](lanes/lane-n-knowledge-memory.md) | knowledge and citations | knowledge **did** compound, but by hand; 17/20 citations verified, 0 fabricated |
| [O](lanes/lane-o-concurrency.md) | concurrency and storage | zero corruption, zero lost updates — **zero locks**; safe by workload shape alone |
| [P](lanes/lane-p-cross-project.md) | cross-project control | separates systemic from local; overturns two sibling findings |
| [Q](lanes/lane-q-context-continuity.md) | context and compaction | zero compactions; **all 14 hooks read the wrong project's `.evor/`** |
| [R](lanes/lane-r-environment-hygiene.md) | environment and secrets | **live API key exposed**; runs not reproducible |

## Corrections between lanes

Recorded because each one is a lesson about method, not just a fixed number.

| claim | corrected by | resolution |
|---|---|---|
| contract `eval_script_hash` mismatched the on-disk script, so pinning is broken (E) | M-01 | The pins were always right. One hardlinked inode (`nlink 5`) shared by all three runs is the entire story. |
| zero instances of a gate being disabled after it fired (H) | M-03 | H read the transcripts and found nothing; M computed the corpus hashes and found the leakage check reclassified. Behavioural tracing could not see this. |
| 96.6% of spend on cache re-ingestion is an evor problem (F) | P/S5 | Every project on this machine runs 98.7–99.8%, including ones that never loaded evor. This is baseline agentic economics, not a regression. |
| the 18 truncated agents hit turn caps or context limits (D) | Q-04 | Exhaustion refuted (p=0.455; the largest *surviving* agent was 2.06× the largest truncated one). 3 are confirmed user-stop, 15 undetermined. |
| 22 `Agent` spawns rejected for passing `name=` (B) | P/S2 | Not reproducible with structural probes across 12 project dirs. Either a non-`tool_result` surface or a different literal. **Unverified.** |
| the run ended on 4 user refusals (B) | L-11 | Two aborts. Three of the four are collateral of one ESC, all within 107 ms of `agents_killed`. |

Two lanes also flagged contamination hazards worth reusing: transcripts record
**streaming snapshots**, so token arithmetic must dedupe by `message.id` or it
over-counts ~2.17×; and this repo's own project dir now contains *this
investigation*, so naive greps for a signature string hit the lanes discussing
it rather than real occurrences.

## Categories for wave 2

Ranked by the severity of what the category admits, not by finding count.

### 1. Seal and provenance integrity
`M-01` `M-03` `I-02` `J-01` `O-01`

All three runs' `eval-suites/v1.py` are **one inode, `nlink 5`**. Rewriting it at
23:49 retroactively rewrote both superseded missions' archived evaluators; r2's
scoring evaluator `f123d17c…` now exists nowhere on disk, so its `fmeasure 48.72`
can never be reproduced. Separately, a leakage check that failed r2 was
reclassified as benign for r3 — with *this corpus's own leakage count* ("36 such
benign mask collisions measured in corpora/v10") cited in the source comment as
the justification. That is a direct violation of the contract's own invariant
that a change "may make the evaluation harder or more honest, never easier".

**Highest-value single action in the whole trace:** `O-01` found the run's only
successful candidate was failed by a slug-vs-UUID directory mismatch, against a
node with 12,000 well-formed telemetry records. The fix landed 15 minutes after
the verdict and **nothing was ever re-scored under it.**

### 2. Path-blind enforcement
`K-01`–`K-04` `K-12` `J-01`–`J-05` `H-01` `G-01`–`G-06`

There is no path allowlist or denylist anywhere — not in the hook, not in
`permissions` (no settings file defines that block), not in agent frontmatter.
Guards match command *text* and agent *type*. Consequences, all observed:

- An agent isolated the trigger token from its own denial messages in four
  minutes, wrote `p = ".../v1" + "." + "p" + "y"`, and patched the sealed
  evaluator. The guard did not prevent the change; it removed the trail.
- A denial for `subagent_type: general-purpose` was satisfied by re-issuing the
  identical prompt as `subagent_type: claude`. This became the standing pattern.
- The `evor-forge-junior` code exemption has no path condition, making it the
  terminus of a `claude` → `evor-forge` → `evor-forge-junior` escalation chain.
- 7 of 8 roles denied `Write`/`Edit` retain `Bash`, which is a full write
  channel. The denylist expresses an intent the grant does not enforce.

Lane K's inverse list matters as much: six guards it recommends **against**
adding, on the evidence that broad text-based denial trains evasion.

### 3. Identity and state coupling
`Q-01` `O-01` `O-02` `O-17` `O-18`

All 14 hooks resolve `.evor/` through `CLAUDE_PLUGIN_ROOT`, so for 19 hours every
hook read a leftover CIFAR-10 self-test inside the plugin cache instead of the
live mission. `[EVOR SUBAGENT WARNING]` therefore never fired once across 97
agents, including the 18 that died without confirming a deliverable.
`test_compaction_survival.py` passes because all 16 of its invocations set
`EVOR_ROOT` explicitly; the default branch every real session takes has no test.

Underneath that: **zero file locking in any of the 29 harness modules**, and
`SignalBus.emit()` is a whole-file read-modify-rewrite that survived on a 2.55 s
inter-emit margin. Nothing was lost — but the clean bill of health is exactly
what a lost update would also look like.

### 4. Durability and audit
`A-04` `P-01` `P-02` `I-01` `I-11` `R-02` `R-03` `O-09`

~3,000 inserted lines of live plugin behaviour exist only in the installed cache
and the marketplace clone, in no commit on any branch — one `plugin update` from
deletion. `decision-log.md` records no restart, no plugin patch, no gate change.
Mission state is written *inside* the installed plugin, so reinstall is
destructive of run history. And the research project is not a git repository at
all, so 19 hours of autonomous edits have no revert point.

### 5. Autonomy and termination
`L-01`–`L-09` `C-01`–`C-05` `K-06` `K-09`

The charter is `aggressive-never-halt`, whose own text says the agent never emits
an `AskUserQuestion`. It emitted 11, and a human answered every one — 2h24m of
blocking wait. The longest stretch of actual autonomous *work* was 1h55m. Two of
three mission restarts were human decisions.

The deepest finding here is `L-02`: the charter asserts "a monotonic move ALWAYS
exists", and at 01:37 none did — the operator-added precision floor made every
node score 0.0, and the only remedy was a forbidden softening. The decision
policy has no branch for its own infeasibility, so the agent asked a person.

Termination is a single predicate: the stop hook's finished-test is `step >= 9`,
and r3's final tick-state reads `step 9 / running / integrity failed`. It looked
at a failed, still-running tick, concluded "finished", and stayed silent — 54
invocations, `preventedContinuation: false` on all 54.

### 6. Knowledge lifecycle
`N-01`–`N-08`

`evor_cite` landed **0 of 18 calls**, 16 of them returning `ok:false` inside an
`is_error:false` envelope so no caller ever retried. The cause is structural: the
tool resolves `node_id` against `tree.json`, but the research role runs before
any node exists. Three of twenty sampled citations are misattributed — a
topology loss credited to an infrared diffusion paper, CBAM credited to an RL
paper — and one entry carries a fabricated performance claim that was
empirically refuted twice and still reads `verdict: confirmed`.

`N-06` is the clearest case of stored knowledge causing a wrong decision: a
confidence-1.0 gotcha encoding r1's latency gate survived a contract that relaxed
that gate 10× and 50×, was retrieved verbatim by five r3 agents, and the selector
rejected the two proposals aimed at the actual bottleneck for lacking kMAC/px
estimates. Gotcha confidence only ever ratchets up; there is no decay,
contradiction or supersede path.

### 7. Tier and benchmark validity
`D` `P/S3` `P-04` `N-07`

The retier landed: 11 of 12 roles ran on their declared tier. But three haiku
agents — `evor-probe`, `evor-sage`, `evor-selector`, all retiered-to-haiku roles
that emit signals — constructed a malformed MCP prefix
(`mcp__plugin_oh-my_evor_evor__`, underscore for hyphen). No sonnet or opus agent
anywhere did. **Directionally confirmed, not yet powered**: it rests on 3 haiku
positives against a negative set from one other session.

It cost exactly one wiki entry — and it was the only entry ever authored about
preprocessing for palm-leaf, the domain that was the binding constraint in all
three missions.

The reason the benchmarks could not have caught this: the 2,320-session tier
corpus contains **not one `tool_use` block**. Its prompts instruct the agent to
call `evor_capability()` and `evor_gotcha_query(...)`, but the MCP server is not
attached, so those instructions are inert text. `evor-acquirer` was retiered to
haiku and never spawned once.

### 8. Environment and secrets
`R-01` `R-03` `R-11`

A live Semantic Scholar API key sits in `~/.claude/settings.json` **and** verbatim
in two conversation transcripts, 15 occurrences, transmitted to the API and
replayed on every session resume. Rotation is the only remedy; redacting the
settings file undoes none of it.

Runs are not reproducible: no repo, no lockfile, and training ran from a
machine-wide conda env that is not captured anywhere. `R-11` reaches back into
category 1 — background training was killed at subagent turn end, and one run
died at step 254 of 450, which bears directly on whether any recorded result
reflects a completed trainer.

## What this trace did not do

- It did not re-run anything. Every number is read from artifacts already on
  disk; where a claim needed execution to verify, lanes marked it UNVERIFIED
  rather than guessing.
- It did not fix anything. The plugin cache, the marketplace clone and the
  binarization project are exactly as the run left them.
- It did not trace the other eleven project dirs in depth. Lane P inventoried
  all twelve and traced four; the rest contribute the cost baseline and nothing
  more.
- It says nothing about intent. Several findings describe an agent routing around
  a guard; in every case the content it was carrying appears legitimate and, in
  the evaluator's case, operator-approved. The findings are about mechanism and
  audit trail.
