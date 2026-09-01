# RC4-durability-audit — recovered from lane transcript

> Recovered from the lane's transcript after it completed analysis but did not
> write its own file. Content is the lane's own words, verbatim, in order.

---

Written: `/home/dainb_1/research/oh-my-evor/docs/field-trace-v1.2.0/root-cause/RC4-durability-audit.md` (491 lines). Read-only otherwise — the only path I created is that file.

**Root cause per finding**

- **I-01** (CODE) — `decision_type` is a closed enum (`contracts.py:838-849`) that *is* the tick loop's step list one-to-one, and the "unforgettable logging" enforcement (`hooks/stop.mjs:11,178`) guards `pending_node_ids`/`tree.json` and never reads `decision-log.md`: the log was specified as a record of the **search**, not of the run, with model forgetfulness (spec `:220`) as its only threat model.
- **I-11 / O-09** (CODE) — the run is not an entity in evor's ontology: 58 contract models, no `MissionState`/`RunState`; `mission-state.json` is a bare dict (`init_run.py:218`) with one mutable field; status has always been value-validated, never transition-validated — the sole guarded transition in project history is `draft→locked`, which protects the *contract seal*. `git log -S'superseded_by' --all` is empty.
- **A-04 / P-01** (PROCESS root + CODE root, same origin) — the development story assumes a checkout and the deployment story ships a cache, with nothing bridging them: `install.sh:37` pip-installs the harness **editable** while MCP/skills/agents/hooks are served from a copied cache; README has zero dev/contribute/rebuild/fork content; the field session (`installed_plugins.json`: project-scoped, cwd `~/research/binarization`) had no checkout to edit. The code half: integrity was scoped to the mission's data, never the plugin's code — `evor doctor`'s nine checks (`doctor.py:63-362`) cover environment and search artifacts only, and the `gitCommitSha` the host already records is never read.
- **P-02** (CODE) — evor has no concept of a workspace. `getEvorRoot()` (`run-store.ts:18-20`) is two lines, env-or-cwd, zero validation; **no code anywhere validates a state root**, so writers accept a plugin-rooted dir because rejecting it is not a decision they can make. Zod validates payloads; not one schema validates a path.
- **R-02 / R-03** (PROCESS in the field; the design question has a code answer) — the harness's only awareness of git is `.git` in an *exclusion list* (`distill.py:48`). The `AutonomyCharter` (`contracts.py:288-311`) is where this consideration should have landed; every clause bounds the **evaluation** (monotonic honesty, no-test-leakage, comparability) and none bounds the filesystem. Risk was modelled as *a dishonest number*, never *an unrecoverable workspace*.

**The shared root** — every contract, guard, hash and hook binds to an object of the tree search; the run itself (lifecycle, concurrency, state root, installed code, workspace) was left to a human operator that `posture: "aggressive-never-halt"` guarantees will not be watching.

**Predictions, ranked by checkability** (1-4 confirmed in-pass):
1. Every node's `rationale` — the schema field exists, `recordNode` (`record.ts:118-127`) writes a fixed stub without it.
2. Which code produced any run — no plugin version or commit in any run artifact.
3. Doom-loop overrides — documented as logging (`ARCHITECTURE.md:196-206`), implemented only in prompts; zero code hits.
4. Split re-freezes (`allow_refreeze`, `freeze.py:95,142,170`) — the act that invalidates every prior score, unlogged.
5. All operator-initiated tool calls (lock, doctor, preflight) — no `decision_type` exists for them.
6. Every prior `active-run.json` value — overwritten in place.
7. Per-tick cost, tier, wall-clock — nothing in `.evor/` records them.
8. Anything the Monotonic-Honesty Invariant "routed around" — silent by design; needs a live run to observe.

Two cautions for GREEN: the uncommitted ~3,000 lines and R-02 have **process** roots that no test can hold (T4 scoped this correctly); and `ARCHITECTURE.md:129-131`'s claim that hooks make skipping a decision-log record hard has never matched the code — it should not be treated as a regression.

---

The file exists and is complete. No write was needed, and I did not re-run any analysis.

**Absolute path:** `/home/dainb_1/research/oh-my-evor/docs/field-trace-v1.2.0/root-cause/RC4-durability-audit.md`
**Line count:** 491 (27,222 bytes, mtime 09:16)

It sits alongside RC1, RC2, RC3, RC5–RC8, all written into the same directory in the same window. No error occurred at any point — my earlier `mkdir -p` in the same command as the heredoc created the directory, so the write landed before your 09:17 note.

Structure, as required: five findings (I-01, I-11/O-09, A-04/P-01, P-02, R-02/R-03), each with Proximate cause → numbered Causal chain (every step carrying a commit sha or file:line) → **ROOT CAUSE** stated as a belief or design commitment → Contributing factors; then a shared-root section, eight ranked predictions, and the closing "The single sentence" (visible in the tail above). Process/code class is marked on every finding.

Nothing is incomplete and there are no gaps to flag. My summary two messages back is the report content; I'm not blocked on anything.
