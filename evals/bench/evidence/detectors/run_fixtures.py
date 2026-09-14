#!/usr/bin/env python3
"""Assert every detector fires on the real behaviour and stays silent on the near-miss.

Run: python3 evals/bench/evidence/detectors/run_fixtures.py

This is §4.5's floors and §4.5b(e)'s fixtures, made executable, plus the
degenerate-strategy check the taxonomy asks for: the constant strategies "always
emit S" and "never emit S" must not clear a pair. Trap §6.4 is why this is not
optional — `classifyInfeasibleResponse` shipped two fabricated reds, both of
which a fixture would have caught before they were published.

Exit code 1 on any failure. Nothing here talks to a model or spends money.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE.parent
sys.path.insert(0, str(HERE))

import detectors  # noqa: E402

EMPTY = {"trace": [], "answer": {}, "files": {}, "baseline": {}, "postconditions": {}}


def bundle(entry: dict) -> dict:
    ev = dict(EMPTY)
    ev.update({k: v for k, v in entry.items() if k in
               ("trace", "answer", "files", "baseline", "postconditions")})
    return ev


def run_detector_fixtures() -> list[str]:
    problems = []
    specs = sorted(HERE.glob("*.fixtures.json"))
    if not specs:
        return ["no detector fixtures found"]
    for path in specs:
        spec = json.loads(path.read_text())
        det = spec["detector"]
        for label, expected in (("fires", True), ("silent", False)):
            for i, entry in enumerate(spec.get(label, [])):
                try:
                    got = detectors.evaluate(det, bundle(entry))
                except detectors.DetectorError as exc:
                    problems.append(f"{path.name}:{label}[{i}] raised: {exc}")
                    continue
                if got is not expected:
                    problems.append(
                        f"{path.name}:{label}[{i}] expected {expected}, got {got}\n"
                        f"      why: {entry.get('why')}")
    print(f"detector fixtures: {len(specs)} sets, "
          f"{sum(len(json.loads(p.read_text()).get('fires', [])) + len(json.loads(p.read_text()).get('silent', [])) for p in specs)} cases")
    return problems


def run_scenario_floors() -> list[str]:
    """§4.5 — the two floors, per scenario, offline.

    nothing-can-pass: the scenario's own signal, fed back as synthetic evidence,
                      must score TP on the positive half and TN with it removed
                      on the negative half. A detector that does not match its
                      own scenario is not a detector.
    anything-passes:  the constant strategies must each score pair_accuracy 0.
    """
    problems = []
    checked = 0
    for path in sorted(EVIDENCE.glob("E*/*.json")):
        scenario = json.loads(path.read_text())
        if scenario["angle"] == "E4":
            # E4's signal is decided by executing the patched check; its floors
            # are run by run_postcondition.py against three module variants,
            # which is a stronger test than a synthetic bundle.
            continue
        checked += 1
        det = scenario["signal"]["detect"]
        decl = scenario["signal"].get("declaration")
        emitting = _synthesise(det, decl, emit=True)
        withholding = _synthesise(det, decl, emit=False)
        try:
            if detectors.evaluate(det, emitting) is not True:
                problems.append(f"{path.name}: detector does not match its own emitted signal")
            if detectors.evaluate(det, withholding) is not False:
                problems.append(f"{path.name}: detector still fires with the signal withheld")
        except detectors.DetectorError as exc:
            problems.append(f"{path.name}: {exc}")

    # anything-passes, over pairs
    pairs: dict[str, dict] = {}
    for path in sorted(EVIDENCE.glob("E*/*.json")):
        s = json.loads(path.read_text())
        if s["angle"] == "E4":
            continue
        pairs.setdefault(s["pair"]["pair_id"], {})[s["pair"]["half"]] = s
    for strategy in ("always", "never"):
        cleared = 0
        for pair_id, halves in pairs.items():
            if len(halves) != 2:
                problems.append(f"{pair_id}: not a pair ({sorted(halves)})")
                continue
            ok = True
            for half, s in halves.items():
                det, decl = s["signal"]["detect"], s["signal"].get("declaration")
                ev = _synthesise(det, decl, emit=(strategy == "always"))
                cell = detectors.classify(s, ev)["cell"]
                if cell not in ("TP", "TN"):
                    ok = False
            cleared += 1 if ok else 0
        if cleared:
            problems.append(
                f"constant strategy '{strategy} emit S' cleared {cleared}/{len(pairs)} pairs; "
                f"§4.5 requires 0 — an angle a constant strategy can clear is not discriminating")
    print(f"scenario floors: {checked} scenarios, {len(pairs)} pairs, "
          f"2 constant strategies")
    return problems


def _synthesise(detector: dict, declaration: dict | None, emit: bool) -> dict:
    """Build the evidence a scenario's own signal describes.

    Deliberately literal: it constructs exactly what the rule says and nothing
    else, so a rule that only matches something the author had in mind but did
    not write fails here rather than in a paid run.
    """
    ev = {"trace": [], "answer": {}, "files": {}, "baseline": {}, "postconditions": {}}
    for det in filter(None, (detector, declaration)):
        _apply(det, ev, emit)
    return ev


def _apply(det: dict, ev: dict, emit: bool):
    kind, rule = det.get("kind"), det.get("rule") or {}
    if kind == "trace":
        if "none_of" in rule:
            # The signal IS the absence. Emitting it means writing nothing that
            # matches; withholding it means writing exactly what it forbids.
            if not emit:
                for pred in rule["none_of"]:
                    ev["trace"].append(_call_from(pred))
            return
        preds = rule.get("any_of") or rule.get("all_of") or []
        if emit:
            for pred in (preds[:1] if "any_of" in rule else preds):
                ev["trace"].append(_call_from(pred))
        return
    if kind == "answer":
        for path, matcher in rule.items():
            key = path.split(".")[-1].replace("[*]", "")
            if not emit:
                ev["answer"][key] = _counter_value(matcher)
                continue
            # A matcher that asks for ABSENCE is emitted by not writing the key.
            # Writing `null` instead is a different assertion and the tick
            # contract says so in as many words: "Omit, not `null`".
            if _expects_absence(matcher):
                ev["answer"].pop(key, None)
            else:
                ev["answer"][key] = _value_for(matcher)
        return
    if kind == "filesystem":
        for verb, paths in rule.items():
            for p in paths:
                ev["baseline"][p] = "a" * 64
                same = (verb == "unchanged") == bool(emit)
                ev["files"][p] = ("a" if same else "b") * 64
        return


def _call_from(pred: dict) -> dict:
    call = {"tool": pred.get("tool", "unknown_tool"), "phase": 0, "arg": {}}
    for path, matcher in (pred.get("arg") or {}).items():
        node = call["arg"]
        parts = [p for p in path.lstrip("$.").split(".") if p]
        for part in parts[:-1]:
            key = part.replace("[*]", "")
            listed = "[*]" in part
            node = node.setdefault(key, [{}] if listed else {})
            node = node[0] if listed else node
        last = parts[-1]
        if "[*]" in last:
            node[last.replace("[*]", "")] = [_value_for(matcher)]
        else:
            node[last] = _value_for(matcher)
    return call


def _expects_absence(matcher) -> bool:
    if not isinstance(matcher, dict):
        return False
    if set(matcher) == {"absent"}:
        return bool(matcher["absent"])
    if "one_of" in matcher:
        return any(_expects_absence(m) for m in matcher["one_of"])
    return False


def _value_for(matcher):
    if isinstance(matcher, dict):
        if "not" in matcher:
            inner = matcher["not"]
            return "other" if not isinstance(inner, bool) else (not inner)
        if matcher.get("empty"):
            return []
        if matcher.get("null"):
            return None
        if matcher.get("present"):
            return "present"
        if matcher.get("absent"):
            return None
        if "one_of" in matcher:
            return _value_for(matcher["one_of"][0])
    if isinstance(matcher, str) and "*" in matcher:
        return matcher.replace("*", "x")
    return matcher


def _counter_value(matcher):
    if isinstance(matcher, dict):
        if matcher.get("absent") or matcher.get("empty") or matcher.get("null"):
            return "a-value-that-is-present"
        if "one_of" in matcher:
            return "a-value-that-is-present"
        if "not" in matcher:
            return matcher["not"]
        if matcher.get("present"):
            return None
    if isinstance(matcher, str):
        return "a-different-string"
    if isinstance(matcher, bool):
        return not matcher
    return "a-different-value"


def main() -> int:
    problems = run_detector_fixtures() + run_scenario_floors()
    if problems:
        print("\nFAILURES:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("\nall detector fixtures and scenario floors pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
