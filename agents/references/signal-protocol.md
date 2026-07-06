# Signal Protocol

The authoritative reference for the Evor signal bus. Every agent's `<Signal_Lens>` section
opens with "Read references/signal-protocol.md before acting." This is that file.

---

## Purpose

The signal bus is a shared, deduplicated stream of self-describing observations that steer
the search. Producers emit neutral facts about what the run is experiencing — limits to
avoid, opportunities to chase, failures to learn from, trends to act on. Consumers pull
what is relevant to their own lens; the same signal is a brief to Mutagen, a gate to
Selector, a default to Forge-architect, and an escalation input to the orchestrator. The
bus never decides routing — that is each consumer's job.

Signals accumulate across ticks. A `cuda-oom` emitted in tick 3 is still visible in
tick 7. Repeat occurrences of the same signal raise its `confidence` and `occurrences`
count, making recurring patterns progressively harder to ignore.

---

## Closed Facet Vocabularies

`kind` is **open** — any descriptive string. The three closed facets below are how
consumers subscribe. Use only values from these sets; unknown values are rejected by the
`Signal` schema.

### shapes — what kind of signal this is

| Value | Meaning |
|---|---|
| `limit` | A constraint or ceiling the search is hitting |
| `opportunity` | An unexplored angle or improvement space |
| `failure` | A concrete error, violation, or breakdown |
| `trend` | A directional pattern evolving over time |

A signal may carry multiple shapes (e.g. `["failure", "limit"]` for OOM — it is both an
error and a hard ceiling).

### axes — which dimension of the run is affected

| Value | Meaning |
|---|---|
| `memory` | GPU/CPU memory pressure |
| `compute` | Throughput, wall-clock time, parallelism |
| `accuracy` | Primary metric, hypothesis outcomes, SOTA distance |
| `stability` | Gradient health, loss stability, convergence |
| `data` | Dataset quality, provenance, acquisition, contamination |
| `generalization` | Cross-domain coverage, family diversity, approach breadth |
| `cost` | Budget burn rate, resource cost |

### severity — urgency and digest eligibility

| Value | Meaning |
|---|---|
| `low` | Informational; never included in spawn digests by default |
| `medium` | Notable; included in spawn digests |
| `high` | Urgent; included in spawn digests; may gate candidate selection |
| `critical` | Must be resolved; blocks propagation; always in digest |

The `digest()` default floor is `severity >= medium`. A `low` signal is visible via
`query()` but never floods a spawn prompt.

---

## The MCP Path Is Canonical

**Emit signals with `evor_signal_emit`. Read signals with `evor_signal_query`.**

`evor_signal_emit` and `evor_signal_query` are the only path — do not bypass them.
This path is validated, lineage-tracked, and ensures the inbox is drained before
results are returned.

```
evor_signal_emit({
    run_id,
    kind,          # free-text, e.g. "cuda-oom"
    signature,     # dedup key — see Dedup section below
    shapes,        # list from closed vocab
    axes,          # list from closed vocab
    severity,      # from closed vocab
    evidence,      # structured dict — metric values, config, node_id, etc.
    source,        # your agent role string, e.g. "evor-forge-analyst"
    tick?,         # current tick number
    node_id?,      # node this signal is about, if applicable
    confidence?,   # 0.0–1.0 initial confidence (default 0.5)
})

evor_signal_query({
    run_id,
    shapes?,       # filter by any-overlap
    axes?,         # filter by any-overlap
    kind?,         # exact match
    min_severity?, # default "low"
    since_tick?,   # only signals at or after this tick
})
```

### The `<evor-signal>` tag — hook-capture fallback

When you cannot call `evor_signal_emit` directly (e.g. inside a tool response body or
Write tool content), embed a signal tag in your output text. The PostToolUse hook
captures it and writes it to `signals-inbox.jsonl`, which is drained into the bus on the
next `evor_signal_query` call.

```
<evor-signal kind="cuda-oom" shapes="failure,limit" axes="memory,compute" severity="high">
  OOM at step 12, batch 256, peak 23.4 GB on A100 80 GB
</evor-signal>
```

Attribute format: `kind` (required), `shapes` (comma-separated), `axes` (comma-separated),
`severity`. The tag body becomes `evidence.description`. The hook computes the signature
automatically (SHA-256 of the description text, prefixed by kind).

Use the MCP tool when you can — the tag is a safety net, not the primary path.

---

## Emit vs Query Roles Per Agent

| Agent | Mode | What it does |
|---|---|---|
| **evor-forge-analyst** | Emit (primary producer) | Emits operational signals after Pass 1–3 analysis: OOM, slow training, NaN loss, divergence, throughput collapse |
| **evor-probe** | Emit + escalate | Emits accuracy-axis lessons after EDA; escalates `eval-saturated` when saturation + new-angle conditions are met; emits gradient health and LR signals |
| **evor-sage** | Emit | Emits `sota-bar` when an authoritative bar is established; emits `no-evidence-found` when a research angle has no prior art |
| **evor-acquirer** | Emit (leaf) | Emits `data-acquired` on success; emits `leakage-blocked` whenever collision items were detected |
| **evor-selector** | Query + emit | Queries `failure/limit` signals before evaluating proposals (hard gate); emits `family-{X}-rejected` after repeated family rejections |
| **evor-mutagen** | Query (brief) | Queries `limit/opportunity/trend` signals at `min_severity=medium` before proposing; uses signals to avoid known dead-ends and chase open opportunities |
| **Orchestrator** | Query + emit | Queries digest before spawn; emits `integrity-violation`, `data-leak-suspected`, `budget-burn`, `diversity-collapse` based on run state |
| **evor-forge** / **evor-forge-architect** | Query (brief) | Reads the digest injected into the spawn prompt; uses signals as defaults (e.g. avoid batch sizes that caused OOM) |
| **evor-sage-junior** | None | Does not interact with the bus directly |
| **evor-forge-critic** / **evor-forge-junior** | None | Do not interact with the bus directly |

---

## Dedup and Signature

Every signal has a `signature` — the dedup key. When `evor_signal_emit` receives a signal
whose `signature` matches an existing record, it **merges** rather than duplicates:

- `occurrences` increments
- `last_seen` updates to now
- `confidence` rises toward 1.0 (formula: `old + (1 - old) * 0.4` per occurrence)
- `severity` takes the MAX of old and new (a recurring signal can only escalate)
- `evidence` merges (new values overwrite old keys)

**Construct signatures to be stable and specific:**

```
# Good — stable across repeat occurrences of the same root cause
signature=f"cuda-oom-bs{batch_size}-{task_slug}"
signature=f"family-rejected-{rejected_family}"
signature="eval-saturated"          # intentionally single dedup key across all ticks

# Bad — unique per call, defeats dedup
signature=f"cuda-oom-{uuid4()}"
```

Do not spam duplicates. The recurrence x confidence weighting means a signal that fires
three times is treated with much higher priority than one that fires once. If the same root
cause recurs, use the same signature so the bus learns from recurrence.

---

## Digest — the Mandatory PUSH Half

Before spawning any specialist agent, the orchestrator injects a compact signal digest into
the spawn prompt. This is the push half of the protocol — agents do not need to query the
bus to learn about the most important active signals; the orchestrator ensures they arrive.

```
evor_signal_query({ run_id, min_severity: "medium" })
# — or via dedicated digest tool —
evor_signal_digest({ run_id, max_items: 8 })
```

The digest contains the top slice sorted by `(severity DESC, confidence DESC, last_seen DESC)`,
filtered to `severity >= medium`. Low-severity informational signals never flood a spawn prompt.

Each specialist agent may additionally call `evor_signal_query` with its own lens (shapes +
axes filter) to pull signals beyond what the digest carries. The digest is the floor, not
the ceiling.

---

## Complete Kind Catalogue

`{X}` in kind strings is a placeholder for a variable (e.g. `family-arch-rejected`).

### Existing kinds

| kind | shapes | axes | severity | primary emitter | trigger |
|---|---|---|---|---|---|
| `cuda-oom` | failure, limit | memory, compute | high (critical at step 0) | evor-forge-analyst | OOM error during training |
| `training-too-slow` | limit, trend | compute, cost | high (medium if moderate) | evor-forge-analyst | Throughput below expected target |
| `nan-loss` | failure | stability | high | evor-forge-analyst | NaN or Inf in loss at any training step |
| `divergence` | failure | stability | high | evor-forge-analyst | Loss increasing over last 10% of steps |
| `hypothesis-confirmed` | trend | accuracy | medium | evor-probe | Actual delta within or exceeding predicted range |
| `hypothesis-refuted` | trend | accuracy | medium | evor-probe | Actual delta outside predicted range in either direction |
| `hypothesis-inconclusive` | trend | accuracy | medium | evor-probe | Telemetry absent, eval incomplete, or integrity failed |
| `eval-saturated` | trend | accuracy | high | evor-probe | ≥3 consecutive ticks with primary metric improvement < 1% |
| `class-confusion` | limit | accuracy, generalization | medium | evor-probe | Per-domain performance gap ≥15% across domains |
| `family-{X}-rejected` | trend | generalization | medium | evor-selector | Same approach_family rejected in ≥2 consecutive ticks |
| `sota-bar` | trend | accuracy | low | evor-sage | Authoritative SOTA bar established for an angle |
| `sota-coverage-gap` | limit | accuracy, generalization | medium | evor-probe, evor-sage | Worst-angle coverage below the coverage target |
| `data-acquired` | opportunity | data | medium | evor-acquirer | External or synthetic data successfully integrated into a split |
| `data-contamination-detected` | failure | data, accuracy | critical | orchestrator, evor-acquirer | Test-set contamination confirmed in training data |
| `no-evidence-found` | opportunity | accuracy | medium | evor-sage | No prior art found for an angle after exhausting wiki + external search |
| `leakage-blocked` | failure | data | medium (high if >20% collision rate) | evor-acquirer | Train/test collision items detected and removed during acquisition |

### New kinds (§15D)

| kind | shapes | axes | severity | primary emitter | trigger |
|---|---|---|---|---|---|
| `gradient-explosion` | failure | stability | high | evor-probe | max(grad_norm) > 100 OR p95 > 10x mean |
| `gradient-vanishing` | failure | stability | medium | evor-probe | mean(last 10 grad_norms) < 0.001 with param_norm present and non-zero |
| `lr-schedule-misconfigured` | limit | stability | medium | evor-probe | LR constant for the entire run, or val metric degrades within 5 steps of any lr decrease > 50% |
| `overfit` | trend | accuracy, generalization | medium | evor-probe | Train loss decreasing while val metric plateaus or degrades over last 20% of steps |
| `plateau` | trend | accuracy | medium | evor-probe, orchestrator | Primary metric unchanged (< 0.5% change) over a sustained window |
| `budget-burn` | trend | cost | medium | orchestrator, evor-forge | Cumulative cost approaching or exceeding a budget threshold; escalate severity to high near ceiling |
| `throughput-collapse` | trend | compute, memory | high | evor-forge-analyst | Sudden sustained drop in samples/sec — indicator of memory pressure before OOM |
| `integrity-violation` | failure | accuracy | critical | orchestrator | `evor_integrity_check` returned failed for a completed node; score must not propagate |
| `data-leak-suspected` | failure | data, accuracy | critical | evor-probe, orchestrator | Leakage pattern detected between test and training data |
| `diversity-collapse` | trend | accuracy, generalization | medium | orchestrator, strategy | Population converging on a single approach family; search space collapsing |
| `sota-gap` | limit | accuracy, generalization | medium | evor-probe, evor-sage | Measurable gap remains between current best and the established SOTA bar on a tracked angle |

**Note on `family-{X}-rejected` axis:** the correct axis is `generalization` (search-space
diversity), not `accuracy`. Any agent code using `axes=["accuracy"]` for this kind should
be updated to `axes=["generalization"]`.

**Note on `overfit` severity:** emit at `medium` initially; raise to `high` if the gap
between train loss trajectory and val metric persists for more than 30% of total steps.

---

## Emit Discipline

- Emit only when warranted by actual evidence (telemetry values, measured metrics, observed
  errors). Do not emit speculative signals.
- Each emit is a durable record. It affects Selector's gate, Mutagen's briefs, and the
  orchestrator's digest in every subsequent tick.
- Use the most specific `signature` that deduplicates correctly — stable across repeat
  occurrences of the same root cause, unique across distinct root causes.
- Provide structured `evidence` dicts with numeric values (not prose descriptions) wherever
  possible: `{"batch_size": 256, "peak_vram_gb": 23.4, "oom_step": 12}`. Downstream agents
  act on the numbers, not the text.
