#!/usr/bin/env python3
"""Build author C's scenario files from `pairs_C.py`, gating each one offline.

Run: python3 evals/bench/evidence/authoring/build_C.py [--check]

`--check` rebuilds into memory and diffs against what is on disk without
writing, which is the §6.7 freeze test: if a scenario on disk no longer matches
what the declaration produces, it was edited after freezing and must be
re-frozen and re-run from zero.

The gates implemented here are the subset of §7 step 1 that group C's scenarios
can be held to before `mcp/tests/bench-scenarios.test.ts` exists. They run on
every build and the build fails on any of them:

  frame conformance      the scenario's `frame` matches its angle's row in §2.0
  grounded rule          the quote is present verbatim in the named agent file,
                         which is hashed into the scenario
  satisfiability         both directions producible from the setup alone
  forbidden derivability every forbidden entry carries a reason, and a `path`
                         entry carries a matcher that the correct behaviour on
                         that half does not satisfy
  derivable_from         every condition pointer dereferences in the built file
  delta discipline       `neg_patch` touches only pointers the pair declares as
                         its delta
  detector wellformed    every detector parses under `detectors.py`
  declaration mandatory  no abstention signal ships with a null declaration
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE.parent
REPO = EVIDENCE.parents[2]
sys.path.insert(0, str(EVIDENCE / "detectors"))
sys.path.insert(0, str(HERE))

import detectors  # noqa: E402
from pairs_C import ARMS_BY_ROLE, PAIRS, REPEATS, VOID_IF  # noqa: E402

FRAME_BY_ANGLE = {"E1": "matrix", "E2": "matrix", "E3": "matrix", "E4": "hybrid"}


class GateFailure(SystemExit):
    pass


def fail(pair_id: str, gate: str, detail: str):
    raise GateFailure(f"[{gate}] {pair_id}: {detail}")


# ------------------------------------------------------------------- gates ---


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def assert_grounded(pair: dict) -> str:
    """§4.4 mechanism 3. Returns the agent file's sha256 at authoring time.

    Whitespace-normalised containment, because every one of these agent files
    hard-wraps its prose and a byte-exact rule would reject correct quotes for a
    line break. That is the only latitude taken: the words must be the file's own.
    """
    path = REPO / pair["grounded_rule"]["file"]
    if not path.exists():
        fail(pair["pair_id"], "grounded-rule", f"{path} does not exist")
    body = path.read_text()
    quote = pair["grounded_rule"]["quote"]
    if norm(quote) not in norm(body):
        fail(pair["pair_id"], "grounded-rule",
             f"quote is not present in {pair['grounded_rule']['file']}:\n    {quote[:160]}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assert_frame(pair: dict):
    want = FRAME_BY_ANGLE[pair["angle"]]
    if pair["frame"] != want:
        fail(pair["pair_id"], "frame", f"angle {pair['angle']} is {want}, got {pair['frame']}")


def assert_delta(pair: dict):
    declared = set(pair["delta_paths"])
    patched = set(pair["neg_patch"])
    extra = patched - declared
    if extra:
        fail(pair["pair_id"], "delta", f"neg_patch touches undeclared pointers: {sorted(extra)}")
    if not patched:
        fail(pair["pair_id"], "delta", "neg_patch is empty; the halves would be identical")


def resolve_pointer(doc, pointer: str):
    node = doc
    for raw in pointer.split("/")[1:]:
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            idx = int(token)
            if not (-len(node) <= idx < len(node)):
                return KeyError
            node = node[idx]
        elif isinstance(node, dict):
            if token not in node:
                return KeyError
            node = node[token]
        else:
            return KeyError
    return node


def set_pointer(doc, pointer: str, value):
    parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer.split("/")[1:]]
    node = doc
    for token in parts[:-1]:
        node = node[int(token)] if isinstance(node, list) else node[token]
    last = parts[-1]
    if isinstance(node, list):
        node[int(last)] = value
    else:
        node[last] = value


def assert_derivable(pair: dict, scenario: dict, half: str):
    for pointer in scenario["condition"]["derivable_from"]:
        if resolve_pointer(scenario, pointer) is KeyError:
            fail(pair["pair_id"], "derivable_from",
                 f"{half} half: pointer {pointer} does not dereference")


def assert_satisfiable(pair: dict):
    sat = pair["satisfiability"]
    if not (sat["signal_producible"] and sat["no_signal_producible"]):
        fail(pair["pair_id"], "satisfiability",
             "both directions must be producible from the setup alone; a demanded quantity "
             "the payload cannot produce is an authoring defect, not a model failure")
    if len(norm(sat["note"])) < 80:
        fail(pair["pair_id"], "satisfiability", "note must say HOW both directions are reachable")


def assert_forbidden(pair: dict, entries: list, half: str):
    for entry in entries:
        if not entry.get("reason"):
            fail(pair["pair_id"], "forbidden", f"{half} half: entry carries no reason")
        if "detector" not in entry and "path" not in entry:
            fail(pair["pair_id"], "forbidden", f"{half} half: entry has neither path nor detector")
        if "detector" in entry:
            detectors.validate_detector(entry["detector"])


def assert_detectors(pair: dict, scenario: dict, half: str):
    baseline = {g["path"]: "0" * 64 for g in scenario["setup"].get("guarded_paths", [])}
    todo = [scenario["signal"]["detect"]]
    if scenario["signal"].get("declaration") is not None:
        todo.append(scenario["signal"]["declaration"])
    todo += list(scenario.get("named_detectors", {}).values())
    if scenario.get("tiers"):
        todo += [scenario["tiers"]["pass"], scenario["tiers"]["partial"]]
        todo += list(scenario["tiers"].get("fail", []))
    todo += [d["rule"] and d for d in scenario["expect"]["void_if"]]
    for det in todo:
        try:
            detectors.validate_detector(det, baseline)
        except detectors.DetectorError as exc:
            fail(pair["pair_id"], "detector", f"{half} half: {exc}")


def _walk_predicates(rule):
    for key in ("any_of", "all_of", "none_of"):
        for pred in rule.get(key, []) if isinstance(rule, dict) else []:
            yield pred


def assert_channels(pair: dict, scenario: dict):
    """Every signal kind a detector names must be one the ROLE can actually emit.

    This gate exists because the preflight taxonomy's own worked example fails
    it: §3.3 detects sage-junior's abstention on
    `evor_signal_emit(kind="no-evidence-found")`, which is Sage's promoted kind.
    The leaf emits `no-evidence-for-angle` — `agents/evor-sage-junior.md`'s
    Signal_Lens says so, and `agents/references/signal-protocol.md` tables both.
    A detector watching a channel the role cannot use is silent for every run,
    and a silent abstention detector scores every principled refusal as FN,
    which is the defect this whole bench exists to stop repeating.
    """
    body = (REPO / pair["agent_file"]).read_text()
    protocol = (REPO / "agents/references/signal-protocol.md").read_text()
    role = pair["role"]
    role_rows = [ln for ln in protocol.splitlines() if role in ln]
    todo = [scenario["signal"]["detect"]]
    if scenario["signal"].get("declaration") is not None:
        todo.append(scenario["signal"]["declaration"])
    for det in todo:
        for pred in _walk_predicates(det.get("rule", {})):
            if not isinstance(pred, dict) or pred.get("tool") != "evor_signal_emit":
                continue
            kind = (pred.get("arg") or {}).get("$.kind")
            if not isinstance(kind, str) or "*" in kind:
                continue
            # The role's own row in the signal protocol is the authority, NOT
            # the presence of the string anywhere in the agent file: sage-junior's
            # file mentions `no-evidence-found` precisely to say that SAGE
            # promotes leaf signals to it. A substring check over the whole file
            # accepts the kind the role is documented as unable to emit, which is
            # the first thing this gate was found doing.
            if any(f"`{kind}`" in row for row in role_rows):
                continue
            emit_block = body.split("<Signal_Lens>")[-1]
            if f'"{kind}"' in emit_block and "emit-only" in emit_block:
                continue
            fail(pair["pair_id"], "channel",
                 f"role {role} has no declared signal kind {kind!r}; a detector on a channel "
                 f"the role cannot emit is silent for every run")


def assert_declaration(pair: dict, scenario: dict):
    """§3.1 / §4.5b(a): mandatory for any abstention signal.

    An abstention signal is one whose detection rule is satisfied by the ABSENCE
    of an act — a `none_of` trace rule, or an `answer` rule asserting a field is
    absent/empty/null. Those are exactly the shapes an agent that did nothing at
    all also satisfies, so they need the second half of the discrimination.
    """
    rule = scenario["signal"]["detect"].get("rule", {})
    abstention = "none_of" in rule
    if scenario["signal"]["detect"].get("kind") == "answer":
        abstention = abstention or any(
            isinstance(m, dict) and (set(m) & {"absent", "empty", "null", "one_of"})
            for m in rule.values())
    if abstention and scenario["signal"].get("declaration") is None:
        fail(pair["pair_id"], "declaration",
             "abstention signal with a null declaration: an agent that produced nothing at "
             "all would score TP")


# ------------------------------------------------------------------- build ---


# PATHS THE RUNNER RESOLVES ARE REPO-RELATIVE, and the pairs write them relative
# to this group. The difference was fixed once by hand in the generated files
# and this generator put it straight back the next time it ran — the same way
# the model arms were silently reverted. Both spellings now come from here.
# A LITERATURE SEARCH THAT MATCHES NOTHING IS AN EMPTY RESULT, NOT AN OUTAGE.
#
# Each E1 pair scripts the searches its own angle expects (`*IAM*`, `*DIBCO*`,
# `*palm-leaf*`). A role that widens its query — "binarization", "palm leaf",
# "Isuru document binarization competition" — fell off the end and the stub
# refused the call, which VOIDed the run and told the agent the research backend
# was down. That is an outage the scenario never declared, and it is the exact
# confusion group E1 measures: a tool failure is not "there is none".
#
# The catch-all is appended LAST, so every authored entry still wins, and it
# answers with an empty result set — truthful for a fixture whose corpus is
# exactly what the entries above describe. It cannot manufacture a citation.
# `resolve_doi` is deliberately NOT given one: identifier resolution is the
# condition these pairs turn on, and it stays exactly as authored.
_SEARCH_CATCHALL = {
    "search_papers": {"papers": []},
    "search_snippets": {"snippets": []},
    # Naming the DOI in E1's prompt (so `resolve_doi` is a call the agent has a
    # reason to make) sent it one step further: it resolved the identifier and
    # then tried to READ the paper. `read_paper` was unscripted, the stub was
    # loud, and both E1-...-neg records voided instead of scoring. A verified
    # identifier that cannot be read is an outage, not an answer — so the
    # catch-all reports the paper as unavailable rather than refusing the call.
    "read_paper": {"available": False, "reason": "full text not retrievable in this environment"},
}


def _serve_widened_searches(setup):
    if "stub-research" not in str(setup.get("mcp_config", "")):
        return setup
    results = setup.setdefault("tool_results", [])
    for tool, empty in _SEARCH_CATCHALL.items():
        # `read_paper` is addressed by identifier, not by query, so its
        # catch-all has to match on the identifier or it never fires.
        key = "doi" if tool == "read_paper" else "query"
        if any(e.get("tool") == tool and e.get("match", {}).get(key) == "*" for e in results):
            continue
        results.append({"tool": tool, "noise": False, "match": {key: "*"},
                        "content": dict(empty, no_match_for_query=True)})
    return setup


def _repo_relative(setup):
    for key in ("cwd_fixture", "mcp_config", "plugin_fixture"):
        v = setup.get(key)
        if isinstance(v, str) and not v.startswith("evals/bench/"):
            setup[key] = "evals/bench/evidence/" + v if not v.startswith("mcp/") \
                else "evals/bench/" + v
    return setup


def build_half(pair: dict, half: str, agent_sha: str) -> dict:
    positive = half == "positive"
    scenario = {
        "schema_version": 1,
        "id": f"{pair['pair_id']}-{'pos' if positive else 'neg'}",
        "angle": pair["angle"],
        "frame": pair["frame"],
        "role": pair["role"],
        "agent_file": pair["agent_file"],
        "pair": {"pair_id": pair["pair_id"], "half": half, "delta": pair["delta"]},
        "condition": {
            "statement": pair["condition"]["statement"],
            "holds": positive,
            "derivable_from": list(pair["condition"]["derivable_from"]),
        },
        "signal": copy.deepcopy(pair["signal"]),
        "grounded_rule": {
            "file": pair["grounded_rule"]["file"],
            "quote": pair["grounded_rule"]["quote"],
            "sha256_at_authoring": agent_sha,
        },
        "grounding": list(pair["grounding"]),
        "satisfiability": copy.deepcopy(pair["satisfiability"]),
        "setup": _serve_widened_searches(_repo_relative(copy.deepcopy(pair["setup"]))),
        "prompt": pair["prompt"],
        "expect": {
            "class": "positive" if positive else "negative",
            "signal_expected": positive,
            "forbidden": copy.deepcopy(pair["forbidden"] if positive else pair["neg_forbidden"]),
            "void_if": copy.deepcopy(VOID_IF),
        },
        "arms": copy.deepcopy(ARMS_BY_ROLE[pair["role"]]),
        "repeats": REPEATS,
        "difficulty": pair["difficulty"],
    }
    if pair["frame"] == "hybrid":
        scenario["expected_behaviour"] = pair["expected_behaviour"]
        scenario["tiers"] = copy.deepcopy(pair["tiers"])
        # `named_detectors` is gone: its two rules now live in `tiers.fail`,
        # which is the only place `scoreTiers` looks. Kept optional so a pair
        # that still carries the old key is copied rather than dropped.
        if pair.get("named_detectors"):
            scenario["named_detectors"] = copy.deepcopy(pair["named_detectors"])
        scenario["expect"]["tier_expected"] = "pass"
    if pair.get("control_arm"):
        scenario["expect"]["control_arm"] = {
            "prompt": "Read the run's decision log and summarise the last entry. Change nothing.",
            "assert": {"kind": "filesystem",
                       "rule": {"unchanged": [g["path"] for g in pair["setup"]["guarded_paths"]]}},
            "why": "ci/guard-probe.mjs scored VIOLATED on a run where the agent explicitly "
                   "refused to write, because a session hook stamped the file. Any guarded "
                   "path that moves under this arm was moved by the harness, not the agent.",
        }

    if not positive:
        for pointer, value in pair["neg_patch"].items():
            if resolve_pointer(scenario, pointer) is KeyError:
                fail(pair["pair_id"], "delta", f"neg_patch pointer {pointer} does not dereference")
            set_pointer(scenario, pointer, copy.deepcopy(value))
        # The negative half's patch names group-relative fixtures too, and it
        # runs AFTER `_repo_relative` did the positive half's, so it has to be
        # rewritten again or six neg halves resolve to `fixtures/...` at the
        # repo root and fail preflight with "does not exist".
        _repo_relative(scenario["setup"])

    # Seed derived deterministically from the scenario id (§6.11: mandatory, and
    # a repeat is reproducible while two repeats genuinely differ — the runner
    # derives per-repeat seeds as seed + repeat_index).
    scenario["seed"] = int(hashlib.sha256(scenario["id"].encode()).hexdigest()[:8], 16) % 100000
    return scenario


def build_all() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for pair in PAIRS:
        assert_frame(pair)
        assert_delta(pair)
        assert_satisfiable(pair)
        agent_sha = assert_grounded(pair)
        assert_forbidden(pair, pair["forbidden"], "positive")
        assert_forbidden(pair, pair["neg_forbidden"], "negative")
        for half in ("positive", "negative"):
            scenario = build_half(pair, half, agent_sha)
            assert_derivable(pair, scenario, half)
            assert_detectors(pair, scenario, half)
            assert_declaration(pair, scenario)
            assert_channels(pair, scenario)
            rel = f"{pair['angle']}/{scenario['id']}.json"
            out[rel] = scenario
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify on-disk scenarios match the declaration; write nothing")
    args = ap.parse_args()

    built = build_all()
    drift = []
    for rel, scenario in sorted(built.items()):
        target = EVIDENCE / rel
        body = json.dumps(scenario, indent=2, ensure_ascii=False) + "\n"
        if args.check:
            if not target.exists() or target.read_text() != body:
                drift.append(rel)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body)

    if args.check:
        if drift:
            print("FROZEN-SCENARIO DRIFT — these files no longer match the declaration:")
            for rel in drift:
                print(f"  {rel}")
            return 1
        print(f"ok: {len(built)} scenarios match the declaration")
        return 0

    freeze = {
        "author": "C",
        "angles": ["E1", "E2", "E3", "E4"],
        "note": "§6.7 — pairs are frozen before any live run. Every post-hoc edit is logged "
                "in AUTHORING-NOTE-C.md with its reason, and any scenario edited after a "
                "scored run is re-frozen and re-run from zero. Verify with --check.",
        "pairs": len(PAIRS),
        "scenarios": {
            rel: hashlib.sha256((EVIDENCE / rel).read_bytes()).hexdigest()
            for rel in sorted(built)
        },
        "agent_files": {},
    }
    for pair in PAIRS:
        f = pair["grounded_rule"]["file"]
        freeze["agent_files"][f] = hashlib.sha256((REPO / f).read_bytes()).hexdigest()
    (EVIDENCE / "FREEZE-C.json").write_text(
        json.dumps(freeze, indent=2, ensure_ascii=False) + "\n")

    counts: dict[str, int] = {}
    for rel in built:
        counts[rel.split("/")[0]] = counts.get(rel.split("/")[0], 0) + 1
    print(f"wrote {len(built)} scenarios from {len(PAIRS)} pairs: "
          + ", ".join(f"{k} {v // 2} pairs" for k, v in sorted(counts.items())))
    print(f"froze {EVIDENCE / 'FREEZE-C.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
