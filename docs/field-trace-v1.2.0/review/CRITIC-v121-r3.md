# CRITIC — v1.2.1 plan, revision 5 (delta re-review, iteration 3)

Scope: my three BLOCKING items from `CRITIC-v121-r2.md`, anything rev 5 broke, and the
two questions the planner asked (is 1.9's site list complete; does 1.9d's *modified*
ledger category hold). C1–C4, C6, C7 and the baseline attribution are passed and not
revisited. All commands below run read-only against the working tree, 2026-09-01.

**Verdict: ITERATE** — narrowly. Two additive site-list entries and one ledger
constraint. No restructuring; nothing here changes a phase, a gate, or an ordering.

---

## 1. The three BLOCKING items — all three land

| item | rev 5 | verified |
|---|---|---|
| 1 | 1.9c names `:255`, `:271`, `:318`, "three, not two" | `grep -n "status === 'running'" hooks/stop.mjs` → exactly those three lines |
| 2 | 1.9b names `validate.py:691` + `init_run.py:178` | both confirmed verbatim; the `required` tuple and the `"status": "initialized"` seed |
| 3 | Phase 1 gate = **T3 + T4 + T5 and the full mcp suite** + harness with `PYTHONPATH`; new 1.9d | gate text confirmed at plan line 91; §5.9 general rule confirmed at line 309 |

1.9d's count is exact. `grep -rln 'status": *"running"\|status: *"running"' harness/tests/
mcp/tests/ | wc -l` → **21**, matching the plan's figure.

The non-blocking three also landed: 3.2 now reads against *absence read as liveness*,
criterion 5 specifies a fresh empty scratch dir with the `chmod 444` reason, §5.9 is
stated as a general rule. Rev 5 broke nothing I can find.

## 2. Question 1 — no, the site list is not complete. Two more, and they are one grep shape apart.

The planner greped `hooks/`, `mcp/src/`, `harness/evor/` for readers and writers of the
key. That shape has a blind spot in each of two directions, and both are populated.

### 2a. `harness/evor/dashboard/server.py:92` — a reader behind an accessor. **BLOCKING**

```python
state = store.run_state()          # server.py:86
...
"status": state.get("status"),     # server.py:92
```

`RunStore.run_state()` (`harness/evor/dashboard/store.py:52`) is
`_read_json(self.run_dir / "run-state.json") or {}`. The path literal lives in the
accessor, so a grep for `run-state` finds `store.py:52` and never reaches the call site
that reads `.status` — this is inside `harness/evor/`, which *was* greped. **The directory
was right; the shape was wrong.** Any access routed through an accessor is invisible to a
path-literal grep.

Effect is milder than the other sites: it is the runs-list API response, so post-retirement
every run reports `status: null` in the dashboard. Not fail-open, not a hard fail —
observability. I mark it BLOCKING only because 1.9b now says *"Complete site list, each
verified on disk"*, and an executor who trusts that sentence will not re-grep. Either add
the site or drop the completeness claim; the claim is the hazard, not the null.

### 2b. `skills/evor-run/SKILL.md:30` and `:72` — prose readers. **BLOCKING**

```
:30  If found and run-state shows `status != "completed"`: offer to resume that run.
:72  If `status = "completed"`: print "This run is already complete…" and stop.
```

These are branch conditions an agent evaluates. Retire the key and `status != "completed"`
is vacuously true for every run, so `/evor-run` offers to resume runs that are finished,
and the `:72` stop-branch never fires again. Nothing in Phases 1–3 touches `skills/`, and
no test covers it — §5.9's new rule ("the suite covering every file it edits") is silent
here because *there is no suite*, which makes this the one class of reader the widened gate
structurally cannot catch.

Two reasons this is worth a line rather than a shrug. First, it changes agent behaviour,
and Risk 3 is that nothing measured before an agent-behaviour change compares to anything
after — Phase 8's re-measurement sits downstream. Second, it is the plan's own §2 thesis
pointed back at the plan: *"any obligation stated in prose to an agent is an obligation the
system has decided not to have."* A prose reader is still a reader. 1.9b/1.9c enumerate
code; the key also has a prose surface, and rev 5's enumeration has no row for it.

Everything else I swept came back clean, and I want the negative results on record so the
next pass need not redo them: `ci/` and `scripts/` (no run-state status access);
`doctor.py:251` (reads **mission**-state, correctly out of scope); `__main__.py:378`
(mission-state); `contracts.py:562` / `contracts.ts:256` (`TreeNode.status`, a different
key with a different enum — do not let a careless retirement touch it); `plot_tree.py:105`
and `store.py:199` (node status, not run status); `skills/evor/SKILL.md:417`
(`tick_state.step_status`, different key). No shell/`jq` readers exist.

## 3. Question 2 — *modified* is a loophole, and it is already occupied. **BLOCKING**

The category is the right idea; it is under-specified in exactly the way §5.4 warns about.
A fixture edit and an assertion weakening are the same diff shape — both touch a test file
and neither changes the collected count — so "modified" as written lets a weakening be
filed under the benign label, which is the count-only-ledger failure one level up.

It is not hypothetical. `harness/tests/test_validate.py` is one of the 21:

```python
:445  (run_dir / "run-state.json").write_text(json.dumps({"status": "running"}))
:450  assert "run_state_well_formed" in failed_names
```

That test asserts the validator *rejects* a run-state carrying only `status`. When 1.9b
edits `validate.py:691`'s `required` tuple, both the fixture and the assertion must change,
because what counts as well-formed has changed. That is not a fixture migration — it is a
change to the meaning of the check, arriving pre-labelled "modified" by 1.9d.

Proposed constraint, mechanical and executable: **a row may be filed *modified* only if the
diff touches no assertion line.**

```
git diff <phase-base> -- <file> | grep -E '^[-+].*(expect\(|assert|toBe|toThrow|pytest.raises)'
```

Empty → legitimately *modified*. Non-empty → it is a *weakened* row and carries §5.4's
fuller justification. This costs one command per file, distinguishes the two cases without
judgement, and would correctly route `test_validate.py` to the weakened column.

## 4. Pre-mortem

Scenarios 1 and 2 remain closed. Scenario 3 (a check disarmed between a data change and its
code change) is now closed for the code readers — the site list plus the widened gate reach
all of them — and reopens only through the two surfaces in §2, one of which no gate can
reach. The new scenario I opened at rev 4 (a gate blind to its own phase's change) is closed
in the specific case by the Phase 1 gate and in general by §5.9.

What I would watch during execution, not before: §2b is the third consecutive revision where
the same enumeration came back incomplete under a new grep shape. The pattern is not
carelessness — each grep was correct for the shape it assumed. It argues for retiring the key
behind a **named accessor first** (one `readRunStatus()` that every site must call), so the
final removal is a compiler/import error rather than a grep. That is a suggestion for how to
sequence 1.9b, not a required change.

---

## Verdict

**ITERATE.**

| # | item | severity |
|---|---|---|
| 1 | 1.9b must name `harness/evor/dashboard/server.py:92` (reader via `RunStore.run_state()`, `store.py:52`), or drop 1.9b's "complete site list" claim | **BLOCKING** |
| 2 | 1.9b/1.9c must name `skills/evor-run/SKILL.md:30` and `:72` — prose readers, no suite covers them, so §5.9's gate rule cannot reach them | **BLOCKING** |
| 3 | 1.9d must constrain *modified*: no assertion line in the diff, else it is a *weakened* row. `test_validate.py:445-450` is already the exception | **BLOCKING** |
| 4 | Consider routing 1.9b through a named accessor so removal fails at compile time rather than depending on a grep | NON-BLOCKING |
| 5 | Note in 1.9b that `TreeNode.status` (`contracts.py:562`, `contracts.ts:256`) is a different key and must not be touched | NON-BLOCKING |

All three BLOCKING items are additive: two site-list lines and one sentence constraining a
ledger category. Nothing about the phases, gates, ordering, or risk analysis needs to move,
and I would approve rev 6 on sight if they are the only changes. The three items I raised
at rev 4 are fully discharged, and rev 5 introduced no regression.
