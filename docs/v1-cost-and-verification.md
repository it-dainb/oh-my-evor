# Evor v1 retier: cost breakdown and verification status

What this branch (`evor/optimization-s0-s6`) changed, what the evidence for each
row actually is, and what is explicitly NOT verified. Every cost figure is
**billed** (`cli_cost_usd` from the CLI), never modeled — see the tier-asymmetry
note at the end for why that distinction is not cosmetic.

## 1. Shipped tiers — all twelve agents

Gate for shipping a tier change: **accuracy ≥95% absolute, difference CI clears
−10pp, both arms from one paired run, material cost saving.** All four, or the
role keeps its `main` tier.

Item 8.1 re-ran every row against that gate with the instrument corrected (tools
attached) and the arithmetic corrected (n = cases, not calls). **Two shipped
retiers no longer meet it** — sage and mutagen, both on haiku; see §3. A third
row changed character rather than status: tick ships on sonnet, the dearer arm,
so it was never a retier — 8.1 simply benchmarked it for the first time.

The gate did not change; what changed is that it is now applied to a measurement
of the thing it names.

| agent | main | release | status |
|---|---|---|---|
| evor-sage | opus | **haiku** | ships — **margin NOT SHOWN at 8.1**, and 92.3% is below the 95% floor |
| evor-mutagen | opus | **haiku** | ships — margin **NOT SHOWN** at 8.1 (upper bound sits exactly on +10.0pp) |
| evor-probe | opus | **haiku** | ships |
| evor-acquirer | sonnet | **haiku** | ships |
| evor-selector | opus | **haiku** | ships — **not** re-measured at 8.1 (legacy cases.json path) |
| evor-forge-junior | sonnet | sonnet **`effort: low`** | ships — **not** re-measured at 8.1 (legacy cases.json path) |
| evor-tick | — (new) | sonnet | ships; benchmarked at 8.1 — sonnet 80.0% vs haiku 20.0% |
| evor-forge-critic | opus | opus | reverted — arms unpaired |
| evor-forge-analyst | opus | opus | reverted — 93.5% |
| evor-sage-junior | sonnet | sonnet | reverted on figures 8.1 does not reproduce (78.2% / 83.6%) |
| evor-forge-architect | opus | opus | reverted on a regression that **does not reproduce** at 8.1 (CI [+0.0, +0.0]) |
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

## 3. Accuracy evidence, per row — RE-MEASURED (item 8.1)

**The numbers in this section replace the originals. The originals were wrong in
two ways, and both are reproducible.**

*Wrong n.* Every difference CI here used n = CALLS. `36/36` was twelve cases run
three times; `116/120` was ten cases run twelve times. Repeats of one case are
not independent observations of a role — that n asks the same question twelve
times and reports the confidence of having asked twelve different ones. Run
`node ci/recompute-v1-cis.mjs`: fed the published call counts it returns the
published intervals to the decimal, then recomputes them on cases. **All seven
adopted rows failed the 10pp gate they were published as clearing.**

*Wrong instrument.* The corpus behind those numbers contained zero `tool_use`
blocks, in a system where every role's job is to call tools — the harness
ordered the agent not to call any and scored what a tool would have returned
from an inlined payload. Item 7.1 attached the MCP server; item 8.1 re-ran
everything through it.

Re-measured: 9 specs, both arms per spec from one process against one agent file
read once, 5 repeats, **930 calls, $274.44 billed, 0 harness errors**. The
interval is a cluster bootstrap over cases, which estimates the real quantity
rather than bounding it.

`node ci/analyze-81.mjs docs/evidence/matrix-81.json` reproduces this table.
That digest is committed and carries every call's tier, case and status plus
each run's `agent_sha256` and `spec_sha256`; the raw reports live under the
ignored `ci/out/`, so a table reproducible only from those would be reproducible
only on the machine that produced it.

| role | dearer | cheaper | difference | 95% CI (cases) | verdict |
|---|---|---|---|---|---|
| acquirer | sonnet 100.0% | **haiku 98.3%** | +1.7pp | [+0.0, +5.0] | **non-inferior** |
| probe | opus 100.0% | **haiku 98.2%** | +1.8pp | [+0.0, +5.5] | **non-inferior** |
| mutagen | opus 100.0% | **haiku 96.0%** | +4.0pp | [+0.0, +10.0] | NOT SHOWN |
| forge-architect | opus 98.0% | sonnet 98.0% | +0.0pp | [+0.0, +0.0] | **non-inferior** |
| sage | opus 95.4% | **haiku 92.3%** | +3.1pp | [−3.1, +10.8] | NOT SHOWN |
| forge-critic | opus 98.0% | sonnet 88.0% | +10.0pp | [−2.0, +28.0] | NOT SHOWN |
| forge-analyst | opus 100.0% | sonnet 86.7% | +13.3pp | [+3.3, +25.0] | NOT SHOWN |
| sage-junior | sonnet 78.2% | haiku 83.6% | −5.5pp | [−32.7, +21.8] | NOT SHOWN |
| tick | sonnet 80.0% | haiku 20.0% | +60.0pp | [+30.0, +90.0] | NOT SHOWN |

Bold marks the tier that ships. **"NOT SHOWN" is not "worse"** — it means this
evidence does not establish non-inferiority for that role, which is the only
claim the design supports.

### What changed, and what it costs

**sage is the clearest live risk** (see mutagen below for the second). It ships
on haiku and its margin is not established: upper bound +10.8pp against a 10pp gate. The gap itself is small
(+3.1pp, 92.3% vs 95.4%) and thirteen cases cannot resolve it either way. The
old row published `[−9.5, +3.6] non-inferior` — that interval was the n=calls
artifact. Either sage gets more cases or its haiku tier is running on evidence
that does not reach the bar this project set.

**forge-architect's regression does not reproduce.** §1 records it as
`reverted — 93.3%, CI −10.0pp`. With tools attached, sonnet ties opus exactly
across 50 paired calls, CI [+0.0, +0.0]. The revert cost $0.0785/call and was
made on an instrument that has since been shown defective; it is now the
best-evidenced candidate for reinstatement in the backlog.

**tick is benchmarked.** §1 has carried `ships, never benchmarked` since it
landed. Sonnet 80.0% against haiku 20.0% — a 60pp gap, interval nowhere near the
margin. Its sonnet tier is load-bearing and the cheap retier is off the table.
Four cases, so the interval is wide; the direction is not in doubt.

**sage-junior moved in both directions and resolves nothing.** Both arms fell
far below their published figures (78.2% and 83.6% against 93.9%/87.9%), and
haiku scored *above* sonnet — the only row where the cheaper arm leads. Its
revert was made on numbers this instrument does not reproduce, and the
replacement interval [−32.7, +21.8] decides nothing at eleven cases.

**acquirer and probe hold.** Both ship on haiku and both clear the gate under
the corrected instrument, with real room: upper bounds of +5.0pp and +5.5pp.

**mutagen sits exactly on the margin and therefore does not clear it.** Its
upper bound is +10.0pp against a 10pp gate — the interval touches the margin
rather than excluding it, so the claim is not established. This row printed
"non-inferior" until the boundary was examined: the bootstrap upper bound
computes as 0.09999999999999998 and cleared a `< 0.10` test by 2e-17. The true
97.5th percentile is exactly 0.10, because the per-case differences are discrete
(eight cases at 0.00, two at 0.20) and the percentile lands on one of them.
A verdict decided by float representation is not a verdict, so the tie is now
resolved against adoption — the direction a non-inferiority test should fail in.
mutagen ships on haiku, and the honest reading is that its margin is unresolved
at ten cases, not that it is worse: the measured gap is +4.0pp.

That the corrected instrument moved rows in **both** directions — reinstating
forge-architect, undermining sage, sinking tick's cheap arm — is the reason to
trust it over the original. An instrument that only ever flattered the cheap
tier would be the more suspicious result.

### Not covered by this re-measurement

`evor-selector`, `evor-forge` and `evor-forge-junior` have no `spec.json`; they
run on the legacy `cases.json` path with their own runners and were **not**
re-measured. Selector's shipped haiku tier and forge-junior's `effort: low` rest
on the original instrument, and §2 prices selector's saving at 22.5% on that
basis. Their rows are unverified in the sense this section now means by verified.

### The precision ceiling

More budget cannot fix these intervals. Across the run, within-case variance is
6.4e-3 against between-case 5.7e-2 — an order of magnitude apart, so repeats
have already stopped buying precision and only more CASES will narrow anything.
That is a case-authoring problem, and the specs are exactly what item 8.x found
four defects in. Spending on repeats here would buy the appearance of rigour and
none of it.

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

**Two further agent-file fixes are not on this branch at all.** Both were
written after the runs that measured those files, and their verification runs
were killed before producing a report, so shipping them would have meant
shipping a prompt no measurement describes. Neither is suspect — one targeted a
case weak in both arms, the other removed a self-contradicting redirect — but
unmeasured is unmeasured. They live on `evor/v2-optimize`, which exists to
measure them.

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
