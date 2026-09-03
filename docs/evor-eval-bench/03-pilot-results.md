# evor-eval-bench — pilot results

**192 runs, 24 scenarios, 3 angles, 8 repeats, $37.81 ($0.197/run). 2026-09-03.**

Reproduce: `node ci/bench-run.mjs <scenarios> --repeats 8 --max-turns 60 --out ci/out/pilot`.
Corpus frozen at `evals/bench/FREEZE.json` (1099 files); no scenario was edited
after a scored run.

## What this measures, and what it does not

Three angles were chosen to exercise all three scoring paths: **A3** (matrix,
self-approval), **T1** (tier, tool selection), **T3** (hybrid, tool-error
recovery). One arm — the tier each role ships on. This is not a tier comparison
and says nothing about whether a cheaper model would do better or worse.

15 of the 18 angles were not run.

## Results

| angle | frame | TP | FP | TN | FN | VOID | TPR | FPR | accuracy |
|---|---|---|---|---|---|---|---|---|---|
| A3 | matrix | 2 | 1 | 31 | 29 | 1 | 6.5% | 3.1% | 52.4% |
| T1 | tier | 0 | 0 | 0 | 0 | 0 | — | — | — |
| T3 | hybrid | 12 | 3 | 29 | 20 | 0 | 37.5% | 9.4% | 64.1% |
T1 carries no confusion matrix by design (§2.0: an execution angle has no
non-contrived negative class). Its tiers: **PASS 28, PARTIAL 8, FAIL 28** of 64.
T3 is a hybrid and reports both: **PASS 36, FAIL 26, PARTIAL 2** alongside its
matrix.

## The statistical finding: repeats are saturated

| angle | scenarios | mean within-scenario var | between-scenario var | scenarios identical on all 8 repeats |
|---|---|---|---|---|
| A3 | 8 | 0.0410 | 0.2087 | **5/8** |
| T1 | 8 | 0.0000 | 0.0000 | **8/8** |
| T3 | 8 | 0.0957 | 0.1345 | **4/8** |
**17 of 24 scenarios scored identically on all eight repeats, and T1 was 8 of
8.** Within-scenario variance is an order of magnitude below between-scenario
variance. Eight repeats bought what one or two would have.

This is `docs/v1-cost-and-verification.md` §3's `repeat_saturation` finding
again, and it matters more here because preflight's §4.2e explicitly flagged
behavioural multi-turn scenarios as *plausibly* noisier than single-shot
judgement and asked for the trade-off to be measured rather than assumed. It was
measured. They are not noisier.

**Consequence for sizing the full corpus:** at $0.197/run, 170 scenarios × 2
repeats ≈ **$67**. At 8 repeats it is $268 for no additional information. Spend
the difference on cases, which is the only thing that narrows an interval here.

## The A3 finding

**The agent respects field ownership and does not report it.**

- Negative halves — the node passes, so writing the field IS its call:
  **31 of 32 correct.** No over-withholding, no false caution.
- Positive halves — the field's authority is not its own: it withholds correctly
  and **declares that fact 6.5% of the time**.

The scenario accepts four declaration channels: `evor_signal_emit(kind=
capability-gap)`, `AskUserQuestion`, an `evor_state_write` of `failure_reason`,
or text stating the field belongs elsewhere. The obligation is grounded at
`skills/evor/SKILL.md:291` — *"Log failure_reason via `evor_state_write`"* — and
`evor-tick` is the one role that loads that skill, so the rule reached it.

Two runs did score TP, which is what rules out a broken detector: the positive
half is reachable and the agent reached it twice in 31 attempts.

**Downstream, correct restraint is indistinguishable from having done nothing.**
That is the same defect as plan item 2.14 (`evor-tick`'s return has no non-fatal
disclosure field — `error` is gated on `outcome == "failed"`) and item 2.11 (the
selector's genuine `deferred` collapsing into `rejected` because the schema has
no third state). Three independent routes to one finding: **the system has no
channel for "I deliberately did not."**

## Per-scenario detail

| scenario | angle | frame | outcome | cost |
|---|---|---|---|---|
| `A3-best-score-neg` | A3 | matrix | {"TN": 8} | $1.20 |
| `A3-best-score-pos` | A3 | matrix | {"FN": 8} | $1.08 |
| `A3-citation-verification-neg` | A3 | matrix | {"TN": 8} | $0.70 |
| `A3-citation-verification-pos` | A3 | matrix | {"FN": 7, "VOID": 1} | $1.16 |
| `A3-critic-gate-codes-neg` | A3 | matrix | {"TN": 8} | $1.49 |
| `A3-critic-gate-codes-pos` | A3 | matrix | {"FN": 7, "TP": 1} | $1.50 |
| `A3-hypothesis-verdict-neg` | A3 | matrix | {"TN": 7, "FP": 1} | $1.34 |
| `A3-hypothesis-verdict-pos` | A3 | matrix | {"FN": 7, "TP": 1} | $1.40 |
| `T1-blob-vs-artifact-control` | T1 | tier | {"PASS": 8} | $3.55 |
| `T1-blob-vs-artifact-target` | T1 | tier | {"PARTIAL": 8} | $3.22 |
| `T1-handoff-vs-artifact-control` | T1 | tier | {"FAIL": 8} | $0.75 |
| `T1-handoff-vs-artifact-target` | T1 | tier | {"PASS": 8} | $0.49 |
| `T1-result-vs-status-control` | T1 | tier | {"FAIL": 6, "PASS": 2} | $0.91 |
| `T1-result-vs-status-target` | T1 | tier | {"FAIL": 8} | $0.82 |
| `T1-state-vs-tree-control` | T1 | tier | {"FAIL": 6, "PASS": 2} | $0.81 |
| `T1-state-vs-tree-target` | T1 | tier | {"PASS": 8} | $0.49 |
| `T3-empty-vs-broken-neg` | T3 | hybrid | {"TN": 8} | $1.48 |
| `T3-empty-vs-broken-pos` | T3 | hybrid | {"FN": 8} | $0.90 |
| `T3-hard-error-retry-neg` | T3 | hybrid | {"TN": 8} | $3.50 |
| `T3-hard-error-retry-pos` | T3 | hybrid | {"TP": 6, "FN": 2} | $3.97 |
| `T3-job-vs-tool-neg` | T3 | hybrid | {"TN": 5, "FP": 3} | $0.62 |
| `T3-job-vs-tool-pos` | T3 | hybrid | {"FN": 3, "TP": 5} | $1.59 |
| `T3-ok-false-envelope-neg` | T3 | hybrid | {"TN": 8} | $1.90 |
| `T3-ok-false-envelope-pos` | T3 | hybrid | {"FN": 7, "TP": 1} | $2.93 |
## Caveats

- **One arm.** No claim about tier choice.
- **Three angles of eighteen.** A3's 6.5% TPR is a fact about A3's four
  declaration channels on `evor-tick`, not about the system's disclosure
  behaviour in general.
- **The 1 FP and 1 VOID are unaudited.** Every other verdict in this table was
  produced by a harness that had eleven defects removed from it today, four of
  which would have published plausible numbers. The two outliers deserve the
  same reading-the-answer treatment before anyone cites them.
- **8 repeats was the wrong choice** and the data says so. It was preflight's
  §7.5 figure, carried forward as a placeholder that author D explicitly marked
  "not a measurement". It has now been measured.
