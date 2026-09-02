# tool-eval-bench research

Repo: https://github.com/SeraphimSerapis/tool-eval-bench (MIT, Python, 325 stars, 44 forks,
pushed 2026-08-31, default branch `main`). Real and substantial — not a thin/aspirational repo:
~90 scenario files, a full test suite (`tests/` alone is dozens of files, several 20-100KB),
CI, CONTRIBUTING.md, a changelog-fragment workflow. Fetched via `raw.githubusercontent.com` for
all files quoted below; every claim here is from a file I actually opened, listed with its path.

Files read: `README.md`, `docs/methodology.md`, `docs/related-work.md`, `docs/hard-mode.md`,
`docs/adding-a-scenario.md`, `docs/cli-reference.md`, `src/tool_eval_bench/domain/models.py`,
`src/tool_eval_bench/domain/scenarios.py`, `src/tool_eval_bench/evals/scenarios/core/tc01.py`,
`src/tool_eval_bench/evals/yaml_scenarios/weather.yaml`,
`src/tool_eval_bench/runner/orchestrator.py` (partial), plus the repo's full file tree via the
GitHub API. I did not fetch `evals/helpers.py`, `application/service.py` in full, or the trials/
Pass@k aggregation code — noted explicitly below where that gap matters.

## 1. Scenario format

A scenario is one Python file under `src/tool_eval_bench/evals/scenarios/<group>/tcNN.py`
exporting two module-level objects, `SCENARIO` and `DISPLAY` — nothing else registers it
(`docs/adding-a-scenario.md`). Real example, `evals/scenarios/core/tc01.py`:

```python
SCENARIO = ScenarioDefinition(
    id="TC-01",
    title="Direct Specialist Match",
    category=Category.A,
    user_message="What's the weather like in Berlin right now?",
    description="Use get_weather instead of falling back to web_search.",
    handle_tool_call=_tc01_handle,
    evaluate=_tc01_eval,
    difficulty=1,
)

DISPLAY = ScenarioDisplayDetail(
    "Pass if it calls get_weather for Berlin and avoids web_search.",
    "Fail if it searches the web, calls multiple tools, or answers from memory.",
)
```

A case is three parts: a deterministic mock tool handler (`handle_tool_call`), a Python
evaluator function (`evaluate`) that inspects the full conversation state and returns a
pass/partial/fail verdict with a reason string, and the `ScenarioDefinition` binding them plus
metadata (id, category, difficulty 1-5, optional `follow_up_messages`, `tools_override`,
`tool_choice_after_first_call`, `max_turns_override`, `preserve_reasoning_across_follow_ups`).
Expected behavior is expressed as code, not data — the evaluator is a hand-written function per
scenario, not a declarative match against one canonical trace. `docs/methodology.md` calls this
out explicitly: it's a "reasonable-trace policy," not a single reference trace — independent
reads may run in parallel or either order, equivalent recipient layouts are accepted "when they
preserve the same safety and completeness guarantees."

Tools are **entirely simulated** — no real API calls. Every scenario supplies a deterministic
mock handler; the same input always produces the same output, which the docs state is
load-bearing: "so a score difference is a model difference" (`docs/adding-a-scenario.md`).
Responses are enriched with "deterministic payload noise" — extra metadata, timestamps, IDs the
answer doesn't need — via a `with_noise()` helper, specifically to test whether a model can
extract the right field from a response shaped like a real API's rather than a hand-trimmed one.

There is also a declarative YAML subset (`evals/yaml_loader.py`, examples in
`evals/yaml_scenarios/`) for simple lookup-shaped cases, meant for third parties authoring
private "held-out packs" without shipping Python. Real example,
`evals/yaml_scenarios/weather.yaml`:

```yaml
id: YAML-01
title: Simple weather lookup
category: A
difficulty: 1
user_message: What is the weather in Berlin?
expected_tool_calls:
  - tool: get_weather
    arguments:
      location: Berlin
tool_responses:
  get_weather:
    - match:
        location: Berlin
      response:
        location: Berlin
        temperature_c: 18
        condition: cloudy
```

The YAML format is deliberately narrow per the docs: it matches tool calls positionally, cannot
inspect tool results, and has no conditionals — "a scenario that needs to react to what a tool
returned belongs in Python." `answer_contains` is its only PARTIAL-tier mechanism.

## 2. Scoring

Rule-based, not LLM-judge. Every scenario has a hand-written Python evaluator that inspects tool
calls, arguments, call order/timing, and the final text answer — string/keyword matching plus
structural checks (JSON parsing, key presence). `docs/methodology.md` states this plainly: no
semantic-similarity scoring, no LLM-as-judge for the core suite (`runner/judge.py` exists in the
tree but I did not open it, so I can't say what role, if any, it plays — the methodology doc's
"Evaluator Design" section only describes pattern-based evaluation).

Three tiers per scenario: PASS (2 pts), PARTIAL (1 pt), FAIL (0 pts). Final score is
`(points earned / max points) × 100`, i.e. scenario-count-weighted, not category-averaged — the
docs explicitly reject category-averaging because it lets a model that aces 3 trivial scenarios
and fails 10 hard ones outscore one that passed 8/13 (`docs/methodology.md`, "Why scenario-count
weighting?"). An opt-in `--weight-by-difficulty` flag recomputes the score weighting by each
scenario's 1-5 difficulty tier, reported *alongside*, never replacing, the standard score.

**Right answer, wrong route / wrong answer, sound reasoning:** handled per-scenario in the
evaluator logic, not by a general rule. TC-01's evaluator (quoted in full above as source) is
illustrative: calling `get_weather` for Berlin and stating the temperature or condition is PASS;
calling only `web_search` and getting a usable answer is PARTIAL ("functionally correct… but
missed the specialist tool"); anything else is FAIL. The methodology doc documents known
evaluator limitations candidly: string-matching refusal detection is "fragile" (a model refusing
in unlisted phrasing may be wrongly marked FAIL), there's no semantic similarity ("seven degrees
Celsius" vs "7°C" may not get credit), and JSON-format strictness varies by scenario. It also
documents a real historical bug and fix: TC-14 used to give partial credit for `web_search` being
called *anywhere* in the transcript; it now requires the search to occur in a turn *after* the
tool error, to confirm genuine recovery rather than a coincidental pre-error search.

There's also an explicit "scenario-critical semantics" layer above tier assignment: evaluators
check that explicit tool errors can't be used to support fabricated answer data, that
dependencies/critical arguments are valid, and that structured outputs satisfy declared
types/fields.

## 3. TP/FP/TN/FN — it does not use this framing at all

I grepped every file I fetched (`.py` and `.md`, including `domain/scenarios.py`,
`application/service.py` header, `runner/orchestrator.py`, `docs/methodology.md`,
`docs/cli-reference.md`) for `true positive`, `false positive`, `true negative`, `false negative`,
`TP`, `FP`, `TN`, `FN` — zero matches anywhere. This benchmark is built entirely around the
3-tier PASS/PARTIAL/FAIL taxonomy plus a separate `FailureKind` enum for *why* something failed
(`wrong_tool`, `wrong_args`, `missing_step`, `forbidden_action`, `budget_exceeded`, `timeout`,
`connection_error`, `server_error`, `model_crash`, `evaluator_error`, `partial` —
`domain/scenarios.py`). There is no "positive class" concept, per-case or global, anywhere in
what I read. This is a genuine gap relative to what a TP/FP-framed bench would need — see §9.

## 4. Negative / abstention cases

Yes, and it's a full category, not a bolt-on. Category D "Restraint & Refusal" (3 scenarios)
tests "knowing when NOT to call tools" (`docs/methodology.md` category table). Category K
"Safety & Boundaries" (13 scenarios, the largest category) covers ambiguity, scope limits,
hallucination, prompt injection, authority escalation. TC-77 ("Irrelevant tool trap") is a
direct abstention case: "Answer a stable fact directly despite distractor tools" — the model must
NOT call a tool that's present and superficially relevant. Hard-mode TC-75/TC-76 test refusing to
guess a missing required parameter and refusing an unsupported mutation while still allowing a
valid read (`docs/hard-mode.md`).

Distinguishing "correctly abstained" from "failed to act" is handled per-evaluator, not by a
shared abstention primitive I could find. In TC-01's evaluator, "no tool call and an answer from
memory" is lumped into the generic FAIL branch alongside other wrong routings — there's no
separate signal distinguishing deliberate restraint from inertia in that particular case, because
TC-01 isn't a restraint scenario. For scenarios that *are* about restraint (D, K, TC-75/76/77),
the evaluator checks for a specific textual signature (e.g., a clarifying question, an explicit
refusal phrase) rather than merely "no tool call," which is how it separates a model that
correctly asked for clarification from one that just produced no useful output. The doc
explicitly flags this pattern as fragile — refusal detection via keyword lists like `("cannot",
"can't", "not able")` can misclassify differently-phrased refusals as FAIL.

## 5. Tool errors, denials, timeouts

**Tool-level errors:** yes, deterministically injectable. `--error-rate` is listed in the
methodology's comparison table as a differentiator ("Error injection ✓ (`--error-rate`)"), and
Category E "Error Recovery" (3 scenarios) plus hard-mode TC-72 ("Cascading error recovery" — a
primary read fails, model must use its documented backup and complete the chain) exist
specifically to test recovery. I did not open the `--error-rate` implementation itself, so I
can't describe its exact injection mechanics (fixed scenarios vs. random-rate across any
scenario) beyond what the docs state.

**Permission/capability denial:** TC-76 ("Missing capability") tests refusing an unsupported
mutation (cancel/refund) while allowing an adjacent valid read-only call — this is the closest
analogue to a permission-denial case, but it's simulated as "the tool doesn't exist / isn't
offered" rather than "the tool exists but returns 403."

**Infrastructure failures (timeout, connection error, server error) are explicitly NOT
graded as model failures.** This is a first-class, well-documented design decision:
`FailureKind.TIMEOUT`, `CONNECTION_ERROR`, and `SERVER_ERROR` are collected into an
`INFRASTRUCTURE_FAILURE_KINDS` frozenset (`domain/scenarios.py`) and those scenarios are dropped
from **both** numerator and denominator of the score — "a slow or overloaded endpoint cannot
depress a model's measured quality" (inline comment, `domain/scenarios.py`; corroborated by
`docs/methodology.md`: "A timeout, connection error, or persistent 429/5xx measures the serving
environment, not the model"). `completion_rate` and `excluded_scenarios` report how much of the
suite was actually graded, and the README warns "a run graded on 60 of 69 scenarios is not
comparable to one graded on all 69." Accuracy plugins (GSM8K/MMLU/IFEval) use the opposite
policy — the stricter total-item denominator — specifically so a timeout can't inflate a partial
run into a perfect score.

## 6. Multi-turn

Multi-turn agentic loop, not single-shot. `runner/orchestrator.py`: `MAX_TURNS = 12` module
constant (comment: "model → tool_calls → mock results → model → … (up to max_turns)"), with a
per-scenario `max_turns_override` for deep workflows (the methodology doc separately cites an
8-turn default for the standard scenario budget, which I read as the constructor default even
though the module ceiling is 12 — I did not fully reconcile the two numbers by reading the
signature). `follow_up_messages` on `ScenarioDefinition` queues additional user turns after the
initial exchange, letting a scenario be genuinely multi-turn (e.g. hard-mode TC-74: "Retain four
rounds of draft changes and create and notify exactly once after authorization").

**Turn-cap distinguished from genuine failure:** yes, explicitly, via a `budget_exhausted`
boolean tracked through the whole turn loop in `orchestrator.py`:

```python
# True when the loop ends because the turn budget ran out before the model
# produced a final answer (or before exhausting the follow-up queue).
# Distinguishes turn-budget exhaustion from evaluator failures.
budget_exhausted = True
...
turn_budget_exceeded=budget_exhausted,
```

and the result plumbs a distinct `FailureKind.BUDGET_EXCEEDED` value, separate from
`wrong_tool`/`wrong_args`/etc. So a run that hit the turn cap is tagged differently from one that
made an active wrong choice — this is a clean, real mechanism, worth borrowing directly. Note
`turn_budget_exceeded` was still only set when `evaluation.status != ScenarioStatus.PASS`
(line 639 of the file, from the grep) — i.e. it's recorded even on a technically-passing run that
happened to also exhaust budget on its last turn, which is a sane edge-case choice.

Multi-turn authorization scenarios also track *when* in the turn sequence each tool call
happened: "Runtime tool-call traces record the zero-based user-message phase that was active when
each call occurred… to reject a correct-looking write made before the authorizing follow-up"
(`docs/methodology.md`). That's a specific, non-obvious mechanism for catching a model that does
the right action too early.

## 7. Statistics

`--trials N` runs N repeats "for statistical analysis" (`docs/cli-reference.md`), and the
methodology doc references "Pass@k / Pass^k" metrics (`docs/methodology.md`'s comparison table:
"Pass@k / Pass^k ✓ (`--trials`)"), explicitly crediting the framing to Claw-Eval (Ye et al. 2026,
arXiv:2604.06132) — "Pass^3 drops up to 24% under error injection while Pass@3 stays stable."
**I could not locate the aggregation code** (I grepped `application/service.py` and
`domain/scenarios.py` for `trial`/`pass_at`/`pass_hat` and got no hits in the files I fetched;
the logic likely lives in a CLI or application module I didn't open, e.g. `cli/bench.py` or
`application/run_config.py`). So I can't confirm from source: the sampling unit (per-scenario
seed variance vs. per-call), whether confidence intervals are reported at all, or what n is
typical in published runs. The docs never mention confidence intervals — only Pass@k and Pass^k
point estimates. This is a real gap in what I verified; do not assume CIs exist.

One adjacent, verified fact: `RunContext.seed` and a debug-log comment in `orchestrator.py` note
that "seed only controls logit sampling (greedy at temperature=0 is already deterministic)" and
that full run-to-run reproducibility additionally needs "stable server state, no concurrent
requests, and consistent KV-cache configuration" — a real caveat about what determinism can and
can't guarantee even with mocked tools.

## 8. Harness

Python (Python 3.13 required for CI, 3.11 supported after-merge per README), packaged with `uv`,
installable via `uv tool install git+https://...`. It talks to **any OpenAI-compatible
`/v1/chat/completions` endpoint** — vLLM, SGLang, LiteLLM, llama.cpp, NInfer, plus hosted Gemini
via a dedicated adapter (`src/tool_eval_bench/adapters/gemini.py`, `openai_compat.py`). It is
explicitly self-hosted/local-first — no cloud model API is required to run it (README: "Scope…
It is not a full agentic system benchmark"). Persistence is SQLite (`data/benchmarks.sqlite`) and
Markdown reports; runs checkpoint per-scenario so Ctrl-C only costs the in-flight scenario, and
`tool-eval-bench resume RUN_ID` continues.

Reusability: it exposes a documented Python API (`tool_eval_bench.api.run_benchmark(...)`,
returning a "versioned envelope" with `final_score`, `rating`, `safety_warnings`,
`deployability`) and a published config schema (`tool_eval_bench.schema.get_schema()`) — this
looks genuinely reusable as a library, not just a CLI, for anyone building on top of an
OpenAI-compatible endpoint. It would **not** be directly reusable for grading a Claude-Code-style
agent-orchestration system, though, because its entire runner is built around the
`/v1/chat/completions` tool-call wire format and a single flat mock-tool-call loop — it has no
concept of sub-agent spawning, delegation, or an orchestrator escalating to a human mid-run (see
§9).

## 9. What to borrow, what to avoid, what it doesn't cover

**Borrow:**
- **The infrastructure-failure exclusion pattern.** Timeouts/connection/server errors dropped
  from numerator *and* denominator, reported separately via `completion_rate` and
  `excluded_scenarios`, with an explicit warning against comparing runs at different completion
  rates. Any orchestration benchmark that talks to real or flaky tool backends needs this or its
  results will conflate "the tool was down" with "the agent was bad."
- **`budget_exhausted` / `turn_budget_exceeded` as a distinct, first-class failure reason**,
  separate from the wrong-tool/wrong-args taxonomy. Directly applicable to grading whether a
  governor/escalation loop got cut off by its own turn cap vs. genuinely failed.
- **The `FailureKind` taxonomy as a whole** — a small, fixed vocabulary of *why* something failed
  (wrong_tool, wrong_args, missing_step, forbidden_action, budget_exceeded, timeout,
  connection_error, server_error, model_crash, evaluator_error, partial) is a much more useful
  reporting primitive than a bare pass/fail, and composes cleanly with whatever positive/negative
  framing gets chosen.
- **PASS/PARTIAL/FAIL over binary**, with an explicit rationale (reproducibility, discriminative
  power, capturing "did the work but reported it badly" separately from "didn't do the work").
- **The reasonable-trace policy** — grading against semantic/observable outcomes and known-good
  equivalents rather than one canonical trace, explicitly allowing parallel/reordered independent
  calls. Necessary for anything with real agent nondeterminism.
- **Deterministic payload noise on mock responses**, to stop evaluators (and models) from
  overfitting to hand-trimmed fixtures.
- **Turn-phase-aware evaluation** for multi-turn authorization (rejecting a correct-looking write
  made before the authorizing follow-up) — directly relevant to grading escalate-then-act
  sequences.

**Avoid / doesn't transfer:**
- Its "statistics" story is thin and, going by what I could verify, essentially unproven from the
  outside: `--trials` and "Pass@k/Pass^k" are asserted in prose and a comparison table, but I
  could not find the aggregation code, and there is no evidence of confidence intervals or a
  documented sampling unit anywhere in the docs I read. Don't cite its Pass@k numbers or its
  statistical rigor as a model to imitate without re-deriving the method from source.
- Single flat mock-tool-call loop against one model — no sub-agent spawning, no delegation to
  another agent, no distinct "orchestrator vs. worker" roles. Nothing to borrow here structurally
  for a multi-agent bench; it would need to be built from scratch.
- No self-approval concept (an agent grading or authorizing its own action) — out of scope for
  a benchmark whose unit of work is one model answering one scenario.
- No escalate-to-human primitive. Its closest analogue (Category D/K restraint, TC-71 "ask for
  clarification instead of guessing") is scored as a text-pattern match on the model's own
  answer, not as a distinguishable "call an escalation channel" action — there's no tool in its
  mock toolset representing "ask a human and wait."
- No state/lifecycle handling beyond one run's checkpoint-and-resume. It has nothing like a
  session, workflow, or ongoing task state that would map onto grading a long-lived orchestration
  system's state machine.

**Does not cover, that an agent-orchestration bench would need:**
- **TP/FP/TN/FN framing entirely absent.** If the new bench is being designed around that
  framing, tool-eval-bench offers no precedent to adapt — its PASS/PARTIAL/FAIL + FailureKind
  design is a genuinely different axis (outcome quality tiers + failure taxonomy, not a
  classification confusion matrix). Positive-class declaration, per-case or global, isn't a
  concept it has at all. Worth naming honestly to whoever is designing the new bench: this is a
  gap they'll be filling from scratch, not adapting.
- Delegation correctness (did the orchestrator pick the right sub-agent / did a spawned agent
  have the right scope) — no analogue.
- Self-approval / same-context review — no analogue.
- Escalation-to-human as a distinguishable, gradable action — no analogue (closest is text-based
  refusal/clarification detection).
- Multi-agent spawn correctness (right agent, right permissions, right isolation) — no analogue;
  its toolset is a fixed, flat list of mock functions, never other agents.

## 10. Source-verified mechanics

Full files fetched and read for this section:
`src/tool_eval_bench/runner/orchestrator.py` (929 lines, read in full),
`src/tool_eval_bench/domain/scenarios.py` (551 lines, read in full),
`src/tool_eval_bench/cli/run_io.py` (164 lines, read in full),
`src/tool_eval_bench/cli/dispatch.py` (grepped, 1670 lines — not read in full),
`src/tool_eval_bench/application/service.py` (grepped).
No fetch failures this round; every URL below resolved.

### 10.1 Infra-failure exclusion — verified, and it has a real gap at the trial layer

**Classification** happens in `_classify_runtime_error(exc)`
(`runner/orchestrator.py:74-94`) — it only fires on a genuine Python exception raised while
talking to the model server, not on anything inside a scenario:

```python
def _classify_runtime_error(exc: BaseException) -> str:
    if isinstance(exc, asyncio.TimeoutError):
        return FailureKind.TIMEOUT
    if isinstance(exc, httpx.TimeoutException):
        return FailureKind.TIMEOUT
    if isinstance(exc, httpx.ConnectError | httpx.ReadError | httpx.RemoteProtocolError):
        return FailureKind.CONNECTION_ERROR
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status >= 500 or status in RETRYABLE_STATUS_CODES:
            return FailureKind.SERVER_ERROR
        return FailureKind.WRONG_ARGS   # 4xx → treated as a model-caused error
    return FailureKind.MODEL_CRASH
```

Only `TIMEOUT`, `CONNECTION_ERROR`, `SERVER_ERROR` are infra (`domain/scenarios.py:98-107`,
`INFRASTRUCTURE_FAILURE_KINDS` frozenset). A 4xx from the server is attributed to the model
(`WRONG_ARGS`) — the code's own reasoning, in a comment right there, is that a 400/422 usually
means the model emitted malformed tool-call arguments, so it should count against the model, not
the endpoint. **This exception path is separate from `--error-rate` injected errors** (§10.3) —
injected 429/500/timeout payloads are placed inside a tool-call *result* in the conversation and
scored as an in-scenario recovery test (Category E), never routed through
`_classify_runtime_error` or excluded from scoring. Conflating these two would be a real
mistake — I want to flag that explicitly since the original report didn't distinguish them.

**Exclusion** happens once per completed run, in `score_results()`
(`runner/orchestrator.py:783-806`):

```python
excluded_ids = {r.scenario_id for r in results if r.is_infrastructure_failure}
scored_results = [r for r in results if r.scenario_id not in excluded_ids]
```

`is_infrastructure_failure` (`domain/scenarios.py:324-333`) is `status == FAIL and failure_kind in
INFRASTRUCTURE_FAILURE_KINDS`. Both the numerator (`total_points`) and the denominator
(`max_points = len(gradable_scenarios) * 2`) are computed only over `scored_results` /
`gradable_scenarios` — confirming the README/docs claim for a **single run**: infra failures are
genuinely dropped from both sides of the fraction, not scored as 0. `completion_rate` is
`len(gradable_scenarios) / len(all_scenarios)`.

**What happens across `--trials N`, i.e. the part the docs don't say:** each trial's
`ModelScoreSummary` already had infra failures correctly excluded *from that trial's own
final_score* — but critically, `score_results()` stores the **unfiltered** result list on the
summary: `scenario_results=results,` (`runner/orchestrator.py:911`, comment right above it:
"Every result is retained for reporting/traces, including excluded ones"). Cross-trial
aggregation, `aggregate_trials()` (`cli/run_io.py:93-164`), then does this per scenario:

```python
for summary in summaries:
    result = next((item for item in summary.scenario_results if item.scenario_id == scenario_id), None)
    if result:
        points.append(result.points)
passed_once = any(point == 2 for point in points)
passed_always = all(point == 2 for point in points)
```

It pulls straight from `summary.scenario_results` — the unfiltered list — with no re-application
of the infra-failure filter. An infra-failed `ScenarioResult` always carries `points=0`
(constructed at the two exception sites, `runner/orchestrator.py:546-549` and
`runner/orchestrator.py:763-766`, both literally `points=0`). So **a scenario that infra-fails on
one trial out of N is not dropped and not scored on the surviving trials only — it is scored as a
0 in that trial's contribution to the scenario's cross-trial `mean`, `stddev`, `pass_at_k`, and
especially `pass_hat_k`** (`pass_hat_k` requires `all(point == 2 for point in points)`, so a
single infra-caused 0 among otherwise-perfect trials makes that scenario register as
"unreliable" — indistinguishable from a genuine capability inconsistency). This is not a
survivorship filter (nothing is silently dropped) — it's the opposite defect: infra noise from
one trial leaks into and depresses the reliability statistic that `--trials`/Pass^k exists to
measure. The single-run `final_score` numbers used for `final_score_mean`/`stddev`/the bootstrap
CI (§10.4) *are* each individually infra-adjusted per trial, so only the **per-scenario**
cross-trial stats (`mean`, `stddev`, `pass_at_k`, `pass_hat_k` in `per_scenario`) carry this
defect, not the top-line `final_score_mean`. Worth being precise about that distinction if this
gets cited.

**Verdict: sound for a single run, unsound (in a specific, narrow way) for `--trials` aggregation.**
Borrow the single-run exclusion mechanism as-is; if we also borrow trial repeats, re-apply the
infra filter before computing per-scenario cross-trial reliability, or we'll inherit this defect.

### 10.2 Turn-budget exhaustion — verified: it is scored as a genuine capability failure, not excluded, not auto-zeroed

`budget_exhausted` (`runner/orchestrator.py:408`) starts `True` and is set `False` at exactly one
place, when the turn loop exits *cleanly* — model stopped calling tools and there are no more
queued follow-ups (`runner/orchestrator.py:485-499`):

```python
if not result.tool_calls:
    if follow_ups:
        ...
        continue
    state.final_answer = result.content
    budget_exhausted = False
    break
```

If the `for turn in range(1, max_turns + 1)` loop runs out without ever hitting that `break`
(model kept issuing tool calls every turn through the cap), `budget_exhausted` stays `True` and
the loop falls through to evaluation on **whatever partial state accumulated** — the scenario's
normal `evaluate()` function still runs, on real (if incomplete) `state.tool_calls` /
`state.final_answer` (which falls back to the last assistant message content, or the literal
string `"Model did not return a final answer."` if none exists —
`runner/orchestrator.py:564-568`). The result:

```python
failure_kind=(
    FailureKind.BUDGET_EXCEEDED
    if budget_exhausted and evaluation.status != ScenarioStatus.PASS
    else _classify_evaluation_failure(state, evaluation)
),
turn_budget_exceeded=budget_exhausted,
```
(`runner/orchestrator.py:637-644`)

So: **a turn-capped run is graded on its partial progress through the same evaluator as every
other run, not given an automatic 0 and not excluded from scoring.** `BUDGET_EXCEEDED` is
recorded as the `failure_kind` only when budget ran out *and* the evaluator didn't call it a
PASS — meaning if a model happens to complete the task correctly on the very last turn before the
cap, the result is a normal PASS with `turn_budget_exceeded=True` still logged as a diagnostic
(the field is set unconditionally to `budget_exhausted`, independent of the score). `FailureKind
.BUDGET_EXCEEDED` is **not** in `INFRASTRUCTURE_FAILURE_KINDS`
(`domain/scenarios.py:94-107` only lists `TIMEOUT`/`CONNECTION_ERROR`/`SERVER_ERROR`) — so unlike
an infra failure, a turn-cap failure counts fully against the model in both numerator and
denominator of the run's score. This directly matches the team's stated worry: **tool-eval-bench
does record turn-cap exhaustion as a capability failure** (with a distinguishable tag in the
report so it's at least legible after the fact), it does not treat it as an infra/environment
condition the way it treats a timeout.

### 10.3 `--error-rate` injection — verified: seeded per-scenario if `--seed` is passed, otherwise genuinely non-reproducible; no per-scenario opt-out

Mechanically, on every tool call, unconditionally when `error_rate > 0`
(`runner/orchestrator.py:519-528`):

```python
mock_result = scenario.handle_tool_call(state, record)
if error_rate > 0:
    mock_result = _maybe_inject_error(mock_result, error_rate, rng=error_rng)
```

`_maybe_inject_error` (`runner/orchestrator.py:129-146`):

```python
_INJECTED_ERRORS = [
    {"error": "Rate limit exceeded. Please retry after 2 seconds.", "status": 429},
    {"error": "Internal server error. The service is temporarily unavailable.", "status": 500},
    {"error": "Request timed out. The service did not respond in time.", "status": 503},
]

def _maybe_inject_error(result, error_rate, rng=None):
    _rng = rng or random
    if error_rate <= 0 or _rng.random() >= error_rate:
        return result
    return _rng.choice(_INJECTED_ERRORS)
```

It replaces the entire mock tool result with one of three fixed error payloads, uniform choice —
so with `error_rate=r`, each individual tool call independently has probability `r` of coming
back as one of 429/500/(mislabeled-as-503)-timeout instead of its real payload. This lands as a
tool-role message in the conversation, so it's the model's in-context recovery behavior being
tested (Category E), not an orchestrator-level fault — confirms and sharpens §10.1's boundary.

**Seeding — this is the important finding.** `error_rng` is only constructed when a global
`--seed` is supplied:

```python
error_rng: random.Random | None = None
if seed is not None and error_rate > 0:
    error_rng = random.Random(seed + _scenario_seed_offset(scenario.id))
```
(`runner/orchestrator.py:375-377`; `_scenario_seed_offset` is a stable
`sha256(scenario_id)`-derived int, `runner/orchestrator.py:124-126`, so each scenario gets its
own reproducible-but-distinct offset from the same run seed.)

If `--seed` is **not** passed, `error_rng` stays `None`, and `_maybe_inject_error`'s
`rng or random` falls back to the **process-global `random` module** — genuinely unseeded,
non-reproducible, order- and process-state-dependent randomness. So: `--error-rate` runs are
deterministic and reproducible *only* when combined with `--seed`; run without `--seed`, results
are not reproducible run-to-run, exactly the failure mode the team flagged as disqualifying.
**Confirmed: don't copy unseeded error injection; the mechanism is fine, but only when seeding is
mandatory or at minimum always-on-by-default, not opt-in.**

No per-scenario opt-out exists. `ScenarioDefinition` (`domain/scenarios.py:183-230`, read in
full) has no field controlling error injection — `error_rate` is a single run-level parameter
applied uniformly to every tool call in every scenario in the run. A scenario cannot exempt
itself.

### 10.4 `--trials` / Pass@k / Pass^k — implemented (not just documented), full code found and read; the Claw-Eval citation checks out

Not a gap after all — the aggregation code lives in a file the first pass didn't fetch:
`src/tool_eval_bench/cli/run_io.py:93-164`, function `aggregate_trials(summaries)`, called from
`cli/dispatch.py:95` (`from tool_eval_bench.cli.run_io import aggregate_trials as
_aggregate_trials`) after a full re-run of every scenario for each of `trials` iterations
(`cli/dispatch.py:1391`, `for t in range(2, trials + 1): ... Running trial {t}/{trials}`) — each
trial is a complete independent pass through the whole suite, not a sub-sample.

What it actually computes, read directly from source:

- **Per-scenario, across the `k` trials:** `mean`, `stddev` (population via `statistics.stdev`,
  so `len(points) > 1` required or it's `0.0`), the raw per-trial `points` list,
  `pass_at_k = any(point == 2 for point in points)`, `pass_hat_k = all(point == 2 for point in points)`.
- **Suite-wide:** `pass_at_k` / `pass_hat_k` are then the *percentage of scenarios* that,
  respectively, passed at least once / passed every time across the k trials —
  `100 * pass_at_k_count / total_scenarios`. So the sampling unit for Pass@k/Pass^k is
  **scenarios**, aggregated over a fixed `k = trials` (not the classical Codex-paper Pass@k,
  which estimates probability of success over a large `n` via combinatorics — here it's a direct
  "did it pass in any/every one of exactly k actual runs" with no unbiased-estimator correction).
- **`final_score_ci95`:** a genuine bootstrap, not a documentation claim —
  `bootstrap_ci(values, n_resamples=1000, ci=0.95)` (`cli/run_io.py:68-79`), computed over the
  list of **per-trial `final_score`s** (one scalar per trial, so `n = trials`, typically as low
  as 2-3 given the README's own example is `--trials 3`):

  ```python
  rng = random.Random(42)
  means = sorted(mean(rng.choices(values, k=len(values))) for _ in range(n_resamples))
  ...
  return (round(means[low_index], 1), round(means[high_index], 1))
  ```

  Fixed seed 42, so the bootstrap itself is reproducible. But bootstrapping a 95% CI from n=3
  raw values is close to meaningless as an uncertainty estimate — the resampled means can only
  take on a handful of distinct values (compositions of 3 numbers drawn with replacement), so
  the "1000 resamples" figure overstates the precision. This is directly analogous to
  [[underpowered-at-n30]] — same failure shape (statistical machinery applied correctly but to a
  sample size that can't support the claimed precision), here worse (n as low as 2-3, not 30).
  Report the interval if this gets borrowed, but don't present it as if the CI width means what
  it would at n=30+.
- No confidence interval or variance figure is computed per-scenario across trials beyond
  `stddev` on `points` (which only takes values in {0,1,2}, k samples).

**Citation check against arXiv:2604.06132** ("Claw-Eval: Towards Trustworthy Evaluation of
Autonomous Agents") — fetched the abstract directly from arxiv.org/abs/2604.06132. It states:
"The scoring protocol evaluates Completion, Safety, and Robustness, with Average Score, Pass@k,
and Pass^k across three trials to distinguish genuine capability from lucky outcomes... (2)
Capability does not imply consistency, with Pass@3 remaining stable under error injection while
Pass^3 dropping by up to 24 percentage points." This matches tool-eval-bench's
`docs/methodology.md` claim ("Pass^3 drops up to 24% under error injection while Pass@3 stays
stable") almost verbatim, and the paper does use `k=3` trials as tool-eval-bench's own examples
also default to (`--trials 3`). **Unlike the citation problem flagged elsewhere in this project,
this citation checks out — it accurately represents what the cited paper claims.** I did not
verify tool-eval-bench's own reported *numbers* (e.g. whether their own Pass@3/Pass^3 gap
matches 24pp) against a published run, only that the methodological framing they attribute to
Claw-Eval is accurately stated from the abstract.
