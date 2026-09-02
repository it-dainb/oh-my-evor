# Evor — Marketing Plan & Demo Runbook

> **Purpose:** self-contained handoff for a new session. It captures the demo-task decision,
> the GPU answer, the competitive positioning (with citations), the `/evor-setup` runbook, and
> the remaining TODO (README trees + a real showcase run). Backed by two deep-research passes
> (206 research agents, adversarially verified) + direct inspection of the top competitor repos.

---

## 0. Where things stand (context for a fresh session)

- **Plugin:** `oh-my-evor` — autonomous, multi-agent, **integrity-gated** model-evolution engine, delivered as a Claude Code plugin. Roster: Sage (research) → Mutagen (mutations) → Selector (gate) → Forge (implement+train) → Probe (analyze) → integrity gates → learn (wiki). Runs a from-scratch (or seed-repo) evolution loop, evaluates on a **frozen, hash-sealed, read-only** test split.
- **Released:** **v1.1.0** on `main` (github.com/it-dainb/oh-my-evor), tag `v1.1.0`. This release added: 6 server-side tools (`evor_lock_mission`, `evor_check_stop`, `evor_check_leakage`, `evor_seal_eval_script`, extended `evor_tree_read`/`evor_state_write`); the integrity subsystem (eval-script sealing, validate-gated lock + anchor enforcement, bridge fixes, **reward-hacking false-positive corroboration gate**); ~120 agent-facing internal-mechanism leak fixes; check_stop cost/cold-start fixes; Forge await-terminal-state. Tests: vitest 675, pytest 882.
- **What we learned from the first demo (cats-vs-dogs):** it was a **weak marketing task** — it *saturated* (all models ~99%, "trivially easy" on frozen ImageNet features), the tree showed no arc, and the reward-hacking gate false-positived (now fixed). **Do not demo saturating/frozen-feature toys.** The demo must show an honest baseline→evolved *climb*.

---

## A. What Evor actually is — the full engine (don't sell only the gates)

Tagline: *"Autonomous ML-research evolution engine for Claude Code — that proves its own results are real."* Evor is not a single loop with anti-cheat bolted on; it's a **full autonomous ML research org** of specialist agents, with a learning bus and compounding memory. The 9-step tick loop: **Select → Ideate → Hypothesis-Register → Critique → Implement+Run → Evaluate+Integrity → Analyze+Learn → Record → Prune/Promote**, with a **meta-evolution** pass every N ticks. Sell ALL of this:

| Pillar | What it is | Why it's a differentiator |
|---|---|---|
| 🔬 **Real literature research** | **Sage** (research lead) fans out **Sage-juniors** by angle over **arxiv + Semantic Scholar + HuggingFace** MCPs; returns citation-backed SOTA findings with `implementation_spec` + exact `libraries[]`. **Every SOTA claim carries a source URL — no citation, no claim.** | Proposals trace to real published methods, not guesses. |
| 💭 **The Dreamer** | **Mutagen** is a *divergence-first dreamer* on a wildness dial (0.0 single-param tweak → 0.5 cross-family → 1.0 paradigm shift / cross-domain transfer). It dreams; it never researches (stays anchoring-free). | Not hyperparameter search — genuine idea generation across arch/training/data/algo, tunable from safe to wild. |
| 📡 **Signal bus (learn from the run)** | `signal_emit / query / digest` + `telemetry_ingest`: agents emit signals from **training telemetry** (SOTA bars, opportunities, failures, gotchas); the **signal-bus digest fuels the Dreamer** and steers Selector. This is the "signal to learn from training." | The roster **adapts mid-run** from what training actually did — not a blind fixed loop. |
| 🧠 **Compounding memory** | `wiki_*` + `gotcha_*`: lessons + hard constraints persist **across ticks AND across missions**. A **conditional Sage gate** skips fresh research when the wiki/gotchas already answer the question. | The engine **gets smarter and cheaper over time** (Karpathy-style compounding). |
| 🏗️ **Dev-team implementation** | **Forge** leads a team — *architect* (soundness) + *junior* (writes code) + *critic* (code + integrity review) + *analyst* (compute/OOM risk) — reviewing **in parallel via LSP before a single training hour is spent**, in an isolated git worktree. | Catches broken/OOM/leaky candidates before burning compute; only the junior writes code (clean separation). |
| 🔎 **Telemetry EDA** | **Probe** verifies each hypothesis from the **training curves** (loss curve, gradient health, LR sensitivity, error clustering) — not just the final number. | Understands *why* a candidate worked/failed → better next proposals. |
| 🌳 **Meta-evolution tree search** | UCB1 + crossover + prune tree engine; a meta pass **self-tunes the selection strategy** every N ticks; `tree.json` never deletes a node. | A real evolutionary search that improves *how it searches*, with a complete lineage. |
| 🛡️ **Integrity gates** | **13-check** gate: frozen `chmod 444` splits + hash-seal, test-leakage / label-contamination / near-duplicate / ingestion-contamination detection, reward-hacking probe, monotonic-honesty invariant. | A candidate's score only counts **after it clears the gate** — results are verifiable (see §3). |
| 🔒 **Hook-enforced governance** | A capability governor + always-on **write-guard** make it *structurally impossible* (tool-call layer, not prompt politeness) for any agent to write the evaluator, touch frozen splits, hand-edit run state, or train out of turn. | Enterprise-grade trust — the referee can't be edited. |
| 📊 **Live audit + dashboard** | Immutable `goal-contract.json`, full `decision-log.md`, content-addressed artifacts, provenance, and a **FastAPI + SSE dashboard** (D3 evolution tree, telemetry charts, coverage gauge). | Watch it think in real time; audit every decision after. |
| 📥 **Safe data acquisition** | **Acquirer** fetches/validates/de-dupes/integrates external data, and acquired data must share **zero** samples with the frozen eval split or the node is rejected. | Autonomous data expansion *without* leaking the test set. |

**39 MCP tools** wrap the whole lifecycle; the Python harness (integrity gate, tree engine, signal bus, evaluator, telemetry, dashboard) is reachable **only** through them.

**Elevator pitch (full engine):** *"Evor is an autonomous ML research team in a plugin: it reads the actual literature (Sage), dreams up divergent ideas (Mutagen), gates them (Selector), builds + reviews + trains them with a dev team (Forge), analyzes the training telemetry (Probe), learns from its own signals mid-run and compounds lessons across runs — and every result it reports has cleared a 13-check integrity gate, so the numbers are verifiable."*

---

## 1. DECISION — Demo task: **CIFAR-10** 🏆

Public image benchmark, 10 classes, 50k train / 10k test. Source: <https://www.cs.toronto.edu/~kriz/cifar.html> (MIT-style research use; ships in torchvision).

**Why it wins (all criteria, adversarially verified):**
- **Honest improvement arc:** from-scratch ResNet-110 baseline **~93.6%** (He et al. 2016, CVPR) → SOTA **~99.5%** (Papers-with-Code). Start the demo from a *deliberately simple* CNN (~75-80%) and the on-screen climb is **15-20 points over ticks**. The "CIFAR-10 saturates / bad demo" objection was **refuted 0-3** in verification.
- **Built-in integrity moment:** CIFAR-10 has a **documented 3.3% train/test near-duplicate contamination** (286 pairs — Barz & Denzler 2020, *Journal of Imaging*, arXiv:1902.00423; ciFAIR confirms 3.25%). Evor's `near_dup_leakage` gate **catches the benchmark's own contamination on camera** — the exact leakage every competitor silently absorbs. A legit 94% sits *below* the 0.98 reward-hacking ceiling, so the FP fix won't misfire.
- **Rich branching tree:** the canonical NAS playground — topology/ops/augmentation/optimizer/schedule knobs. Efficient NAS runs full searches in **4-24 GPU-hrs** (ENAS/DARTS/GDAS) → the evolution tree branches richly.
- **Recognizable + credible:** general audiences get "learning to recognize images"; engineers respect the documented baselines/SOTA.
- **Compute:** per-tick **minutes on a consumer GPU**; overnight → hundreds of ticks.

**Backups (CPU-friendly, heavier leakage drama, narrower audience):**
1. **Medical tabular / ICU admission** — temporal leakage: a post-outcome feature (mechanical ventilation) pushes AUC **0.64→0.76** (PMC7880048). The **"runs on a laptop, no GPU"** story.
2. **C-NMC 2019 leukemia** — patient-level leakage inflates AUROC **~0.04** even in frozen-feature settings (arXiv:2606.24944).

**Avoid:** anything that saturates fast (cats-vs-dogs on frozen features), needs huge compute (full ImageNet), or is LLM-only (HumanEval/GSM8K — not a from-scratch training task).

---

## 2. GPU answer (definitive)

**The plugin is hardware-agnostic** — it probes hardware and adapts fp32/CPU/GPU (cats-vs-dogs ran fully on CPU). **Evor does not *require* a GPU.** The *task* decides:

- **CIFAR-10 (flashy visual demo): use ONE GPU.** From-scratch CNNs are ~minutes/tick on an **RTX 3090/4090** → overnight = a rich tree. On CPU they're ~20-40 min/tick — too slow for a compelling tree. No GPU on hand? **Rent an A10/L4/A100 for a few $/hr on Lambda / RunPod / Colab.**
- **Tabular backup: no GPU.** Gradient-boosting / MLP tasks train in seconds-minutes on CPU → the "runs anywhere" pitch.

**Recommendation:** lead with **CIFAR-10 on a single consumer GPU, run overnight** — most marketable *and* reproducible ("came back to a model that beat the baseline, on one 4090, and it provably didn't cheat"). Keep a tabular/CPU run as the "runs anywhere" secondary.

---

## 3. Competitive landscape — a factual comparison (reader decides)

The category is **active and validated** — HuggingFace, funded startups, and research labs are all shipping autonomous-ML agents, which is good for the whole space. Different tools make different, legitimate design choices, and each has real strengths: `ml-intern` — deep HuggingFace-ecosystem integration and a big community; `SIA` — broad task coverage with reported gains and a clean dashboard; `AIDE` — strong published MLE-bench results. The tables below are a **factual capability matrix** (present / absent / partial + traction) so a reader can judge what fits their needs. Evor's design emphasis is **verifiable integrity + research depth**; where a competitor already provides a capability, it's marked ✅.

| Tool | Stars / traction | Frozen eval | **Integrity / anti-gaming** | Audit trail |
|---|---|---|---|---|
| **HF `ml-intern`** | **10.6k★** (huggingface/ml-intern) | ❌ *none mentioned* | ❌ *"no anti-overfitting or anti-leakage"* | ✅ session JSONL to HF Hub |
| **hexo-ai `SIA`** | **2.0k★** (hexolabs, commercial) | ✅ private split | ❌ *"optimizes **directly** against metrics… no frozen protocol"* | ✅ per-generation |
| **Weco `AIDE`** | popular (MLE-bench) | ❌ | ❌ paper admits contamination risk; "only remedy = live submission" | ❌ |
| **Sakana `AI Scientist v2`** | high-profile | ❌ | ❌ zero integrity gates | ❌ |
| **AutoGluon / H2O / FLAML / TPOT** | mature | CV only | ❌ nothing beyond basic CV | partial |
| **AlphaEvolve / FunSearch / OpenEvolve** | DeepMind / OSS | verifier-based (diff. domain) | evaluator-based, not ML-eval integrity | n/a |
| **Evor** | new (v1.1.0) | ✅ **hash-sealed, read-only** | ✅ **leakage + near-dup + label-contamination + reward-hacking probe + monotonic-honesty** | ✅ decision-log + **evolution tree** + provenance |

**Capability matrix — architecture depth.** The tools take different architectural approaches (`ml-intern`: an LLM-tool loop; `SIA`: a 3-agent meta→target→feedback loop; `AIDE`: a solution tree-search). Which capabilities each provides today, as a factual checklist:

| Depth dimension | ml-intern | SIA | AIDE | **Evor** |
|---|---|---|---|---|
| **Cited literature research** (arxiv/Semantic Scholar, source-URL required) | ❌ | ❌ | ❌ | ✅ Sage + juniors |
| **Divergence dial / true idea generation** | partial | partial | tree mutations | ✅ Mutagen (0→1 wildness) |
| **Learns *mid-run* from training telemetry (signal bus)** | ❌ | feedback only | ❌ | ✅ signal bus + Probe EDA |
| **Compounding memory across runs** (wiki + gotchas) | ❌ | ❌ | ❌ | ✅ |
| **Pre-run dev-team review** (architect/critic/analyst before compute) | ❌ | ❌ | ❌ | ✅ Forge team |
| **Meta-evolution** (self-tunes its own search strategy) | ❌ | partial | ❌ | ✅ UCB1 + crossover |

**Why evaluation integrity matters — industry context (cited; not aimed at any competitor):**
- Evaluation integrity is a recognized, active research problem across agentic ML *in general*. Recent studies find reward-hacking behaviors in a meaningful share of agentic-coding trajectories and note the risk tends to grow with model capability (Meta FAIR, arXiv:2507.02554v2). The direction the field is converging on: integrity is best enforced as an **active structural defense**, not assumed.
- Data leakage is well-taxonomized (an 8-type taxonomy — Kapoor & Narayanan 2022, arXiv:2207.07048), yet built-in tooling for it is thin: even the most advanced *patented* commercial leakage defense (IBM US 11,847,544 B2) covers a single sub-type and no split-hashing.
- This is simply *why Evor invests in the gates* — a design priority stated as a fact about Evor, for the reader to weigh. Reported metrics from any tool (including Evor) should be read alongside its evaluation protocol.

**Positioning line (Evor's angle, stated as a fact — not a knock on anyone):**
> "Autonomous ML agents are here and thriving. Evor's particular bet is **depth + verifiable results**: a research team that reads the literature (cited), dreams up divergent ideas, learns from its own training signals mid-run, and compounds lessons across runs — where **every reported score has already cleared a 13-check integrity gate** (hash-sealed frozen splits, leakage / reward-hacking detection, a monotonic-honesty invariant, and a full audit trail). If reproducible, audit-ready results matter to you, that's the reason to look at Evor."

**Fair-play FAQ (answer with facts, credit others):**
- *"Isn't this just AutoML?"* → Different scope. Classic AutoML tunes hyperparameters/pipelines (and does it very well); Evor evolves the model + training code with LLM agents and adds an integrity + audit layer. They can be complementary.
- *"Won't frontier labs / others just add integrity too?"* → Quite possibly, and that'd be good for the field. Evor's head start is that the verifiable-integrity + audit substrate is already built and tested — it's a design priority here, not an afterthought.
- *"Does the gate hurt results?"* → It only lets a score count once it clears the integrity checks, so reported numbers stay reproducible. In the CIFAR-10 demo it surfaces the benchmark's own 3.3% near-duplicate contamination — that transparency is the point.
- *Guiding principle:* let the **numbers and the comparison matrix speak**; present others' reported results fairly and at face value; let the user decide what's best for them.

---

## 4. `/evor-setup` runbook (user's perspective)

**Prereqs:** plugin installed (`/plugin install oh-my-evor` + `./install.sh`); CIFAR-10 in `data/cifar10/` (torchvision download); **one GPU** (owned or rented). Set `EVOR_PYTHON` to your venv python if not default.

**Kickoff message:**
```
/oh-my-evor:evor-setup
I want to evolve an image classifier FROM SCRATCH on the CIFAR-10 dataset in data/cifar10/
(10 classes, 50k train / 10k test). Start from a simple CNN baseline and push test accuracy
as high as it can honestly go. I have one GPU. Run it overnight.
```

**Recommended interview answers (flashy demo):**
| Question | Answer |
|---|---|
| Distill/scan | Skip (fresh dataset) |
| Mode | **From-scratch** (blank PyTorch skeleton — biggest arc) |
| Wildness | **0.5 balanced** (0.7 for a bushier on-camera tree) |
| Mission type | **Fixed** (one frozen test set) |
| Metric | **Accuracy** (balanced 10-class, non-gameable) |
| Target | **Maximize under budget** |
| Budget | **50 ticks, plateau 8** (overnight/GPU → rich tree; 20 for a shorter run) |
| Licenses | Confirm defaults |
| Then | `/evor-run` overnight → `/evor-report` for tree + frontier table |

**Capture for the README:** the `/evor-report` **evolution tree** (baseline → branching → honest winner), the baseline→best **accuracy curve**, and a screenshot of the **integrity gate catching the 3.3% near-duplicate contamination** — that one screen *is* the differentiator.

---

## 5. Remaining TODO (next session)

1. **README hero image** — replace the current image with **both** a `shapes-tree` and an `evor-tree` visualization (more attractive to users/customers). ⚠️ **Debate the visual direction with the user first** (style, whether side-by-side or one hero + one supporting, dark/light, whether to annotate the integrity-rejected nodes). Tree images come from `/evor-report` (graphviz/HTML export) — may need to generate fresh ones from a real run.
2. **Run the real CIFAR-10 showcase** (needs a GPU box — the test container was CPU-only). Produce: the evolution tree, the baseline→best curve, and the integrity-catch screenshot. Keep it honest (that's the whole point).
   - ✅ **Data prepared + mission set up & locked** on the CPU container (`cifar10-classification-2026-07`): from-scratch PyTorch, fixed, top-1 accuracy, baseline 0.10→maximize, 50 ticks, wildness 0.5. Phase-2 validation **VALID (17/17 checks)**; both integrity anchors sealed (`locked_split_hash`, `eval_script_hash`); frozen-test label recovery **8000/8000 exact**.
   - ✅ **Real from-scratch baseline measured** (sealed evaluator, standalone, sealed 8k frozen test): a tiny CNN (4k imgs, 3 epochs, no augment) = **38.5% top-1 in 68 s on CPU** — ~4× random, all easy levers untouched. Headroom to ~80–90% is real (CIFAR-10 does not saturate).
   - 📦 **Deliverables in scratchpad:** `prep_cifar10_hf.py` (HF-CDN prep, ~12s), `CIFAR10_GPU_RUNBOOK.md` (turnkey GPU steps + the 14 locked answers + genome surface), `cifar10_evaluator_v1.py` (sealed evaluator reference).
   - ⚠️ **GPU note:** set up *fresh on the GPU box* — the sealed CPU evaluator has no CUDA path and can't be edited. Tell the setup agent "this box has CUDA; move model+batches to cuda; default train_subset=0 (all 45k)".
   - 🔧 **Two setup-flow findings for maintainers** (recovered live, but should be fixed in source): (a) freeze runs before init_run → contract written anchor-less; (b) no auto-authored image-classification evaluator to seal. Details in the runbook appendix.
3. **Update README with the real results** + the competitive positioning (section 3) + the moat line + the pitch. Fold in `ml-intern` / `SIA` comparison as proof the category is validated but ungated.
4. Optional: package sections 1-3 as a polished strategy artifact / one-pager for investors.

---

## 6. Key citations
- CIFAR-10 baseline: He et al. 2016, *Deep Residual Learning* (CVPR). SOTA: Papers-with-Code CIFAR-10 leaderboard.
- CIFAR-10 near-dup 3.3%: Barz & Denzler 2020, arXiv:1902.00423; ciFAIR (cvjena.github.io/cifair).
- Consumer-GPU feasibility: Jordan 2024, arXiv:2404.00498 (A100 timings; ~3-5× consumer overhead).
- NAS search space / cost: automl.org/nas-overview; Pham et al. ICML 2018 (ENAS); Dong & Yang CVPR 2019 (GDAS, 4 GPU-hrs).
- Leakage taxonomy: Kapoor & Narayanan 2022, arXiv:2207.07048. Commercial art: IBM US Patent 11,847,544 B2.
- Reward hacking prevalence/scaling: Meta FAIR, arXiv:2507.02554v2 (also documents AIDE val→test gap 16.6pp).
- Temporal leakage (tabular): PMC7880048 (COVID ICU). Patient-level leakage: arXiv:2606.24944 (C-NMC).
- Competitors (direct): github.com/huggingface/ml-intern (10.6k★), github.com/hexo-ai/sia (2.0k★, hexolabs.com), github.com/WecoAI/aideml (arXiv:2502.13138), github.com/sakanaai/ai-scientist-v2 (arXiv:2504.08066).
