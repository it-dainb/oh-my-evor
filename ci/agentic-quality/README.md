# ci/agentic-quality

Agentic quality evals for the oh-my-evor plugin. These run real Claude calls against
the plugin inside the `evor-ml-test` Docker image and score the outputs.

## Why agentic evals?

Deterministic unit tests verify structural invariants (ForgeStructureGate, fitness
formulas, contract schemas). They cannot verify that the agents actually reason
correctly, retrieve real citations, or produce useful proposals. Agentic evals close
that gap by running live Claude calls and scoring the structured outputs.

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker image `evor-ml-test` | Built by `ci/build_ml_image.sh` |
| `$HOME/.claude/.credentials.json` | Real Claude subscription; mounted read-write |
| `ANTHROPIC_API_KEY` (optional) | Fallback if credentials file absent |
| `python3` | For scoring scripts; stdlib only |

The credentials file must be at the **exact** path `$HOME/.claude/.credentials.json`.
The mount is: `-v "$HOME/.claude/.credentials.json:/root/.claude/.credentials.json:rw"`.

## Scripts

### `researcher_eval.sh`

Runs the Sage researcher scenario (self-supervised pre-training on IMDB) and scores
the output structure.

```bash
bash ci/agentic-quality/researcher_eval.sh
```

- Requires `--permission-mode bypassPermissions`: Sage uses academic MCPs (Consensus)
  and WebSearch; without bypass those tool calls are denied.
- Max turns: 12. Estimated cost: $0.05–0.20 per run.
- Output: `ci/out/researcher-raw.json`, `ci/out/researcher-report.json`.

**Pass criteria:** output is well-formed JSON with a `findings` list; every finding
has required fields (`title`, `source_url`, `finding`, `confidence`, `trust_level`);
no hedged language in `finding` fields.

Note: the scorer marks all citations as `unverifiable_by_scorer` — live URL resolution
requires the MCP tools available inside the run container. This is expected and does
NOT cause a failure.

### `dreamer_eval.sh`

Runs the Dreamer/Mutagen scenario at two wildness levels (0.3 and 0.9) and scores
proposal structure and distinct-angle coverage.

```bash
bash ci/agentic-quality/dreamer_eval.sh
```

- Max turns: 8. Estimated cost: $0.10–0.30 per run.
- Output: `ci/out/dreamer-w03.json`, `ci/out/dreamer-w09.json`,
  `ci/out/dreamer-report.json`.

### `judge.sh`

Runs the LLM judge to score Dreamer proposals on a 1–10 rubric across five dimensions
(novelty, feasibility, expected_gain_pp, specificity, citation_quality).

```bash
bash ci/agentic-quality/judge.sh [path/to/proposals.json]
```

- Default input: `ci/out/dreamer-w09.json` (run `dreamer_eval.sh` first).
- Max turns: 3. Estimated cost: $0.03–0.10 per run.
- Output: `ci/out/judge-raw.json`, `ci/out/judge-report.json`.

**Scoring formula:** `composite = novelty*0.25 + feasibility*0.20 + expected_gain_pp*0.30 + specificity*0.15 + citation_quality*0.10`.

The judge flags gameable/degenerate proposals (e.g. predict-all-positive for recall)
in a `red_flags` list.

### `cross_domain_eval.sh`

Runs the cross-domain coverage scenario and scores how many distinct mutation families
are represented.

```bash
bash ci/agentic-quality/cross_domain_eval.sh
```

## Scenarios

| File | Description |
|---|---|
| `scenarios/researcher.txt` | Sage: self-supervised pre-training IMDB, structured JSON output |
| `scenarios/dreamer.txt` | Dreamer: text-classification mutations at specified wildness |
| `scenarios/judge.txt` | Judge: 1-10 rubric with composite score formula |
| `scenarios/cross_domain.txt` | Cross-domain coverage scenario |

## Scoring scripts

| Script | Input | Pass criteria |
|---|---|---|
| `score_researcher.py` | `researcher-raw.json` | Well-formed output, required fields, no hedging |
| `score_dreamer.py` | `dreamer-raw.json` | ≥N proposals, ≥K distinct families represented |
| `score_cross_domain.py` | `cross_domain-raw.json` | ≥5 distinct families at wildness=0.9 |

## Output files (`ci/out/`)

All output files are written to `ci/out/` (gitignored). Raw files contain the full
Claude JSON output envelope; report files contain parsed scores and PASS/FAIL verdicts.

## Running all agentic evals

```bash
cd /path/to/oh-my-evor

# Researcher eval (requires bypassPermissions)
bash ci/agentic-quality/researcher_eval.sh

# Dreamer eval (no special permissions needed)
bash ci/agentic-quality/dreamer_eval.sh

# Judge eval (scores dreamer output)
bash ci/agentic-quality/judge.sh

# Cross-domain eval
bash ci/agentic-quality/cross_domain_eval.sh
```

## Cost estimate

A full agentic eval suite run costs approximately $0.20–0.60 total. All evals use
the mounted subscription credentials (no additional API key required if credentials
file is present).

## Deterministic tests

The deterministic (no-Claude) parts of the test suite run inside the ML container:

```bash
docker run --rm evor-ml-test
```

This runs all pytest tests for `harness/` (ForgeStructureGate, MetricSpec/fitness,
contract validation, tree fitness). See `ci/run_deterministic.sh` for the full
invocation.
