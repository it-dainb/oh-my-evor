# Evor v1 retier: cost breakdown and verification status

What this branch (`evor/optimization-s0-s6`) changed, what the evidence for each
row actually is, and what is explicitly NOT verified. Every cost figure is
**billed** (`cli_cost_usd` from the CLI), never modeled — see the tier-asymmetry
note at the end for why that distinction is not cosmetic.

## 1. Shipped tiers

| agent | main | v1 | changed |
|---|---|---|---|
| evor-sage | opus | **haiku** | yes |
| evor-probe | opus | **haiku** | yes |
| evor-mutagen | opus | **haiku** | yes |
| evor-forge-analyst | opus | **haiku** | yes |
| evor-forge-architect | opus | **sonnet** | yes |
| evor-sage-junior | sonnet | **haiku** | yes |
| evor-acquirer | sonnet | **haiku** | yes |
| evor-forge-critic | sonnet | **haiku** | yes |
| evor-forge | sonnet | sonnet | no |
| evor-forge-junior | sonnet | sonnet | no |
| evor-tick | sonnet | sonnet | no |
| evor-selector | haiku | haiku | no |

Eight of twelve roles moved down at least one tier. Seven run haiku.

## 2. Cost breakdown, billed

One call of each retiered role, at the tier it ran on `main` vs the tier it runs
now:

| role | main tier | $/call | v1 tier | $/call | saving |
|---|---|---|---|---|---|
| mutagen | opus | 0.2754 | haiku | 0.0774 | **71.9%** |
| probe | opus | 0.1588 | haiku | 0.0493 | **69.0%** |
| sage | opus | 0.1581 | haiku | 0.0327 | **79.3%** |
| forge-analyst | opus | 0.1156 | haiku | 0.0422 | **63.5%** |
| forge-architect | opus | 0.1040 | sonnet | 0.0618 | **40.6%** |
| sage-junior | sonnet | 0.1043 | haiku | 0.0358 | **65.7%** |
| acquirer | sonnet | 0.0720 | haiku | 0.0294 | **59.2%** |
| forge-critic | sonnet | 0.0626 | haiku | 0.0365 | **41.7%** |
| **total** | | **1.0508** | | **0.3651** | **65.3%** |

**This is eight prices compared like for like. It is NOT a tick.** Roles are not
invoked equally often — sage-junior fans out several per angle, forge-critic
runs once per candidate, tick runs once — so the per-tick saving does not follow
from this table and has not been measured. Anyone quoting a tick-level number
from this document is quoting something that was never measured.

## 3. Accuracy evidence, per row

Verdict is a Newcombe difference CI at a 10pp non-inferiority margin. "Adopt"
requires the interval to exclude a 10pp drop — a non-significant p alone is not
sufficient and never was.

| role | haiku | sonnet | difference CI | verdict | $/pass saving |
|---|---|---|---|---|---|
| acquirer | 36/36 = 100% | 36/36 = 100% | [-9.6, +9.6] | non-inferior | 59.2% |
| sage | 75/78 = 96.2% | 77/78 = 98.7% | [-9.5, +3.6] | non-inferior | 58.6% |
| sage-junior | 31/33 = 93.9% | 29/33 = 87.9% | [-9.3, +21.9] | non-inferior | 70.8% |
| probe | 66/66 = 100% | 66/66 = 100% | [-5.5, +5.5] | non-inferior | 39.9% |
| mutagen | 116/120 = 96.7% | 116/120 = 96.7% | [-5.3, +5.3] | non-inferior | 56.9% |
| forge-critic | 29/30 = 96.7% | 27/30 = 90.0% | [-8.2, +22.5] | non-inferior | 44.6% |
| forge-analyst | 101/108 = 93.5% | 103/108 = 95.4% | [-8.7, +4.8] | non-inferior | 36.5% |

forge-architect has no haiku row: its last measurement was 81/90 vs 89/90,
CI [-16.9, -2.1], a **REGRESSION**. It ships on sonnet, which is where the
opus→sonnet step left it, and that step is one of the four original claims now
classed underpowered (see §5).

## 4. Verification status — read this before trusting §3

`ci/role-eval.mjs` writes an `agent_sha256` into every report so a run can be
tied to the file it measured. The check below is what that fingerprint plus git
history actually supports:

| row | measured file vs shipped file | status |
|---|---|---|
| sage | frontmatter only (model:, effort:) | **VERIFIED** |
| probe | frontmatter only | **VERIFIED** |
| mutagen | frontmatter only | **VERIFIED** |
| forge-critic | frontmatter only | **VERIFIED** |
| sage-junior | unchanged since measurement | **VERIFIED** |
| acquirer | file edited in the same commit that reported the run; mtimes cannot establish order | **UNVERIFIED** |
| forge-analyst | S49 edited the file AFTER the measurement | **UNVERIFIED** |
| forge-architect | S47 edited the file AFTER the measurement | **UNVERIFIED** |

The four VERIFIED-by-frontmatter rows are sound: the only post-measurement diff
is `model:` and `effort:`, which the harness overrides per-arm anyway, so the
prompt body those runs measured is the prompt body that ships.

The three UNVERIFIED rows are the honest gap in v1:

- **forge-analyst ships on haiku on the strength of a measurement of the
  previous revision of its file.** S49 changed only `oom-high-with-checkpointing`
  handling — a case that was weak in BOTH arms (5/9 haiku, 6/9 sonnet), so the
  expected effect is both arms up and the verdict unchanged. That is a
  prediction, not a result.
- **forge-architect's S47 fix is unmeasured.** The prior run was a regression
  driven almost entirely by `wrong-loss-for-task` (haiku 1/9), whose cause was a
  self-contradicting Dimension 3 redirect that S47 removed. Whether that lifts
  it into non-inferior territory is unknown.
- **acquirer** is the weakest of the three, because both arms scored 36/36: a
  spec where nothing fails cannot resolve a small gap in either direction.

Deferred to the next branch by decision, not by oversight.

## 5. Claims that are NOT supported

- **Four opus→sonnet retiers were never demonstrated**: probe, forge-architect,
  forge-critic and mutagen. Under the corrected statistics they are
  *underpowered*, not held. They were adopted before the margin existed, and no
  run since has had the power to confirm them. They are not suspected of
  regressing; they are simply unproven.
- **No tick-level cost measurement exists.** See §2.
- **The modeled-vs-billed gap is unexplained.** Billed exceeds modeled by 1.142x
  on haiku and 1.261x on sonnet and opus. Knowing the direction is not knowing
  the cause; a pricing-table bug and a token-accounting bug look identical here.

## 6. Why the savings exist

Not model swaps. **Thirteen defects in our own agent files**, all one class: a
rule graded but never stated, stated twice with different answers, or stated far
from where the field is written. Every time a haiku arm looked like a capability
limit, reading the model's actual answer found a prompt defect —
**thirteen times out of thirteen, zero times a model failing to reason.**

probe is the clearest case. Same role, same model, three readings:

| reading | haiku | difference CI | verdict it supported |
|---|---|---|---|
| pre-fix | 59/66 = 89.4% | [-20.3, -2.9] | REGRESSION — do not adopt |
| after S40 | 63/66 = 95.5% | [-12.5, +1.7] | underpowered |
| after S43 | 66/66 = 100% | [-5.5, +5.5] | non-inferior — adopt |

sonnet was 66/66 throughout. Had the first reading been filed as a capability
finding, probe would have stayed on opus permanently and both defects would
still be there — invisible, because they cost the expensive tier nothing.

Full defect list: `docs/agent-file-defects.md`. Method and statistics:
`docs/retier-benchmark-results.md`.
