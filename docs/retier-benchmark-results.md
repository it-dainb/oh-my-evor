# Retier benchmark: seven roles, cheaper tier vs the tier it replaced

Branch `evor/optimization-s0-s6` retiers seven agents downward. This measures
each one against the tier it replaced on `main`, so that "no regression" is a
measured claim rather than an assumption about model capability.

**Method.** Each role has a spec under `evals/<role>/spec.json` declaring two
arms that differ *only* in model — effort is held at `medium` throughout, so the
retier is the only variable. Cases are graded offline against a contract built
from the agent file's own `<Output_Format>`; `ci/eval-core.mjs` builds the
prompt and scores the answer from the same `contract.fields` array, so a graded
field is necessarily a stated field. 3 repeats per case per arm.

**Statistics.** Wilson score intervals (Wald collapses to a point at k=n and
would assert certainty from 30 samples) and an exact two-sided Fisher test (cell
counts are single digits, where the normal approximation is unreliable).
`python3 ci/retier-report.py --self-test` checks both against scipy.

**Cost** is reported per *passing attempt*, not per call: a tier that is 40%
cheaper and fails a third of the time is not cheaper, because the retry is part
of the price.

## Results

| role | retier | current | pre-retier | delta | Fisher p | verdict | $/pass |
|---|---|---|---|---|---|---|---|
| probe | opus->sonnet | 30/30 = 100.0% [89–100] | 30/30 = 100.0% [89–100] | +0.0pp | 1.000 | no difference | $0.0853 vs $0.1193 (+29%) |
| forge-analyst | opus->sonnet | 35/36 = 97.2% [86–100] | 31/36 = 86.1% [71–94] | +11.1pp | 0.199 | no difference | $0.0502 vs $0.1095 (+54%) |
| forge-architect | opus->sonnet | 28/30 = 93.3% [79–98] | 26/30 = 86.7% [70–95] | +6.7pp | 0.671 | no difference | $0.0508 vs $0.0846 (+40%) |
| forge-critic | opus->sonnet | 27/30 = 90.0% [74–97] | 29/30 = 96.7% [83–99] | -6.7pp | 0.612 | no difference | $0.0537 vs $0.0882 (+39%) |
| sage ‡ | opus->sonnet | 25/30 = 83.3% [66–93] | 24/30 = 80.0% [63–90] | +3.3pp | 1.000 | no difference | $0.0774 vs $0.1367 (+43%) |
| sage-junior ‡ | sonnet->haiku | 21/27 = 77.8% [59–89] | 22/27 = 81.5% [63–92] | -3.7pp | 1.000 | no difference | $0.0378 vs $0.0721 (+48%) |
| mutagen †‡ | opus->sonnet | 23/30 = 76.7% [59–88] | 22/30 = 73.3% [56–86] | +3.3pp | 1.000 | no difference | $0.1994 vs $0.2888 (+31%) |

‡ **These three rows are superseded.** They were measured against agent files
that contradicted themselves (see `docs/agent-file-defects.md`). S30 fixed the
contradictions, which changed both the prompts and several expectations, so
these numbers no longer describe the shipped files. The re-baseline below
replaces them; the four unmarked rows are unaffected and stand as measured.

Sum of mean per-call cost across the seven roles, using the re-baselined runs
for the three ‡ rows: **$0.5163** current vs **$0.8266** pre-retier
(**38% cheaper**). Per-role: probe +28.5%, forge-analyst +48.2%,
forge-architect +35.3%, forge-critic +43.3%, sage +32.0%, sage-junior +64.9%,
mutagen +29.4%.

All seven retiers hold. Not one was defeated by a model that could not do the
work; the only regression that survived scrutiny turned out to be an instruction
the model could not find.

† mutagen's current arm is sonnet:medium **with the S26 prompt fix**. As
shipped before that fix it was 7/30 (23.3%) against opus's 22/30 — a genuine
regression at p=0.0002. See below.

**Verdict: 7 of 7 retiers hold.** No role regresses at p<0.05. Four of the seven
point cheaper-arm-ahead, though none significantly.

## Re-baseline after the agent-file fixes (S30-S32)

The three ‡ rows above were measured against agent files that answered the same
question twice, differently (`docs/agent-file-defects.md`). Fixing those files
changed the prompts, and fixing the fixtures that had encoded the contradictions
changed the case sets, so these runs replace them outright:

| role | retier | current | pre-retier | delta | Fisher p | verdict | $/pass |
|---|---|---|---|---|---|---|---|
| mutagen | opus->sonnet | 24/30 = 80.0% [63–91] | 24/30 = 80.0% [63–91] | +0.0pp | 1.0000 | no difference | $0.2124 vs $0.3008 (+29%) |
| sage | opus->sonnet | 37/39 = 94.9% [83–99] | 33/39 = 84.6% [70–93] | +10.3pp | 0.2626 | no difference | $0.0903 vs $0.1489 (+39%) |
| sage-junior | sonnet->haiku | 31/33 = 93.9% [80–98] | 29/33 = 87.9% [73–95] | +6.1pp | 0.6724 | no difference | $0.0328 vs $0.0998 (+67%) |

**These accuracies are not comparable to the ‡ rows.** The case sets changed:
sage went from 10 cases to 13 and sage-junior from 9 to 11, and several
expectations flipped because the models had been right and the fixtures wrong.
What *is* comparable is the arm-vs-arm verdict within each run, which is the only
thing the retier decision rests on.

All three retiers hold, and none of the three has a case failing in every arm
any more — the state the fixes were aiming for. sage-junior's saving is the
largest in the whole exercise at **67% per passing attempt**, and it is now the
*better* arm as well as the cheaper one; haiku still runs ~2x slower per call
(40.7s vs 20.8s), which matters only if latency ever outranks cost.

### sage-junior: the merge rule was worth 9 points

`wide-disagreement` had been failing in both arms — 0/3 sonnet, 1/3 haiku — and
both models had the same defensible reason. They emitted **one finding per
source**, so two papers reporting the same metric became two single-source
findings, each legitimately "medium". The comparability gate never ran at all,
because step 2b only fires when A and B sit inside one finding. The 24-point
disagreement between the two papers — the whole question the angle was asked to
resolve — appeared nowhere in the output, and nothing in the file forbade it.

Stating the merge rule in `Output_Format` took the case to 3/3 haiku and 2/3
sonnet, and lifted both arms overall (haiku 84.8% -> 93.9%, sonnet 90.9% ->
87.9% within noise). Note the shape: this was invisible to every check that
looked at *values*. It only surfaced because a case failed in both arms, which
is the signature worth trusting.

### mutagen: the same lesson as S26, found a second time

The first re-baseline came back a genuine regression — sonnet 14/30 against
opus's 24/30 — driven almost entirely by the newly-graded `mutation_tier`, which
scored 30/30 for opus and 20/30 for sonnet. Sonnet was labelling proposals
`"structural"` at wildness 0.45, apparently reasoning that switching approach
family is inherently a structural change.

The rule was stated, correctly and unambiguously, in `Wildness_Interpretation` —
and nowhere near `Output_Format`, where the model actually writes the field.
Restating it there as a two-number lookup, and naming the specific wrong
inference, took sonnet to **30/30 on that field with no tier change**:

| mutagen arm | mutation_tier | overall | note |
|---|---|---|---|
| sonnet, rule stated only in Wildness_Interpretation | 20/30 | 14/30 | regression, z=2.68 |
| sonnet, rule restated at the point of use | 30/30 | 24/30 | ties opus |
| opus | 30/30 | 24/30 | baseline |

This is the second independent instance of the pattern S26 found for `dream_k`.
Two data points is not a law, but it is enough to change the default move:
**when the cheaper tier regresses on one specific field, check whether the rule
is stated where that field is written before concluding the model cannot do it.**
Both times the answer was prompt placement, and both times raising the tier back
would have paid for a defect that cost nothing to fix.

---

## The one real regression, and why effort was the wrong lever

mutagen failed on exactly one check in both arms: the proposal count. Sonnet
emitted 4 proposals in 25 of 30 runs where `dream_k >= train_k * 2` requires 6.

Three levers, measured:

| mutagen arm | accuracy | vs opus:medium | $/call | $/pass |
|---|---|---|---|---|
| sonnet:medium, as shipped | 7/30 = 23.3% | **REGRESSION** p=0.0002 | $0.1273 | $0.5458 |
| opus:medium (pre-retier) | 22/30 = 73.3% | baseline | $0.2118 | $0.2888 |
| sonnet:**high** (raise effort) | 13/30 = 43.3% | **still REGRESSION** p=0.035 | $0.2294 | $0.5294 |
| sonnet:medium + **prompt fix** | 23/30 = 76.7% | no difference p=1.000 | $0.1529 | $0.1994 |

Raising effort was wrong twice over: it did not clear the regression, and at
$0.2294/call it costs **more than the opus:medium it was meant to replace**.
The ceiling was never sonnet's reasoning — it was an instruction the model could
not find, stated once in a parenthetical and once in a checklist, with a default
value (`5`) that contradicted the floor it was supposed to satisfy
(`train_k * 2`, which is 6 at `train_k=3`).

Making the computation explicit recovered the role past its opus baseline at 31%
less per passing attempt. **This is the general lesson: benchmark before
attributing a failure to the model. Two of the three levers here were dead ends,
and the cheap one worked.**

## Not benchmarked

`evor-acquirer`'s sonnet->haiku retier was **unverified** for the reason given
here — network-bound work that cannot be faithfully replayed offline. That was
half right and is now superseded: see "The last unverified retier" below. The
fetching cannot be replayed; every rule the role turns on can.

## Caveats

- `n=30` per arm (36 for forge-analyst). The intervals are wide; several roles
  span 20+ points. This detects a large regression, not a small one.
- `cost_usd` is the CLI's modelled figure, reconciled against `costUSD`. It is
  an estimate, not an invoice.
- Two sage-junior cases and one sage case are unwinnable as specified — the
  agent files answer them twice, differently. They depress both arms equally and
  move no verdict. See `docs/agent-file-defects.md`.
- Every fixture defect found during this work (~8) was mine, and the model was
  right every time. Fixtures are now verified against the strictest arm before a
  matrix is launched.

---

# Ladder extension: sonnet -> haiku on the three ceiling roles

The three roles closest to ceiling on sonnet were re-run on haiku. The sonnet
arms were reused rather than re-measured, so only the haiku arm was paid for.

| role | haiku | sonnet | delta | Fisher p | $/call | $/pass | verdict |
|---|---|---|---|---|---|---|---|
| probe | 22/30 = 73.3% [56–86] | 30/30 = 100.0% [89–100] | -26.7pp | **0.0046** | +48.8% | +30.2% | **REGRESSION — do not adopt** |
| forge-analyst | 31/36 = 86.1% [71–94] | 35/36 = 97.2% [86–100] | -11.1pp | 0.199 | +19.9% | **+9.6%** | not adopted — see below |
| forge-architect | 24/30 = 80.0% [63–91] | 28/30 = 93.3% [79–98] | -13.3pp | 0.254 | +31.9% | **+20.5%** | not adopted — see below |

**Recommendation: keep all three on sonnet.**

probe is a clear regression and the decision is easy. The other two are the
interesting case, because a naive reading says they passed — p > 0.05, "no
detectable difference." That reading is wrong twice.

**1. Failure to detect is not evidence of equivalence.** At n=30–36 the Wilson
intervals span 20+ points. A true 10-point drop is exactly what this design
cannot distinguish from noise. Both roles point *down* by 11–13pp; the test
says we cannot rule out zero, not that zero is likely.

**2. The saving mostly evaporates when you price the retry.** Haiku is 20–49%
cheaper per call but only **9.6%** cheaper per passing attempt for forge-analyst
and 20.5% for forge-architect, because it fails more often. Trading an 11-point
accuracy drop for 9.6% is a bad trade at any level of significance — and these
roles gate downstream work, so a wrong analysis costs a whole implementation
cycle, not one retry.

Both also have a systematic blind spot rather than diffuse noise:
forge-architect misses `structural-missing-new-knob` 0/3 (approving a structural
mutation that introduces no new knob), and probe misses `grad-vanishing` 0/3
(calling small-amplitude noise around a flat line "oscillating").

Unlike mutagen's regression, these are **not** buried-instruction defects. There
is no stated rule the model failed to find; fixing them would mean inventing new
decision thresholds, which changes what the agent means rather than clarifying
it. That is the honest boundary between a prompt fix and a capability limit.

**Where the ladder stops.** sonnet holds for six roles and haiku holds for
sage-junior, whose 48%-per-pass saving is real because its accuracy barely moved
(77.8% vs 81.5%). The pattern across both rungs: judge the rung by cost per
*passing* attempt, not per call. Per-call savings of 20–49% shrank to 10–30%
once failures were priced in, and that is what turned two apparent passes into
declines.

---

# The statistics were reading "not significant" as "no regression" (S35)

The paragraph above — *failure to detect is not evidence of equivalence* — was
right, and `ci/compare-arms.py` was printing the opposite. Every result with
p >= 0.05 came out as **"no detectable difference -- retier holds"**. The sage
sonnet->haiku ladder is what made this impossible to keep ignoring: 31/39 vs
37/39, a 15-point drop, reported as a held retier.

The verdict is now a non-inferiority test on a Newcombe interval for the
difference between arms, with four outcomes instead of three:

| verdict | means |
|---|---|
| REGRESSION | significantly worse |
| IMPROVEMENT | significantly better |
| non-inferior within 10pp | the interval rules OUT a drop worse than 10pp |
| **UNDERPOWERED** | it does not, and the run cannot decide |

**The margin is set by what n can reach, not by what would be comfortable.**
At n=30, two arms that tie *perfectly* still leave a 15pp drop inside the
interval. Ruling out 5pp would take n near 200:

| n per arm (arms tied at 95%) | worst drop ruled out |
|---|---|
| 30 | 15.4pp |
| 60 | 9.3pp |
| 120 | 6.1pp |
| 200 | 4.6pp |

So a role that lands UNDERPOWERED needs repeats, not a softer margin. Lowering
the number until a verdict appears would be assuming the answer the run exists
to produce.

## What this does to the standing claims

| retier | n | difference CI | was | now |
|---|---|---|---|---|
| forge-analyst opus->sonnet | 36 | [-2.7, +26.1] | no difference | **non-inferior** |
| sage opus->sonnet | 39 | [-4.0, +25.1] | no difference | **non-inferior** |
| sage-junior sonnet->haiku | 33 | [-9.3, +21.9] | no difference | **non-inferior** |
| probe opus->sonnet | 30 | [-11.4, +11.4] | no difference | UNDERPOWERED |
| forge-architect opus->sonnet | 30 | [-10.0, +23.7] | no difference | UNDERPOWERED |
| forge-critic opus->sonnet | 30 | [-22.5, +8.2] | no difference | UNDERPOWERED |
| mutagen opus->sonnet | 30 | [-20.2, +20.2] | no difference | UNDERPOWERED |

Four of the seven were never demonstrated — they were *not refuted*, which is a
weaker thing that the report had been spelling the same way. None of the four
is now suspected of regressing; the runs simply do not carry the claim, and the
fix is more repeats. `ci/compare-arms.py` now accepts `a.json+b.json` for one
arm so an arm can be topped up, and refuses to pool reports whose agent+spec
fingerprints differ — averaging a before and an after would be worse than a
small n.

---

# The last unverified retier: acquirer (S35)

`evor-acquirer` had shipped on haiku since the day it was written and had never
been measured. The earlier claim that its work "cannot be faithfully replayed
offline" was true of the *fetching* and false of everything that matters: the
leakage direction, the drop arithmetic, and the four signal conditions are all
decidable from tool results, which the harness already inlines.

| arm | n | accuracy | difference CI | $/call | $/pass |
|---|---|---|---|---|---|
| haiku (current) | 36 | 36/36 = 100.0% | [-9.6, +9.6] | $0.0232 | $0.0232 |
| sonnet (pre-retier) | 36 | 36/36 = 100.0% | — | $0.0534 | $0.0534 |

**non-inferior within 10pp — the retier holds**, at 57% less per call.

Both arms perfect means the spec cannot resolve a *small* gap between them, and
that limitation is the honest reading. What it does establish is that haiku
handles every rule the role actually turns on: that enrich-train writes to
`train` while de-duping against `test` (and harden-test the mirror), that
`eval_version` moves only for harden-test, that a 45% collision rate is
leakage-blocked but not contamination while 65% is both, and that an unknown
license flags without gating — all 1500 items still integrated.

Writing the spec surfaced two defects of the usual class in the agent file:
`format_errors` and `validation_dropped` merged into a single output field with
no rule saying so, and the license-gate condition ended in "e.g.", which made
every unlisted license a coin flip. Both are fixed; the second is now decided
by exclusion from a permissive set, so an unfamiliar license fails safe.

---

# Ladder round 2: haiku on the three roles that had never been tried (S33-S36)

| role | haiku | sonnet | difference CI | $/pass | verdict |
|---|---|---|---|---|---|
| forge-critic | 29/30 = 96.7% | 27/30 = 90.0% | [-8.2, +22.5] | $0.0315 vs $0.0537 (**+41%**) | **non-inferior — adopt** |
| sage | 31/39 = 79.5% | 37/39 = 94.9% | [-30.9, -0.1] | $0.0361 vs $0.0903 (+60%) | UNDERPOWERED, pointing down — *superseded, see S36–S39 below* |

forge-critic is the clean one: haiku scored *higher* than sonnet, and the
interval rules out a drop worse than 8.2pp. At 41% less per passing attempt it
is the second-largest saving in the exercise after sage-junior.

sage is the opposite and the reason the margin exists. The point estimate is
-15.4pp, Fisher p=0.0866, and the old report would have called it a held
retier. The failures are concentrated, not diffuse: `divergence-just-outside`
0/3 and `divergence-inside-band-incomparable` 1/3 — the two cases that turn on
the 5% divergence arithmetic *and* the comparability gate at once. That is the
shape of a capability limit rather than a buried rule, though it has not been
ruled out; either way the evidence does not support adopting it.

# S36-S39: sage was a buried rule after all, and the fix first broke the strong arm

The round-2 sage row above read like a capability limit — failures concentrated
on the two cases that need the 5% divergence arithmetic and the comparability
gate at the same time. It was not. Reading haiku's actual answers showed it was
picking `confidence` before it had finished the comparability step, because the
file stated the confidence rule far from the point where the field is written.

The first fix (S36) made `confidence` an explicit ceiling. It also declared
`quorum_met=false` with `confidence="medium"` a contradiction. That is wrong —
a single authoritative source is exactly that pairing, and three fixtures
expect it. The measurement caught it in the only way it could: **the cheap arm
started outscoring the strong one.** sonnet fell 37/39 to 61/78, with
`mirrored-source-trap` at 0/6.

S39 narrowed the "low" ceiling to *a comparison was attempted and failed*,
leaving *never had a second measurement to attempt* at "medium". Both arms then
came back healthy:

| arm | n | correct | accuracy | 95% CI | $/pass |
|---|---|---|---|---|---|
| haiku (candidate) | 78 | 75 | 96.2% | [89.3, 98.7] | $0.0285 |
| sonnet (baseline) | 78 | 77 | 98.7% | [93.1, 99.8] | $0.0637 |

delta -2.6pp, Fisher p=0.6201, difference CI **[-9.5, +3.6]pp** →
**non-inferior within 10pp — retier holds**, at **-55.3% per passing attempt**.

Two things are worth keeping from this. The prompt fix lifted *both* arms
(sonnet 94.9% → 98.7%), so the round-2 verdict was measuring a defective file,
not a tier. And re-measuring the baseline is not optional: had S39 reused the
round-2 sonnet numbers to save an hour, the S36 regression would have shipped
invisibly. Recorded as [[prompt-fix-can-regress-strong-arm]].

# Adopted

Applied to agent frontmatter on this branch:

| agent | was | now | evidence | $/pass, billed |
|---|---|---|---|---|
| `evor-acquirer` | sonnet | haiku | 36/36 vs 36/36, CI [-9.6, +9.6] | **-59.2%** |
| `evor-forge-critic` | sonnet | haiku | 29/30 vs 27/30, CI [-8.2, +22.5] | **-44.6%** |
| `evor-sage` | sonnet | haiku | 75/78 vs 77/78, CI [-9.5, +3.6] | **-58.6%** |
| `evor-probe` | sonnet | haiku | 66/66 vs 66/66, CI [-5.5, +5.5] | **-39.9%** |

`effort:` was dropped from the two retiered files — haiku does not support it,
and `tests/agent-frontmatter.test.ts` fails if an inert tag is left behind.

Everything else stays where it is. Roles whose haiku arm is merely
*underpowered* are not adopted: "we could not demonstrate a regression" is not
"there is no regression", and at n=30 the interval still admits a 15pp drop.

# The cost numbers above are billed, and that changed them

Every $/pass figure in this document before this section was on *modeled*
dollars — our own price table applied to the token counts. `cli_cost_usd` is
what the CLI reported being billed, and across all 1988 records in `ci/out` the
two disagree by a factor that is **not constant across tiers**:

| tier | records | billed / modeled |
|---|---|---|
| haiku-medium | 738 | 1.142 |
| sonnet-medium | 882 | 1.261 |
| sonnet-high | 30 | 1.130 |
| opus-medium | 338 | 1.261 |

A uniform bias would cancel in an arm-vs-arm ratio. This one does not: modeled
dollars understate the sonnet arm by about 12pp more than the haiku arm, so
every modeled sonnet→haiku saving quoted here is a **floor**. Recomputed on
billed cost the three adopted retiers all move up — sage 55.3% → 58.6%,
acquirer 57% → 59.2%, forge-critic 41% → 44.6% per passing attempt.

`arm_cost()` in `ci/retier-report.py` now prefers billed, falls back to modeled,
flags `mixed`, and treats a *zero* `cli_cost_usd` as the CLI declining to answer
rather than as a free call. `ci/compare-arms.py` prints the basis on the cost
line and warns when either arm is on modeled dollars. Accuracy verdicts are
untouched by any of this.

What is still unexplained is *why* the bill exceeds the model at all; knowing
the direction is not knowing the cause. No accuracy conclusion depends on it.

# probe: the same row, read three times, would have given three answers

probe is the clearest illustration in the exercise of why a single measurement
of a cheap tier is not a capability finding. Nothing about haiku changed across
these three runs — two rules in `agents/evor-probe.md` did:

| reading | haiku | difference CI | verdict it supported |
|---|---|---|---|
| pre-fix | 59/66 = 89.4% | [-20.3, -2.9] | **REGRESSION — do not adopt** |
| after S40 | 63/66 = 95.5% | [-12.5, +1.7] | underpowered |
| after S43 | 66/66 = 100% | [-5.5, +5.5] | **non-inferior — adopt** |

sonnet was 66/66 throughout. Had the first reading been filed as "haiku cannot
do telemetry EDA", probe would have stayed on sonnet permanently on the strength
of two defects in its own prompt — and the defects would still be there,
costing sonnet nothing visible and so never getting found.

The second fix is the one worth remembering, because **S40 caused the problem
S43 repaired.** S40 rescued `truncated-run-trap` and broke `nan-telemetry` in
the same edit, taking it 6/6 → 3/6. The wording "a null where a number was
written" never said how to tell a null from an absent field, and haiku filed
`train_loss: null` under "optional field absence" — a defensible reading of the
sentence as written. Both arms have to be re-measured after every prompt edit,
including the ones that are obviously improvements.

haiku is 3.6x slower on this role (78s vs 22s per call). Cost outranks latency
here, so it goes; if that ever inverts, probe is the first row to revisit.
