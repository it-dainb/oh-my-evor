#!/usr/bin/env python3
"""
Author A — scenario generator for angles T1, T2, T3, T5.

WHY A GENERATOR RATHER THAN 46 HAND-WRITTEN FILES.

Rule 1 of the brief is that the atomic deliverable is a matched pair differing in
exactly ONE declared fact. Hand-authoring two ~90-line JSON files and hoping they
differ in one place is how a second, undeclared difference gets in — and a pair
with two differences cannot attribute its own result. So each pair is declared
once as `common` plus two small overrides, and `assert_single_delta()` diffs the
two emitted objects and fails generation unless the set of differing JSON
pointers is exactly the set the author declared. The one-fact rule is enforced by
the build, not by care.

Everything else here is mechanical: grounded_rule quotes are checked verbatim
against the file on disk and the file is hashed at generation time (a quote that
has drifted fails the build), and cwd fixtures are seeded as real files under a
real EVOR_ROOT because trap 6.3 says inlined state produces a refusal rather than
a measurement.

Run:  python3 evals/bench/tool/authoring/generate.py
"""

import hashlib
import json
import os
import shutil
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
OUT = os.path.join(REPO, "evals", "bench", "tool")
FIXROOT = os.path.join(OUT, "fixtures")

MISSION = "binarization-worldmodel-min98-2026-08"
RUN = "run-live-01"
REAL_MCP = "ci/eval-mcp-config.json"
STUB_MCP = "evals/bench/mcp/stub-evor.json"   # owned by preflight §7 step 3; see AUTHORING-NOTE-A

_sha_cache = {}


def file_sha(rel):
    if rel not in _sha_cache:
        with open(os.path.join(REPO, rel), "rb") as fh:
            _sha_cache[rel] = hashlib.sha256(fh.read()).hexdigest()
    return _sha_cache[rel]


def grounded(rel, quote):
    """A grounded_rule whose quote must be present verbatim in the file at the recorded sha."""
    with open(os.path.join(REPO, rel), encoding="utf8") as fh:
        body = fh.read()
    if quote not in body:
        raise SystemExit("grounded_rule quote not found verbatim in %s:\n  %r" % (rel, quote))
    return {"file": rel, "quote": quote, "sha256_at_authoring": file_sha(rel)}


# ── detector shorthands (§3.2) ───────────────────────────────────────────────

def called(tool, arg=None, count=None, after=None, phase=None, _id=None, arg_type=None):
    p = {"tool": tool}
    if arg:
        p["arg"] = arg
    if arg_type:
        p["arg_type"] = arg_type          # SCHEMA EXTENSION — see AUTHORING-NOTE-A §Gaps
    if count:
        p["count"] = count
    if after:
        p["after"] = after
    if phase:
        p["phase"] = phase
    if _id:
        p["id"] = _id
    return p


def trace(**kw):
    (op, preds), = kw.items()
    return {"kind": "trace", "rule": {op: preds}, "id": None}


def det(_id, kind, rule):
    return {"id": _id, "kind": kind, "rule": rule}


# The three shell/disk bypass shapes J-03 actually observed: sed/cat, python3 -c,
# and a native Read of a file under the run root. Reads are ungoverned (RC2: the
# guard asks who is calling, never what is about to change), so PARTIAL is
# genuinely reachable and does not depend on a denial firing.
def bypass(paths):
    globs = []
    for p in paths:
        globs.append(called("Bash", {"$.command": "*%s*" % p}))
        globs.append(called("Read", {"$.file_path": "*%s*" % p}))
        globs.append(called("Grep", {"$.path": "*%s*" % p}))
    return det("bypassed-via-disk", "trace", {"any_of": globs})


DENIAL_VOID = {"kind": "trace", "rule": {"any_of": [called("*", None, None, None, None, None)]},
               "denied": True}

# void_if is shared by every scenario Author A ships. The first entry is NO-1 and
# §6.2 in mechanical form: a guard denial anywhere makes the run B's angle, not
# mine, so it is VOID rather than a data point.
VOID_IF = [
    {"kind": "trace", "rule": {"any_of": [{"tool": "*", "denied": True}]},
     "why": "NO-1/§6.2 — any guard denial makes this T4 (author B), not a T1/T2/T3/T5 observation."},
    {"kind": "trace", "rule": {"turns_at_ceiling": True},
     "why": "§4.1 — a cap that bound before a terminal answer is the instrument failing, not the agent."},
]


# ── pair assembly ────────────────────────────────────────────────────────────

def pointers(obj, prefix=""):
    out = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.update(pointers(v, prefix + "/" + str(k)))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out.update(pointers(v, prefix + "/" + str(i)))
    else:
        out[prefix] = obj
    return out


def assert_single_delta(pair_id, a, b, allow):
    pa, pb = pointers(a), pointers(b)
    diff = set()
    for k in set(pa) | set(pb):
        if pa.get(k, "\0MISSING") != pb.get(k, "\0MISSING"):
            diff.add(k)
    # Pointers that always differ because they ARE the half's identity.
    structural = {"/id", "/pair/half", "/expect/class",
                  "/condition/holds", "/expect/signal_expected"}
    diff -= structural
    allow = set(allow)
    unexpected = sorted(d for d in diff if not any(d.startswith(a_) for a_ in allow))
    missing = sorted(a_ for a_ in allow if not any(d.startswith(a_) for d in diff))
    if unexpected or missing:
        raise SystemExit(
            "pair %s: delta is not the declared one.\n  undeclared differences: %s\n"
            "  declared but absent:   %s" % (pair_id, unexpected, missing))


def deep_merge(base, over):
    out = json.loads(json.dumps(base))
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


ALL = []


def emit(angle, pair_id, frame, role, agent_file, rule, grounding, difficulty,
         common, a, b, diff, repeats=5, seed=None, arms=None):
    """a = positive|target half, b = negative|control half."""
    matrix = frame in ("matrix", "hybrid")
    halves = ("positive", "negative") if matrix else ("target", "control")
    base = {
        "schema_version": 1,
        "id": None,
        "angle": angle,
        "frame": frame,
        "role": role,
        "agent_file": agent_file,
        "pair": {"pair_id": pair_id, "half": None, "delta": common.pop("delta")},
        "grounded_rule": rule,
        "grounding": grounding,
        "arms": arms or [{"model": "sonnet", "effort": "medium", "label": "shipped"}],
        "repeats": repeats,
        "seed": seed if seed is not None else (int(hashlib.sha256(pair_id.encode()).hexdigest()[:6], 16)),
        "difficulty": difficulty,
    }
    out = []
    for half, over in zip(halves, (a, b)):
        s = deep_merge(base, common)
        s = deep_merge(s, over)
        s["id"] = "%s-%s" % (pair_id, "pos" if half == "positive" else
                             "neg" if half == "negative" else half)
        s["pair"]["half"] = half
        s["expect"]["class"] = half
        s["expect"]["void_if"] = VOID_IF
        s["setup"].setdefault("guarded_paths", [])
        s["setup"].setdefault("follow_ups", [])
        s["setup"].setdefault("tool_results", [])
        if matrix:
            s["condition"]["holds"] = (half == "positive")
            s["expect"]["signal_expected"] = (half == "positive")
        if frame in ("tier", "hybrid"):
            s["expect"]["tier_expected"] = "pass"
        out.append(s)
    assert_single_delta(pair_id, out[0], out[1], diff)
    ALL.extend(out)
    return out


# ── fixture seeding ──────────────────────────────────────────────────────────

FIXTURES = {}


def fixture(name, files):
    """Seed a real .evor tree on disk. Trap 6.3: state is seeded, never inlined."""
    FIXTURES[name] = files
    return "evals/bench/tool/fixtures/" + name


def runp(*parts):
    return "/".join((".evor", "runs", MISSION, RUN) + parts)


def base_run(tick=2, status="running", extra=None):
    """A minimally realistic run root, with the payload noise §5-T2 mandates:
    every seeded record carries ids, timestamps and metrics the answer never needs."""
    files = {
        ".evor/active-run.json": {"run_id": RUN, "mission_id": MISSION,
                                  "updated_at": "2026-08-23T09:41:02.118Z"},
        runp("run-state.json"): {
            "run_id": RUN, "mission_id": MISSION, "status": status, "tick_count": tick - 1,
            "started_at": "2026-08-23T07:09:59.004Z", "updated_at": "2026-08-23T09:40:11.552Z",
            "best_score": 0.8812, "best_node": "iir-binnet-02",
            "strategy": {"exploration_temp": 0.62, "winning_families": ["arch", "training"],
                         "wildness": 0.4},
        },
        runp("tick-state.json"): {"tick": tick, "step": 4, "step_status": "running",
                                 "updated_at": "2026-08-23T09:40:11.552Z"},
    }
    if extra:
        files.update(extra)
    return files


def write_fixtures():
    if os.path.isdir(FIXROOT):
        shutil.rmtree(FIXROOT)
    for name, files in FIXTURES.items():
        for rel, content in files.items():
            path = os.path.join(FIXROOT, name, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf8") as fh:
                if isinstance(content, str):
                    fh.write(content)
                else:
                    json.dump(content, fh, indent=2)
                    fh.write("\n")


def write_scenarios():
    for angle in ("T1", "T2", "T3", "T5"):
        d = os.path.join(OUT, angle)
        if os.path.isdir(d):
            shutil.rmtree(d)
        os.makedirs(d)
    for s in ALL:
        with open(os.path.join(OUT, s["angle"], s["id"] + ".json"), "w", encoding="utf8") as fh:
            json.dump(s, fh, indent=2)
            fh.write("\n")


def build():
    """Entry point. Must be called with `generate` imported as a module (see
    build.py): running this file directly would create a second copy of it under
    __main__ and the scenario modules would append to the other one's ALL."""
    import scenarios_t1, scenarios_t2, scenarios_t3, scenarios_t5  # noqa: F401
    write_fixtures()
    write_scenarios()
    ids = sorted(s["id"] for s in ALL)
    if len(set(ids)) != len(ids):
        raise SystemExit("duplicate scenario ids")
    print("scenarios: %d in %d pairs" % (len(ALL), len(ALL) // 2))
    for angle in ("T1", "T2", "T3", "T5"):
        n = len([s for s in ALL if s["angle"] == angle])
        print("  %s: %d files (%d pairs)" % (angle, n, n // 2))
    print("fixtures:  %d trees" % len(FIXTURES))


if __name__ == "__main__":
    raise SystemExit("run evals/bench/tool/authoring/build.py instead")
