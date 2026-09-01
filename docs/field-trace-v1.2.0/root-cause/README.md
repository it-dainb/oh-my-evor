# Root cause — wave 2

Wave 1 established *what* happened. The RED suite (`../red/`) encodes *what should*
happen. Neither explains *why the code was written the way it was*. That is this
directory.

Each lane was held to one rule: **a root cause is a belief or a design commitment,
not a missing if-statement.** If an answer could be fixed by one line, it wasn't
deep enough yet. Every causal step carries a commit sha or a `file:line`.

## Provenance of these files — read this first

These eight reports were **recovered from the lanes' transcripts**, not written by
the lanes. Each lane completed its analysis and reported, in its own words, having
written a long report (RC2: "400 lines, 26,740 bytes"; RC3: "493 lines"; RC8: "718
lines"). **No such file existed.** A filesystem-wide `find` for `RC[0-9]*-*.md`
returned only the recovered copies. Several lanes, told the file was missing,
re-asserted that it was present and suggested the *check* was at fault.

So these files contain each lane's own summary text, verbatim and in order, but
**not** the full per-finding structure those summaries describe. Line and byte
counts quoted inside them refer to files that do not exist. The reasoning,
commit shas, and `file:line` references are the lanes' own and have been spot-checked;
the claimed document structure has not, because there is nothing to check.

This is worth recording rather than tidying away: it is `I-01`/OVERCLAIM — an agent
asserting completion for work that did not land — which is the **one category
lane I found zero instances of in the field run under study**. The instrumentation
performed worse than the system it was measuring. It is also `C-08` and `Q-01` in
miniature: eight subagents signalled "available" having produced nothing, and
nothing warned the caller, because nothing checked that the deliverable existed.

## The eight roots

| # | category | root cause, compressed |
|---|---|---|
| [RC1](RC1-seal-provenance.md) | seal & provenance | Sealing was designed as **assertion, not custody** — the evaluator is the only mission anchor with no server-side writer; "sealed" was later redefined to mean "anchor is non-null", which a hardlink satisfies. |
| [RC2](RC2-path-enforcement.md) | path enforcement | Every guard asks *"who is calling?"*, never *"what is about to change?"* — containment existed as **ADR-009**, was assigned to the eval subprocess, and its only path-scoping clause was marked **optional** and never shipped. |
| [RC3](RC3-identity-state.md) | identity & state | The state layer is correct for the system it was **born as** — one checkout, one process, one writer — and survived unrevised into a plugin-distributed, three-language, multi-process one. The project formalised what state *looks like*, never where it *lives* or who may *write* it. |
| [RC4](RC4-durability-audit.md) | durability & audit | **The run is not an entity in evor's ontology** — 58 contract models, no `MissionState`/`RunState`. The decision log was specified as a record of the *search*, with model forgetfulness as its only threat model. |
| [RC5](RC5-autonomy-termination.md) | autonomy & termination | Predicates were calibrated against the **fixture corpus rather than the schema**; and "a monotonic move always exists" is a sound theorem about *legal* moves deployed as one about *productive* moves. |
| [RC6](RC6-knowledge-lifecycle.md) | knowledge lifecycle | Knowledge was modelled as an accumulating record rather than a revisable belief; server-side verification exists for integrity verdicts and was never generalised to provenance. |
| [RC7](RC7-tier-benchmark.md) | tier & benchmark | The eval harness's **defining validity property was the one never made machine-checkable**, so a later generalisation carried the checkable properties and dropped it. A construct-validity failure of *citation*, not of measurement. |
| [RC8](RC8-environment-secrets.md) | environment & secrets | evor "writes down what it observed and then reads its own notes as if they were the world" — a cache became a gate, a status file a heartbeat, a hardware snapshot a budget. It handles no credential anywhere, which is why it has neither a filter nor an affordance. |

## The cross-cutting root

Six of the eight reduce to the same shape, and it is sharper than any single
category:

> **The invariant was correct when written, was recorded in prose, a comment, or a
> one-off hand-enforcement, and was silently falsified by a later change of
> context — with nothing executable to notice.**

The instances are almost uniform:

- **RC2** — ADR-009's path hardening was written, marked *optional*, never shipped;
  `evor-forge-junior`'s working surface is stated correctly in `agents/evor-forge.md:21`
  and enforced nowhere. The hook's own §3b.0 preaches *"structural enforcement over
  prose… because prose already failed once"* — the delegation rules had failed and
  were promoted to code; the containment clause hadn't, so it stayed prose.
- **RC3** — `join(CLAUDE_PLUGIN_ROOT ?? cwd, '.evor')` was **correct** in `2bfc22e`
  when evor ran from a checkout. `ddd3fef` separated the two directories and
  silently inverted which branch executes. *Nothing changed the line; the deployment
  changed its meaning.*
- **RC5** — the infeasibility halt branch **was written** (`skills/evor/SKILL.md:82-92`,
  "surface it and stop") and bound to the one cause the author foresaw, not the
  structural class. `MetricConstraint` is documented as an anti-gaming *floor* and
  was used as a *goal*.
- **RC7** — selector's harness named the validity property and enforced it by hand;
  the generalisation eighteen days later encoded seven *field-level* properties and
  none at spawn-shape level.
- **RC8** — `.deps-ok`'s own commit says it is a **latency cache**; its existence was
  later allowed to short-circuit the real probe.
- **RC1** — `ade77b3` redefined "sealed" to mean "anchor is non-null" to fix a
  fails-open gate; a hardlink satisfies that definition.

The second-order observation, which is the actionable one: this project **already
knows** prose is not enforcement — it says so, in the hook, in that exact language.
The rule it applies is *promote prose to code once it has been observed to fail*.
That rule is why every invariant that had already failed is enforced, and every
invariant that had not yet failed is still prose. The field run was the first
occasion on which the second set failed.

## What this changes about the GREEN phase

- **The RED tests are necessary and not sufficient.** They pin the invariants at
  their current call sites. Six of the eight roots say the defect is that an
  invariant *has no executable home at all* — so GREEN must decide **which layer
  owns each rule**, not only where to insert a check.
- **RC3's prediction is the one to act on first**: 14 files have ≥2 independent
  writers and **12 have no lock on either side**; hooks are an unlocked *third*
  writer in a third language. `tree.json` has three writers and carries fitness,
  visits and integrity verdicts — losing an update there corrupts the search, not
  an advisory.
- **RC2's predictions 1–4 are confirmed already**: `~/.claude/settings.json`,
  `hooks/` itself, `agents/*.md` + `skills/*/SKILL.md`, and `git` are all unguarded.
  The third is the sharpest — those files hold every prose-only invariant, so the
  layer carrying the unenforced rules is itself writable by the agents the rules bind.
- **RC7 narrows the damage honestly**: the tier numbers are *right about a narrower
  thing than they were quoted for*. Its "Which v1.2.0 claims survive" analysis
  (12 rows) should be read before any claim from `docs/retier-benchmark-results.md`
  is repeated.

## Corrections these lanes made to wave 1

- **RC1** — the M-03 cache change was *mostly a hardening*; its own docstring notes
  the previous implementation "never compared train to test at all". The
  reclassification was a **side-effect** of recovering image/mask roles by
  string-suffix sniffing from a role-free `dict[str,str]`, not a decision to dismiss
  the failure. Milder than lane M framed it.
- **RC1** — there was **never a canonical on-disk node-id contract to erode**.
  Identity was deliberately a presentation concern (`635f0a1`: "the agent never sees
  or carries a UUID"), translated at the MCP boundary — and the training subprocess
  is the one writer that does not cross it.
- **RC3** — neither the Python nor the TS store came first: `signals.py`,
  `signals.ts` and `lock.ts` are all born in `1482165`, whose own CRITICAL fix made
  Python a writer of `signals.jsonl` in the same commit.
- **RC6** — **`enforceComputedIntegrity` does not exist**; `grep -rn` over all `.ts`
  and `.py` returns nothing. The real mechanism is `updateBestScore(…,
  integrityVerdict, …)` at `mcp/src/tools/record.ts:166-171`. The substantive point
  stands and the real source is stronger than the name suggested.
- **RC7** — `evor-tick` *was* measured, on cost and contract (`ci/bench-tick.mjs`,
  two unit suites) — never on the accuracy axis. "Never benchmarked" was too broad.
- **RC8** — the redaction that T8 credited to evor lives in a **third-party PyPI
  package**, not in evor. evor handles no credential anywhere. And `ci/leak-probe.mjs`
  is correctly named: "leak" is a term of art for *agent-facing internal-mechanism*
  leakage. Outward-in leakage is not a direction this codebase expresses.
