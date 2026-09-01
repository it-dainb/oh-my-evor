# RED — category 6, knowledge lifecycle

TDD red phase for the lane N findings. **No source file was modified.** Two test
files were added:

- `mcp/tests/wave1-knowledge-lifecycle.test.ts` — 10 tests, **8 RED**, 2 green
- `harness/tests/test_wave1_knowledge_lifecycle.py` — 10 tests, **10 RED**

Re-run:

```
cd mcp     && npx vitest run tests/wave1-knowledge-lifecycle.test.ts --reporter=verbose
cd harness && python -m pytest tests/test_wave1_knowledge_lifecycle.py -q
```

Every failure below is an assertion failure, not an import, fixture or typo
error. No `.skip`, no `.only`, no swallowed exceptions, no network access.

---

## N-03a — the citation mandate must be satisfiable by the role it binds

`mcp/tests/wave1-knowledge-lifecycle.test.ts`

| test | invariant |
|---|---|
| `accepts an angle slug when the run's tree is still empty` | a research role citing its own angle slug with an empty tree SUCCEEDS |
| `persists the pending citation so it is retrievable after the fact` | such citations accumulate durably rather than evaporating |

Status: **RED**

```
 × N-03a — evor_cite is satisfiable by the research role it is imposed on > accepts an angle slug when the run's tree is still empty
   → a sage-junior citing its own angle slug before any node exists must succeed — this is the exact shape of all 18 failed calls in the field run: expected false to be true // Object.is equality
 × N-03a — evor_cite is satisfiable by the research role it is imposed on > persists the pending citation so it is retrievable after the fact
   → expected false to be true // Object.is equality
```

**Conflict the GREEN phase must resolve.** `mcp/tests/cite.test.ts:123`
(`returns error when node not found in tree`) asserts the opposite for an
unknown **UUID**. Both can hold only if the fix distinguishes a pending
slug-shaped ref (accept, hold as pending) from a UUID that names nothing
(reject). If the implementer instead makes every unknown ref succeed, that
existing test must be revised deliberately, not deleted. Flagging rather than
touching it, per the red contract.

## N-03b — an embedded `ok:false` must set `is_error`

| test | invariant |
|---|---|
| `err() flags the result as an error, not just the JSON body` | the single shared failure helper sets `isError` on the envelope |
| `evor_cite returns isError when its payload says ok:false` | the payload flag and the envelope flag agree, whatever the tool decides |

Status: **RED**

```
 × N-03b — an embedded ok:false must set isError on the MCP envelope > err() flags the result as an error, not just the JSON body
   → err() is the single failure path for every evor_* tool; if it does not set isError the whole fleet reports failures as successes: expected undefined to be true
 × N-03b — an embedded ok:false must set isError on the MCP envelope > evor_cite returns isError when its payload says ok:false
   → payload ok=false but isError=undefined — a failure the caller reads as success: expected false to be true
```

`mcp/tests/tool-result-envelope.test.ts` was read first, as instructed. It pins
the **payload** shape (`{ok:false, error}`) by reading tool source text; it says
nothing about the **envelope**, which is the layer the agent runtime reads and
the layer that failed in the field. These two tests are therefore an extension
of that contract, not a duplicate — and the first one is behavioural
(`err("…")` is called), so it covers every tool routed through the helper rather
than `evor_cite` alone, which is the general contract the brief asked for.
`evor_cite` is asserted separately because it does **not** route through `err()`
on the not-found path: it hand-rolls its own envelope at `cite.ts:66-76`.

## N-02 — refuted / superseded wiki knowledge

| test | invariant | status |
|---|---|---|
| `re-adding the same lesson_id with a corrected verdict replaces the entry` | verdict is revisable in place | **ALREADY-GREEN** |
| `the lesson contract can record that an entry was superseded and by what` | `LessonEntry` carries a supersede/refuted-by marker | **RED** |
| `a superseded entry is not returned as a confirmed lesson` | `confirmed_only` retrieval excludes superseded entries | **RED** |

```
 ✓ N-02 > re-adding the same lesson_id with a corrected verdict replaces the entry
 × N-02 > the lesson contract can record that an entry was superseded and by what
   → LessonEntry has no supersede marker (fields: lesson_id, node_id, run_id, mission_id, approach_family, hypothesis_verdict, observation, root_cause, actionable_lesson, citations, telemetry_evidence, tags, created_at) — a claim refuted by measurement can only be silently overwritten or left standing: expected false to be true
 × N-02 > a superseded entry is not returned as a confirmed lesson
   → confirmed_only must not surface an entry that has been superseded — this entry was cited 23 times across the tree after being falsified: expected [ { …(11) } ] to deeply equal []
```

The already-green row is a real result: `wikiAdd`'s exact-`lesson_id` dedup does
replace in place, so the mechanism to change `confirmed` → `refuted` exists and
works. What is missing is (a) any way to say *why* and *by what evidence*, and
(b) any retrieval-time consequence. The field entry was never rewritten because
nothing in the loop was obliged to; both RED tests target that obligation.

## N-01 / N-04 — a self-asserted `urls_verified` is not verification

TypeScript side (stub resolver, **no network**):

| test | invariant | status |
|---|---|---|
| `wikiAdd runs every citation through an injected resolver` | a resolution step is invoked between finding and persist | **RED** |
| `an entry whose citation resolves to an unrelated paper is not stored as verified` | wikiAdd reports per-citation resolution status | **RED** |

```
 × N-01/N-04 > wikiAdd runs every citation through an injected resolver
   → wikiAdd persisted a citation without ever resolving it — the only check on citation identity is the junior's own urls_verified flag: expected 0 to be greater than 0
 × N-01/N-04 > an entry whose citation resolves to an unrelated paper is not stored as verified
   → wikiAdd must report per-citation resolution status; a misattributed citation that writes silently is indistinguishable from a verified one: expected undefined not to be undefined
```

Python side:

```
E  AssertionError: CitationBackedFinding has no server-filled citation-verification field (fields: ['applicable_families', 'confidence', 'evidence', 'finding', 'implementation_spec', 'junior_sources', 'key_hyperparams', 'libraries', 'quorum_met', 'sota_bar', 'source_url', 'sources', 'title', 'trust_level']) — the only signal of citation integrity in the whole pipeline is the junior's own urls_verified flag, and 3 of 20 sampled citations were misattributed
E  Failed: CitationBackedFinding silently accepted and discarded a self-asserted urls_verified=True. An agent-authored verification claim must be rejected outright, not swallowed — this is the only 'check' that stood between a junior finding and evor_wiki_add
```

Note the second one is worse than the lane recorded: `urls_verified` is not in
the contract **at all**. `agents/evor-sage-junior.md:181` instructs the junior to
emit it, pydantic ignores unknown keys, so the flag is dropped on the floor. The
agent believes it declared verification; nothing anywhere records the claim, let
alone checks it.

## N-06 — stale gotcha with demonstrated cost

`harness/tests/test_wave1_knowledge_lifecycle.py`, all **RED**. Fixture is the
real r1 entry (`cpu-4k-latency-gate-requires-lt-3kmac-per-pixel`, confidence 1.0).

| test | invariant |
|---|---|
| `test_entry_contract_can_express_supersession` | `GotchaEntry` can represent "invalidated" |
| `test_store_exposes_a_supersede_path` | `GotchaStore` has a supersede/invalidate method |
| `test_superseded_gotcha_is_not_returned_unflagged` | retrieval flags or omits a superseded entry |
| `test_contradicting_evidence_lowers_confidence` | recorded contradiction moves confidence DOWN |

```
E  AssertionError: GotchaEntry has no supersession marker (fields: ['avoidance', 'confidence', 'context', 'first_seen', 'gotcha_id', 'kind', 'last_seen', 'occurrences', 'resolution', 'scope', 'signature']) — confidence 1.0 is terminal, so a gotcha encoding a gate that a later contract relaxed 10x stays authoritative forever
E  AssertionError: GotchaStore has no supersede/invalidate method — add_gotcha only ever ratchets occurrences and confidence UP. The r3 contract relaxed the gate this gotcha encodes (0.1s -> 1s CPU, 10ms -> 500ms GPU) and nothing in the store could record that
E  AssertionError: no supersede path exists, so a retrieval-time flag cannot exist either — see test_store_exposes_a_supersede_path
E  AssertionError: GotchaStore has no way to record a contradiction. add_gotcha halves the gap to 1.0 on every repeat, so confidence is monotonically increasing and a fact measured to be wrong twice keeps its 1.0
```

Confirmed against source: `harness/evor/gotchas.py:126` computes
`new_conf = min(1.0, old.confidence + (1.0 - old.confidence) * 0.4)` on every
repeat and there is no other writer of `confidence` in the module. Monotonic by
construction.

The four tests name specific APIs (`supersede_gotcha`, `record_contradiction`).
Those names are a proposal, not a requirement — the invariant is the behaviour.
Renaming them in GREEN is fine; deleting the behaviour is not.

## N-08 — mission scope chosen by whim

| test | invariant | status |
|---|---|---|
| `test_a_deterministic_scope_rule_exists` | scope follows a rule exported by `evor.gotchas` | **RED** |
| `test_the_rule_is_stable_for_equivalent_facts` | two equivalent hardware constraints get the same scope | **RED** |

```
E  AssertionError: evor.gotchas exports no scope-selection rule; scope is a free parameter with a default, so the same agent scoped equivalent facts 'mission' and 'global' within ~4 minutes and the mission-scoped five were lost at the r1 -> r2 boundary
E  AssertionError: no scope rule to test — see test_a_deterministic_scope_rule_exists
```

**Partly a prompt concern, and worth saying so.** The code-side fact is real and
testable: `mcp/src/tools/gotcha.ts:315` declares
`scope: z.enum(["global","mission"]).default("global")` and passes it straight
through to `GotchaStore._path_for_scope`. Nothing derives, validates or reviews
the choice — so the observed inconsistency is *permitted* by code even though it
was *committed* by an agent. The tests assert the missing rule. If the GREEN
implementer decides the rule belongs in the tick prompt rather than in
`gotchas.py`, that is a defensible call, and these two tests should then be
replaced by a prompt assertion rather than made to pass with a stub.

## N-09 — the wiki-resolution short-circuit

| test | invariant | status |
|---|---|---|
| `the full-scope branch still excludes angles the wiki already resolved` | wiki-resolved angles are never re-researched, at any wildness | **ALREADY-GREEN** |

```
 ✓ N-09 > the full-scope branch still excludes angles the wiki already resolved
```

This is a genuine already-green, and it changes the reading of the finding. The
P1-8 gate in `skills/evor/SKILL.md:213` **already** instructs that wiki-resolved
angle IDs are passed as "already handled" in the Sage spawn prompt, in both
branches — the `Task(...)` template carries
`wiki-resolved angle IDs already handled: [<ids>]` unconditionally. So the 4-of-8
re-research in r3 was **prompt non-adherence, not a missing rule**: the gate said
skip them and Sage researched them anyway.

A second test asserting that `wildness >= 0.7` should stop forcing full scope was
written and then **deliberately withdrawn**: it contradicts
`mcp/tests/sage-gate.test.ts`, which pins the wildness escape hatch as intended
design (widening the hypothesis space on high-exploration proposals). Forcing
full scope is not the defect; re-asking answered questions is, and the prompt
already forbids that. The remaining question — has wildness ever been below 0.7
in a real mission — is an artifact question, not a code invariant.

## N-10 — the confidence floor hides unresolved defects

| test | invariant | status |
|---|---|---|
| `test_unresolved_gotcha_survives_the_min_confidence_floor` (2 params) | an unresolved gotcha is exempt from `min_confidence` | **RED** |

```
E  AssertionError: an UNRESOLVED gotcha was filtered out by min_confidence=0.8 — this is the exact retrieval that hid a live test-leakage defect from all five r3 agents
E  assert 'private-dataloader-test-leakage-iir-binnet-01' in []
```

Parametrised over both shapes an unresolved entry takes in the field: an empty
`resolution`, and the prose form (`"Not yet resolved — audit data/builder.py…"`).
The prose form implies the GREEN fix needs a structural signal for "unresolved"
rather than string-matching the resolution text; that is a design decision for
the implementer, and both parametrisations must end green.

---

## Not attempted

- **N-05, N-07, N-11, N-12, N-13** were outside the assigned finding list.
  N-05 (`evor_wiki_add` accepts an empty `lesson_id` and writes `<wiki_root>/.md`,
  overwriting the previous empty-id lesson) is straightforwardly testable and is
  the most valuable of the five; it belongs to whichever lane owns it.
- No production file was touched. `git status` for this lane shows exactly three
  new files: the two test files and this report.

---

# Live, MCP-attached red tests (additive)

The tests above are unit-level. They prove the error paths; they do not prove
the defect. `addCitation()` returning ok:false for a bad ref is the tool working
as written. The defect is that a REAL sage-junior, on its REAL prompt, with the
REAL server attached, calls `evor_cite` in the only state its role ever runs in —
angle slug, empty tree — and is told the call succeeded.

New files:

- `ci/knowledge-live-eval.mjs` — fixture, prompts, live CLI call, stream analysis
- `mcp/tests/wave1-knowledge-live-eval.test.ts` — the wrapper, gated

**Why this needed a new runner.** Every existing role eval detaches the tools and
inlines the results as text: `ci/eval-core.mjs:182` tells the model "do not call
any tool; reason from them directly", and `ci/agent-eval.mjs:371` says "no MCP
tools are available here". That is the right design for grading judgement and it
is exactly why the tier corpus contains no `tool_use` block (README category 7).
The prompts and the `extractAgentPromptBlock` plumbing are reused; only the
attachment and the stream analysis are new.

**Gating.** `EVOR_LIVE_EVAL=1`, via `describe.runIf` — not `.skip`. Gate off, the
live blocks do not execute; gate on, they must fail loudly. `runLive()` throws on
a CLI error, an unparseable stream, or a missing result event, and each block
asserts the tier it actually ran on. An unreachable model is an error, never a
pass. Each block also asserts the scenario was exercised at all (the agent
reached for the tool) so an inconclusive run fails rather than passing silently.

**Secrets.** Only the `evor` server is attached, under `--strict-mcp-config`. The
research MCPs (semantic-scholar, arxiv, hf-mcp) are the keyed ones and are
deliberately absent; the literature is supplied in the prompt instead. No
credential is read, printed, or written by any of this. Per the brief, the
citation-validation assertion checks that a resolution step was INVOKED — it
never resolves a DOI over the network.

## Run of record

```
npm --prefix mcp run build
cd mcp && EVOR_LIVE_EVAL=1 npx vitest run tests/wave1-knowledge-live-eval.test.ts \
  --reporter=verbose --testTimeout=700000
```

| scenario | model id | n | turns | cost | wall |
|---|---|---|---|---|---|
| sage-junior / cite | `claude-sonnet-5` (declared tier) | 1 | 12 | $0.4880 | 93.5 s |
| selector / gotcha | `claude-haiku-4-5` (declared tier) | 1 | 7 | $0.0434 | 49.4 s |

n = 1 per scenario in the run of record; four further exploratory runs were made
while building the fixture (~$1.20 total across all runs). **n=1 is enough for a
red and not enough for a green**: the two RED results below are deterministic
consequences of the tool contract, but the one green behavioural result is a
single sample and is reported as such.

## Results

```
 ✓ N-03 LIVE > ran on its declared tier
 ✓ N-03 LIVE > the role actually reached for evor_cite
 × N-03 LIVE > N-03a — every attempted citation lands (field ratio was 0 of 18)
   → 0 of 2 citations landed. Errors: ["node 'genuine-iir-mechanisms' not found in this run's tree — check the name with evor_tree_read.","node 'genuine-iir-mechanisms' not found in this run's tree — check the name with evor_tree_read."]: expected +0 to be 2
 × N-03 LIVE > N-03b — no failure is delivered inside a success envelope
   → 2 call(s) returned ok:false with is_error:false — the agent was told a failure had succeeded, which is why none of the 18 field calls was retried: expected 2 to be +0
 × N-03 LIVE > N-01/N-04 — a citation persisted by the run carries a verification record
   → no citation record carries any resolution/verification field — nothing sat between the junior's finding and the store, which is how CBAM was credited to an RL paper
 ✓ N-06 LIVE > ran on its declared tier
 × N-06 LIVE > the store served the stale gotcha with a staleness marker
   → the store served a confidence-1.0 gotcha encoding a retired contract gate with nothing marking it stale — this is the payload five r3 agents received verbatim
 ✓ N-06 LIVE > neither proposal is rejected for lacking a kMAC/px estimate
```

The raw tool result, captured from the stream:

```json
{"run_id":"run-live-01","node_id":"genuine-iir-mechanisms",
 "citation":"doi:10.1109/ACCESS.2026.3681411 — IIR-BinNet…",
 "ok":false,
 "error":"node 'genuine-iir-mechanisms' not found in this run's tree — check the name with evor_tree_read."}
```
delivered with `is_error: false`. That is the field signature exactly, produced
by a live sonnet sage-junior on the first attempt, twice in one run.

## What the live runs changed about the findings

**The field ratio reproduces: 0 of 2 landed, both silent.** No sage-junior
behaviour is required for this; the role cites its angle slug because that is
the only identifier it has, and the tool resolves against a tree that its own
position in the tick guarantees is empty.

**One nuance the lane could not see.** Asked to report its own tally, the live
junior answered `{"cite_calls_made": 2, "cite_calls_that_succeeded": 0}` and
wrote: *"I won't fabricate a node ID or force a fake success."* The model reads
the embedded `ok:false` perfectly well when something asks it to look. What the
`is_error:false` envelope removes is the RUNTIME's retry signal, not the model's
comprehension. That sharpens the fix: setting `isError` matters because it is
what the harness acts on.

**N-06 did not reproduce as a selection error, and that is a real result.** With
a well-formed proposal pair — distinct families, distinct parents, quantified
predictions, the `evals/selector/cases.json` "clean-2" shape — a live haiku
selector queried the store, read the confidence-1.0 kMAC/px gotcha, and approved
both proposals anyway, explicitly scoring Gotcha Avoidance as *"no matches
(data-only, not kMAC/px)"*. Three separate runs, same outcome. So the r3 harm was
not "the gotcha alone forces a rejection". The invariant that does fire live is
the store-level one: the payload is served with nothing marking it stale.

## Two fixture defects found and fixed while building this

Both would have produced a false red, and are recorded because the failure mode
is the interesting part:

1. The seeded `tree.json` omitted `updated_at`, which `TreeFileSchema`
   (`mcp/src/tree-store.ts:15`) requires. `readTree` threw "tree.json is
   corrupt", the CLI surfaced that as `is_error: true`, and the run showed 0/2
   landed for the WRONG reason — while N-03b passed, because a thrown error does
   set `isError`. A red on the right count via the wrong mechanism.
2. The seeded gotcha's id was `gotcha-stale-latency-01`. The staleness-marker
   assertion greps the served payload for `/stale|superseded|…/` and matched the
   fixture's own id, turning a genuine red green. The id is now
   `gotcha-7f3c1a9e4b02`, the shape `gotchas.py::_gotcha_id` actually produces.

Both were caught by reading the raw tool results rather than the pass/fail
column. A live test whose fixture is wrong fails for a reason that looks right.
