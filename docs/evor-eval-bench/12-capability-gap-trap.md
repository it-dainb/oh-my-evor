# The capability-gap trap: two correct decisions composing into an unpassable cell

Found by a delegated trace over lite14/17/18/19, verified here against the schema.
`L2-active-run-job-disagree-pos` is 7/8 FN and **no correct agent can pass it.**

## The composition

1. **The fixtures are genuinely schema-invalid.** Verified directly —
   `L2-active-run-job-disagree-pos/.evor/runs/m1/run-live-01/ticks/1/mutagen/proposals.json`,
   `proposals[0]`:

   ```
   keys present : proposal_id, name, approach_family, parent_node_ids
   MISSING      : idea, hypothesis, citations, wildness, critic_review
   EXTRA        : name
   ```

   Five of eight `MutationProposalSchema` required fields are absent.

2. **The tick is the only role that finds out.** Its task makes it traverse the run
   directory with the schema-validating tools: 45 of 77 tick records call
   `evor_doctor`, 55 of 77 call `evor_tree_read`. A role that reads one artifact
   through one tool never trips over it.

3. **Filing `capability-gap` is the correct response** — the value was not the
   tick's to produce, which is exactly what `evor-tick.md:197` reserves that kind for.

4. **Every subject-scoped declaration carries `not_arg: {"$.kind": "capability-gap"}`.**
   That exclusion is mine. It was right on its own terms: under defect 23 every role
   emitted a `capability-gap` about unregisterable sub-agents, and counting it scored
   TP on one half and FP on the other half of the same pair.

Compose 3 and 4: **the correct disclosure guarantees `declaration=false`, so the cell
can only score FN.** Both decisions are defensible alone. Together they are §4.5's
nothing-can-pass floor, violated.

## Why the floor check did not catch it

`check-detectors.mjs` builds its synthetic ideal run *from the scenario's own rule*,
so the probe emits precisely the subject-named signal the declaration wants. It never
emits a `capability-gap`, because nothing in the rule asks for one. The floor tests
the detector against itself; it cannot see a trap that only springs when the FIXTURE
gives the agent a second, legitimate reason to speak.

## A correction I owe

An earlier commit recorded the agents' repeated `tree.json missing updated_at`
reports as fabricated — layer 6. That was right for `updated_at` specifically:
`TreeNodeSchema` has no such field. But I let it stand for the broader pattern of
agents reporting schema-invalid artifacts, and **that broader pattern is real.** The
agents have been correct about the fixtures for four calibrations; I dismissed them
on the strength of one case where they were wrong.

## The fix

Make the fixtures schema-valid — `evals/bench/lifecycle/seed-fixtures.mjs`, the
generator, never the emitted JSON. That removes the legitimate reason to file
`capability-gap`, so the exclusion stops being a trap while still doing the job it
was added for.

**Falsifier:** if L2-pos still FNs with `declaration=false` once the fixtures
validate, the exclusion is too broad on its own and must be narrowed rather than the
fixture repaired.

NOT APPLIED: lite20 is in flight at `--repeats 6`, and re-seeding fixtures mid-run
would kill every scenario that starts after the write.

## Reach

This is not one cell. Every tick scenario reads the same fixture family with the same
validating tools, so any tick cell whose declaration is subject-scoped is exposed to
the same composition. It is the largest single contributor to the tick-vs-non-tick
gap (~43% against ~91%).
