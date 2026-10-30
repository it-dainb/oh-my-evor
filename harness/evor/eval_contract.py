"""The evaluator contract — one owner for a fact that had four.

WHY THIS MODULE EXISTS.

Four sites each asserted their own belief about the same interface, and nothing
made them agree:

    evaluator.py::_build_cmd        evaluator takes NO positional args
    scaffold_evaluator.py           evaluator takes <split_dir> <pred_dir>
    evor_seal_eval_script           evaluator IS one file, eval-suites/<v>.py
    skills/evor-setup/SKILL.md      evaluator loads build_model + weights,
                                    and "the frozen split path is provided via
                                    the run environment"  (it was not)

Each disagreement was fatal and none was visible, because the only test that
executed an evaluator supplied its own argv and wrote the mission-owned file with
`Path.write_text` — substituting itself for both boundaries the product crosses.
A mission setup on 2026-09-14 hit all of them and could only be finished by the
operator typing `cp`, the shell being the one actor outside the write guard.

This is the same collapse §1.2 made for `finished`: re-derivations of one fact
reduced to a single owner. Every site above now DERIVES from this module. Adding
a belief about the evaluator here is the only way to hold one.

THE CONTRACT.

  Invocation   `python <eval_script>` with no positional arguments, optionally
               `--eval-domains <d> [<d> ...]`. The script locates everything
               else itself: it lives at `<run_dir>/eval-suites/<v>.py`, so the
               run directory is two parents up, and `EVOR_RUN_DIR` states it
               explicitly. Positional arguments are NOT part of the contract —
               an evaluator that requires them cannot be launched by the runner.

  Output       exactly one JSON object on stdout, the last line. Logs go to
               stderr. `REQUIRED_STDOUT_KEYS` is the floor.

  Extent       the evaluator is a SET of files, not one file. The generated
               shape is a harness plus the mission's `score_plugin.py`, and the
               harness does `from score_plugin import score` — so an anchor over
               the harness alone leaves the function that decides every score
               outside custody. `evaluator_files` is that set.

  Anchors      ONE PER FILE: `eval_script_hash` = sha256(<v>.py), the value every
               reader computes; `eval_plugin_hash` = sha256(score_plugin.py) when
               present. v1.2.6 folded both into one set digest under
               `eval_script_hash`; no reader moved with it and every node failed
               no_eval_shift until v1.2.9 split them again.

  Shapes       `generated` scores prediction files and cannot load a model.
               `authored` loads the candidate's model and can measure inference.
               A contract that gates on latency or VRAM REQUIRES `authored`;
               asking the generator for it is an error at scaffold time, not a
               gate that silently never fires at score time.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path
from typing import Any, Iterable

#: The mission-owned scoring function, in the `generated` shape.
SCORE_PLUGIN_FILENAME = "score_plugin.py"

#: Keys every conformant evaluator must put in its single stdout object.
REQUIRED_STDOUT_KEYS = ("metrics", "eval_version")

#: Environment the runner exports to the eval subprocess. An evaluator may rely
#: on these and on nothing else; `EVOR_RUN_DIR` exists because the setup skill
#: promised a run-provided split path that was never exported.
EVAL_ENV_VARS = (
    "EVOR_EVAL_VERSION",
    "EVOR_NODE_ID",
    "EVOR_RUN_ID",
    "EVOR_WORKTREE",
    "EVOR_MISSION_TYPE",
    "EVOR_TELEMETRY_PATH",
    "EVOR_RUN_DIR",
)

#: The two conformant shapes.
SHAPE_GENERATED = "generated"
SHAPE_AUTHORED = "authored"


# ── Invocation ───────────────────────────────────────────────────────────────

def build_argv(eval_script: str | Path, eval_domains: Iterable[str] | None = None) -> list[str]:
    """THE command line for an evaluator. The only builder; callers must not
    assemble their own — that divergence is what this module exists to end."""
    argv = [sys.executable, str(eval_script)]
    domains = list(eval_domains or [])
    if domains:
        argv += ["--eval-domains"] + domains
    return argv


def run_dir_from_script(eval_script: str | Path) -> Path:
    """Where an evaluator finds its run directory.

    `EVOR_RUN_DIR` when exported, else two parents up — the evaluator lives at
    `<run_dir>/eval-suites/<v>.py`. Both, so a conformant evaluator works whether
    or not the runner remembered to export it.
    """
    env = os.environ.get("EVOR_RUN_DIR")
    if env:
        return Path(env)
    return Path(eval_script).resolve().parent.parent


def split_dir(run_dir: str | Path, eval_version: str, kind: str = "test") -> Path:
    """The frozen split directory for a version. Never re-split, never guessed."""
    return Path(run_dir) / "frozen-splits" / f"{eval_version}-{kind}"


# ── Extent: what files ARE the evaluator ─────────────────────────────────────

def evaluator_files(run_dir: str | Path, eval_version: str) -> list[Path]:
    """Every file the evaluator comprises, sorted, existing ones only.

    The seal must cover all of them. Hashing only `<v>.py` left the metric — the
    thing an anchor exists to pin — outside the anchor.
    """
    base = Path(run_dir) / "eval-suites"
    candidates = [base / f"{eval_version}.py", base / SCORE_PLUGIN_FILENAME]
    return [p for p in candidates if p.exists()]


def evaluator_digest(run_dir: str | Path, eval_version: str) -> dict[str, Any]:
    """A single digest over the evaluator's whole file set, plus the manifest.

    The digest is over `name\\0sha256` lines so that adding, removing or renaming
    a constituent file changes it — not only editing one.
    """
    files = evaluator_files(run_dir, eval_version)
    if not files:
        return {"ok": False, "error": f"no evaluator found for {eval_version}"}
    manifest = {}
    acc = hashlib.sha256()
    for path in files:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        manifest[path.name] = digest
        acc.update(path.name.encode())
        acc.update(b"\0")
        acc.update(digest.encode())
        acc.update(b"\n")
    return {"ok": True, "hash": acc.hexdigest(), "files": manifest}


# ── Anchors: what the seal writes and what the integrity gate checks ────────

def file_sha256(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def eval_script_anchor_matches(anchor: str | None, eval_script: str | Path) -> bool:
    """Does `anchor` (GoalContract.eval_script_hash) seal THIS evaluator file?

    The anchor is sha256 of `<run_dir>/eval-suites/<v>.py`. Contracts sealed by
    v1.2.6–v1.2.9 hold instead a digest over the evaluator's whole file set — a
    change that left every reader comparing a plain sha256 against it, so every
    node failed `no_eval_shift`. That digest commits to the same bytes (it is
    built from each file's sha256), so it is accepted here; nothing is weakened.
    Re-sealing such a run rewrites the anchor to the per-file form.
    """
    if not anchor:
        return False
    path = Path(eval_script)
    if not path.exists():
        return False
    if file_sha256(path) == anchor:
        return True
    run_dir, version = path.resolve().parent.parent, path.stem
    return evaluator_digest(run_dir, version).get("hash") == anchor


def per_file_anchor(anchor: str | None, eval_script: str | Path) -> str | None:
    """`anchor` in its per-file form, for readers that compare one file's sha256.

    A v1.2.6–v1.2.9 set-digest anchor that seals this evaluator is translated to
    sha256(<v>.py); anything else is returned unchanged, so a genuine mismatch
    still fails wherever it is compared. One translation point, so no reader
    grows its own understanding of the legacy form.
    """
    if anchor and eval_script_anchor_matches(anchor, eval_script):
        return file_sha256(eval_script)
    return anchor


def plugin_anchor_matches(plugin_anchor: str | None, eval_script: str | Path) -> bool | None:
    """Does `eval_plugin_hash` seal the score_plugin.py beside this evaluator?

    None when the contract carries no plugin anchor — nothing to check, which is
    the authored shape. False when an anchor exists and the plugin is missing or
    changed: the metric moved.
    """
    if not plugin_anchor:
        return None
    plugin = Path(eval_script).parent / SCORE_PLUGIN_FILENAME
    return plugin.exists() and file_sha256(plugin) == plugin_anchor


# ── Shapes and capabilities ──────────────────────────────────────────────────

def _is_inference_metric(name: str) -> bool:
    """Does measuring this require loading and running the candidate's model?

    Latency and memory are properties of the model executing, so they cannot be
    recovered from prediction files however they are scored.
    """
    n = name.lower()
    return (
        n.startswith("latency")
        or n.startswith("vram")
        or n.endswith("_ms")
        or n.endswith("_s") and "latency" in n
        or "throughput" in n
        or "peak_mem" in n
    )


def required_capabilities(contract: dict[str, Any]) -> set[str]:
    """Metrics this contract needs measured — declared metrics and every
    constraint's metric, since a constraint commonly guards a SECONDARY metric
    that no metric_spec names."""
    out: set[str] = set()
    for spec in contract.get("metric_specs") or []:
        name = spec.get("metric_name")
        if name:
            out.add(str(name))
        for c in spec.get("constraints") or []:
            metric = c.get("metric")
            if metric:
                out.add(str(metric))
    return out


def capability_gap(contract: dict[str, Any], shape: str = SHAPE_GENERATED) -> list[str]:
    """Metrics `shape` cannot measure for this contract.

    Non-empty means the shape is wrong for the mission. It must be raised where
    the shape is chosen — a declared gate whose metric is never measured does not
    fail, it is SKIPPED, so the run reports a pass it never earned.
    """
    if shape == SHAPE_AUTHORED:
        return []  # an authored evaluator loads the model; nothing is out of reach
    return sorted(m for m in required_capabilities(contract) if _is_inference_metric(m))


def shape_for(contract: dict[str, Any]) -> str:
    """The shape a contract requires."""
    return SHAPE_AUTHORED if capability_gap(contract, SHAPE_GENERATED) else SHAPE_GENERATED


# ── CLI, so the MCP layer derives from this module instead of re-implementing ─

def _main(argv: list[str]) -> int:
    import argparse
    import json

    p = argparse.ArgumentParser(prog="python -m evor.eval_contract")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("digest", help="digest the evaluator's whole file set")
    d.add_argument("--run-dir", required=True)
    d.add_argument("--eval-version", default="v1")
    s = sub.add_parser("shape", help="which shape a run's contract requires")
    s.add_argument("--run-dir", required=True)

    args = p.parse_args(argv)
    if args.cmd == "digest":
        print(json.dumps(evaluator_digest(args.run_dir, args.eval_version)))
        return 0
    contract_path = Path(args.run_dir) / "goal-contract.json"
    try:
        contract = json.loads(contract_path.read_text())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"goal contract is unreadable: {exc}"}))
        return 1
    print(json.dumps({
        "ok": True,
        "shape": shape_for(contract),
        "gap": capability_gap(contract, SHAPE_GENERATED),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
