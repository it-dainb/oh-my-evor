# Agent-file defects surfaced by the retier benchmark

These are defects in the **agent files**, not in the eval harness and not in the
models. They were found by benchmarking, which is the point: a contract that
contradicts itself cannot be graded, and until you try to grade it nobody
notices.

None of them are fixed here. Editing an agent file mid-benchmark would change
what the retier matrices are measuring, and the whole exercise is worthless if
the two arms are not run against the same prompt. Fix them after the merge
decision, then re-baseline.

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

**Suggested fix:** state the precedence explicitly at :156 — either
"…except data-acquisition proposals, which are always structural (see :125)",
or drop the blanket rule at :125 and let wildness govern.

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

**Suggested fix:** say which rule wins when they collide. The defensible answer
is that :42 wins — numeric agreement between incomparable protocols is not
evidence of agreement — but then :30 and :62 need "…and the measurements are
methodologically comparable" added, and the quorum check needs a comparability
step before the arithmetic.

---

## 3. `evor-sage-junior.md` — indirect evidence: assert-low or decline?

- **:31** `"low"` confidence is for "only indirect evidence"
- **:42** / **:145** no speculation; do not inflate

On `indirect-evidence-forum` both arms returned `findings: []` rather than a
low-confidence finding sourced to a forum post. :31 implies indirect evidence
should be *reported at low confidence*; the anti-speculation rules imply it
should not be reported at all. The file never says which.

**Effect on the benchmark:** depresses both arms roughly equally (2/3 each).

**Suggested fix:** state the floor. Either name the source classes that are
citable at low confidence, or say explicitly that a non-peer-reviewed source is
never a finding and the angle is reported unresolved.

---

## Cross-cutting note

All three are the same defect class this session has been chasing: **a rule that
is graded but not stated, or stated twice with different answers.** The harness
catches the first shape structurally — `scoreByContract` throws on an
expectation outside the contract. It cannot catch the second, because both
rules really are in the file. That needs a human read, or a lint pass that
looks for two rules writing the same output field.

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

Fix: make the ambiguity intrinsic to a single finding -- one technique, two
sources whose protocols are not comparable -- rather than a property of a pair.

## `evals/sage-junior/spec.json` — two cases sit on agent-file contradictions

See defects 2 and 3 above. `divergence-just-inside` and
`indirect-evidence-forum` are unwinnable as specified because the agent file
answers them twice, differently. Both arms are affected.
