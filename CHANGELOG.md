# Changelog

All notable changes to Evor. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.2.1] — 2026-09-01 — the affordance release

v1.2.0's first real field deployment ran 19 hours across three missions and
produced **1 tick of 200 in each, 0 promotions**, ending when the operator killed
it. An 18-lane trace, 8 root causes and 6 affordance lanes established that most
of what looked like agent misbehaviour was the system unable to express something
real — so a human or an agent improvised outside it, and the improvisation was
later catalogued as a defect.

**57 of 60 planned items ship.** The three that do not are named below with why.

### The principle this release is built on

> Any obligation stated in prose to an agent is an obligation the system has
> decided not to have. **For every invariant, name the writer. If the writer is
> the agent that benefits from violating it, it is not an invariant.**

That pattern existed correctly in the codebase exactly once — `record.ts:162`,
*"absence of a failure verdict is not evidence of integrity"*. This release
applies it to the other twelve places.

### Fixed — guards that could not fail

- `_check_no_label_contamination` was `return True`: three lines of docstring and
  an unconditional pass, reported beside four checks that can fail. It now
  compares hashes, and with none supplied returns **`None` = not evaluated**,
  which is not the same as clean.
- `.evor/.deps-ok` was a 24-byte timestamp whose mere existence satisfied the
  dependency check. It now attests the interpreter and package set and
  revalidates against them.
- The evaluator sanity gate (new): a trivial all-ones predictor scoring **94.7 F**
  is now unsealable. An unrun gate reports unsealable rather than passing.
- `evor doctor` gained a plugin-tree drift check. 17 files in the installed tree
  were modified in place — including `hooks/stop.mjs` — with 26 `.bak-*` files
  beside them, unreported for 19 hours.

### Fixed — guards that were disarmed, and what arming them revealed

Retiring `run-state.status` armed three `stop.mjs` gates that had been silently
false. That exposed three further defects underneath: the drift guard was **never
scoped to the orchestrator** and had been blocking sub-agents for not producing
artifacts they were spawned to produce; check (c) duplicated Guard 3 with a worse
message; and **two independent test suites' fixtures had drifted** behind the same
inert gate.

### Fixed — the guards checked roles and command text, never paths

Every realized harm in the field run came through a path no guard looked at.
Verdicts are now made on the **resolved absolute write target**, through `cd` and
variable expansion, identically for every caller — an identical edit re-issued as
`subagent_type: "claude"` no longer succeeds 51 seconds after being refused.
`runsTraining` was **narrowed**, not widened: 54 of 82 training denials were false
positives, and broad textual denial trains evasion rather than compliance.

### Fixed — data that was wrong about itself

- **`freeze-splits` was freezing the corpus's metadata files as the eval set.**
  `dataset_card.yaml`, `manifest.json`, `test.txt` — 7 files split 80/20, exit 0,
  `test_item_count: 5`, and every fitness number in a 19-hour run computed against
  them. The corpus had declared all 132 items with domains and per-file hashes
  four weeks earlier; nothing read it. Items now resolve by **declared sha256**, so
  the manifest survives the corpus being reorganised — and an edited sample is
  reported missing rather than silently frozen in its place.
- A node with **12,000 valid telemetry records** was failed by a directory-naming
  mismatch: the trainer wrote `nodes/<slug>/`, the gate read `nodes/<uuid>/`.
  Neither writer was wrong; nothing owned the mapping.
- Three missions read `running` concurrently for 15.6 hours. A successor now
  closes out its predecessor in the same write that creates it.

### Added — affordances, because a guard over a missing affordance breaks things

`docs/credentials.md` (there was no secure path; chat was the only channel) ·
`evor_scaffold_evaluator` (the server owns the harness, the mission owns
`score(pred, gt)` — every field failure lived in the hand-written column) ·
`evor_await_artifact` (agents were told to wait on `job_complete` /
`self_heal_event`, which have **zero producers**) · a `capability-gap` consumer
(`evor-tick` emitted one honestly and nothing read it) · authority expressed as
**operations, not tool names** (`Write` denied, `Bash` granted, 21 writes happened
anyway).

### Added — a state machine, as data three languages read

`contracts/state-machines.json` with a reader in Python, TypeScript and
JavaScript. An FSM in one language is invisible to the others, and `stop.mjs` —
whose wrong predicate caused C-02 — is in a third. Every state carries
`max_dwell_s`, so *"is this still alive?"* becomes arithmetic any reader can do
from the file alone.

### Migrated

The three field mission trees (~242 MB) to the v1.2.1 shape, gated on a verified
revert point, dry-run reviewed, with **every node artifact hashed byte-identical
before and after**.

### Not shipping, and why

- **The Semantic Scholar key is not rotated.** The value in `.env` is
  byte-identical to the one exposed on 2026-08-23. Relocating it changed where it
  is stored, not whether it is compromised. Revocation is an operator action.
- **Source-page leakage (M-03) is NOT EVALUATED, not clean.** The check ships and
  is correct in all three states; `corpora/v10` declares no per-item lineage, so it
  abstains. Two RED tests are left failing deliberately — adjusting them would hide
  the gap. One `group` key in the corpus builder closes it. See `KNOWN_GAPS.md`.
- **The tier re-measurement has not run.** Phase 7 fixed the instrument —
  v1.2.0's numbers were measured with **no MCP tools attached**, in a system where
  every role's job is to call tools. They were right about a narrower thing than
  they were quoted for. Until Phase 8 runs, no tier on
  `docs/retier-benchmark-results.md` is claimed to be measured; that page is now
  generated from agent frontmatter and states what ships, which is a fact about
  the build.

## [1.2.0] — 2026-08-22 — model-tier optimization

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
