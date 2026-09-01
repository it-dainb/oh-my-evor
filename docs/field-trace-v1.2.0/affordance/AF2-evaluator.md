# AF2 — Evaluator & Metric Authoring: the affordance surface

Wave 3, affordance trace. Scope: what a mission can **declare** about how it is
scored versus what it must **hand-write in Python**, and which field failures
that boundary produced.

Convention used throughout:

* **GAP** — the system cannot express X. The improvisation was forced.
* **DEFECT** — the system can express X and expressed it wrongly.
* **ADEQUATE** — the contract was capable and was simply not used.

---

## 0. The seed, verified

**CONFIRMED: there is no server-side writer for the evaluator script.**

Every reference to `eval-suites/*.py` in shipped code is a *reader*:

| Site | Operation |
|---|---|
| `mcp/src/tools/integrity.ts:67` | `join(runDir, "eval-suites", "${contract.eval_version}.py")` — path derivation |
| `mcp/src/tools/compute.ts:679-683` | `existsSync` → `createHash("sha256").update(readFileSync(...))` |
| `mcp/src/tools/compute.ts:703-711` | `evor_seal_eval_script`: `existsSync` else `err("no evaluation script found …")`; then hash + `patchGoalContract` |
| `harness/evor/evaluator.py:280` | `run(eval_script: Path, …)` — subprocess execution only |

`grep -rn "eval-suites" --include=*.py --include=*.ts harness/ mcp/src/ skills/`
returns no `write`, no `open(..., "w")`, no template, no scaffold, no generator
for the `.py`. The only writer in the entire tree is the *agent*, instructed in
prose:

> `skills/evor-setup/SKILL.md:364` — "Write `eval-suites/<eval_version>.py` now
> — the ONE evaluation script every node will share."

and again at `SKILL.md:300-303` ("This is MANDATORY. If you skip writing the
evaluator, the seal reports it missing").

**What the harness does with the result:** nothing but hash it. `evor_seal_eval_script`
(`compute.ts:690-714`) checks existence, sha256s the bytes, and writes
`eval_script_hash` into `goal-contract.json`. There is no parse, no import check,
no signature check, no smoke run, no fixture. The mission-lock gate added in
`ade77b3` (`harness/evor/validate.py`, check `goal_contract_eval_anchor`) asserts
only `if not gc.eval_script_hash` — i.e. **"the anchor is non-null."** A hardlink,
a zero-byte file with a shebang, or an evaluator with inverted labels all pass
identically.

Field confirmation of the custody consequence — all three missions' sealed
evaluators are **one inode**:

```
28705681 -r--r--r--+ 5 … 55759 Aug 23 23:49 eval-suites/v1.py
28705681 -r--r--r--+ 5 … 55759 Aug 23 23:49 .evor/runs/binarization-worldmodel-min98-2026-08/run-live-01/eval-suites/v1.py
28705681 -r--r--r--+ 5 … 55759 Aug 23 23:49 .evor/runs/…-r2/run-live-01/eval-suites/v1.py
28705681 -r--r--r--+ 5 … 55759 Aug 23 23:49 .evor/runs/…-r3/run-live-01/eval-suites/v1.py
```

while the three contracts carry three *different* `eval_script_hash` values
(`8d7107cf…` r1, `f123d17c…` r2, `a3776de4…` r3). The r1 and r2 scripts those
hashes attest are gone; the bytes now behind all three anchors are r3's. The seal
is unfalsifiable after the fact. (This is RC1's finding; AF2 re-confirms it on
disk and identifies the cause: the system never held a copy it produced itself.)

**The affordance framing.** Sealing-as-assertion is not laziness. It is the only
thing a system *can* do about an artifact it did not create, has no schema for,
and cannot regenerate. The custody gap is downstream of the authoring gap.

---

## 1. The affordance surface, mapped

### What a mission CAN declare

`GoalContract` (`harness/evor/contracts.py:315-364`):

| Field | Expresses |
|---|---|
| `metric_specs: list[MetricSpec]` | named metrics, direction, role |
| `fitness_mode` | `aggregate` \| `worst-domain` \| `weighted` |
| `baseline_value`, `target_value` | normalisation endpoints |
| `metric_scale` | 0-1 vs 0-100 reporting scale (auto-inferred, `contracts.py:367-387`) |
| `eval_version` | which `.py`/`.json` pair is canonical |
| `eval_script_hash`, `locked_split_hash` | server-owned integrity anchors |

`MetricSpec` (`contracts.py:83-131`):

| Field | Consumed at |
|---|---|
| `metric_name`, `direction`, `role` | `tree.py:469-473`, `validate.py` |
| `fitness_formula` | `tree.py:487-497`, `validate.py:140` |
| `fbeta` | `validate.py:136` (probe only) |
| `constraints: list[MetricConstraint]` | `tree.py:480-484` |
| `custom_metrics` | **nowhere** — informational only, by its own docstring |
| `domain_applicability` | **nowhere in `harness/evor/`** |
| `aggregation_rule` | **nowhere in `harness/evor/`** — see GAP-3 |

`aggregation_rule` and `domain_applicability` appear in
`grep -rn "aggregation_rule\|domain_applicability" harness/evor/` **only at their
own definition site** (`contracts.py:104`, `contracts.py:103`). No reader exists.

### What must be hand-written in Python

Everything else. Concretely, from the field evaluator
(`~/research/binarization/eval-suites/v1.py`, 1381 lines):

* the metric implementations themselves (`fmeasure_score`, `confusion_counts`, DRD)
* **label polarity** (`load_gt`, `v1.py:627-632`)
* **the domain partition** — `EXPECTED_DOMAIN_COUNTS`, 22 entries, `v1.py:147-169`
* the per-domain sample-count assertion (`v1.py:569-591`)
* the gate thresholds, *again* (`v1.py:124-133`)
* the gate enforcement logic (`evaluate_constraints`, `v1.py:1157-1188`)
* the degenerate-predictor floor (`_trivial_floor_min_domain_f`, `v1.py:1199`)
* dataset layout detection, sliding-window inference, latency/VRAM harness

The declarative surface covers roughly the *reporting* of a metric. The
*definition* of one is entirely code.

---

## 2. The specific field failures, traced to affordance

### GAP-1 — Label polarity is not expressible anywhere. → r1 destroyed.

`grep -rn "polarity" harness/ mcp/src skills/` returns **zero hits**. Not in
`GoalContract`, not in `MetricSpec`, not in `Domain`, not in `EvalSuite`, not in
the setup skill, not as a naming convention, not as a comment.

r1's evaluator scored paper as ink. Recorded reason
(`docs/field-trace-v1.2.0/lanes/lane-f-efficiency.md:81`): *"sealed evaluator
scored paper as ink (inverted GT polarity); baseline_value 59.61 was not
like-for-like."* Cost: `$82.59`, 33 ticks, one full mission
(`lane-f-efficiency.md:254`, F-02).

The correction now lives as **72 characters of prose in a docstring**
(`v1.py:29-33`) plus one expression, `mask < 0.5`, at `v1.py:627`. Nothing
machine-readable records it. A v2 evaluator written by a different agent session
re-rolls the same die.

> **Could the contract have expressed "ink is 0"?** No. There is no field, no
> enum, no `positive_class`, no `label_semantics`. This is a pure GAP.

**Compounding:** the one guard that would have caught it —
`probe_metric_gameability` (`validate.py:195-330`), which scores all-positive /
all-negative / majority-class predictors — **cannot run on this mission**.
`_load_eval_labels` (`validate.py:150-190`) accepts only
`frozen-splits/*-test/labels.{json,txt}`: a flat vector of integers, one per
example. A segmentation mission's labels are per-pixel masks. The probe returns
`{"skipped": true, "skip_reason": "no labels.json or labels.txt found …"}` and
`validate` passes.

The agent then **hand-built the missing probe inside the evaluator**:
`_trivial_floor_min_domain_f(items, True/False)` (`v1.py:1199-1231`) computes
exactly the all-ink and all-paper floors the harness probe was supposed to
compute — using the evaluator's own metric code so the numbers are commensurate.
This is the textbook shape of this wave: *the system could not express it, so a
human improvised it outside the system.* An all-ones predictor scoring ~94.7 F
was the signature of r1's inversion (`lane-k-guardrail-gaps.md:130-132`); the
improvised floor is what makes it visible in r3.

**Contract would need:** a `label_semantics` block on `GoalContract` or `Domain`
(`positive_class`, `on_disk_encoding`, and for dense tasks a `mask_polarity`),
plus a degenerate-predictor probe that operates on the *scorer* rather than on a
flat label vector — i.e. run the sealed evaluator against synthetic constant
predictions and assert the resulting fitness sits at a plausible floor.

### DEFECT-1 (not a gap) — Latency gates ARE contract data. They were duplicated into code anyway.

The task brief asked whether gates are data or code. **They are data, and the
contract expressed them correctly.** All three field contracts carry them as
`MetricConstraint` entries on the primary spec:

| | r1 (`…-2026-08`) | r2 (`…-r2`) | r3 (`…-r3`) |
|---|---|---|---|
| `latency_gpu_ms` | `< 10` | `< 10` | `< 500` |
| `latency_cpu_4k_s` | `< 0.1` | `< 1` | `< 1` |
| `vram_gb` | `< 10` | `< 10` | `< 10` |
| `precision` | `>= 0.8` | `>= 0.8` | `>= 0.8` |

(read from each run's `goal-contract.json`, `metric_specs[0].constraints`.)

So the r2→r3 gate rewrite *is* a data edit. Why did it force an evaluator
rewrite and a re-seal? Because **the same thresholds are hardcoded a second time
in the evaluator**:

```
v1.py:124   PRECISION_FLOOR      = 0.80   # applied PER DOMAIN
v1.py:131   LATENCY_GPU_MS_MAX   = 500.0
v1.py:132   LATENCY_CPU_4K_S_MAX = 1.0
v1.py:133   VRAM_GB_MAX          = 10.0
```

and enforced there (`evaluate_constraints`, `v1.py:1157-1188`, "any violation
forces fitness to 0.0"). Two sources of truth for one number, one of them inside
the sealed artifact. Every gate change therefore mutates sealed bytes.

**This duplication was itself forced — by GAP-2.**

### GAP-2 — `MetricConstraint` cannot be scoped per-domain. → the evaluator had to re-enforce, and its verdict is then discarded.

`tree.py:480-484`:

```python
for constraint in primary_spec.constraints:
    cv = result.metrics.get(constraint.metric, float("nan"))
    if not _check_metric_constraint(cv, constraint.op, constraint.threshold):
        return 0.0
```

`result.metrics` is the **aggregate** dict. `result.per_domain` is never
consulted for constraints. `MetricConstraint` (`contracts.py:63-81`) has three
fields — `metric`, `op`, `threshold` — and no scope.

The mission's actual requirement, stated at `v1.py:38-39`: *"per-domain precision
>= 0.80 on EVERY one of the 22 domains (the floor is evaluated PER DOMAIN, never
against the aggregate)"*. Unexpressible. So the evaluator implemented it
(`v1.py:1160-1167`) and zeroed its own `fitness_value`.

**And that verdict is thrown away.** By design:

> `harness/evor/evaluator.py:17-19` — "`fitness_value` is computed by
> `EvaluatorAdapter` post-parse (not by the eval script) to prevent eval script
> from gaming the fitness function."

`evaluator.py` builds the result with a placeholder fitness, then overwrites it
with `_compute_fitness(result, goal)` → `TreeEngine.compute_fitness`. There is no
`violations` field on `EvaluationResult` (`contracts.py:673-689`) and
`grep -rn "violations" harness/evor/` returns **nothing**. The evaluator's
violation list is emitted to stdout and silently dropped.

Net effect: a candidate failing the precision floor on 3 of 22 domains but fine
in aggregate is zeroed by the evaluator and **un-zeroed by the harness**. The
anti-gaming decision (server owns fitness) deleted the enforcement the affordance
gap had forced into the client.

**Contract would need:** `MetricConstraint.scope: "aggregate" | "per_domain"`
(default `aggregate` for compat), evaluated against `result.per_domain` when
`per_domain`; and an optional `violations: list[str]` on `EvaluationResult` that
the server *audits against its own recomputation* rather than trusts — keeping
the anti-gaming property while surfacing the disagreement.

### GAP-3 — `MetricSpec.aggregation_rule` has no reader; aggregation is `GoalContract.fitness_mode`. Two competing declarations.

`MetricSpec.aggregation_rule: Literal["macro_avg","weighted_avg","min","max"]`
(`contracts.py:104`) is dead. All nine specs in every field contract carry
`"macro_avg"`. The mission's fitness is **min over 22 domains**
(`v1.py:34`), which the contract expresses correctly the *other* way, via
`fitness_mode: "worst-domain"` (`tree.py:500-506`).

So the contract says `macro_avg` and `worst-domain` simultaneously, and the
inert field is the one that reads as wrong. This is a **DEFECT of schema
hygiene**, not a gap — `worst-domain` is adequate. But it is an active trap: an
author who sets `aggregation_rule: "min"` and leaves `fitness_mode: "aggregate"`
gets macro behaviour with a `min` label and no warning.

**Contract would need:** delete `aggregation_rule` (and `domain_applicability`,
`custom_metrics` — likewise readerless) or wire them and demote `fitness_mode` to
a derived value. Not both.

### GAP-4 — A domain partition cannot be declared, and a minimum sample size cannot be expressed at all.

`Domain` (`contracts.py:949-957`) has `domain_id`, `description`,
`metric_specs`, `sota_source`, `added_at_eval_version`. **No sample count, no
split reference, no minimum-n.** `EvalSuite.split_hashes: dict[str,str]`
(`contracts.py:971-972`) can name a hash per domain but not a size.

More decisively, the only way to create the first suite is
`BenchmarkManager.create_initial_suite` (`benchmark.py:239-290`), which is
hardcoded to produce **exactly one domain**:

```python
primary_domain = Domain(
    domain_id="primary",
    description=task_description,
    metric_specs=[],
    ...
)
```

The docstring claims it "derives a single 'primary' domain from
*task_description*"; it does not derive, it names. `evor_init_eval_suite`
(`compute.ts:656-687`) is a thin wrapper over it. There is no
`evor_add_domain`, no multi-domain init path, no way for setup to declare 22
domains.

The field result, in all three runs:

```
eval-suites/v1.json → domains: ['primary'], metric_specs: [0], split_hashes: {}
```

The declarative eval suite is **vacuous in every mission that ran**, while the
real structure — 22 domains, 132 items, per-domain counts — lives only as a
Python literal in the sealed script, asserted at `v1.py:569-591`.

Measured distribution (`v1.py:147-169`), correcting the brief: **11 domains at
n=2**, none at n=1; largest is `palmleaf_balinese` at 32. Eleven of 22 domains
carry two test images each, and `fitness = min` over those domains means the
mission's entire score is routinely decided by a single image in a two-image
domain. Nothing in the schema can express "a domain needs ≥ k samples to gate,"
so nothing warned.

**Contract would need:** `Domain.n_samples` (server-computed at freeze from the
frozen index, not agent-supplied), `Domain.min_samples_to_gate`, and a validate
check that refuses `fitness_mode: "worst-domain"` when any gating domain falls
below it. The data already exists — `frozen_index.json` carries the per-item
domain labels that `build_domain_index` (`v1.py:454-510`) joins on. The freeze
step could count them. It doesn't.

### DEFECT-2 — `MetricConstraint` documented as an anti-gaming floor, used as a deployment goal.

RC5's finding, confirmed. `contracts.py:63-71` is unambiguous about intent:

> "Hard constraint on a secondary metric used as a **gamability guard**. …
> This prevents degenerate solutions such as predicting all-positive to maximize
> recall while ignoring precision."

In the field, one of the four constraints (`precision >= 0.8`) is that. The other
three (`latency_gpu_ms`, `latency_cpu_4k_s`, `vram_gb`) are **deployment
requirements** — the mission's actual objective, not a cheating guard. The schema
has one list and no discriminator, so both meanings share a field.

The consequence is at `validate.py:273-276`:

```python
has_constraints = bool(primary_spec.constraints)
has_guard = has_constraints or has_formula or has_fbeta
```

Presence of *any* constraint satisfies the anti-gaming requirement. A mission
carrying only latency gates — which do nothing whatever to stop label-gaming —
is certified guarded. And when the empirical probe skips (as it did here,
GAP-1), `has_guard` is the *only* thing standing between the mission and a
gameable objective.

**Is the schema unable to distinguish them?** Yes — GAP. There is no `purpose`,
`kind`, or `role` on `MetricConstraint`.

**Contract would need:** `MetricConstraint.purpose: "anti_gaming" | "deployment"`,
with `has_guard` counting only `anti_gaming` entries. This is a ~6-line change
that converts a vacuous certification into a real one.

### DEFECT-3 — `evals/*/spec.json` and `eval-suites/vN.py` are unrelated systems sharing a word.

They are not two views of one concept and never interact:

| | `eval-suites/<ver>.{py,json}` | `evals/<role>/spec.json` |
|---|---|---|
| Grades | mission candidates (a trained model) | **this repo's own agent roles** |
| Location | inside a run dir, per mission | repo root, checked in |
| Schema | `.json` = `EvalSuite`; `.py` = none | ad-hoc: `{role, agent_file, arms[], contract{}}` |
| Written by | the agent, in prose-instructed Python | committed by hand |
| Consumed by | `EvaluatorAdapter` subprocess | the tier-benchmark harness (`red/T7-tier-benchmark.md`) |

`evals/sage/spec.json` is a model-tier A/B spec — `arms: [{model: sonnet}, {model:
opus}]` — with a **declarative output contract**: `{"path": "findings[].trust_level",
"kind": "every", "values": ["authoritative","indicative"]}`.

The naming collision is a minor irritant. **The interesting part is that the
repo already ships a declarative evaluator-composition language — in the wrong
namespace.** `evals/*/spec.json` composes a grader from declared field paths and
predicate kinds, with zero hand-written Python. The mission side, which is where
the money and the integrity claims are, has none.

Also inside `eval-suites/`: `v1.json` (a real `EvalSuite` model, server-written,
vacuous) and `v1.py` (the thing that actually decides everything, agent-written,
unvalidated) sit in one directory distinguished only by extension. Only the
`.py` is sealed.

---

## 3. Where the contract was ADEQUATE and simply misused

Stating these plainly, per the brief:

* **`fitness_mode: "worst-domain"`** correctly expresses min-over-domains and was
  correctly set in all three contracts (`tree.py:500-506`). The per-domain min is
  not a gap.
* **Latency/VRAM gates as `MetricConstraint`** were correctly declared as
  contract data in all three runs. The *thresholds* were expressible; only the
  *per-domain scoping* of the precision floor was not. The evaluator-side
  duplication was avoidable for the three global gates.
* **`metric_scale: 100`** was correctly set (and would have been auto-inferred
  anyway — `dataset_ref` contains `binarization`, `contracts.py:139-142`).
* **`fitness_formula`** is a real, wired composite-metric affordance
  (`tree.py:487-497`) that this mission did not need and did not use.
* **The subprocess isolation contract** (`evaluator.py:1-29`: stdout-only result,
  no artifact writes from the eval script, `EVOR_EVAL_VERSION` echo check) is
  sound design and worked.

---

## 4. Should an evaluator be authored, or composed?

The brief's framing — generated evaluators cannot express novel metrics, and this
is a tool for novel objectives — is correct as far as it goes, and it is the
reason the current design chose authoring. But it is answering the wrong
question, because **the parts that failed in the field are not the novel parts.**

Sort the 1381 lines of `v1.py` by whether they are mission-specific research
content:

| Novel / irreducibly hand-written | Boilerplate every scoring mission re-derives |
|---|---|
| F-measure, DRD implementations for document binarization | loading a frozen split, refusing anything else |
| sliding-window full-page inference (`v1.py:784-800`) | joining items to domains via `frozen_index.json` |
| activation-traffic `bytes_per_px` instrumentation | asserting per-domain counts |
| deployment-precision measurement (fp32…int4) | applying gate thresholds and zeroing |
| | computing degenerate-predictor floors |
| | emitting one JSON object on stdout, logs to stderr |
| | declaring label polarity |

Every field failure — inverted polarity (GAP-1), gate duplication (DEFECT-1),
per-domain scope (GAP-2), the vacuous domain declaration (GAP-4) — is in the
**right-hand column**. None is in the left. The novel-metric argument protects
the column that was never the problem.

**Recommendation: a scored-plugin split, not full generation.**

The system should own everything except a single narrow interface:

1. **Server-generated harness.** A real writer — `evor_scaffold_evaluator` —
   emits the split loader, the domain join, the count assertion, the gate
   application, the trivial-predictor floor, and the stdout protocol, driven by
   `GoalContract` + `EvalSuite` + the frozen index. Deterministic from declared
   inputs, so the server can regenerate and byte-compare it, which turns the seal
   from assertion into **custody** — the RC1 fix falls out for free rather than
   needing separate hardening.
2. **A `score(pred, gt) -> dict[str, float]` plugin.** The one hand-written file.
   Small, mission-specific, testable in isolation, and the *only* thing the
   agent authors. Novel objectives stay fully expressible — F-measure, DRD, and
   anything not yet invented live here.
3. **Declarative promotions** to close the specific gaps: `label_semantics` on
   the contract, `MetricConstraint.scope` and `.purpose`, `Domain.n_samples`
   (server-computed at freeze), and a multi-domain init path replacing the
   hardcoded `"primary"`.
4. **A generic fixture gate at seal time.** Run the sealed evaluator against
   synthetic constant predictions before locking. This requires no knowledge of
   the metric — it needs only "all-ones must not score near target." It catches
   inverted polarity in seconds and is worth building even if nothing else here
   is.

Honest cost. The plugin boundary is a real constraint: a metric that needs to see
raw images (perceptual quality), or that is not decomposable per-item
(corpus-level calibration, ranking metrics over the whole split), does not fit
`score(pred, gt)` and will need an escape hatch. Item 4 is where the value
density is — small, generic, and it alone would have saved `$82.59` and a
mission. Item 1 is the structural fix and the larger build. Item 3 is cheap and
should happen regardless.

The failure mode to avoid: hardening the seal into true custody while leaving
authoring in prose. That makes a mis-authored evaluator *permanently* binding
instead of merely wrong — the exact "harden the guard without closing the gap"
outcome this wave exists to prevent.

---

## Appendix — verification commands

```
grep -rn "eval-suites" --include=*.py --include=*.ts harness/ mcp/src/ skills/   # readers only
grep -rn "polarity"    harness/ mcp/src skills/                                  # zero hits
grep -rn "violations"  --include=*.py harness/evor/                              # zero hits
grep -rn "aggregation_rule\|domain_applicability" harness/evor/                  # definition site only
ls -li ~/research/binarization/.evor/runs/*/run-live-01/eval-suites/v1.py        # one inode, nlink 5
```
