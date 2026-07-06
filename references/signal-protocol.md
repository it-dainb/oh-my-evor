# Signal Protocol — Shared Reference

Every agent that reads or writes the signal bus must read this file before acting.

---

## 1. What the Bus Is

The signal bus is a neutral, append-only observation channel shared across all agents in a run.
Bus file: `<run_dir>/signals.jsonl`

Producers emit **neutral, self-describing** signals — they describe what they observed, not what
should be done about it. Consumers read through their own **lens** (see each agent's
`<Signal_Lens>`). The same signal is a brief to Mutagen, a gate to Selector, a design input to
Forge-architect, and a possible escalation trigger for Evor. The bus never decides routing.

---

## 2. Signal Schema

```python
class Signal(BaseModel):
    signal_id: str          # auto-generated: "sig-<sha256[:12]>" of kind+signature
    kind:      str          # FREE TEXT, open-ended — e.g. "cuda-oom", "training-too-slow"
    signature: str          # DEDUP KEY — repeat emits aggregate, not duplicate
    shapes:    list[SignalShape]    # CLOSED: see §3
    axes:      list[SignalAxis]     # CLOSED: see §3
    severity:  SignalSeverity       # CLOSED: see §3
    evidence:  dict[str, Any]       # structured: metric values, config, node_id, etc.
    source:    str          # emitting role, e.g. "evor-forge-analyst"
    tick:      int | None
    node_id:   str | None
    confidence: float       # 0.0–1.0; raised on repeat (default 0.5)
    occurrences: int        # incremented on each dedup emit (default 1)
    first_seen: str         # ISO 8601
    last_seen:  str         # ISO 8601
```

`kind` is intentionally open — new signal types need no code change. Closed facets (`shapes`,
`axes`, `severity`) are how lenses subscribe.

---

## 3. Closed Facet Vocabularies

### Shapes (what kind of finding is this?)
| Value | Meaning |
|---|---|
| `limit` | A hard or soft ceiling — something is maxed out or blocked |
| `opportunity` | An opening — absence of prior art, unused capacity, unexplored angle |
| `failure` | A concrete runtime or integrity failure |
| `trend` | A directional pattern that warrants a strategic response |

### Axes (which resource or quality dimension?)
| Value | Meaning |
|---|---|
| `memory` | GPU/CPU memory pressure |
| `compute` | Throughput, wall-clock speed, FLOP cost |
| `accuracy` | Eval metric quality |
| `stability` | Gradient health, loss smoothness, reproducibility |
| `data` | Dataset coverage, quality, augmentation headroom |
| `generalization` | Domain transfer, worst-angle coverage, confusion patterns |
| `cost` | API spend, cloud cost, search budget |

### Severity
`low` → `medium` → `high` → `critical`

Severity gates whether a signal reaches a **spawn digest** (`digest()` defaults to
`min_severity="medium"`). Critical signals are injected into every digest unconditionally.

---

## 4. The 4 Lens Modes

Each agent's `<Signal_Lens>` declares which mode(s) it applies:

| Mode | Agent | Behavior |
|---|---|---|
| **brief** | Mutagen | A matching signal spawns a **diverse solve-it-K-ways** set of proposals across distinct families/angles. Never a single avoidance. The avoidance floor is Selector's job. |
| **gate** | Selector, Forge-critic | A matching signal becomes a **hard rejection reason**, complementing structural gates. |
| **default** | Forge-architect | A matching signal is **baked into the design** as a mitigation — e.g. gradient checkpointing on a memory limit. |
| **escalate** | Evor / Probe | A matching signal triggers a **consent-gated contract change** — monotonic toward harder/more honest only. Softening is structurally prohibited. |

---

## 5. Emit (Python)

```python
from evor.signals import SignalBus, make_signal
from pathlib import Path

bus = SignalBus(Path(run_dir))
bus.emit(make_signal(
    kind="training-too-slow",          # free text
    signature="slow-cand-1",           # dedup key — reuse across ticks for same root issue
    shapes=["limit", "trend"],
    axes=["compute", "cost"],
    severity="high",
    evidence={"wall_min": 22, "node_id": nid, "batch_size": 128},
    source="evor-forge-analyst",
    tick=tick,
    node_id=nid,
))
```

Repeat emits with the same `signature` increment `occurrences`, bump `last_seen`, and raise
`confidence` toward 1.0 (recurrence × confidence weighting). Severity escalates to MAX seen.

---

## 6. Query (Python)

```python
from evor.signals import SignalBus
from pathlib import Path

sigs = SignalBus(Path(run_dir)).query(
    shapes=["limit", "opportunity", "trend"],   # ANY-overlap match
    axes=["memory", "compute"],                 # ANY-overlap match
    min_severity="medium",                      # floor
    since_tick=None,                            # all ticks
)
# Returns list[Signal] sorted by (severity, confidence, last_seen) descending
```

`digest()` returns the same data as a compact list of dicts, capped at `max_items=8`, suitable
for injection into a spawn prompt.

---

## 7. Hook Tag Form

Agents may emit signals via inline hook tags when they cannot run Python directly:

```xml
<evor-signal kind="cuda-oom" shapes="failure,limit" axes="memory,compute" severity="high">
  batch_size=256 OOM at epoch 3; node=node-xyz; peak_vram_gb=15.8
</evor-signal>
```

The PostToolUse hook parses these tags and calls `SignalBus.emit()` automatically.
Tag body is free-text evidence; the hook sets `source` from the emitting agent's name.

---

## 8. Storm / Oscillation Dampers

Four mechanisms prevent signal storms and oscillation:

1. **Dedup by signature** — same `signature` aggregates rather than duplicates; `occurrences`
   rises, `confidence` rises toward 1.0.

2. **Severity gates digests** — `digest()` defaults to `min_severity="medium"` so low-noise
   signals never flood spawn prompts. Critical signals always surface.

3. **Recurrence × confidence weighting** — `query()` sorts by `(severity, confidence, last_seen)`
   descending. A recurring high-confidence signal ranks above a one-off critical with no history.

4. **One-off pains → briefs; recurring pains → strategy shifts** — a single `limit` signal at
   `occurrences=1, confidence=0.5` is a brief prompt for Mutagen. The same signal at
   `occurrences=5, confidence=0.9` should shift strategy (e.g. Selector gates the family,
   Forge-architect bakes in a standing mitigation).

---

## 9. Quick Reference — Who Emits What

| Agent | Signal kinds | shapes | axes | severity |
|---|---|---|---|---|
| evor-forge-analyst | `cuda-oom` | failure, limit | memory, compute | high/critical |
| evor-forge-analyst | `training-too-slow` | limit, trend | compute, cost | medium/high |
| evor-forge-analyst | `nan-loss`, `divergence` | failure | stability | high |
| evor-forge-junior | `build-failure` | failure | — | medium |
| evor-forge-critic | `integrity-violation` | failure | — | critical |
| evor-probe | `eval-saturated` | trend | accuracy | high |
| evor-probe | `class-confusion` | limit | accuracy, generalization | medium |
| evor-probe | accuracy-axis lessons | various | accuracy | medium |
| evor-sage | `no-evidence-found` | opportunity | — | medium |
| evor-sage | `sota-bar` facts | — | accuracy | low/medium |
| evor-sage-junior | `no-evidence-for-angle` | opportunity | — | low |
| evor-selector | `family-<X>-rejected` | trend | — | medium |
