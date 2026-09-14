# The ceiling: 100% F1 is not reachable on a single run of this bench

Delegated determinism analysis, verified against the runs on disk. This is the
number the loop has been working toward without anyone having costed it.

## Positional instability is 36%, not 29%

`lite18` and `lite19` are the same arm over the same 36 scenarios — 72 paired
record positions — separated by a commit that changed only what gets recorded.

| paired status | count |
|---|---|
| SCORED in both | 51 |
| VOID in both | 9 |
| VOID → SCORED | 6 |
| SCORED → VOID | 4 |
| HARNESS_ERROR → SCORED | 1 |

- **15/51 verdict flips among both-scored positions (29.4%)** — the figure reported earlier, confirmed.
- **11/72 additional *scoreability* flips** — graded in one run, excluded in the other.
- **Total positional instability: 26/72 = 36.1%.**

The scoreability flips are the ones that were invisible. Voids are excluded from
F1, so a cell that voids in one run and scores FP in the next **moves F1 with no
behavioural change at all**. Four of them are `no terminal JSON answer`, four an
undeclared denial that fired in one run only, one a stub gap, one an infrastructure
flake.

## The floor, with arithmetic

Of the 15 verdict flips, 7–8 are eliminable by bench changes (both-trajectories-
defensible cases, plus one Mechanism A case). Residual: **7–8 of 51 = 13.7–15.7%**.

Two independent draws of a cell with per-draw correctness *p* flip with probability
2*p*(1−*p*):

```
2p(1-p) = 0.294  ->  p ≈ 0.82   (today)
2p(1-p) = 0.137  ->  p ≈ 0.925  (at the floor)
```

**Stated plainly: the floor is materially above zero.** With every bench-side cause
fixed, about **one paired position in seven still re-rolls**, and a single-draw F1
from this instrument carries a ceiling around **0.92–0.94, not 1.00**.

Folding the scoreability flips back in (best case ~6 survive), positional
instability floors at ~13/72 = **18%**.

**100% F1 on a single run of this bench is not reachable, and a run reporting it
would be reporting a lucky draw.** That is the honest answer to the target, and it
is better said now than approached asymptotically while each run's number is quoted
as progress.

## What the seed does not do

`§6.11` makes `seed` mandatory and the runner refuses to start without one. Its only
consumer is `derivedSeed(sc.id, sc.seed, r)`, written into the stub script for the 46
stub-backed scenarios. **It does not reach the model** — the Claude CLI takes no seed
parameter — and for the 124 non-stub scenarios it is threaded to nothing at all.

The mandatory-seed rule is real reproducibility hygiene for the stub's noise. It is
not a determinism control on the measurement and must not be cited as one.

## What is clean

- `Math.random`: zero occurrences in the runner, the detector engine, or the stub.
- The detector engine reads no clock.
- The stub is counter-based (`sha256(seed, callIndex, label)`) and selects by
  argument match, not by a draw, so an extra early call does not change which
  scripted result a later call receives.
- `--workers` fan-out gives each scenario its own sandbox and stub dir; no shared
  mutable state between workers.

The irreducible source is **model sampling**, which is unseeded and unseedable from
here.

## What this changes about the goal

A target of 100% F1 is a target for a **deterministic** instrument. This one is not,
and cannot be made so from the bench side. Three honest reformulations, in order of
how much they preserve the original intent:

1. **Report a modal verdict over n draws per cell, with n chosen for stability.**
   Costs n× the run. At the current flip rate a per-cell verdict is not stable at
   n=2 or n=4.
2. **Report F1 with a confidence interval** and require the interval, not the point
   estimate, to clear the bar.
3. **Target the eliminable fraction directly**: drive bench-caused flips to zero and
   report the residual as the measured variance of the model under test, which is a
   finding rather than a defect.

None of these is a decision I should make alone — they change what the project's
headline number means.
