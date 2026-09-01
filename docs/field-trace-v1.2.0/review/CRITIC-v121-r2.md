# CRITIC — v1.2.1 plan, revision 4 (delta re-review, iteration 2)

Scope: the two items the Architect flagged (C5, C6), the baseline attribution fix,
whatever rev 4 introduced, and my own pre-mortem revisited. C1–C4 and C7 spot-checked
only. Everything below was executed read-only against the working tree on 2026-09-01.

**Verdict: ITERATE.** Three BLOCKING items, all of them variants of one defect: rev 4
correctly identified the *mechanism* of C5 but under-enumerated its *blast radius*, and
put the fix in a phase whose gate does not run the suite that would catch it.

---

## 1. C6 — resolved. Both criteria execute.

I ran all four commands. Every number the plan claims is reproducible.

| criterion | command | plan claims | measured |
|---|---|---|---|
| baseline (harness) | `cd harness && PYTHONPATH=. python3 -m pytest tests/ --collect-only -q` | 1003 | **1003 collected in 0.53s** |
| baseline (mcp) | `grep -c "it(" tests/wave1-*.test.ts tests/*live*.test.ts` | 196 | **196** |
| 6 | `grep -cE 'permissionDecision:\s*"deny"\|deny\(' hooks/pre-tool-use.mjs` | 21 | **21**, exit 0 |
| 5 | the freeze command | executes; `--run-dir` required | **executes** |

Criterion 5 in detail. The bare form does fail exactly as the plan says:

```
ModuleNotFoundError: No module named 'evor'
```

With `PYTHONPATH` set, `python -m evor.freeze freeze-splits --help` confirms all four
flags exist as written (`--dataset-path`, `--eval-version`, `--run-dir` required,
`--mission-id` optional). Run against `corpora/v10` with a fresh scratch `--run-dir`, it
exits 0 and emits:

```json
{"locked_split_hash": "52c8d15f…", "val_split_hash": "1084e894…",
 "test_item_count": 5, "val_item_count": 2}
```

That is AF1's original failure reproduced from the plan text alone — which is the
strongest possible evidence the criterion is executable by a stranger. **C6 closed.**

One NON-BLOCKING precision note (item 5 below): freeze *writes* into `--run-dir`, and the
plan's placeholder is a bare `<run>`. `~/research/binarization/.evor/runs/` holds the
three live mission trees that 1.10 migrates. A reader who resolves `<run>` to one of them
runs a write against the thing 0.8 exists to protect.

## 2. Baseline attribution — correct, and the circularity is acceptable

Verified: `git ls-tree bab279e --name-only harness/tests/ | grep -c wave1` → **0**. The
tracked tree at that sha has 36 test files, none of them `wave1`. Rev 4's concession is
accurate and 1003/196 are working-tree numbers as stated.

Deferring the real sha to 0.5 is **not** circular in a way that matters. 0.5 is the first
substantive item in Phase 0, it lands before any acceptance criterion is evaluated, and
criteria 3 and 4 compare *release* against *that commit* — a comparison that is
well-defined the moment 0.5 exists. The plan already says the block gets updated to cite
the sha. Accepted as written.

## 3. C5 — mechanism right, enumeration incomplete. **Still open.**

Rev 4's diagnosis is correct and the shape of the fix (1.9b + 1.9c, 3.2 demoted to an
assertion) is the right shape. But I grepped for every reader of the key, as asked, and
the plan names two of the stop-hook gates when there are **three**, and misses a hard-fail
reader in the third language.

### 3a. `hooks/stop.mjs:318` is a third `runState?.status === 'running'` gate — BLOCKING

1.9c names `:255` and `:271`. There is a third:

```js
// stop.mjs:318 — check (e), sub-agent tasks still running within this tick
if (runState?.status === 'running') {
```

This is the guard that blocks stop while `tick-state.json` still lists
`pending_subagent_ids`. Its own comment says it is "a no-op (fail-open)" when the field is
absent — so like the other two, deleting the key turns it silently false in the permissive
direction and emits nothing. C5 was precisely the argument that a silently disarmed
governance check is the failure mode worth blocking on; the argument applies verbatim to a
third check the plan does not know about. 1.9c must name `:318`.

For the record, the two the plan does name are not minor: `:255` is check (c) (mid-flight
tick detection) and `:271` is check (d), which the source comments call *"the enforcement
teeth behind the SKILL's Orchestrator_Contract"*. With `:318`, retiring the key disarms
three of the five debt checks in the drift guard.

### 3b. `harness/evor/validate.py:691` requires the key — BLOCKING

```python
required = ("status", "tick_count", "frontier_ids")
missing = [f for f in required if f not in data]
```

The harness validator hard-fails `run_state_well_formed` when `status` is absent. This is
a *reader in Python*, not TypeScript, and it does not fail open — it fails the validation
that `evor validate` runs over exactly the three trees 1.10 migrates. 1.9b names only
`record.ts:24`/`:37` "plus every writer that sets the key"; a required-field check in a
validator is neither of those, so nothing in the plan currently catches it. 1.10's
acceptance criterion ("all three trees load under the new schema") is likely evaluated
*through* this validator, which would make the migration's own acceptance unsatisfiable.
Name `validate.py:691` in 1.9b, and name `init_run.py:178` (`"status": "initialized"`) as
the concrete writer.

### 3c. A premise inside rev 4's own justification is wrong — NON-BLOCKING

Rev 4 argues that `tree.ts:208-213` "reads through that default and writes `running` back
into the migrated tree on the first tick". I read the code. `tree.ts:208` calls
`readRunState`, mutates only `pending_node_ids`, and writes back. The `status:"running"`
default is returned **only** when the file is missing or unparseable
(`record.ts:22`/`:36`). Post-1.10 the files exist and parse, so `JSON.parse` returns an
object with no `status`, and `writeRunState` writes it back with no `status`. The
reintroduction path is real but narrower than claimed — it fires on a missing/corrupt
file, not on a migrated one.

This does not change what 1.9b should do (the defaults are still wrong and still must go).
It is flagged because the plan's stated justification would not survive being checked by
the engineer executing it, and 3.2's assertion should be written against the actual
mechanism — *absence read as liveness* — rather than against a write-back that will not
reproduce.

## 4. What rev 4 introduced — the new gate/suite mismatch. **BLOCKING**

This is question 3, and the answer is no: the suites named in Phase 1's gate do not cover
the predicates 1.9c re-homes. The T-numbers resolve against
`docs/field-trace-v1.2.0/red/`:

```
T1 seal-provenance   T3 identity-state       T5 autonomy-termination
T2 path-enforcement  T4 durability-audit     T6 knowledge-lifecycle …
```

Phase 1's gate is **"T3 + T4 suites green."** The suite that actually spawns
`hooks/stop.mjs` and asserts on its exit code is **T5** —
`mcp/tests/wave1-autonomy-termination.test.ts:53`. T5 is not in Phase 1's gate; it is
Phase 3's. So 1.9b/1.9c are code changes to the stop hook sitting in a phase that never
runs the stop-hook suite, and any breakage surfaces two phases later.

It gets sharper. T5 does not merely fail to gate the change — it **depends on the key
being deleted**. `wave1-autonomy-termination.test.ts:178` writes
`{ run_id, status: "running", tick_count: 1, frontier_ids: [] }` into `run-state.json` as
its fixture. Ten mcp test files do the same (`hooks.test.ts`, `record.test.ts`,
`state.test.ts`, `stop-incomplete-tick.test.ts`, `state-tick.test.ts`, `classc.test.ts`,
`tree-store-bugs.test.ts`, `hooks-runid-fallback.test.ts`, `hook-primer-consistency.test.ts`,
and T5 itself). The `:318` gate from §3a is covered — but by `hooks.test.ts:3572`, a
general suite in neither T3 nor T4.

The consequence is the one §5 criterion 4 was written to prevent. Two phases after the
change, an engineer meets a red T5 whose fixtures reference a field that no longer exists,
and the path of least resistance is to edit the fixtures — a weakened assertion in
`tests/wave1-*.test.ts`, which criterion 4 requires a ledger row for, discovered at the
moment when writing that row is most inconvenient. Fix: **Phase 1's gate must read "T3 +
T4 + T5 + the full `npx vitest run` suite green"**, and 1.9b/1.9c should carry their
fixture-migration cost explicitly rather than deferring it to Phase 3.

## 5. NON-BLOCKING — criterion 5's `<run>` placeholder

Say "a fresh empty scratch directory, **not** one of the three live run dirs under
`~/research/binarization/.evor/runs/`". One line; removes the only way to execute a stated
acceptance criterion destructively.

## 6. My pre-mortem, revisited

- **Scenario 1 (revert point is a no-op — `.gitignore:40` ignores `.evor/runs/`)** —
  **closed** by rev 3's 0.8 and the 1.10 gate on a verified revert point. Re-checked, still
  correct.
- **Scenario 2 (the seal hardened over an unguarded authoring path)** — **closed** at rev 2
  by the 2.5 → 2.6 → 2.7 ordering. Nothing in rev 4 disturbs it.
- **Scenario 3 (a governance check disarmed in the window between a data change and its
  code change)** — **not closed; narrowed and relocated.** Rev 4 shrank the window from
  Phase 1→3 to within Phase 1, which is the right move, but §3a/§3b show two disarmed
  readers still outside the fix and §4 shows the phase gate cannot detect either. This is
  the same scenario, one layer down.
- **New scenario, opened by rev 4: the gate that cannot see its own phase's change.**
  1.9b/1.9c are the first items in this plan where a phase modifies a component whose test
  suite belongs to a later phase's gate. Worth a general rule in §5.8: *an item's phase
  gate must include the suite covering the file the item edits.* Applied across the plan,
  it would also catch 0.2/0.3 (edit `pre-tool-use.mjs`, gated on T2 — correct, T2 is
  path-enforcement) and 4.1's stop-hook-adjacent governor work.

---

## Verdict

**ITERATE.**

| # | item | severity |
|---|---|---|
| 1 | 1.9c must name `hooks/stop.mjs:318` — a third `status === 'running'` gate, fail-open, currently unnamed | **BLOCKING** |
| 2 | 1.9b must name `harness/evor/validate.py:691` (required-field hard fail) and `harness/evor/init_run.py:178` (the writer) | **BLOCKING** |
| 3 | Phase 1's gate must include T5 + the full mcp suite; 1.9b/1.9c carry the fixture migration for the ~10 test files that write `status:"running"` | **BLOCKING** |
| 4 | Rev 4's `tree.ts:208-213` write-back premise is wrong — the default fires on missing/corrupt only; restate 3.2's assertion against *absence read as liveness* | NON-BLOCKING |
| 5 | Criterion 5: replace `<run>` with "a fresh empty scratch dir, not a live run dir" | NON-BLOCKING |
| 6 | Add to §5: an item's phase gate must include the suite covering the file it edits | NON-BLOCKING |

Items 1–3 are one fix landing in one place: complete 1.9b/1.9c's site list and widen the
Phase 1 gate. Everything else in rev 4 — C1–C4, C6, C7, the baseline attribution, the 3.2
demotion, the 1.9b/1.9c decomposition itself — I pass. The structure is sound; this is a
grep that was not run wide enough, and it is worth one more round precisely because C5's
whole subject is checks that fail without saying so.
