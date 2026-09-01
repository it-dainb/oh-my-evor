# AF1 — Dataset / Corpus / Freeze affordance surface

Wave 3, affordance trace. Lane AF1.
Repo: `oh-my-evor` @ `v1.2.1` (working tree ≡ `bab279e` for every file cited here — verified
`git diff bab279e -- harness/evor/freeze.py` is empty).
Corpus: `/home/dainb_1/research/binarization/corpora/v10`.

**An affordance gap is: the system cannot express something real, so someone improvises outside
it, and the improvisation is later catalogued as a defect.** This lane names the gaps. Where the
contract *can* express the thing and was simply used wrong, that is recorded as a defect and
dropped.

---

## 0. Correcting the seed

The seed is right about the conclusion and wrong about the artifact. The correction matters,
because the thing the seed treats as *the corpus* is itself the improvisation.

### 0.1 `train.txt` / `frozen_index.json` / `_store/` are not the corpus — they are the workaround

`stat` on `corpora/v10` separates two populations cleanly:

| artifact | mtime | origin |
|---|---|---|
| `dataset_card.yaml`, `domains.json`, `manifest.json` | 2026-07-26 14:33 | native corpus |
| `_freeze_anchor/eval_manifest_{test,val}.json` | 2026-07-26 14:42 | native corpus |
| `train.txt`, `val.txt`, `test.txt` | **2026-08-23 08:17** | operator, during setup |
| `corpora/_store/{images,masks}/` | **2026-08-23 08:16–08:19** | operator, during setup |
| `eval/test/`, `eval/val/`, `frozen_index.json` | **2026-08-23 08:24** | operator, during setup |

The field run's setup phase ran 07:09–08:51 (lane L, H1→H8). The freeze attempt that triggered
the patch was at `08:21:14` (lane C:400). **Every TSV-and-CAS artifact the seed describes was
created inside that window**, minutes before and after the failure. `corpora/v5` shows the same
signature — Jun-10 metadata beside Aug-23 `*.txt` — so the operator reshaped the whole `corpora/`
tree, not just v10. This is H2 and H5 in lane L: *"prune corpora + restructure to centralized
`images`/`masks`"* (07:37:43) and *"Approve, and restructure v10 too"* (08:06:31).

**The native shape** is what `manifest.json` records — 1261 entries, and their prefixes are
exactly:

```
train/gt 370   train/images 370
test/gt  132   test/images  132
val/gt   128   val/images   128
```

i.e. six per-split directories of zero-padded serial files, `train/images/000000.png` paired by
filename with `train/gt/000000.png`. Splits pre-defined, pairs implicit in the shared basename,
domains carried positionally in `domains.json` (three parallel arrays, 370/128/132 strings,
22 distinct labels).

So: the corpus was never in "manifest form" in the sense of a TSV. It was in *directory-pair
form*. The TSV manifest, the content-addressed `_store`, and `frozen_index.json` are the shape
**the operator built so EVOR could see the data at all** — and then `freeze.py` had to be patched
anyway to read the shape the operator had just invented for it. That is the gap twice over.

### 0.2 The shared-mask claim is correct, and larger than stated

`train.txt` lines 1–2 do both point at `masks/1984603597…png`. Measured over the whole corpus
(`frozen_index.json` + `train.txt`):

```
unique eval images 260   unique eval masks 230
image sha256 overlap, train vs eval:  0
mask  sha256 overlap, train vs eval: 48
within-test mask collisions: 132 items → 128 unique masks
within-val  mask collisions: 128 items → 124 unique masks
```

48 is exactly the number the patched `integrity.py` reports as *"48 benign mask-only collisions
ignored"* (lane M-03). It reproduces on the shipped corpus today. The lineage is real and the
contract has no field for it — see G-3.

### 0.3 What the pristine freeze actually did — reproduced, not inferred

Ran `python -m evor.freeze freeze-splits --dataset-path …/corpora/v10 --eval-version v1` on the
pristine `bab279e` code against the corpus as it stands:

```json
{"locked_split_hash":"52c8d15f…","val_split_hash":"1084e894…",
 "test_item_count":5,"val_item_count":2}
```

The materialised frozen test split is:

```
frozen-splits/v1-test/  0.yaml 1.json 2.json 3.json 4.txt
frozen-splits/v1-val/   0.txt 1.txt
```

— `dataset_card.yaml`, `domains.json`, `frozen_index.json`, `manifest.json`, `test.txt` frozen as
the **eval set**, and `train.txt`/`val.txt` as the **val set**. Exit 0. Lane A-12's summary is
literally accurate: the eval set became the corpus's own metadata files.

Two refinements on lane A's wording:

- Not "returned ok over zero images" but **ok over seven non-image files**. The distinction is
  load-bearing: `compute.ts:640-648` guards only `testCount === 0 && valCount === 0`. Seven files
  is not zero, **so the zero-item guard does not fire**. The guard was written for the empty case
  and the real failure was the wrong-content case, which is invisible to it.
- At 08:21 `frozen_index.json` did not yet exist (written 08:24), so the counts that day were
  6 files → 4 test / 2 val rather than 5/2. Same defect, different arithmetic. **INFERRED** from
  mtimes; the run's MCP call log would confirm the exact returned counts.

### 0.4 The corpus already ships the artifact `FrozenSplit` should have been

`_freeze_anchor/eval_manifest_test.json` (Jul 26, native) contains:

```json
{"corpus":"data/corpora/v10",
 "domain_counts":{"dibco_2009_hwt":2, …, "palmleaf_balinese":32, "office_scan":27},
 "item_count":132,
 "items":[{"domain":"office_scan","index":0,
           "image":"data/corpora/v10/test/images/000000.png",
           "gt":"data/corpora/v10/test/gt/000000.png",
           "sha256_gt":"7301121d…", …}]}
```

Per item: a domain label, a two-file pair, a hash per file. Plus per-domain counts at the top.
This is a strictly richer frozen-split record than `FrozenSplit`, it predates the mission by four
weeks, and **the freeze path cannot read it, cannot represent it, and does not know it exists.**
The corpus author had already solved the problem the contract cannot state.

---

## 1. What the contract CAN express

Being fair to the system first — this is not a barren schema.

| affordance | where | reachable? |
|---|---|---|
| per-sample content hash | `FrozenSplit.per_sample_hashes` | yes |
| split-level tamper anchor | `FrozenSplit.split_hash`, `contracts.py:913` | yes |
| read-only enforcement | `freeze.py` `_make_readonly` / `check_read_only` | yes |
| re-freeze refusal with a reason | `freeze.py:177-193` | yes |
| **augmentation lineage** | `DataProvenance.source_sample_id` + `transform_applied` | yes, train-only |
| **acquisition licensing/provenance** | `AcquisitionProvenance` (`contracts.py:877+`) | yes |
| **domain as a first-class object** | `Domain` (`contracts.py:952`) | schema only — see G-2 |
| **per-domain frozen split hashes** | `EvalSuite.split_hashes: dict[domain_id, sha256]` | schema only — see G-2 |
| **train/val/test three-way anchor** | `IntegrityGate.lock_splits` (`integrity.py:119`) | **dead** — see G-4 |
| worst-domain fitness | `GoalContract.fitness_mode`, `evaluator.py:98`, `tree.py:500` | yes, on the output side only |

The schema is consistently *ahead of* the freeze path. Most gaps below are not missing concepts —
they are concepts that exist in `contracts.py` and have no wire from the corpus to reach them.

---

## 2. The gaps, ranked

Ranking is by **blocks a real deployment on day one** vs **degrades silently**. Day-one blockers
first, because the field run proves they stop the mission before any science happens.

---

### G-1 — BLOCKS DAY ONE — A pre-defined split cannot be declared

**The gap.** There is no parameter, anywhere in the stack, for "my splits already exist."

`evor_freeze_splits` (`mcp/src/tools/compute.ts:610-615`) accepts exactly:

```ts
dataset_ref, eval_version, run_id, mission_id
```

`freezeSplits` (`compute.ts:124-138`) forwards exactly `--dataset-path`, `--eval-version`,
`--run-dir`, `--mission-id`. The CLI (`freeze.py` `_cli`) then does, unconditionally:

```python
all_files = sorted(f for f in dataset_path.iterdir() if f.is_file() and not f.name.startswith("."))
split_idx = max(1, int(len(all_files) * 0.8))
```

A flat `iterdir` of the top level, 80/20, no recursion. The library layer *does* accept a
`split_config` with explicit `test`/`val` entry dicts (`freeze.py` `freeze_splits`) — **but no
caller can supply one.** The CLI builds `split_config` itself from the scan, and the MCP tool has
no parameter that could reach it. The affordance exists one layer below the surface and is
sealed off.

**What it forced.** The corpus restructuring (H2/H5, 07:37 and 08:06) — the operator reshaped a
directory-pair corpus into a flat CAS so that *some* `iterdir` would see image files. That did not
work either, because `iterdir` of `v10/` still sees only metadata. Then H7 at 08:30:14:
*"`evor_freeze_splits` can't express 132/128 split"* → **"patch only no wdit CLAUDE"** — the
operator authorising a mid-setup patch of the plugin harness. Wave 1 of the mutation timeline,
`freeze.py.bak-20260823-083205`, +130 lines: `_pairs_from_frozen_index`, `_pairs_from_split_txt`,
`enumerate_split_pairs` (lane A-12). Every downstream mutation — `--allow-refreeze` exposure
(A-01, H-06), the `item_count` divergence (A-10) — descends from this one gap.

The tell that this is an affordance gap and not an oversight: **`skills/evor-setup/SKILL.md:112-114`
already asks the question.**

```
"Where is your dataset? … Is it already split into train/val/test?"
→ Set `dataset_ref`.
→ Note whether splits are pre-defined or need to be created by the freeze step.
```

"Note whether" — to *whom*? There is no field. `GoalContract.dataset_ref` is a bare `str`
(`contracts.py:322`). The interview elicits the fact and then has nowhere to put it. The system
knows the distinction matters and cannot represent it.

**What the contract would need.** `evor_freeze_splits` to accept a split source:
`{mode: "scan" | "manifest", test: [...], val: [...], train: [...]}`, or a manifest path with a
declared schema. Plus `GoalContract.split_source` recording which was used, so a later reader can
tell a discovered split from a declared one.

---

### G-2 — BLOCKS DAY ONE — A domain cannot be attached to data

**The gap.** `Domain` exists (`contracts.py:952`) with `domain_id`, `description`, `metric_specs`,
`sota_source`. `EvalSuite.split_hashes` is documented as `{domain_id: sha256}` — *"each domain's
frozen held-out split"* (`contracts.py:970-972`). `MetricSpec.domain_applicability` and
`aggregation_rule: "min"` exist. `fitness_mode: "worst-domain"` is honoured at `evaluator.py:98`
and `tree.py:500`. The vocabulary is complete.

And then `benchmark.py:247-260`, the *only* production constructor, writes:

```python
primary_domain = Domain(domain_id="primary", description=task_description,
                        metric_specs=[], sota_source=None, ...)
suite = EvalSuite(..., domains=[primary_domain], split_hashes={}, ...)
```

One hardcoded domain. `split_hashes` empty. Nothing in the codebase ever populates it — and
`FrozenSplit` has no `domain` field at all, so there is nothing to populate it *from*.

The result is a hard asymmetry:

- **Output side:** `EvaluationResult.per_domain: dict[str, dict[str, float]]` — free-form, written
  by the evaluator script the agent authors, keys unconstrained.
- **Input side:** the frozen split is 132 opaque byte-blobs with no labels.

**Nothing connects them.** `worst-domain` fitness takes `min` over whatever keys the evaluator
chose to emit. An evaluator that emits 21 domains instead of 22 — dropping the one it scores
worst on — produces a higher fitness and trips no check, because no artifact records that 22 was
ever the number. The frozen split, the thing designed to be immutable, does not know how many
domains it contains.

**What it forced.** The mission's fitness is min-over-22-domains. The corpus carries `domains.json`
(three parallel arrays) and `_freeze_anchor`'s `domain_counts`. Neither can enter the contract.
The operator's `frozen_index.json` invents a `domain` key per item — a schema EVOR does not define
— because the freeze had to carry domains somehow. Lane M-07's observation that `palmleaf_balinese`
(n=32) and `office_scan` (n=27) are 45% of the corpus while eleven domains sit at n=2 is invisible
to every guard, because per-domain n is not a quantity the system has.

**What the contract would need.** `FrozenSplit.per_sample_domains: dict[sample_id, domain_id]`, and
`freeze_splits` populating `EvalSuite.split_hashes` per domain rather than writing `{}`. Then a
minimum-n-per-domain check at freeze becomes expressible, and `per_domain` keys can be validated
against the frozen split instead of trusted.

---

### G-3 — BLOCKS DAY ONE (as a false positive) — Sample lineage across splits cannot be expressed

**The gap.** The system has exactly one lineage concept, and it points the wrong way.

`DataProvenance` (`contracts.py:932`) records `source_sample_id`, `transform_applied`,
`is_synthetic` — and is pinned to `split_type: Literal["train"]`, with the field comment
*"DataProvenance only exists for train samples"*. It answers "which train item was this train item
augmented from," recorded at augmentation time by a node.

It cannot answer: **"which two items already in the corpus derive from the same source page."**
That relationship exists in v10 — 48 mask-sha collisions between train and eval, 0 image
collisions — and it exists *before* EVOR ever sees the data. There is no field for it, in
`FrozenSplit`, in `DataProvenance`, or anywhere else. `dataset_card.yaml`'s own provenance block
says as much for v5: *"v5's manifest.json stores only file hashes, so the build-time group IDs
needed by check_no_leakage are unrecoverable."* The corpus author hit the same wall and wrote it
down.

**Consequence, and why it is a gap and not a defect.** With G-1's patch hashing both members of a
pair, `per_sample_hashes` holds 2N entries. Pristine check 2 is:

```python
def _check_no_test_leakage(self, frozen_test: FrozenSplit) -> bool:
    hashes = list(frozen_test.per_sample_hashes.values())
    return len(hashes) == len(set(hashes))          # integrity.py:386-395
```

— *any duplicate hash inside the test split*. Test has 132 items and 128 unique masks, so four
intra-test mask collisions make this return `False` on a clean corpus, unconditionally. Note this
is not even a leakage test: it never sees train data. `_check_no_label_contamination`
(`integrity.py:397-404`) is `return True` with a docstring saying real comparison *"requires access
to training data"* — access the contract does not provide, because **there is no train split
object anywhere in the schema.**

So the only two representations available are "every mask collision is leakage" and "no mask
collision is leakage." M-03's rewrite chose the second. Both are wrong for v10, where
`office_scan` and `office_print` (40 of 132 test pages) *are* re-degradations of trained-on source
pages while the other 20 domains are distinct documents that coincidentally share a GT. **The
correct answer is not expressible**, which is precisely why the guard had to be loosened rather
than fixed. Hardening this check without adding the lineage field makes the system refuse every
real corpus.

**What the contract would need.** A group key on frozen items —
`FrozenSplit.per_sample_group: dict[sample_id, group_id]`, where `group_id` identifies the source
document — and a leakage check defined as *group* overlap between train and eval, not hash
overlap. The corpus builder must emit it, since it is only knowable at build time; `manifest.json`
would need a `group` per entry.

---

### G-4 — DEGRADES SILENTLY — The train split is not an object

**The gap.** `freeze_splits` returns `(test_split, val_split)` and nothing else. The docstring is
explicit: *"locked_split_hash (for GoalContract) = test_split.split_hash."* `compute.ts:631-632`
patches exactly that one hash into the contract. **Train is never hashed, never anchored, never
recorded.**

`IntegrityGate.lock_splits` (`integrity.py:119-131`) does compute a three-way anchor over
`train`/`val`/`test`. Its callers, repo-wide:

```
harness/tests/test_integration.py:388
harness/tests/test_integrity.py:245, 252, 256, 262
```

Tests only. **Zero production callers.** The three-way anchor is dead code — the richer affordance
was built and then never wired.

**What it forces.** Every train-vs-eval comparison is impossible by construction, which is the
root of G-3's degenerate checks. It also means the training set can change between ticks with no
anchor violation: fitness stays comparable by the contract's own definition while the denominator
of *learning* moves underneath it. Silent, not blocking — which is why it survived the field run
unremarked.

**What the contract would need.** `freeze_splits` to return and anchor a train split too, and
`GoalContract.locked_split_hash` to become the three-way `lock_splits` digest that already exists.

---

### G-5 — DEGRADES SILENTLY — A multi-file sample is not a sample

**The gap.** `_sample_to_bytes` (`freeze.py`) accepts `bytes`, `str`/`Path`, or a JSON-serialisable
value. One sample, one file, one hash, one index. Segmentation `(image, mask)`, detection
`(image, annotation)`, ASR `(audio, transcript)` — none have a representation.

The A-10 patch worked around it by hashing both files under separate keys, which is why
`item_count` had to be overridden to N while `per_sample_hashes` holds 2N entries, breaking the
`item_count == len(per_sample_hashes)` invariant every consumer assumed. That is the improvisation
tax, and it is the direct cause of G-3's false positive: mask hashes and image hashes end up in
one flat namespace where a mask collision is indistinguishable from an image collision.

**What the contract would need.** `FrozenSplit` entries as records rather than scalars —
`{sample_id: {role: sha256}}`, with `item_count` = number of records. Leakage then compares
per-role, and "the image is new, the mask is shared" is a statement the system can make.

---

### G-6 — DEGRADES SILENTLY — Corpus version is not a first-class thing

**The gap.** `GoalContract.dataset_ref: str` (`contracts.py:322`). A path. `grep -rn
"corpus_version\|dataset_version\|corpus_ref" harness/evor mcp/src` → no matches.

`corpora/` holds 18 sibling versions (`v1`…`v10`, `v1_prod`, `v1_prod.fb15`, `v4b`, `v7all`,
`v8_both`, `v8_kligler`, `v8_phibd`, `v9base`, `synth_dibco`), and `dataset_card.yaml` maintains a
real semver with a documented convention — *"MINOR for offline augmentation recipes … MAJOR for a
change to raw split composition"* — and a `derived_from: data/corpora/v5` / `derivation:
split-repair` lineage chain. The corpus has a richer versioning model than EVOR does.

To EVOR, `…/corpora/v10` and `…/corpora/v5` are two unrelated strings. `eval_version` (`"v1"`)
versions the *evaluator*, not the data. A corpus swap between runs is indistinguishable from a
path typo.

**What it forces.** Nothing dramatic in this run — v10 was used throughout. But it means the
`dataset_card.yaml` `known_limitations` block (*"40 of 132 test pages are 540px thumbnails … this
corpus cannot measure true 4k behaviour outside palm-leaf"*) — a direct statement about what the
benchmark can and cannot prove, on a mission whose whole point is 4k — has no channel into the
contract, the decision log, or any report.

**What the contract would need.** `dataset_ref` as `{path, version, content_digest}`, and a corpus
digest recorded at freeze so a swap is detectable.

---

### G-7 — DEGRADES SILENTLY — Unlabeled data cannot be declared

**The gap.** `grep -rn "unlabeled\|unlabelled\|semi_supervised\|pseudo" harness/evor mcp/src
skills/evor-setup/SKILL.md` → nothing (the two `pseudo` hits are `pseudo_fm`, a DIBCO metric
name, and a prose "pseudocode").

At H3 (07:42:58) the operator was asked where the in-house 4k data was and answered **"its
unlabeled."** That answer is not representable. `AcquisitionProvenance` has `sample_count` and
`license_identifier` but no label-status field; `DetectedDataset.kind` is
`images-dir|csv|parquet|tfrecord|hf-cache|unknown` — a container format, not a supervision level.
So the answer went nowhere, and at H4 (08:01:11, 17m34s later) the agent **re-asked the same
question** and got *"let the scout find it."* Two human gates, 22 minutes, because a one-word
answer had no field.

**What the contract would need.** `labeled: bool` (or a `supervision` enum) on dataset references,
so "unlabeled, train-only, cannot enter an eval split" is a fact the contract carries rather than
a sentence in a transcript.

---

### G-8 — DEGRADES SILENTLY — The eval item / train item asymmetry is unmodelled

**The gap.** Consequence of G-4, worth naming separately. `DataProvenance.split_type` is
`Literal["train"]` and `FrozenSplit.split_type` is `Literal["test","val"]`. These are disjoint
type universes: an item that is provenance-tracked is definitionally not an item that is frozen,
and vice versa. There is no type in which a train item and an eval item are the same kind of
thing, so "is this train item the same underlying sample as that eval item?" cannot be *typed*,
let alone checked. G-3 is the surface symptom; this is the modelling reason it is hard to fix.

---

## 3. Defects noted and dropped (expressible, used wrong)

Not this lane's business, but found while mapping and worth passing on:

- **`compute.ts:640-648` zero-item guard is the wrong predicate.** It catches `test==0 && val==0`.
  The real failure mode returned 5 and 2 and passed. A content-plausibility check (extension
  agreement with the task modality, or a floor relative to a declared expected count) would have
  caught it. Defect — the guard's concept is fine, its condition is wrong.
- **`skills/evor-setup/SKILL.md:318-321` documents a parameter that does not exist.** It shows
  `evor_freeze_splits({ dataset_path: … })`; the tool's Zod schema (`compute.ts:611`) names it
  `dataset_ref`. Pure doc drift.
- **`SKILL.md:332`: *"if `evor_freeze_splits` returns an error, surface it and stop; there is no
  agent-side fallback."*** The tool returned `ok` on a nonsense split, so the instruction never
  engaged. Correct instruction, wrong trigger.
- **`integrity.py:397-404` `_check_no_label_contamination` is `return True`.** A check that is
  structurally unable to fail. Flagged in the shipped `bab279e` tree, not just the field patch.
  Related to G-4 but a defect in its own right: fail-open with a docstring is worse than absent.

---

## 4. Where the contract is genuinely adequate

- Re-freeze refusal (`freeze.py:177-193`) is well designed — it hashes prospectively *before*
  materialising, is idempotent on identical content, and the error message explains why a frozen
  split is the denominator of every comparison. The exposure of `allow_refreeze` as a plain MCP
  boolean (A-01/H-06) is a wiring decision, not a gap in the concept.
- `AcquisitionProvenance` genuinely models external and synthetic data lineage: SPDX licence,
  allowlist membership, citation, generator config, contamination clearance. Nothing in the field
  run needed to improvise around it.
- `DataProvenance` correctly models *augmentation* lineage. Its failure at G-3 is scope, not
  design: it was built for "node augments a train sample," and the corpus's pre-existing
  ancestry is a different relation that simply has no model.
- `MetricSpec` is expressive — composite formulas, F-beta, constraint guards, custom metrics,
  `aggregation_rule` including `min`. The H6/H14 per-domain-precision disaster was a contract
  *authoring* error at the consent gate, not something the schema could not say.

---

## 5. Ranked summary

| # | gap | severity | what it forced |
|---|---|---|---|
| G-1 | pre-defined splits cannot be declared | **blocks day one** | corpus restructure (H2/H5) + mid-setup harness patch (H7, A-12) |
| G-2 | domains cannot attach to data | **blocks day one** | operator-invented `frozen_index.json` `domain` key; unverifiable `per_domain` |
| G-3 | cross-split sample lineage inexpressible | **blocks day one (false positive)** | leakage check loosened rather than fixed (M-03) |
| G-4 | train split is not an object | degrades silently | `lock_splits` dead; train-vs-eval comparison impossible |
| G-5 | multi-file samples are not samples | degrades silently | `item_count` override, 2N hash namespace (A-10) |
| G-6 | corpus version not first-class | degrades silently | `dataset_card` limitations never reach the contract |
| G-7 | unlabeled data cannot be declared | degrades silently | H3 answer discarded → H4 re-ask, 22 min of human time |
| G-8 | train/eval item type asymmetry | degrades silently | makes G-3 structurally hard to fix |

**The through-line.** G-1, G-2 and G-3 are one gap seen three times: *the corpus knows things
about itself that the contract has no field for.* Pre-defined splits, domain membership, and
source-page ancestry are all recorded in `corpora/v10` — in `manifest.json`, `domains.json`,
`_freeze_anchor/`, `dataset_card.yaml` — and all three are discarded at the `dataset_path: Path`
boundary. `freeze.py` re-derives what it can by scanning, gets it wrong, and every guard
downstream reasons over the impoverished result.

**The warning for remediation.** Do not harden check 2 without first adding the group key from
G-3. Pristine check 2 already returns `False` on this corpus for a benign reason (four intra-test
mask collisions), and a hardened version would refuse every paired-modality corpus on earth. The
guard is not too weak; it is reasoning over a representation that cannot carry the distinction it
needs to make.
