# T7 — Tier and benchmark validity (RED phase)

Category 7 of the wave-1 field trace. Tests live in
`mcp/tests/wave1-tier-benchmark.test.ts`. Nothing outside that file was touched;
no `agents/*.md`, `mcp/src/**`, `ci/**` or `benchmarks/**` change was made.

Re-run: `npx vitest run mcp/tests/wave1-tier-benchmark.test.ts`

Result: **33 tests, 18 failing, 15 passing.** Every failure is on its assertion.

This category is mostly about *what the benchmarks could not see*, and several
findings are model behaviours that no unit test can settle. Those are marked
NOT-TESTABLE with the evidence that would settle them, rather than being turned
into a test that implies certainty the evidence does not support.

---

## Summary

| finding | test | status |
|---|---|---|
| P-04 (prompt) | `P-04 — a role-eval prompt may not mandate a tool call it also forbids` | **RED** (8/8 specs) |
| P-04 (meta) | `P-04 — the report records whether MCP tools were attached` | **RED** |
| S3 / N-07 (prefix spelling in the repo) | `S3/N-07 — … names it identically` | ALREADY-GREEN |
| S3 / N-07 (haiku mis-transcription) | — | NOT-TESTABLE |
| `evor-acquirer` unmeasured retier | `every declared role has eval coverage` | ALREADY-GREEN for acquirer; **RED for `evor-tick`** |
| D — model / effort frontmatter | `mcp/tests/agent-frontmatter.test.ts` | ALREADY-GREEN (70/70) |
| D — spec arms vs shipped tier | `D — the eval specs measure the tier the role actually ships on` | **RED** (7/8) |
| D — doc vs shipped tier | `D — the benchmark document describes the tiers that shipped` | **RED** (4 roles) |
| D — one forge-junior on opus; `evor-tick.md` edited mid-run | — | NOT-TESTABLE |
| P-04 / S3 live | `T7 live tool-name eval` (`EVOR_LIVE_EVAL=1`) | **RAN, 6/6 PASS** — malformed prefix **not observed at n=15/arm**, not refuted (see addendum) |

---

## P-04 — the corpus graded tool-using roles on toolless runs

**Invariant.** A role-eval prompt must not simultaneously order the agent to
call an MCP tool and forbid all tool calls. The two legitimate states are: the
MCP server is attached and the call is graded, or the mandate is explicitly
neutralised — which `ci/agent-eval.mjs`'s `buildCasePrompt` actually does for
selector ("Gates H002 and Gotcha Avoidance require live state/tool access that
this harness does not provide. Score both `pass` unconditionally"). The generic
`ci/eval-core.mjs` path does neither: it pastes the agent file's `<Agent_Prompt>`
verbatim, then appends *"do not call any tool; reason from them directly."*

All 8 `evals/*/spec.json` roles fail:

```
 × P-04 — a role-eval prompt may not mandate a tool call it also forbids > 'acquirer'
AssertionError: the prompt orders the agent to call [evor_check_leakage, evor_read_goal_contract,
evor_signal_emit, evor_store_blob, evor_write_artifact] and then forbids all tool calls. Whatever
those calls would have returned is graded from the payload instead, so this arm measures the
prompt, not the role.: expected true to be false // Object.is equality

 × … > 'mutagen'
AssertionError: the prompt orders the agent to call [evor_capability, evor_check_plateau,
evor_gotcha_query, evor_read_artifact, evor_signal_query, evor_state_read, evor_state_write,
evor_tree_read, evor_wiki_query, evor_write_artifact] and then forbids all tool calls. …

 × … > 'forge-analyst'   [evor_capability, evor_signal_emit, evor_write_artifact]
 × … > 'forge-architect' [evor_write_artifact]
 × … > 'forge-critic'    [evor_lock_evaluate, evor_signal_emit, evor_write_artifact]
 × … > 'probe'           [evor_read_handoff, evor_record_eval, evor_signal_emit, evor_state_write,
                          evor_write_artifact]
 × … > 'sage'            [evor_cite, evor_read_artifact, evor_read_handoff, evor_signal_emit,
                          evor_wiki_query, evor_write_artifact]
 × … > 'sage-junior'     [evor_signal_emit, evor_wiki_query, evor_write_artifact]
```

`mutagen` and `forge-analyst` are the sharpest cases: `evor_capability()` and
`evor_gotcha_query(...)` are the exact calls the README names, and both roles'
contracts grade fields whose real-world input is those calls' return values.

**Note on scope.** This test asserts the *prompt* is not self-contradictory. It
does not, and cannot from here, assert that a tool was invoked in a live run —
that requires reading the run envelope, which `ci/role-eval.mjs` discards. The
second test below is the piece that would make a live run's tool basis auditable.

### P-04 meta — the report does not record whether tools were attached

**Invariant.** The report artifact a tier claim is read from must record whether
MCP tools were attached for the runs it summarises, so a future claim cannot be
made from a toolless corpus without that being visible.

```
 × P-04 — the report records whether MCP tools were attached > buildReport stamps the
   tool-availability basis of the run
AssertionError: buildReport() emitted no `mcp_tools_attached` field, so a report produced without
an MCP server is indistinguishable from one produced with it. keys: role, generated_at,
pricing_basis, tiers, baseline, comparisons: expected false to be true
```

The field name `mcp_tools_attached` is this test's choice; any equivalent stamp
would satisfy the invariant and the test should be adjusted to whatever the fix
adopts. Note `buildReport` already stamps `pricing_basis` for exactly this
reason — the tool basis is the same class of provenance and is missing.

---

## S3 / N-07 — the malformed haiku MCP prefix

Three haiku agents (`evor-probe`, `evor-sage`, `evor-selector`) emitted
`mcp__plugin_oh-my_evor_evor__…` — underscore where the canonical name has a
hyphen. No sonnet or opus agent did.

**Testable half — ALREADY-GREEN.** Every source in the repo that names the
prefix names it the same way:

```
 ✓ S3/N-07 — every source that names the MCP prefix names it identically > scans a non-empty set
   of sources
 ✓ S3/N-07 — every source that names the MCP prefix names it identically > uses
   `mcp__plugin_oh-my-evor_<server>__` and no other spelling
```

Scanned: `agents/`, `skills/`, `hooks/`, `commands/`, `mcp/src/`, `harness/evor/`,
`ci/*.mjs`, with the server segment validated against `.mcp.json`'s declared
servers. All occurrences — concentrated in `hooks/` plus one in
`skills/evor-mcp/SKILL.md` — are hyphenated. There is no doc or prompt anywhere showing a mis-transcribable form,
so hypothesis (b) from the brief is refuted: the models did not copy a bad
spelling out of the repo. The test stands as a regression guard.

The prefix is nevertheless *hardcoded in ten places* rather than defined once
(most of them in `hooks/`, as string literals and inline regexes). No test
asserts single-definition, because that would require a production refactor to
satisfy and the consistency check catches the failure the refactor would prevent.

**NOT-TESTABLE half.** Whether haiku is more likely than sonnet/opus to
mis-transcribe an MCP tool name is a property of the model, not of this repo. No
unit test can establish it, and a test that appeared to would be fabricated
evidence.

*What would settle it:* a paired A/B with the MCP server actually attached,
same prompts, haiku vs sonnet arms, counting malformed tool names per call.
Lane P's cross-check is directionally consistent but rests on 3 positives against
a negative set drawn from **one** other session. For a base rate around 3 in 17 haiku
agents, distinguishing it from zero at 80% power needs on the order of
n ≥ 60 tool-emitting calls per arm — comparable to the n=120 mutagen top-up that
was needed to call an exact tie. The current evidence supports "worth measuring",
not "confirmed".

---

## `evor-acquirer` — retiered to haiku, never spawned

Offline coverage is the only part a test can hold; whether a role was spawned in
a particular live run is not a repo invariant.

**Invariant.** Every role declared in `agents/*.md` has at least one eval spec or
case file.

`evor-acquirer` passes — `evals/acquirer/spec.json` exists, and
`docs/retier-benchmark-results.md` records it at 36/36 vs 36/36. Its retier is
unmeasured *in the field*, not unmeasured offline. The test found a different
role with no coverage at all:

```
 × every declared role has eval coverage > evor-tick
AssertionError: no evals/tick/spec.json and no evals/tick/cases.json — this role's tier is
asserted, never measured: expected false to be true
 ✓ (the other 11 roles pass)
```

This matches lane D: `evor-tick` shipped new on sonnet, was never benchmarked,
took the largest wall-clock share of any role in the run, and was the single
worst schema offender at 5 hits from 5 agents.

*What would settle acquirer's field retier:* a run in which the acquirer path is
actually exercised. Nothing in the repo can substitute for that.

---

## D — tier conformance

### Frontmatter — ALREADY-GREEN

`mcp/tests/agent-frontmatter.test.ts` already asserts every agent declares a
model from `{opus, sonnet, haiku}`, that `effort` is absent for haiku roles and
present-and-valid otherwise, and that the description's `(Opus)`/`(Haiku)` tag
matches. Verified: `70 passed (70)`. Confirmed as the brief asked — an inert
`effort:` on a haiku role does fail that suite. No duplicate written.

### Spec arms vs the shipped tier — RED (7 of 8)

**Invariant.** The arm each spec labels `current` must be the model the shipped
agent file declares. A spec whose `current` arm is not the shipped model
measures a retier that did not happen; re-running it costs real money to produce
a number about a configuration no agent runs.

```
 ✓ D — the eval specs measure the tier the role actually ships on > 'acquirer'
 × … > 'forge-analyst'
AssertionError: evals/forge-analyst/spec.json calls `sonnet` the current arm, but
agents/evor-forge-analyst.md ships `opus`: expected 'sonnet' to be 'opus'
 × … > 'forge-architect'  spec `sonnet`, ships `opus`
 × … > 'forge-critic'     spec `sonnet`, ships `opus`
 × … > 'mutagen'          spec `sonnet`, ships `haiku`
 × … > 'probe'            spec `sonnet`, ships `haiku`
 × … > 'sage'             spec `sonnet`, ships `haiku`
 × … > 'sage-junior'      spec `haiku`,  ships `sonnet`
```

The drift is in both directions, which is what makes it a defect rather than a
lag: three specs are *behind* the retier (mutagen/probe/sage went to haiku), four
are *ahead* of a revert (`aace945` put forge-analyst, forge-architect,
forge-critic back on opus and sage-junior back on sonnet). Half the specs would
re-measure the pre-retier tier as if it were current.

### Documented results vs the shipped tier — RED (4 roles)

**Invariant.** The closing tier table in `docs/retier-benchmark-results.md` — the
document the retier claim rests on — must name the tier each agent file actually
declares.

```
 ✓ D — the benchmark document describes the tiers that shipped > states a final tier for at
   least one role
 × D — the benchmark document describes the tiers that shipped > matches every agent file it names
AssertionError: docs/retier-benchmark-results.md is the evidence the retier rests on; where it
disagrees with the shipped frontmatter, one of the two is describing a build that does not exist:
expected [ …(4) ] to deeply equal []

- Array []
+ Array [
+   "evor-forge-critic: doc says haiku, agents/evor-forge-critic.md declares opus",
+   "evor-sage-junior: doc says haiku, agents/evor-sage-junior.md declares sonnet",
+   "evor-forge-analyst: doc says sonnet, agents/evor-forge-analyst.md declares opus",
+   "evor-forge-architect: doc says sonnet, agents/evor-forge-architect.md declares opus",
+ ]
```

The doc's "Adopted" and "Where the branch ends up" sections were not updated when
`aace945` ("ship only the tier changes that clear both angles") reverted five
roles to their `main` tier. The doc still claims "Six of the eight roles now run
haiku"; four do. It also omits `evor-selector`, which *did* ship to haiku.
Reading a cost saving off that table gives a number for a build that was never
released — the same class of error the doc itself
warns about two sections earlier, where every pre-repricing $/pass figure turned
out to be on modeled rather than billed dollars.

### One `evor-forge-junior` on opus; `evor-tick.md` edited mid-run — NOT-TESTABLE

Both are properties of one 19-hour run, not of the repo. The runtime tier check
`checkTierMatch` in `ci/agent-eval.mjs` already throws on a wrong tier in the
eval path (`ci/role-eval.mjs`: "FAIL LOUDLY. A wrong tier silently measuring the
baseline twice is worse than not measuring at all"), and the eval harness is not
what spawned the deviant agent — the Task tool was, and its tier selection is
outside this repo.

*What would settle the mid-run-edit confound:* the run's report would need to
record the agent-file hash per spawn. `ci/role-eval.mjs` already does exactly
this for eval runs (`report.fingerprint.agent_sha256`); the live spawn path does
not, and adding it is a production change, so it is reported here rather than
tested.

---

## Not written, and why

- **No test claims a model-behaviour result.** The haiku prefix correlation is
  directionally confirmed and underpowered; the tests here assert repo
  invariants only.
- **No test asserts the prefix is defined in exactly one place.** That is a
  refactor request, not a defect the evidence shows caused harm.
- **No test asserts a live run invoked a tool.** `ci/role-eval.mjs` discards the
  CLI envelope's tool records; making that assertable requires a production
  change to the harness, which the RED contract forbids.

---

# ADDENDUM — the live eval, with MCP actually attached

`mcp/tests/wave1-tier-live-eval.test.ts`. This is the instrument v1.2.0's tier
corpus did not have. It was **run for real**; the numbers below are from that run,
and the raw records are in `docs/field-trace-v1.2.0/red/T7-live-eval-raw.json`.

```
EVOR_LIVE_EVAL=1 npx vitest run mcp/tests/wave1-tier-live-eval.test.ts \
  --testTimeout=3600000 --hookTimeout=3600000 --reporter=verbose
```

Gate off (`EVOR_LIVE_EVAL` unset) the suite does not run — a cost gate, not a
`.skip` of a deterministic failure. Gate on, every failure is loud and an
unreachable model is an error, not a pass.

## Design

The `--mcp-config` server key is `plugin_oh-my-evor_evor`, so the wire prefix the
model sees is **`mcp__plugin_oh-my-evor_evor__`** — byte-for-byte the production
string the three haiku agents mangled. A shorter key would have made the harness
structurally unable to express the defect, which is the same mistake the offline
corpus made one level up.

Roles: `evor-probe`, `evor-sage`, `evor-selector` — the three where the malformed
prefix appeared, all haiku-declared, all signal-emitting. Arms: haiku (declared
tier) and sonnet (control). The prompt is each role's own `<Agent_Prompt>` block
plus a short task naming the **bare** tool the agent file mandates
(`evor_capability`, `evor_wiki_query`, `evor_gotcha_query`, `evor_signal_emit`) —
bare, because that is how the agent files spell it; constructing the `mcp__…__`
wire name from the tool listing is the step under test.

One paired matrix, 5 repeats × 3 roles × 2 arms, interleaved in a single queue.
The only variable between arms is `--model`. No agent file was edited.

## Result — 30/30 calls, 6/6 assertions pass

```
 ✓ every call completed — an unreachable model is an error, not a pass
 ✓ the evor MCP server was attached to every call
 ✓ haiku: every call actually invoked a mandated evor tool
 ✓ sonnet: every call actually invoked a mandated evor tool
 ✓ haiku: every emitted evor tool name carries the canonical prefix
 ✓ sonnet: every emitted evor tool name carries the canonical prefix

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  155.65s
```

| arm | model id | n calls | ok | calls with ≥1 evor tool call | evor tool calls | malformed names | cost (billed) |
|---|---|---|---|---|---|---|---|
| haiku | `claude-haiku-4-5` | 15 | 15 | 15 | 30 | **0** | $0.4915 |
| sonnet | `claude-sonnet-5` | 15 | 15 | 15 | 33 | **0** | $1.4953 |

Tool names emitted across all 30 calls (63 evor calls total, plus discovery):

```
mcp__plugin_oh-my-evor_evor__evor_gotcha_query   22
mcp__plugin_oh-my-evor_evor__evor_capability     20
mcp__plugin_oh-my-evor_evor__evor_signal_emit    11
mcp__plugin_oh-my-evor_evor__evor_wiki_query     10
ToolSearch                                       32
Bash                                             12
```

## What this does and does not establish

**Establishes.** The instrument works and the corpus is no longer structurally
blind: with the server attached, 63 real `tool_use` blocks were produced and
every emitted name was checked against the canonical prefix. Any future
occurrence of `mcp__plugin_oh-my_evor_evor__…` now fails a benchmark instead of
surfacing in a 19-hour production run. It also confirms the P-04 mechanism is a
harness property, not a model one: the same three roles that emitted zero tool
calls in the entire offline corpus emitted a tool call on **15 of 15** live calls
per arm. The offline corpus's silence was the prompt's doing.

**Does NOT establish.** The malformed prefix was **not observed at n=15 per arm**.
That is not evidence it is absent. At lane D's observed base rate — 3 of 17 haiku
agents, 0.176 — **P(zero malformed | n=15) = 0.054**. A one-in-eighteen chance of
seeing nothing by luck is not a refutation, and this run must not be cited as
one. The harness prints that probability in its own failure message for exactly
this reason.

*What would settle it:* the same paired matrix at n ≥ 60 tool-emitting calls per
arm (`EVOR_LIVE_EVAL_REPEATS=20`), which drops P(zero | 0.176) below 0.0001 and
would also give a usable interval on the difference between arms. At the observed
$0.033/call haiku and $0.100/call sonnet that is roughly $8 of API spend; this
n=15 matrix took 156 s wall at concurrency 5, so n=60 is about 10 minutes. That is the cheapest unanswered
question in this whole category.

## Fidelity gaps in the live harness, stated plainly

1. **Frontmatter tool restrictions are not applied.** `evor-probe`, `evor-sage`
   and `evor-selector` all declare `disallowedTools: Write, Edit`, and the run
   used `--permission-mode bypassPermissions`; 12 `Bash` calls were emitted
   across the matrix. The runs are therefore slightly *more* permissive than
   production, which if anything makes a malformed name easier to produce, not
   harder — but it is not an exact reproduction of the spawn shape.
2. **Sessions are single-role, not nested.** Production spawns these as
   subagents under `evor-tick`; this harness runs each as a top-level `-p`
   session. Tool discovery here went through `ToolSearch` (32 calls), matching
   lane D's note about discovery burden, but the context is shorter than a real
   subagent's.
3. **No accuracy is scored.** This harness grades *tool-call well-formedness and
   occurrence only*. It is deliberately not a retier measurement and must not be
   quoted as one; the cost column above is one task's price, not a $/pass.
4. **The user's global hooks fired during the run** (visible as `system` hook
   frames in the stream). They did not block any evor tool call, but the runs are
   not hermetic.

## Bottom line for the tier claim

Every accuracy number in `docs/retier-benchmark-results.md` was measured on
agents that could not call a tool. This addendum does not repair those numbers —
it builds the instrument that could. Combined with the RED findings above (7 of 8
specs pointing at the wrong tier, 4 doc rows describing a build that was never
released), **the honest status of v1.2.0's tier claim is unverified**, and the
live harness is what a re-verification would run.
