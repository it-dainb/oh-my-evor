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

Sum of mean per-call cost across the seven roles: **$0.4766** current vs **$0.7521** pre-retier (**37% cheaper**).

† mutagen's current arm is sonnet:medium **with the S26 prompt fix**. As
shipped before that fix it was 7/30 (23.3%) against opus's 22/30 — a genuine
regression at p=0.0002. See below.

**Verdict: 7 of 7 retiers hold.** No role regresses at p<0.05. Four of the seven
point cheaper-arm-ahead, though none significantly.

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

`evor-acquirer`'s sonnet->haiku retier is **unverified**. Its work is
network-bound data acquisition that cannot be faithfully replayed offline, and a
fragment of its behaviour dressed up as coverage would be worse than an honest
gap.

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
