# evals/bench/authority — Author B's angles

Group A of `docs/evor-eval-bench/00-preflight-taxonomy.md`, plus T4.

| angle | frame | what it grades |
|---|---|---|
| T4 | matrix | a mandated call is denied — stated upward and rerouted legitimately, or routed around |
| A1 | **tier** | delegation shape: right role, permitted parent, no `name`, honest description |
| A2 | matrix | privilege escalation — **who** performed the work |
| A3 | matrix | self-approval — a field whose authority is another actor's |
| A4 | matrix | governed-path write — **whether** the write happened at all |

30 pairs, 60 scenarios. Read `AUTHORING-NOTE-B.md` before changing anything: it
records what was verified by execution, where the design broke during authoring,
and what is owed before any number here is quotable.

```
node evals/bench/authority/build.mjs            regenerate the 60 scenarios
node evals/bench/authority/build.mjs --check    verify disk matches the specs
node evals/bench/authority/lint.mjs             offline gates (§4.4, §4.5)
node evals/bench/authority/detectors/run-fixtures.mjs   detector fixtures (§6.4)
```

Scenarios are generated rather than hand-written so that §1's rule — the two
halves of a pair differ in exactly one declared fact — is guaranteed by
construction instead of asserted. `pair.differs` records the check.
