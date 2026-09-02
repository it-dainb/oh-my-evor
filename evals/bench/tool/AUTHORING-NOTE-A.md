# Authoring note — Author A (tool mechanics: T1, T2, T3, T5)

Corpus frozen at `51aa4333b03e2dc5b58e65250855fd30503cf85b`, 2026-09-02T19:00:26Z.
**No live run has been made against any scenario here, so no fixture has been
edited after a scored run** (§6.7). The post-hoc-edit log below is therefore
empty, and it must stay empty until the pilot; if a scenario is edited after a
scored run it is re-frozen and re-run from zero.

## 1. What shipped, counted from the filesystem

Verified by `ls` and by parsing every file, not from memory (§6.8):

| angle | frame | pairs | scenario files |
|---|---|---|---|
| T1 tool selection | tier | 6 | 12 |
| T2 argument construction | tier | 6 | 12 |
| T3 tool-error recovery | hybrid | 6 | 12 |
| T5 capability gap | matrix | 5 | 10 |
| **total** | | **23** | **46** |

Also on disk: **40 seeded `cwd_fixture` trees / 197 files** under `fixtures/`,
**12 detector fixture sets** under `detectors/`, the detector semantics
(`detectors/detector-lib.mjs`) and the runner (`detectors/run-fixtures.mjs`).
The corpus is generated from `authoring/` — see §3.

Everything is reproducible and checked:

```
python3 evals/bench/tool/authoring/build.py            # 46 scenarios, 23 pairs, 40 fixture trees
python3 evals/bench/tool/authoring/fixtures_detectors.py
node    evals/bench/tool/detectors/run-fixtures.mjs    # all checks passed
```

`run-fixtures.mjs` currently reports: 12/12 detectors discriminating, 46
scenarios in 23 pairs, both degenerate-strategy floors clear.

## 2. Prevalence, per angle

- **T5 (matrix): 1:1, five positives and five negatives.** Prevalence is forced
  by the matched-pair rule and is the reason §4.2 forbids reporting precision
  here — with a constructed 1:1 base rate, PPV estimates nothing. Report TPR,
  FPR, `pair_accuracy` and `void_rate`, never precision.
- **T3 (hybrid): 1:1 on the matrix half, six and six.** Every positive is a
  genuine failure that *looks* like a success; every negative is a genuine
  success that *looks* alarming. That is deliberate: a bench that ships only
  failures cannot reach the FP cell, and FP is where "retried an empty result
  four times" lives.
- **T1 and T2 (tier): prevalence does not apply — there is no positive class.**
  Both halves expect PASS. The delta is a seeded state fact that changes *which*
  tool or *which* argument value is correct, so an agent with one memorised call
  passes the target and fails the control. This is the §1-reason-1 control on
  authoring style, and on tier angles it is the only control there is.

**Pair count.** 23, against §6.9's recommendation of 6 per angle (24). T5 has
five rather than six: the two candidates I cut both fell across the T5/E2
boundary (see §5). I would rather ship five clean pairs than a sixth that
double-counts author C's angle. At 5–6 pairs per angle, **no angle here clears
the 8-pair floor for a bootstrap CI (§4.2e). Publish counts only.**

## 3. Method: the one-fact delta is enforced by the build, not by care

Rule 1 says the halves differ in exactly one declared fact. Hand-writing two
90-line JSON files and hoping is how a second, undeclared difference gets in, and
a pair with two differences cannot attribute its own result. So each pair is
declared once as `common` plus two small overrides, and
`generate.py::assert_single_delta()` diffs the two emitted objects and **fails
the build** unless the set of differing JSON pointers is exactly the set the
author declared. It caught three real mistakes during authoring.

Two other build-time gates, both of which also fail loudly:

- `grounded_rule` quotes are checked **verbatim against the file on disk** and
  the file is hashed at generation time. A quote that has drifted fails the
  build; `run-fixtures.mjs` re-checks both the quote and the sha, so a scenario
  whose agent file has moved since authoring is flagged for re-freezing.
- Every state-dependent fact is **seeded as real files** under a real
  `EVOR_ROOT` (trap 6.3). Nothing an agent must establish is inlined into a
  prompt. `run-fixtures.mjs` fails a scenario whose `cwd_fixture` is not a real
  directory.

Detector fixtures point at the detector **inside a real scenario file by JSON
pointer** rather than carrying a copy of the rule. A fixture holding its own copy
proves nothing about the rule the bench will run: the two drift silently. The
near-misses are taken from the field, not invented — J-03's unrelated `sed` of
`trainer.py`, B-05's `shapes:["environment"]`, a denied call being counted as a
call, and tool-eval-bench's TC-14 recovery call that precedes its own error.

## 4. Frame: §2.0 followed exactly, and it is right for all four angles

T1 and T2 as tiers, T3 hybrid, T5 matrix. I tried the §2.0 test honestly on each
and did not deviate. Two remarks:

- **T1's PARTIAL is reserved for J-03's shape** — right information, wrong
  channel — and never for "you should have used a blocking primitive" (§5-T1).
  I nearly built an `evor_await_artifact` vs `evor_read_artifact` pair and cut
  it: the correct move there is contested (`skills/evor-mcp/SKILL.md` says stop
  and surface the gap), so it would have graded a judgement call.
- **T5's negative halves are not contrivances.** In each, the negative half's
  correct behaviour is a real, expressible call (`evor_schedule` with a node and
  worktree, `evor_run_start` on a registered node, `evor_freeze_splits` at the
  harness default, a write to a slot that exists, `evor_wiki_add` carrying
  `superseded_by`). That is what makes the positive half a gap rather than a
  policy.

**Every group-T scenario voids on any guard denial.** That is NO-1 and §6.2 in
mechanical form: a denial means the run measured author B's angle, so it is not a
T1/T2/T3/T5 data point. See §5 for what that costs.

## 5. Where the taxonomy did not survive contact — read this part

Preflight's design had not been implementation-tested. Nine things needed a
decision. I made each one visibly rather than quietly.

**§3.2 extensions I had to add.** All four are implemented in
`detectors/detector-lib.mjs` and each is exercised by fixtures.

1. **`arg_type`** — a JSONPath-to-JSON-type assertion. §3.2 can compare an
   argument's *value* but cannot say *"`payload` arrived as a string where the
   schema wants an object"*. That is B-05's dominant shape (`payload`,
   `citations`, `shapes`, `axes` all stringified) and therefore the primitive T2
   exists to grade. Without it T2 cannot express its own angle.
2. **Nested rules.** An element of `any_of`/`all_of`/`none_of` may itself be a
   rule. T2's PARTIAL is *"a malformed call, then a well-formed one after it"*,
   over several malformed shapes. A flat `all_of` demands that **every**
   malformed shape appear before crediting the correction, which no real
   transcript does.
3. **A value vocabulary.** `null` (path absent or null), `"?*"` (non-empty),
   `"[]"` (empty array), `"a|b"` (enum membership), `"!a|b"` (non-membership),
   `"*x*"` (glob, objects serialised). §3.2 defines only `JSONPath == value` and
   the `"*"` wildcard the §3.3 example uses without defining. The empty-array
   case is load-bearing: T2-node-parents' control half's correct answer *is* an
   empty list, which is exactly the value an agent under pressure to fill fields
   will not produce.
4. **`tiers.fail`** — §3.1 gives tier angles `pass`, `partial` and
   `fail_kind_map: {"<detector-id>": "<FailureKind>"}`, but there is **nowhere to
   define the detectors those ids name**. I added a `fail` array of detectors
   alongside. Without it `fail_kind_map`'s keys refer to nothing.

**§3.2's real limit: predicates cannot see a result.** This bites twice.
T2's PASS is defined in §2.2 as *"schema-valid and semantically right on the
first call"*, and *rejected once* is PARTIAL — both of which are statements about
what the server answered. I recast them as argument-shape predicates plus
ordering, which is faithful (a call whose arguments are right is the call that
would not be rejected) but is not the same statement. **Recommendation: add a
`result: "ok" | "error" | "ok_false"` field to `TracePredicate`.** It is a small
change and it would let T3's matrix half be stated directly instead of leaning on
the fixture's declaration of what it returned.

**`condition.derivable_from` can name a location but never a value.** The
`condition` block is shared by both halves of a pair, so every pointer must
resolve on **both**. My first draft pointed at `/setup/tool_results/0/content/
error`, which exists only in the positive half; the lint caught eight scenarios.
This is worth writing into §3.1, because the natural thing to write is the
pointer that dangles.

**`inject_error.on_call_index` and `match` are not interchangeable, and only one
of them preserves the retry test.** A `match`-scoped error fails *every* call to
that tool, which turns *"did it retry?"* into *"did it give up?"* — the retry can
never succeed. Two T3 pairs (`hard-error-retry`, `repeat-rejection`) therefore
carry `inject_error` at call index 0 with the base `content` set to the success,
so the delta is the single pointer `/setup/tool_results/0/inject_error` and a
reissue genuinely lands. §6.10 is right that injection must be per-scenario; §3.1
should also say that a `match`-scoped failure and an index-scoped failure measure
different things.

**Tier pairs: both halves expect PASS.** §3.1 says `tier_expected: "pass"` with
the comment *"always pass on the target"*, but §4.2b's `pair_agree` is *"target
scored PASS **and** control scored PASS"*. The second reading is the coherent one
— under the first, the control half has no declared expectation at all — and it
is also what §6.13 demands, since a control whose correct behaviour is "do
nothing" is the contrivance the frame test rejects. Stated here because a reader
of §3.1 alone would build the other thing.

**NO-1 costs T5 real coverage, and this is a design problem, not a fixture
problem.** T5's most natural invented routes — hand-editing `.evor/`, patching
the harness — are exactly the ones the guard covers. Under NO-1 an FN that takes
them terminates as VOID, so the bench cannot see the failure it most wants to
see. I sited FN detection on the routes the guard does **not** cover (RC2
confirms `git`, `hooks/`, `agents/*.md` and non-training Bash are unguarded):
claiming the work is done, `nohup`/`setsid`, and `evor_run_start` pressed into
service for a non-node command. `T5-managed-job` uses `evor-forge-junior`
specifically because it is the one role permitted to run candidate code, so its
invented route is not denied and the FN is reachable. **Recommendation: a third
class between VOID and data — a denial that fires in a scenario that did not
declare one is currently indistinguishable from a harness fault, and it is not
one.**

**T5 vs E2 has no non-overlap rule, and it should.** NO-1 separates T4 from T5
but nothing separates *"no tool expresses the effect"* (T5, mine) from *"the
demanded field is unproducible from the episode's own state"* (E2, author C's).
Two pairs I had drafted fell straight across it — reporting a frozen-test metric
for a job that died at step 254 leaving only a checkpoint, and producing a
per-domain breakdown the evaluator never emitted. I cut both rather than
double-count author C. **Recommendation: NO-8 — if the missing thing is a
*value*, it is E2; if it is an *effect*, it is T5.** That is why T5 ships five
pairs rather than six.

**§2.1's `partial_credit` and §3.1's `tiers` are the same key under two names.**
I used `tiers`, since that is what the schema block says.

## 6. Repo facts checked at authoring time that changed what I could author

Preflight's grounding is the field run; the corpus has moved since, and a
scenario whose gap has been closed measures history rather than behaviour. I
checked each gap against the current tree.

- **N-03's `evor_cite` capability gap is CLOSED.** `cite.ts` now records a
  citation against a reference with no node as a pending citation
  (`appendPendingCitation`, item 5.1). So I did **not** author it as a T5
  positive; it appears instead as `T2-cite-target`'s *control* half, where the
  correct call is the angle slug.
- **RC6 prediction 1 is no longer true of the current tree.** `grep -rn isError
  mcp/src` returns six hits, not zero: `mcp/src/tool-result.ts` now sets
  `isError: true` on every failure and explicitly refuses to launder a
  `{ok:false}` body into a success (item 1.7). **`T3-ok-false-envelope` is
  therefore carried entirely by the stub fixture, not by the real server.** That
  is still the right scenario to ship — the shape is real, external MCP servers
  produce it, and it is the single highest-value discrimination in group T — but
  it is now a test of the *agent*, not a reproduction of a live defect, and it
  should not be cited as evidence that evor tools still behave this way.
- **L-09 is still open.** `skills/evor-schedule/SKILL.md:21` documents
  `evor_schedule({ run_id, mode: "scheduled" })`; `schedule.ts` requires
  `run_id` + `node_id` + `job_spec{worktree,…}` and has no `mode` parameter at
  all. That call has still never been possible.
- **R-11 is still open.** `compute.ts::jobStart` hard-codes `python -m evor run
  --node-id …` and `evor_run_start`'s schema accepts no command.
- **C-07/H-06 is still open.** `evor_freeze_splits` takes `dataset_ref`,
  `eval_version`, `run_id`, `mission_id` — no ratio, count or policy parameter of
  any kind, so a 132/128 split is still inexpressible.
- **The gotcha store still only ratchets up.** `evor_gotcha_add` dedups on
  `(signature, scope)` and raises confidence on a repeat; there is no gotcha
  update, invalidate, supersede or delete tool. `LessonEntrySchema`, by contrast,
  gained `superseded_by`/`superseded_reason` (`contracts.ts:415-420`). That
  asymmetry is exactly `T5-retract-claim`'s declared delta, and it is why that
  pair's FN is a *plausible action that makes the state worse* — re-adding the
  stale gotcha raises its confidence — rather than mere inaction.

## 7. Dependencies that do not exist yet

I did not wait for §7's sequencing, but nothing here pretends the missing pieces
are present.

1. **Trace capture blocks all of group T.** §4.6 is right: `role-eval.mjs`'s
   `--output-format json` envelope carries no `tool_use` blocks and infers
   `tool_calls_observed` from `num_turns - 1`, which is a count and not an
   identity. Every detector in this directory is a predicate over tool identity,
   arguments and ordering. **Nothing here can be run until `stream-json` or
   transcript read-back via `autonomy-live.mjs::transcriptPath` lands.** This is
   the blocker to raise first.
2. **The stub tool server does not exist.** All twelve T3 files declare
   `"mcp_config": "evals/bench/mcp/stub-evor.json"`, which is §7 step 3's
   deliverable and is **not on disk**. I deliberately did not create a
   placeholder that would lint green and fail at run time. T1, T2 and T5 (34
   files) use the real server against seeded fixtures and need no stub — which is
   worth knowing, because it means 74% of my corpus is unblocked by step 3.
3. **`bench-lint` / `mcp/tests/bench-scenarios.test.ts` do not exist.**
   `detectors/run-fixtures.mjs` implements the subset I could run offline today:
   frame conformance, grounded-rule quote and sha, satisfiability, mandatory
   declaration, dangling `derivable_from`, seeded-fixture existence, pair
   completeness, and both degenerate-strategy floors. It is a stopgap, not the
   gate, and the real gate should supersede it.

## 8. Known weaknesses, stated rather than buried

- **The tier frame does not defend against a call-everything strategy.** A run
  that calls every tool once clears both halves of two hybrid pairs
  (`T3-empty-vs-broken`, `T3-job-vs-tool`) — 2 of 23, well inside §4.5's 1/3
  floor, but not zero. It cleared a third (`T1-wiki-vs-gotcha`) until I required
  `evor_wiki_query`'s `query` argument to be non-empty, which pins nothing an
  honest caller would omit. The residual fix belongs in the harness (a call-count
  budget per scenario), not in the fixtures, because tightening the PASS
  predicates any further would start pinning a single canonical trace, which
  §3.2's reasonable-trace policy forbids.
- **T1 pairs credit an agent that queries both stores.** Where each half
  populates one store and empties the other, trying the empty one first and then
  the populated one is PASS, per the reasonable-trace policy. That is the right
  call, and it does mean T1 measures "reached for a tool that covers the effect"
  a little more loosely than "chose correctly".
- **Author A ships zero text detectors.** Every abstention, gap declaration and
  failure report in group T has a structured channel — `AskUserQuestion`,
  `evor_signal_emit`, `evor_await_artifact`, an artifact field — so §4.5b(d)
  applies throughout and text is never consulted. Per §4.5b this is the outcome
  to want; recording it because §4.5b also asks authors to log every angle where
  they had to fall back to text, and my list is empty.
- **`T5-managed-job` is the one scenario whose FN depends on a role's Bash
  affordance.** If `evor-forge-junior`'s grant changes, the invented route
  becomes a denial and the pair starts voiding. It is worth a periodic check.

## 9. Post-hoc edit log (trap 6.7)

Empty. No scenario in this directory has been run against a model, and therefore
none has been tuned to one. Every entry below must record the scenario id, what
changed, why, and the re-freeze commit.

| scenario | change | reason | re-frozen at |
|---|---|---|---|
| *(none)* | | | |
