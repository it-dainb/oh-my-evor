# Agent-file defects surfaced by the retier benchmark

These are defects in the **agent files**, not in the eval harness and not in the
models. They were found by benchmarking, which is the point: a contract that
contradicts itself cannot be graded, and until you try to grade it nobody
notices.

**Status: all three are fixed.** They were deliberately left alone while the
retier matrices ran -- editing an agent file mid-benchmark changes what the
matrices are measuring, and the exercise is worthless if the two arms do not see
the same prompt. The fixes landed after the last matrix completed; the three
affected roles were re-baselined against the amended files, and those
re-baselines are the numbers to cite for mutagen, sage and sage-junior.

---

## 1. `evor-mutagen.md` — mutation_tier is doubly determined

- **:156** `wildness < 0.5` → `mutation_tier = "parametric"`
- **:125** a proposal with `approach_family="data-acquisition"` is always `"structural"`

For a data-acquisition proposal at low wildness these give opposite answers.
Sonnet resolved it toward the specific rule (:125) in every smoke case; both
structural proposals it emitted at wildness 0.2 and 0.3 were exactly the
data-acquisition ones, which is the standard specific-beats-general reading.

**Effect on the benchmark:** `proposals[].mutation_tier` was dropped from the
mutagen contract in S19. Grading it would score which horn a model happened to
pick, not whether it followed the spec.

**Fixed.** `Wildness_Interpretation` now carries an explicit PRECEDENCE
paragraph: a data-acquisition proposal is `"structural"` at every wildness, that
specific rule wins, and the wildness ranges are the general case for every other
family. `Data_Acquisition_Mutations` carries the reciprocal cross-reference.

A second collision surfaced while fixing this one, one line up: the wildness
*table* labelled the 0.2–0.5 row "Structural mutation within parent's family"
while the rule below it assigns `mutation_tier="parametric"` to that same range.
The table now describes the step size without reusing the field's vocabulary,
and a sentence says outright that only the two rules name `mutation_tier`.

`proposals[].mutation_tier` is graded again as a result -- restricted to
non-data-acquisition proposals, which required a new `where` filter in the
harness (see below).

---

## 2. `evor-sage-junior.md` — confidence is doubly determined

- **:30** `confidence` is `"high"` only when ≥2 independent sources agree within 5%
- **:62** `|A-B| / max(A,B) ≤ 0.05` → `trust_level = "authoritative"`
- **:42** if the evidence is ambiguous, report it as `"low"` confidence with the
  ambiguity stated explicitly

Two sources can agree numerically to within 5% and still be methodologically
incomparable. On the `divergence-just-inside` case both arms did exactly this:
they computed 4.5% divergence, noted it was inside the band, and then
downgraded to `indicative`/`medium` because the two papers used different
preprocessing pipelines and possibly different splits.

The mechanical rule (:30, :62) says authoritative/high. The judgement rule
(:42) says low. Both are stated; the model cannot satisfy both.

**Effect on the benchmark:** none on the verdict. The case depresses both arms
(haiku 2/3, sonnet 0/3) and the comparison is paired, so it does not favour
either tier. It is left graded and flagged rather than removed, because unlike
the mutagen case the model's failure mode here is legible.

**Fixed**, the way the models argued for. Both `evor-sage-junior.md` and
`evor-sage.md` gained a step **2b COMPARABILITY GATE** that runs *before* the 5%
arithmetic: two numbers are comparable only if they share dataset AND split AND
evaluation protocol, an unstated protocol is not an established one, and a
failed gate yields `quorum_met=false` / `trust_level="indicative"` /
`confidence="low"`. The confidence bullets in `Success_Criteria` now point at
the gate rather than at numeric closeness alone.

Both arms were right and the fixture was wrong, so `divergence-just-inside`
flipped: it is now `divergence-inside-band-incomparable` and expects
indicative/low. Because that case had been the only positive test of the 5%
arithmetic, a comparable twin was added alongside it in both specs -- same
divergence, protocols explicitly shared -- so the arithmetic keeps a case that
can only be passed by doing it.

---

## 3. `evor-sage-junior.md` — indirect evidence: assert-low or decline?

- **:31** `"low"` confidence is for "only indirect evidence"
- **:42** / **:145** no speculation; do not inflate

On `indirect-evidence-forum` both arms returned `findings: []` rather than a
low-confidence finding sourced to a forum post. :31 implies indirect evidence
should be *reported at low confidence*; the anti-speculation rules imply it
should not be reported at all. The file never says which.

**Effect on the benchmark:** depresses both arms roughly equally (2/3 each).

**Fixed** by naming the classes. `evor-sage-junior.md` gained a
`<Source_Admissibility>` block that separates "report it, at this ceiling"
(peer-reviewed → up to high; leaderboard or model card → medium; indirect
technical evidence such as an authors' engineering blog, framework docs, a
maintainer's issue comment → low, never higher) from "do not report at all"
(anonymous forum and social-media posts, marketing copy with no method,
unestablished provenance, and any number not actually fetched this tick). An
angle with nothing admissible returns an empty list *plus a stated reason*, so
Sage can tell "found only inadmissible sources" from "search failed".

Both arms were right here too: `indirect-evidence-forum` is now
`inadmissible-forum-anecdote` and expects zero findings. The vendor page in
`indirect-evidence-only` turned out to be marketing copy with no method rather
than indirect technical evidence, so it became `inadmissible-marketing-copy`
(zero findings), and a genuinely indirect-but-admissible case was added so the
low-confidence-reportable branch is still tested.

---

## 4. `evor-mutagen.md` — dream_k asks for more proposals than families exist

- **Success_Criteria** `dream_k >= train_k * 2`
- **H003** no two proposals in one call may share an `approach_family`
- **Output_Format** the `approach_family` enum holds exactly seven values:
  `arch`, `training`, `data-curation`, `data-augmentation`, `data-acquisition`,
  `algo`, `other`

Seven distinct families is the most proposals a single call can contain. At
`train_k >= 4` the doubling rule asks for eight or more, and the two rules become
mutually unsatisfiable. Nothing in the file said which one yields.

Found by the S30 re-baseline, not by reading: `dream-k-scales-with-train-k`
(train_k=5, so the fixture demanded 10) and `crossover-lineages-far-apart`
(demanded 8) each scored **0/3 in both arms**. Both models emitted exactly seven,
one per family, and both were right; the fixtures were impossible. Two arms at
zero is the fixture-bug signature -- a capability difference does not show up
identically in both.

**Fixed.** Step 5a now computes
`dream_k = min(max(strategy.dream_k or 0, train_k * 2, 5), 7)` under a FAMILY
CEILING paragraph that names the seven families, says the two rules collide, and
says which wins: H003 is a hard Selector gate, so it wins, and padding by
repeating a family costs a slot and buys nothing. Both fixtures now expect 7.

---

## Cross-cutting note

All four are the same defect class this session has been chasing: **a rule that
is graded but not stated, or stated twice with different answers.** The harness
catches the first shape structurally — `scoreByContract` throws on an
expectation outside the contract. It cannot catch the second, because both
rules really are in the file. That needs a human read, or a lint pass that
looks for two rules writing the same output field.

Defect 4 suggests a cheaper detector than either. Three of the four were found
by *grading the field* -- and the signature is specific: **a case that fails in
every arm is a fixture or file bug, not a capability difference.** A model that
is merely weaker fails some of the time; a rule that cannot be satisfied fails
all of the time, identically, at every tier. `ci/compare-arms.py` already splits
its per-case output on exactly this, and it is worth reading that section first
whenever an arm regresses. The corollary is uncomfortable but held every time
this session: when the models disagree with the fixture, check the fixture.

---

# Known fixture limitations (mine, not the agent files')

These depress both arms equally, so they do not affect any retier verdict. They
do depress the absolute accuracy numbers, so they are stated rather than
quietly excluded.

## `evals/sage/spec.json` — `ambiguous-low-confidence` is mis-specified

The case supplies two juniors reporting two *different* techniques (multi-scale
TTA on Cityscapes, flip-only TTA on ADE20K). Each finding is individually
single-sourced and clean, which the rules put at `"medium"`. The ambiguity is
in the *comparison between* them, not in either one.

The contract grades `findings[].confidence` with `every`, so it demands both
findings be `"low"`. Both arms returned `"medium"` and both were right.

Effect: 0/3 per arm, so roughly -10pp on both sage arms. sonnet 86.7% / opus
83.3% as measured; ~96.3% / ~92.6% excluding this case.

**Fixed.** Both juniors now report the same technique and the same metric
(multi-scale TTA, mIoU gain), which `evor-sage.md:83` makes a cross-junior
quorum, but on different datasets at different resolutions with different
backbones. The two values are 2.4 and 2.3 -- 4.2% apart, *inside* the 5% band --
so the arithmetic alone answers "authoritative/high" and only the comparability
gate answers "low". The case is a discriminator now rather than a trap.

## `evals/sage-junior/spec.json` — two cases sit on agent-file contradictions

See defects 2 and 3 above. Both are fixed: the agent file now answers each
question once, and both cases were re-specified to the answer it gives.

---

# Harness changes these fixes required

**`where` on per-element fields.** A per-element rule sometimes governs only
part of a list. Mutagen's wildness ranges set `mutation_tier` for most approach
families but not for data-acquisition, and a bare `every` cannot say that --
which is why the field was dropped rather than grade a rule the agent was never
given. `every`/`unique` now accept `where: {field, equals | not_equals}`, and
`buildContractText` renders the filter into the prompt ("every entry of
`proposals` whose `approach_family` is not `data-acquisition` ..."), so the
restriction is stated wherever it is graded. A filter that selects nothing fails
rather than passing vacuously, for the same reason an empty list does.

Fields may now also carry a `key`, so two rules can share one path while keeping
distinct expectation keys.

**The degenerate-strategy floor had a blind spot.** It enumerated fixed replies
for scalar fields but skipped `every`/`unique` entirely -- so "report every
finding as indicative/medium/not-met" was never priced, and that is precisely
the shape of the cases being added. With per-element constants enumerated (both
an empty list and one long enough to satisfy any `min`), the check immediately
found that a constant answer cleared 4 of 10 sage cases. Sage gained a second
single-source case and a three-junior comparable quorum, and `confidence` is now
graded on the cases where the rules determine it, which was the free ride the
fixed "medium" answer had been taking.
