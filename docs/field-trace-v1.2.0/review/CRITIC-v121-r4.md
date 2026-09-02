# CRITIC — v1.2.1 plan, revision 6 (delta re-review, iteration 4)

Scope: my three BLOCKING items from `CRITIC-v121-r3.md`, anything rev 6 broke, and the
planner's two questions. Earlier passes not revisited.

**Verdict: APPROVE.** The plan is executable as written. Two NON-BLOCKING additions below
that I would make during execution setup rather than in a seventh revision — a fifth
iteration would be diminishing returns, and I am saying so because I was asked to say so if
it were true.

---

## 1. The three items — all landed

| item | rev 6 | verified |
|---|---|---|
| 1 | `dashboard/server.py:92` in 1.9b, with the accessor mechanism spelled out | site + `store.py:52` accessor confirmed; the *why the grep missed it* sentence is there |
| 2 | 1.9e covers `SKILL.md:30` and `:72`, and states no suite covers `skills/` | both lines confirmed verbatim |
| 3 | §5.4 carries the mechanical test; 1.9d names `test_validate.py` as a weakened-column member | §5.4 text confirmed; 1.9d confirmed |

Rev 6 broke nothing. **1.9a is the right call and the most valuable change in the
revision** — it is the only version of this fix whose correctness does not depend on
anyone's enumeration being right, and it converts 1.9b's site list from a load-bearing
claim into a convenience. Relabelling that list "a starting set, not a closed one" is the
honest framing.

## 2. Question 1 — 1.9a makes 1.10 safer, with one ordering caveat

Safer, and for a sharper reason than the window: the accessor gives you **one place to
define what absence means** during the interval when data still carries `status`. Today
that meaning is spread across `record.ts:24`, `:37` and four fail-open reads in
`stop.mjs`; after 1.9a it is one function body. That is 3.2's *"absence of state is never
read as liveness"* invariant becoming enforceable in a single edit, which is exactly the §2
pattern — an invariant with one writer.

The caveat is a constraint on 1.9a, not an objection to it. **1.9a must be a pure refactor
— behaviour identical, both suites passing unchanged.** The temptation will be to introduce
`readRunStatus()` and fix its default in the same commit, because the fix is one line and
the function is right there. Don't: the compile-error safety net is what makes the later
removal safe, and spending it on a semantic change means the behaviour moves in a commit
whose tests were expected to stay green, which is unattributable in exactly the way Risk 3
warns about.

This interacts with **1.4**, which is precisely "`readRunState` stops returning `running`
for a missing file" — the same default, one item earlier in the numbering. The correct
sequence is **1.9a (pure refactor) → 1.4 (change the default, inside the accessor, one
site) → 1.9b (remove the key)**. As numbered, 1.4 lands before the accessor exists, so it
edits the two `record.ts` defaults directly and 1.9a then refactors code that just changed.
Reordering costs nothing and makes 1.4 a one-line diff with an obvious blast radius.

## 3. Question 2 — `skills/` is systemic, not a one-off. I ran the sweep.

`grep -rnE 'If .*(status|state|tick|step_status|integrity_status|verdict)[^`]*(==|!=|=|is|shows)' skills/*/SKILL.md agents/*.md`

Three further prose-reader clusters over state this release restructures. None is a Phase-1
C5 recurrence — each breaks in a *later* phase, which is why enumeration is the wrong
response and a rule is the right one:

| site | reads | broken by |
|---|---|---|
| `skills/evor/SKILL.md:417` | `tick_state.step_status == "running"` AND `current_step < 9` — the interrupted-tick resume branch | **3.1/3.2**. The FSM replaces the step/status pair; this prose is the agent's entire resume logic and it silently stops matching |
| `agents/evor-forge.md:198`, `:223` | `run_status.state == "oom"` / `== "succeeded"` | **6.4**, job lifecycle — the item whose whole point is that `status()` never checks pid liveness, i.e. it changes what these values mean |
| `skills/evor/SKILL.md:289-290` | `integrity_status` `"failed"` / `"passed"` | **2.6/2.8**, sanity gate and gates-as-contract-data |

Also noted, lower confidence: `evor-run/SKILL.md:60` (`tick_count = 0`) against 1.2's
computed `finished`, and `evor-forge.md:130` (`critic_result.verdict == "approved"`)
adjacent to 2b.2's removal of `critic_approved` — different field, but the same review
step, so whoever does 2b.2 should look.

**Recommendation: a per-item rule, not a Phase 7 audit.** Routing this to 7.5 is the wrong
home for a specific reason: Phase 7 runs *after* Phases 2, 3 and 6 have landed, so the
prose would sit rotted for most of the release and the repair would arrive as a batch of
agent-file edits immediately before Phase 8 — the re-measurement whose validity Risk 3
already makes conditional on agent files being stable. Detecting the rot there means you
cannot attribute it.

Proposed **§5.10**, the prose analogue of §5.9:

> Any item that changes the name, semantics, or domain of a state field must grep
> `skills/` and `agents/` for prose readers of that field and update them in the same
> commit. `skills/` has no suite; the gate rule in §5.9 cannot reach it, so the obligation
> attaches to the item rather than the gate.

That is structural in the same sense 1.9a is — it attaches the cost to whoever changes the
field, rather than to a later audit's diligence. A `KNOWN_GAPS.md` row is worth adding
alongside for the three clusters above, so they are tracked rather than rediscovered.

## 4. Fourth unnamed code reader: none

I swept again for the code path and found nothing beyond 1.9b's list — and after 1.9a the
question stops mattering, which is the point of 1.9a. Recorded negatives from this pass and
the last, so a later reviewer need not redo them: `ci/`, `scripts/`, `doctor.py:251`
(mission-state), `__main__.py:378` (mission-state), `plot_tree.py:105`, `store.py:199`
(node status), `contracts.py:562` / `contracts.ts:256` (`TreeNode.status` — different key,
different enum, must not be touched), `skills/evor/SKILL.md:417` (`step_status`, a
different key — it is in §3 above for a different reason). No shell or `jq` readers exist.

## 5. Pre-mortem, final

All four scenarios are closed or converted. Scenario 3 — a check disarmed between a data
change and its code change — is closed structurally by 1.9a rather than by enumeration,
which is a stronger closure than I asked for. The scenario I opened at rev 4 (a gate blind
to its own phase's change) is closed by §5.9. The one residual, the prose surface no gate
can reach, is the subject of §3 and is a tracked gap rather than an open defect.

---

## Verdict

**APPROVE.**

| # | item | severity |
|---|---|---|
| 1 | Add §5.10 — items changing a state field's name/semantics must update prose readers in `skills/` and `agents/` in the same commit; `KNOWN_GAPS.md` rows for the three clusters in §3 | NON-BLOCKING |
| 2 | Sequence 1.9a before 1.4, and constrain 1.9a to a pure behaviour-preserving refactor with both suites green unchanged | NON-BLOCKING |

Both are additions to acceptance and ordering, not to scope, and both can be made while
setting up execution. The three BLOCKING items from iteration 3 are fully discharged, rev 6
introduced no regression, and 1.9a resolves the recurring defect at its root rather than at
its symptom. Nothing remaining would let a real defect through, and I do not think a fifth
iteration would find one.
