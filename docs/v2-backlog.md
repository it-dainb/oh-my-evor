# v2-optimize

Branched from `evor/v1-optimize` (the release). Everything here is work the
release deliberately left out, plus the two agent-file fixes it could not ship.

**Goal: win back the $0.2618/call the release forgoes, by producing the evidence
the gate demanded — not by lowering the gate.**

The gate a tier change must clear to ship: **accuracy ≥95% absolute, difference
CI clears −10pp, both arms from one paired run, material cost saving.**

---

## What the release left on the table

Five tier changes were measured, found short, and reverted to their `main`
tiers. None is suspected of regressing; each has thin evidence, not adverse
evidence.

| role | release tier | candidate | measured | short by | saving at stake |
|---|---|---|---|---|---|
| forge-critic | opus | haiku | 29/30 vs 27/30, CI [−8.2, +22.5] | arms came from **separate runs** | $0.0777/call (68.0%) |
| forge-analyst | opus | haiku | 101/108 vs 103/108, CI [−8.7, +4.8] | 93.5% < 95% | $0.0734/call (63.5%) |
| sage-junior | sonnet | haiku | 31/33 vs 29/33, CI [−9.3, +21.9] | 93.9% < 95% | $0.0685/call (65.7%) |
| forge-architect | opus | sonnet | 28/30 vs 26/30, CI [−10.0, …] | 93.3%, CI exactly on the margin | $0.0422/call (40.6%) |
| forge | opus | sonnet | 3-tick A/B, 148/160 vs 147/160 | no per-attempt n to build an interval | 17%, unquantified per call |

The two categories need different work. **forge-critic** and **forge** fail on
*measurement design* — re-run them properly and the numbers may already be
there. **forge-analyst**, **sage-junior** and **forge-architect** fail on
*absolute accuracy*, which means defect-hunting, not repeats.

---

## P0 — the two fixes this branch carries and the release could not

Both were written after the runs that measured those files, and their
verification runs were killed. They are on this branch, unmeasured.

| role | command | expected |
|---|---|---|
| forge-analyst | `ROLE_EVAL_TIERS="haiku:medium,sonnet:medium" ROLE_EVAL_REPEATS=9 ROLE_EVAL_OUT=ci/out/analyst-s49.json node ci/role-eval.mjs evals/forge-analyst/spec.json` | fixes `oom-high-with-checkpointing`, weak in BOTH arms (5/9, 6/9). Both arms up; haiku ~96% from 93.5% would clear the accuracy gate and recover $0.0734/call |
| forge-architect | same shape → `ci/out/architect-s47.json` | removes the Dimension 3 redirect behind `wrong-loss-for-task` haiku 1/9. If it recovers to ~8/9, haiku ~88/90 vs ~89/90 → clears the gate at −67% |

Both roles sit at **opus** on this branch, inherited from the release. Adopt only
after the measurement, and adopt to the tier the measurement supports.

## P1 — re-measure the two that failed on design, not ability

| role | what to change | why |
|---|---|---|
| forge-critic | run both arms in **one paired run** at n≥90 | its only defect is that haiku and sonnet came from separate sessions; 29/30 vs 27/30 already clears accuracy and the CI |
| forge | build a per-attempt spec | a 3-tick A/B cannot produce an interval. 148/160 vs 147/160 is one sample; see P4 on orchestrators first |

forge-critic is the cheapest win on this branch: no file edits, one run.

## P2 — accuracy work on sage-junior

93.9% at n=33, and the only role of the three whose shortfall has not already
been diagnosed. Read the failing cases before adding repeats — the pattern held
thirteen for thirteen in v1 that an apparent capability limit was a prompt
defect.

## P3 — give `evals/acquirer` resolving power

Both arms score 36/36. The spec proves the absence of a *large* regression and
nothing finer, so acquirer ships on a gate it cannot actually stress. Same
latent issue, milder, for probe (66/66 both arms). Add cases the current file
gets wrong; respect the degenerate-strategy floor in `ci/eval-core.mjs` — no
constant answer may clear `ceil(cases.length/3)`.

## P4 — the three orchestrator roles: forge, forge-junior, tick

`forge` reverted to opus. `forge-junior` has a strong *effort* measurement
(45/45 across low/medium/high) but was never tried at haiku. `tick` is new and
has never been benchmarked at all.

These are **orchestrators**, not leaves: they spawn subagents, so a failure
cascades into wasted downstream calls rather than surfacing as one wrong field.
The eval harness grades a single agent's artifact and cannot see that blast
radius. **Design the spec before measuring** — grading an orchestrator on its own
output repeats the mistake catalogued in `docs/agent-file-defects.md`.

`forge-junior` carries a known trap: an earlier tier matrix on it measured the
scheduler, not the models. Those numbers are invalid; do not cite them.

## P5 — fingerprint the prompt body, not the whole file

`role-eval.mjs` hashes the entire agent file, so adopting a retier
(`model:` → haiku, dropping `effort:`) invalidates the fingerprint of the very
run that justified it. In v1 this forced a forensic argument to establish which
revision the acquirer run had measured — two behavioural rules, six for six —
where a body hash would have answered it in one command.

Emit `agent_body_sha256` and `agent_frontmatter_sha256` separately. Pooling
refuses on a body mismatch, permits a frontmatter-only difference.

## P6 — measure a real tick

The number everyone actually wants. Needs role invocation counts, which no
artifact records — `.evor/runs/**/ticks/` holds one findings file and no cost
telemetry. Until this exists, every saving figure keeps its "not a tick" caveat.

## P7 — explain the modelled-vs-billed gap

Billed exceeds modelled by 1.142× on haiku and 1.261× on sonnet and opus
(n=1988). v1 reports billed and labels the basis, which is correct but is a
workaround: a pricing-table bug and a token-accounting bug look identical from
outside. The tier asymmetry is the clue — whatever is wrong is not a flat
multiplier. Every future retier is denominated in these dollars.

---

## Method notes worth carrying forward

- **Read the model's answer before concluding a capability limit.** Thirteen for
  thirteen in v1: every apparent haiku limit was a prompt defect. Two minutes of
  reading against hours of harness time — and the repeats would have measured
  the wrong file anyway.
- **A case failing in every arm is a fixture or file bug**, never a tier
  difference. `compare-arms.py` splits per-case output on exactly this.
- **A case weak in both arms is worth fixing even when it changes no verdict** —
  it lifts the expensive arm too.
- **Concentrated single-case failure on the cheap arm** = the rule is stated far
  from where the field is written. Restate it at `Output_Format`.
- **Being less literal is not being more correct.** Twice, where sonnet passed a
  case haiku failed, the cause was sonnet silently ignoring a contradictory
  instruction that haiku followed.
- **Re-measure BOTH arms after any prompt edit.** S36 aimed a fix at haiku and
  took sonnet from 37/39 to 61/78. The tell was the cheap arm outscoring the
  strong one.
- **A fix can break what a previous fix repaired.** One edit rescued
  `truncated-run-trap` and broke `nan-telemetry` in the same stroke.
- **Do not use n as a gate.** It double-counts what the CI already measures. An
  `n≥60` rule briefly excluded acquirer (36/36, CI [−9.6, +9.6]) and
  forge-junior (45/45, CI [−7.9, +7.9]), both of which clear the margin outright.
- **n reality:** n=30 → 15.4pp, n=60 → 9.3pp, n=90 → 7.5pp, n=120 → 6.1pp,
  n=200 → 4.6pp. The 10pp margin is what n can reach, not what is comfortable.
