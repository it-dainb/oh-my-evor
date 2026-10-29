"""The owning writer for the evaluator's files.

`skills/evor-setup/SKILL.md` instructs the agent to write `eval-suites/<v>.py`;
`evor_scaffold_evaluator` says "the mission then writes ONLY score(pred, gt) in
score_plugin.py". Both live under `.evor/runs/`, where the PreToolUse guard
denies Write and Edit for every role, and no tool targeted either file. Both
documented paths dead-ended at the same guard, and a mission setup on 2026-09-14
could only be completed by the operator typing `cp`.

The guard is right and stays: run artifacts are written through their owning
tool, because a direct write bypasses the invariants the tool enforces. This is
the tool, and these are the invariants — every one of them a thing the
hand-written column actually got wrong in the field:

  * it compiles (a syntax error discovered at score time costs a training run)
  * argv conformance: no positional arguments, per the evaluator contract
  * it prints something, so the runner has a result to parse
  * polarity is declared rather than guessed — the defect that once scored a
    blank white page at F 92.32
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from typing import Any

from .eval_contract import SCORE_PLUGIN_FILENAME


def _uses_positional_argv(tree: ast.AST) -> bool:
    """Does this source read sys.argv by index?

    The contract is `python <eval_script>` with no positional arguments. A
    generated harness that required two exited 2 with a usage error under the
    runner that launches it, every time, and nothing caught it because the only
    test invoking an evaluator built its own argv.
    """
    for node in ast.walk(tree):
        if not isinstance(node, ast.Subscript):
            continue
        value = node.value
        if (
            isinstance(value, ast.Attribute)
            and value.attr == "argv"
            and isinstance(value.value, ast.Name)
            and value.value.id == "sys"
        ):
            # sys.argv[1:] is a slice — argparse's normal input, and fine.
            if isinstance(node.slice, ast.Slice):
                continue
            return True
    return False


def validate(source: str, *, target: str) -> list[str]:
    """Contract violations in `source`. Empty means conformant."""
    problems: list[str] = []
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [f"source does not compile: line {exc.lineno}: {exc.msg}"]

    if target == "score_plugin":
        names = {
            n.name for n in ast.walk(tree)
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        if "score" not in names:
            problems.append(
                "score_plugin.py must define score(pred, gt) — it is what the generated "
                "harness imports"
            )
        if "NotImplementedError" in source:
            problems.append(
                "the stub still raises NotImplementedError; this would seal a metric that "
                "cannot score anything"
            )
        return problems

    if _uses_positional_argv(tree):
        problems.append(
            "the evaluator reads sys.argv by index. The contract is `python <eval_script>` "
            "with NO positional arguments — the runner passes none, so an evaluator that "
            "requires them cannot be launched. Locate the run directory from EVOR_RUN_DIR "
            "or from __file__ (the evaluator lives at <run_dir>/eval-suites/<v>.py)."
        )
    if "print(" not in source:
        problems.append(
            "the evaluator never prints. The contract is exactly one JSON object on "
            "stdout (logs to stderr); without it the runner has no result to parse."
        )
    if "label_semantics" not in source and "LABEL_SEMANTICS" not in source:
        problems.append(
            "polarity is not declared. The contract states label_semantics and the "
            "evaluator must read it rather than assume which pixel value means ink — "
            "guessing is how a blank white page once scored F 92.32."
        )
    return problems


def write(
    run_dir: str | Path,
    eval_version: str,
    source: str,
    target: str = "evaluator",
) -> dict[str, Any]:
    """Validate, then write atomically. Returns the path and digest, or an error."""
    run_dir = Path(run_dir)
    problems = validate(source, target=target)
    if problems:
        return {
            "ok": False,
            "error": "evaluator source does not conform to the contract: "
            + "; ".join(problems),
            "problems": problems,
        }

    dest_dir = run_dir / "eval-suites"
    dest_dir.mkdir(parents=True, exist_ok=True)
    name = SCORE_PLUGIN_FILENAME if target == "score_plugin" else f"{eval_version}.py"
    dest = dest_dir / name

    # Atomic, and never through an existing hardlink: all three field runs'
    # `v1.py` were ONE inode with nlink 5, so a write through an unprotected
    # alias reached every sealed copy.
    tmp = dest.with_suffix(dest.suffix + ".write-tmp")
    tmp.write_text(source)
    tmp.replace(dest)

    from .eval_contract import evaluator_digest
    digest = evaluator_digest(run_dir, eval_version)
    return {
        "ok": True,
        "path": str(dest),
        "target": target,
        "bytes": len(source.encode()),
        "evaluator_hash": digest.get("hash"),
        "files": digest.get("files", {}),
    }


def _main(argv: list[str]) -> int:
    import argparse

    p = argparse.ArgumentParser(prog="python -m evor.eval_contract_writer")
    sub = p.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("write")
    w.add_argument("--run-dir", required=True)
    w.add_argument("--eval-version", default="v1")
    w.add_argument("--target", default="evaluator", choices=["evaluator", "score_plugin"])
    w.add_argument("--stdin-source", action="store_true",
                   help="read the source from stdin rather than --source")
    w.add_argument("--source", default=None)

    args = p.parse_args(argv)
    source = sys.stdin.read() if args.stdin_source else (args.source or "")
    if not source.strip():
        print(json.dumps({"ok": False, "error": "no source provided"}))
        return 1
    result = write(args.run_dir, args.eval_version, source, args.target)
    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
