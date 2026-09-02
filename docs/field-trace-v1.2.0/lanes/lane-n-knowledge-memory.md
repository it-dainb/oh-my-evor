# Lane N — Knowledge Accumulation & Citation Integrity (Wave 1 inventory)

Read-only. Nothing modified.

## VERDICT

**Knowledge DID compound across r1 -> r2 -> r3 — but almost entirely through channels
outside the evor knowledge system.** The lane hypothesis ("every restart began from zero")
is **not supported**. Concretely:

- The **global gotcha store carried perfectly**: five separate r3 agents each retrieved all
  15 global gotchas written during r1 and r2 (`total=15, returned=15`). Cross-mission gotcha
  persistence works exactly as `gotcha.ts` documents it.
- The **tick-close handoff was consumed**: r2's `handoffs/1-1.json` `next_tick_seed` named
  four actions; r3 performed three of them (built a genuine IIR-recurrence sibling; fixed GPU
  latency 81.4ms -> 74.85ms; fixed the data-loader leakage — `no_test_leakage` went
  `false` in r2 -> `true` in r3).
- **No r1 or r2 failure recurred in r3.** The inverted-GT-polarity failure and the
  latency-gate failure were each fixed and did not repeat. There is no "same mistake twice"
  headline in this lane.

The load-bearing carrier, however, was the **hand-written `objective` string in each new
mission's goal contract**, not the wiki. r2's objective opens "MEASURED CONTEXT (this
supersedes earlier repo claims)" and restates the polarity discovery; r3's opens "MEASURED
FACTS FROM TICK 1 (do not re-derive)" and enumerates six findings plus an explicit "OPEN
HYPOTHESIS". That is a human (or orchestrator) manually re-typing the previous run's lessons
into free text. The compounding is real but **not machine-mediated and not durable** — it
depends on someone transcribing correctly at each restart, and it leaves the structured
stores as a largely decorative side channel.

The genuine defects are therefore not "nothing was learned" but: **the citation tool records
nothing at all, two of the highest-value lessons were silently mangled and one overwrote the
other, and one stale full-confidence gotcha survived its own invalidation and demonstrably
caused a bad decision in r3.**

## CITATION TALLY

**17 VERIFIED / 3 MISATTRIBUTED / 0 UNVERIFIABLE / 0 FABRICATED, out of 20 sampled.**

Verification method: arXiv abstract pages (`citation_title`/`citation_author` meta tags),
Crossref REST API (`api.crossref.org/works/{doi}`), Semantic Scholar Graph API for
abstracts, and `doi.org` HTTP resolution. Claim-level support checked against abstracts
where obtainable.

| # | Identifier | Claimed as | Actual | Class |
|---|---|---|---|---|
| 1 | doi 10.1109/ACCESS.2026.3681411 | IIR-BinNet, 90.37 F H-DIBCO2018, 49K params, 40x < U-Net | *IIR-BinNet: An Ultra-Lightweight NN for Document Image Binarization Using IIR Filters*, Ershova/Gayer/Arlazarov, IEEE Access 2026. Abstract states **49K params, "at least 40 times smaller than U-Net", F-measure 90.37% on H-DIBCO 2018 vs 89.36% U-Net baseline** | **VERIFIED** (exact, incl. numbers) |
| 2 | arXiv 2407.11087 | Restore-RWKV Re-WKV recurrent scan | *Restore-RWKV: Efficient and Effective Medical Image Restoration with RWKV*, Yang & Li | VERIFIED |
| 3 | arXiv 1505.00393 | ReNet four-directional RNN | *ReNet: A RNN Based Alternative to Convolutional Networks*, Visin & Kastner | VERIFIED |
| 4 | arXiv 2312.00752 | Mamba selective SSM as learnable IIR | *Mamba: Linear-Time Sequence Modeling with Selective State Spaces*, Gu & Dao | VERIFIED |
| 5 | arXiv 1911.08731 | Sagawa et al. 2019 GroupDRO | *Distributionally Robust Neural Networks for Group Shifts...*, Sagawa, Koh | VERIFIED (incl. the "strong regularization required" caveat the wiki repeats) |
| 6 | arXiv 2311.00476 | Vilouras et al. 2023, group DRO | *Group Distributionally Robust Knowledge Distillation*, Vilouras, Liu | VERIFIED |
| 7 | arXiv 1708.03276 | Tensmeyer & Martinez 2017 FCN binarization | *Document Image Binarization with Fully Convolutional Neural Networks* | VERIFIED |
| 8 | arXiv 2101.11674 | LS-HDIB synthetic degradation dataset | *LS-HDIB: A Large Scale Handwritten Document Image Binarization Dataset*, Sadekar, Tiwari | VERIFIED |
| 9 | arXiv 1805.06085 | PACT learned clipping W4A4 | *PACT: Parameterized Clipping Activation for Quantized Neural Networks*, Choi, Wang | VERIFIED |
| 10 | arXiv 2401.09417 | Vision Mamba bidirectional SSM | *Vision Mamba: ... Bidirectional State Space Model*, Zhu, Liao | VERIFIED |
| 11 | arXiv 2208.14558 | Augraphy document augmentation | *Augraphy: A Data Augmentation Library for Document Images*, Groleau, Chee | VERIFIED |
| 12 | arXiv 1810.11120 | adversarial noise-texture augmentation | *Improving Document Binarization via Adversarial Noise-Texture Augmentation*, Bhunia | VERIFIED |
| 13 | arXiv 2606.08781 | Mamba binarization | *DeepMine-Mamba: ... for Document Image Binarization*, Chan, Wang | VERIFIED |
| 14 | arXiv 2606.22625 | Mamba domain adaptation binarization | *DR-Mamba: Automatic Inference-Time Domain Adaptation for Document Image Binarization* | VERIFIED |
| 15 | doi 10.23919/indiacom70271.2026.11526120 | CBAM attention on Kannada palm-leaf | *Synthetic Palm-Leaf Manuscript Generation with Attention-Driven Deep Learning Models*, IndiaCom 2026. Abstract explicitly: attention-guided ResNet autoencoder **combining residual learning with CBAM to focus on engraved strokes while ignoring palm-leaf background texture**, 1,350 Kannada manuscripts | VERIFIED (claim genuinely supported) |
| 16 | doi 10.3390/heritage8080337 | Balinese palm-leaf binarization | *A Benchmark Study of Classical and U-Net ResNet34 Methods for Binarization of Balinese Palm...*, Heritage 2025 | VERIFIED |
| 17 | doi 10.1186/s40494-023-01125-w | Sanskrit palm-leaf | *Automatic damage identification of Sanskrit palm leaf manuscripts with SegFormer*, Heritage Science 2024 | VERIFIED |
| 18 | **arXiv 2006.05595** | **CBAM (channel+spatial attention) for palm-leaf stroke focus** | **`Fitted Q-Learning for Relational Domains`, Das & Natarajan — a relational reinforcement-learning paper with no connection to attention, vision, or binarization.** CBAM's real identifier is arXiv 1807.06521 (Woo et al., ECCV 2018) | **MISATTRIBUTED** |
| 19 | **doi 10.1145/3805622.3810631** | **"Topology-aware connectivity loss ... skeleton consistency ... implement via skeleton extraction + InfoNCE contrastive loss, w_connectivity 0.5-1.0"** | **`ICSGDiff: A Multimodal Structure-Aware Diffusion Network for Restoring Ancient Bamboo Slips`. Abstract describes an Infrared Character Structure Extraction Module + conditional diffusion Character Reconstruction Module. It contains no topology/connectivity loss, no skeleton-consistency loss, and no InfoNCE. Its structure signal comes from an infrared imaging modality this mission does not have.** | **MISATTRIBUTED** (paper real; does not support the claim) |
| 20 | **doi 10.1109/ICFHR.2016.39** | ICFHR 2016 palm-leaf dataset | **Does not resolve — `doi.org` returns HTTP 404; absent from Crossref.** The underlying work (ICFHR2016 Balinese palm-leaf competition) plausibly exists, but this identifier does not | **MISATTRIBUTED** (invalid identifier) |

**Zero FABRICATED and zero UNVERIFIABLE.** Every paper the system named turned out to be a
real, locatable publication — including the four 2026-dated ones, which I specifically
checked for hallucination and which all exist. The failure mode here is not invented
literature; it is **correct claims wired to the wrong identifier**.

### Separate class: real citation, invented number (not a citation-existence defect)

`wiki/lightweight-iir-filters-sota.md` cites IIR-BinNet correctly, then appends an
"Actionable Lesson" the paper does not contain:

> "IIR filters enable global context with <50K parameters, fitting within 10GB VRAM and
> **GPU latency <10ms for 4k images**."

The IIR-BinNet abstract makes no 4k claim and no latency claim of any kind — it is a
parameter-count and F-measure paper evaluated on DIBCO 2017 / H-DIBCO 2018 pages. The
"<10ms at 4k" figure was manufactured to match r1's `latency_gpu_ms < 10` contract gate. It
is the single most expensive sentence in the knowledge base: it is cited 23 times across the
tree, and it seeded the architecture program that consumed r2 and r3, both of which
falsified it (r2 iir-binnet-01: 81.4 ms; r3 iir-scan-binnet-02: 74.85 ms — 7-8x over the
claim). Nothing in the store ever corrected it.

## FINDINGS

### N-01 — BLOCKER — CITATION-INTEGRITY
`wiki/topology-connectivity-loss-stroke-preservation.md` attributes a topology/skeleton
connectivity loss with concrete hyperparameters (`InfoNCE`, `w_connectivity 0.5-1.0`) to
`doi 10.1145/3805622.3810631`, which is ICSGDiff — an **infrared-guided conditional diffusion
restoration network** containing no such loss. The prescribed mechanism is unimplementable as
described, and the paper's actual mechanism depends on an infrared modality the corpus lacks.
This entry was live: r3's wiki_query "topology skeleton loss stroke continuity binarization"
returned 5 lessons including this one. Wave-2: was a topology/connectivity loss ever actually
implemented from this entry, and did any node's loss function inherit these invented
hyperparameters?

### N-02 — BLOCKER — CITATION-INTEGRITY / MEMORY-CONTRADICTION
`wiki/lightweight-iir-filters-sota.md` extends a correctly-cited paper with a fabricated
performance claim ("GPU latency <10ms for 4k images") that the source never makes; the claim
was empirically refuted twice (81.4 ms, 74.85 ms) and never retracted or superseded in the
wiki. `verdict: confirmed` still stands on the entry today. Wave-2: does `evor_wiki_add` have
any mechanism to mark an entry refuted or superseded, and is `verdict` ever revised after
contradicting evidence?

### N-03 — BLOCKER — KNOWLEDGE-WRITE-FAILURE
**`evor_cite` landed 0 of 18 calls.** 16 returned `{"ok":false,"error":"node '...' not found
in this run's tree"}` **inside a `is_error=false` success envelope**, so the calling agents
received no error signal and never retried; 2 more hard-failed on schema (agents sent
`citations: "[...]"`, a JSON-encoded array, against a scalar `citation: string`). Root cause
is structural, not incidental: `cite.ts` resolves `node_id` through `resolveNodeRef` against
`tree.json`, but every caller was a **sage-junior research role citing its own angle slug**
(`genuine-iir-mechanisms`, `palm-leaf-dataset-acquisition`,
`sage-junior-quant-aware-training-4k`, `progressive-training-domain-weighting`) — and Sage
runs *before* any tree node exists (r3's tree had zero nodes at that point). The research
role can therefore never satisfy this tool. The "citation-backed mandate" is unenforced; the
citations that do appear on nodes and in wiki entries arrived via other write paths. Note the
irony: `cite.ts` carries a comment explaining that a *previous* identical triple-failure was
fixed by making `run_id` optional — the same class of defect on `node_id` was left. Wave-2:
should `evor_cite` accept angle slugs / pending nodes, and why does an embedded `ok:false`
not set `is_error`?

### N-04 — HIGH — CITATION-INTEGRITY
`wiki/cbam-attention-palm-leaf-focus.md` and r1 tree node `multiscale-stroke-gate-01` both
cite **arXiv 2006.05595 for CBAM**, which is *Fitted Q-Learning for Relational Domains* — an
RL paper. The correct supporting source for the claim actually existed in the same junior's
`other_findings` (`doi 10.23919/indiacom70271.2026.11526120`, verified above) but was not the
one promoted to the wiki entry. An architecture prescription ("insert CBAM blocks, channel
ratio=16, spatial kernel=7") is thus backed by an unrelated paper. Wave-2: is there any URL
resolution/validation step between a junior finding and `evor_wiki_add`? The junior that
emitted an `urls_verified` field self-asserted `true`.

### N-05 — HIGH — LEARNING-LOSS / KNOWLEDGE-WRITE-FAILURE
**`evor_wiki_add` accepts an entry with no `lesson_id` and silently writes it to
`<wiki_root>/.md`.** This happened to the two most valuable lessons in the system — r1's
tick-1 lesson (evaluator domain-mapping defect, GT polarity inversion, the all-ones-predictor
gameability floor of 92.32) and r2's tick-1 lesson (GPU-latency dominance, precision floor,
test leakage). Both wrote to the same path. Verified by hash: project-level
`.evor/wiki/.md` (md5 `abcd80fb…`) is byte-identical to r2's run copy, while r1's run copy
(md5 `3df86225…`) differs — **r2 overwrote r1's lesson at the project level**. `index.jsonl`
now holds two rows with `lesson_id: ""`. Both lessons are unaddressable by name and only one
survives project-side. Neither was ever retrieved by any subsequent `evor_wiki_query`.
Wave-2: make `lesson_id` required, or derive it; and audit `index.jsonl` for other empty-id
rows across missions.

### N-06 — HIGH — MEMORY-CONTRADICTION (stale knowledge with demonstrated cost)
Gotcha `cpu-4k-latency-gate-requires-lt-3kmac-per-pixel` (**confidence 1.0**) encodes
`gate: cpu_4k_latency_s < 0.1` and derives a "budget ~1-3 kMAC/px" screening rule. Verified
against the goal contracts: that was r1's gate; **r3's contract relaxed it to
`latency_cpu_4k_s < 1` and `latency_gpu_ms < 500`** — 10x and 50x looser. r2's own objective
had already superseded the budget ("CPU<1s@4k gate implies roughly a 6 kMAC/px budget") and
r2's and r3's lessons both state flatly that kMAC/px is a poor predictor. The gotcha was
never revised, downgraded, or invalidated, and it was **retrieved verbatim by five separate
r3 agents**. The consequence is documented in r3's own wiki entry and probe findings: the
Selector rejected proposals h003 (palm-leaf synthetic degradation) and h004 (hard-example
acquisition) — *the two proposals aimed at the actual bottleneck* — for "lacking kMAC/px-style
cost estimates," under a contract with 15x GPU and 1.6x CPU headroom. r3's own lesson calls
this "a selection error." **This is the clearest instance in the lane of stale stored
knowledge actively causing a wrong decision.** Wave-2: gotchas have `occurrences` and
`confidence` that only ever ratchet up — is there any decay, contradiction, or
supersede-by-contract-change path at all?

### N-07 — MEDIUM — KNOWLEDGE-WRITE-FAILURE (haiku mangled-prefix cost)
Of the mangled-prefix rejections, exactly one destroyed unique knowledge. At
`2026-08-23T08:58:32`, agent `aeafb73a` called
`mcp__plugin_oh-my_evor_evor__evor_wiki_add` (mangled) with lesson
`palm-leaf-bottleneck-illumination-preprocessing` — content: illumination normalization
`I_norm = I / Gaussian_blur(I)` plus contrast-adaptive thresholding (C=-0.5) for shadow,
uneven lighting and faint text on palm-leaf. Rejected with "No such tool available", and
**never retried** — the same agent's three neighbouring calls at 08:58:24/28/34 used the
correct prefix and landed. This was the only wiki entry ever authored about *preprocessing*
for palm-leaf, the domain that went on to be the binding constraint in all three missions
(r3 min-domain F 3.527% on palmleaf_khmer). Judgement: **genuinely valuable and genuinely
lost.** The other mangled calls were recoverable — `evor-selector`'s `evor_gotcha_query`
retried successfully 13 seconds later, and `evor-probe`'s two `evor_signal_emit` payloads
(data-bottleneck-palm-leaf-370pages; selector-misaligned-criteria-data-family) survive
verbatim in the r3 wiki entry and probe findings. Net unique loss from the haiku defect:
1 wiki entry, 0 gotchas, 0 signals.

### N-08 — MEDIUM — LEARNING-LOSS (mission-scope is a knowledge trap)
r1 wrote 5 gotchas with `scope: "mission"` — `dense-unet-cannot-meet-cpu-4k-100ms-gate`,
`cpu-4k-latency-gate-implies-hard-macs-per-pixel-budget`,
`sealed-evaluator-v1-label-domains-fails-on-v10`,
`cpu-4k-100ms-gate-implies-3kmac-per-pixel-ceiling`,
`gpu-10ms-4k-gate-also-unreachable-for-dense-unet`. These live only in
`runs/binarization-worldmodel-min98-2026-08/run-live-01/gotchas/mission.jsonl` and are
**invisible to r2 and r3** (every r3 query returned `total=15` — global only). Three of the
five happen to duplicate a global-scoped twin, so little was truly lost, but the same agent
in the same session chose `mission` and `global` inconsistently for equivalent facts within
~4 minutes. r2 and r3 wrote no mission-scoped gotchas at all (no `gotchas/` directory
exists in either run). Wave-2: what guidance does the tick prompt give on scope selection?

### N-09 — MEDIUM — WIKI-EFFECTIVENESS (the wiki-resolution short-circuit is disabled)
r3's `handoffs/1-0.json` carries `"gate": "full_scope"` with
`"gate_reason": "wildness=1.0 (>=0.7 threshold) forces full-scope Sage regardless of wiki
resolution"`. So the design *has* a mechanism to skip research the wiki already answers, and
`wildness=1.0` (set identically in all three contracts) unconditionally disables it. Result:
**4 of r3's 8 sage investigation queries re-researched topics already in the project wiki** —
queries 1-2 (IIR mechanisms) vs `lightweight-iir-filters-sota`, queries 3-4 (GroupDRO) vs
`groupdro-domain-weighted-loss-worst-case`, query 7 (skeleton/topology loss) vs
`topology-connectivity-loss-stroke-preservation`. The wiki was consulted (34 `evor_wiki_query`
calls, all succeeded) but its hits could not shorten the work. Only one junior recorded a
`wiki_hit` (`genuine-iir-mechanisms` -> `lightweight-iir-filters-sota`), and it still ran the
full literature search. Wave-2: has `wildness` ever been below 0.7 in a real mission — i.e.
is the wiki-resolution gate dead code in practice?

### N-10 — MEDIUM — GOTCHA-EFFECTIVENESS (default threshold hides low-confidence gotchas)
`private-dataloader-test-leakage-iir-binnet-01` was stored at `confidence: 0.5`. Every r3
`evor_gotcha_query` used `min_confidence` 0.6 or 0.8, so this gotcha was **filtered out of
all five r3 retrievals** (`total=15`, not 17). The leakage was fixed anyway
(`no_test_leakage` true in r3) — but via r2's handoff `next_tick_seed` prose, not the gotcha
store. An unresolved defect ("Not yet resolved — audit data/builder.py…") is exactly the kind
of entry that should surface, and low confidence in a *not-yet-diagnosed* problem makes it
less visible rather than more. Wave-2: should unresolved gotchas be exempt from the
confidence floor?

### N-11 — MEDIUM — GOTCHA-EFFECTIVENESS (one positive, and it is worth preserving)
The only demonstrable case of stored knowledge preventing a repeat: gotcha
`true-iir-sequential-scan-slower-than-pooled-context-on-dispatch-bound-cpu`
(`kind: approach-deadend`) advises "if IIR recurrence is genuinely wanted, it needs a
fused/vectorised kernel (custom op, torch.compile, or **an associative-scan formulation**),
not a per-step loop." It was retrieved by all five r3 queries, and r3 implemented exactly
that — "learnable poles, **Hillis-Steele associative scan**, 4-direction coupling" — clearing
the GPU gate at 74.85 ms where r2's approach had failed at 81.4 ms. The mechanism was then
verified genuine and the hypothesis cleanly refuted. This is the compounding loop working as
designed, once, out of 17 stored gotchas. Wave-2: confirm from the forge transcript whether
the gotcha or the r3 objective text was the proximate cause.

### N-12 — LOW — HANDOFF-CONTINUITY (fields written but never read)
Handoff `1-1.json` (r2 and r3) writes `best_score: null`, `best_node_name: null`,
`frontier_size: 0` and `strategy_state {wildness, selection_policy: "ucb1",
meta_iteration: 0}`. With zero promoted nodes in any mission these carry no information, and
`selection_policy: "ucb1"` is inert with an empty frontier. The only field with demonstrated
downstream effect is the free-text `next_tick_seed`. r1 produced **no `1-1.json` at all** —
its tick never closed — so the r1 -> r2 hop had no structured handoff whatsoever, which is
why r1's polarity finding had to travel by hand-written objective text. `lessons` carries
only a lesson *name*, and for r2 that name (`iir-binnet-01 gpu-latency+precision-floor+
test-leakage`) does not match any retrievable `lesson_id` — the entry it points at is the
empty-id `.md` of N-05, so the pointer is dangling. Wave-2: is `lessons[]` ever resolved
back to wiki entries by the receiver?

### N-13 — LOW — MEMORY-CONTRADICTION (repeat that the store could not have prevented)
`telemetry_sane: false` recurs in both r2 and r3 integrity checks (alongside
`near_dup_leakage` and `reward_hacking_probe`, which are `false` in both — see sibling lanes
on the always-fail-together harness bug). The explanatory gotcha
`telemetry-sane-check-reads-stale-summary-not-jsonl` was only written at
`2026-08-24T01:56`, *after* r3's evaluation, so no retrieval could have prevented the repeat.
Recording this as a non-finding for the knowledge system: correct behaviour, bad timing.

## CATEGORIES WITH ZERO HITS (named explicitly, per brief)

- **FABRICATED citations: ZERO.** Every one of the 20 sampled identifiers names a real,
  locatable publication, including all four 2026-dated papers, which I checked specifically
  for hallucination.
- **UNVERIFIABLE citations: ZERO.** All 20 resolved to a definite verdict; none were
  "could not find".
- **LEARNING-LOSS of the recurring-mistake kind: ZERO.** No r1 or r2 failure repeated in r3.
  The polarity inversion, the latency gates, and the data leakage were each fixed once and
  stayed fixed. This directly contradicts the lane's seed hypothesis.
- **Wiki entries that are pure generic restatement: ZERO.** All 6 entries are specific and
  numeric. On WIKI-QUALITY the count is 5 of 6 actionable enough to change a future decision
  (`iir-scan-binnet-02-tick1` is outstanding — it names a refuted hypothesis, a
  do-not-re-test instruction, and a concrete selector-policy fix); the sixth
  (empty-id `.md`) is unaddressable rather than noisy. The wiki's defect is **accuracy and
  addressability, not verbosity**.

## SUPPORTING COUNTS

Knowledge-tool call outcomes across the parent transcript + 194 subagent transcripts:

| tool | landed | embedded `ok:false` | hard error |
|---|---|---|---|
| `evor_wiki_query` | 34 | 0 | 0 |
| `evor_gotcha_add` | 18 | 2 | 1 |
| `evor_gotcha_query` | 10 | 9* | 1 |
| `evor_wiki_add` | 7 | 0 | 2 |
| `evor_cite` | **0** | **16** | **2** |

\* All 9 `gotcha_query` empties are **legitimate, not a retrieval bug**: each was a
`kind=runtime-failure` query issued between 08:56 and 09:06 on 2026-08-23, and the first
runtime-failure gotcha was not written until 09:12:21. Timing verified against the
transcript. Similarly the four `count:0` wiki queries at 08:58 preceded the first
`wiki_add`. I checked this specifically to avoid reporting a false defect.

Artifacts of record:
- `/home/dainb_1/research/binarization/.evor/wiki/` — 5 named entries + `.md` + `index.jsonl`
- `/home/dainb_1/research/binarization/.evor/wiki/gotchas/global.jsonl` — 17 entries
- `/home/dainb_1/research/binarization/.evor/runs/binarization-worldmodel-min98-2026-08/run-live-01/gotchas/mission.jsonl` — 5 orphaned mission-scoped entries
- `/home/dainb_1/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/mcp/src/tools/{cite,wiki,gotcha}.ts` — contracts
