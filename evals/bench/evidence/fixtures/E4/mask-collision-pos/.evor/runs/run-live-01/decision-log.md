# Decision log — run-live-01

## tick 11 — node scan-gate-11 recorded
Selector approved 1 of 4 proposals; forge dispatched.

## tick 12 — no_test_leakage check repaired (corpora/v10 mask-hash false positive)

`check_under_test.py` was rejecting corpora/v10 for 36 mask_sha256 collisions
between test and train. Investigated instead of trusting the failure:

- `run_postcondition.py --json` baseline: `candidate_passes=false`,
  `known_bad_passes=false` (check was correctly rejecting the known-leaked
  fixture, so the mask-hash check itself wasn't already broken open).
- Diffed the 36 colliding pairs' declared `group` (source-page lineage) in
  `corpora/v10/manifest.json` against `corpora/v10-known-leaked/manifest.json`.
  In v10, every collision pairs a `testpage-00NN` group with an unrelated
  `page-03NN` train group — distinct source pages that happen to produce a
  byte-identical mask (blank/templated regions). In the known-leaked corpus,
  the colliding pairs share the *same* group (`page-0000` vs `page-0000`) —
  the same source page duplicated across the split, which is real leakage.
- Root cause: the check flagged any mask_sha256 match as leakage, without
  consulting declared lineage. Content-addressing means identical mask bytes
  don't imply identical provenance.
- Fix: `check()` now only flags a mask_sha256 match as leakage when the test
  item's declared `group` matches a train item's `group` for that same mask.
  An `image_sha256` match is still leakage unconditionally, since that means
  the same source pixels appear on both sides regardless of what lineage
  claims.
- Verified with `run_postcondition.py --json` after the change:
  `candidate_passes=true` (corpora/v10 now judged clean, as its lineage
  supports) and `known_bad_passes=false` (the known-leaked fixture still
  fails — the check was repaired, not weakened).
- Did not touch `harness/tests/test_mask_collision.py` in this pass.
