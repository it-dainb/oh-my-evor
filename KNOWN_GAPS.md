# Known gaps — v1.2.1

Where an item cannot land, it gets a tracked row rather than silence (plan §6).

---

## M-03 / items 2.3, 9.1 — source-page leakage is NOT EVALUATED for the field corpus

**Status: capability shipped, corpus cannot yet use it.**

### What the finding is

`corpora/v10` is built by DEGRADING source pages. When one page is degraded into
a train item and a test item, the two have different image bytes and a
byte-identical ground-truth mask — so every hash-based check sees two unrelated
samples. The field harness counted exactly that signal, recorded it as *"48
benign mask-only collisions ignored"*, and declared it benign **citing this
corpus's own leakage count as the reason**. A check was reclassified so that its
own failing instance passed.

### Why it does not close in v1.2.1

Mask identity is not a usable discriminator. 132 test items yield 128 unique
masks, so collisions occur legitimately *within a single split* — a fix that
flags every mask collision would refuse a large fraction of correct corpora, and
`test_distinct_source_pages_sharing_a_gt_are_not_flagged` exists to reject
exactly that shortcut.

What settles it is **declared per-item lineage**: a `group` key naming the source
page each item was derived from. `corpora/v10/manifest.json` does not carry one,
and adding it is a **corpus-builder change**, outside this repository. The plan
anticipated this and routed it here.

### What DID ship

- `FrozenSplit.per_sample_groups` (item 2.3) — the field, carried through the
  freeze, populated from `manifest.json` whenever an item declares `group` or
  `source_page`.
- `IntegrityGate._check_source_page_leakage` (check 3b) — compares declared test
  lineage against the train side's `source_sample_id`.
- `IntegrityChecks.no_source_page_leakage` is **tri-state**. With lineage
  declared it returns True or False correctly, verified in all three states:

  | corpus declares | verdict |
  |---|---|
  | `office_scan_p17_b → page-17`, train has `page-17` | `False` — gate fails |
  | `office_scan_p17_b → nabuco-page-3`, train has `page-17` | `True` — clean |
  | nothing (the field corpus today) | `None` — **not evaluated** |

`None` is the honest answer and is deliberately not `True`. Reporting clean
without the evidence would be the same move that produced the finding: a check
that cannot see a leak declaring its absence — `record.ts:162`, "absence of a
failure verdict is not evidence of integrity."

### To close it

1. `corpora/v10`'s builder emits `group` (the source-page id) per manifest entry.
2. Re-freeze. `per_sample_groups` populates automatically; no harness change.
3. `test_wave1_seal_provenance.py::TestM03SourcePageLeakage` goes green with the
   fixture supplying group keys.
4. **Item 9.1** (restore the strict leakage check) and **9.2**'s re-score under
   it become meaningful. Until then 9.2 would re-score under a check that cannot
   see the leak it is meant to catch.

### Two RED tests remain failing, deliberately

`test_same_source_page_in_train_and_test_is_flagged` and
`test_distinct_source_pages_sharing_a_gt_are_not_flagged` supply no group keys,
so the check correctly returns `None` and the gate does not fail. They are left
RED rather than adjusted: a test weakened to match a capability the corpus cannot
supply would hide precisely this gap.

---

## Prose readers with no suite (plan §5.10)

`skills/` and `agents/` have no test suite, so §5.9's gate rule structurally
cannot reach them. Three clusters read state this release restructures, each
broken by a *later* phase than the one that would have caught it:

| site | reads | broken by |
|---|---|---|
| `skills/evor/SKILL.md:417` | `tick_state.step_status == "running"` AND `current_step < 9` | **3.1/3.2** — the FSM replaces the step/status pair, and this prose is the agent's entire resume logic |
| `agents/evor-forge.md:198`, `:223` | `run_status.state == "oom"` / `== "succeeded"` | **6.4** — job lifecycle changes what these values mean |
| `skills/evor/SKILL.md:289-290` | `integrity_status` `"failed"` / `"passed"` | **2.6/2.8** — sanity gate and gates-as-contract-data |

Lower confidence, worth a look by whoever touches the adjacent item:
`evor-run/SKILL.md:60` (`tick_count == 0` vs 1.2's computed `finished`) and
`evor-forge.md:130` (`critic_result.verdict == "approved"`, adjacent to 2b.2's
removal of `critic_approved` — a different field, same review step).

---

## Items 8.1 / 8.3 — two SHIPPED tiers are not supported by their own evidence

**Status: measured, stated, not resolved. Both tiers ship.**

### What the finding is

Phase 8 re-measured every role through the corrected instrument — tools
attached, and `n` = cases rather than calls. Under it, `evor-sage` and
`evor-mutagen` both fail this project's own adoption gate, and both run on haiku
in production today.

| role | ships | dearer arm | cheaper arm | difference | 95% CI (cases) |
|---|---|---|---|---|---|
| `evor-sage` | haiku | opus 95.4% | **haiku 92.3%** | +3.1pp | [−3.1, +10.8] |
| `evor-mutagen` | haiku | opus 100.0% | **haiku 96.0%** | +4.0pp | [+0.0, +10.0] |

The gate is: accuracy ≥95% absolute, and a difference CI clearing −10pp. sage
misses both — 92.3% is below the floor and its upper bound is +10.8pp. mutagen
sits on the margin exactly: an interval that touches 10.0pp has not excluded it.

**Neither is evidence that haiku is worse.** The measured gaps are +3.1pp and
+4.0pp. The claim that fails is *non-inferiority*, and it fails for want of
resolution, not because the cheap tier lost.

### Why it does not close in v1.2.1

More repeats cannot fix it. Across the run, within-case variance is 6.4e-3
against between-case 5.7e-2 — repeats stopped buying precision long before this,
and 13 and 10 cases respectively is all the resolution the specs contain. The
interval narrows only with more CASES.

Authoring cases is the work, and item 8.x found four defects in the cases that
already existed: three specs graded rules their agent files never stated, and
`evals/selector` scored a verdict leaving an H003 collision standing as correct.
Writing ten more under time pressure would most likely add the same defect and
produce a tighter interval around a worse question.

### What DID ship

- The corrected instrument: `ci/role-eval.mjs` attaches the MCP server, records
  whether tools were attached, and fingerprints the bytes it actually read.
- `ci/analyze-81.mjs`, which clusters on cases, gives a per-role verdict rather
  than a pooled one, takes its direction from tier price rather than arm labels,
  and refuses a verdict decided by floating-point noise at the margin.
- `ci/recompute-v1-cis.mjs`, which reproduces the published intervals from the
  published call counts and then recomputes them on cases.
- The evidence itself, at `docs/evidence/matrix-81.json` — 930 calls with each
  run's `agent_sha256` and `spec_sha256`, so the table is checkable rather than
  quotable.
- `mcp/tests/evidence-81.test.ts`, which fails if any agent file drifts from the
  measurement or if §3 stops printing what the analyser computes.

### To close it

Author cases for `evals/sage` and `evals/mutagen` — validated against the
grounding gate in `ci/eval-core.mjs` before measuring anything — and re-run
`ci/tier-matrix-81.mjs` for those two roles. Roughly 20 cases each would bring
the interval inside the margin if the true gap is near the measured +3 to +4pp.

### Also not re-measured

`evor-selector`, `evor-forge` and `evor-forge-junior` have no `spec.json` and run
on the legacy `cases.json` path. Selector's shipped haiku tier and the 22.5%
saving credited to it in §2 of `docs/v1-cost-and-verification.md` still rest on
the original instrument — the one Phase 7 replaced.

---

## Item 0.1 — the Semantic Scholar key is not rotated

The value in `.env` is byte-identical (sha256 `fd48f224`, 44 chars) to the one
exposed in the 2026-08-23 transcripts, and `~/.claude/settings.json` holds the
same one. Across all occurrences in every transcript there is exactly **one**
distinct key. Relocating it changed where it is stored, not whether it is
compromised.

Revocation at semanticscholar.org is an operator action and nothing in this
release substitutes for it. `docs/credentials.md` (item 2b.4) is the affordance
that removes the reason it was pasted into chat in the first place.
