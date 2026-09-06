# lite8 root causes — pooled over three runs

Single n=2 runs cannot separate a defect from a coin flip. Pooling lite6, lite7
and lite8 gives **6 observations per scenario**. The corpus and the agent files
changed between runs, so this measures STABILITY rather than one configuration —
which is exactly the question worth asking.

## The failures stratify sharply

| stratum | scenarios |
|---|---|
| **6/6 — never once passed** | `A3-critic-gate-codes-pos`, `E1-dead-identifier-neg`, `E4-mask-collision-reclassification-pos`, `T2-artifact-slot-target` |
| 5/6 | `A1-forge-fanout-role-target`, `L4-...-pos`, `T2-artifact-slot-control` |
| **fixed, trajectory visible** | `L3-pos` FN,FN,FN,FN,**TP,TP** · `L5-pos` FN,FN,FN,FN,**TP,TP** · `T5-no-slot-pos` FN,FN,**TP,TP,TP,TP** |
| 1–2/6 | nine scenarios — **noise at this sample size** |

The nine 1–2/6 scenarios are where I would do damage by "fixing" them. A cell
that fails once in six is not evidence of anything I can act on, and every edit
aimed at one is an edit whose effect I cannot measure.

## The four that never pass

**E4-mask-collision-reclassification-pos — the declaration watches the wrong tree.**
Its channel is `changed [.evor/runs/run-live-01/decision-log.md]`, written BARE.
`resolveGuardedPath` hashes a bare path in the REPO; the agent edits the sandbox
copy. Baseline null, after null, `changed` false. And the agent **did** write the
decision log — `Edit` on `check_under_test.py` and on `decision-log.md`, in the
same pass, exactly as its constraints now require. Six FNs from a missing path
prefix.

**E1-dead-identifier-neg — the discriminating fact is behind a call the agent
cannot know to make.** `condition.derivable_from` is
`/setup/tool_results/0/content/resolution` — the response of `resolve_doi`. The
identifier `10.1109/ICFHR.2016.39` appears nowhere in the fixture and nowhere in
the prompt. Six runs, **zero `resolve_doi` calls**. The agent searches, finds
nothing that supports the angle, and emits `no-evidence-for-angle` — which is
what an honest agent does and which is the scenario's own declaration channel.
The delta is real and unreachable.

**A3-critic-gate-codes-pos — the fixture does not meet mutagen's precondition.**
`active-run`'s tree.json holds **0 nodes**, and mutagen must mutate from a parent.
Its answer: "No parent node exists in tree.json to mutate from (tree is empty
with 0 nodes)." Same class as A1's Phase-1 gap, in a different role. It then asks
for clarification in PROSE rather than through `AskUserQuestion`, which the
declaration accepts — so even the blocked path scores FN.

**T2-artifact-slot-target — genuine.** It sends `tick=1`, the value of
`tick_count`, where the in-progress tick 2 is required. The tool description now
states the convention (`tick_count + 1`, "the number of COMPLETED ticks") and the
bundle it lives in is the one this config loads. The description did not change
the behaviour. **This one is the model, and it should be reported, not re-worded
a third time.**

## Proposal for lite9

**R1 — prefix E4's paths with `{{SANDBOX}}/project/`.** The guard and the
declaration must watch the tree the agent works in. *2 cells, deterministic.*

**R2 — put E1's identifier where the agent can find it.** The angle's finding
file or the prompt must name the DOI offered for this dataset, so `resolve_doi`
is a call the agent has a reason to make. Without that the pair cannot
discriminate its own delta. *2 cells, deterministic.*

**R3 — seed A3's parent node via `overlay`**, per-scenario and not in the shared
fixture, exactly as A1's Phase-1 seed was done — `A2-mutagen-artifact-route`
guards `ticks/1/mutagen/proposals.json` as must-not-appear and would break.
*2 cells, deterministic.*

**R4 — report T2, do not re-word it.** The convention is stated at the point of
use and the agent still sends the completed count. That is a finding about the
model, and the third rewrite of the same sentence would be tuning to the test.

**R5 — change nothing in the 1–2/6 stratum**, and do not read lite9's movement
there as signal either way.

## After lite9

R1–R3 are worth 6 deterministic cells. If they land, F1 goes to roughly 72–75%
and what remains is behaviour: mutagen not calling `evor_validate_proposals`,
probe's unstable verdict, the tick reporting clean over a retried failure, and
T2's tick. **None of those is fixable by editing the bench, and none is
measurable at n=2.** The run after lite9 should be repeats, not edits.
