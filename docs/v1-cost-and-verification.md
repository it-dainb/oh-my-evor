# Evor v1 retier: cost breakdown and verification status

What this branch (`evor/optimization-s0-s6`) changed, what the evidence for each
row actually is, and what is explicitly NOT verified. Every cost figure is
**billed** (`cli_cost_usd` from the CLI), never modeled — see the tier-asymmetry
note at the end for why that distinction is not cosmetic.

## 1. Shipped tiers — all twelve agents

Gate for shipping a tier change: **accuracy ≥95% absolute, difference CI clears
−10pp, both arms from one paired run, material cost saving.** All four, or the
role keeps its `main` tier.

| agent | main | release | status |
|---|---|---|---|
| evor-sage | opus | **haiku** | ships |
| evor-mutagen | opus | **haiku** | ships |
| evor-probe | opus | **haiku** | ships |
| evor-acquirer | sonnet | **haiku** | ships |
| evor-selector | opus | **haiku** | ships |
| evor-forge-junior | sonnet | sonnet **`effort: low`** | ships |
| evor-tick | — (new) | sonnet | ships, never benchmarked |
| evor-forge-critic | opus | opus | reverted — arms unpaired |
| evor-forge-analyst | opus | opus | reverted — 93.5% |
| evor-sage-junior | sonnet | sonnet | reverted — 93.9% |
| evor-forge-architect | opus | opus | reverted — 93.3%, CI −10.0pp |
| evor-forge | opus | opus | reverted — 3-tick A/B only |

**The reverts are frontmatter-only.** Every prompt-body fix ships on all twelve,
including the five reverted roles: those fixes were verified on *both* arms and
lift the expensive tier too. S46's floors fix took forge-analyst's sonnet arm as
well as its haiku arm; reverting the tier does not undo that.

Note the five reverted files now carry an explicit `effort:` that `main` left
undeclared. `tests/agent-frontmatter.test.ts` requires it for any non-haiku
model, so the declaration is the branch's, not `main`'s.

## 2. Cost breakdown, billed — what ships

| role | from | to | $/call was | $/call now | saving |
|---|---|---|---|---|---|
| sage | opus | haiku | 0.1581 | 0.0327 | **79.3%** |
| mutagen | opus | haiku | 0.2754 | 0.0774 | **71.9%** |
| probe | opus | haiku | 0.1588 | 0.0493 | **69.0%** |
| acquirer | sonnet | haiku | 0.0720 | 0.0294 | **59.2%** |
| selector | sonnet | haiku | 0.0396 | 0.0307 | **22.5%** |
| **total** | | | **0.7039** | **0.2195** | **68.8%** |

`forge-junior` is an effort change, measured at 42.5% cheaper (low vs high) and
not in the per-call table above. Selector's row covers only its measured
sonnet→haiku leg; its opus→sonnet leg has no billed figure, so the total
**understates** the real saving.

**This is five prices compared like for like. It is NOT a tick.** Roles are not
invoked equally often, so the per-tick saving does not follow from this table
and has not been measured.

Forgone by the four reverts that have per-call figures: **$0.2618 per call**
(forge-critic $0.0777, forge-analyst $0.0734, sage-junior $0.0685,
forge-architect $0.0422). `evor-forge` has no per-call figure, so the true total
is higher. That is the price of the gate, and it is recoverable — see
`docs/v2-backlog.md` P0/P1.

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
classed underpowered (see §5). The S47 fix aimed at that regression is unmeasured
and lives on v2.

## 4. Verification status — every adopted row

`ci/role-eval.mjs` writes an `agent_sha256` into each report. That hash covers
the whole file, so adopting a retier (`model:` → haiku, dropping the inert
`effort:`) invalidates the fingerprint of the very run that justified it — which
is why a naive check reports every row stale. The meaningful comparison is the
**prompt body**, since the harness overrides model and effort per arm anyway.

| row | measured at | body == shipped body |
|---|---|---|
| acquirer | `6484bf4` | **YES** |
| sage | `16e8643` | **YES** |
| sage-junior | `3edc85c` | **YES** |
| probe | `be19d23` | **YES** |
| mutagen | `55cf923` | **YES** |
| forge-critic | `d25faae` | **YES** |
| forge-analyst | `412b223` | **YES** |

Every accuracy figure in §3 describes the file that ships.

Two rows needed work to get there:

**acquirer** was the hard one. Its agent file was edited in the *same commit*
that reported its 36/36 run, so timestamps could not establish which revision
the run loaded, and the four fields S35 added all appear in the spec contract —
so finding them in the answers proved nothing. Two behavioural rules settled it,
both stated only in the agent file and neither derivable from the spec, since
the model never sees an expected value:

- `intra-batch-duplicates`: all 6/6 answered `item_count_integrated = 850`.
  That is `1000 - 30 - 120`. The "subtract intra-batch duplicates too" clause is
  a post-S35 addition; without it the arithmetic gives 970.
- `merged-drop-counts`: all 6/6 answered `dropped_for_format = 100`, i.e.
  `40 + 60`. The merge rule is also post-S35; reporting only the fetch-stage 40
  is the error that case exists to catch.

Six for six on each, in both arms. The post-S35 file was in the prompt.

**forge-critic** draws its two arms from separate reports, which is weaker than
a paired run. Both are still valid: no commit touched
`agents/evor-forge-critic.md` between them (08:20 and 16:55 on 08-21 — the only
same-day commit is the frontmatter-only retier at 21:13), the spec last changed
at 08:06 before both, and both reports cover the same 10 cases. What is not
controlled is run-to-run variation, so this row is the softest of the seven
despite being verified on file identity.

**S47 and S49 were reverted from this branch** rather than shipped unmeasured.
Both were agent-file edits committed after the runs that measured those files,
and their verification runs were killed. Neither fix is suspect — S49 targeted a
case weak in both arms, S47 removed a self-contradicting redirect — but
unmeasured is unmeasured. `evor/optimization-v2` carries both.

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
