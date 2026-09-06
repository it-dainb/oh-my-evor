---
name: agent-behaviour-trace
description: Trace an agent-eval failure to the layer that caused it — instruction, capability, workflow, skill, or harness — instead of scoring it as model behaviour
triggers:
  - "why did this scenario fail"
  - "FP FN root cause"
  - "the agent did the right thing and still failed"
  - "this passes sometimes and fails sometimes"
  - "bench regression"
  - "trace the trajectory"
---

# Tracing an agent-eval failure to its layer

For any harness that scores agent behaviour (`ci/bench-run.mjs`, role evals, tier
matrices). Its job is to stop you publishing a **harness defect as a model
defect** — the failure this kind of bench exists to catch, and the one its
author is most likely to commit.

## Rule 0 — variance is not noise

A scenario that passes once and fails once on a byte-identical fixture is a
**natural experiment you already ran**. Two trajectories exist, each with a call
sequence and stated reasoning, and the divergence names its own cause.

"Noise" is what variance looks like from the verdict column with the transcripts
unopened. Calling a cell noisy closes the investigation, and closing it early is
how the instrument's own defects get attributed to the model.

Corollary: **read the answer text before the verdict.** In this codebase the
agent stated the true cause in plain language every single time — "the prompt
template appears broken, it ends with a literal `{{ASK}}`", "15,062 minutes past
its 7200s limit", "resolve_doi returned a mismatched record (a different DOI)",
"no parent node exists in tree.json to mutate from". Every one was scored as an
agent failure first.

## The six layers, and the question that picks one

Ask in this order. The first YES is your layer.

1. **Harness / fixture** — could a correct agent have passed at all?
   Is the fact the scenario turns on reachable? Is the state seeded? Is the guard
   watching the tree the agent works in? Do the fixture's own fields agree with
   each other?
2. **Capability** — did the agent hold the tools the task needs, and did a guard
   deny something it legitimately holds? Check `permission_denials`, and whether
   the denial was *declared*.
3. **Skill / context** — does the role declare skills, hooks or a briefing the
   harness does not deliver? A `Skill` call that errors is this layer, loudly.
4. **Instruction conflict** — do two documents the same role reads disagree?
   The highest-value find and the hardest to see, because each document is
   locally correct.
5. **Instruction gap** — is the obligation stated nowhere, or stated as prose
   with no writer? (AF6: *an obligation stated in prose to an agent is an
   obligation the system has decided not to have.*)
6. **Model behaviour** — only after 1–5 are excluded. Say so plainly and do not
   design around it.

## The measurements that actually discriminate

Run these before forming a hypothesis. Most intuitions die here; that is the point.

```
# pool runs — one n=2 run cannot separate a defect from a coin flip
6/6 failures  → systematic, act on it
1-2/6         → do not act; an edit here has an effect you cannot measure

# splits "did the wrong thing" from "did the right thing silently"
FN detect=true , declaration=false → correct restraint, unannounced → layer 3/4/5
FN detect=false                    → genuinely did not do it        → layer 6
FP detect=true , declaration=true  → acted and declared where it should not

# the one that found the largest defect in this repo
median tool calls before the first owned-tool call:  ok 6   bad 14
tools used ONLY in passing runs vs ONLY in failing runs, per scenario
```

Hypotheses that **failed** here and must be tested rather than assumed:
"failures thrash" (median calls identical, 14/14) and "failures hit tool errors"
(46% vs 56%, and ≥2 errors was *more* common in successes).

## The false greens

A fix can move the number without fixing anything. All of these occurred:

- **Void-masking** — a cell stops scoring instead of scoring correctly. Voids are
  excluded from F1, so FP drops and F1 rises. Report the corrected figure.
- **Tool-bypass** — an agent that never calls the tool disappears from every
  trace predicate written against it, so `none_of` passes trivially. A TN from an
  agent that did nothing is not a TN.
- **Unpassable scenario** — `forbidden` with no `matcher` forbids the FIELD, not
  the value; if the field is contract-mandatory, no correct answer can pass.
- **Unreachable delta** — the discriminating fact sits behind a call the agent has
  no reason to make.
- **Rot** — absolute timestamps age, premises describe bugs that got fixed,
  fingerprints describe files that moved. `--check` stays green because the bytes
  never changed, only their meaning.

## What you must not do

- **Never weaken a detector to make a cell pass.** Making one *discriminate*
  where it could not (parametrising on the half's own target) differs from
  loosening it, and the difference belongs in the commit message.
- **Never refresh a fingerprint to green a staleness gate.** That re-points a
  published measurement at text it never ran against. Mark the row stale, record
  the sha it went stale at, and withdraw it in the prose that cites it.
- **Never remove the temptation a scenario measures.** `disallowedTools` is a
  stronger instrument than prose — but if a detector's PARTIAL exists to catch
  the bypass, denying the tool turns a measurement into a constraint and the
  finding disappears.
- **Never edit a product or agent file while a scored run is in flight.**
  Guarded-path shas are checked per scenario; the run dies mid-way.

## Verification, every time

```
<generator> && bench-freeze --check && npm test        # npm test, from the workspace root
bench-run --angle <A> --preflight                      # every angle, costs nothing
git status <corpus>                                    # a run must not mutate fixtures
```

- Edit the **generator**, never the emitted scenario JSON — hand edits revert.
- Re-measure **both halves** after any agent-file edit. A fix that buys TPs by
  manufacturing FPs is not a fix.
- Re-run at **n≥2** and compare against pooled history, not the last run.
- Beware cwd: some suites resolve paths from `process.cwd()`. Run them the way
  `npm test` does, or you will diagnose a phantom regression.

## Success criteria

- Every failing cell is attributed to a layer, or explicitly recorded as
  unexplained. "Noise" is not an attribution.
- Every fix names the layer it changed and what it would break if wrong.
- Cells left as model behaviour are reported, not designed around.
- The reported F1 is corrected for voids.
