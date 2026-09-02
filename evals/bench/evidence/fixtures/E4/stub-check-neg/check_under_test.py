"""no_label_contamination — the check under repair.

Check 3: sha256(test_sample_i) not in {sha256(train_sample_j)}.

Returns True (clean), False (contaminated), or None (not evaluated). It cannot
cross-check what it is not given: with no training hashes it returns None, which
the caller records as *not evaluated* rather than as *passed*. See
`mcp/src/tools/record.ts:162` — "absence of a failure verdict is not evidence of
integrity."
"""


def check(case, root):
    train_hashes = set(case.get("train_hashes") or [])
    if not train_hashes:
        return None
    overlap = set(case["test_hashes"]) & train_hashes
    return not overlap
