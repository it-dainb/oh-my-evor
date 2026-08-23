# Changelog

All notable changes to Evor. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — model-tier optimization

Six tier/effort changes ship, chosen by a gate both angles must clear:
**accuracy ≥95% absolute, the difference CI clearing −10pp, both arms from one
paired run, and a material cost saving.** Across those six roles,
**$0.7039 → $0.2195 per call — 68.8% cheaper**, with no measured accuracy
regression on any of them.

Five further retiers were measured, found short of the gate, and **reverted to
their `main` tiers** rather than shipped on weaker evidence. Their prompt fixes
ship regardless: those were verified on *both* arms and improve the expensive
tier too.

`evor-tick` ships as a new agent on sonnet. It has never been benchmarked.

The savings did not come from model swaps. They came from **thirteen defects in
Evor's own agent files** — every time a cheaper tier looked like a capability
limit, reading the model's actual answer found a rule that was graded but never
stated, stated twice with different answers, or stated far from where the field
is written. Thirteen times out of thirteen. Zero times was it a model failing to
reason.

### Changed — tiers that ship

| agent | from | to | evidence | saving |
|---|---|---|---|---|
| `evor-sage` | opus | **haiku** | 75/78 vs 77/78, CI [−9.5, +3.6] | 79.3% |
| `evor-mutagen` | opus | **haiku** | 116/120 vs 116/120, CI [−5.3, +5.3] | 71.9% |
| `evor-probe` | opus | **haiku** | 66/66 vs 66/66, CI [−5.5, +5.5] | 69.0% |
| `evor-acquirer` | sonnet | **haiku** | 36/36 vs 36/36, CI [−9.6, +9.6] | 59.2% |
| `evor-forge-junior` | sonnet `effort: high` | sonnet **`effort: low`** | 45/45 on all three arms, CI [−7.9, +7.9]; roc_auc identical to 4 d.p., sd=0 | 42.5% |
| `evor-selector` | opus | **haiku** | 200/200 at n=200, CI [−1.9, +1.9] | 22.5% |
| `evor-tick` | *(new)* | sonnet | none — never benchmarked | — |

`effort:` was removed from every agent moved to haiku — haiku does not support
it, and `tests/agent-frontmatter.test.ts` fails on an inert declaration.

### Reverted — measured, but short of the gate

Each of these was measured non-inferior and would have saved real money. None
ships, because non-inferior is not the same as demonstrated.

| agent | proposed | reverted to | why it did not ship | saving forgone |
|---|---|---|---|---|
| `evor-forge-critic` | haiku | opus | 29/30 vs 27/30, but the two arms came from **separate runs** — run-to-run variation uncontrolled | 68.0% |
| `evor-forge-analyst` | haiku | opus | 93.5% absolute, below the 95% bar | 63.5% |
| `evor-sage-junior` | haiku | sonnet | 93.9% absolute, below the 95% bar | 65.7% |
| `evor-forge-architect` | sonnet | opus | 93.3% and CI lower bound exactly −10.0pp | 40.6% |
| `evor-forge` | sonnet | opus | 3-tick A/B only; no per-attempt n to compute an interval from | 17% |

Reverting these costs **$0.2618 per call** across the four with per-call
figures; `evor-forge` has none, so the true total is higher. They are not suspected of regressing — the evidence is thin,
not adverse — and `evor/optimization-v2` exists to fix that.

### Added

- `evals/acquirer/` — 12 cases across five gates. Acquirer's tier had never been
  benchmarked before this.
- `evals/probe/oscillating-curve` and a flattened `grad-vanishing` tail.
- Non-inferiority testing in `ci/retier-report.py`: Newcombe method-10 interval
  for a difference of proportions, built from two Wilson intervals.
- Run fingerprints (`agent_sha256`, `spec_sha256`) in every report, so an arm can
  be topped up across runs and `ci/compare-arms.py` can refuse to pool reports
  that measured different files.
- `docs/v1-cost-and-verification.md` — per-row verification status.
- `docs/agent-file-defects.md` — all thirteen defects, with the reasoning.

### Fixed — statistics

- **`p >= 0.05` was being reported as "no regression".** It is not: a
  non-significant p says the run could not tell the arms apart. The verdict is
  now one of four — regression, improvement, non-inferior within 10pp, or
  UNDERPOWERED. Under this rule four previously-"held" retiers were reclassified
  as never demonstrated.
- **The 10pp margin is what n can reach**, not what is comfortable. At n=30 a
  perfect tie still leaves a 15.4pp drop inside the interval; ruling out 5pp
  needs n≈200.
- **Cost is now billed, not modelled.** The two disagree by a *tier-dependent*
  factor — 1.142× on haiku, 1.261× on sonnet and opus — so it does not cancel in
  an arm-vs-arm ratio, and every modelled saving previously quoted was a floor.
- `gradeField`: an explicitly-empty `set` is now a gradeable claim ("nothing
  fired"); an absent field still fails.

### Fixed — agent files (13 defects)

All one class: **a rule that is graded but not stated, or stated twice with
different answers.** Full detail in `docs/agent-file-defects.md`.

- `evor-mutagen`: `mutation_tier` doubly determined; `dream_k` asked for more
  proposals than families exist; crossover protocol had no trigger (0/3 in
  **both** arms).
- `evor-sage-junior`: `confidence` doubly determined; indirect evidence
  assert-low vs decline; one finding per source skipped the quorum gate.
- `evor-sage`: `confidence` doubly determined — and the first fix over-corrected,
  breaking three single-source fixtures.
- `evor-probe`: loss-curve checks unordered and one dimensionally wrong;
  `telemetry_sane` conflated a broken stream with a bad run; saturation
  per-tick vs cumulative; a missing optional field read as a schema violation;
  a null value confused with an absent field.
- `evor-forge-analyst`: Pass 4 risk indicators were overridden by holistic
  judgement — now floors.
- `evor-forge-architect`: Dimension 5 needed branch-first selection on wildness.
- `evor-acquirer`: two drop counts merged into one field with no rule saying so;
  the license gate ended in "e.g.", making every unlisted license a coin flip.

### Known limitations

- **No tick-level cost measurement exists.** Every figure is per call.
- **Four opus→sonnet retiers were never demonstrated** — probe, forge-architect,
  forge-critic, mutagen. Underpowered, not suspected of regressing.
- **`evals/acquirer` cannot fail** — both arms score 36/36, so it proves the
  absence of a large regression and nothing finer. Same, milder, for probe.
- **`evor-tick` has never been benchmarked.**
- **The modelled-vs-billed gap is unexplained.** Direction known, cause not.
