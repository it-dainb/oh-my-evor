# RC5-autonomy-termination — recovered from lane transcript

> Recovered from the lane's transcript after it completed analysis but did not
> write its own file. Content is the lane's own words, verbatim, in order.

---

My only change is the new file. Findings:

**`docs/field-trace-v1.2.0/root-cause/RC5-autonomy-termination.md`** (917 lines).

**Root cause, one line each:**

- **C-02** — The predicate was calibrated against the *fixture corpus*, not the schema, and framed as binary (require `step_status` or ignore it) when the data is three-valued. Commit `6c713b7` says so verbatim: *"kept deliberately loose… Demanding `step_status === "done"` made three existing tests fail, all with tick-state that omits the field."* But `mcp/src/tools/state.ts:25-28` makes `step_status` **required** — the omitting fixtures are ones no sanctioned writer could produce. `step >= 9 && step_status !== "running"` satisfied all three fixtures *and* blocks the field state; the binary framing hid it.
- **L-02** — The invariant is a **sound theorem about legal moves deployed as a theorem about productive moves**; its unstated precondition is that fitness responds to the monotonic direction, which holds only while the system alone sets the gates. It was *believed*, and correctly — the author even wrote the infeasibility halt branch (`skills/evor/SKILL.md:82-92`, "surface it and stop") and bound it to the one cause he foresaw (integrity checks) instead of the structural class. L-05 is the mechanism: `MetricConstraint` is documented (`contracts.py:63-71`) as an anti-gaming *floor* and was used as a *goal*; same field, opposite feasibility requirements.
- **K-06** — "Validation" here means write-safety, not feasibility (`init_run.py:129`: *"ALL validation before ANY disk write"*). Reachability was never in the requirement set. Answering the brief directly: an empty registry is **the only starting state init can produce** — `angle-registry.json` isn't among init's seven artifacts and is created lazily empty (`angle_registry.py:82-92`).
- **K-07** — Not a sentinel *misread*: a **three-way collision**. `skills/evor-setup/SKILL.md:177` assigns `0 = local-only`; `tree.py:828` truthiness reads it as unlimited; the type says "stop now". Premise was true when cost meant GPU rental and died when cost became inference. Compounded: cost is a stop *type*, not a ceiling, so an explicit $10 binds nothing under `target`.
- **K-09** — The whole enforcement layer is **edge-triggered**; a stall is the absence of edges, so it is structurally unobservable. Liveness wasn't rejected — the question was unreachable from the frame.
- **L-09** — `evor-run/SKILL.md:98` states the rule then forwards ownership to a component that doesn't implement it. Sharpest evidence in the doc: `skills/evor-schedule/SKILL.md` documents `evor_schedule({run_id, mode:"scheduled"})`; the real tool (`schedule.ts:63-71`) submits GPU jobs and requires `node_id`+`job_spec`. **That call has never been possible.**
- **L-06** — Waiting specified as *intention*, never *mechanism*: zero `run_in_background` in any agent/skill file; the one place a primitive is named is a `stop.mjs` block message fired after the turn ends. Not a learning failure — a **write-back** failure.

**Shared root:** *This system decides when things end by asking many independent questions with permissive defaults — and never asks the composite one, because the rule that would ask it lives in prose, and prose here is written, forwarded, and drifted from without ever being executed.* Note §0: `stop.mjs` fails open toward *stopping*, `tree.py:894` toward *continuing* — the two halves disagree, which **is** C-01.

On the brief's cross-cutting question: prose-vs-code is the propagation mechanism, not the root. The repo enforces plenty in code well; what's missing is any decision about **which layer owns which rule**, and any audit that a rule in one has a counterpart in the other.

**Predictions ranked by checkability:**
1. **P17** — other skill files instruct MCP calls with nonexistent signatures. Diff every `evor_*({…})` in `skills/**` + `agents/**` against the Zod schemas. Half-day script; `evor_schedule` is one confirmed hit.
2. **P10** — every `if <numeric>` truthiness test where 0 is legal. Candidates: `wildness`, `plateau_window`, `budget_ceiling_extensions`. Grep suffices.
3. **P11/P12** — `max_wall_clock_hours` and `max_gpu_hours` are declared and read by nothing (and `max_wall_clock_hours` is exactly what L-09 needs); `contracts.py`↔`contracts.ts` field-by-field diff (`coverage_target` bounds already drifted).
4. **P13** — any `GoalContract` field absent from the consent summary has never been human-reviewed on any run. `max_cost_usd` is confirmed absent.
5. **P9** — feed `evor-setup/SKILL.md:455-480`'s template through `validate_run`; it ships `circuit_breaker: 5` against `max_iterations: 50`.
6. **P8** — diff files read at runtime against the seven `init_run` writes; each difference is a K-06 candidate.
7. **P16** — hold `tick_count` fixed and confirm no stop condition in `tree.py:738-895` can fire; a non-advancing run is immortal.
8. **P3** — `git log --grep` for "deliberately loose" / "false-stop" maps every fixture-weakened predicate.

---

The file exists and is complete — no rewrite was needed.

- **Path:** `/home/dainb_1/research/oh-my-evor/docs/field-trace-v1.2.0/root-cause/RC5-autonomy-termination.md`
- **Lines:** 917 (52,306 bytes), written at 09:20
- Sits alongside RC1–RC4 and RC6–RC8 in the same directory.

No Write failed and nothing was blocked. I created the directory with `mkdir -p` myself before writing via a heredoc, which is why the missing-directory problem never arose in my lane. Re-running `mkdir -p` just now was a no-op.

Structure is as specified — per finding (C-02, L-02, K-06, K-07, K-09, L-09, L-06, plus L-05 and C-01 where load-bearing): Proximate cause → numbered causal chain with commit sha or file:line at each step → **ROOT CAUSE** stated as a belief or design commitment → Contributing factors → Trigger → Predictions. It closes with §8 (three recurring mechanisms), §9 "The single sentence", and an evidence index table mapping every causal claim to its sha, file:line, or grep result.

No gaps to flag: every finding in the brief is covered, and the two the RED suite marked NOT-TESTABLE-IN-CODE (L-02's policy branch, L-09's threshold) are analyzed from prose and schema evidence rather than left open. My earlier summary message carries the per-finding root causes and the ranked predictions.
