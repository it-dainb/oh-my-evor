# ARCHITECT review — `docs/v1.2.1-plan.md`

Deliberate mode. Read-only: the only path this lane created is this file.

**Verdict: SOUND-WITH-CHANGES.** The ordering argument is real and the collapse
arithmetic in §1 is correct. Six changes are required before approval, listed in
§8. None of them is "restructure"; two of them are "this release is two releases."

---

## 0. What I verified on disk rather than taking from the trace

Because §0 of `AF6` and the provenance note in `root-cause/README.md` both record
that eight of eight wave-2 lanes claimed files that did not exist, every load-bearing
claim below was re-checked. Commands and results:

| check | result |
|---|---|
| `ls ~/research/binarization/.evor/runs/` | three trees, `du -sh .evor` = **256M** |
| `mission-state.json` status, all three | `failed`, `failed`, **`running`** (r3) |
| `run-state.json` status, all three | **`running`, `running`, `running`** — including both `failed` missions |
| `git rev-parse` in `~/research/binarization` | `fatal: not a git repository` |
| `ls -li …/eval-suites/v1.py` ×3 | one inode `28705681`, `nlink 5`, mode `444`, 55759 bytes, mtime Aug 23 23:49 |
| `find .evor -name '*iir-scan-binnet*'` | node dir exists under **r3** only |
| `pytest tests/test_wave1_*.py --collect-only -q` | **76 tests collected** (harness side) |

Two consequences are used repeatedly below: **the three run trees are not under
version control**, and **`run-state.status` is `running` in all three, including the
two the plan's own §9.1 depends on**.

---

## 1. The antithesis, at its strongest

I do not think "this is a rewrite disguised as a patch" survives. `AF6 §3.1`
steelmans changing nothing structural and then §3.2 refutes it on arithmetic, not
taste: four independent P-02 path checks, ~54 `isError` sites, 12 pairwise lock
retrofits, two `resolveNodeRef` patches. That is not a redesign argument, it is a
deduplication argument, and the plan's §1 states it correctly. Attacking the spine
is the weak attack. Here are the three that hold.

### A1 — The release is ordered by *dependency* and gated by *nothing an executing agent must pass through*

The plan's Phase 4 note — *"Safe now, because the legitimate reasons to patch are
gone"* — is an argument about **hardening**, and items 4.1–4.3 are not hardening.
`AF6 §5.4` lists `red/T2` items 1–3 under **"Not moot — do these regardless of any
redesign"**, calling them *"what stops the system rewriting its own governing
files."* `RC2` prediction 3 is the sharp form: `agents/*.md` + `skills/*/SKILL.md`
are unguarded, and *"the layer carrying the unenforced rules is itself writable by
the agents the rules bind."*

Phases 1–3 are 25 items of Python, TypeScript and **agent-file** editing, executed
by agents, with the plugin-root denylist (4.2) and the logged
`EVOR_ALLOW_SELF_PATCH=1` escape (4.2) not yet landed. The field run's entire
mutation timeline — 17 files, 7 waves, 18 hours, `.bak-<ts>` files the agents
invented themselves (`AF5 §3.2`, K-01) — is the demonstration of what that costs.
The plan proposes to execute its largest structural change under exactly the
governance posture that produced the finding.

The false-positive tax compounds it. `AF5 §2.1`: `runsTraining` produced **82
denials, 54 of them false (66%)**, on `pytest`, `ast.parse`, `torch.__version__`,
`json.load` and a bare `grep` — ~8.2M tokens and 32 minutes. Phases 1–3 are
Python-and-pytest-shaped work. 4.1 is the change that *reduces* false positives
(the plan says so itself, item 4.1). Deferring it behind 25 items means paying the
tax through the most expensive phases of the release.

**The plan's own §3 cut list contradicts its ordering**: *"Any 'add a matcher for X'
item — presumed moot until 4.1 lands."* 4.1 is written as a prerequisite and
scheduled fourth.

### A2 — Phase 2 is not one phase and is not attributable

Eleven items spanning: the dataset contract (2.1–2.4), evaluator custody and the
CAS (2.5), gate/polarity relocation (2.6), the signal taxonomy plus a new consumer
in `evor_check_stop` (2.7), tool-name resolution affecting **58 of 97 agents**
(2.8, `AF4 §0`), deletion of a required contract field (2.9), a new tick state
(2.10), and credential handling (2.11). These share no writer, no file, no test
suite and no failure mode. The gate is *"T1 + T6 dataset/evaluator tests green"* —
which does not exercise 2.7, 2.8, 2.10 or 2.11 at all.

The attribution answer is: **no.** 2.8 alone moves every benchmark, because it
changes whether agents can reach their tools — `AF4 §0` measured 58/97 agents
failing bare-name `ToolSearch`, and a `general-purpose` helper loading the prefixed
name on its first try while `evor-mutagen`, the artifact's owner, could not. If 2.6
(gate relocation) and 2.8 (tool discovery) land in one phase and quality moves, no
paired design separates them, and Phase 8 is explicitly the *only* measurement.
"One commit per item, one tag per phase" (§5) tags at the wrong granularity: the
commit is the attribution unit but nothing is *measured* per commit.

### A3 — Two acceptance criteria are unfalsifiable as written

*"All 263 tests green, with every deletion justified in writing"* against §4.4,
*"Where a phase deletes the call site, delete the test with it, deliberately."*
Nothing bounds that. Phase 3.2 deletes `run-state.status`; Phase 1.2 deletes
`stateWrite`'s merge-patch; Phase 2.9 deletes `critic_approved`. Each deletion
takes its RED tests with it, and the criterion is satisfied by a suite that has
shrunk to whatever survived. "Justified in writing" is prose — which is precisely
the class of obligation `AF6 §4` says the system has decided not to have.

Second: I could not reproduce **263**. Harness collects 76
(`pytest --collect-only`, verified above); no file in `red/` states a 263 total —
`T2` says *"64 of 67 failing"*, `T7` says *"33 tests, 18 failing, 15 passing."* The
number may well be right once the TypeScript side is collected, but an acceptance
criterion in a project that has been burned by unsourced counts should cite the
command that produces it.

### A4 — What does *not* hold, stated for fairness

- **"56 items destroys attribution regardless of phase tags."** Overstated. Phases
  1, 3, 5, 6 are internally coherent — one substrate each, and each has a gate that
  actually exercises it. The attribution problem is Phase 2 specifically.
- **"The RED suite encodes the wrong acceptance criteria."** `root-cause/README.md`
  already concedes the exact limit (*"necessary and not sufficient… they pin the
  invariants at their current call sites"*), and the plan carries it forward as
  risk 4. The suite is not wrong; the deletion policy around it is unbounded (A3).
- **"The plan mistakes deliberate looseness for defects."** `AF6 §2` lists eight
  things that are architecturally sound and the plan's §3 cut list protects most of
  them. This attack fails on the evidence.

---

## 2. Tradeoff tensions the plan has papered over

### T1 — Migration versus the only real result. **The plan must choose, and §4.3 chooses neither.**

§4.3 is one sentence: *"Phase 1 is a schema migration against three existing run
trees. Migration or explicit abandonment; do not leave them half-readable."*

Take **abandonment**: Phase 9.1 dies. `9.1` re-scores `iir-scan-binnet-02` — the
README's *"highest-value single action in the whole trace"*, a node with 12,000
valid telemetry records failed by a directory-naming mismatch (O-01). I located it:
it exists in **r3 only**. Abandon the trees and 9.1 has no input.

Take **migration**: the target has no revert point. `~/research/binarization` is
`not a git repository` (verified; README category 4 says so and it is still true).
A 256 MB in-place schema migration, one-way, against a tree whose r3
`mission-state.json` still reads `running` and all three `run-state.json` read
`running` — i.e. the migration's source data is in a state the new domain model
must reject (Phase 3.5: *"two missions cannot both be running"*).

So the migration is not a mechanical transform. It has to *decide the lifecycle
outcome of three real missions* — exactly the judgement the operator made by hand
in `vim` at 00:13:36 with a `.bak` chain (O-09), which is the finding Phase 1
exists to make impossible. **The migration is the first user of the domain model
and it is not scheduled as an item.**

**And 9.1 is unsound as written even if the trees survive.** The evaluator it would
re-score under is inode `28705681`, `nlink 5`, 55759 bytes, mtime `23:49` — the
*post-tamper* version, shared by all three trees. `M-01`/`RC1`: r2's scoring
evaluator `f123d17c…` exists nowhere on disk. That 23:49 evaluator is the one
carrying the M-03 leakage reclassification. The plan orders **9.1 before 9.2**
(*"Restore the strict leakage check — only after 2.3 lands"*), so 9.1 produces a
number under the loosened check and calls it *"the run's only real result."*

**Required choice:** either (a) promote migration to a numbered Phase 1 item with
its own acceptance criteria, `git init` the binarization tree first, and reorder
9.2 before 9.1; or (b) abandon the trees explicitly and **delete 9.1 from the
release**, saying so.

### T2 — Custody versus authoring: 2.5 lands seven phases before 9.3

`AF2 §4` ends with a named failure mode, verbatim:

> The failure mode to avoid: hardening the seal into true custody while leaving
> authoring in prose. That makes a mis-authored evaluator **permanently** binding
> instead of merely wrong — the exact "harden the guard without closing the gap"
> outcome this wave exists to prevent.

Plan 2.5 is custody. Plan 9.3 is the gap-closer (*"a trivial all-ones predictor
scoring 94.7 F must be unsealable"* — K-10, `AF2 §4` item 4, which that lane calls
*"where the value density is… it alone would have saved $82.59 and a mission"*).
They are separated by seven phases.

This is the same structural error as `AF1`'s warning, which the plan **did** honour
(2.3 before 9.2) and did **not** honour here. The plan has a rule — *do not harden
a guard over a missing affordance* — and applies it to the dataset and not to the
evaluator.

The genuine conflict underneath: the plan wants **"every invariant names a writer"**
(§2) and simultaneously wants to preserve **the agent-authored evaluator as a
research bet** (`AF6 §2.8`, ADR-010). Those are compatible only via `AF2 §4`'s
scored-plugin split — server-generated harness (`evor_scaffold_evaluator`) plus a
hand-written `score(pred, gt)` — under which *"the seal from assertion into custody
… falls out for free rather than needing separate hardening."* The plan takes
custody without the split and without the gate. **Choice: move 9.3 into Phase 2 as
a precondition of 2.5, or adopt the split.** Doing neither ships a permanently
binding mis-authorable evaluator.

---

## 3. Synthesis

Both the plan and the antithesis are right about different axes, and they are
separable.

1. **Keep the domain-model-first spine.** A1 is not an argument against Phase 1; it
   is an argument that Phase 4's *structural* items are not ordering-dependent and
   were never claimed to be. `AF6 §5.4` already sorts them into "do regardless."
   **Move 4.1, 4.2, 4.3 to Phase 0** (with 6.7's commit of the plugin cache, which
   is what makes self-patching auditable at all). Phase 4 keeps 4.4 and 4.5, which
   *are* behaviour changes and belong after the affordances. This costs the plan
   nothing and removes the tax and the self-patch exposure from Phases 1–3.
2. **Split Phase 2 by writer, not by theme.** 2.1–2.6 share one substrate (the
   dataset/evaluator contract) and one gate. 2.7–2.11 are five unrelated
   affordances. Make them **Phase 2 (contract)** and **Phase 2b (agent
   affordances)** with separate tags and separate gates. This is the minimum that
   makes A2 answerable.
3. **2.8 is Phase 0.** It is a documentation-and-alias fix (`AF4` classifies it
   **DF**, not AG), it is independent of everything, and it is the single
   largest-N finding in wave 3 (58/97 agents). It also *confounds every
   measurement in Phase 8 if it lands anywhere near them.* Landing it first and
   alone is both the cheapest and the most attributable placement.
4. **The migration is an item.** T1's required choice, made explicitly, with 9.2
   before 9.1.
5. **9.3 moves to Phase 2** as 2.5's precondition. T2.

Under this, the release becomes: **Phase 0 (operator + structural guards + tool
discovery) → 1 domain model → 2 contract → 2b affordances → 3 FSM → 4 behavioural
guards → 5–7 → 8 measure → 9 science.** Same spine, same collapse arithmetic, three
moves.

---

## 4. Principle violations (deliberate mode)

The principle: *"For every invariant, name the writer. If the writer is the agent
that benefits from violating it, it is not an invariant."* Auditing Phase 1 and
Phase 2 item by item.

**Names a writer, correctly:** 1.2 (server-side owner per state variable), 1.3
(validated root on `Run` at lock time), 1.5 (identity registry), 1.7 (envelope),
1.8 (ownership rule), 2.5 (server materialises into CAS), 2.6 (contract data),
2.7 (`evor_check_stop` named as consumer), 2.11 (`userConfig` slot).

**Violations, in descending order of consequence:**

- **2.10 — `blocked{on, since}` has no writer, and its writer is the beneficiary.**
  The item says outright: *"Naming the wait is ours; blocking is a host affordance."*
  So `blocked` becomes another field the agent writes about its own state — and the
  agent that is stalled is the party that benefits from not being recorded as
  stalled. This is `stateWrite`'s merge-patch defect (§1.2 of the plan, which the
  same phase is deleting) reintroduced one phase later under a new field name.
  `AF4 §4` supplies the writer the plan dropped: **`evor_await_artifact(tick, agent,
  kind, timeout)`** — a *server-side blocking read* on the deterministic
  `ticks/{n}/{agent}/{kind}.json` path, so the dependency edge is a server fact
  rather than an agent assertion. `AF4` prefers it to `Monitor` explicitly
  (*"`Monitor` blocks on an agent id, which is the wrong noun"*). The plan cites
  `Monitor` and omits `evor_await_artifact` entirely (grep: 0 hits).
- **2.3 — the writer is outside the system, and the plan asserts otherwise.**
  2.3 claims *"The corpus already encodes it — 48 shared masks train↔eval,
  reproducing on disk today."* What `AF1 §0.2` measured is a **mask sha256
  coincidence**, not a group id. `AF1 G-3` is explicit that the group key *"must be
  emitted by the corpus builder, since it is only knowable at build time;
  `manifest.json` would need a `group` per entry"* — and quotes `dataset_card.yaml`
  saying for v5 that *"the build-time group IDs needed by check_no_leakage are
  unrecoverable."* Worse, deriving `group` from mask-sha **reproduces the exact
  false positive 2.3 exists to fix**: `AF1 G-3` distinguishes `office_scan` /
  `office_print` (40 of 132 test pages, genuine re-degradations of trained-on
  pages) from *"the other 20 domains [which] are distinct documents that
  coincidentally share a GT."* Mask-sha grouping cannot tell those apart. Since 9.2
  is gated on 2.3, and M-03 is the reason lane M says **no accuracy number is
  trustworthy**, an unwritable 2.3 leaves the release's headline science finding
  open while the plan reads as though it closes it.
- **1.4 — a reader fix standing in for a missing writer.** *"Fix `readRunState`
  returning `status:"running"` for a missing file"* changes a default. The invariant
  ("absence is not liveness") gets a writer only at **3.3**, timed states. `AF3 F1`:
  *"a killed process executes no transition. What is missing is a timed state."*
  Keep 1.4, but it does not close A6/C-01 and should not be listed as doing so
  without 3.3.
- **1.6 and 2.8 are validators/documentation, not writers.** `extra="forbid"` makes
  dropped keys loud; the `ToolSearch` alias makes a tool findable. Both are correct
  and cheap (`AF6 §5.4` calls 1.6 *"highest ratio of enumeration to effort in the
  whole trace"*). Flagged only because the plan's gate — *"`git diff` shows no new
  matcher added in this phase"* — is a check about matchers, and 1.6 is one.
- **Phase 1's entity set is missing the entity the operator was actually
  manipulating.** 1.1 names `Mission`, `Run`, `Tick`. `AF3 §6` closes with:
  *"Also worth adding above the mission: a **Campaign** (or `MissionAttempt`)
  entity — an ordered list of missions against one research goal, with per-attempt
  `abandoned_reason`. That is the object the operator was actually manipulating, in
  `vim`, at 00:13:36."* The plan instead patches the absence with a `superseded`
  **edge** at 3.5. An edge between three sibling missions is the workaround; the
  entity is the affordance. This is the plan performing, at the entity level, the
  same substitution it criticises elsewhere. (grep for `Campaign` in the plan: 0.)

---

## 5. Is Phase 3 correctly placed?

**Yes, for the FSM; no, for two items inside it.**

`AF6 §3.3` orders: domain model → single writer → **a clock** → FSM library
optional. The plan's Phase 3 is that ordering with the clock folded in as 3.3, and
its 3.1 correctly refuses `python-statemachine` for `AF3 §4.5`'s decisive reason
(the machine would be in Python class syntax that `stop.mjs` and `state.ts` cannot
read — *"structurally recreating RC3"*). 3.2's *"delete `run-state.status`"* honours
`AF3 §4.1`'s single most important implementation constraint. This is the best-argued
phase in the plan.

Guards do **not** need to precede the FSM as a matter of design dependency — A1's
argument is about the *execution* of the release, not its logic. Two corrections
inside Phase 3:

- **3.4 (the `paused → locked/running` recovery edge) is misplaced.** `AF3 §7`
  ranks it **#2 of 7** by defects-closed-over-cost and calls it *"small, and it is a
  live shipped bug, not a design debt."* It is live in **this** repo right now:
  `git status` shows `.evor/runs/frontier-1ms/run-live-01/mission-state.json`
  modified, and `AF3 F6` documents that file's `locked → paused` transition, stuck
  since 2026-07-26, with `stop.mjs:74-86` silencing the entire enforcement layer
  for any `paused` mission. Every paused run in the project is currently
  unresumable *and* ungoverned. That is a Phase 0 bug, not a Phase 3 deliverable.
- **3.5 encodes an undecided product question.** *"Two missions cannot both be
  `running`"* is a RED test, and `AF6 §6.6` flags precisely this: *"nobody has asked
  whether concurrent missions are wanted. If they are, the domain model in §3.3
  needs to be designed for it now."* Phase 1 is that domain model. The plan answers
  the question by implication, in Phase 3, after the entities are frozen. Decide it
  in Phase 1, in writing.

---

## 6. Findings in the trace that the plan does not cover

Cross-checked against the eight wave-1 categories and the `AF1`–`AF6` gap lists.
Grep counts against `docs/v1.2.1-plan.md` in parentheses.

**Evaluator / metric (`AF2`)**
- `AF2 §4` item 1, the **server-generated harness / scored-plugin split**
  (`scaffold`: 0). The structural fix for the boilerplate column where *every*
  field failure lived. 2.5 takes custody without it — see T2.
- `AF2 §4` item 3's declarative promotions: `label_semantics` (0),
  `MetricConstraint.scope`/`.purpose` (2.6 covers `.purpose` as floor-vs-goal, not
  `.scope`), `Domain.n_samples` server-computed at freeze (`n_samples`: 0).
  GAP-2's *per-domain* constraint scoping is the one that forced the evaluator to
  re-enforce and then have its verdict discarded.
- `AF2 GAP-3`: `MetricSpec.aggregation_rule` has no reader and competes with
  `GoalContract.fitness_mode` (`aggregation_rule`: 0). Two live declarations of how
  fitness aggregates; 2.2 makes domains real without resolving which one wins.
- `AF1 §3`: `integrity.py:397-404` `_check_no_label_contamination` is `return True`
  — *"a check that is structurally unable to fail… flagged in the shipped `bab279e`
  tree"* (`label_contamination`: 0). 9.2 restores check 2; check 4 is untouched.
- `AF1 §3`: `compute.ts:640-648`'s zero-item guard is the wrong predicate — it
  catches `test==0 && val==0` and the real failure returned 5 and 2. Phase 2's gate
  asserts the *outcome* (132 items) without fixing the guard that failed to notice.

**Subagent topology (`AF4 §7`)**
- Gap 4 — `general-purpose` spawns are unregulated and inherit everything; `PARENT`
  is keyed on `evor-*` names only. `AF4`'s fix is *inherit the spawner's operation
  set*. 4.5 changes the unit of authority but does not close the laundering hole
  (J-02: an identical prompt re-issued as `general-purpose` became the standing
  pattern).
- Gap 6 — the `name` denial is **19 of 26 spawn denials** and collides with
  `SendMessage` addressing (`SendMessage`: 0). The most-fired rule in the field run
  is not in the release.
- Gap 8 — `evor-tick` is denied `Bash` but needs read-only globbing; it spawned a
  `general-purpose` agent to run `find` (I-1).

**Governance (`AF5 §6` defects)**
- D4 — `PIPELINE` (`:492`) holds stage names while juniors write `<stage>-junior`
  slots, and `grants.delete(own)` blocks the three forge reviewers from reading the
  `forge` proposal they were spawned to review (`J-03`: 0, `PIPELINE`: 0). Five of
  seven blocked reads were satisfied by `cat`/`sed` off disk.
- D5 — `permission-denied.mjs` throttles at 10 min per reason-hash and delegates
  escalation to the governed agent (`permission-denied`: 0). Lane J: *"Escalation
  to the user. Zero."* 4.4 logs the governor's catches; it does not fix the one
  channel built for escalation.
- `AF5 §4` calls **denial-as-signal with `signature`-dedup** *"the highest-leverage
  change in the lane"* — 82 identical `runsTraining` denials become one signal with
  `occurrences: 82`, legible **during** the run. 4.3/4.4 give the governor a log;
  they do not put it on the bus that 2.7 is simultaneously fixing a consumer for.
- `AF5 gap 4` / K-11 / K-03: refreeze and sealed-threshold changes are named as the
  *genuine* exceptions that want `ask` (`K-11`: 0, `K-03`: 0). The plan's note
  correctly explains why `ask` degrades headless and then drops the two cases.
- K-08 — a supersession reason must be **contemporaneous**, not narrated 14 h later.
  3.1's `transitions.jsonl` plausibly covers this; say so explicitly, because
  `state_history` (0) is `AF5 §5`'s named home for it.

**Still un-traced (`AF6 §6`)** — the plan's §6 defers to it, which is honest, but
two items bear on this release rather than the next one:
- §6.2, the instrument's own failure: 8/8 wave-2 lanes asserted files that did not
  exist and, when told, re-asserted them. The plan's acceptance criteria are read
  from that instrument. This is the reason §0 of this review exists.
- §6.6, concurrency as a goal — see §5 above; it is a Phase 1 decision.

---

## 7. Where the plan is better than its evidence required

Stated because a review that only subtracts is not a review.

- §1's refusal to harden check 2 before 2.3 lands is `AF1`'s closing warning
  followed exactly, and it is the discipline most releases get wrong.
- 3.1's rejection of `python-statemachine` reproduces `AF3 §4.5`'s decisive
  argument rather than the convenient one.
- 7.4 (delete the retier doc, generate from frontmatter) takes `AF6 §5.8`'s point
  about the 26-hour rot window instead of correcting four rows.
- §3's cut list is the rarest thing in a remediation plan: items removed *with
  reasons*, including the plan's own earlier work.
- Phase 7 gating Phase 8 on `--mcp-config` is `RC7`'s one-fix-gates-nine-items
  finding, honoured without argument.

---

## 8. Required changes

1. **Move 4.1, 4.2, 4.3 and 6.7 to Phase 0**, ahead of the domain model. Keep 4.4,
   4.5 where they are. (A1; `AF6 §5.4`.)
2. **Move 2.8 to Phase 0** and land it alone. (A2; `AF4 §0`; it confounds Phase 8.)
3. **Split Phase 2** into 2 (dataset/evaluator contract, 2.1–2.6) and 2b (agent
   affordances, 2.7–2.11), with separate gates. (A2.)
4. **Move 9.3 into Phase 2 as a precondition of 2.5**, or adopt `AF2 §4`'s
   scored-plugin split. (T2.)
5. **Make the migration a numbered Phase 1 item** with acceptance criteria, `git
   init` the binarization tree before it runs, and **reorder 9.2 before 9.1** — or
   delete 9.1 and say the trees are abandoned. (T1.)
6. **Rewrite 2.3's premise.** State that the group key requires a corpus-builder
   change (`manifest.json` gains `group` per entry) and that mask-sha is not a
   substitute; if that change is out of scope, mark 9.2 as **not landing in
   v1.2.1** rather than gating it on an item with no writer. (§4; `AF1 G-3`.)

Recommended, not blocking: add `evor_await_artifact` as 2.10's writer; add the
`Campaign`/`MissionAttempt` entity to 1.1; promote 3.4 to Phase 0 as a live bug;
decide concurrency in Phase 1; add the six uncovered items in §6 either to the
release or to `KNOWN_GAPS.md` with a tracked row; and replace "all 263 tests green"
with the command that produces the count.
