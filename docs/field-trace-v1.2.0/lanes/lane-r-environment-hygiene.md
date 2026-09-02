# Lane R — Environment, Dependencies & Secret Hygiene (Wave 1 inventory)

Read-only defensive review of the user's own autonomous-research rig.
Scope: PROJECT `/home/dainb_1/research/binarization`, PLUGIN
`/home/dainb_1/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/`,
LOGS `/home/dainb_1/.claude/projects/-home-dainb-1-research-binarization/`
(115 transcript/tool-result files, 36 MB, 194 subagent transcripts).

**All secret values redacted to first 4 chars + length. Nothing was modified.**

---

## Headline

- **1 live-looking credential exposed**, in 2 places at once: on disk in
  `~/.claude/settings.json` *and* echoed 15 times across 2 conversation
  transcripts that were transmitted to the API.
- **4 environment/harness-caused failures** identified (not agent-behaviour
  failures): a read-only-file `PermissionError`, background-job kills at
  subagent turn end, a `sys.path` cwd bug, and a capability profile that
  overstates available VRAM by ~2x.
- **Blast radius outside the project dir**: 4 distinct destinations —
  `/tmp` (session scratchpad + 6 loose files), `~/.claude/settings.json`,
  `~/.claude/projects/.../memory/`, and **the plugin cache itself**
  (source files edited in place + 13 `.bak` files + a whole `.evor/` run tree).
  No `sudo`. No writes outside `$HOME` and `/tmp`.
- **Reproducibility: not achievable.** The project is **not a git repository
  at all**, and no dependency versions are pinned.

---

## PART 1 — Secret exposure

### R-01 — BLOCKER — Live Semantic Scholar API key, exposed twice

| | |
|---|---|
| Value | `s2k-2clW…` — 44 chars total, remaining 40 redacted |
| On disk | `/home/dainb_1/.claude/settings.json` → `.env.SEMANTIC_SCHOLAR_API_KEY` (file mode `0600`, so filesystem exposure is contained) |
| In transcripts | `…/8289a9d7-dedd-4aeb-a1af-0efd2bbb45fb.jsonl` (8 occurrences) and `…/8289a9d7-…/subagents/agent-aa183a76c0e0d9edd.jsonl` (7 occurrences) |

How it got there: the **user pasted the key as a raw prompt** — the transcript
carries it verbatim in a `lastPrompt` field:
`"S2 API Key: s2k-… Rate limit: 1 request per second…"`. A subagent was then
tasked with writing it into `settings.json`, which it did (2 `Edit` calls to
that path).

Why this is a BLOCKER rather than a config note: the key is in conversation
history, so it (a) was transmitted to the API as message content, (b) is
replayed into context on every session resume of that project, and (c) sits in
plaintext `.jsonl` on disk indefinitely. Redacting `settings.json` alone does
not undo any of that.

Note the plugin's own tooling behaves correctly here — its status output
reports `"api_key_preview": "s2k-…nCyi"`, already truncated. The leak is
entirely in the human-paste path, not in the plugin.

**Action: rotate the key at semanticscholar.org. Then scrub the two `.jsonl`
files and re-supply the new key via an env var the agent never has to see.**

### Categories checked with ZERO hits (this is the expected, good result)

Scanned all 115 transcript + tool-result files for:

| Category | Result |
|---|---|
| `sk-ant-…` / `sk-…` (Anthropic/OpenAI) | **none** |
| `hf_…` (HuggingFace tokens) | **none** |
| `ghp_` / `gho_` / `github_pat_` | **none** |
| `AKIA…` (AWS), `AIza…` (GCP) | **none** |
| `xoxb/xoxp/…` (Slack) | **none** |
| `-----BEGIN … PRIVATE KEY-----` | **none** |
| JWTs (`eyJ….….…`) | **none** |
| wandb API key | **none** — wandb ran in **offline** mode (`wandb/offline-run-20260726_123508-qaviwq7o`); no `~/.netrc`, no `~/.config/wandb` |
| `VAR=secret` env assignments | **none** — the only `export`s are `EVOR_TELEMETRY_PATH`, `EVOR_RUN_ID`, `EVOR_NODE_ID`, `WANDB_MODE`, `PYTORCH_CUDA_ALLOC_CONF` |
| `.env` / `.pem` / `.key` / `id_rsa` / `credentials` read by an agent | **none** — no such file exists in the project, and no agent read one |
| DB connection URLs | **none** |

A scan for 40-hex strings returned 231 unique matches; **all were verified as
Semantic Scholar `paper_id` values**, not wandb keys. Not a finding.

### R-14 — LOW — HF MCP sends an empty bearer token

`PLUGIN/.mcp.json` declares `hf-mcp` as an HTTP MCP to `https://huggingface.co/mcp`
with `"Authorization": "Bearer ${user_config.hf_token}"`. No `hf_token` is
configured anywhere, and the transcripts confirm the server's own warning:
*"The Hugging Face tools are being used anonymously and rate limits apply."*
So a malformed `Bearer ` header goes out on each call. Used 4 times
(`hub_repo_search`) — search queries only, no data uploaded.
Correct on the secret-hygiene axis: **no hardcoded token in `.mcp.json`.**

### `install.sh` review — clean

No hardcoded secrets. `set -euo pipefail`. No `curl | bash`, no remote fetch of
executable content — it builds locally from the repo (`npm ci`, `npm run build`,
`pip install -e ./harness`) and prewarms two Python MCP venvs from named PyPI
packages. Prereqs are checked before use. No finding.

### R-02 — BLOCKER — The project is not a git repository; `.gitignore` is inert

```
$ git -C /home/dainb_1/research/binarization rev-parse --is-inside-work-tree
fatal: not a git repository (or any of the parent directories): .git
```

The brief asked whether `git add -A` would sweep up operational state. It
cannot, because there is no repo. The `.gitignore` present is decorative — and
it is also *insufficient*, which matters the moment someone runs `git init`:

| Path | Would be ignored? |
|---|---|
| `.evor/` (run state, frozen splits, node weights) | **NOT ignored** |
| `.omc/` (OMC runtime state) | **NOT ignored** |
| `wandb/` | **NOT ignored** |
| `.deps/` (vendored packages) | **NOT ignored** |
| `*.log` (`err.log`, `base_*_err.log`) | **NOT ignored** |
| `.semantic_scholar_mcp/` (cached PDFs, memories) | **NOT ignored** |
| `.claude/settings.local.json` | **NOT ignored** |
| `champion_telemetry.json` | **NOT ignored** |

The project `.gitignore` covers only `__pycache__/`, `*.py[cod]`, `*.egg-info/`,
`.pytest_cache/`, `.ipynb_checkpoints/`, `outputs/`, `data/`, `lightning_logs/`,
`*.ckpt`. Contrast the **plugin's** `.gitignore`, which is thorough and
explicitly ignores `.evor/.env`, `.evor/.deps-ok`, `.omc/state/`, `.evor/runs/`
and `**/.omc/`. The plugin knows what needs ignoring; the project has not
inherited it.

Beyond hygiene, the absence of git is the deeper problem — see R-03.

---

## PART 2 — Environment & dependency fragility

### R-03 — BLOCKER — Runs are not reproducible

Four independent gaps, any one of which alone would block reproduction:

1. **No version control** (R-02). There is no commit, no diff, no revert point
   for 19 hours of autonomous edits to a research codebase.
2. **No dependency pinning.** `pyproject.toml` uses only lower bounds —
   `torch>=2.1`, `lightning>=2.2`, `torchmetrics>=1.0`, `pydantic>=2.5`,
   `numpy>=1.24`, `opencv-python>=4.8` — with no upper bounds and no lockfile.
   `deploy/requirements.txt` is likewise all `>=`.
3. **Training ran from a shared, unversioned interpreter.** Tracebacks resolve
   to `/opt/conda/envs/shared-base/lib/python3.*`, a machine-wide conda env
   outside the project. It is not captured, exported, or pinned. `.deps/`
   contains only numpy/onnx/sympy/protobuf/ml_dtypes — **no torch** — so
   `.deps/` is not the training environment either.
4. **No hardware pin.** `capability.json` is a probe output, not a constraint;
   nothing fails if the next run lands on different silicon.

Seeding is the one bright spot: `seed: 42` is recorded for the frozen splits,
and the frozen test/val splits are materialised on disk under
`.evor/runs/*/run-live-01/frozen-splits/`. But a fixed data split does not make
a run reproducible when the framework version and interpreter are unpinned.

For a project whose stated purpose is autonomous *research*, results that cannot
be regenerated are not results yet.

### R-07 — HIGH — `.deps-ok` verifies nothing, and is in the wrong directory

The dependency-readiness sentinel is
`PLUGIN/.evor/.deps-ok`, and its entire content is:

```
2026-08-23T03:53:19.779Z
```

A bare timestamp — 24 bytes. It records no package list, no version set, no
interpreter path, no hash of anything. Consequences:

- It **cannot fail** once written. It was written once at 03:53 on Aug 23 and
  never revalidated across the whole 19-hour run. If the environment had broken
  mid-run (package removed, conda env swapped, GPU driver reload), the sentinel
  would still read "ok".
- It answers the brief's question directly: **yes, it can pass while the
  environment is actually broken.** It is a "someone once ran a check" marker,
  not a check.
- It lives under the **plugin cache**, not the project — so it is not even
  scoped to the project whose deps it purports to attest.

### R-06 — HIGH — Live run state is stored inside the auto-updating plugin cache

`PLUGIN/.evor/` contains a full parallel run tree:
`active-run.json` (`mission_id: frontier-1ms`), `capability.json`,
`.deps-ok`, `user-prompt-throttle.json`, and `runs/frontier-1ms/run-live-01/`.

That directory is `…/plugins/cache/oh-my-evor/oh-my-evor/**1.2.0**/` — a
*version-pinned* cache path. And `~/.claude/settings.json` sets:

```json
"oh-my-evor": { "source": {…}, "autoUpdate": true }
```

So on the next plugin release the runtime resolves to a `1.2.1/` directory and
every artifact above silently disappears. This is a data-loss trap, not a
theoretical one.

### R-05 — HIGH — Two conflicting `capability.json` files; one bypasses the prober

| File | Content |
|---|---|
| `PROJECT/.evor/capability.json` | `gpu_arch: sm_80`, `gpu_name: NVIDIA A100 80GB PCIe`, `vram_gb: 79.25`, `cuda_version: 13.0`, `available_libs: [flash-attn, xformers, triton]`, `cpu_only: false`, `probed_at: 2026-08-24T00:55:37Z` |
| `PLUGIN/.evor/capability.json` | `gpu_arch: null`, **`cpu_only: true`**, `supported_dtypes: [fp32, int8]`, plus `notes`, `cores: 8`, `avx512: true` |

The plugin-side file is **hand-authored**. It is not schema-conformant with what
`harness/evor/capability.py` emits — it invents `notes`/`cores`/`avx512` and
omits the required `vram_gb`, `available_libs`, `cuda_version`, `probed_at`. Its
`notes` field admits the intent: *"Capability profile pinned CPU-only + int8 so
Dreamer's proposals stay deployment-realistic."*

Pinning a capability profile to steer proposals is a legitimate goal, but doing
it by hand-writing the prober's output file means (a) the artifact no longer
means "what this machine can do", and (b) two agents reading "the capability
profile" get contradictory answers depending on which root they resolve.

### R-04 — HIGH — `capability.json` reports **total** VRAM, not **free** VRAM

`harness/evor/capability.py:_probe_torch_gpu()`:

```python
props = torch.cuda.get_device_properties(dev)
vram_gb = round(props.total_memory / (1024 ** 3), 2)
```

`total_memory` on a **shared-tenant** A100 is not what this run could use. The
recorded 79.25 GB overstates reality by roughly 2x — the transcripts show agents
working against **~40 GB actually free**, and independently discovering they had
to distrust the artifact:

> "Read actual free VRAM (nvidia-smi / torch.cuda.mem_get_info) at launch rather
> than trusting capability.json."
> "Size candidates against ~40 GB free, not the 79.xx figure."

A capability record that the agents reading it have collectively learned to
override is worse than no record: it costs a discovery cycle per agent, and the
next agent that *doesn't* learn the lesson will oversize a candidate.

### R-09 — MEDIUM — `available_libs` reports importability, never exercise

The same prober fills `available_libs` by bare `__import__`:

```python
for lib_name, import_name in [("flash-attn","flash_attn"), ("xformers","xformers"),
                              ("apex","apex"), ("triton","triton")]:
    try: __import__(import_name); libs.append(lib_name)
    except ImportError: pass
```

This is exactly the pattern the brief flagged. `capability.json` advertises
flash-attn, xformers and triton — and the run **never used any of them**. It
could not have: the goal contract's own pass criteria *forbid* them, and the
verification artifacts record this as a PASS condition:

> `"7_no_forbidden_deps": {"result":"pass", "evidence":"No 'evor.' imports.
>  No fp8, no flash_attn. AUTOCAST_DTYPE = torch.bfloat16 on cuda / float32 on
>  cpu (trainer.py:77), sm_80-safe"}`

So the profile's most eye-catching claims describe capabilities the mission was
contractually prohibited from touching. Import-success is a weak proxy for
usability in any case (a lib can import and still fail at kernel launch on the
wrong arch).

### R-08 — MEDIUM — Capability probed ~50 minutes *after* the run started

`PROJECT/.evor/active-run.json` → `started_at: 2026-08-24T00:05:00Z`.
`PROJECT/.evor/capability.json` → `probed_at: 2026-08-24T00:55:37Z`.

The plugin's own docs place `evor_capability` *before* preflight
("Probe hardware and record capability; call before preflight"). Here the first
50 minutes of the run — including candidate sizing decisions — proceeded against
either no profile or a stale one. `evor_capability` was called 15 times across
the run, consistent with repeated re-probing rather than one ordered gate.

### Environment-caused failures found in logs and transcripts

These are the failures that trace to the environment or harness, not to agent
reasoning:

**R-10 — MEDIUM — `PermissionError` on `genome.yaml` killed a candidate before step 1.**
```
PermissionError: [Errno 13] Permission denied:
  '/home/dainb_1/research/binarization/.evor/worktrees/iir-binnet-01/genome.yaml'
  File "train/trainer.py", line 355, in write_genome
```
Recorded in the run's own gotcha store as *"…path in the worktree becomes
read-only in place"* — a guard/permission interaction, not a code defect. The
transcript is explicit: *"Task 3: blocked on segment 1, exit 1, before any step
ran."* 20 occurrences across transcripts (one distinct root cause, repeatedly
re-reported).

**R-11 — MEDIUM — Background training jobs killed at subagent turn end.**
Gotcha `backgrounded-training-killed-at-subagent-turn-end` (confidence 0.9,
17 references): *"Training launched from a sub-agent as a background job was
killed when the launching sub-agent's turn ended. `nohup` did NOT protect it.
`setsid` … do NOT help."* One run died at **step 254 of a planned 450**, leaving
a `weights.pt` from an incomplete run. Three separate launches failed this way
and were initially misdiagnosed as memory pressure before being correctly
attributed. This is a harness-lifecycle constraint, and it silently produces
half-trained checkpoints that look valid on disk.

**R-15 — LOW — `ModuleNotFoundError: No module named 'model'`.**
`sys.path.insert(0, os.getcwd())` in `train/trainer.py` resolved against the
wrong cwd. Self-diagnosed correctly in the transcripts. Notably, the same
transcript records that apparent "concurrent processes" were **self-matching
bash-wrapper argv strings** — a false alarm, worth remembering.

**Not found — categories with zero environment hits:**

| Checked | Result |
|---|---|
| CUDA OOM / `torch.cuda.OutOfMemoryError` | **none.** All 8 "out of memory" hits are *source code* (OOM-detection branches) or *grep patterns*, not events. Confirmed empirically in-transcript: *"450/450 steps with no CUDA OOM"*, *"55 GiB RAM available … ZERO kernel OOM records (no dmesg oom-kill)"* |
| `No space left on device` / disk quota | **none** |
| `Connection refused` / `ECONNREFUSED` / MCP transport failure | **none** — the 32 "MCP error" hits are all `-32602 Input validation error` (malformed *arguments* to `evor_record_node`, `evor_signal_emit`, `evor_validate_proposals`, `web_fetch_exa`), i.e. agent-side schema mistakes, not environment failures. **Lane B's territory, not mine.** |
| API rate-limit / HTTP 429 responses | **none.** All 19 "rate limit" hits are advisory prose or the S2 key paste; all 470 "429" hits are substring noise (author IDs, line numbers, token counts) |
| Package version conflicts | **none** |
| Import errors at runtime | **1 real** (R-15). The other 46 `ImportError` hits are deliberate `try/except ImportError` optional-dependency guards in source (cv2, yaml, pynvml, quality_gate) |
| `sudo` / privilege escalation | **none — 0 uses** |
| GPU probe failure (`nvidia-smi` missing) | **none** — 67 hits are all instructional or fallback-path source |

Timeouts (13 hits) are benign: mostly `Monitor timed out — re-arm if needed`
for finished training runs, plus one 2-minute Bash cap.

### Docker / deploy divergence

`PLUGIN/.dockerignore` excludes `refs/`, `**/node_modules`, `**/.venv`,
`harness/.venv`, `mcp/dist`, `**/__pycache__`, `.git`, `.omc/state`, `ci/out`.
Note it excludes **`mcp/dist`** — which the plugin `.gitignore` deliberately
*un*-ignores (`!mcp/dist/index.cjs`) so the bundle ships. So a container build
must rebuild the MCP bundle that a git install would have received prebuilt:
a real behavioural divergence between the two install paths, and the likeliest
seam for the CHANGELOG's docker chmod-ordering class of bug. `deploy/` itself is
CPU-only ONNX inference (`onnxruntime`, `deploy/models/v9_h2_bg.onnx`) — a
different runtime from the CUDA/torch training path entirely, with its own
unpinned `requirements.txt`.

---

## PART 3 — Blast radius

Derived by parsing every `tool_use` block in all 115 transcripts (1,444 `Bash`,
41 `Write`, 63 `Edit`, 125 `Agent` calls) and extracting write targets.

### Writes outside `/home/dainb_1/research/binarization`

| Destination | Via | Severity |
|---|---|---|
| `/tmp/claude-1006/-home-dainb-1-research-binarization/7fa9c902-…/scratchpad/**` (~40 files: `bench.py`, `apply.py`, `patch_*`, `verify_*`, `.ts`/`.mjs`/`.py` probes) | `Write`/`Edit`/shell redirect | LOW — session scratchpad, intended |
| `/tmp/selector_verdict.json`, `/tmp/sage_findings.json`, `/tmp/sage_signals.py`, `/tmp/corrected_findings.json`, `/tmp/del_ckpt.txt`, `/tmp/deldirs.txt`, `/tmp/evor_micro_test{,2}` | shell redirect | LOW — loose `/tmp` files outside the scratchpad, world-readable by default umask, never cleaned up |
| `/home/dainb_1/.claude/settings.json` | 2× `Edit` + 1 shell write | **BLOCKER — this is the R-01 credential write** |
| `/home/dainb_1/.claude/projects/-home-dainb-1-research-binarization/memory/baseline-73-excludes-palmleaf.md` | `Write` | LOW — auto-memory, intended |
| `/home/dainb_1/.claude/plugins/cache/oh-my-evor/oh-my-evor/1.2.0/**` | `Edit` + shell | **HIGH — see R-12** |

**No writes anywhere else.** Nothing outside `$HOME` and `/tmp`. No `sudo`, no
`/etc`, no systemd, no crontab, no SSH config, no package installs to system
paths.

### R-12 — HIGH — The system edited its own plugin source mid-run

Confirming the sibling lane's finding, with the full file list. Files under the
plugin cache modified *after* the Aug 23 03:47 install timestamp:

**Source edited in place:** `harness/evor/integrity.py`, `harness/evor/contracts.py`,
`harness/evor/freeze.py`, `mcp/src/contracts.ts`, `mcp/dist/index.cjs`,
`mcp/bridge/integrity_bridge.py`, `hooks/stop.mjs`, `agents/evor-tick.md`,
`harness/tests/test_integrity.py`, `harness/tests/test_tabular_ladder.py`,
`harness/tests/test_bench_evaluator.py`, `mcp/tests/tick-self-heal.test.ts`.

**13 `.bak-*` files left behind**, in four timestamped waves —
`…bak-20260823-2350`, `…bak-20260824-013931`, `…bak-20260824-020302`,
`…bak-20260824-021010` — indicating four successive self-modification rounds
between 23:50 and 02:10.

Two compounding problems: the modified `mcp/dist/index.cjs` is the **built
bundle** the MCP server actually executes, so the running orchestrator was
changed underneath the run; and every one of these edits is destroyed by
`autoUpdate: true` on the next release, along with the R-06 run state. The
`.bak` files are the only record, and they are in the same doomed directory.

### External services contacted

Every network destination in the run, with call counts:

| Host | Calls | Direction |
|---|---|---|
| `arxiv.org` | 37 | **inbound only** — paper search/fetch/download |
| `doi.org` | 23 | inbound — resolution |
| `amadi.univ-lr.fr` | 14 | inbound — research dataset host (palm-leaf corpus) |
| `www.semanticscholar.org` | 5 | inbound — paper metadata |
| `ieeexplore.ieee.org`, `dial.uclouvain.be`, `hal.science`, `www.mdpi.com`, `dl.acm.org` | 1 each | inbound — paper fetch |
| `huggingface.co/mcp` | 4 | outbound *queries* only (`hub_repo_search`), anonymous |

**No project data or code was uploaded anywhere.**

- **wandb: offline.** The only run directory is `wandb/offline-run-20260726_123508-qaviwq7o`,
  `debug.log` confirms offline init, and the documented guidance is
  `# export WANDB_MODE=offline`. Nothing was synced to wandb servers.
- Search-tool calls (`search_papers` ×47+27, `web_search_exa` ×9) send **query
  strings**, which do describe the research direction — modest intent leakage,
  normal for literature review, no code or data.
- The one genuine egress of project content is **inherent, not incidental**:
  1,444 Bash invocations, source reads, and full tracebacks went to the model
  API as conversation content. That is how the tool works; it is only a finding
  because R-01 rode along in that same channel.

---

## Ranked findings

| ID | Sev | Category | Location | Finding | Action |
|---|---|---|---|---|---|
| R-01 | **BLOCKER** | Secret | `~/.claude/settings.json` + 2 `.jsonl` (15×) | Live S2 API key `s2k-2clW…` (44 ch), pasted by user, echoed to API | **Rotate**, then scrub transcripts; re-supply via env var |
| R-02 | **BLOCKER** | Repro | `PROJECT/` | Not a git repo; `.gitignore` inert and insufficient | `git init` + adopt the plugin's `.gitignore` |
| R-03 | **BLOCKER** | Repro | `pyproject.toml`, `/opt/conda/envs/shared-base` | No pins, no lockfile, shared unversioned interpreter | Lockfile + project venv + record interpreter in run manifest |
| R-04 | HIGH | Env | `harness/evor/capability.py` | Reports `total_memory` (79.25 GB) not free (~40 GB) | Record both; size against free |
| R-05 | HIGH | Env | `PLUGIN/.evor/capability.json` | Hand-authored, schema-nonconformant, contradicts project profile | Separate "policy pin" from "probe output" |
| R-06 | HIGH | Fragility | `PLUGIN/.evor/` + `autoUpdate: true` | Run state inside version-pinned cache; wiped on update | Move state out of plugin dir |
| R-07 | HIGH | Env | `PLUGIN/.evor/.deps-ok` | Bare 24-byte timestamp; cannot fail; wrong root | Record package set + interpreter; revalidate |
| R-12 | HIGH | Blast | plugin cache, 12 files + 13 `.bak` | Self-modified its own running source in 4 waves | Preserve `.bak`s outside cache before any update |
| R-08 | MED | Env | `capability.json` `probed_at` | Probed 00:55, run started 00:05 | Gate run start on a fresh probe |
| R-09 | MED | Env | `capability.py` `available_libs` | Advertises flash-attn/xformers/triton; contract forbids all three | Report exercised, not importable |
| R-10 | MED | Env | `.evor/worktrees/*/genome.yaml` | `PermissionError` killed candidate before step 1 | Fix guard/worktree write ordering |
| R-11 | MED | Harness | subagent lifecycle | Background training killed at turn end; `nohup`/`setsid` ineffective; one run died at step 254/450 | Foreground-and-poll, or a real job runner |
| R-13 | MED | Posture | `~/.claude/settings.json` | `skipDangerousModePermissionPrompt: true` | Confirm intentional for 19h unattended runs |
| R-14 | LOW | Secret | `PLUGIN/.mcp.json` | `Bearer ` with unset `${user_config.hf_token}` | Set token or drop the header |
| R-15 | LOW | Env | `train/trainer.py` | `sys.path.insert(0, os.getcwd())` cwd bug | Anchor to `__file__` |
| R-16 | LOW | Blast | `/tmp/*.json`, `/tmp/*.py` | 6 loose world-readable `/tmp` files, never cleaned | Confine to session scratchpad |

## Wave-2 questions

1. **R-01** — Was the key ever used against the live S2 API, and does S2 offer
   usage logs to bound the exposure window (paste → rotation)?
2. **R-02/R-03** — Is there a git repo elsewhere this tree was exported from, or
   is 19h of autonomous edits genuinely unversioned? Determines whether
   reproducibility is recoverable or already lost.
3. **R-04/R-05** — Which `capability.json` did each agent actually resolve, and
   did any candidate get sized against the false 79.25 GB figure?
4. **R-06/R-12** — Do the 13 `.bak` files reconstruct the pre-run plugin state,
   and has an auto-update already fired since Aug 24?
5. **R-11** — How many of the run's recorded results came from checkpoints of
   *killed* training runs? Bears directly on Lane M's validity findings.
6. **R-07** — Is `.deps-ok` consulted as a gate anywhere in the tick loop, or is
   it vestigial? (No reader found in `harness/evor/*.py` or `mcp/src/*.ts`.)
