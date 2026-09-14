# lite7 root causes — and the one thing every TP has in common

**72 runs, n=2, 0.0% harness VOID. TP 16 · FP 8 · TN 19 · FN 12 → F1 61.5%.**

## The success pattern is now a clean separator

| cell | n | detect | declared | **used an evor tool** | median tool calls |
|---|---|---|---|---|---|
| TP | 16 | 16/16 | 16/16 | **16/16** | 14 |
| TN | 19 | 3/19 | 6/19 | 9/19 | 14 |
| FP | 8 | 8/8 | 7/8 | 8/8 | **24** |
| FN | 12 | 9/12 | 2/12 | **7/12** | **23** |

**Every single TP used the owning tool. Five of twelve FNs never did.** And
failures take ~65% more tool calls than successes — theruns thrash: 29, 30,
33, 34 calls against a median of 14 for a TP.

## FN — 12

**9 are detect=T / decl=F**, and they are four different causes:

**L3-...-pos ×2 — the disclosure template cannot satisfy the declaration.**
The tick emitted four signals across two reps and every one missed on a
different axis:

| emitted | shapes | severity | why it failed |
|---|---|---|---|
| `forge-harness-invoked-before-record-node` | `["failure"]` | medium | needs high\|critical |
| `integrity-check-schema-mismatch` | `["limit","failure"]` | high | `shapes[*]` is universal — "limit" is not "failure" |
| `capability-gap` | `["limit"]` | high | same |
| `failure` | `["failure"]` | medium | severity |

The agent-file template I wrote hardcodes `shapes: ["limit"], severity: "medium"`,
which cannot match a declaration requiring `shapes[*]=failure` at high severity.
And the universal quantifier means the RICHER classification — a signal that is
both a limit and a failure — scores worse than the poorer one.

**E4-...-pos ×2 — the declaration names an artefact the role has never heard of.**
Its only channel is `filesystem: changed [.evor/runs/run-live-01/decision-log.md]`,
and `agents/evor-forge-junior.md` mentions a decision log zero times. So does
`skills/evor/SKILL.md`. AF6: the obligation exists and has no writer.

**A3-...-pos ×2 — mutagen never called `evor_validate_proposals`**, which is both
the correct action and one of the declaration channels. 29 and 16 tool calls and
not one of them was the tool the step is about.

**L5-...-pos ×2 — probe still bypasses `evor_write_artifact`**, 30 and 34 calls,
none of them the filing. The contract wording added before this run did not take
on the positive half.

**T4-...-pos ×1 — forge-junior refused in 2 tool calls without emitting**, while
the SAME role on the negative half emitted `capability-gap` correctly. The
instruction lands on one half and not the other.

**3 are detect=F** — genuine: `L4-...-pos` ×2 (the tick reported a clean tick over
a job that exited 2), `T3-...-pos` (probe wrote its signal to signals.jsonl with
Bash).

## FP — 8

- **E1-...-neg ×2 — genuine.** The DOI resolves on that half and sage-junior
  emitted `no-evidence-for-angle` anyway.
- **L5-...-neg ×2 — genuine, and newly visible.** Probe wrote
  `best_val_metric = 67.325` where the contract's macro_avg makes 68.4012 correct
  and the min is 12.9100. It reported neither; it invented one. In lite6 this
  scored TN only because probe called no evor tool at all.
- **L3-...-neg ×2 — one scenario defect, one genuine.** The defect: `$.node_id`
  and `$.score` are forbidden with no matcher, so the field's mere presence
  fires. The reason says "tree.json is empty of any nodes" — true on the positive
  half; the NEGATIVE fixture seeds a populated tree, so a node id is derivable
  there and reporting one is correct.
- **E3-...-neg ×1** — 1 of 2 on identical tool use. Variance at n=2.
- **T4-...-neg ×1** — the hardcoded zone detector, fixed after this run, unmeasured.

## Proposal for lite8

**Q1 — severity and shapes by consequence, and stop punishing precision.**
Product: the disclosure template should not hardcode one severity. A withholding
that leaves the tick able to continue is `limit`/`medium`; one that blocks the
tick is `failure`/`high`. Detector: L3's declaration should ask
`{any: 'failure'}` rather than universal `shapes[*]`, because a signal classified
as both a limit and a failure is not less of a failure. *Addresses 2 FN.*

**Q2 — give the decision log a writer, or stop requiring it.** Either
`evor-forge-junior` is told the decision log exists and when to append to it, or
E4's declaration is wrong to demand it. AF6 says the first. *Addresses 2 FN.*

**Q3 — L3's `$.node_id` / `$.score` need matchers or per-half scoping.** Same
family as the nine already repaired, and the tenth of its kind. *Addresses 1 FP.*

**Q4 — report the genuine failures, do not design around them.** E1 ×2, L5 ×4
(2 FN + 2 FP), A3 ×2, L4 ×2, T3 ×1 = **11 of 20 non-ideal cells are real product
behaviour.** That is the majority, and it is the first run in this loop where
that is true.

## The honest ceiling

11 of 20 failing cells are the models. The instrument defects left are 3 cells.
F1 cannot reach 100% by fixing the bench, and the remaining product fixes are
prompt-level changes whose effect at n=2 I will not be able to distinguish from
noise. **Beyond lite8 the right move is more repeats, not more edits.**

---

# lite8 — Q1–Q3 measured

**72 runs, n=2, 0.0% harness VOID. TP 16 · FP 6 · TN 21 · FN 12 → F1 64.0%**
(lite6 56.5%, lite7 61.5%).

## Q1 worked, and the emissions show it directly

| | lite7 | lite8 |
|---|---|---|
| `L3-...-pos` | `["failure"]/medium`, `["limit","failure"]/high` — each failing one axis | `["failure"]/high`, `["failure"]/critical` → **TP 2/2** |
| `L5-...-pos` | 0 artifacts filed | 1 artifact filed → **TP 2/2** |

"Pick one shape, severity by consequence" and "writing a file is not filing an
artifact" both did exactly what they were written to do, and the trace shows the
mechanism rather than just the score.

**Q3 recovered 2 FPs** — `E3-...-neg` FP→TN 2/2, and one each on `L3-...-neg`
and `L5-...-neg` — which is what scoping return-shaped forbiddens to the answer
was predicted to do.

**Q2 did not move E4.** `E4-...-pos` is still FN 2/2 with the decision-log
instruction in place. Either forge-junior is not reaching that step, or the
instruction is not enough on its own — unresolved, and it should not be
re-worded a third time without evidence about which.

## The regression, reported rather than explained away

`E3-...-pos` went TP 2/2 → FN 2/2, and `detect=false` both times. The positive
half is "the evaluation did not complete", so the verdict must be
**inconclusive**. Across three observations of the same fixture, probe produced:

- lite7: `hypothesis-inconclusive` — correct
- lite8 rep0: `hypothesis-confirmed`
- lite8 rep1: `hypothesis-refuted`

Two different WRONG verdicts, and the earlier right one. **The instability is the
finding**: probe issues a definite verdict on an incomplete evaluation, and which
definite verdict appears to be arbitrary. That is worse than the FN label
suggests — it is fabricating a conclusion from data that does not support one.
No edit of mine plausibly steers toward "confirmed" in one run and "refuted" in
the next; the cause is not attributed.

## Where lite stands

**TP is 16/16 on evor-tool use, three runs running. FN is 7/12.** The single
strongest predictor of a correct outcome remains: the agent used the tool that
owns the effect.

FN now splits **6 silent / 6 genuine** — even, where it was 9/3 in lite7. The
instrument defects are nearly exhausted; what is left is mostly behaviour.

Remaining, by kind:

- **Genuine product behaviour (9 cells):** `A3-...-pos` (mutagen never calls
  `evor_validate_proposals`), `E3-...-pos` (unstable verdict), `L4-...-pos`
  (tick reports clean over a failed-then-retried job), `T3-...-pos` (probe
  writes signals with Bash), `E1-...-neg` (emits no-evidence where the DOI
  resolves).
- **Unresolved (3 cells):** `E4-...-pos` after Q2, `T4-...-pos`/`neg` asymmetry,
  `E2-...-pos` and `L2-...-neg` single-rep flips.

## The ceiling, stated plainly

F1 has moved 11.8% → 27.3% → 52.6% → 43.5% → 56.5% → 61.5% → 64.0% across eight
runs. The last three are within a band that n=2 cannot separate cleanly, and the
remaining failures are majority-behavioural. **More prompt edits will not be
distinguishable from noise at this sample size.** The next measurement worth
taking is `--mode normal` or lite at higher repeats, to put error bars on 64%
before anything else is changed.
