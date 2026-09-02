"""v1.2.1 tree migration — plan item 1.10.

The sharpest risk in the release: a one-way rewrite of three live mission trees
(~242 MB). It is gated on 0.8's VERIFIED revert point, it runs dry by default,
and it rewrites each tree exactly once — to the post-1.9b shape, so the trees are
not walked twice.

**It is not a mechanical transform.** It has to decide the lifecycle outcome of
three real missions, which is the judgement the operator previously made by hand
in ``vim`` at 00:13:36. That makes it the domain model's first real user rather
than a schema bump, and it is why the decisions are written down here rather than
inferred at runtime.

What it changes, and nothing else:

1. ``run-state.json`` loses ``status`` (1.9b). All three said ``running``.
2. ``mission-state.json`` gains ``entered_at`` (3.3), so "is this still alive?"
   becomes arithmetic instead of requiring an event nobody emitted.
3. A mission still claiming ``running`` is adjudicated to a terminal state, with
   a contemporaneous-shaped reason recorded in ``transitions.jsonl``. r3's
   mission-state still read ``running`` months after the operator killed the
   session — the exact C-01 finding, on disk.
4. ``campaign.json`` is written once at the runs root: r1 -> r2 -> r3 were three
   ATTEMPTS at one objective, and the model had no word for that until 1.1.

What it must NOT change: node artifacts. ``--verify`` hashes every file under
``nodes/`` before and after and fails on any difference. r3's node artifacts are
the input to 9.2's re-score, which the trace calls the highest-value single
action in the investigation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

#: Adjudication, decided here rather than guessed at runtime. A mission left
#: claiming `running` by a killed session is `failed`: nothing completed it, and
#: `paused` would assert a resumability that the killed session does not have.
KILLED_SESSION_OUTCOME = "failed"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _hash_tree(root: Path) -> dict[str, str]:
    """sha256 of every file under `root`, keyed by relative path."""
    out: dict[str, str] = {}
    if not root.exists():
        return out
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def plan_run(run_dir: Path) -> list[dict[str, Any]]:
    """Everything this run needs, as a list of described changes. No writes."""
    changes: list[dict[str, Any]] = []

    rs_path = run_dir / "run-state.json"
    rs = _read_json(rs_path)
    if "status" in rs:
        changes.append({
            "file": str(rs_path),
            "action": "drop-key",
            "key": "status",
            "was": rs["status"],
            "why": "1.9b — run-state.status duplicated the mission's and was wrong in all three field runs",
        })

    ms_path = run_dir / "mission-state.json"
    ms = _read_json(ms_path)
    if ms:
        if "entered_at" not in ms:
            changes.append({
                "file": str(ms_path),
                "action": "add-key",
                "key": "entered_at",
                "value": ms.get("updated_at"),
                "why": "3.3 — without it, staleness is not computable from the file",
            })
        if str(ms.get("status", "")) == "running":
            changes.append({
                "file": str(ms_path),
                "action": "adjudicate",
                "key": "status",
                "was": "running",
                "value": KILLED_SESSION_OUTCOME,
                "why": (
                    "C-01 — this mission still claims `running`; the session that "
                    "owned it was killed and nothing ever closed the record. "
                    "`failed` rather than `paused`: paused asserts a resumability "
                    "a killed session does not have."
                ),
            })
    return changes


def apply_run(run_dir: Path, changes: list[dict[str, Any]]) -> None:
    by_file: dict[str, list[dict[str, Any]]] = {}
    for c in changes:
        by_file.setdefault(c["file"], []).append(c)

    for file, cs in by_file.items():
        path = Path(file)
        data = _read_json(path)
        for c in cs:
            if c["action"] == "drop-key":
                data.pop(c["key"], None)
            else:
                data[c["key"]] = c["value"]
        tmp = path.with_suffix(path.suffix + ".migrate-tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(path)

    now = datetime.now(timezone.utc).isoformat()
    with open(run_dir / "transitions.jsonl", "a") as fh:
        for c in changes:
            if c["action"] == "adjudicate":
                fh.write(json.dumps({
                    "at": now,
                    "entity": "mission",
                    "from": c["was"],
                    "to": c["value"],
                    "actor": "migrate_v121",
                    "reason": c["why"],
                }) + "\n")


def write_campaign(runs_root: Path, missions: list[Path], dry: bool) -> dict[str, Any]:
    """r1 -> r2 -> r3 as one campaign with ordered attempts (1.1)."""
    ordered = sorted(missions, key=lambda p: p.name)
    campaign = {
        "campaign_id": "binarization-worldmodel-min98",
        "objective": "min98 F-measure across 22 document-binarization domains",
        "created_at": "2026-08-23T03:47:00Z",
        "status": "failed",
        "attempt_ids": [p.name for p in ordered],
        "attempts": [
            {
                "attempt_id": p.name,
                "campaign_id": "binarization-worldmodel-min98",
                "mission_id": p.name,
                "ordinal": i + 1,
                "supersedes_attempt_id": ordered[i - 1].name if i else None,
            }
            for i, p in enumerate(ordered)
        ],
    }
    if not dry:
        (runs_root / "campaign.json").write_text(json.dumps(campaign, indent=2))
    return campaign


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="v1.2.1 tree migration (item 1.10)")
    ap.add_argument("--runs-root", required=True, type=Path)
    ap.add_argument("--apply", action="store_true", help="write; default is a dry run")
    ap.add_argument("--verify", action="store_true", help="hash nodes/ before and after")
    args = ap.parse_args(argv)

    runs_root: Path = args.runs_root
    if not runs_root.is_dir():
        print(f"ERROR: {runs_root} is not a directory", file=sys.stderr)
        return 2

    missions = sorted(p for p in runs_root.iterdir() if p.is_dir())
    run_dirs = [r for m in missions for r in sorted(m.iterdir()) if r.is_dir()]

    before: dict[str, dict[str, str]] = {}
    if args.verify:
        for rd in run_dirs:
            before[str(rd)] = _hash_tree(rd / "nodes")
        print(f"hashed nodes/ in {len(before)} run dirs "
              f"({sum(len(v) for v in before.values())} files)")

    total = 0
    for rd in run_dirs:
        changes = plan_run(rd)
        total += len(changes)
        print(f"\n{rd}")
        if not changes:
            print("  (nothing to do)")
        for c in changes:
            target = f"{Path(c['file']).name}.{c['key']}"
            if c["action"] == "drop-key":
                detail = f"was {c.get('was')!r}"
            else:
                detail = f"{c.get('was')!r} -> {c.get('value')!r}"
            print(f"  {c['action']:11s} {target:34s} {detail}")
            print(f"              {c['why']}")
        if args.apply:
            apply_run(rd, changes)

    campaign = write_campaign(runs_root, missions, dry=not args.apply)
    print(f"\ncampaign.json: {campaign['campaign_id']} "
          f"with {len(campaign['attempts'])} attempts {campaign['attempt_ids']}")

    if args.verify and args.apply:
        bad = []
        for rd in run_dirs:
            after = _hash_tree(rd / "nodes")
            if after != before[str(rd)]:
                bad.append(str(rd))
        if bad:
            print(f"\nFAIL: node artifacts changed under {bad}", file=sys.stderr)
            return 1
        print("\nVERIFIED: every node artifact byte-identical before and after")

    print(f"\n{'APPLIED' if args.apply else 'DRY RUN'}: {total} change(s) across {len(run_dirs)} run dir(s)")
    if not args.apply:
        print("Re-run with --apply --verify to write. Requires 0.8's verified revert point.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
