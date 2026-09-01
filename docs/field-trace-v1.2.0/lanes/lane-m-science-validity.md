# Lane M — Scientific Validity (Wave 1 inventory)

**VERDICT: NO.** No accuracy number produced by any of the three runs is scientifically
trustworthy. r1 produced zero scored candidates and its training+evaluation both ran at
inverted GT polarity. r2's scoring evaluator no longer exists on disk and its numbers are
unreproducible. r3's single number is a 3.53 min-domain F drawn from a metric whose
per-domain sample sizes (8 domains with n=2, one with n=1) make it noise-dominated, on a
checkpoint the trainer's own stated criterion says "is NOT a verdict on the IIR hypothesis".
Separately, 40/132 (30%) of the frozen test set shares byte-identical ground truth with the
train split, and the integrity harness was changed between r2 and r3 to classify exactly
that signal as "benign".

The r3-era evaluator itself (`eval-suites/v1.py`, sha a3776de4) is, in isolation, a
well-built artifact: metrics are correct, the min-domain aggregation is right, the
degeneracy guard works, gates are enforced honestly, and `latency_measured=false` cannot
silently pass. The invalidity is in the seal, the corpus, the baseline, and the training
runs — not in the current metric code.

---

## M-01 — BLOCKER — EVALUATOR-CORRECTNESS / seal integrity
### The "sealed" evaluator is one hardlinked inode shared by all three runs

```
$ ls -li eval-suites/v1.py .evor/runs/*/run-live-01/eval-suites/v1.py
28705681 -r--r--r--+ 5 ... eval-suites/v1.py
28705681 -r--r--r--+ 5 ... .evor/runs/binarization-worldmodel-min98-2026-08/run-live-01/eval-suites/v1.py
28705681 -r--r--r--+ 5 ... .../-r2/run-live-01/eval-suites/v1.py
28705681 -r--r--r--+ 5 ... .../-r3/run-live-01/eval-suites/v1.py
```

Same inode, link count 5. The per-run "sealed copy" is not a copy. Rewriting
`eval-suites/v1.py` in the repo on 2026-08-23 23:49 retroactively rewrote r1's and r2's
archived evaluators. The file's own docstring says *"THIS FILE IS SEALED BY SHA256. Every
candidate in the mission is scored by a verbatim copy of it."* — the mechanism intended to
make that true is absent.

**This corrects Lane E.** The contract pins were never wrong:

| run | contract `eval_script_hash` | run-dir copy today | worktree `evaluate.py` | worktree `.lock` |
|---|---|---|---|---|
| r1 | `8d7107cf…` | `a3776de4…` | **`8d7107cf…`** | `8d7107cf…` |
| r2 | `f123d17c…` | `a3776de4…` | `a3776de4…` | — |
| r3 | `a3776de4…` | `a3776de4…` | `a3776de4…` | `a3776de4…` |

r1's real evaluator survives only as `.evor/worktrees/multiscale-stroke-gate-01/evaluate.py`
and it matches its contract exactly. **r2's scoring evaluator `f123d17c…` exists nowhere on
disk** — its worktree copy was overwritten too (mtime 23:49, after r2's 23:37 evaluation).
r2's `fmeasure 48.72` cannot be reproduced or audited.

**Wave 2:** does `freeze.py` / the eval-lock writer copy or link? Is the lock hash checked
against the *file content* at scoring time (r3's `eval_lock_detail` suggests yes) but the
archive left as a link?

---

## M-02 — BLOCKER — LEAKAGE & SPLIT HYGIENE
### 40/132 test items have ground truth byte-identical to a train item; 2 domains are 100% leaked

Computed directly from `corpora/v10/{train,val,test}.txt`:

```
train n=370 uniq img 370 uniq mask 307
val   n=128 uniq img 128 uniq mask 124
test  n=132 uniq img 132 uniq mask 128
image sha256 overlap: train∩test 0, train∩val 0, val∩test 0          <- clean
MASK   sha256 overlap: train∩test 36, train∩val 34, val∩test 22       <- NOT clean
test items whose GT mask also appears in train/val: 40 / 132 (30.3%)
```

Per-domain breakdown of those 40:

```
office_scan   leaked 27 / 27   (100%)
office_print  leaked 13 / 13   (100%)
all 20 other domains            0 leaked
```

The corpus is content-addressed and built by degrading source pages. A shared GT mask means
**the same source page** appears in train and in test under a different degradation. For
`office_print` and `office_scan` — the two synthetic-render domains, 30% of the test set —
every single test page's source document was trained on. Those are precisely the two domains
that score highest for every candidate (r2: office_print 94.05, office_scan 88.04; r3:
office_scan 87.06, office_print 82.65), and they are the ones underwriting the mission
briefing's claim that the incumbent's *"other 18 domains score 82-96 F"*.

Fitness is `min` over domains, and the min is always palm-leaf, so **fitness itself is not
inflated by this**. But `fmeasure_mean` (r2 74.47, r3 56.82), `agg_fmeasure` (r2 79.68, r3
68.92) and every per-domain office number are, and they are what the decision-log narrative
is built on.

**Wave 2:** where is `corpora/v10` built, and does the splitter group by source page or by
rendered artifact? Are `nabuco`/`livememory`/`monk_cuper` clean only because they are real
scans that were never re-degraded?

---

## M-03 — BLOCKER — LEAKAGE / guard evasion
### The integrity harness detected M-02's exact signal and was changed to dismiss it

r2 (2026-08-23T23:37) — `evaluations/a0d33fe8….json`:

```json
"no_test_leakage": false,
"failure_reason": "no_test_leakage: test indices or content-hashes found in training data; ..."
```

r3 (2026-08-24T01:56), same corpus, same splits — `evaluations/afb204f4….json`:

```json
"no_test_leakage": true,
"no_test_leakage_detail": "... 0 image sha256 overlap (train=370 vs eval=260 unique image
   hashes; 48 benign mask-only collisions ignored)",
"no_label_contamination_detail": "... (48 mask-only sha collisions — benign for
   content-addressed GT, not flagged) ..."
```

The 48 = my 36 (train∩test) + the train∩val portion, over `eval = test 132 + val 128 = 260`.
The harness counted the leakage exactly and then reclassified it.

`harness/evor/integrity.py` encodes the reclassification in its docstrings:

- `_compute_no_test_leakage`, line ~763: *"a corpus whose content-addressed ground truth is
  shared across distinct noisy inputs failed with a pure false positive (**36 such benign
  mask collisions measured in corpora/v10**). Mask reuse is legitimate; image reuse is not."*
- `_compute_no_label_contamination`, line ~833: *"mask-only collisions -> counted and
  explicitly NOT flagged"*
- `integrity.py:734`: `mask_only = (train_view.masks & eval_masks) - overlap_img`

The number 36 in the source comment is *this corpus's leakage count*, named as the reason for
the rule change. The premise — "mask reuse is legitimate" — is true for a corpus where
distinct source pages happen to share a GT; it is false for a corpus where the same source
page is degraded into multiple items, which is what `office_*` is. The check was tuned on
the failing instance rather than on the semantics.

This is a direct violation of the contract's own `autonomy_charter.invariant`: *"it may make
the evaluation harder or more honest, never easier"*. r2→r3 made a leakage check strictly
easier, and the run it unblocked is the only run that reached a verdict.

**Wave 2:** who authored that integrity.py change and when, relative to r2's failure? Was the
"36 benign collisions" figure derived by inspecting the failing run?

---

## M-04 — BLOCKER — RESULT-CREDIBILITY / DEGENERATE-SOLUTION
### r1 trained *and* scored against inverted polarity; it reported val F 98.76, above the mission target of 98

r1's evaluator, preserved at `.evor/worktrees/multiscale-stroke-gate-01/evaluate.py:542`:

```python
def load_gt(path: Path) -> np.ndarray:
    """GT ink mask as bool HxW, ink = True. Corpus polarity is ink = 1 (white)."""
    ...
    return a >= 0.5
```

Independently, r1's **trainer** made the same error — `train/trainer.py:209` `gt = (masks >= 0.5)`
and `data/builder.py:197-198` `mask_arr = mask_arr / 255.0`. Model and metric agreed with each
other and both disagreed with the corpus, so nothing detected it.

The telemetry is the proof:

```
step   1  train_loss 2.0372  val_metric 94.2752
step 450  train_loss 0.5957  val_metric 98.7604
```

**F 94.28 at step 1** — a randomly-initialised network. That is Lane E's all-ones ceiling
(94.7) reached before any learning. By step 450 it reported **98.76, above the mission
`target_value: 98`**. Had either node scored successfully, r1 would have declared the
mission solved on an inverted metric. Both nodes instead crashed in `label_domains`
(`results.json`: *"132 test item(s) could not be mapped to a domain via manifest.json"*), so
r1 has **zero scored candidates**, `best_score: null`, `status: failed`.

The current evaluator's `_trivial_floor_min_domain_f` degeneracy guard (v1.py:1199, raises if
all-ones min-domain F ≥ 15.0) is a correct and sufficient fix for exactly this. It is
present only in `a3776de4`.

---

## M-05 — HIGH — EVALUATOR-CORRECTNESS / statistical power
### The primary fitness statistic is noise-dominated: min over 22 domains, 10 of which have n ≤ 3

`EXPECTED_DOMAIN_COUNTS` (v1.py:147-170) over 132 items:

```
palmleaf_balinese 32, office_scan 27, office_print 13, palmleaf_khmer 9, nabuco 6,
monk_cuper 5, livememory 4, dibco_2013 4, dibco_2017 4,
persian_historical 3, h_dibco_2012 3,
h_dibco_2010 2, h_dibco_2014 2, h_dibco_2016 2, h_dibco_2018 2,
handwritten_historical 2, dibco_2009_hwt 2, dibco_2009_printed 2,
dibco_2011_hwt 2, dibco_2011_printed 2, dibco_2019_track_a 2, dibco_2019_track_b 2
```

Fitness = `min` of 22 per-domain means, and a per-domain mean of **two images** is the fitness
for 11 of them. `min` of many noisy estimates is a strongly downward-biased statistic with
variance dominated by whichever domain got the unlucky page — and the mission asks for that
minimum to reach **98**.

r3's own validation telemetry shows the instability first-hand (`val_min_domain_f` at
successive validations): `4.644 → 0.005 → 0.028 → 4.604 → 8.964 → 0.726`. r3's trainer
explicitly names the problem (`train/trainer.py:508-512`): *"NOT min-domain F: the val split
has 1-2 item domains, so min-domain val selection is dominated by single-page sampling
noise."* The trainer routes around it for checkpoint selection — and then the frozen test
fitness uses exactly the statistic the trainer just declared unusable.

`palmleaf_balinese` (n=32) and `office_scan` (n=27) are 45% of the corpus; the 11 two-item
domains are 17%. There is no confidence interval anywhere in the pipeline.

**Wave 2:** what is the test-retest spread of min-domain F for one fixed checkpoint under
resampling? Is any observed r2-vs-r3 delta larger than it?

---

## M-06 — HIGH — RESULT-CREDIBILITY
### r3's scored checkpoint is from 48 seconds into a 13-minute run; 96% of the run made it worse

`nodes/iir-scan-binnet-02/telemetry.jsonl`, 12000 records, 47 validations:

```
step     1  01:05:02  val_metric 10.69  val_min_domain_f 4.644  mean_domain_f 13.44
step   250  01:05:18  val_metric 43.67  val_min_domain_f 0.005  mean_domain_f 59.70
step   750  01:05:50  val_metric 54.32  val_min_domain_f 4.604  mean_domain_f 70.06   <- PEAK
...
step 11500  01:17:33  val_metric  9.72  val_min_domain_f 0.000  mean_domain_f 19.43
step 12000  01:18:05  val_metric  9.80  val_min_domain_f 0.000  mean_domain_f 19.59
```

`md5sum` confirms `weights.pt == weights_best.pt` (`2c67e0fc…`), so the *best*-checkpoint path
worked — the best checkpoint is just from step 750. `train_loss` fell monotonically
1.254 → 0.207 throughout, i.e. the run trained hard for 11,250 further steps while
validation fell by 5x. At `epoch 387.10` over 370 training images this is textbook
memorisation, and `train_loss` — the only signal `telemetry_sane` inspects — looks perfect
the whole way.

Also: `val_floor_ok` is `False` at **all 47** validations
(`val_n_domains_precision_floor_ok` peaked at 20/22, never 22). The trainer's own comment,
`train/trainer.py:719-721`:

> *"architect-required: if this stays 0 for the whole run, the precision lever never engaged
> and the result is NOT a verdict on the IIR hypothesis — it is a verdict on the floor gate."*

By the run's own stated standard, r3's `min-domain F 3.53` is not evidence about the IIR
architecture. It is nonetheless the only number r3 produced, and r3 is `status: running` with
`best_score: null`.

---

## M-07 — HIGH — BASELINE-VALIDITY
### r1's `baseline_value: 59.61` is a per-domain cell lifted out of an incompatible artifact; r2/r3's `0` sets the bar at "does not crash"

`base_record.json` / `base_quality.json` (2026-07-26) report:

```json
"fitness_value": 73.09095216981164,          // claimed min-domain (livememory)
"per_domain": { "palmleaf_balinese": {"fmeasure": 59.6129611809554, ...},
                "livememory":        {"fmeasure": 73.0909521698116, ...}, ... }
"meta": {"n_items": 130, "n_domains": 22, "n_winnable": 21,
         "worst_domain": "livememory", "precision_floor": 0.7, "constraint_ok": false}
```

Three separate problems:

1. **The file's own fitness is wrong by its own table.** `min` over its `per_domain.fmeasure`
   is 59.61 (`palmleaf_balinese`), not 73.09. It reports 73.09 because `n_winnable: 21`
   dropped a domain. The sealed evaluator's docstring explicitly repudiates this:
   *"There is no 'n_winnable' concept in this evaluator; if such a flag exists anywhere in
   the repo it is ignored here."* r1's `baseline_value: 59.61` was taken from the excluded
   cell — arithmetically the right min, but pulled from a table computed under a
   different rule.
2. **It is not comparable to anything.** It was measured on **130 items** (sealed split is
   132; `dibco_2009_*` show `n=1` there vs `n=2` in `EXPECTED_DOMAIN_COUNTS`), at
   **precision_floor 0.7** (sealed: 0.80), with `latency_* = -1.0` (unmeasured), and
   `recall` on a **0-100 scale** where the sealed evaluator uses 0-1. `base_record.json` and
   `base_quality.json` even disagree on what `metrics.precision` means (0.8442 = mean vs
   0.5968 = min-domain) while sharing an identical `per_domain` block.
3. **r2/r3 set `baseline_value: 0`.** Combined with `fitness = raw_fitness if ok else 0.0`
   (v1.py:1310), the improvement bar becomes "clears all four gates at all", not "beats the
   73.09 / 59.61 incumbent". In practice no candidate cleared the gates, so
   `best_score` stayed `null` in all three runs and nothing was falsely promoted — the
   defect is latent, not yet triggered.

**Wave 2:** does the promotion path compare `fitness_value` to `baseline_value`, or to the
incumbent's *raw* min-domain F? A gate-passing candidate at raw F 20 would beat baseline 0.

---

## M-08 — MEDIUM — GOAL-COHERENCE
### `target_value: 98` min-domain has never been approached by anything measured in this repo

The best *single-domain* score ever recorded anywhere here is 95.94 (`office_print`,
`base_record.json`) — and that domain is 100% leaked (M-02). The mission asks the **worst** of
22 domains to reach 98, on a corpus that includes palm-leaf manuscript binarization, where
every measurement in the repo lands between 3.5 and 49:

```
                        incumbent(base_record)   r2 iir-binnet-01   r3 iir-scan-binnet-02
palmleaf_balinese              59.61                  49.07                14.13
palmleaf_khmer                 73.20                  48.72                 3.53
livememory                     73.09                  61.40                48.18
```

With `stop_condition: {type: "coverage-target"}` and `coverage_target: 1`, the run cannot
terminate successfully; combined with `autonomy_charter.posture:
"aggressive-never-halt"` and `budget.max_cost_usd: 0` (no cost ceiling), the mission is
specified so that it can only ever exhaust `max_iterations: 200` or fail. This is a design
defect in the contract, not a failure of the search.

---

## M-09 — MEDIUM — EVALUATOR-CORRECTNESS
### `telemetry_sane` failed both scored nodes with a failure reason that is demonstrably false

Both r2 and r3 record `"telemetry_sane": false` with
`failure_reason: "telemetry_sane: telemetry fails sanity (NaN/Inf loss, constant loss, or
zero/negative grad_norm when field is present)"`. r3's verdict is `failed` on that check alone.

I checked every documented FAIL condition in `_check_telemetry_sane`
(`integrity.py:1027-1150`) against both files:

| condition | r2 (8000 rec) | r3 (12000 rec) |
|---|---|---|
| empty / malformed | no | no |
| duplicate step | no — 8000 unique | no — 12000 unique |
| non-monotonic step | no — 1..8000 | no — 1..12000 |
| NaN/Inf train_loss | no | no |
| constant loss (first==last) | no — 1.675 → 0.247 | no — 1.254 → 0.207 |
| grad_norm NaN/Inf/negative | no — min 0.0737 | no — min 0.0543 |

Every condition passes. The only remaining path to `False` is the `status: "skipped"`
INDETERMINATE branch (telemetry file not located), which returns `False` and is then reported
under the generic substantive-failure string. Neither evaluation JSON carries the
`telemetry_sane_status` / `telemetry_sane_detail` fields that would disambiguate, even though
r3's JSON carries `_status`/`_detail` for four other checks. An unresolved path is being
reported as "the model didn't learn".

Consistent with the known pattern that gates failing together indicate a harness bug rather
than a candidate defect.

**Wave 2:** what path does `_resolve_telemetry_path` search, and does it know about
`nodes/<node-name>/` vs `nodes/<uuid>/`? Both runs store telemetry under the *name* directory
and results under the *uuid* directory.

---

## M-10 — MEDIUM — EVALUATOR-CORRECTNESS
### `_to_prob` branches per-image on the model's output range

`v1.py:773-781`:

```python
def _to_prob(raw: torch.Tensor) -> torch.Tensor:
    """Sigmoid iff the raw output leaves [0, 1] (i.e. it is logits)."""
    lo = float(raw.min()); hi = float(raw.max())
    if lo < -1e-4 or hi > 1.0 + 1e-4:
        return torch.sigmoid(raw)
    return raw
```

The decision is made from the *data*, per page. One model can be sigmoid-ed on page A and not
on page B, purely because page A's logits happened to span [0,1]. A confident logits model
whose outputs land inside [0,1] on an easy page is silently read as probabilities, and since
`sigmoid([0,1]) ∈ [0.5, 0.73]` vs raw `[0,1]` straddling the 0.5 threshold differently, the
predicted mask flips. The candidate contract already requires a declared polarity; it should
require a declared output convention too. Nothing in these three runs is known to have hit
this — no candidate's per-page output range is recorded.

Related, lower severity: `_select_ink_channel` (v1.py:737-750) silently takes channel 0 for
any output with `C > 2` and channel 1 for `C == 2`, with no way for a candidate to declare
otherwise — a silent polarity flip for a `(ink, bg)`-ordered 2-channel head.

---

## M-11 — MEDIUM — EVALUATOR-CORRECTNESS / gate coherence
### The gated latency path is never the scored path, and reported precision/recall are not the contract's `macro_avg`

**(a) Latency vs scoring measure disjoint code paths.** `FULLPAGE_MAX_PIXELS = 2200*2200` and
the largest test page is 1536×1393, so `pages_tiled == 0` for all 132 scored images — every
accuracy number comes from the full-page branch. `measure_latency` uses a synthetic
3840×2160 page, which *always* takes the tiled branch. The gate that zeroes fitness therefore
measures a code path that never produced a single accuracy number, and the accuracy path is
never timed. The evaluator documents this honestly (v1.py:118-120) but still gates on it.

**(b) Contract says `macro_avg`; the evaluator reports image-weighted means.** Every
`metric_specs` entry sets `"aggregation_rule": "macro_avg"`, but v1.py:1327-1330 emits
`_mean(all_p)`, `_mean(all_r)`, `_mean(all_d)` — flat means over the 132 *images*. With
`palmleaf_balinese` at 32/132 and `office_scan` at 27/132, 45% of the reported precision and
recall come from two domains. Only `fmeasure` is aggregated per the contract (as `min`, per
`fitness_mode: worst-domain`, which itself does not match that metric's declared
`macro_avg` either).

**(c) The r1 gates were physically unsatisfiable.** r1's evaluator enforced
`LATENCY_GPU_MS_MAX = 10.0` and `LATENCY_CPU_4K_S_MAX = 0.1`; the smallest model anyone
subsequently built (10,889 params) measured 81.4 ms GPU and 0.664 s CPU. Loosening them to
500 ms / 1.0 s for r3 was the correct call, but it is a comparability break: r1, r2 and r3
fitness values are computed under three different constraint sets, all labelled
`eval_version: "v1"`, and `eval_version_consistent` reports `true`.

---

## M-12 — LOW — CANDIDATE-QUALITY
### The candidates are real work; the scaffolding around them is stale

**Genuinely good.** r3's `iir-scan-binnet-02` is serious: a learnable 4-direction first-order
IIR scan with a log-depth Hillis-Steele associative scan, stability constraint
`a = 0.9995·sigmoid(a_raw)` justified against fp32 sigmoid saturation *and* bf16 mantissa
rounding, exactness verified numerically (9.237e-14 fp64 / 2.384e-07 fp32, `tests/test_scan.py`),
and — notably — `genome.yaml` **retracts** the proposal's claim: *"The mutagen proposal's
'effectively infinite receptive field' is FALSE and is deliberately NOT carried into this
record."* That is the right behaviour.

**Name/claim mismatch, self-flagged.** r2's node is called `iir-binnet-01` and its own
`tree.json` config says *"NOTE: contains NO IIR recurrence"*. r3's contract carries this
forward correctly as an open hypothesis. Caught, but the artifact name is now permanently
misleading in the tree.

**r1 was never a research result.** `tree.json` config:
`"run_class": "smoke-test / tick-1 integration verification, not a convergence run"`,
450 steps at constant `lr 3e-4`. Its telemetry (M-04) is nevertheless the source of the
"98.76" figure.

**Stale seam.** Repo-root `evor_candidate.py` (2026-07-26) declares the contract
*"The frozen canonical evaluator imports `load_binarizer` from here"* and is customised for
`node filter_bank_distill_v1` — a node from an entirely different mission. The sealed
evaluator imports `from model import build_model` and never touches this file. Dead
scaffolding that documents a contract that no longer exists.

---

## M-13 — LOW / UNVERIFIED — PRIOR-ART
### r1's citation list does not obviously match the methods it claims

r1 `tree.json` describes *"CBAM multi-scale U-Net"* with a *"soft-clDice topology"* loss and
*"GroupDRO exponentiated-gradient"* weighting, citing:

```
https://arxiv.org/abs/2006.05595
https://arxiv.org/abs/1911.08731
https://doi.org/10.1145/3805622.3810631
```

`1911.08731` is Sagawa et al., *Distributionally Robust Neural Networks* — correct for
GroupDRO. The canonical IDs for the other two named methods (CBAM, clDice) are not present in
the list, and I did not fetch `2006.05595` or the ACM DOI to confirm what they are. Flagged
for the citation-integrity lane rather than resolved here. **UNVERIFIED.**

---

## Category coverage

| category | hits |
|---|---|
| EVALUATOR-CORRECTNESS | M-01, M-05, M-09, M-10, M-11 |
| BASELINE-VALIDITY | M-07 |
| LEAKAGE & SPLIT HYGIENE | M-02, M-03 |
| RESULT-CREDIBILITY | M-04, M-06, M-09 |
| DEGENERATE-SOLUTION | M-04 (r1 only — the r3-era guard closes it; **no candidate exploited the current evaluator**) |
| GOAL-COHERENCE | M-08 |
| CANDIDATE-QUALITY | M-12 |
| PRIOR-ART/CITATION-SANITY | M-13 (unverified, deferred) |

**Zero-hit:** none. Every category has at least one finding.

## Explicitly NOT found (checked, clean)

- **Image-level split overlap: zero.** `train∩test`, `train∩val`, `val∩test` image sha256
  overlap is 0 in all three pairs. The leak in M-02 is at the source-page level only.
- **No selection on test.** The evaluator hardcodes `SPLIT = "test"` and the trainer reads
  `split="val"` for validation; `genome.yaml` states *"frozen_test_split: never trained on,
  never selected on"* and the telemetry is consistent with it (val-only metrics logged).
- **No fabricated training.** All three telemetry files show real, monotonic, finite loss
  descent with plausible grad norms. r2 and r3 trained for 8000 and 12000 genuine steps.
- **No metric read from the wrong source.** `results.json` metrics reconcile exactly with
  `tree.json` for both scored nodes, and r2's test min-domain F 48.72 sits inside its val
  range (max 48.39) — consistent.
- **Metrics are correctly implemented.** `confusion_counts`, `precision_score`, `recall_score`,
  `fmeasure_score`, `drd_score` (5×5 distance-reciprocal weights, 8×8 NUBN) and the
  min-domain aggregation are all correct as written in `a3776de4`.
- **`latency_measured` cannot silently pass.** `measure_latency` returns `None` (not `-1.0`)
  when CUDA is unavailable and `evaluate_constraints` treats `None` as a violation.
