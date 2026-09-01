# ARCHITECT re-review — `docs/v1.2.1-plan.md` revision 3

Scoped delta review, iteration 2, deliberate mode. Read-only: the only path this
lane created is this file. Structure settled in rev 2 is not relitigated; what
follows asks only whether rev 3's seven changes introduced anything wrong, whether
§5 is now executable, and whether anything is uncovered or unverifiable.

---

## 0. What I ran, rather than took from the plan

| check | command | result |
|---|---|---|
| harness baseline | `cd harness && python3 -m pytest tests/ --collect-only -q` | **1003 collected** — reproduces |
| RED harness subset | `pytest tests/test_wave1_*.py --collect-only -q` | **76 collected** |
| mcp baseline | `grep -c "it(" tests/wave1-*.test.ts tests/*live*.test.ts` | **196** across 22 files |
| are those files at `bab279e`? | `git ls-tree -r --name-only bab279e harness/tests/ \| grep -c wave1` | **0** (7 exist untracked in the worktree) |
| mcp equivalent | `git ls-tree -r --name-only bab279e mcp/tests/ \| grep -c "wave1\|live"` | **1** of 22 |
| freeze importability | `cd ~/research/binarization && python3 -m evor.freeze …` | **`ModuleNotFoundError: No module named 'evor'`** |
| with the repo on the path | `PYTHONPATH=…/oh-my-evor/harness python3 -c "import evor"` | ok — `harness/evor/__init__.py` |
| `run-state.status` writers | `mcp/src/tools/record.ts:21-45` | `readRunState`'s missing-file **and** parse-failure defaults both contain `status:"running"` |
| `run-state.status` readers | `hooks/stop.mjs:255`, `:271` | two debt checks gated on `runState?.status === 'running'` |
| read-modify-write path | `mcp/src/tools/tree.ts:208-213` | `readRunState` → mutate → `writeRunState` |
| deny sites | `grep -c "deny(" hooks/pre-tool-use.mjs` | **20** (19 call sites + the helper at `:51`), file is 583 lines |

Two of these rows are load-bearing: the `bab279e` attribution (§2.1) and the
`run-state.status` writers (§1.1).

---

## 1. The seven changes

### C1 — 0.8 rewritten; 1.10 gated on a verified revert point. **SOUND.**

The gate is real, not deferred. `git -C ~/research/binarization ls-files
.evor/runs/ | wc -l` is a command whose output is an integer, evaluated before the
one-way write, and the item names the alternative (`cp -al` / tarball) so a `git`
failure does not become a stall. Crucially rev 3 also wrote the *fail* branch:
abandon explicitly and delete 9.2. A gate with only a pass branch moves the failure
later; this one has both. It does not move the failure.

One residue: `.gitignore:40` is this repo's ignore file. 0.8 correctly identifies
that the *template applied to* the binarization workspace carries the same rule.
The verification command reads the target repo, so the gate is measured in the
right place. No change needed.

### C2 — T1's abandonment branch written into §4.1. **SOUND.**

Three sentences, the fact it turned on (9.2's input exists under r3 only), and the
condition under which abandonment wins. This is what was asked for.

### C3 — renumber rot repaired; `_check_no_label_contamination` → check 3. **SOUND.**

Verified: `C-01` now appears exactly once in the plan, at **3.4**, so 1.4's
reassignment (C4) left it owned rather than orphaned. The 9.1/9.2 references in 2.3
and 2.11 read correctly under the current numbering.

### C4 — 1.4's closures reassigned to 3.3. **SOUND, no finding left unowned.**

1.4 now closes `A6 (with 3.3)`; `C-01` moved to 3.4 (grep: 1 occurrence, in 3.4).
The joint-hold is the honest form: 1.4 changes a default, 3.3 gives the invariant a
writer and a sweeper, and neither alone closes A6. Nothing falls between Phase 1
and Phase 3.

### C5 — 3.2's deletion folded into 1.10's single pass. **INTRODUCES A PROBLEM.**

This is the one place rev 3 made something worse, and it is the answer to the
lead's first question — but not in the shape the question anticipated. There is no
*schema* dependency inversion: the post-3.2 shape is `run-state.json` minus one
key, and Phase 1 can state it in a sentence. Publishing the target schema in Phase
1 would fix nothing, because the problem is not the schema. It is the **readers and
writers**.

Verified on disk:

- `mcp/src/tools/record.ts:21-45` — `readRunState` returns a default object
  containing `status:"running"` on a missing file *and* on a parse failure.
  `mcp/src/tools/tree.ts:208-213` reads through that function, mutates, and calls
  `writeRunState`. So under un-migrated Phase-1/2 code, **the first tick after
  1.10 writes `status:"running"` back into the migrated tree.** 1.10's own
  acceptance criterion — *"no tree reads `running`"* — is true at the moment of the
  migration and false again one tick later, and stays false until 3.2 lands.
- `hooks/stop.mjs:255` and `:271` gate two stop-hook debt checks on
  `runState?.status === 'running'`. Once 1.10 deletes the key, both predicates go
  silently false. Two governance checks are **disabled for the whole Phase 1 → 3.2
  window** — which is precisely the window A1 identified as the release's most
  agent-driven, most Python-and-pytest-shaped stretch. The stop hook is documented
  as fail-open (`stop.mjs:24-25`), so this fails in the permissive direction and
  emits nothing.

Rev 2's shape was two one-way passes over 256 MB, which the Critic was right to
reject. Rev 3's shape is one pass, which is right, but it moved the data ahead of
the code and did not move the code with it.

**Minimal fix — do not split the pass.** Keep 1.10 as one migration and move
**3.2's code deletion into Phase 1** as well: `readRunState`'s two default objects
(`record.ts:24`, `:37`), `stop.mjs`'s two predicates (`:255`, `:271`), and any
writer that sets the key. Phase 1 is *already* editing that exact function — 1.4 is
a change to `readRunState`'s missing-file default, one line above the `status` key
it must also drop. 3.2 then remains in Phase 3 as what it should have been all
along: an assertion that no writer has reintroduced the field, backed by the FSM's
single-state-variable rule. This costs Phase 1 nothing it was not already paying
and closes the window entirely.

Whichever way this is taken, **the two `stop.mjs` predicates must be named in the
plan.** A migration that silently disarms two stop-hook checks is exactly the class
of thing this release exists to stop happening.

### C6 — §5 made executable. **PARTIALLY RESOLVED; two criteria still not runnable as printed.**

See §2. Criteria 1–4, 7, 8 are sound. Criterion 5 fails at import, criterion 6
still has no command and no integer.

### C7 — carry-forwards, 4.8, 4.9. **SOUND.**

- **3.1 must assert 0.7's `locked → paused` edge** — present, stated as a test
  obligation rather than prose. Right form.
- **0.3's sequencing and who may set `EVOR_ALLOW_SELF_PATCH=1`** — present, names
  the human, names the audit log, names the review point. This closes the tension
  I raised without pretending the escape is unnecessary.
- **4.8 / 2b.1 producer-consumer ordering — coherent, and in the safe order.** The
  consumer (2b.1) lands two phases before this second producer (4.8). That is
  correct and not an inversion, because 2b.1's *first* producer already exists in
  the field: `evor-tick` emitted `forge-cannot-spawn-forge-junior-tool-gap` at
  `bab279e`. So 2b.1 has something to consume the day it lands, and 4.8 emits onto
  a bus that is already read. The reverse order is the original defect — a producer
  writing into nothing — and rev 3 avoided it.
- **4.9's headless degradation is safe for these two cases specifically.** Refreeze
  denied unattended means the split is not silently re-cut under a running mission;
  a sealed-threshold change denied means the seal holds. Both failures leave the
  *stricter* prior state in force and both are recoverable by a human. This is not
  a general property of `ask` — it is true here because both operations are
  irreversible in one direction only. The plan says this and is right.

  One ordering note worth a clause: a denied refreeze under an unattended run is
  useless unless the denial reaches someone, which is **4.6** (`permission-denied.mjs`
  escalation) and **4.8** (denial-as-signal). Both precede 4.9 in the table, so the
  dependency is satisfied — but the table lists 4.7 *after* 4.9, which is the only
  place in the document where written order and numeric order disagree. Cosmetic in
  a normal plan; in this one, whose deferral logic rides on cross-references,
  renumber it.

---

## 2. Is §5 sound? — run, not read

**Criterion 1–2 (suites).** Sound. `npx vitest run` over `npm test` is the right
call and the reason given (`--passWithNoTests` makes exit 0 satisfiable by a broken
include glob) is correct.

**Criterion 3–4 (counts and ledger) — the numbers reproduce, the sha does not.**
1003 and 196 both reproduce exactly. But they are **not `bab279e` numbers.** Seven
`harness/tests/test_wave1_*.py` files (76 tests) are untracked, and 21 of the 22
mcp files the `grep` counts do not exist at that sha either. §5 says *"every
command below was executed read-only at baseline sha `bab279e`"*; a reviewer who
checks out `bab279e` and runs the printed command gets **927**, not 1003, and
concludes the plan is fabricated. This is the same defect class as the header's
uncited "263" and as this project's own `modeled-vs-billed-cost` memory: a number
attributed to a source that does not produce it.

*Fix, one of two, both cheap:* either label the baseline honestly — "working tree
at `bab279e` plus the uncommitted wave-3 RED suite" — or, better, commit the RED
suite as part of 0.5 (which already commits ~3,000 uncommitted lines) and record
the resulting sha. The second is preferable: criterion 3's floor and criterion 4's
weakened-assertion rule both name RED files by glob, and a ledger whose baseline
artifacts are untracked cannot be diffed against anything.

Criterion 4's extension from *tests removed* to *assertions weakened* is the right
correction and closes PM-2. Non-gameable in the form written, given a tracked
baseline — which is exactly what the paragraph above is asking for.

**Criterion 5 (freeze) — still does not run.** Rev 3 fixed the three problems the
Critic named (no console script, `--run-dir` required, wrong cwd) and the command
now fails at a fourth:

```
$ cd ~/research/binarization && python3 -m evor.freeze freeze-splits ...
ModuleNotFoundError: No module named 'evor'
```

`evor` lives at `oh-my-evor/harness/evor/`; `~/research/binarization` has no
`.venv` and nothing puts the harness on the path. Verified that
`PYTHONPATH=/home/dainb_1/research/oh-my-evor/harness` makes the import succeed.
The corrected command exits 1 instead of 2 — later, but still before touching a
dataset. This is the criterion carrying the release's headline number and it is
still the one command a reviewer cannot run. *Fix:* prefix `PYTHONPATH=…/harness`
(or name the interpreter that has the harness installed) and print the exact string
that was executed.

**Criterion 6 (deny-rule literals) — scoped correctly, still not falsifiable.**
Rev 3 answered the *conceptual* half of the Critic's change 6(b): "deny-rule
literals, not every `/…/`" is the right unit, and noting that 0.2 legitimately adds
parsing regexes is right. But the Critic asked for **a literal command and the
integer it produced**, and rev 3 supplies neither — it only says what *not* to
count (the useless 217). A criterion that names its unit but not its measurement is
still an intention. For reference, `grep -c "deny(" hooks/pre-tool-use.mjs` returns
**20** on the 583-line file (19 call sites plus the helper at `:51`), which is a
defensible, stable, mechanically checkable proxy for "deny rules" and needs one
line in §5 to become a criterion. Pick that or another, but print the command and
the integer.

**Criteria 7–8.** Sound. "Every invariant names its writer in the commit message"
is enforceable at commit granularity and is the right expression of §2's principle.

---

## 3. Coverage

Grepped the plan against my §6 list item by item. All now present: `scaffold` (2.5),
`n_samples` (2.2), `label_semantics` and `MetricConstraint.scope`/`.purpose` (2.8),
`aggregation_rule` (2.9), `compute.ts:640-648` (2.10),
`_check_no_label_contamination` (2.11), `Campaign` (1.1), concurrency (1.9),
`J-02`/`general-purpose` (4.3), `SendMessage`/the `name` denial (4.4), `PIPELINE`
and `grants.delete(own)` (4.5), `permission-denied` escalation (4.6), read-only
globbing (4.7), `signature`/`occurrences` denial-as-signal (**4.8**, new), `K-11`
and `K-03` refreeze/sealed-threshold `ask` (**4.9**, new), K-08 (3.1's
contemporaneous reason).

`state_history` remains at 0 hits, but 3.1 now says the supersession reason is
written contemporaneously into `transitions.jsonl`. That is the same obligation in
a better home; naming the old field is not required. **Nothing from the trace is
uncovered.** §6's deferrals (2.3's corpus-builder change, and 9.1 with it; `AF6
§6`'s un-traced list) are the honest remainder.

The one coverage item I would still add is not from the trace but from §1 above:
the `stop.mjs` predicates that 1.10 disarms.

---

## 4. Is there an item whose acceptance requires executing a later phase?

**Yes — one, and rev 3 created it: 1.10.**

Three items depend on later phases and **say so**, which is fine: 1.4 (closure held
jointly with 3.3), 9.2 (requires 9.1 and 1.10), and all of Phase 8 (gated on Phase
7). A declared forward dependency is a sequencing fact, not a verification defect.

1.10 is the undeclared one. Its acceptance criterion *"no tree reads `running`"* is
demonstrable at the end of Phase 1 and **ceases to be true during Phase 2**,
because `record.ts:21-45` reconstructs the key and `tree.ts:208-213` writes it
back. The criterion is therefore not a property of the migration; it is a property
of the migration *plus* 3.2's code change, and it can only be *shown to hold* after
Phase 3. Simultaneously, the two `stop.mjs:255/:271` predicates fail silently for
that entire span, so the plan has no signal that the criterion has lapsed.

That is exactly the shape the lead asked about, and it matters more than any single
item — but it is narrow and the fix in §1/C5 is small: move the code deletion into
Phase 1 alongside the data migration. Do that and every item in the release becomes
incrementally verifiable, with the three declared forward dependencies above as the
only remainder.

---

## 5. Verdict

**SOUND-WITH-CHANGES.** The spine survives rev 3 intact; five of the seven changes
are clean, C7's additions are well-placed, and the coverage sweep is complete. Three
things need fixing, none structural, none requiring a reorder of phases:

1. **Fold 3.2's code deletion into Phase 1** with the data migration, and name
   `record.ts:24/:37` and `stop.mjs:255/:271` explicitly. Without this the release
   runs Phases 1–3 with two stop-hook checks silently disarmed, and 1.10's
   acceptance is unverifiable until Phase 3.
2. **Fix §5's baseline attribution** — 1003/196 are working-tree numbers; the RED
   files are untracked and absent from `bab279e`. Commit them under 0.5 and record
   the sha, or relabel.
3. **Finish §5's two unrunnable criteria** — criterion 5 needs `PYTHONPATH` (it
   currently `ModuleNotFoundError`s); criterion 6 needs a printed command and an
   integer.

With those three, this goes to the Critic.
