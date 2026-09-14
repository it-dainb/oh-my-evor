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

---

# lite10 — the two harness defects were worth 8 F1 points, and corrected me twice

**72 runs, n=2. TP 22 · FP 7 · TN 21 · FN 6 → F1 77.2%. Zero voids of any kind.**

| | before | lite10 |
|---|---|---|
| `Skill` calls / errors | 37 / **37 failed** | **0 / 0** |
| undeclared denials | 3 (voided T4) | **0** |
| voids | 4 | **0** |

`Skill` calls fell to zero not because the roles stopped asking but because they
no longer need to: the procedure is in the prompt where their frontmatter says
it should be.

## Two "genuine behavioural failures" were the missing skill

`T3-hard-error-retry-pos` FN,FN → **TP,TP**, and
`E3-evaluation-did-not-complete-pos` FN,FN → **TP,TP**.

Both were in my "report it, do not design around it — this is the model" list.
Both were the harness denying the role the nine-step procedure its own
frontmatter declares. **The classification was wrong, and it was wrong in the
direction that flatters the instrument**: calling a cell behavioural closes the
investigation, and closing it early is how a harness defect gets published as a
model defect.

The rule that caught it: a scenario that passes once and fails once on a
byte-identical fixture is a natural experiment, not a coin flip. Every run has a
call sequence and stated reasoning, and the divergence between them names its
own cause — an instruction that underdetermines the behaviour, or a tool, hook
or harness that underdetermines the instruction. "Noise" is what that looks like
from the verdict column with the transcripts unopened.

## What moved

Recovered: `E1-...-pos` TP,TP · `E3-...-neg` TN,TN · `A4-...-neg` TN,TN ·
`E4-...-pos` FN,FN → TP,FN · `L4-...-pos` FN,FN → FN,TP · `E1-...-neg` and
`T4-...-neg` now SCORE instead of voiding.

Regressed, all single-rep flips: `A3-...-pos`, `L2-...-neg`, `L4-...-neg`,
`T5-no-slot-pos`, `L5-...-pos`, `T2-artifact-slot-target`.

## Where it stands

F1 across the loop: 11.8 → 27.3 → 52.6 → 43.5 → 56.5 → 61.5 → 64.0 → 69.2 →
**77.2**, and lite10 is the first with no voids at all, so nothing is masked.

Six FN and seven FP remain. The FN are now the smallest they have been, and the
FP rose — which is worth watching rather than explaining, because injecting the
skills changed what every role sees and this is a new baseline, not a delta.
