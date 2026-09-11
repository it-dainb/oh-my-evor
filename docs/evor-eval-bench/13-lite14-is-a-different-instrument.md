# lite14 is a different instrument, and every comparison against it is void

Found by the delegated non-tick trace, verified directly.

## The evidence

```
run      records   CLI denials   voids
lite14      72          0          1
lite17      72         57         16
lite18      72         48         17
lite19      72         63         14
```

**Zero denials fired anywhere in lite14.** `--plugin-dir` landed in `4afe175`
(2026-09-07); lite14 predates it. Before that commit the sandbox held agent files
that no namespace owned, so `hooks/hooks.json` was never loaded and the product's
PreToolUse governor was not running. Only 16 of 170 scenarios ever got a hand-built
`bench-settings.json`; the rest ran ungoverned.

So lite14 measured **agents with the governor off** and lite17/18/19 measure
**agents with the governor on**. They are two instruments.

## What this invalidates

Every paired comparison in this loop that used lite14 as the baseline:

- `lite14 -> lite17`   ALL 69.6 -> 80.0
- `lite14 -> lite18`   ALL 73.5 -> 76.6, non-tick 88.2 -> 88.2, tick 40.0 -> 46.2

Those numbers pair a pre-governor run against post-governor runs and attribute the
difference to whatever changed in between. **Withdrawn.** The only sound
within-regime comparison so far is `lite18 -> lite19`, which is a replication and
produced the 29% flip floor.

The conclusions drawn from those comparisons survive on other evidence and are not
withdrawn with them — the A3 fix was verified by `declaration_fired false->true` and
`evor_validate_proposals 0->2 calls`, and the lite17 inflation was confirmed by
reading errored spawns, not by the F1 delta. But the F1 numbers themselves should not
be quoted.

## The second finding, which is larger

The non-tick figure of ~88-91% is computed over **scored cells only**, and 33 of the
non-tick records are `denied_undeclared` voids — all of them post-lite14, all created
by turning the governor on. §4.1 is right that a void is a harness failure and must
not be counted against the model; but a void rate that rises when the instrument is
repaired means the F1 is describing a shrinking fraction of the corpus.

Non-tick coverage is roughly 84%, and the 88-91% describes only that part. The
delegated trace's own accounting of the 90 non-passing non-tick records:

```
(a) fixable instrument defects   66  (73%)   confidence high
(b) plausibly genuine behaviour  10  (11%)   confidence LOW — all sit inside the
                                             29% flip floor, and some FPs may be
                                             manufactured by the denial defects
(c) flickers below threshold     14  (16%)   no cause claimed for any, per Rule 0's
                                             corollary that "noise" is not an
                                             attribution
```

Roughly three quarters of the remaining shortfall is the instrument. The residue
where the model is plausibly at fault is on the order of **10 records out of 208**,
and that figure is an upper bound rather than a measurement.

## Consequence for the loop

Two rules from here:

1. **Never pair across the plugin-dir boundary.** lite17 is the earliest sound
   baseline. lite21 must be compared to lite17/18/19, never to lite14.
2. **Report void rate beside every F1.** An F1 over a shrinking denominator is the
   first entry on the skill's false-green list, and it has now bitten twice in this
   loop — once as lite13's budget voids, once here.
