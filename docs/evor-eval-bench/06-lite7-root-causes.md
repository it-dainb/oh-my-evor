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
