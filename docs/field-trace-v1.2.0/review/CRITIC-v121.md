# CRITIC review — `docs/v1.2.1-plan.md` revision 2

Deliberate mode. Read-only: the only path this lane created is this file.

**Verdict: ITERATE.** Five of the Architect's six required changes are resolved,
one is partially resolved. The spine is sound and I would not restructure it. What
blocks approval is smaller and sharper than rev 1's problems: the plan's single
named #1 risk has a mitigation that this repo's own `.gitignore` makes a no-op, a
second undeclared migration is hiding in Phase 3.2, and the acceptance section —
rewritten specifically to be falsifiable — contains two criteria that cannot be
executed as printed. Seven required changes in §9. None is "restructure."

---

## 0. What I verified on disk rather than taking from the plan

The Architect opened its review this way because `AF6 §6.2` records eight of eight
wave-2 lanes asserting files that did not exist. Rev 2 is a document written to
answer that review, so the same discipline applies to it.

| check | command | result |
|---|---|---|
| harness suite size | `pytest tests/ --collect-only -q` | **1003 tests** collected |
| RED harness subset | `pytest tests/test_wave1_*.py --collect-only -q` | **76 tests** |
| RED mcp subset | `grep -c "it(" tests/wave1-*.test.ts tests/*live*.test.ts` | **196** `it(` sites |
| vitest version | `require('vitest/package.json').version` | **1.6.1** (no `list` subcommand; `vitest list` is parsed as a *filter*, which is why a naive check reports "No test files found" — the config's `include` does cover `tests/**/*.test.ts`) |
| `evor` console script | `grep script harness/pyproject.toml` | **none** — no `[project.scripts]` |
| freeze CLI | `harness/evor/freeze.py:369-402` | `python -m evor.freeze freeze-splits`, `--run-dir` **required** |
| freeze mechanism | `harness/evor/freeze.py:406-420` | top-level `dataset_path.iterdir()`, 80/20 by count |
| zero-item guard | `mcp/src/tools/compute.ts:640-642` | `testCount === 0 && valCount === 0` — exactly as 2.10 states |
| check 4 | `harness/evor/integrity.py:397-404` | `_check_no_label_contamination` → `return True`; **its docstring says "Check 3"**, and `integrity.py:200` labels check 4 `no_eval_shift` |
| `record.ts:162` | `mcp/src/tools/record.ts:158-163` | "Absence of a failure verdict is not evidence of integrity" — the plan's cited exemplar is real |
| `ARCHITECTURE.md:134` | `docs/ARCHITECTURE.md:133-135` | `job_complete` / `self_heal_event`, `Monitor`-based idle — 2b.3's premise holds |
| T2 false-positive arms | `red/T2-path-enforcement.md:120` | "(d) benign mentions must be ALLOWED — 8 tests, 5 RED" — the Phase 0 gate is real |
| **the ignore template** | **`.gitignore:40`** | **`.evor/runs/`** |
| binarization tree | `du -sh ~/research/binarization/.evor` | **256M**, path confirmed |

The last two rows are load-bearing and are the subject of §5.1.

**On 263.** It approximately reproduces — 76 + 196 = 272 raw `it(`/test sites, and
the gap is consistent with nested `describe` bodies and skips. The Architect's
objection was not that the number is wrong but that it is uncited; rev 2 added
commands to §5 and left the header's *"263 tests of which 201 fail by design"*
(line 10) sourced to nothing. In a project whose memory carries an entry titled
*"our pricing table said $9.70 for a tick Anthropic billed at $15.70"*, an uncited
count in the first ten lines is a habit worth breaking, not a defect worth blocking
on.

---

## 1. The six required changes, item by item

The instruction was to check whether these were **answered**, not acknowledged.

### RC-1 — Move 4.1/4.2/4.3 and 6.7 to Phase 0. **RESOLVED.**

Old 4.1 (path resolution) → **0.2**; old 4.2 (plugin-root denylist +
`EVOR_ALLOW_SELF_PATCH`) → **0.3**; old 4.3 → **0.4**; old 6.7 (commit the plugin
cache) → **0.5**. Phase 4 retains the behavioural items. The move is substantive,
not cosmetic: the Phase 0 gate is *"T2 suite green including its false-positive
arms, so a fix that merely denies more broadly still fails"*, which I verified is
an arm that actually exists (`red/T2:120`, 8 tests, 5 RED). That gate is the answer
to the plan's own §3 cut line — *"any 'add a matcher for X' presumed moot until 0.2
lands"* — and rev 2 correctly renumbered that reference where rev 1's dangled.

One residue, in §7.1 of this review.

### RC-2 — Move tool discovery to Phase 0 and land it alone. **RESOLVED.**

**0.6**, with *"Alone because it moves agent behaviour and would confound Phase 10"*
— which is a typo for Phase 8 (there is no Phase 10), but the reasoning is `AF4
§0`'s and the placement is right. Required change 6 in §9.

### RC-3 — Split Phase 2 into contract and agent affordances. **RESOLVED.**

Phase 2 (2.1–2.11, one substrate) and Phase 2b (2b.1–2b.4), with separate gates and
an explicit rationale — *"separate gate so a behaviour change is attributable to
this phase, not to Phase 2."* That is exactly A2's ask.

### RC-4 — Move the sanity gate into Phase 2, **or** adopt the scored-plugin split. **RESOLVED — and rev 2 did both.**

This is the strongest thing in the revision. **2.5** adopts `AF2 §4`'s
`evor_scaffold_evaluator` split; **2.6** promotes the all-ones sanity gate to a
precondition; **2.7** puts custody *behind both*, with the reason stated in the
plan's own words: *"custody over an unguarded authoring path makes a mis-authored
evaluator permanently binding instead of merely wrong."* T2 asked for one of two
options and got the more expensive one with the failure mode quoted back. Nothing
further is required here.

### RC-5 — Migration as a numbered Phase 1 item, `git init` first, re-score after the leakage fix. **PARTIALLY RESOLVED.**

Three sub-parts. Two are answered, one is answered in form and void in substance.

- *Numbered item with acceptance criteria* — **yes**, 1.10, with four criteria.
- *Reorder* — **yes.** 9.1 is now the leakage restore, 9.2 the re-score, *"after
  9.1, not before"*, with the tampered-evaluator reasoning (inode `28705681`,
  mtime 23:49) reproduced correctly.
- *`git init` the tree first* — **0.8 exists and does not do what it must.** See
  §5.1. This is required change 1.

### RC-6 — Rewrite 2.3's premise. **RESOLVED.**

*"Premise corrected: this requires a corpus-builder change — `manifest.json` gains
`group` per entry. Mask-sha is not a substitute (it collides within-split
legitimately: 132 test items → 128 unique masks)."* The plan now states the
`office_scan`/`office_print` distinction's consequence rather than the mask-sha
coincidence, and declares the deferral path. Correct.

But the deferral path is wired to **stale rev-1 numbering** — required change 3.

**Score: 5 resolved, 1 partial.**

---

## 2. Principle–option consistency: does every item name a writer?

The principle (§2, from `AF6 §4`): *for every invariant, name the writer; if the
writer is the agent that benefits from violating it, it is not an invariant.* Rev 1
failed this audit on five items. Auditing rev 2's Phases 0–3.

**Names a writer, correctly (14):** 0.4 (the audit lane makes the hook a writer of
decisions rather than a write-nothing refuser — this is the item that converts the
governance layer from matcher to writer and it is well placed), 1.2 (server-side
owner per state variable; `finished` a computed property), 1.3 (validated root on
`Run` at lock time), 1.5 (identity registry), 1.7 (envelope), 1.8 (ownership rule
plus locks only where a second writer survives), 1.10 (the migration decides, and
the plan says so), 2.1 (read the manifest the corpus builder already wrote), 2.2
(`n_samples` **server-computed at freeze** — the Architect's exact ask), 2.5
(server generates the harness), 2.7 (server materialises into the CAS), 2.8 (gates
and polarity become contract *data*), 2b.1 (`evor_check_stop` named as consumer),
2b.3 (**`evor_await_artifact` as the writer** — rev 1's single worst violation,
where `blocked` was to be written by the stalled agent that benefits from not being
recorded as stalled; rev 2 names the server-side blocking read, and grep confirms
`Monitor` now appears 0 times in the plan).

**Still not writers, in descending order of consequence:**

1. **1.4 still claims closures it cannot deliver.** *"`readRunState` stops
   returning `running` for a missing file"* is a changed default — a reader fix.
   The invariant "absence is not liveness" gets a writer only at **3.3** (timed
   states + external sweeper). The Architect said explicitly: *"Keep 1.4, but it
   does not close A6/C-01 and should not be listed as doing so without 3.3."* Rev 2
   changed the wording of the item and left the closes column reading **`A6, C-01`**
   unchanged. This is the clearest case in the revision of a change acknowledged and
   not made. Required change 4.
2. **0.3 is a denylist — a matcher — and the plan's cut list presumes matchers moot
   until 0.2 lands.** 0.2 and 0.3 are in the same phase with no stated ordering
   between them. Structurally this is fine (a path denylist over *resolved absolute
   paths* is not the pattern lane J measured as net-negative), but the plan should
   say 0.3 sequences after 0.2, because a denylist over unresolved paths is
   precisely the class of matcher §3 cuts.
3. **1.6 (`extra="forbid"`) is a validator**, and the Phase 1 gate is *"no new
   matcher added in this phase."* The Architect flagged this as a naming collision,
   not a defect. Rev 2 kept both. Harmless; noted for completeness.
4. **0.7 draws an FSM edge before the FSM exists.** Correct as a live-bug fix — the
   `locked → paused` stranding is visible in this repo's `git status` right now on
   `.evor/runs/frontier-1ms/run-live-01/mission-state.json`. But 3.1 builds the
   transition table, and nothing in 3.1 says the table must contain 0.7's edge.
   Cheap to fix, easy to lose. Required change 7.

**Result: substantially better than rev 1.** The one violation with real
consequence (2b.3/`blocked`) is fixed at the writer level rather than papered over,
and 1.4's is a bookkeeping error in a column rather than a design error in an item.

---

## 3. Fair alternatives — is T1's abandonment branch fairly represented?

**No, and this is the plan's weakest rhetorical moment, though I do not think the
decision is wrong.**

The Architect posed T1 as a genuine two-branch choice: migrate (with the
consequences it enumerated) or abandon and **delete 9.1 from the release**, saying
so. Rev 2 chose migrate. What it does not do anywhere — not in 1.10, not in §4
risks, not in §7's changelog — is state that abandonment was an option, what it
would have cost, or why it lost. 1.10 opens *"MIGRATION — a numbered item with its
own acceptance criteria"* and proceeds as though migration were the only branch.

The justification is *recoverable* from the plan: 1.10 says the migration is the
domain model's first real user, and 9.2 says the `iir-scan-binnet-02` re-score
requires 1.10. Chain those and the argument is "abandon the trees and you lose the
README's highest-value single action." That is a good argument. It is also an
argument the reader has to assemble from two items seven phases apart.

This matters more than a documentation nicety because of §5.1: if the migration's
revert point turns out to be unbuildable, the executing agent needs to know that
abandonment was a considered branch with a known cost, not an unthinkable one. A
plan that never wrote down the alternative gives whoever hits trouble at 1.10 no
option but to push forward. **Required change 2** asks for three sentences, not a
restructure.

Elsewhere the plan handles options well: 3.1's refusal of `python-statemachine`
states the rejected option and the decisive reason (`stop.mjs` and `state.ts`
cannot read Python class syntax — RC3 recreated structurally); 2.3 and 9.1 both
carry explicit "if out of scope, this does not land and gets a `KNOWN_GAPS.md` row"
branches; §3 is a cut list with reasons. The pattern exists in the document. T1 is
the one place it was needed most and is absent.

---

## 4. Risk mitigation clarity (§4's four risks)

- **Risk 1 (1.10).** Three mitigations. **One is void, one is strong, one is
  narrow.** See §5.1 immediately below — this is the substance of the verdict.
- **Risk 2 (Phase 2 moves tool contracts the agent files depend on).** Stated as
  *"prompts and schemas move together or both benchmark arms break."* This is
  correct and it is exactly the failure this project's memory records under
  *"re-measure both arms after any agent-file edit; the cheap arm winning is a
  warning sign."* But there is no *check*: nothing in the Phase 2 or 2b gate
  verifies that agent files referencing a changed schema were updated. A grep gate
  ("no agent file references a tool signature that Phase 2 changed") would make it
  testable. Recommended, not blocking.
- **Risk 3 (0.6 and 2b change agent behaviour; Phase 8 is last for that reason).**
  Concrete, correctly ordered, and honest about what stays unverified. The closing
  line — *"nothing needs retracting; RC7 found the numbers right about a narrower
  thing than they were quoted for"* — is fair rather than defensive.
- **Risk 4 (RED suite necessary, not sufficient).** Mitigation is *"delete its test
  deliberately and record why in the phase's commit,"* operationalised in §5 as the
  deletions ledger. Partly gameable — §6.2.

### 4.1 — the pre-mortem's first scenario, stated here because it is a §4 defect

`1.10` is called *"the sharpest risk in the release"* and its first mitigation is
**0.8: `git init` the binarization workspace and apply the ignore template.**

This repo's ignore template is `.gitignore`, and **line 40 is `.evor/runs/`**
(line 1 additionally ignores `.evor/runs/*/artifacts/`). The 256 MB that 1.10
migrates lives at `~/research/binarization/.evor/runs/`.

Applying the ignore template to the binarization workspace therefore produces a git
repository that **ignores the entire migration target**. `git init` succeeds,
`git add -A && git commit` succeeds, the operator sees a clean tree and a commit
sha, and the revert point contains none of the data. The first `git checkout` after
a bad migration restores nothing. The mitigation does not fail loudly — it fails by
reporting success, which is the failure signature this entire trace is about
(`readRunState` returning `running` for a missing file; `_check_no_label_
contamination` returning `True`; `record.ts:162`'s "absence of a failure verdict").

The plan wrote the right mitigation and named the wrong artifact to implement it
with. The fix is small — 0.8 must snapshot `.evor/runs/` *specifically*, by an
inverted ignore rule (`!.evor/runs/`), by `git add -f`, or by not using git at all
(a `cp -al` hardlink snapshot or a tarball is arguably the better tool for 256 MB
of write-once artifacts). What is not acceptable is 0.8 as written, because it is
the prerequisite the plan itself declares non-negotiable: *"a 256 MB one-way
migration against a tree with no revert point is not acceptable."*

The other two mitigations: **dry-run diff reviewed before write** is strong and is
the one that would actually catch a bad lifecycle adjudication. **r3 node artifacts
asserted byte-identical** is strong but narrow — it protects the `iir-scan-binnet-02`
inputs 9.2 needs and says nothing about r1/r2, whose `mission-state.json` the
migration must rewrite from `failed`+`running` into a coherent pair.

### 4.2 — 1.10 is not the release's only migration, and the second one is undeclared

**3.2 deletes `run-state.status`.** All three run trees carry it, and the Architect
verified all three read `running`. So Phase 3 performs a second schema change
against the same 256 MB, after 1.10 has already rewritten it.

1.10's acceptance criterion is *"all three trees load under the new schema."* Phase
3.2 then changes that schema. 3.2 has no migration step, no dry-run, no
byte-identity assertion, and no acceptance criteria of its own — the Phase 3 gate is
*"T5 suite green; five duplicated finished-predicates reduced to one owner,"* which
is a statement about code, not about the trees on disk.

Either 1.10 must migrate to the *post-3.2* shape (i.e. drop `run-state.status` in
the same pass, which means Phase 1 must already know Phase 3's decision — defensible,
since 1.9 already pulls the concurrency decision forward into Phase 1), or 3.2 needs
its own migration item with 1.10's four criteria repeated. The first is cheaper and
better: one write against the trees, not two. Required change 5.

---

## 5. Acceptance criteria — are the commands correct for this repo?

§5 was rewritten specifically to be falsifiable, so I ran it.

### 5.1 The two suite commands: **one correct, one correct-by-accident**

```
cd harness && python -m pytest tests/ -q     # ✓ works; collects 1003
cd mcp     && npx vitest run                 # ✓ works
```
Both are runnable, and both are **red at the rev-2 baseline as they should be** —
I ran the mcp side to completion and it exits 1, which is the 201-fail-by-design
state the release must turn green. Note for whoever executes: `mcp/package.json:9` defines `test` as
`vitest run --passWithNoTests`, and the plan's criterion deliberately does not use
`npm test`. Keep it that way — `--passWithNoTests` turns "exit 0" into a criterion
that a broken `include` glob satisfies vacuously. Worth one line in §5 saying so,
since the obvious "simplification" during execution is to replace the raw command
with `npm test`.

### 5.2 The freeze command **cannot be run as written**

```
evor freeze-splits --dataset-path corpora/v10 --eval-version v1
```
Three separate problems, all verified:

1. **There is no `evor` executable.** `harness/pyproject.toml` has no
   `[project.scripts]`. The invocation form, per `freeze.py:374`, is
   `python -m evor.freeze freeze-splits`.
2. **`--run-dir` is required** (`freeze.py:397`) and is absent from the plan's
   command. The command as printed exits 2 on argparse before touching a dataset.
3. **`corpora/v10` is not a path in this repo.** It resolves only relative to
   `~/research/binarization/`. The plan's other commands are `cd`-prefixed; this one
   is not, and the working directory it needs is a *different repository*.

This is the criterion that carries the plan's headline number — 132 domain-labelled
test items instead of 5 metadata files. It is the one command a reviewer would most
want to run to falsify the release, and it is the one that does not run.

While confirming the invocation I read the mechanism, and it strengthens the plan:
`freeze.py:406-420` scans `dataset_path.iterdir()` for **top-level files only** and
splits 80/20 by count. Pointed at `corpora/v10`, whose top level holds
`dataset_card.yaml`, `domains.json`, `manifest.json`, `test.txt`, that yields
exactly the 5-file freeze `AF1` reproduced. So 2.1 (read
`eval_manifest_test.json`) is the mechanism fix and 2.10 (`compute.ts:640-642`) is
the detection fix, and the plan is right that both are needed. The gate asserts the
outcome and the phase now fixes both halves of the mechanism — **the Architect's
§6 objection about 2.10 is closed.**

### 5.3 The matcher-count baseline is **not a criterion yet**

> `grep -c` for new regex literals in `pre-tool-use.mjs` does not exceed the rev-2
> baseline.

No pattern is given and no baseline number is recorded. I tried the obvious
pattern: `grep -c "/.*/" hooks/pre-tool-use.mjs` returns **217** against a
583-line file — it matches every path-like string, so it is useless as a baseline.
`grep -c "new RegExp"` returns **0**.

A criterion whose measurement procedure is unspecified and whose baseline is
unrecorded is not falsifiable; it is an intention. It needs a literal command and
the integer it produced at the rev-2 commit, both written into §5. Required change 6.

Note also that 0.2 and 0.4 both *add* code to `pre-tool-use.mjs` — 0.2 a path
resolver handling redirects, `tee`, `cp`/`mv`/`ln`, `sed -i` and heredocs. Parsing
those without regexes is unlikely. The criterion as intended ("do not fix this by
adding matchers") is right; as stated it will either fire on 0.2 or be quietly
dropped. Scope it to *deny-rule literals*, not to regexes in the file.

### 5.4 Can the deletions ledger be gamed? **Yes, three ways.**

The ledger: *"Any test removed between rev-2 baseline and release is listed in
`docs/v1.2.1-test-deletions.md` with the phase, the deleted call site, and the
invariant that replaced it. A test count that falls without a corresponding row
fails the release."*

This is a real improvement over rev 1's *"all 263 tests green, with every deletion
justified in writing"* — it has a trigger, an artifact, and a failure condition. It
still has three holes, and the first two matter:

1. **No baseline is recorded.** "The rev-2 baseline" names no commit and no number.
   The counts must be captured now, by the §5.1 commands, at a named sha, and
   written into the plan — otherwise the baseline is whatever the tree happens to
   hold when someone first thinks to measure, which in this project has previously
   been the source of the error rather than the check on it.
2. **It counts tests, not assertions.** A test can be neutered — assertion
   loosened, `expect(x).toBe(132)` → `expect(x).toBeGreaterThan(0)`, an arm dropped
   from a parametrised case — with the count unchanged and no ledger row triggered.
   This is not hypothetical here: it is what `_check_no_label_contamination`'s
   `return True` is (`integrity.py:404`), and `red/T2:130` states the general form
   — *"a fix that denies more broadly"* passes a weakened check. This project's own
   memory records the rule: *a lenient arm passing only proves the check was too
   weak to fire.* Fix: the ledger triggers on **net negative change in tests
   collected _or_ a reduction in RED-suite assertions**, and the RED files
   (`test_wave1_*.py`, `wave1-*.test.ts`) get a stricter rule — any diff to an
   assertion inside them needs a row, not just a deletion.
3. **A deletion plus an unrelated addition nets to zero.** Minor: a per-file count
   rather than a total closes it.

### 5.5 The remaining two criteria

*"Every invariant added in Phases 1–3 names its writer in the commit message"* —
checkable by reading the log, and given §2's audit this is the right thing to
enforce at commit granularity. Good.

*"One commit per item, one tag per phase, full suite at each gate"* — the
Architect's A2 objection that this *"tags at the wrong granularity: the commit is
the attribution unit but nothing is measured per commit"* is **unresolved**, and I
judge it correctly unresolved. Per-commit measurement is not affordable for a
release with a live-hardware measurement phase. The 2/2b split plus 0.6-lands-alone
is the affordable approximation and it is the right call. Not a required change.

---

## 6. Do the phase gates verify what the phases claim?

| phase | gate | verdict |
|---|---|---|
| 0 | T2 green **including false-positive arms** | **Strong.** Verified the arms exist (`red/T2:120`, 8 tests, 5 RED). This gate cannot be passed by denying more broadly — the exact failure mode of the phase. Best gate in the plan. |
| 1 | T3 + T4 green; no new matcher | **Weak on the item that matters.** Nothing in the gate touches 1.10. The migration has its own four criteria inside the item, which is correct, but they are not in the gate, so a Phase 1 tag can be cut with the trees unmigrated or half-migrated. Fold 1.10's criteria into the Phase 1 gate. |
| 2 | freeze yields 132 domain-labelled items | **Now verifies the mechanism** — 2.1 fixes the scan, 2.10 fixes the guard predicate, 2.11 fixes the always-true check. Architect's objection closed. The command itself does not run (§5.2). |
| 2b | T6 + T4 agent-facing tests green | Adequate. Attribution is the point of the split and it achieves that. |
| 3 | T5 green; five finished-predicates → one owner | **Asserts an outcome over an unmigrated substrate.** The predicate count is checkable in code; 3.2's deletion of `run-state.status` from three live trees is not in the gate at all (§4.2). |
| 4 | T2 + governor suites green | Adequate. |
| 5–8 | T6 / T8 (incl. `EVOR_LIVE_HW`) / T7 / — | Phase 8 has **no gate**, which is defensible for a measurement phase, but 8.2's stated design (*"powered haiku prefix check… n sized to the margin"*) needs the margin written down. This project's memory carries `underpowered-at-n30`: *"not significant" ≠ "no regression"*. 8.1's *"n sized to the margin"* is the right instinct with no number attached. |
| 9 | none stated | 9.1/9.2 carry their own conditions inline. Acceptable. |

**Sequencing:** does anything in Phase 0 secretly depend on the domain model? I
checked each. 0.1 (key rotation) operator-only; 0.2/0.3/0.4 operate on paths and
hook decisions, not on `Run`/`Mission`; 0.5 is a commit; 0.6 is naming and alias
resolution; 0.8 is a snapshot. **0.7 is the one exception** — drawing a `locked →
paused` recovery edge is a state-machine change landing before 3.1 builds the
transition table. It is right to land early (it is live in this repo now) but it
must be carried forward, which nothing currently requires. Required change 7.

**A1, answered or relocated?** Answered on substance. A1's complaint was that
Phases 1–3 execute 25 items of agent-driven editing under the governance posture
that produced the finding, and that the false-positive tax (82 denials, 66% false,
~8.2M tokens) would be paid through the most Python-and-pytest-shaped phases of the
release. Moving 0.2 forward removes the tax before those phases; 0.3 removes the
self-patch exposure. That is the fix, and it is real.

**But it creates a tension rev 2 has not noticed.** `RC2` prediction 3 — the reason
0.3 exists — is that `agents/*.md` and `skills/*/SKILL.md` are unguarded, *"the
layer carrying the unenforced rules is itself writable by the agents the rules
bind."* Meanwhile the plan's own risk 2 says Phase 2 changes tool contracts **the
agent files depend on**, and *"prompts and schemas move together or both benchmark
arms break."* So the release's own work requires agents to edit `agents/*.md` —
through the denylist Phase 0 installs, via the `EVOR_ALLOW_SELF_PATCH=1` escape.
If that escape becomes routine for Phases 1–3, the guard is theatre for the
duration of the release, and the log 0.3 promises is the only thing standing. Not a
blocker — logged-and-routine still beats unguarded-and-invisible — but 0.3 should
say who is expected to set that flag during this release and what reviews the log.

**Wrong-phase items after the reshuffle:** I found none. 2.10 and 2.11 belong in
Phase 2 (they are the mechanism behind its gate). 1.9 belongs in Phase 1 (`AF6
§6.6` asked for exactly that). 4.3–4.7 are behaviour changes and belong after the
affordances. 0.7 is correctly early even though it is FSM-shaped.

---

## 7. Scope integrity — what is still uncovered after rev 2

The user's instruction was "fix all". §7.6 claims the Architect's coverage-gap list
was added. Grepping the plan against `ARCHITECT §6` item by item:

**Added and verified present:** 2.9 (`aggregation_rule`, 1 hit), 2.10
(`compute.ts:640-648`), 2.11 (`_check_no_label_contamination`), 4.3
(`general-purpose` inherit-spawner's-operations), 4.4 (the `name` denial, 19/26),
4.5 (`PIPELINE`/`grants.delete(own)`), 4.6 (`permission-denied.mjs` escalation),
4.7 (`evor-tick` read-only globbing), 1.1's `Campaign` (2 hits), 1.9 (concurrency),
2b.3's `evor_await_artifact` (1 hit), 2.2's `n_samples` (2 hits), 2.5's `scaffold`
(1 hit), 2.8's `label_semantics` (1 hit) and `MetricConstraint.scope`.

That is a genuine and near-complete sweep. **Three remain at zero hits:**

1. **`AF5 §4`'s denial-as-signal with `signature`-dedup** — grep: `signature` 0,
   `occurrences` 0. That lane calls it *"the highest-leverage change in the lane"*:
   82 identical `runsTraining` denials collapse to one signal with
   `occurrences: 82`, legible **during** the run instead of in a post-hoc trace.
   Rev 2's 4.1 gives the governor a log; 2b.1 simultaneously builds a signal-bus
   consumer (`evor_check_stop` returning blocked with the gap attached). The two
   items are one item apart and are not connected. This is the cheapest remaining
   item in the trace and the one whose absence is least defensible after a revision
   that added eight others.
2. **`AF5 gap 4` / K-11 / K-03 — refreeze and sealed-threshold changes as the
   genuine `ask` cases** — grep: `K-11` 0, `K-03` 0, `refreeze` 0. Rev 1 explained
   correctly why `ask` degrades headless and then dropped the two operations that
   actually want it. Rev 2 dropped the explanation too, so these are now absent
   rather than declined.
3. **K-08 — supersession reason must be contemporaneous, not narrated 14 h later**
   — grep: `state_history` 0. 3.1's append-only transition log plausibly covers it;
   the Architect asked for that to be *said*, because `AF5 §5` names
   `state_history` as its home. One clause in 3.1.

None is structural. All three are one-line additions to existing items, or three
rows in `KNOWN_GAPS.md`. But "fix all" with a §6 that defers explicitly makes
silence the wrong disposition: §6 currently defers only 2.3's corpus-builder change
and `AF6 §6`'s un-traced list. Required change 3 folds these in.

**Cross-reference rot from the 9.1/9.2 renumber.** The reorder was done by swapping
the items' numbers, and two references to the old numbering survived:

- **2.3** says *"If the corpus-builder change is out of scope, **9.2** does not land
  in v1.2.1"* — but under rev 2's numbering, 9.1 is the leakage restore that
  requires 2.3, and 9.1 itself says so. 9.2 (the re-score) depends on 9.1 and 1.10.
- **2.11** says *"**9.2** restores check 2; this is check 4"* — under rev 2, 9.1
  restores check 2. And "check 4" is itself wrong: `integrity.py:398` documents
  `_check_no_label_contamination` as **Check 3**, while `integrity.py:200` shows
  check 4 is `no_eval_shift`.
- §6 gets it right (*"2.3's corpus-builder change if out of scope (and 9.1 with
  it)"*), which is what makes the other two visibly stale rather than ambiguous.

Small, but this is a plan whose deferral logic is *encoded in these
cross-references*: 2.3 out of scope → which item does not land? The document
currently gives two different answers.

---

## 8. Pre-mortem — three ways this release fails

Required by deliberate mode. Each names the phase, the item, and the earliest
signal.

### PM-1 — The migration's revert point is empty, and nobody learns this until they need it

**Phase 0 item 0.8 → Phase 1 item 1.10.** 0.8 runs `git init` on
`~/research/binarization` and applies the ignore template. `.gitignore:40` is
`.evor/runs/`. The initial commit contains configuration and no run trees. 1.10
proceeds with its dry-run diff reviewed and its byte-identity assertion passing —
both mitigations *work*, and both are about the write, not the recovery. Weeks
later a Phase 3.2 follow-up write corrupts an `r1` state file, someone runs
`git checkout`, and 256 MB of the only real field data this project has is
unrecoverable.

**Earliest signal — available in seconds, and it is the same command either way:**
after 0.8, run `git -C ~/research/binarization status --porcelain --ignored | grep
'.evor/runs/'`. If the run trees appear under `!!` (ignored) rather than in the
commit, 0.8 has not produced a revert point. **Gate 1.10 on `git -C … ls-files
.evor/runs/ | wc -l` being non-zero**, which is a criterion the executing agent
cannot pass by accident.

### PM-2 — Phase 2 lands, the gate goes green on 132 items, and the RED suite has been quietly weakened to let it

**Phase 2 items 2.1/2.10/2.11 against §5's deletions ledger.** Phase 2 changes the
dataset contract, and the T1 RED tests were written against the *old* freeze
behaviour. Every one of them that fails is ambiguous: is it pinning an invariant, or
pinning a call site the phase legitimately removed? Risk 4 says to delete
deliberately and record why — but the cheap resolution under time pressure is not
deletion (which triggers a ledger row) but **loosening**: an assertion relaxed, a
parametrised arm dropped, a `132` softened to `> 0`. Test count is unchanged, no row
is triggered, the gate reports green, and the release ships with the detection layer
for its headline fix weaker than it was on `bab279e`. The precedent is in the tree:
`integrity.py:404` is a check that returns `True`, and 2.11 exists because nobody
noticed for a release cycle.

**Earliest signal:** at the Phase 2 gate, diff the RED files against the rev-2
baseline sha and count assertions, not tests —
`git diff <baseline> -- harness/tests/test_wave1_*.py mcp/tests/wave1-*.test.ts |
grep -c '^-.*\(assert\|expect\)'`. Any non-zero result with no ledger row is the
signal, and it appears at the gate rather than three phases later.

### PM-3 — Phase 8 re-measures, the numbers move, and nothing can attribute the movement

**Phase 0 item 0.6 + Phase 2b + Phase 8 item 8.1.** The plan is careful here — 0.6
lands alone precisely because it changes what tools agents can reach (58/97 agents
failing bare-name `ToolSearch`), and Phase 8 is last for the same reason. But
between the 0.6 baseline and 8.1 sit Phase 2's tool-contract changes and Phase 2b's
four behaviour changes, and risk 2 concedes that prompts and schemas must move
together — i.e. **agent files change during Phases 2 and 2b.** 8.1 then runs "both
arms from one paired run against identical agent files." Identical to each other,
yes; identical to anything measured in v1.2.0, no. So the tier claims are not
re-verified — they are re-measured against a different system, and any difference is
uninterpretable. This project's memory records both halves of this trap already:
*a prompt fix regressed the strong arm*, and *the first forge-junior tier matrix
measured the scheduler, not the models.*

**Earliest signal — before Phase 8 rather than after:** at the Phase 2b gate,
`git diff --stat <phase-0.6-tag> -- agents/ skills/`. A non-empty diff means 8.1
cannot be reported as a re-verification of v1.2.0's claims and must be labelled a
fresh measurement of a changed system. Deciding that at the 2b gate costs a
sentence; discovering it after a live-hardware run costs the run.

---

## 9. Expanded test plan

Required by deliberate mode. The plan leans on the 263-test RED suite, which was
written against **wave-1 findings on `bab279e`** — that is, against the system as it
failed, not against the system this release builds. Two changes are outside its
reach entirely.

### Where the RED suite is insufficient

**1.10 (migration) — the suite has no coverage of this shape at all.** Every RED
test asserts a property of code. 1.10's failure modes are properties of *data*: a
tree that half-loads, a lifecycle decision made wrongly, artifacts silently
rewritten. Needed:

- *Unit:* the migration function, table-driven over the three real
  `mission-state.json`/`run-state.json` pairs as fixtures — `failed`+`running`,
  `failed`+`running`, `running`+`running` — asserting the adjudicated output for
  each. These are the inputs the operator handled by hand in `vim` at 00:13:36;
  freezing them as fixtures is what makes 1.10 "the domain model's first real user"
  a testable claim rather than a description.
- *Integration:* idempotence (`migrate(migrate(x)) == migrate(x)`) and a
  round-trip load of all three trees under the new schema. Idempotence is what makes
  a partial failure recoverable by re-running, which given PM-1 may be the only
  recovery available.
- *E2E:* migrate a **copy** of all three trees; `find -type f -exec sha256sum` over
  r3's node artifacts before and after; diff the sets. The plan asserts byte
  identity — this is the command that checks it.
- *Observability:* the dry-run diff must be an artifact on disk, not console
  output, and the Phase 1 gate should require it to exist and to have been reviewed.
- *Negative:* feed the migration a tree with `run-state.status` already absent —
  because after 3.2 that is what the trees look like, and if 1.10 is re-run for any
  reason it will meet its own output.

**3.1–3.3 (FSM) — T5 tests termination behaviour, not transition legality.** The
FSM is new; nothing existing constrains it. Needed:

- *Unit:* every cell of the JSON transition table — legal transitions accepted,
  illegal rejected. Since 3.5 generates the Mermaid diagram from the table, add a
  test that the committed diagram matches a fresh render, or the diagram rots in the
  26-hour window 7.4 exists to close.
- *Unit:* the table must contain 0.7's `paused → locked/running` recovery edge.
  This is the carry-forward that §2 flags as easy to lose, and one assertion fixes
  it permanently.
- *Integration:* the three-language reading problem — 3.1's decisive argument is
  that `stop.mjs`, `state.ts` and the Python harness must all read the same
  structure. Test that all three loaders parse the same `transitions.json` and agree
  on legality for an identical set of pairs. Without this, RC3 is recreated in a new
  file format and nothing notices.
- *Integration:* 3.3's staleness sweeper — a state entered, `max_dwell` exceeded,
  no process alive, sweeper transitions it. This is the writer for the invariant
  1.4 only defaults; it is the test that lets 1.4 legitimately claim A6/C-01.
- *E2E:* kill a training process mid-run (`AF3 F1`: *"a killed process executes no
  transition"*) and assert the run reaches a terminal state without human action.
  This is the actual field failure and no current test reproduces it.
- *Observability:* `transitions.jsonl` append-only, with the K-08 requirement — a
  supersession reason written **at transition time**. Assert the log entry's
  timestamp is within the transition, not backfilled.

**Cross-cutting, and the most important addition:** a **weakening detector** in CI
— PM-2's signal, run at every phase gate rather than at the release. The plan's
ledger catches deletions; this catches the substitution that a deletion ledger
predictably induces.

**One thing the plan should keep exactly as-is:** 7.3's `ToolSearch` gating test.
The plan's reason — *"without it an agent physically cannot call the tool; this
confound already produced one false red"* — is the difference between measuring a
model and measuring a harness bug, and this project has already paid for that
lesson once.

---

## 10. Where rev 2 is better than the review it answers

Stated because a review that only subtracts is not a review.

- **RC-4 was a choice between two options and rev 2 took both** (2.5 split + 2.6
  gate + 2.7 custody behind them), with `AF2 §4`'s failure mode quoted back in the
  item that would have caused it. That is the most expensive of the available
  answers and the correct one.
- **2b.3 fixes rev 1's worst principle violation at the writer level.**
  `evor_await_artifact` replaces an agent-asserted `blocked` field; `Monitor` now
  appears zero times. Rev 1 had the stalled agent writing the record of its own
  stall.
- **2.3's premise was corrected against the plan's own interest.** Admitting the
  group key needs a corpus-builder change means the release's headline science
  finding may not land. Rev 2 wrote that down and gave it a deferral path instead of
  keeping the convenient claim.
- **§5's rewrite is a real conversion** from "all 263 tests green" to commands, a
  ledger, and a baseline. Two of the four criteria are defective (§5.2, §5.3), but
  they are defective in a way I could *demonstrate by running them* — which is the
  entire point of the rewrite and was not possible against rev 1.
- **0.6's isolation is disciplined.** Landing the largest-N finding alone, with the
  confound named, costs a phase boundary and buys the only attributable measurement
  in the release.

---

## 11. Verdict

**ITERATE.** The structure is sound — I would not reorder the phases, and the
2/2b split plus the Phase 0 hoist answer A1 and A2 on substance rather than by
relocation. Five of six required changes are resolved and the sixth is resolved in
form. What follows is seven changes, none structural; changes 1, 3 and 5 are the
ones I would not ship without.

1. **Fix 0.8, or 1.10 has no revert point.** `.gitignore:40` is `.evor/runs/` —
   applying the ignore template to the binarization workspace ignores the exact
   256 MB 1.10 migrates. Snapshot `.evor/runs/` explicitly (`!.evor/runs/`,
   `git add -f`, or a tarball / `cp -al` snapshot instead of git), and **gate 1.10
   on `git -C ~/research/binarization ls-files .evor/runs/ | wc -l` being
   non-zero.** (PM-1.)
2. **State T1's abandonment branch and why it lost.** Three sentences in 1.10 or
   §4.1: abandoning the trees kills 9.2's re-score of `iir-scan-binnet-02`, the
   README's highest-value single action, which exists under r3 only. The plan
   chose correctly and never wrote down that there was a choice — which leaves
   whoever hits trouble at 1.10 with no considered fallback.
3. **Close the three remaining uncovered findings, or give them `KNOWN_GAPS.md`
   rows:** `AF5 §4` denial-as-signal with `signature`-dedup and `occurrences: 82`
   (grep: 0 — and 2b.1 is building the consumer bus one item away); `AF5 gap 4` /
   K-11 / K-03, refreeze and sealed-threshold changes as the genuine `ask` cases
   (grep: 0); K-08's contemporaneous supersession reason, one clause in 3.1 naming
   `state_history`/`transitions.jsonl` as its home. **And repair the 9.1/9.2
   renumber rot:** 2.3 says "9.2 does not land" where it means 9.1; 2.11 says "9.2
   restores check 2" where it means 9.1, and calls
   `_check_no_label_contamination` check 4 where `integrity.py:398` documents it as
   check 3 (`integrity.py:200`: check 4 is `no_eval_shift`).
4. **Correct 1.4's closes column.** It reads `A6, C-01`; the Architect stated that
   1.4 is a changed default and the invariant gets its writer only at 3.3. Move
   those closures to 3.3 or mark them jointly held. This is the one required change
   from the Architect that rev 2 acknowledged in prose and did not make.
5. **Declare Phase 3.2's migration.** Deleting `run-state.status` is a second
   one-way schema change against the same three trees, after 1.10 has rewritten
   them, with no dry-run, no acceptance criteria, and a Phase 3 gate that speaks
   only about code. Preferred fix: 1.10 migrates to the post-3.2 shape in one pass
   (Phase 1 already pulls the concurrency decision forward at 1.9, so it can pull
   this one too). Otherwise 3.2 needs 1.10's four criteria of its own. (§4.2.)
6. **Make §5 executable.** (a) The freeze command does not run: there is no `evor`
   console script (`harness/pyproject.toml` has no `[project.scripts]`), the form is
   `python -m evor.freeze freeze-splits`, `--run-dir` is required and missing, and
   `corpora/v10` resolves only under `~/research/binarization`. (b) The matcher
   criterion needs a literal grep pattern and the integer it produced at a named
   rev-2 sha — `grep -c "/.*/"` returns 217 on a 583-line file and is useless;
   scope it to deny-rule literals, since 0.2 will legitimately add regexes. (c)
   Record the rev-2 baseline test counts at a named sha, and extend the ledger's
   trigger from *tests removed* to *assertions weakened in the RED files* — a
   count-only ledger is satisfied by neutering, which is what `integrity.py:404`
   already is. (§5.2–5.4, PM-2.)
7. **Two carry-forwards and a typo.** 3.1's transition table must contain 0.7's
   `locked → paused` recovery edge (assert it, or the Phase 0 fix is silently
   dropped when Phase 3 rebuilds the machine); 0.3 should state that it sequences
   after 0.2 and say who may set `EVOR_ALLOW_SELF_PATCH=1` during Phases 1–3 and
   who reviews the log, since risk 2 requires agent-file edits through that
   denylist; and 0.6 cites "Phase 10", which does not exist — it means Phase 8.

Recommended, not blocking: fold 1.10's four criteria into the Phase 1 gate; add a
grep gate at the Phase 2/2b boundary that no agent file references a tool signature
Phase 2 changed; write down 8.1's margin, given `underpowered-at-n30`; cite the
command behind the header's "263" (it approximately reproduces: 76 harness +
196 `it(` sites); and keep §5's raw `npx vitest run` rather than `npm test`, whose
`--passWithNoTests` would make "exit 0" satisfiable by a broken include glob.
