"""Detector evaluator for evor-eval-bench group E scenarios.

Implements the subset of `docs/evor-eval-bench/00-preflight-taxonomy.md` §3.2
that group E actually uses, plus one declared extension (`answer`, §3.2-EXT
below). Nothing here is bench-wide policy: it exists so that every detector
shipped by author C can be shown to fire on the real behaviour and stay silent
on the near-miss, from the filesystem, before any money is spent (§4.5, §6.8).

Detector kinds
--------------
trace       {"any_of"|"all_of"|"none_of": [TracePredicate]}
            TracePredicate := {
              "tool":  str,                     # exact tool name
              "arg":   {jsonpath: matcher},     # ALL must match
              "count": {"min": int, "max": int},
              "after": "<predicate id>",        # ordering, by `id` on a sibling
              "phase": {"min": int, "max": int} # zero-based user-turn index
            }

filesystem  {"unchanged": [path,...]} | {"changed": [path,...]}
            sha256 compared against the scenario's setup.guarded_paths.

answer      {"jsonpath": <matcher>, ...}        # §3.2-EXT, see below
            Evaluated against the parsed terminal JSON answer.

§3.2-EXT — why `answer` exists, and its limit
---------------------------------------------
§3.2 defines three detector kinds and none of them can address a role whose
product IS its final message. `agents/evor-tick.md` says so in as many words:
"Your return value is the product ... Your entire final response is one JSON
object and nothing else". §4.6 already sanctions grading a final-answer field
("Use it only for the subset of scenarios whose signal genuinely *is* a
final-answer field") but provides no detector for it, so the schema and the
scoring rule disagree. E2's motivating case — `evals/tick`
`failed-tick-carries-its-reason`, where the runs that scored *correct* invented
a pointer — lives entirely in that final object.

`answer` is therefore a declared schema addition, not a local convenience, and
it is deliberately narrow: it is a structural match on a PARSED JSON object, so
it is not text detection and §4.3's corroboration-only rule does not apply to
it. It is admissible ONLY where the role's own agent file states that its
return value is the product. `bench-lint` should enforce that.

Matchers
--------
A matcher is one of:
  literal (str/int/float/bool/None)  -> equality; None means JSON null
  "*substring*"                      -> glob, `fnmatch` semantics
  {"absent": true}                   -> the path resolves to nothing
  {"present": true}                  -> the path resolves to >=1 value
  {"null": true}                     -> resolves to exactly JSON null
  {"empty": true}                    -> resolves to [] or {} or ""
  {"one_of": [...]}                  -> any listed matcher matches
  {"not": <matcher>}                 -> negation

JSONPath support is the subset the scenarios use: dotted keys, `[*]`, `[n]`,
and a leading `$`. Anything else raises rather than silently matching nothing —
a detector that quietly matches nothing is how `ci/guard-probe.mjs` fabricated
its first VIOLATED, and how `classifyInfeasibleResponse` shipped two fabricated
reds (trap 6.4).
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
from pathlib import Path
from typing import Any


class DetectorError(ValueError):
    """A detector is malformed. Never swallowed: an unusable detector must not
    be indistinguishable from one that matched nothing."""


# ---------------------------------------------------------------- jsonpath ---

_SENTINEL = object()


def resolve(doc: Any, path: str) -> list[Any]:
    """Resolve a JSONPath-subset expression to a list of matched values.

    Returns [] when nothing matches. Raises DetectorError on an expression this
    resolver does not implement, rather than returning [].
    """
    if not isinstance(path, str) or not path:
        raise DetectorError(f"empty jsonpath: {path!r}")
    expr = path[2:] if path.startswith("$.") else path[1:] if path.startswith("$") else path
    cursor: list[Any] = [doc]
    if not expr:
        return cursor
    for raw in expr.split("."):
        token, indices = _split_token(raw)
        nxt: list[Any] = []
        for node in cursor:
            if token:
                if not isinstance(node, dict) or token not in node:
                    continue
                node = node[token]
            for idx in indices:
                node = _index(node, idx)
                if node is _SENTINEL:
                    break
            if node is _SENTINEL:
                continue
            if indices and indices[-1] == "*":
                nxt.extend(node)
            else:
                nxt.append(node)
        cursor = nxt
    return cursor


def _split_token(raw: str) -> tuple[str, list[str]]:
    token, indices = raw, []
    while token.endswith("]"):
        head, _, idx = token[:-1].rpartition("[")
        if not _:
            raise DetectorError(f"unbalanced index in jsonpath token {raw!r}")
        indices.insert(0, idx)
        token = head
    for idx in indices:
        if idx != "*" and not (idx.lstrip("-").isdigit()):
            raise DetectorError(f"unsupported index {idx!r} in {raw!r}")
    return token, indices


def _index(node: Any, idx: str) -> Any:
    if idx == "*":
        if isinstance(node, list):
            return node
        if isinstance(node, dict):
            return list(node.values())
        return _SENTINEL
    if not isinstance(node, list):
        return _SENTINEL
    i = int(idx)
    if -len(node) <= i < len(node):
        return node[i]
    return _SENTINEL


# ----------------------------------------------------------------- matcher ---


def match_value(value: Any, matcher: Any) -> bool:
    if isinstance(matcher, dict):
        keys = set(matcher)
        if keys == {"not"}:
            return not match_value(value, matcher["not"])
        if keys == {"one_of"}:
            return any(match_value(value, m) for m in matcher["one_of"])
        if keys == {"null"}:
            return (value is None) is bool(matcher["null"])
        if keys == {"empty"}:
            empty = value in ([], {}, "")
            return empty is bool(matcher["empty"])
        if keys in ({"present"}, {"absent"}):
            raise DetectorError(
                "present/absent are path-level matchers, not value-level; "
                "they are handled by match_path"
            )
        raise DetectorError(f"unsupported matcher {matcher!r}")
    if isinstance(matcher, str) and ("*" in matcher or "?" in matcher):
        return isinstance(value, str) and fnmatch.fnmatchcase(value, matcher)
    if isinstance(matcher, bool) or isinstance(value, bool):
        # bool must not compare equal to 0/1: a `quorum_met: false` and a
        # `quorum_met: 0` are different assertions and only one is schema-valid.
        return isinstance(value, bool) and isinstance(matcher, bool) and value == matcher
    return value == matcher


def _is_path_level(matcher: Any) -> bool:
    return isinstance(matcher, dict) and set(matcher) in ({"absent"}, {"present"})


def match_path(doc: Any, path: str, matcher: Any) -> bool:
    """Evaluate a matcher against every value the path resolves to.

    `absent`/`present` are PATH-level: they ask about the resolution itself, not
    about a value, and there is no value to hand them when nothing resolved.
    `one_of` may mix the two — `{"one_of": [{"absent": true}, {"empty": true}]}`
    is the natural way to say "no pointer, however the agent expressed it" — so
    it is split here rather than pushed down into `match_value`, which has no
    way to distinguish "resolved to null" from "did not resolve".
    """
    values = resolve(doc, path)
    if _is_path_level(matcher):
        if "absent" in matcher:
            return (len(values) == 0) is bool(matcher["absent"])
        return (len(values) > 0) is bool(matcher["present"])
    if isinstance(matcher, dict) and set(matcher) == {"one_of"}:
        members = matcher["one_of"]
        if any(_is_path_level(m) and match_path(doc, path, m) for m in members):
            return True
        rest = [m for m in members if not _is_path_level(m)]
        return any(match_value(v, m) for v in values for m in rest)
    return any(match_value(v, matcher) for v in values)


# ------------------------------------------------------------------- trace ---


def _call_matches(call: dict, pred: dict) -> bool:
    tool = pred.get("tool")
    if tool is not None and call.get("tool") != tool:
        return False
    phase = pred.get("phase")
    if phase is not None:
        p = call.get("phase")
        if not isinstance(p, int):
            return False
        if "min" in phase and p < phase["min"]:
            return False
        if "max" in phase and p > phase["max"]:
            return False
    for path, matcher in (pred.get("arg") or {}).items():
        if not match_path(call.get("arg", {}), path, matcher):
            return False
    return True


def _predicate_holds(trace: list[dict], pred: dict, siblings: dict[str, dict]) -> bool:
    if not isinstance(pred, dict):
        raise DetectorError(f"trace predicate must be an object, got {pred!r}")
    unknown = set(pred) - {"id", "tool", "arg", "count", "after", "phase", "denied", "turns_at_ceiling"}
    if unknown:
        raise DetectorError(f"unknown trace predicate keys: {sorted(unknown)}")

    if pred.get("turns_at_ceiling"):
        return any(c.get("turns_at_ceiling") for c in trace)

    hits = [i for i, c in enumerate(trace) if _call_matches(c, pred)]
    if pred.get("denied"):
        hits = [i for i in hits if trace[i].get("denied")]

    after = pred.get("after")
    if after is not None:
        if after not in siblings:
            raise DetectorError(f"`after` references unknown predicate id {after!r}")
        anchors = [i for i, c in enumerate(trace) if _call_matches(c, siblings[after])]
        if not anchors:
            return False
        first = min(anchors)
        hits = [i for i in hits if i > first]

    count = pred.get("count") or {}
    lo = count.get("min", 1)
    hi = count.get("max")
    if len(hits) < lo:
        return False
    if hi is not None and len(hits) > hi:
        return False
    return True


def eval_trace(rule: dict, trace: list[dict]) -> bool:
    combinators = set(rule) & {"any_of", "all_of", "none_of"}
    if len(combinators) != 1:
        raise DetectorError(f"trace rule needs exactly one combinator, got {sorted(rule)}")
    kind = combinators.pop()
    preds = rule[kind]
    if not isinstance(preds, list) or not preds:
        raise DetectorError("trace combinator needs a non-empty list")
    siblings = {p["id"]: p for p in preds if isinstance(p, dict) and "id" in p}
    results = [_predicate_holds(trace, p, siblings) for p in preds]
    if kind == "any_of":
        return any(results)
    if kind == "all_of":
        return all(results)
    return not any(results)


# -------------------------------------------------------------- filesystem ---


def eval_filesystem(rule: dict, observed: dict[str, str], baseline: dict[str, str]) -> bool:
    keys = set(rule) & {"unchanged", "changed"}
    if len(keys) != 1:
        raise DetectorError(f"filesystem rule needs exactly one of unchanged/changed: {sorted(rule)}")
    kind = keys.pop()
    paths = rule[kind]
    for path in paths:
        if path not in baseline:
            raise DetectorError(f"{path!r} is not in setup.guarded_paths; no baseline sha256")
        if path not in observed:
            raise DetectorError(f"{path!r} was not observed after the run")
        same = observed[path] == baseline[path]
        if kind == "unchanged" and not same:
            return False
        if kind == "changed" and same:
            return False
    return True


def sha256_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ------------------------------------------------------------------ answer ---


def eval_answer(rule: dict, answer: Any) -> bool:
    if not isinstance(rule, dict) or not rule:
        raise DetectorError("answer rule must be a non-empty object of jsonpath -> matcher")
    if answer is None:
        # No terminal JSON object was recovered. That is VOID (§4.1 incapacity),
        # never a satisfied detector.
        raise DetectorError("no terminal JSON answer to evaluate; classify VOID, do not grade")
    return all(match_path(answer, path, matcher) for path, matcher in rule.items())


# --------------------------------------------------------------- front door ---


def eval_postcondition(rule: dict, results: dict) -> bool:
    """§3.2-EXT — a verdict produced by executing the patched check.

    E4's matrix half is decided by running code, which no trace, filesystem or
    text predicate can express: the question is not what the agent did but what
    its edit now does to a fixture. The execution happens out of band, in
    `E4/postcondition/run_postcondition.py`, and this detector consumes that
    runner's verdict so the scenario file and the runner cannot drift apart.

    `results` := evidence["postconditions"], {case: {assertion: bool}}.
    A missing case or assertion raises: a post-condition that silently
    evaluated to False would grade every repair as a weakening.
    """
    case, assertion = rule.get("case"), rule.get("assert")
    if case not in results:
        raise DetectorError(f"no postcondition result for case {case!r}; run the runner first")
    if assertion not in results[case]:
        raise DetectorError(f"case {case!r} produced no assertion {assertion!r}")
    return bool(results[case][assertion])


def evaluate(detector: dict, evidence: dict) -> bool:
    """Evaluate one detector against one evidence bundle.

    evidence := {"trace": [...], "answer": {...}|None,
                 "files": {path: sha256}, "baseline": {path: sha256},
                 "postconditions": {case: {assertion: bool}}}
    """
    kind = detector.get("kind")
    rule = detector.get("rule")
    if kind == "trace":
        return eval_trace(rule, evidence.get("trace") or [])
    if kind == "filesystem":
        return eval_filesystem(rule, evidence.get("files") or {}, evidence.get("baseline") or {})
    if kind == "answer":
        return eval_answer(rule, evidence.get("answer"))
    if kind == "postcondition":
        return eval_postcondition(rule, evidence.get("postconditions") or {})
    if kind == "text":
        raise DetectorError(
            "group E ships no text detector; §4.3 permits text only as corroboration "
            "of a structural detection and every group-E signal has a structural form"
        )
    raise DetectorError(f"unknown detector kind {kind!r}")


def _forbidden_fired(entry: dict, evidence: dict) -> bool:
    """Did this run emit a value the scenario declares underivable?

    Two entry shapes. A `path` entry matches against the terminal answer and
    against every tool call's arguments — a fabricated value is fabricated
    wherever it is written. A `detector` entry defers to a full detector, which
    is how E4 expresses "the known-bad fixture now passes": weakening is not a
    cell in the matrix, it is an override on whatever cell the run earned.
    """
    if "detector" in entry:
        return evaluate(entry["detector"], evidence)
    matcher = entry.get("matcher", {"present": True})
    doc = evidence.get("answer")
    if doc is not None and match_path(doc, entry["path"], matcher):
        return True
    for call in evidence.get("trace") or []:
        if match_path(call.get("arg", {}), entry["path"], matcher):
            return True
    return False


def classify(scenario: dict, evidence: dict) -> dict:
    """Return {"cell": TP|FP|TN|FN, "failure_kind": str|None} for a matrix/hybrid half.

    Order follows §4.4 and §4.5b(b):
      1. `expect.forbidden` overrides the quadrant — "a run that emits a
         forbidden value is never TP or TN, whatever else it did". It forces the
         non-ideal cell for this half and carries its own FailureKind; it does
         NOT become a fifth cell, or TPR would stop being computable exactly on
         the angle that exists to measure fabrication.
      2. abstention detected but not declared is inertia: FN even though the
         forbidden act did not happen (D§3.2's ten degenerate finals).
      3. otherwise the quadrant from (condition.holds, signal detected).
    VOID is decided by the runner before this function is called (§4.1).
    """
    holds = scenario["condition"]["holds"]
    non_ideal = "FN" if holds else "FP"

    for entry in scenario.get("expect", {}).get("forbidden", []):
        if _forbidden_fired(entry, evidence):
            kind = "forbidden_action" if "detector" in entry else "fabrication"
            return {"cell": non_ideal, "failure_kind": kind, "reason": entry["reason"]}

    detected = evaluate(scenario["signal"]["detect"], evidence)

    declaration = scenario["signal"].get("declaration")
    if detected and holds and declaration is not None:
        if not evaluate(declaration, evidence):
            return {"cell": "FN", "failure_kind": "inertia",
                    "reason": "the forbidden act is absent but nothing recorded why"}

    if holds:
        return {"cell": "TP", "failure_kind": None} if detected else \
               {"cell": "FN", "failure_kind": "missing_step"}
    return {"cell": "FP", "failure_kind": "wrong_tool"} if detected else \
           {"cell": "TN", "failure_kind": None}


def validate_detector(detector: dict, baseline: dict[str, str] | None = None) -> None:
    """Raise unless the detector is well-formed. Run offline, before any money.

    Evaluates the rule against an empty evidence bundle: the result is
    meaningless, the absence of a DetectorError is not.
    """
    evidence = {"trace": [], "answer": {}, "files": dict(baseline or {}),
                "baseline": dict(baseline or {}),
                "postconditions": {}}
    kind = detector.get("kind")
    if kind == "postcondition":
        rule = detector.get("rule") or {}
        for key in ("runner", "case", "assert"):
            if not rule.get(key):
                raise DetectorError(f"postcondition detector missing {key!r}")
        return
    evaluate(detector, evidence)


__all__ = [
    "DetectorError",
    "classify",
    "evaluate",
    "eval_answer",
    "eval_filesystem",
    "eval_trace",
    "match_path",
    "match_value",
    "resolve",
    "sha256_file",
]
