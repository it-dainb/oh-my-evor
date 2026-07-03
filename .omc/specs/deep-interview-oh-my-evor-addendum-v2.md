# Deep Interview Spec — oh-my-evor — Addendum v2 (Four New Pillars)

## Provenance
- Extends: `.omc/specs/deep-interview-oh-my-evor.md` (20-round base spec)
- Source: follow-up interview exchanges after base-spec crystallization (mutation representation, data safety, benchmark evolution, open-ended generality)
- Status: pending approval (feeds a dedicated second consensus pass)
- Generated: 2026-07-03
- **Agent roster:** Sage (Researcher, `evor-sage.md`) · Mutagen (Dreamer, `evor-mutagen.md`) · Probe (EDA/Analyst, `evor-probe.md`) · Forge (Implementer, `evor-forge.md`) · Selector (Critic, `evor-selector.md`)

These four pillars are **new requirements**, not restatements. Where they touch existing components, they refine them; the base spec remains authoritative for everything else.

---

## Pillar 1 — Mutation Representation (the "genome")

**Owner:** Forge (Implementer) is the ONLY agent that writes/edits candidate code. It takes an approved `MutationProposal` + the parent node's code and materializes the child node in an isolated worktree.

**Candidate structure = modular seams, never a monolith:**
```
candidate/
  genome.yaml      # declarative genome — parameterizes everything below
  data/            # dataset builder + augmentation pipeline (online/offline)
  model/           # backbone · neck · head — assembled by build_model(genome)
  train/           # training strategy: optimizer, schedule, loss, regularization
  evaluate.py      # LOCKED evaluator contract — mutations never touch it
```

**Two mutation tiers:**
1. **Parametric (config-level)** — change a gene in `genome.yaml` (backbone swap, head swap, LR schedule, aug set, optimizer). Cheap, composable, and **crossover-friendly**: `child.genome = merge(A.genome[backbone], B.genome[head], …)`. Clean crossover is only possible because of the modular seams.
2. **Structural (code-level)** — when a proposal is not expressible in the current genome schema (novel module, physics-inspired layer, new algorithm), Forge writes new module code **and extends the genome schema** to expose it as a future knob. **The search space grows as breakthroughs are discovered** — the genome is open/extensible, not fixed. This is the mechanism that lets oh-my-evor "break the boundary" while staying composable.

**approach_family → code locus** (why the taxonomy exists — it localizes edits + enforces diversity):
`arch → model/` · `training → train/` · `data-curation → data/ builder` · `augmentation → data/ aug` · `algo → new module + genome extension`.

**Provenance:** each mutation stored as a **diff/patch against the parent** (`git format-patch`) + resulting `genome.yaml`; the tree *edge* records the mutation delta; `code_ref` is a patch not a full copy (ties to content-addressed storage); lineage fully auditable.

**Seed handling (audit-first, no assumptions):**
- From-scratch: Forge generates the canonical modular skeleton (PyTorch default) as gen-1 root.
- Seed-repo: Forge audits the repo, finds its existing seams (model def / training loop / data pipeline), and fits a thin **genome adapter** over them so mutations apply in place — it does not force a rewrite.

**New entities:** `GenomeConfig`, `MutationLocus`.

---

## Pillar 2 — Dataset Safety: Frozen Splits + Augmentation Gating

**Core invariant: freeze the evaluation splits at mission start; mutate only train.**
- Test (and val) sets are **frozen and hash-locked** (`split_hash` + per-sample hashes), stored **read-only (`chmod 444`)** in the content-addressed store.
- The hash-lock is an **invariant re-asserted on every evaluation** (Integrity Gate recomputes + compares → mismatch = reject). This is data-level "no shift."
- **Only train + its augmentation pipeline are mutable.** Test/val are never touched by any mutation.

**Augmentation is safe by construction:** online (per-batch, ephemeral) and offline (materialized train samples) aug target **train only**; the evaluator loads the frozen test with fixed preprocessing — aug cannot enter evaluation.

**Five structural protection layers:**
1. **Physical read-only + isolation** — test/val are `444`; eval runs in the **isolated read-only subprocess** (consensus change R12), reading results from stdout only; `DataStore` API structurally refuses writes to frozen-split namespaces.
2. **Hash-lock verification every eval** — catches test-set swap/shrink/relabel/reorder.
3. **Leakage check (consensus change R5)** — no train sample (incl. augmented/curated/synthetic) may collide with a test sample at index **and** content-hash level, plus a **near-duplicate** check (catches an "aug" that is an identity/near-copy of a test sample).
4. **Per-sample provenance** — every train sample carries `(source_sample_id + transform_applied)`; the gate traces augmented samples to their source and confirms it was a train sample, never test/val.
5. **Curation guardrails** — drop/reweight/relabel operate on train only, recorded as versioned deltas; cannot shrink the test set or relabel eval data.

**Data as a versioned artifact:** `data-version = (frozen base-train hash) + (ordered data-mutation deltas)`; the frozen eval `split_hash` is **constant across all nodes** (gate-enforced invariant).

**Quality (separate from safety):** aggressive aug can drift the train distribution away from the frozen test distribution — **Probe's EDA monitors train-vs-test drift** as a quality signal; the **wildness dial** governs aug aggressiveness.

**New entities:** `FrozenSplit`, `DataProvenance`.

---

## Pillar 3 — Benchmark Evolution + Per-Domain Metrics

**Separate two acts:** evolving the *solution* (agents, untrusted, never touches the yardstick) vs evolving the *benchmark* (governed, versioned, consent-gated). "No shift" forbids **silent** goalpost-moving; **explicit versioned** hardening is a feature.

**Versioned eval suite (`eval_version`):**
- Hardening the test (e.g., scanned-only → +handwritten) creates a **new `EvalSuite v2`** — a superset of v1, separately hash-locked. **Never mutate v1 in place.**
- Old nodes keep v1 scores; nodes are **re-scored under v2** where feasible, else flagged "v1-only" (frontier never mixes yardsticks silently).
- Goal Contract records the bump and **re-establishes baseline/target under v2**.

**Governance:** Forge/Mutagen **cannot** harden the test (that IS goalpost-shift). A **`BenchmarkUpgrade`** is triggered by the user (milestone-ping decision) or **proposed** by Probe/Sage (with citation) when EDA shows saturation/under-coverage — surfaced for **explicit consent** because it changes the Goal Contract. Evor never auto-hardens to move numbers.

**Per-domain AND aggregate — always both.** Suite partitioned into named **domains/slices**. `EvaluationResult` is not a scalar:
```
{ eval_version, overall: {…}, per_domain: { scanned:{…}, handwritten:{…} }, per_slice: {…} }
```
Fitness driving tree selection is a Goal-Contract choice: **aggregate** (macro-avg), **worst-domain / robustness** (maximize the min — for "don't regress on any view"), or **weighted**.

**How ome "knows" metrics so Probe can analyze — `MetricSpec` / `MetricRegistry`:**
- Goal Contract declares a **MetricSpec**: metric name(s), direction (max/min), per-domain applicability, aggregation rule, primary-fitness vs secondary/reported-only.
- Evaluator emits a **structured, self-describing, domain-tagged, version-stamped** `EvaluationResult`.
- Stored dimensioned: `(eval_version, domain, metric_name) → value`.
- **Probe reads dimensioned metrics** (not a bare scalar) and pivots on `(eval_version, domain, metric)` without hardcoding: per-domain error analysis, regression detection on domain-add, robustness gaps, cross-node comparison.

**Cross-version safety:** each node stores `eval_version`; dashboard shows it; gate **refuses implicit cross-version comparison** (re-score or flag).

**New entities:** `EvalSuite`/`EvalVersion`, `Domain`/`Slice`, `MetricSpec`/`MetricRegistry`, `BenchmarkUpgrade`.

---

## Pillar 4 — Open-Ended / Generality Missions (the honesty ratchet)

**Problem:** ambiguous open-ended goals ("keep enhancing in all angles → general/world model, beat all SOTA"), where the user knowingly misses angles and Researcher discovers more later — while the test was locked. A single frozen test cannot define "general" (Goodhart).

**Resolution:** `mission_type` distinguishes **fixed** (frozen test, clean) vs **open_ended** (the benchmark itself must grow — honestly).

**The monotonic ratchet:** for open-ended missions, "no shift" is redefined as **only-ever-harder**:
- May **ADD** angles → new `eval_version`, strict superset: `v_{n+1} ⊇ v_n`.
- **Never** remove/weaken/shrink/relabel existing angles.
- Within any version: frozen + hash-locked.
- Result: you can only make the bar **broader/harder, never easier** → Goodhart-resistant (can't overfit a static target; the target expands to cover the model's weak angles).

**Setup captures a policy, not a fixed list.** `evor-setup` recognizes open-ended missions and captures an **ExpansionPolicy**: auto-add within a domain family? consent per angle? which SOTA sources count? (Designed for "I'll miss angles.")

**Discovering an angle ≠ getting its answers.** New angles are proposed by Researcher/Dreamer/Probe (with citations) and pass the **BenchmarkUpgrade** gate (user consent or pre-authorized policy). Each added angle arrives with its **own fresh held-out test split the training side never sees** (frozen, read-only, isolated). Each imports the **current published SOTA as its bar** → "beat all SOTA" = a growing *conjunction*: ≥SOTA on **every** angle simultaneously.

**Fitness for generality = worst-angle robustness + coverage**, never average: maximize the **minimum across all angles** and/or **coverage** (fraction of angles ≥ their SOTA). A model "becomes general/world" only when ≥SOTA across the whole growing suite.

**Expansion re-scores + demotes false generalists.** On v_n→v_{n+1}, live nodes re-evaluated on new angles; a node that looked best may drop (it failed the new angle — correct). "Best-so-far" = max worst-angle coverage under the latest version.

**Why honest, not cheating:** expansion is **monotonic** (add-only) + brings **fresh unseen labels** + is **governed/consent-gated + logged** (decision-log records every angle, proposer, citation, SOTA bar) + each version stays **frozen + hash-locked**. The yardstick only grows more demanding, transparently — the operational definition of "true general/world model."

**Termination:** no natural finish; stop on budget exhaustion, **worst-angle-coverage plateau** (can't lift the weakest domain after N ticks), or a **coverage target** (e.g., ≥SOTA on ≥95% of angles). Designed to run as a **living loop** (cron/scheduled), ingesting new angles + new SOTA as the field advances.

**New entities/config:** `mission_type` (fixed | open_ended), `ExpansionPolicy`, `AngleRegistry`, `CoverageTarget`, `SotaSource`, worst-angle fitness mode.

---

## Integration Map (which base components each pillar refines)

| Pillar | Refines base component(s) | Plan milestones to touch |
|--------|---------------------------|--------------------------|
| 1 Mutation genome | C Mutation System, B/Forge | M3 (Forge agent), M5 (engine/crossover), M8 (tick Step 4) |
| 2 Data freeze/aug | D Evaluation, H Harness, E Tracking | M1 (schemas), M4 (DataStore), M6 (IntegrityGate) |
| 3 Benchmark evolution/metrics | D Evaluation, A Orchestrator, B/Probe | M1 (MetricSpec schema), M6 (evaluator), M8 (BenchmarkUpgrade), M9 (dashboard per-domain) |
| 4 Open-ended generality | A Orchestrator, D Evaluation, setup | evor-setup skill, M5 (worst-angle fitness), M6 (angle held-out), M8 (living loop) |

## Consolidated New Entities (append to base ontology)
GenomeConfig, MutationLocus, FrozenSplit, DataProvenance, EvalSuite/EvalVersion, Domain/Slice, MetricSpec/MetricRegistry, BenchmarkUpgrade, ExpansionPolicy, AngleRegistry, CoverageTarget, SotaSource, mission_type.

## Acceptance Criteria (added)
- [ ] A parametric mutation and a structural mutation both produce valid child nodes; a crossover child inherits genes from two distinct lineages.
- [ ] Frozen split hash is verified on every eval; a seeded test-set tamper is rejected.
- [ ] A seeded near-duplicate-of-test augmentation is caught by the leakage check.
- [ ] `EvaluationResult` carries per-domain + aggregate metrics tagged with `eval_version`; Probe's generated EDA pivots on domain without hardcoding.
- [ ] A `BenchmarkUpgrade` (add a domain) creates a superset `eval_version`, re-scores live nodes, and is consent-gated + logged.
- [ ] Open-ended mission optimizes worst-angle coverage; adding an angle can demote a prior "best" node; expansion is monotonic (no removal permitted by the API).
