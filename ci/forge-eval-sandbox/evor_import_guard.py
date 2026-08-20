"""
ci/forge-eval-sandbox/evor_import_guard.py — enforce the stdlib-only candidate
contract for the forge-junior eval.

WHY THIS EXISTS (measured, not assumed):
  This host has numpy 2.2.6, scikit-learn 1.9.0, pandas 3.0.3 and torch 2.12.1
  installed. ci/docker/Dockerfile installs numpy + scikit-learn into the bench
  venv on a best-effort line that ends in `|| echo "sklearn optional path
  skipped"`, so the bench image may or may not have them depending on whether
  that install succeeded at build time.

  That leaves two failure modes, both fatal to the measurement:

  1. NOT REPRODUCIBLE. The same case graded on the host and in the container
     would be answering different questions, so a tier comparison run in one
     place could not be trusted in the other.

  2. THE EVAL STOPS MEASURING ANYTHING. Every auc_floor in
     evals/forge-junior/cases.json is calibrated against a REFERENCE CANDIDATE
     that implements the algorithm in pure stdlib (see
     harness/tests/fixtures/tabular-ladder/candidates/ and the ladder docstring
     in benchmarks/tabular-ladder/evaluate.py). If third-party libraries are
     importable, `from sklearn.ensemble import GradientBoostingClassifier`
     clears the hardest floor in three lines. Both tiers would score 100% and
     the eval would report "haiku matches sonnet" while having measured only
     which tier remembered that sklearn exists.

  Stating the constraint in the prompt is not enough — that is the same
  "reads as enforced, inert at runtime" shape this codebase keeps producing.
  So it is enforced here, in the harness, identically everywhere.

The guard is installed BEFORE the evaluator is loaded (see runCandidate in
ci/forge-eval.mjs), and the evaluator itself is pure stdlib, so nothing
legitimate is affected.
"""

import sys

# Top-level package names the candidate may not import. Denylist rather than a
# stdlib allowlist: an allowlist silently breaks whenever the evaluator or a
# legitimate candidate reaches for a stdlib module nobody thought of, and that
# failure would look like the candidate's fault.
BLOCKED = frozenset({
    "numpy",
    "scipy",
    "sklearn",
    "pandas",
    "polars",
    "torch",
    "torchvision",
    "tensorflow",
    "keras",
    "jax",
    "jaxlib",
    "xgboost",
    "lightgbm",
    "catboost",
    "statsmodels",
    "paddle",
    "transformers",
    "sentence_transformers",
})


class _BlockedImportFinder:
    """A sys.meta_path finder that refuses the blocked top-level packages.

    Sits at the FRONT of meta_path so it is consulted before any real finder,
    including any that a candidate might install itself.
    """

    def find_module(self, fullname, path=None):  # legacy API, harmless to keep
        self._maybe_block(fullname)
        return None

    def find_spec(self, fullname, path=None, target=None):
        self._maybe_block(fullname)
        return None

    @staticmethod
    def _maybe_block(fullname):
        root = fullname.split(".", 1)[0]
        if root in BLOCKED:
            raise ImportError(
                f"'{root}' is not available to candidates in this evaluation. "
                "The candidate contract is Python standard library only "
                "(random, math, json, os). See ci/forge-eval-sandbox/"
                "evor_import_guard.py for why this is enforced rather than "
                "merely requested."
            )


def install():
    """Install the guard, and drop anything already-imported from the denylist."""
    for name in list(sys.modules):
        if name.split(".", 1)[0] in BLOCKED:
            del sys.modules[name]
    if not any(isinstance(f, _BlockedImportFinder) for f in sys.meta_path):
        sys.meta_path.insert(0, _BlockedImportFinder())
