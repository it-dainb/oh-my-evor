# RC7-tier-benchmark — recovered from lane transcript

> Recovered from the lane's transcript after it completed analysis but did not
> write its own file. Content is the lane's own words, verbatim, in order.

---

`docs/field-trace-v1.2.0/root-cause/RC7-tier-benchmark.md` written. Read-only otherwise.

**Root cause per finding**

- **P-04 (toolless corpus).** Selector's harness (`6e892d2`, 08-03) named the instrument's validity property — *every graded item is derivable from the inlined payload* — and enforced it by hand-excluding H002/Gotcha. Eighteen days later `6199645`/`fb95660` generalised the harness against a *different* declared defect ("grading a contract the agent was never given"); `eval-specs.test.ts:134-174` encoded seven field-level properties, none spawn-shape-level. **The defining validity property was the one never made machine-checkable, so generalisation carried the checkable ones and dropped it.** Construct-validity failure of *citation*, not of measurement — the numbers are right about a narrower thing.
- **Tier drift in the notebook.** `docs/retier-benchmark-results.md` last edited `e9b3de4` 2026-08-22 00:47; reverts landed `aace945` 2026-08-23 02:35 — 26 hours later. Hand-maintained (no generator; only tests read it). The release wrote a *new* correct doc (`v1-cost-and-verification.md` §1, which lists all five reverts) instead of updating the notebook. **Root: four descriptions of shipped tiers, only one executable, no designated source of truth and no check tying prose to frontmatter.** Documentation defect, not measurement defect.
- **Coverage.** `evor-tick` predates the tier harness (`4009394`, 07-31 vs 08-03) and *was* measured — cost/context by `ci/bench-tick.mjs`, contract by two unit suites — just never on the accuracy axis. Every spec's arms are `current` vs `main (pre-retier)`: **coverage is a by-product of the retier candidate list.** `eval-specs.test.ts:32` enumerates specs that exist, so an absence can never be a failure. `evor-acquirer` is the inverse: offline-covered (36/36), never field-exercised.
- **S3 (mangled prefix).** Same root as P-04. `ci/role-eval.mjs:41-44` passes no `--mcp-config`; grep of all 62 `ci/out/*.json` finds `tool_use` only in `live-seal-*`/`bench-tick-raw`, never a role-eval report. Two independent blinding layers (no server attached; envelope tool records discarded).

**Claims verdict** — cost (68.8%) SURVIVES with one named assumption (equal tool-call volume across tiers; T7's live run gives haiku 30 vs sonnet 33 evor calls at n=15, mildly reassuring). "No measured accuracy regression" SURVIVES as worded, NEEDS RE-MEASUREMENT as read. Per-role CIs SURVIVE for judgement-given-facts, not end-to-end competence. The thirteen-prompt-defects finding SURVIVES and is *strengthened* by the live run. The gate, the five reverts, the $0.2618 forgone, and the billed-vs-modeled repricing all SURVIVE. REFUTED: "Six of the eight roles now run haiku" (four do; five agents total), and the four notebook tier rows. Nothing here shows a model failing or a number computed wrongly.

**Shared root** — the property that determines whether a result means what it says is the property that has no test. Same shape at both levels: the harness's derivability audit, and the frontmatter-vs-prose enumeration that always runs from the paraphrase rather than from the executable copy.

**Predictions ranked by checkability** — (1) prefix transcription at n≥60, ~$8/10min, cheapest open question; (2) tool-argument schema by tier (lane D's tick offender: no spec grades an argument object); (3) declared-vs-emitted signals (`signals_emitted`, `angles_wiki_resolved` are graded strings); (4) tool-error recovery — no spec presents a failing call; (5) call sequencing, removed by inlining all facts at once; (6) any role added for architectural rather than cost reasons — statically checkable today; (7) hand-maintained derived counts; (8) long-context/nested-subagent tier effects; (9) latency as a gate criterion (data exists, criterion does not); (10) unstamped provenance dimensions — `pricing_basis` exists because modeled-vs-billed burned them, tool basis did not because it hadn't; predict no permission-mode, context-depth, or live-spawn agent-hash stamp (T7 confirms the last).

One fairness correction I'd flag to the lead: T7 frames the appended "do not call any tool" sentence as the defect. It isn't — it's the honest accommodation for a deliberate offline design. The cause is the spawn shape, and the failure is that the boundary was never recorded anywhere the numbers travelled to.

---

No retry needed — the write landed. `docs/field-trace-v1.2.0/root-cause/RC7-tier-benchmark.md`, 531 lines, 32KB, written 09:19. The directory already existed by the time I reached the write step (RC1–RC3 were present when I checked it at 09:19; RC4–RC8 are there now too). Nothing was blocked; I have no outstanding asks.

Restating the findings, unchanged:

**Root cause per finding**
- **P-04 (toolless corpus).** Selector's harness (`6e892d2`, 08-03) named the instrument's validity property — *every graded item is derivable from the inlined payload* — and enforced it by hand-excluding H002/Gotcha. Eighteen days later `6199645`/`fb95660` generalised the harness against a *different* declared defect ("grading a contract the agent was never given"); `mcp/tests/eval-specs.test.ts:134-174` encoded seven field-level properties, none spawn-shape-level. **The defining validity property was the one never made machine-checkable, so generalisation carried the checkable ones and dropped it.** Construct-validity failure of *citation*, not of measurement.
- **Tier drift.** `docs/retier-benchmark-results.md` last edited `e9b3de4` 2026-08-22 00:47; reverts landed `aace945` 2026-08-23 02:35 — 26 hours later. Hand-maintained (no generator; only tests read it). The release wrote a *new* correct doc (`docs/v1-cost-and-verification.md` §1, all five reverts listed) instead of updating the notebook. **Root: four descriptions of shipped tiers, one executable, no designated source of truth, no check tying prose to frontmatter.**
- **Coverage.** `evor-tick` predates the tier harness (`4009394` 07-31 vs `6e892d2` 08-03) and *was* measured — cost/context by `ci/bench-tick.mjs`, contract by two unit suites — never on the accuracy axis. Every spec's arms are `current` vs `main (pre-retier)`: **coverage is a by-product of the retier candidate list.** `mcp/tests/eval-specs.test.ts:32` enumerates specs that exist, so an absence can never be a failure. `evor-acquirer` is the inverse: offline-covered (36/36), never field-exercised.
- **S3 (mangled prefix).** Same root as P-04. `ci/role-eval.mjs:41-44` passes no `--mcp-config`; grep of all 62 `ci/out/*.json` finds `tool_use` only in `live-seal-*`/`bench-tick-raw`, never a role-eval report. Two independent blinding layers.

**Claims verdict** — 68.8% cost SURVIVES with one named assumption (equal tool-call volume across tiers; T7's live run gives haiku 30 vs sonnet 33 evor calls at n=15). "No measured accuracy regression" SURVIVES as worded, NEEDS RE-MEASUREMENT as read. Per-role CIs SURVIVE for judgement-given-facts, not end-to-end competence. Thirteen-prompt-defects SURVIVES and is *strengthened* by the live run. Gate, five reverts, $0.2618 forgone, billed-vs-modeled repricing all SURVIVE. REFUTED: "Six of the eight roles now run haiku" (four do; five agents total) and the four notebook tier rows. No model failed and no number was computed wrongly.

**Shared root** — the property that determines whether a result means what it says is the property that has no test. Same shape at both levels: the harness's derivability audit, and the enumeration that always runs from the paraphrase rather than from the executable copy.

**Predictions, cheapest first** — (1) prefix transcription at n≥60, ~$8/10min; (2) tool-argument schema by tier — no spec grades an argument object; (3) declared-vs-emitted signals (`signals_emitted`, `angles_wiki_resolved` are graded strings); (4) tool-error recovery — no spec presents a failing call; (5) call sequencing, removed by inlining all facts at once; (6) any role added for architectural rather than cost reasons — statically checkable today; (7) hand-maintained derived counts; (8) nested-subagent context-depth effects; (9) latency as a gate criterion (data exists, criterion does not); (10) unstamped provenance dimensions — `pricing_basis` exists because modeled-vs-billed burned them; predict no permission-mode, context-depth, or live-spawn agent-hash stamp (T7 confirms the last).

One fairness correction worth carrying into GREEN: T7 frames the appended "do not call any tool" sentence as the defect. It isn't — it's the honest accommodation for a deliberate offline design. The cause is the spawn shape, and the failure is that the boundary was never recorded anywhere the numbers travelled to.

---

The file was already written and is complete — the premise that it was never created is incorrect. No Write failed, and I did not rewrite it (rewriting from context alone would have degraded a report already grounded in verified sha/line evidence).

**Absolute path:** `/home/dainb_1/research/oh-my-evor/docs/field-trace-v1.2.0/root-cause/RC7-tier-benchmark.md`
**531 lines, 32,282 bytes, mtime 09:19.** The `mkdir -p` was a no-op; the directory already existed when I reached the write step.

Structure verified present, matching the required shape:

- L1 title, L19 evidenced timeline (9 commits with dates)
- L39 Finding 1 — P-04 toolless corpus (proximate → 8-step chain → ROOT CAUSE → C1-C4 → trigger)
- L207 Finding 2 — retier doc describes an unreleased build (7-step chain)
- L296 Finding 3 — coverage is a by-product (6-step chain)
- L364 Finding 4 — S3 structurally unobservable (4-step chain)
- L424 Which v1.2.0 claims survive — 12 rows, each SURVIVES / NEEDS RE-MEASUREMENT / REFUTED
- L450 The shared root (Root A / Root B)
- L472 Predictions, ranked by checkability (10 items)
- L522 The single sentence

Every causal step carries a sha or `file:line` (`6e892d2`, `6199645`, `fb95660`, `aace945`, `e9b3de4`, `4009394`, `bab279e`; `ci/role-eval.mjs:41-44`, `ci/eval-core.mjs:1-24`, `ci/eval-core.mjs:172-190`, `ci/agent-eval.mjs:368-390`, `mcp/tests/eval-specs.test.ts:32` and `:134-174`). No gaps needed marking — the two NOT-TESTABLE items from T7 (haiku mis-transcription rate, the mid-run agent-file edit) are carried forward as explicitly unsettled rather than resolved, which is the honest state.

No blockers, and nothing I need from you.
