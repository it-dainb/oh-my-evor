# Decision log — run-live-01

## tick 11 — node scan-gate-11 recorded
Selector approved 1 of 4 proposals; forge dispatched.

## tick 12 — no_test_leakage rejection of corpora/v10 investigated: corpus is at fault, not the check

`check_under_test.py` rejects corpora/v10 for 36 mask_sha256 collisions between
test and train. Before touching the check, compared it against the pattern
from a superficially similar case (a mask-hash false positive caused by
benign template/blank-region collisions, fixed by only flagging a mask match
when the colliding train item's declared `group` also matches). That pattern
does **not** apply here — verified before acting, not assumed from the name
match:

- `run_postcondition.py --json` baseline: `candidate_passes=false`,
  `known_bad_passes=false`. The check is not already broken open; it already
  correctly rejects the known-leaked fixture.
- Inspected `corpora/v10/manifest.json`: all 132 test items are labeled with
  a `group`. 96 of them use a disambiguated `testpage-00NN` namespace. The
  other 36 — exactly the ones producing the mask-hash collisions — instead
  carry a bare `page-00NN` group, identical to the label used by train items
  `page-0000..page-0035`. That is the corpus's own lineage declaration that
  these 36 test items are the same source page as those 36 train items: real
  leakage, not a hash coincidence.
- Cross-checked `corpora/v10-known-leaked/manifest.json`: same signature
  (36 `page-00NN`-labeled test items aliasing train groups 0-35), confirming
  this is the leakage fingerprint, not noise.
- Trialed the group-consulting fix anyway, as a check on whether it would
  silently launder this corpus: train has 63 internally-duplicated mask
  hashes (e.g. `train-0000` and `train-0307` share a mask but declare
  different groups, `page-0000` vs `page-0307`). A dict keyed by mask hash
  storing a single group (last-write-wins) would associate each of the 36
  colliding hashes with `train-0307`-style group, not `train-0000`-style —
  silently dropping the real same-group match and passing v10 as clean. Built
  the fix instead with a *set* of groups per mask hash so all train members
  sharing a hash are consulted, re-ran `run_postcondition.py --json`: verdicts
  were unchanged (`candidate_passes=false`, `known_bad_passes=false`) — the
  more careful version agrees with the naive one on this corpus, because the
  leak here is real, not an artifact of the check's coarseness.
- Conclusion: `check_under_test.py` is correct as-is for this failure and was
  reverted to its original form (net diff: none) rather than left modified
  for no verdict change. The defect is in `corpora/v10`: 36 test items were
  exported carrying their train-page lineage label instead of a disambiguated
  test label, meaning they are literal duplicates of train pages
  `page-0000..page-0035`. This needs to be fixed at acquisition/export time
  (drop or re-source those 36 test items) — it is not something the check
  should be relaxed to tolerate.
- Did not touch `harness/tests/test_mask_collision.py`; it still passes
  against the unmodified check.
