# `kind` is open and closed at the same time, and the bench pays for it

A layer-4 find — two documents the same role reads, disagreeing. The skill calls
this the highest-value kind of defect and the hardest to see, because each document
is locally correct.

## The contradiction

`agents/references/signal-protocol.md:24`:

> `kind` is **open** — any descriptive string. The three closed facets below are how
> consumers subscribe.

Four agent files — `evor-tick.md:197`, `evor-forge.md:483`,
`evor-forge-junior.md:346`, `evor-mutagen.md:503`:

> **`kind` is a closed set, not a description.** … an invented kind —
> `tree-json-corrupt`, `state-schema-bad` — files the disclosure where nobody is
> looking.

Every role that emits signals is told to read the protocol reference before acting
(`Read agents/references/signal-protocol.md before acting`, in six agent files). So
the role reads "open, any descriptive string" in the reference and "closed set, not
a description" in its own file, in the same session.

The schema settles which is authoritative: `SignalSchema.kind` is `z.string()`
(`mcp/src/contracts.ts:792`), while `shapes`, `axes` and `severity` are enums.
**The reference and the schema agree; the four agent files are the outliers.** The
reference's own "Existing kinds" table is a 31-row registry, not an enum.

## What it costs

The agents invent kinds, exactly as the reference permits and their own file
forbids. Observed in lite18/lite19 on identical fixtures:

```
same finding, different run:
  integrity-violation                 ⟷  tick-integrity-failure
  forge-artifact-job-status-mismatch  ⟷  runaway-job-post-completion
  capability-gap                      ⟷  state-schema-corrupt
```

This is mechanism B behind the 29% replication flip rate: the same observation,
classified under a different invented name, scores differently.

And it reaches the detectors. The subject-scoped declarations added earlier carry
`not_arg: {'$.kind': 'capability-gap'}` — a rule that assumes `kind` means something
stable. Against an open field whose vocabulary each run reinvents, that exclusion
fires or misses at random.

## The fix, and which side moves

The agent files are wrong and should move to the reference: **`kind` is open, and
should reuse a registry entry where one fits; `shapes`, `axes` and `severity` are
the closed facets readers filter on.** That is what the schema enforces and what the
reference documents.

The stronger option is to close `kind` in the schema — structural enforcement over
prose, this repo's own P2 — but that is a product decision with migration cost for
every existing signal on every run's bus, and it is not the bench's call to make.

NOT APPLIED: lite20 is in flight at `--repeats 6`, and editing `agents/**` mid-run
kills every scenario that starts after the edit.

**Falsifier:** if agents keep inventing kinds after the agent files are aligned with
the reference, the prose was never what drove the behaviour and the schema enum is
the only instrument that will work.
