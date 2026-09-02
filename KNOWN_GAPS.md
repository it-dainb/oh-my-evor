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

## Item 0.1 — the Semantic Scholar key is not rotated

The value in `.env` is byte-identical (sha256 `fd48f224`, 44 chars) to the one
exposed in the 2026-08-23 transcripts, and `~/.claude/settings.json` holds the
same one. Across all occurrences in every transcript there is exactly **one**
distinct key. Relocating it changed where it is stored, not whether it is
compromised.

Revocation at semanticscholar.org is an operator action and nothing in this
release substitutes for it. `docs/credentials.md` (item 2b.4) is the affordance
that removes the reason it was pasted into chat in the first place.
