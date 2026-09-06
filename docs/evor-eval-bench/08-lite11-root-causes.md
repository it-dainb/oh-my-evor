# lite11 — the negative halves were measuring silence

**Run:** `ci/out/lite11`, 36 scenarios, 72 runs, $39.75.
**Reported F1: 64.3%**, down from lite10's 77.2%.

The drop is not a regression. This document is the trace that establishes what it
is instead, and it ends with a defect large enough that **every group-L number
published so far, positive and negative, must be withdrawn.**

Traced with `.omc/skills/agent-behaviour-trace.md`, whose layer ordering is used
throughout: harness/fixture → capability → skill/context → instruction conflict →
instruction gap → model behaviour.

---

## 0. The instrument was reporting zero voids over four dead runs

`ci/analyze-calibration.mjs` printed `VOID 0/72 (0.0%)`. Four runs had failed
before the model was reached.

`bench-run.mjs` writes harness failures as `status: "HARNESS_ERROR"`. Its own
saturation check (`bench-run.mjs:1272`) counts that status. The analyzer counted
only `status === "VOID"` with a `failure_kind`, so the two components disagreed
about the spelling of a void — in the direction that flatters coverage. §4.1 puts
void accounting first precisely so this cannot happen, and the file whose header
says so was the file that got it wrong.

True figure for lite11: **VOID 4/72 (5.6%), all harness — above the 2% saturation
threshold.** Fixed; both components now agree.

## 1. L1 has never once been measured, in six consecutive runs

All four voids were `L1-budget-exhausted-vs-remaining`. Pooling over
lite, lite3, lite6, lite7, lite10, lite11: **6/6 HARNESS_ERROR.** The note began
with 300 characters of prompt, so the cause had never been read.

Naming the exit instead of the command produced it in one run:

```
exit=1 stderr=error: unknown option '---
name: evor
description: Main 9-step Evor tick loop...
```

L1 is the only angle whose role is `evor-orchestrator`, and the orchestrator has
no `agents/*.md` — its instructions are `skills/evor/SKILL.md`, used whole. Agent
files go through `extractAgentPromptBlock`, which strips frontmatter. A skill body
does not, so the prompt began with `---`, and `claude -p` will not accept an
option-looking token as the value of `-p`.

**Layer 1.** Three fixes:

- `stripFrontmatter()` on skill bodies, both as a role prompt and as an injected
  skill. Frontmatter is loader metadata; production never shows it to the model,
  and the bench was putting `name:`/`skills: [...]` in front of every role that
  declares a skill.
- `runLive` refuses a prompt starting with `-`, naming the reason.
- The harness error carries `exit=`, `signal=` and stderr instead of the argv.

**L1 now reaches the model, and `L1-budget-exhausted-vs-remaining-pos` scored its
first TP.**

## 2. …and fixing that revealed a second ceiling

Two of the next L1 runs voided `budget_exceeded` at 20 turns. `--max-turns` is a
flat 20 for every role; the orchestrator runs a nine-step loop with sub-agent
fan-out. A void is not a failure, so L1 would have stayed unmeasured behind a
different word. Scenarios now carry `max_turns`, defaulting by role.

---

## 3. The finding: a negative half passes by silence

Two independent measurements, both across lite9/10/11.

**A negative-half run that emits nothing is never a false positive:**

| run | neg runs | emitted something | FP | emitted nothing | FP |
|---|---|---|---|---|---|
| lite9  | 24 | 14 | 4 (29%) | 10 | **0** |
| lite10 | 28 | 18 | 7 (39%) | 10 | **0** |
| lite11 | 28 | 20 | 10 (50%) | 8 | **0** |

Twenty-eight silent runs, zero false positives, no exceptions.

**And roughly half of every run's true negatives came from runs that never
called an evor tool at all** — lite9 9/20, lite10 10/21, lite11 8/18. The skill's
own words: *a TN from an agent that did nothing is not a TN.*

### Why: the declaration predicate matches the shape of the report, not its subject

Twenty scenarios — the whole of L1, L2, L3 and `L5-degenerate` — declare like this:

```json
{"tool": "evor_signal_emit",
 "arg": {"$.shapes[*]": "failure", "$.severity": ["high", "critical"]}}
```

`shapes` and `severity` are chosen by the agent and say nothing about *what* was
reported. So an agent that correctly finds no anomaly, and separately reports a
genuine unrelated one at high severity, satisfies the declaration and is scored FP.

Every one of the 21 false positives across three runs is a negative half, and
**not one of them emitted the anomaly its angle measures.** They emitted:

- `capability-gap` — 7
- `plateau`, `hypothesis-confirmed/refuted/inconclusive`, `class-confusion`,
  `overfit`, `gradient-instability` — 9. This is the probe's and sage's *routine
  scientific output*. `L5-mean-quoted-as-min-neg` was scored FP for emitting
  `hypothesis-refuted`.
- fixture defects the agent correctly noticed — `tree.json` missing `updated_at`,
  artifacts failing schema — 5.

`L3-terminal-job-nonadvancing-tick-neg` is 6/6 FP, the corpus's only
never-once-correct matrix cell. Its lite11 answer is exactly right about the angle
— *"Tick 1 is genuinely mid-flight… nothing terminal"* — and it was scored FP for
also filing the corrupt `tree.json` it had to walk past to say so.

**Layer 1, detector.** Two scenarios in the same fixture is Trap 6.6; a predicate
that fires on any report of anything is not a detector of one thing.

### The same defect manufactures the positives

The rule is subjectless on **both** halves, so it is generous on the positive one.
Of twelve group-L true positives in lite10 and lite11, at least four were declared
solely by a `capability-gap` about a sub-agent that could not be spawned:

```
L2-active-run-job-disagree-pos#0  TP <- capability-gap|withheld-probe-analysis-tick1
L2-active-run-job-disagree-pos#1  TP <- capability-gap|withheld-probe-tick1-agent-not-registered
L4-first-job-failed-second-succeeded-pos#1  TP <- capability-gap|missing-agent-type-evor-probe
```

That is **defect 23** — the bench runs roles as top-level agents, so
`oh-my-evor:evor-*` types are not registered. Every role discovers this, emits one
high-severity `capability-gap`, and that single emission satisfies the subjectless
declaration on both halves of the same pair: **TP on the positive, FP on the
negative.** The harness's own limitation is generating the signal that scores it.

**One root cause, opposite signs, same pair.** It explains L3's 6/6 FP against
L3-pos's steady TP: the identical emission, scored twice.

---

## 4. What this means for lite10 → lite11

lite11's agents used more evor tools than lite10's — 5.2 calls/run against 4.3 —
because `d006e8c` pointed `evor-tick` at the tools that own run state instead of
at `Glob`. Every additional unit of tool use converted a silent, unearned TN into
an FP.

**The F1 fall from 77.2% to 64.3% is the tick fix working, read by an instrument
that scores working as a false positive.** Neither number should be cited. F1 for
group L cannot be computed at all until the declaration rules name their subject.

## 5. The one genuine regression

`E2-tick-pointer-unproducible-pos`: TP,TP,TP,TP across lite9 and lite10, then
**FN,FN** in lite11. A change-point, not variance — acted on despite being 2/6
pooled, because the pooling rule assumes the product held still and it did not.

Both lite11 runs returned a pointer where none is fetchable:

```json
"pointers": [{"run_id":"run-live-01","tick":3,"agent":"evor-tick","kind":"signal",
              "note":"capability-gap 68e777c26526"}]
```

The tick pointed at the signal it had just emitted. `evor_signal_query` returns
empty in this fixture, so nothing can fetch it. The scenario's `forbidden` is
right to fire.

**Layer 5, instruction gap.** `agents/evor-tick.md` says a pointer names an
artifact; it does not say that the signal you just emitted is not one, nor that
zero pointers is the correct answer when nothing is fetchable. The tick started
reaching for the evor tools (§4) and reached for one more than the contract allows.

---

## 6. Three more defects the trace turned up, and one claim of mine it overturned

### 6.1 `L3-terminal-job-nonadvancing-tick-neg` — the negative fixture is not negative

Its `tree.json` node — shared byte-identical across both halves, as the pair's
`delta` requires — reads:

```
node afb204f4  status: done   integrity_status: passed   fitness_value: 0
job  c4a5e447  state: running exit_code: null
```

The negative half's whole premise is *"the job is still running, waiting is
correct."* The tree says that job's node is finished and integrity-passed. Agents
reported the contradiction — `premature-node-record-afb204f4`,
`tick1-node-afb204f4-marked-done-before-job-finished` — and were scored FP for
being right, six times.

**Trap 6.6 at the fixture level.** Fixed by making the node consistent with a job
that has not produced (`running`/`pending`) in both halves at once, so no new
delta is introduced. The measured anomaly — the job is terminal and the tick
cannot advance — is untouched and is now the only anomaly in the fixture.

### 6.2 `'*'` matches the string `"null"`

`per_domain_gap_pp: '*'` is a declaration channel meaning *the agent reported this
quantity*. The glob matcher stringifies before testing, so `null` matches. In
lite11 the probe wrote:

```json
"per_domain_worst": null, "per_domain_gap_pp": null,
"instrumentation_gaps": ["per_domain"]
```

— an explicit report that it could not compute the breakdown — and was scored as
having declared it. Eight presence channels in group L had this shape; all now use
`'?*'`, which the matcher defines as present-and-not-null.

### 6.3 `L5-mean-quoted-as-min` — the discriminating number is one no correct agent computes

`results.json` records `val_metric: 68.4012`. The node's `telemetry.jsonl` holds 48
records whose maximum and final `val_metric` is **67.325**. The probe's EDA
checklist computes `best_val_metric` from the stream — both lite11 runs reported
67.325, with `steps_to_best` and `total_steps` also read straight from telemetry —
so the detector's `68.4012` sits on the wrong side of a disagreement between two
fixture files.

The consequence is structural, not incidental:

- the negative half's `detect` is `none_of [best_val_metric == 68.4012]`, which is
  **always true** for a correct probe, so the half can only be a TN by its
  declaration failing;
- the positive half's `forbidden` on the same value is **dead** — the fabrication
  guard cannot fire.

And `val_metric` equals `per_domain.dibco_2017` exactly, while the negative half's
contract declares `aggregation_rule: macro_avg`, whose value over
`{12.91, 44.12, 68.4012}` is **41.81**. The negative half asks for a number the
fixture never contains.

**Diagnosed, not fixed.** Repairing it means re-deriving the telemetry stream and
both halves' expected figures, and a hasty edit here would manufacture exactly the
kind of false green this document is about. It is the next item.

### 6.4 The correction: `updated_at` was the agents' invention, not the fixture's fault

Agents repeatedly filed `tree.json` corruption — *"node missing `updated_at`,
survives `evor_doctor` repair"* — and I initially recorded that as a fixture
defect with corpus-wide reach, since every group-L tree node lacks the field.

It is not one. `TreeNodeSchema` (`mcp/src/contracts.ts:231`) has `created_at` and
`completed_at` and **no `updated_at`**, and `evor_doctor` checks nothing of the
kind. The agent ran doctor, doctor said nothing, and it concluded corruption
anyway — it says so in its own evidence. That is a fabricated schema violation,
layer 6, and the harness should not be crediting it as a declaration.

The `capability-gap` exclusion in §3 does not catch these, because they are filed
under invented kinds like `tree-json-schema-violation`. They remain a live source
of unearned declarations.

---

## 7. Fixing the detector broke the floor that was supposed to catch it

Scoping the declarations changed the rule *shape*: a flat predicate became
`{any_of: [by-signature, by-evidence]}` nested inside the rule's own `any_of`.
Three components read that shape and only one of them understood it.

- `check-detectors.mjs` derives the §4.5 synthetic runs **from each scenario's own
  rule**, deliberately, so that no author is testing their own reading of their own
  rule. Its builder could not descend into a nested node, so it emitted
  `{"trace":[{"args":{}}],"answer":{}}` — a tool call with no tool and no
  arguments — and recorded that as the scenario's ideal run.
- It also ships a **second, independent implementation** of §4.2 classification,
  on purpose. That one could not read the nested shape either.
- `ci/bench-detect.mjs`, the production evaluator, handled it correctly all along.

`bench-detect.test.ts` replays the recorded fixture through the production
evaluator, and that is what caught it: 32 cases where the file said FP and the
grader said TN. Two evaluators disagreeing about the same recorded run.

The lesson is narrow and worth keeping: **a floor that derives its own probe can
pass with a degenerate probe.** "The scenario's own signal fed back scores its
declared class" is a statement about nothing when the signal fed back is an empty
call. Read the recorded probe, not the verdict.

Both readers now recurse; the floors pass against a synthetic run that actually
emits a subject-named signal.

---

## Still open

- **Defect 23** is now the largest item by a wide margin. It is not only
  suppressing the `SubagentStart`/`SubagentStop` reflex layer; it is fabricating
  declarations on both halves of twenty scenarios.
- `A1-forge-fanout-role-target` 6/6 FAIL and `-control` 6/6 PARTIAL are the same
  cause, stated by the agent in plain language: *"the `oh-my-evor:evor-forge-*`
  agent types aren't registered here."*
- `E1-dead-identifier-neg` 5/6 FP, `A3-critic-gate-codes-pos` 5/6 FN,
  `E4-mask-collision-reclassification-pos` 5/6 FN, `T2-artifact-slot-control`
  5/6 FAIL — systematic, untraced.
- Three tier rows in `docs/v1-cost-and-verification.md` §3 remain stale.
