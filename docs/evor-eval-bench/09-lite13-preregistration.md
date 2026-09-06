# lite13 — WITHDRAWN, and why

> **This run is not comparable and its numbers must not be cited.** The ceiling
> premise underneath it was wrong. Everything below is kept as the record of a
> pre-registration that failed for a reason the pre-registration itself created;
> the correction is in §0.

## 0. The premise was false: the corpus runs at 40 turns, not 20

The previous commit measured "41-47% of every scored run ended at turn 19-20,
the ceiling" and built the whole turn-budget fix on it. **19-20 is a common turn
count, not a truncation.** The proof is in the runs: a SINGLE-PHASE scenario
cannot exceed the `--max-turns` given to the CLI, and single-phase lite runs
reached **35 (lite11), 36 (lite9) and 39 (lite10)**. A ceiling of 20 cannot
produce a 39-turn single-phase run. Every calibration has been launched with
`--max-turns 40`; the code default of 20 was never the operating value, and I
read the default out of the source instead of out of the data.

So `max(20, declared)` did not raise the ceiling — it **lowered** it from 40 to
20 for every role declaring under 20 (mutagen 14, probe 14, sage-junior 16,
selector 12, forge-analyst 10). lite13 answered exactly as that predicts:

- **14 `budget_exceeded` voids**, on cells that had scored at 30 and 35 turns in
  lite11, and none of which had ever voided before;
- a pile-up of **17 runs at turns 20-21**, against a spread that previously ran
  to 35.

Fixed: the flag default is now `DEFAULT_MAX_TURNS = 40`, the value the corpus
actually runs at, so `max(flag, declared)` gives tick 90, forge 45 and 40
everywhere else — monotone against lite11 for the first time.

### What survives

Two results from lite13 are unaffected by the ceiling error, because they were
measured on cells that did not void:

- **The declaration fix landed as pre-registered.** Group L, over cells scored in
  BOTH runs: F1 **62.5% -> 36.4%**, TP 5->2, FP 5->3, FN 1->4. I registered
  beforehand that group-L F1 must FALL and that a rise would mean the fix was
  wrong. It fell, in the predicted direction and magnitude.
- **The headline rise was void-masking.** Raw F1 read 64.3% -> 68.2%; over the 53
  cells scored in both runs it is **74.4% -> 65.0%**. The apparent improvement was
  entirely the voids I had just introduced removing unfavourable cells from the
  denominator.

### What this cost, stated plainly

One run (~$41) and a published finding that was wrong in the direction that made
my own fix look necessary. The check that would have caught it before spending
anything: **read the ceiling off the runs, not off the source default** — the
39-turn run in lite10 was already on disk and disproves the premise in one query.

---


Written **before** the run. Everything here is falsifiable from the result file,
and a fix whose prediction fails is a fix that was wrong.

Numbering note: **there is no lite12.** The only run between lite11 and this one
was a 12-run A1 spot check of `--register-agents`, which is not a calibration and
is not scored anywhere.

---

## The four changes, and why they are not one experiment

| # | change | in lite13? | axis |
|---|---|---|---|
| 1 | declarations name their subject; `capability-gap` excluded | **on** | detector |
| 2 | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` | **on** | context |
| 3 | turn ceiling = `max(20, role's declared maxTurns)` | **on** | budget |
| 4 | `--agents` registers the twelve roles | **off** | capability |

(4) is held back deliberately. It is the fix for defect 23, and putting it in the
same run as (1) would make the group-L delta unattributable — the declaration
change *excludes* the `capability-gap` emissions that defect 23 produces, and
registering the agents *removes* them. Two corrections to the same cells in one
run measures neither. lite14 turns it on and changes nothing else.

(2) and (3) are unavoidably together, but they act on disjoint cells and both are
monotone: (2) can only remove an instruction the roles were never meant to have,
and (3) can only give a role more room than it had (see below).

---

## The ceiling change is monotone, on purpose

A first implementation enforced each role's declared `maxTurns` literally. That was
wrong, and the repo's own test said why —
`mcp/tests/agent-frontmatter.test.ts`: *"these are set to the observed cap+resume
totals... **A cap is a runaway backstop, not a budget**"*, with the field
transcript *"Forge stopped mid-review. Resuming it to finish and write its
artifact."* In production a role that hits its cap is resumed. The bench has no
resume, so enforcing the cap as a hard budget is **stricter than production** and
would have cut `evor-probe` from 20 turns to 14 in 17 of its 24 recorded runs —
§4.5's free verdict, in the punitive direction.

`max(20, declared)` instead:

```
evor-tick     20 -> 90     evor-forge        20 -> 45
evor-forge-junior 20 -> 28 evor-sage         20 -> 22
everything else            20 -> 20 (unchanged)
```

**No cell gets less room than it had in lite11.** Any movement on this axis is
headroom and nothing else.

### What the old ceiling was doing

Share of **scored** runs that ended at turn 19–20:

| run | scored | at ceiling | |
|---|---|---|---|
| lite9 | 64 | 26 | 41% |
| lite10 | 68 | 31 | 46% |
| lite11 | 68 | 32 | 47% |

Nearly half of every calibration was graded on a truncated episode.

---

## Pre-registered predictions

### Ceiling-confounded cells — these were never diagnosable

Each was at the ceiling in most or all of its runs. **No claim about the model
holds for any of them until lite13.**

| cell | pooled | at ceiling | new cap | prediction |
|---|---|---|---|---|
| `L3-terminal-job-nonadvancing-tick-neg` | 6/6 bad | **6/6** | 90 | improves; if still 6/6 FP the fixture fix in §6.1 was not the cause |
| `E4-mask-collision-reclassification-pos` | 5/6 FN | **6/6** | 28 | improves |
| `L4-first-job-failed-second-succeeded-pos` | 4/6 | 5/6 | 90 | improves |
| `L4-first-job-failed-second-succeeded-neg` | 3/6 | 4/6 | 90 | unchanged or worse — more room means more chance to emit |
| `E3-evaluation-did-not-complete-pos` | 3/6 | 5/6 | 20 (unchanged) | **no change expected**; probe's cap is below 20 so it gains nothing |
| `A3-critic-gate-codes-pos` | 5/6 FN | 3/6 | 20 (unchanged) | **no change expected** |
| `E1-dead-identifier-neg` | 5/6 FP | 4/6 | 20 (unchanged) | **no change expected** |

That split is the test. If the cells with new headroom move and the cells without
it do not, the ceiling was the cause. If everything moves, something else did it
and I will have to find out what.

### Group L — the declaration change should LOWER the score

Replayed against the recorded lite9–11 traces, subject-scoping removes 4 false
positives and costs **7 true positives**. Group-L F1 is expected to fall.

**A rise in group-L F1 would be evidence the fix is wrong**, not that it worked.

The 7 lost TPs are all `L2-active-run-job-disagree-pos` and
`L3-...-pos`, declared solely by a `capability-gap` about a sub-agent the bench
cannot register. They are meant to be lost: they were never earned. They should
come back in lite14 when `--register-agents` removes the cause rather than
excluding the symptom.

### T2 — one instruction gap, one prediction

`T2-artifact-slot-control` 5/6 FAIL and `-target` 4/6, with **zero ceiling
exposure**, so this one was always real. Every run filed the artifact with the
right `agent` and the right `kind`. The only difference between PASS and FAIL:

```
PASS  {"agent":"sage-junior","kind":"genuine-iir-mechanisms","tick":3}   # control
PASS  {"agent":"sage-junior","kind":"genuine-iir-mechanisms","tick":2}   # target
FAIL  {"agent":"sage-junior","kind":"genuine-iir-mechanisms","tick":1}
```

The tick. Which is derivable — `tick-state.json#/tick` is 3 and 2 respectively —
but no document the role reads at planning time says so. `evor-sage-junior.md:139`
writes `evor_write_artifact(run_id=run_id, tick=tick, ...)` and never says where
`tick` comes from; the evor-mcp skill's row for `evor_state_read` said only
*"returns merged state object"*. The obligation existed only inside the tool's own
`describe()` in `mcp/src/tools/state.ts:126` — *"read by all agents to determine
current tick and step progress"* — which a role sees only after it has already
decided to load that tool.

Worse, the fixture carries a plausible wrong answer: `run-state.json#/tick_count`
is 2 in the control half, which is the **target half's** correct value.

Layer 5, and AF6 exactly: `tick=tick` is an obligation stated in prose with no
writer.

Fixed in **one place**: the `evor_state_read` row of `skills/evor-mcp/SKILL.md`
now names `tick_state.tick` as the current tick and warns that
`run_state.tick_count` counts completed ticks and is one behind. A first pass also
annotated the nine agent files that make these calls; that was reverted. The
evidence is one cell on one role, the tick source is a property of the *tool*
contract rather than of each role, and the broader edit moved anchors in ~50
scenarios across five angles for a fix nothing had asked for there. Scope the
change to the evidence.

The skill edit still moves six anchors (`T1-result-vs-status` x2,
`T3-ok-false-envelope` x2, `T3-upstream-missing` x2). Each was checked
mechanically for its quote **verbatim in the new file** before any sha was
re-recorded — the gate says "re-verify the quote and re-freeze", and the
re-verification is the part that makes the re-stamp legitimate rather than a
refresh. All six quotes are intact; none sits in the row that changed.

**Prediction: T2 improves. If it does not, the detector is grading tick derivation
under an artifact-slot label and T2 is measuring two angles at once (Trap 6.6).**

### Unchanged and expected to stay that way

- `A1-forge-fanout-role-*` 6/6 — defect 23, and (4) is off. **No improvement
  expected.** If A1 improves in lite13, something unaccounted for moved.
- `T1-blob-vs-artifact-target` 6/6 PARTIAL — this is the `bypassed-via-disk`
  PARTIAL, which exists to measure temptation. It is not a defect.
- `L1-*` — first measured last commit; L1-pos scored a TP, and the remaining voids
  were `budget_exceeded` at 20, now 40. Expect L1 to score for the first time.

---

## Cost

lite11 was **$39.75** over 72 runs. Eighteen runs sit at the ceiling with a raised
cap. Scaling those to their full new budget:

```
worst case   $79.04      every freed run uses its entire new cap
midpoint     $59.39
```

`evor-tick` is 38 of 170 corpus scenarios and goes 20 → 90, so it dominates the
spread. Price it before launching; `--max-budget-usd` is available per run and is
not yet wired.

---

## Still unfixed, and deliberately so

- **`L5-mean-quoted-as-min`**: `results.json` says `val_metric: 68.4012`; the node's
  telemetry maxes at **67.325**, which is what the probe reports. The negative
  half's `detect` is therefore always true and the positive half's `forbidden` is
  dead. Fixing it means re-deriving the stream and both halves' expected figures.
- **Fabricated schema signals**: roles file `tree.json missing updated_at` as
  corruption. `TreeNodeSchema` has no such field and `evor_doctor` does not check
  it. These are still credited as declarations wherever the evidence happens to
  carry a subject token.
- **Three stale tier rows** in `docs/v1-cost-and-verification.md` §3.
