"""Derived, researcher-facing views of one Evor run.

Everything here is computed from files already on disk; nothing is cached or
written except by :func:`append_steer`, which appends one line to the run's
``signals-inbox.jsonl`` and touches no other file.

The views answer three questions a researcher asks of a live mission:

* **Is it on the right path?**  ``recipes()`` folds seed siblings into one
  recipe so progress is read off the *median across seeds*, not one lucky run;
  ``progress()`` traces that robust best tick by tick against the contract
  baseline; ``alerts()`` names the ways a rising number can still be wrong
  (metric gaming, seed spread, integrity failures, plateau, a stalled tick).
* **Why did it decide that?**  ``timeline()`` restates each tick's artifacts
  (Mutagen proposals, Selector verdicts, Forge results, Probe verdicts, wiki
  lessons, gotchas, signals, decision-log entries) in plain language.
* **What is the evidence?**  ``node_evidence()`` returns the per-domain table,
  telemetry curves and the parent comparison for one node.

Artifact schemas vary between ticks (agents write free-form JSON around a few
stable keys), so every reader here is tolerant: a missing or oddly shaped
field degrades that one item, never the whole view.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

INBOX_FILENAME = "signals-inbox.jsonl"
STEER_KIND = "human-steer"
STEER_SOURCE = "dashboard:human-steer"
SIGNAL_AXES = ("memory", "compute", "accuracy", "stability", "data", "generalization", "cost")

#: Tick-loop step names, indexed by ``tick-state.current_step``.
STEP_NAMES = {
    0: "Startup",
    1: "Select",
    2: "Ideate",
    3: "Register hypothesis",
    4: "Critique",
    5: "Implement + run",
    6: "Evaluate + integrity",
    7: "Analyze + learn",
    8: "Record",
    9: "Prune / promote",
    10: "Re-score",
}

# Seed suffix tokens: ``-s42``, ``_s7``, ``-seed123`` (bounded by - / _ / end).
_SEED_RE = re.compile(r"(?:(?<=^)|(?<=[-_]))(?:s|seed)(\d{1,6})(?=$|[-_])", re.IGNORECASE)
_TRAIL_IDX_RE = re.compile(r"[-_]\d{1,3}$")
_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_SAMPLE_DIRS = ("samples", "sample_images", "images", "viz", "visuals", "qualitative")

# Integrity checks where True means "passed" (the leakage / probe flags read the
# other way round: True means the problem was found).
_PASS_IS_TRUE_CHECKS = (
    "split_hash_match", "frozen_split_read_only", "no_test_leakage", "data_provenance_valid",
    "no_eval_shift", "eval_version_consistent", "telemetry_sane", "trainer_completed",
)

# Lesson tags that mark a whole recipe's gain as a metric artefact.
_ARTEFACT_TAGS = {"metric-artefact", "metric-artifact", "artefact", "artifact", "eval-artefact", "eval-artifact", "metric-gaming"}

# Seed spread above this max/min ratio means seed noise dominates the signal.
SPREAD_WARN = 10.0
# A seed scoring this many times the median of its siblings is a lucky seed.
LUCKY_FACTOR = 3.0
# Minutes without a tick-state update before a running step reads as stalled.
STALL_WARN_MIN = 60.0
STALL_CRIT_MIN = 180.0


# ── Small helpers ─────────────────────────────────────────────────────────────


def _read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    try:
        text = path.read_text()
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def parse_ts(value: Any) -> datetime | None:
    """Parse an ISO-8601 timestamp (``Z`` or offset) to an aware UTC datetime."""
    if not isinstance(value, str) or not value:
        return None
    s = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return float(v)
    return None


def _text(v: Any, limit: int = 600) -> str:
    """Flatten an artifact value to readable prose, bounded in length."""
    if v is None:
        return ""
    if isinstance(v, str):
        s = v
    elif isinstance(v, (list, tuple)):
        s = "; ".join(_text(x, limit) for x in v if x is not None)
    elif isinstance(v, dict):
        s = "; ".join(f"{k}: {_text(x, limit)}" for k, x in v.items() if x not in (None, "", [], {}))
    else:
        s = str(v)
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def _first_sentence(s: str, limit: int = 220) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    m = re.search(r"(?<=[.!?])\s", s)
    if m and m.start() <= limit:
        return s[: m.start()]
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def _refs(v: Any) -> set[str]:
    """Node references from a str ('a, b'), list, or stringified list."""
    out: set[str] = set()
    if isinstance(v, str):
        for part in re.split(r"[,\s\[\]'\"]+", v):
            part = part.strip()
            if part:
                out.add(part)
    elif isinstance(v, (list, tuple, set)):
        for x in v:
            out |= _refs(x)
    elif isinstance(v, dict):
        for k in ("node_id", "node", "node_name", "name"):
            if k in v:
                out |= _refs(v[k])
    return out


def normalize_verdict(v: Any) -> str | None:
    s = str(v or "").strip().lower()
    if not s:
        return None
    if "artefact" in s or "artifact" in s or "gaming" in s:
        return "artefact"
    if s.startswith(("confirm", "support", "accept", "genuine")):
        return "confirmed"
    if s.startswith(("refut", "reject", "falsif", "disconfirm")):
        return "refuted"
    if s.startswith(("inconclusive", "mixed", "unclear", "partial")):
        return "inconclusive"
    return None


def seed_and_stem(name: str) -> tuple[str, str | None]:
    """Split ``ema-long-s42-01`` into (``ema-long-01``, ``42``)."""
    m = None
    for m in _SEED_RE.finditer(name or ""):
        pass
    if m is None:
        return name, None
    stem = (name[: m.start()] + name[m.end():]).replace("--", "-").replace("__", "_")
    stem = stem.strip("-_")
    return stem or name, m.group(1)


def recipe_label(stem: str) -> str:
    return _TRAIL_IDX_RE.sub("", stem) or stem


def _dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def clean_json(obj: Any) -> Any:
    """Replace non-finite floats with None so the payload is strict JSON."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {str(k): clean_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean_json(v) for v in obj]
    return obj


_VERDICT_PRIORITY = {"artefact": 0, "refuted": 1, "confirmed": 2, "inconclusive": 3}


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


# ── Insights ──────────────────────────────────────────────────────────────────


class RunInsights:
    """All derived views for one run directory. Instances read lazily and memoise
    within their own lifetime, so build one per request (or per export)."""

    def __init__(self, run_dir: Path, evor_root: Path | None = None, now: datetime | None = None) -> None:
        self.run_dir = Path(run_dir).resolve()
        self.evor_root = Path(evor_root).resolve() if evor_root else self.run_dir.parent.parent.parent
        self.now = now or datetime.now(timezone.utc)
        self._memo: dict[str, Any] = {}

    # ── raw readers ───────────────────────────────────────────────────────────

    def _m(self, key: str, fn):
        if key not in self._memo:
            self._memo[key] = fn()
        return self._memo[key]

    def contract(self) -> dict[str, Any]:
        return self._m("gc", lambda: _read_json(self.run_dir / "goal-contract.json") or {})

    def run_state(self) -> dict[str, Any]:
        return self._m("rs", lambda: _read_json(self.run_dir / "run-state.json") or {})

    def tick_state(self) -> dict[str, Any]:
        return self._m("ts", lambda: _read_json(self.run_dir / "tick-state.json") or {})

    def mission_state(self) -> dict[str, Any]:
        return self._m("ms", lambda: _read_json(self.run_dir / "mission-state.json") or {})

    def strategy(self) -> dict[str, Any]:
        return self._m("st", lambda: _read_json(self.run_dir / "strategy.json") or {})

    def nodes(self) -> list[dict[str, Any]]:
        def load() -> list[dict[str, Any]]:
            data = _read_json(self.run_dir / "tree.json") or {}
            vals = data.get("nodes", {})
            if isinstance(vals, dict):
                vals = list(vals.values())
            if not isinstance(vals, list):
                return []
            nodes = [n for n in vals if isinstance(n, dict) and n.get("id")]
            nodes.sort(key=lambda n: (str(n.get("created_at") or ""), str(n.get("id"))))
            return nodes
        return self._m("nodes", load)

    def node_index(self) -> dict[str, dict[str, Any]]:
        """Lookup by id AND by name (agents refer to nodes by either)."""
        def build() -> dict[str, dict[str, Any]]:
            idx: dict[str, dict[str, Any]] = {}
            for n in self.nodes():
                if n.get("name"):
                    idx.setdefault(str(n["name"]), n)
            for n in self.nodes():
                idx[str(n["id"])] = n
            return idx
        return self._m("nidx", build)

    def resolve(self, ref: Any) -> dict[str, Any] | None:
        if not ref:
            return None
        return self.node_index().get(str(ref))

    def _node_dirs(self, node: dict[str, Any]) -> list[Path]:
        out = []
        for key in (node.get("id"), node.get("name")):
            if key:
                p = self.run_dir / "nodes" / str(key)
                if p.is_dir() and p not in out:
                    out.append(p)
        return out

    def result(self, node: dict[str, Any]) -> dict[str, Any] | None:
        key = f"res:{node['id']}"
        def load():
            for d in self._node_dirs(node):
                r = _read_json(d / "results.json")
                if isinstance(r, dict):
                    return r
            return None
        return self._m(key, load)

    def integrity(self, node: dict[str, Any]) -> dict[str, Any] | None:
        def load():
            for key in (node.get("id"), node.get("name")):
                if key:
                    r = _read_json(self.run_dir / "evaluations" / f"{key}.json")
                    if isinstance(r, dict):
                        return r
            return None
        return self._m(f"integ:{node['id']}", load)

    def fitness(self, node: dict[str, Any]) -> float | None:
        v = _num(node.get("fitness_value"))
        if v is None:
            r = self.result(node) or {}
            v = _num(r.get("fitness_value"))
        return v

    def integrity_failed(self, node: dict[str, Any]) -> bool:
        if str(node.get("integrity_status") or "").lower() == "failed":
            return True
        rep = self.integrity(node)
        return bool(rep and str(rep.get("verdict")).lower() == "failed")

    def parent_of(self, node: dict[str, Any]) -> dict[str, Any] | None:
        for ref in node.get("parent_ids") or []:
            p = self.resolve(ref)
            if p is not None and p["id"] != node["id"]:
                return p
        if node.get("parent_id"):
            return self.resolve(node.get("parent_id"))
        return None

    def higher_is_better(self) -> bool:
        return self.primary_metric()["direction"] != "lower"

    def better(self, a: float | None, b: float | None) -> bool:
        """True when fitness *a* beats *b* under the contract's direction."""
        if a is None:
            return False
        if b is None:
            return True
        return a > b if self.higher_is_better() else a < b

    def primary_metric(self) -> dict[str, Any]:
        gc = self.contract()
        specs = gc.get("metric_specs")
        if isinstance(specs, str):
            try:
                specs = json.loads(specs)
            except ValueError:
                specs = None
        name, direction = None, "higher"
        if isinstance(specs, list):
            for s in specs:
                if isinstance(s, dict) and s.get("role") == "primary_fitness":
                    name, direction = s.get("metric_name"), s.get("direction") or "higher"
                    break
            if name is None and specs and isinstance(specs[0], dict):
                name, direction = specs[0].get("metric_name"), specs[0].get("direction") or "higher"
        return {
            "name": name or "fitness",
            "direction": direction,
            "baseline": _num(gc.get("baseline_value")),
            "target": _num(gc.get("target_value")),
            "fitness_mode": gc.get("fitness_mode"),
        }

    # ── ticks ─────────────────────────────────────────────────────────────────

    def tick_numbers(self) -> list[int]:
        def load():
            ticks = set()
            tdir = self.run_dir / "ticks"
            if tdir.is_dir():
                for p in tdir.iterdir():
                    if p.is_dir() and p.name.isdigit():
                        ticks.add(int(p.name))
            for rec in self.run_state().get("tick_records") or []:
                if isinstance(rec, dict) and isinstance(rec.get("tick"), int):
                    ticks.add(rec["tick"])
            ts = self.tick_state().get("tick")
            if isinstance(ts, int) and ts > 0:
                ticks.add(ts)
            return sorted(ticks)
        return self._m("ticks", load)

    def tick_starts(self) -> dict[int, datetime]:
        """Earliest artifact mtime per tick directory: the tick's start time."""
        def load():
            out: dict[int, datetime] = {}
            for t in self.tick_numbers():
                d = self.run_dir / "ticks" / str(t)
                best: float | None = None
                if d.is_dir():
                    for root, _dirs, files in os.walk(d):
                        for f in files:
                            try:
                                m = os.stat(os.path.join(root, f)).st_mtime
                            except OSError:
                                continue
                            best = m if best is None or m < best else best
                if best is not None:
                    out[t] = datetime.fromtimestamp(best, tz=timezone.utc)
            # Ticks must start in order; clamp so a re-written early file can't
            # pull a later tick's start before its predecessor's.
            prev = None
            for t in sorted(out):
                if prev is not None and out[t] < prev:
                    out[t] = prev
                prev = out[t]
            return out
        return self._m("tstarts", load)

    def tick_for_time(self, dt: datetime | None) -> int | None:
        if dt is None:
            return None
        starts = self.tick_starts()
        tick = None
        for t in sorted(starts):
            if starts[t] <= dt:
                tick = t
        if tick is None and starts:
            run_start = parse_ts(self.contract().get("created_at"))
            if run_start and dt >= run_start:
                return min(starts)
        return tick

    def _tick_file(self, tick: int, role: str, name: str) -> dict[str, Any] | None:
        d = self.run_dir / "ticks" / str(tick) / role
        for fname in (f"{name}.json", f"{name}-partial.json"):
            r = _read_json(d / fname)
            if isinstance(r, dict):
                return r
        return None

    def proposals(self, tick: int) -> list[dict[str, Any]]:
        d = self._tick_file(tick, "mutagen", "proposals") or {}
        return [p for p in d.get("proposals") or [] if isinstance(p, dict)]

    def proposal_index(self) -> dict[str, dict[str, Any]]:
        def build():
            idx: dict[str, dict[str, Any]] = {}
            for t in self.tick_numbers():
                for p in self.proposals(t):
                    rec = dict(p)
                    rec["_tick"] = t
                    hyp = p.get("hypothesis") if isinstance(p.get("hypothesis"), dict) else {}
                    for k in (p.get("proposal_id"), hyp.get("id")):
                        if k:
                            idx[str(k)] = rec
            return idx
        return self._m("pidx", build)

    def selector(self, tick: int) -> dict[str, Any]:
        return self._tick_file(tick, "selector", "verdict") or {}

    def forge_reports(self, tick: int) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        d = self.run_dir / "ticks" / str(tick) / "forge"
        if not d.is_dir():
            return out
        for sub in sorted(p for p in d.iterdir() if p.is_dir()):
            rep = _read_json(sub / "forge-report.json") or _read_json(sub / "forge-report-partial.json")
            if isinstance(rep, dict):
                out[sub.name] = rep
        return out

    def probe(self, tick: int) -> dict[str, Any]:
        return self._tick_file(tick, "probe", "findings") or {}

    def sage(self, tick: int) -> dict[str, Any]:
        return self._tick_file(tick, "sage", "findings") or {}

    def node_ticks(self) -> dict[str, int]:
        """node id → the tick that built it (Forge dir name, else created_at window)."""
        def build():
            out: dict[str, int] = {}
            for t in self.tick_numbers():
                for dirname, rep in self.forge_reports(t).items():
                    for ref in {dirname, str(rep.get("node_id") or ""), str(rep.get("node") or "")}:
                        n = self.resolve(ref)
                        if n is not None and n["id"] not in out:
                            out[n["id"]] = t
            for n in self.nodes():
                if n["id"] not in out:
                    t = self.tick_for_time(parse_ts(n.get("created_at")))
                    if t is not None:
                        out[n["id"]] = t
            return out
        return self._m("nticks", build)

    # ── knowledge: lessons, gotchas, signals, decision log ────────────────────

    def lessons(self) -> list[dict[str, Any]]:
        """Wiki lessons written for this run (run-scoped copies), richest first."""
        def load():
            index: dict[str, dict[str, Any]] = {}
            for rec in _read_jsonl(self.evor_root / "wiki" / "index.jsonl"):
                if rec.get("lesson_id"):
                    index[str(rec["lesson_id"])] = rec
            out = []
            wdir = self.run_dir / "wiki"
            if wdir.is_dir():
                for p in sorted(wdir.glob("*.md")):
                    out.append(self._parse_lesson(p, index.get(p.stem)))
            out.sort(key=lambda r: r.get("created_at") or "")
            return out
        return self._m("lessons", load)

    def _parse_lesson(self, path: Path, indexed: dict[str, Any] | None) -> dict[str, Any]:
        try:
            text = path.read_text()
        except OSError:
            text = ""

        def field(label: str) -> str:
            m = re.search(rf"\*\*{label}:\*\*\s*([^|\n]*)", text)
            return m.group(1).strip() if m else ""

        def section(title: str) -> str:
            m = re.search(rf"^## {title}\s*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
            return m.group(1).strip() if m else ""

        tags = [t.strip() for t in field("Tags").split(",") if t.strip()]
        rec = {
            "lesson_id": path.stem,
            "node": field("Node") or (indexed or {}).get("node_id") or None,
            "family": field("Family") or (indexed or {}).get("approach_family"),
            "verdict": (field("Verdict") or (indexed or {}).get("hypothesis_verdict") or "").lower() or None,
            "created_at": field("Created") or (indexed or {}).get("created_at"),
            "observation": _text(section("Observation") or (indexed or {}).get("observation"), 900),
            "lesson": _text(section("Actionable Lesson") or (indexed or {}).get("actionable_lesson"), 900),
            "tags": tags or list((indexed or {}).get("tags") or []),
        }
        rec["artefact"] = normalize_verdict(rec["verdict"]) == "artefact" or any(t.lower() in _ARTEFACT_TAGS for t in rec["tags"])
        rec["artefact_hint"] = rec["artefact"] or any("artefact" in t.lower() or "artifact" in t.lower() for t in rec["tags"])
        rec["tick"] = self._lesson_tick(rec)
        return rec

    def _lesson_tick(self, rec: dict[str, Any]) -> int | None:
        for t in rec.get("tags") or []:
            m = re.fullmatch(r"tick(\d+)", t)
            if m:
                return int(m.group(1))
        m = re.search(r"(?:^|-)t(\d+)-", rec["lesson_id"])
        if m:
            return int(m.group(1))
        return self.tick_for_time(parse_ts(rec.get("created_at")))

    def gotchas(self) -> list[dict[str, Any]]:
        """Gotchas first seen during this run (mission-scoped and global)."""
        def load():
            start = parse_ts(self.contract().get("created_at")) or min(self.tick_starts().values(), default=None)
            out = []
            sources = [
                (self.run_dir / "gotchas" / "mission.jsonl", "mission"),
                (self.evor_root / "wiki" / "gotchas" / "global.jsonl", "global"),
            ]
            for path, scope in sources:
                for g in _read_jsonl(path):
                    first = parse_ts(g.get("first_seen"))
                    if scope == "global" and (start is None or first is None or first < start):
                        continue
                    out.append({
                        "gotcha_id": g.get("gotcha_id"),
                        "kind": g.get("kind"),
                        "signature": g.get("signature"),
                        "avoidance": _text(g.get("avoidance") or g.get("resolution"), 400),
                        "scope": scope,
                        "occurrences": g.get("occurrences"),
                        "first_seen": g.get("first_seen"),
                        "tick": self.tick_for_time(first),
                    })
            return out
        return self._m("gotchas", load)

    def signals(self) -> list[dict[str, Any]]:
        return self._m("signals", lambda: _read_jsonl(self.run_dir / "signals.jsonl"))

    def decision_log(self) -> list[dict[str, Any]]:
        """Parse decision-log.md into dated entries."""
        def load():
            try:
                text = (self.run_dir / "decision-log.md").read_text()
            except OSError:
                return []
            entries: list[dict[str, Any]] = []
            cur: dict[str, Any] | None = None
            for line in text.splitlines():
                h = re.match(r"^##\s+(\S+)\s+(\S+)\s*$", line)
                if h and parse_ts(h.group(2)):
                    cur = {"kind": h.group(1), "at": h.group(2), "fields": {}}
                    entries.append(cur)
                    continue
                inline = re.match(r"^-\s+`([^`]+)`\s+\*\*(.+?)\*\*\s*[—-]*\s*(.*)$", line)
                if inline and parse_ts(inline.group(1)):
                    entries.append({"kind": "event", "at": inline.group(1), "title": inline.group(2), "text": inline.group(3)})
                    cur = None
                    continue
                kv = re.match(r"^-\s+([\w ]+):\s*(.*)$", line)
                if kv and cur is not None:
                    cur["fields"][kv.group(1).strip()] = kv.group(2).strip()
            for e in entries:
                e["tick"] = self.tick_for_time(parse_ts(e["at"]))
                e["text"] = self._describe_log(e)
            return entries
        return self._m("dlog", load)

    def _describe_log(self, e: dict[str, Any]) -> str:
        if e["kind"] == "event":
            return f"{e.get('title', '')} — {e.get('text', '')}".strip(" —")
        f = e.get("fields") or {}
        if e["kind"] == "record" and f.get("node_id"):
            n = self.resolve(f["node_id"])
            nm = (n or {}).get("name") or f["node_id"][:8]
            bits = [b for b in (f.get("approach_family"), f.get("status") and f"status {f['status']}") if b]
            return f"Recorded node {nm}" + (f" ({', '.join(bits)})" if bits else "")
        body = ", ".join(f"{k}: {v}" for k, v in f.items())
        return f"{e['kind']}: {body}" if body else e["kind"]

    # ── recipes ───────────────────────────────────────────────────────────────

    def recipes(self) -> list[dict[str, Any]]:
        return self._m("recipes", self._build_recipes)

    def recipe_of(self) -> dict[str, str]:
        self.recipes()
        return self._memo["recipe_of"]

    def _build_recipes(self) -> list[dict[str, Any]]:
        nodes = self.nodes()
        group_of: dict[str, str] = {}
        groups: dict[str, list[dict[str, Any]]] = {}
        meta: dict[str, dict[str, Any]] = {}

        # Pass 1 — name stem: seed siblings share (stem, parent); a node whose
        # parent has its own stem is a seed replicate of that parent.
        for n in nodes:
            stem, seed = seed_and_stem(str(n.get("name") or n["id"]))
            parent = self.parent_of(n)
            if parent is not None and parent["id"] in group_of:
                pstem, _ = seed_and_stem(str(parent.get("name") or parent["id"]))
                if pstem == stem:
                    gid = group_of[parent["id"]]
                    group_of[n["id"]] = gid
                    groups[gid].append(n)
                    continue
            gid = f"{stem}@{parent['id'] if parent else 'root'}"
            group_of[n["id"]] = gid
            groups.setdefault(gid, []).append(n)
            meta.setdefault(gid, {"stem": stem, "parent": parent})

        # Pass 2 — differently named singletons that share parent + hypothesis
        # are replicates of one recipe too.
        by_hyp: dict[tuple[str, str], str] = {}
        for gid in list(groups):
            members = groups[gid]
            if len(members) != 1:
                continue
            n = members[0]
            if seed_and_stem(str(n.get("name") or ""))[1] is not None or not n.get("hypothesis_id"):
                continue
            parent = meta[gid]["parent"]
            key = (parent["id"] if parent else "root", str(n["hypothesis_id"]))
            if key in by_hyp and by_hyp[key] in groups:
                target = by_hyp[key]
                groups[target].append(n)
                group_of[n["id"]] = target
                del groups[gid]
            else:
                by_hyp[key] = gid

        verdicts = self.node_verdicts()
        lessons = self.lessons()
        node_tick = self.node_ticks()
        pidx = self.proposal_index()
        pruned = self.pruned_ids()

        recipes: list[dict[str, Any]] = []
        for gid, members in groups.items():
            stem = meta[gid]["stem"]
            label = recipe_label(stem)
            stems = {seed_and_stem(str(n.get("name") or n["id"]))[0] for n in members}
            if len(stems) > 1:
                # Differently named replicates: label by their shared prefix.
                common = os.path.commonprefix(sorted(stems)).rstrip("-_")
                if len(common) >= 3:
                    label = recipe_label(common)
            parent = meta[gid]["parent"]
            member_names = {str(n.get("name") or "") for n in members} | {n["id"] for n in members}
            rec_lessons = [
                l for l in lessons
                if (l.get("node") and l["node"] in member_names)
                or any(t.lower() == label.lower() for t in l.get("tags") or [])
            ]
            rows = []
            for n in members:
                nv = verdicts.get(n["id"]) or {}
                tagged = bool(nv.get("artefact_suspect")) or any(
                    l["artefact"] and l.get("node") in (n["id"], n.get("name")) for l in rec_lessons)
                fit = self.fitness(n)
                res = self.result(n)
                rows.append({
                    "id": n["id"],
                    "name": n.get("name") or n["id"],
                    "seed": _seed_label(n),
                    "fitness": fit,
                    "has_result": res is not None,
                    "status": n.get("status"),
                    "integrity_failed": self.integrity_failed(n),
                    "pruned": n["id"] in pruned,
                    "verdict": (verdicts.get(n["id"]) or {}).get("verdict"),
                    "artefact": tagged,
                    "tick": node_tick.get(n["id"]),
                    "badges": [],
                })
            # Only nodes explicitly tagged as artefacts leave the robust median;
            # their siblings still count.
            valid = [r["fitness"] for r in rows if r["fitness"] is not None and not r["integrity_failed"] and not r["artefact"]]
            med = _median(valid)
            lo, hi = (min(valid), max(valid)) if valid else (None, None)
            spread = None
            if len(valid) >= 2 and lo is not None and hi is not None:
                if lo > 0:
                    spread = hi / lo
                elif lo <= 0 < hi:
                    spread = math.inf
            # Lucky seed: one seed far better than the median of its siblings
            # (a factor of the median for higher-is-better, of its inverse otherwise).
            if len(valid) >= 2:
                higher = self.higher_is_better()
                top = hi if higher else lo
                for r in rows:
                    f = r["fitness"]
                    if f is None or r["integrity_failed"] or r["artefact"] or f != top:
                        continue
                    others = [x["fitness"] for x in rows if x is not r and x["fitness"] is not None and not x["integrity_failed"] and not x["artefact"]]
                    om = _median(others)
                    if om is None:
                        continue
                    lucky = (f > 0 and f >= LUCKY_FACTOR * max(om, 0.0)) if higher else (om > 0 and f >= 0 and f * LUCKY_FACTOR <= om)
                    if lucky:
                        r["badges"].append("lucky-seed")
            for r in rows:
                if r["pruned"]:
                    r["badges"].append("pruned")
                if r["integrity_failed"]:
                    r["badges"].append("integrity-failed")
                if r["artefact"]:
                    r["badges"].append("artefact")

            # Verdict: artefact only when every scored seed is tagged one;
            # otherwise Probe > lesson > pending, with a "suspect" flag when any
            # seed is tagged or an audit / lesson names the whole recipe.
            node_vs = [r["verdict"] for r in rows if r["verdict"]]
            suspect = any(r["artefact"] for r in rows) or any(
                (verdicts.get(r["id"]) or {}).get("recipe_artefact") for r in rows
            ) or any(l["artefact"] for l in rec_lessons)
            scored = [r for r in rows if r["fitness"] is not None and not r["integrity_failed"]]
            source, evidence = None, None
            if scored and all(r["artefact"] for r in scored):
                verdict = "artefact"
                art = next((l for l in rec_lessons if l["artefact"]), None)
                source = f"wiki:{art['lesson_id']}" if art else "probe"
                evidence = (art or {}).get("lesson") or next(
                    ((verdicts.get(r["id"]) or {}).get("evidence") for r in rows if (verdicts.get(r["id"]) or {}).get("evidence")), None)
            elif node_vs:
                verdict = sorted(set(node_vs), key=lambda v: (-node_vs.count(v), _VERDICT_PRIORITY.get(v, 9)))[0]
                pv = next(verdicts[r["id"]] for r in rows if r["verdict"] == verdict)
                source, evidence = f"probe:tick{pv.get('tick')}", pv.get("evidence")
            elif any(normalize_verdict(l.get("verdict")) for l in rec_lessons):
                l = next(l for l in rec_lessons if normalize_verdict(l.get("verdict")))
                verdict, source, evidence = normalize_verdict(l["verdict"]), f"wiki:{l['lesson_id']}", l.get("lesson")
            else:
                verdict = "pending"
            if verdict == "inconclusive":
                verdict_display = "inconclusive"
            else:
                verdict_display = verdict

            badges = sorted({b for r in rows for b in r["badges"] if b != "artefact"})
            if suspect:
                badges.append("artefact-suspect")
            if spread is not None and spread >= SPREAD_WARN:
                badges.append("seed-spread")
            first = members[0]
            hyp = pidx.get(str(first.get("hypothesis_id") or "")) or {}
            hyp_obj = hyp.get("hypothesis") if isinstance(hyp.get("hypothesis"), dict) else {}
            ticks = [r["tick"] for r in rows if r["tick"] is not None]
            recipes.append({
                "id": gid,
                "label": label,
                "stem": stem,
                "parent_node_id": parent["id"] if parent else None,
                "parent_recipe": None,  # filled below
                "family": first.get("approach_family"),
                "hypothesis_id": first.get("hypothesis_id"),
                "hypothesis": _text(hyp_obj.get("statement"), 500) or None,
                "prediction": _text(hyp_obj.get("prediction"), 400) or None,
                "idea": _text(hyp.get("idea"), 500) or None,
                "tick": min(ticks) if ticks else None,
                "n": len(rows),
                "n_valid": len(valid),
                "median": med,
                "min": lo,
                "max": hi,
                "spread": None if spread is None else (None if math.isinf(spread) else spread),
                "spread_unbounded": bool(spread is not None and math.isinf(spread)),
                "verdict": verdict_display,
                "verdict_source": source,
                "verdict_evidence": _text(evidence, 700) or None,
                "credible": med is not None,
                "suspect": suspect,
                "suspect_evidence": _text(next((l.get("lesson") for l in rec_lessons if l["artefact"]), None) or next(
                    ((verdicts.get(r["id"]) or {}).get("evidence") for r in rows
                     if (verdicts.get(r["id"]) or {}).get("artefact_suspect") or (verdicts.get(r["id"]) or {}).get("recipe_artefact")), None), 700) or None,
                "badges": badges,
                "lessons": [l["lesson_id"] for l in rec_lessons],
                "members": rows,
            })

        recipe_of = {nid: gid for nid, gid in group_of.items() if gid in groups}
        for r in recipes:
            pid = r["parent_node_id"]
            r["parent_recipe"] = recipe_of.get(pid) if pid else None
            if r["parent_recipe"] == r["id"]:
                r["parent_recipe"] = None
        recipes.sort(key=lambda r: (r["tick"] if r["tick"] is not None else 10**9, r["label"]))
        self._memo["recipe_of"] = recipe_of
        return recipes

    def pruned_ids(self) -> set[str]:
        def build():
            out = {n["id"] for n in self.nodes() if str(n.get("status")).lower() == "pruned"}
            latest: dict[str, str] = {}
            for e in self.decision_log():
                f = e.get("fields") or {}
                if e["kind"] == "record" and f.get("node_id") and f.get("status"):
                    latest[f["node_id"]] = f["status"].lower()
                if e["kind"] in ("prune", "pruned") and f.get("node_id"):
                    latest[f["node_id"]] = "pruned"
            for nid, st in latest.items():
                n = self.resolve(nid)
                if n is not None and st == "pruned":
                    out.add(n["id"])
            for t in self.tick_numbers():
                for rep in self.forge_reports(t).values():
                    for ref in _refs(rep.get("recommend_prune")):
                        n = self.resolve(ref)
                        if n is not None:
                            out.add(n["id"])
            return out
        return self._m("pruned", build)

    # ── verdicts from Probe ───────────────────────────────────────────────────

    def node_verdicts(self) -> dict[str, dict[str, Any]]:
        """node id → {verdict, tick, evidence, artefact_suspect, recipe_artefact}."""
        return self._m("nverd", self._build_node_verdicts)

    def _probe_items(self, tick: int) -> list[dict[str, Any]]:
        """Normalised Probe verdicts for one tick: [{verdict, hyps, refs, evidence}]."""
        d = self.probe(tick)
        if not d:
            return []
        pidx = self.proposal_index()
        items: list[dict[str, Any]] = []

        def hyps_of(obj: dict[str, Any]) -> set[str]:
            out = set()
            for k in ("hypothesis", "hypothesis_id"):
                v = obj.get(k)
                if isinstance(v, str) and v:
                    out.add(v)
            pid = obj.get("proposal_id")
            if isinstance(pid, str) and pid in pidx:
                h = pidx[pid].get("hypothesis")
                if isinstance(h, dict) and h.get("id"):
                    out.add(str(h["id"]))
            return out

        def refs_of(obj: dict[str, Any]) -> set[str]:
            out: set[str] = set()
            for k in ("node_id", "node_name", "nodes", "node_set", "node"):
                if k in obj:
                    out |= _refs(obj[k])
            le = obj.get("lesson_entry")
            if isinstance(le, dict) and le.get("node_id"):
                out |= _refs(le["node_id"])
            return out

        listed = d.get("hypothesis_verdicts")
        if isinstance(listed, list):
            for it in listed:
                if isinstance(it, dict):
                    items.append({
                        "verdict": normalize_verdict(it.get("verdict")),
                        "raw": it.get("verdict"),
                        "hyps": hyps_of(it),
                        "refs": refs_of(it),
                        "evidence": _text(it.get("evidence"), 700),
                    })
        hv = d.get("hypothesis_verdict")
        if isinstance(hv, str) and hv:
            hyps, refs = hyps_of(d), refs_of(d)
            if not hyps and not refs:
                # No explicit target: the tick's selected proposals were tested.
                for p in self._selected_proposals(tick):
                    h = p.get("hypothesis")
                    if isinstance(h, dict) and h.get("id"):
                        hyps.add(str(h["id"]))
            items.append({
                "verdict": normalize_verdict(hv),
                "raw": hv,
                "hyps": hyps,
                "refs": refs,
                "evidence": _text(d.get("evidence") or d.get("verdict_summary") or d.get("eda_summary"), 700),
            })
        # Audits: "<target>_audit": {"verdict": "..."} — artefact calls live here.
        for k, v in d.items():
            if not (k.endswith("_audit") and isinstance(v, dict)):
                continue
            target = k[: -len("_audit")].replace("_", "-")
            refs = _refs(v.get("node_id")) if v.get("node_id") else set()
            items.append({
                "verdict": normalize_verdict(v.get("verdict")),
                "raw": v.get("verdict"),
                "hyps": set(),
                "refs": refs,
                "audit_target": target,
                "evidence": _text(v.get("verdict"), 400),
                "audit": True,
            })
        return items

    def _selected_proposals(self, tick: int) -> list[dict[str, Any]]:
        sel = self.selector(tick)
        props = {str(p.get("proposal_id")): p for p in self.proposals(tick)}
        chosen = [str(r.get("proposal_id")) for r in sel.get("reviews") or [] if isinstance(r, dict) and r.get("selected")]
        if not chosen and sel.get("winner"):
            chosen = [str(sel["winner"])]
        return [props[c] for c in chosen if c in props]

    def _build_node_verdicts(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        nodes = self.nodes()
        for t in self.tick_numbers():
            for it in self._probe_items(t):
                targets: list[dict[str, Any]] = []
                for ref in it["refs"]:
                    n = self.resolve(ref)
                    if n is not None:
                        targets.append(n)
                explicit = {n["id"] for n in targets}
                if it["hyps"]:
                    targets += [n for n in nodes if str(n.get("hypothesis_id")) in it["hyps"]]
                recipe_wide = False
                if it.get("audit") and not targets:
                    tgt = it["audit_target"]
                    stem_hits = [n for n in nodes if recipe_label(seed_and_stem(str(n.get("name") or ""))[0]) == tgt]
                    name_hits = [n for n in nodes if str(n.get("name") or "").startswith(tgt)]
                    if stem_hits:
                        targets, recipe_wide = stem_hits, True
                    else:
                        targets = name_hits
                        explicit = {n["id"] for n in name_hits}
                seen = set()
                for n in targets:
                    if n["id"] in seen:
                        continue
                    seen.add(n["id"])
                    rec = out.setdefault(n["id"], {})
                    if it["verdict"] == "artefact":
                        # A node is tagged only when the call names it; a call on
                        # the recipe or hypothesis marks the recipe suspect.
                        if recipe_wide or n["id"] not in explicit:
                            rec["recipe_artefact"] = True
                        else:
                            rec["artefact_suspect"] = True
                        rec.setdefault("evidence", it["evidence"])
                        rec.setdefault("tick", t)
                        continue
                    if it.get("audit"):
                        continue  # audit notes refine, they don't replace the Probe verdict
                    if it["verdict"]:
                        rec.update({"verdict": it["verdict"], "tick": t, "evidence": it["evidence"]})
        return out

    # ── progress ──────────────────────────────────────────────────────────────

    def progress(self) -> list[dict[str, Any]]:
        """Per tick: robust best (best credible recipe median, ≥2 seeds), best
        single node so far, and the recipes evaluated that tick."""
        recipes = self.recipes()
        node_tick = self.node_ticks()
        ticks = self.tick_numbers()
        if not ticks:
            ticks = sorted({t for t in node_tick.values()})
        scores = {r.get("tick"): r for r in self.run_state().get("tick_records") or [] if isinstance(r, dict)}
        tagged_ids = {m["id"] for r in recipes for m in r["members"] if m["artefact"]}
        out = []
        robust_best = None
        any_best = None
        node_best = None
        for t in ticks:
            # Recomputed every tick, not a running max: a recipe's median falls
            # when a new seed disappoints, and the robust trend must show that.
            cur_robust, cur_any = None, None
            for r in recipes:
                vals = [m["fitness"] for m in r["members"] if m["fitness"] is not None and not m["integrity_failed"] and not m["artefact"] and m["tick"] is not None and m["tick"] <= t]
                med = _median(vals)
                if med is None or not r["credible"]:
                    continue
                cand = {"recipe": r["id"], "label": r["label"], "median": med, "n": len(vals), "since_tick": t}
                if len(vals) >= 2 and (cur_robust is None or self.better(med, cur_robust["median"])):
                    cur_robust = cand
                if cur_any is None or self.better(med, cur_any["median"]):
                    cur_any = dict(cand)
            for prev, cur in ((robust_best, cur_robust), (any_best, cur_any)):
                if prev and cur and prev["recipe"] == cur["recipe"] and prev["median"] == cur["median"]:
                    cur["since_tick"] = prev["since_tick"]
            robust_best, any_best = cur_robust, cur_any
            for n in self.nodes():
                if node_tick.get(n["id"]) == t and not self.integrity_failed(n) and n["id"] not in tagged_ids:
                    f = self.fitness(n)
                    if f is not None and (node_best is None or self.better(f, node_best["fitness"])):
                        node_best = {"id": n["id"], "name": n.get("name"), "fitness": f, "since_tick": t}
            this_tick = [
                {"recipe": r["id"], "label": r["label"], "median": r["median"], "min": r["min"], "max": r["max"],
                 "n": r["n_valid"], "verdict": r["verdict"], "credible": r["credible"]}
                for r in recipes if r["tick"] == t
            ]
            rec = scores.get(t) or {}
            out.append({
                "tick": t,
                "robust_best": dict(robust_best) if robust_best else None,
                "recipe_best": dict(any_best) if any_best else None,
                "best_node": dict(node_best) if node_best else None,
                "tick_score": _num(rec.get("score")),
                "outcome": rec.get("outcome"),
                "recipes": this_tick,
            })
        return out

    # ── alerts ────────────────────────────────────────────────────────────────

    def gaming_checks(self) -> list[dict[str, Any]]:
        """Nodes whose fitness rose vs their parent while recall / F / ink fell
        on a floor domain (the parent's or their own)."""
        out = []
        for n in self.nodes():
            parent = self.parent_of(n)
            if parent is None or self.integrity_failed(n):
                continue
            f, pf = self.fitness(n), self.fitness(parent)
            if f is None or pf is None or not self.better(f, pf):
                continue
            res, pres = self.result(n) or {}, self.result(parent) or {}
            pd, ppd = _dict(res.get("per_domain")), _dict(pres.get("per_domain"))
            if not pd or not ppd:
                continue
            fm = self.floor_metric(pd)
            floors = []
            for which, table in (("parent floor", ppd), ("own floor", pd)):
                d = self.floor_domain(table, fm)
                if d and d not in [x[1] for x in floors]:
                    floors.append((which, d))
            for which, d in floors:
                a, b = _dict(pd.get(d)), _dict(ppd.get(d))
                drops = []
                for key in self._quality_keys(a, b):
                    va, vb = _num(a.get(key)), _num(b.get(key))
                    if va is None or vb is None:
                        continue
                    scale = 100.0 if max(abs(va), abs(vb)) > 1.5 else 1.0
                    tol = (0.05 if key.lower().startswith("recall") else 0.03) * scale
                    if vb - va >= tol:
                        drops.append({"metric": key, "parent": vb, "node": va})
                sa, sb = _num(a.get(fm)), _num(b.get(fm))
                # The gaming signature: the domain's score went up while the
                # quality it is meant to measure went down.
                if drops and sa is not None and sb is not None and sa > sb:
                    out.append({
                        "node_id": n["id"], "name": n.get("name"),
                        "parent_id": parent["id"], "parent_name": parent.get("name"),
                        "fitness": f, "parent_fitness": pf,
                        "domain": d, "which": which, "floor_metric": fm,
                        "floor_metric_parent": sb, "floor_metric_node": sa,
                        "drops": drops,
                    })
                    break
        return out

    @staticmethod
    def floor_metric(per_domain: dict[str, Any]) -> str:
        for cand in ("S", "score", "fmeasure", "f1", "accuracy"):
            if any(isinstance(v, dict) and _num(v.get(cand)) is not None for v in per_domain.values()):
                return cand
        for v in per_domain.values():
            if isinstance(v, dict):
                for k, x in v.items():
                    if _num(x) is not None and k != "n":
                        return k
        return "S"

    @staticmethod
    def floor_domain(per_domain: dict[str, Any], metric: str) -> str | None:
        best, best_v = None, None
        for d, v in per_domain.items():
            x = _num((v or {}).get(metric)) if isinstance(v, dict) else None
            if x is not None and (best_v is None or x < best_v):
                best, best_v = d, x
        return best

    @staticmethod
    def _quality_keys(a: dict[str, Any], b: dict[str, Any]) -> list[str]:
        keys = []
        for k in a:
            if k not in b:
                continue
            kl = k.lower()
            if kl in ("recall", "fmeasure", "f_measure", "f1", "f", "line_recall") or "ink" in kl:
                keys.append(k)
        return keys

    def alerts(self) -> list[dict[str, Any]]:
        return self._m("alerts", self._build_alerts)

    def _build_alerts(self) -> list[dict[str, Any]]:
        alerts: list[dict[str, Any]] = []
        recipes = self.recipes()
        recipe_of = self.recipe_of()

        # 1 — metric gaming
        games = self.gaming_checks()
        if games:
            parts = []
            for g in games[:4]:
                drop = ", ".join(f"{d['metric']} {_fmt(d['parent'])}→{_fmt(d['node'])}" for d in g["drops"][:2])
                parts.append(f"{g['name']}: fitness {_fmt(g['parent_fitness'])}→{_fmt(g['fitness'])} but on {g['domain']} ({g['which']}) {drop}")
            alerts.append({
                "kind": "metric-gaming", "severity": "high",
                "title": f"Possible metric gaming on {len(games)} node{'s' if len(games) != 1 else ''}",
                "detail": "Fitness rose against the parent while recall / F / ink fell on a floor domain — the score can rise by erasing ink rather than binarizing better. "
                          + " · ".join(parts),
                "nodes": [g["node_id"] for g in games],
                "recipes": sorted({recipe_of.get(g["node_id"]) for g in games if recipe_of.get(g["node_id"])}),
                "items": games,
            })

        # 2 — seed spread
        multi = [r for r in recipes if r["n_valid"] >= 2]
        wide = [r for r in multi if r["spread_unbounded"] or (r["spread"] or 0) >= SPREAD_WARN]
        if wide:
            wide.sort(key=lambda r: math.inf if r["spread_unbounded"] else r["spread"], reverse=True)
            desc = ", ".join(f"{r['label']} {_spread_txt(r)}" for r in wide[:4])
            alerts.append({
                "kind": "seed-spread",
                "severity": "high" if len(wide) * 2 >= len(multi) else "medium",
                "title": f"Seed noise dominates {len(wide)} of {len(multi)} multi-seed recipes",
                "detail": f"Max/min fitness across seeds ≥ {SPREAD_WARN:.0f}×: {desc}. A single-node gain is not evidence; read the recipe medians.",
                "recipes": [r["id"] for r in wide],
                "nodes": [],
            })

        # 3 — lucky best node
        best = self.best_node()
        if best and "lucky-seed" in best.get("badges", []):
            alerts.append({
                "kind": "lucky-best", "severity": "medium",
                "title": f"Best node {best['name']} looks like a lucky seed",
                "detail": f"It scores {_fmt(best['fitness'])} while its recipe's median across {best['recipe_n']} seeds is {_fmt(best['recipe_median'])}.",
                "nodes": [best["id"]], "recipes": [best["recipe"]],
            })

        # 4 — integrity failures
        failed = [n for n in self.nodes() if self.integrity_failed(n)]
        if failed:
            reasons: dict[str, list[str]] = {}
            for n in failed:
                rep = self.integrity(n) or {}
                reason = str(rep.get("failure_reason") or "integrity check failed").split(":")[0]
                reasons.setdefault(reason, []).append(str(n.get("name") or n["id"]))
            best_val = (best or {}).get("fitness")
            would_lead = [n for n in failed if self.fitness(n) is not None and self.better(self.fitness(n), best_val)]
            alerts.append({
                "kind": "integrity", "severity": "high" if would_lead else "medium",
                "title": f"{len(failed)} node{'s' if len(failed) != 1 else ''} failed integrity",
                "detail": "Excluded from every median. " + " · ".join(f"{k}: {', '.join(v)}" for k, v in reasons.items())
                          + (f" — {len(would_lead)} would otherwise lead the run." if would_lead else ""),
                "nodes": [n["id"] for n in failed], "recipes": [],
            })

        # 5 — plateau
        plateau = self.plateau()
        if plateau["level"] != "ok":
            alerts.append({
                "kind": "plateau", "severity": "high" if plateau["level"] == "critical" else "medium",
                "title": plateau["title"], "detail": plateau["detail"], "nodes": [], "recipes": [],
            })

        # 6 — stalled tick
        stall = self.stall()
        if stall["level"] != "ok":
            alerts.append({
                "kind": "stalled", "severity": "high" if stall["level"] == "critical" else "medium",
                "title": stall["title"], "detail": stall["detail"], "nodes": [], "recipes": [],
            })

        # 7 — high-severity agent signals from the latest two ticks
        ticks = self.tick_numbers()
        recent = set(ticks[-2:]) if ticks else set()
        hot = [s for s in self.signals() if s.get("severity") in ("high", "critical") and s.get("tick") in recent and s.get("kind") != STEER_KIND]
        if hot:
            kinds: dict[str, int] = {}
            for s in hot:
                kinds[str(s.get("kind"))] = kinds.get(str(s.get("kind")), 0) + 1
            alerts.append({
                "kind": "agent-signals", "severity": "medium",
                "title": f"Agents raised {len(hot)} high-severity signal{'s' if len(hot) != 1 else ''} recently",
                "detail": ", ".join(f"{k}{' ×'+str(v) if v > 1 else ''}" for k, v in kinds.items()),
                "nodes": [], "recipes": [],
            })
        order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
        alerts.sort(key=lambda a: order.get(a["severity"], 9))
        return alerts

    def plateau(self) -> dict[str, Any]:
        prog = self.progress()
        gc = self.contract()
        window = _num(((gc.get("budget") or {}) if isinstance(gc.get("budget"), dict) else {}).get("plateau_window")) or 25
        if not prog:
            return {"level": "ok", "ticks_since": 0, "window": window}
        last = prog[-1]["tick"]
        rb = prog[-1]["robust_best"]
        since = last - rb["since_tick"] if rb else len(prog)
        strat = self.strategy()
        rs = self.run_state()
        level = "ok"
        if since >= window:
            level = "critical"
        elif since >= max(3, window / 2):
            level = "warn"
        title = (f"Robust best unchanged for {since} ticks" if rb else f"No multi-seed recipe yet after {since} ticks")
        detail = f"Plateau window is {int(window)} ticks."
        if strat.get("meta_evolve_requested"):
            level = "warn" if level == "ok" else level
            detail += " Strategy has requested a meta-evolve step."
        for key in ("plateau", "plateau_detected", "plateau_count", "ticks_since_improvement"):
            if rs.get(key):
                detail += f" run-state {key}={rs.get(key)}."
                if level == "ok":
                    level = "warn"
        return {"level": level, "ticks_since": since, "window": window, "title": title, "detail": detail}

    def stall(self) -> dict[str, Any]:
        ts = self.tick_state()
        status = str(self.mission_state().get("status") or self.run_state().get("status") or "").lower()
        updated = parse_ts(ts.get("updated_at"))
        out = {"level": "ok", "minutes": None, "step": ts.get("current_step"), "tick": ts.get("tick"),
               "step_name": STEP_NAMES.get(ts.get("current_step")), "step_status": ts.get("step_status"),
               "blocked": ts.get("blocked"), "mission_status": status or None}
        if updated is None:
            return out
        minutes = (self.now - updated).total_seconds() / 60.0
        out["minutes"] = round(minutes, 1)
        out["updated_at"] = _iso(updated)
        if status in ("paused", "stopped", "completed", "done", "failed"):
            return out
        if str(ts.get("step_status") or "").lower() in ("done", "complete", "completed") and ts.get("current_step") in (9, 10):
            return out
        if minutes >= STALL_CRIT_MIN:
            out["level"] = "critical"
        elif minutes >= STALL_WARN_MIN:
            out["level"] = "warn"
        if out["level"] != "ok":
            blocked = ts.get("blocked") or {}
            on = f" Blocked on {blocked.get('on')}." if isinstance(blocked, dict) and blocked.get("on") else ""
            out["title"] = f"Tick {ts.get('tick')} has not advanced for {_dur(minutes)}"
            out["detail"] = f"Step {ts.get('current_step')} ({out['step_name'] or '?'}) is '{ts.get('step_status')}' since {_iso(updated)}.{on}"
        return out

    def best_node(self) -> dict[str, Any] | None:
        best = None
        for r in self.recipes():
            for m in r["members"]:
                if m["fitness"] is None or m["integrity_failed"] or m["artefact"]:
                    continue
                if best is None or self.better(m["fitness"], best["fitness"]):
                    best = dict(m, recipe=r["id"], recipe_label=r["label"], recipe_median=r["median"], recipe_n=r["n_valid"], recipe_verdict=r["verdict"])
        return best

    # ── overview / headline ───────────────────────────────────────────────────

    def overview(self) -> dict[str, Any]:
        pm = self.primary_metric()
        prog = self.progress()
        alerts = self.alerts()
        best = self.best_node()
        robust = prog[-1]["robust_best"] if prog else None
        recipes = {r["id"]: r for r in self.recipes()}
        rob_recipe = recipes.get(robust["recipe"]) if robust else None
        base = pm["baseline"]
        higher = pm["direction"] != "lower"

        def beats(v: float | None) -> bool | None:
            if v is None or base is None:
                return None
            return v > base if higher else v < base

        first_beat = None
        for p in prog:
            rb = p["robust_best"]
            if rb and beats(rb["median"]):
                first_beat = p["tick"]
                break
        high = [a for a in alerts if a["severity"] in ("high", "critical")]
        stall = self.stall()
        plateau = self.plateau()

        if robust and beats(robust["median"]) and not any(a["kind"] in ("metric-gaming", "stalled") and a["severity"] == "high" for a in alerts) and plateau["level"] == "ok":
            status = "on-track" if not high else "watch"
        elif robust and beats(robust["median"]):
            status = "watch"
        else:
            status = "off-track" if (len(prog) >= 5 or stall["level"] == "critical") else "watch"

        why: list[str] = []
        if robust:
            ratio = f" ({robust['median'] / base:.1f}× baseline)" if base and robust["median"] and base > 0 else ""
            why.append(f"Robust best recipe {robust['label']}: median {_fmt(robust['median'])} over {robust['n']} seeds{ratio}"
                       + (f", first credible beat of the baseline at tick {first_beat}." if first_beat else ", still below the baseline.")
                       + (" It is flagged suspect: sibling seeds or the recipe were tagged as artefacts (tagged seeds are excluded from the median)."
                          if rob_recipe and rob_recipe.get("suspect") else ""))
        else:
            why.append("No recipe has two or more credible seeds yet, so there is no robust trend.")
        if best:
            lucky = " — a lucky seed; its recipe median is " + _fmt(best["recipe_median"]) if "lucky-seed" in best["badges"] else ""
            why.append(f"Single best node {best['name']} scores {_fmt(best['fitness'])}{lucky}.")
        if high:
            why.append("Watch: " + "; ".join(a["title"] for a in high[:3]) + ".")
        return {
            "status": status,
            "headline": {"on-track": "On the right path", "watch": "Progressing — with caveats", "off-track": "Not on a winning path yet"}[status],
            "why": why,
            "metric": pm,
            "robust_best": robust,
            "robust_recipe": {k: rob_recipe[k] for k in ("id", "label", "verdict", "n_valid", "min", "max", "median", "family", "suspect")} if rob_recipe else None,
            "best_node": best,
            "first_beat_tick": first_beat,
            "tick": self.tick_state().get("tick") or (prog[-1]["tick"] if prog else None),
            "tick_count": self.run_state().get("tick_count"),
            "stall": stall,
            "plateau": plateau,
            "alerts_high": len(high),
            "n_nodes": len(self.nodes()),
            "n_recipes": len(recipes),
        }

    # ── timeline ──────────────────────────────────────────────────────────────

    def timeline(self) -> list[dict[str, Any]]:
        return self._m("timeline", self._build_timeline)

    def _build_timeline(self) -> list[dict[str, Any]]:
        out = []
        node_tick = self.node_ticks()
        recipe_of = self.recipe_of()
        recipes = {r["id"]: r for r in self.recipes()}
        lessons, gotchas = self.lessons(), self.gotchas()
        signals, dlog = self.signals(), self.decision_log()
        steers = self.steer_notes()
        scores = {r.get("tick"): r for r in self.run_state().get("tick_records") or [] if isinstance(r, dict)}
        starts = self.tick_starts()
        ts = self.tick_state()
        for t in self.tick_numbers():
            props = self.proposals(t)
            sel = self.selector(t)
            reviews = {str(r.get("proposal_id")): r for r in sel.get("reviews") or [] if isinstance(r, dict)}
            proposals = []
            for p in props:
                pid = str(p.get("proposal_id") or "")
                hyp = p.get("hypothesis") if isinstance(p.get("hypothesis"), dict) else {}
                rv = reviews.get(pid) or {}
                cr = rv.get("critic_review") if isinstance(rv.get("critic_review"), dict) else {}
                failed_gates = [k for k, v in cr.items() if isinstance(v, str) and v.lower() in ("fail", "failed", "reject")]
                parents = [((self.resolve(x) or {}).get("name") or str(x)) for x in p.get("parent_node_ids") or []]
                proposals.append({
                    "proposal_id": pid,
                    "family": p.get("approach_family"),
                    "tier": p.get("mutation_tier"),
                    "parents": parents,
                    "angle": p.get("angle"),
                    "idea": _text(p.get("idea"), 900),
                    "idea_short": _first_sentence(_text(p.get("idea"), 900)),
                    "hypothesis": _text(hyp.get("statement"), 700),
                    "prediction": _text(hyp.get("prediction"), 500),
                    "selected": bool(rv.get("selected")) or sel.get("winner") == pid,
                    "winner": sel.get("winner") == pid,
                    "review": (cr.get("verdict") or ("approved" if rv.get("selected") else None)) if rv else None,
                    "rejection_reason": _text(cr.get("rejection_reason") or rv.get("rejection_reason"), 500) or None,
                    "failed_gates": failed_gates,
                    "note": _text(rv.get("selection_note"), 600) or None,
                })
            forge = []
            for dirname, rep in self.forge_reports(t).items():
                n = self.resolve(dirname) or self.resolve(rep.get("node_id")) or self.resolve(rep.get("node"))
                fit = _num(rep.get("fitness_value"))
                if fit is None:
                    fit = _num(rep.get("fitness"))
                if fit is None and n is not None:
                    fit = self.fitness(n)
                status = next((str(rep[k]) for k in ("status", "run_status", "run_state", "eval_status", "verdict") if rep.get(k) not in (None, "", {})), None)
                if status and status.startswith("{"):
                    status = None
                note = rep.get("note") or rep.get("reason") or rep.get("parent_comparison") or rep.get("telemetry_scan")
                if not note and isinstance(rep.get("report"), str):
                    note = _first_sentence(re.sub(r"#+[^\n]*\n", " ", rep["report"]), 260)
                forge.append({
                    "dir": dirname,
                    "node_id": n["id"] if n else None,
                    "name": (n or {}).get("name") or dirname,
                    "recipe": recipe_of.get(n["id"]) if n else None,
                    "fitness": fit,
                    "status": status,
                    "integrity_failed": self.integrity_failed(n) if n else False,
                    "note": _text(note, 400) or None,
                })
            # Nodes recorded this tick without a Forge report still count as built.
            seen = {f["node_id"] for f in forge}
            for n in self.nodes():
                if node_tick.get(n["id"]) == t and n["id"] not in seen:
                    forge.append({"dir": None, "node_id": n["id"], "name": n.get("name") or n["id"], "recipe": recipe_of.get(n["id"]),
                                  "fitness": self.fitness(n), "status": n.get("status"), "integrity_failed": self.integrity_failed(n), "note": None})
            probe_items = []
            for it in self._probe_items(t):
                targets = sorted({(self.resolve(r) or {}).get("name") or r for r in it["refs"] if self.resolve(r)})
                if not targets and it["hyps"]:
                    targets = sorted({str(n.get("name")) for n in self.nodes() if str(n.get("hypothesis_id")) in it["hyps"]})
                if it.get("audit") and not targets:
                    targets = [it["audit_target"]]
                probe_items.append({
                    "verdict": it["verdict"] or (str(it.get("raw")) if it.get("raw") else None),
                    "raw": it.get("raw"),
                    "targets": targets,
                    "evidence": it["evidence"],
                    "audit": bool(it.get("audit")),
                })
            pd = self.probe(t)
            sage = self.sage(t)
            findings = [f for f in sage.get("findings") or [] if isinstance(f, dict)]
            tick_recipes = [rid for rid, r in recipes.items() if r["tick"] == t]
            sc = scores.get(t) or {}
            in_progress = ts.get("tick") == t and not (ts.get("current_step") in (9, 10) and str(ts.get("step_status")).lower() == "done")
            entry = {
                "tick": t,
                "started_at": _iso(starts.get(t)),
                "in_progress": bool(in_progress and t == max(self.tick_numbers())),
                "score": _num(sc.get("score")),
                "outcome": sc.get("outcome"),
                "proposals": proposals,
                "forge": forge,
                "probe": probe_items,
                "probe_summary": _text(pd.get("verdict_summary") or pd.get("single_next_change") or pd.get("next_step_for_mutagen"), 700) or None,
                "sage": {"n": len(findings), "titles": [_text(f.get("title"), 200) for f in findings[:6]],
                         "gaps": _text(sage.get("gaps") or sage.get("unresolved_gaps") or sage.get("gap_note"), 300) or None},
                "lessons": [l for l in lessons if l.get("tick") == t],
                "gotchas": [g for g in gotchas if g.get("tick") == t],
                "signals": [
                    {"kind": s.get("kind"), "severity": s.get("severity"), "source": s.get("source"),
                     "summary": _signal_summary(s), "occurrences": s.get("occurrences")}
                    for s in signals if s.get("tick") == t or (s.get("tick") is None and self.tick_for_time(parse_ts(s.get("first_seen"))) == t)
                ],
                "decisions": [{"at": e["at"], "kind": e["kind"], "text": e["text"]} for e in dlog if e.get("tick") == t],
                "steers": [s["id"] for s in steers if s.get("picked_up_tick") == t],
                "recipes": tick_recipes,
            }
            entry["headline"] = self._tick_headline(entry, recipes)
            out.append(entry)
        return out

    def _tick_headline(self, e: dict[str, Any], recipes: dict[str, dict[str, Any]]) -> str:
        bits = []
        np_, ns = len(e["proposals"]), sum(1 for p in e["proposals"] if p["selected"])
        if np_:
            fams = sorted({p["family"] for p in e["proposals"] if p["selected"] and p["family"]})
            bits.append(f"{np_} idea{'s' if np_ != 1 else ''} proposed, {ns} selected" + (f" ({', '.join(fams)})" if fams else ""))
        built = [f for f in e["forge"] if f["node_id"]]
        if built:
            scored = [f for f in built if f["fitness"] is not None and not f["integrity_failed"]]
            if scored:
                top = max(scored, key=lambda f: f["fitness"])
                bits.append(f"{len(built)} node{'s' if len(built) != 1 else ''} built, best {top['name']} {_fmt(top['fitness'])}")
            else:
                bits.append(f"{len(built)} node{'s' if len(built) != 1 else ''} built, none scored cleanly")
        vs = [p["verdict"] for p in e["probe"] if p["verdict"] and not p["audit"]]
        arts = [p for p in e["probe"] if p["verdict"] == "artefact"]
        if vs:
            counts: dict[str, int] = {}
            for v in vs:
                counts[v] = counts.get(v, 0) + 1
            bits.append("Probe: " + ", ".join(f"{k}{' ×'+str(c) if c > 1 else ''}" for k, c in counts.items()))
        if arts:
            bits.append(f"{len(arts)} artefact call{'s' if len(arts) != 1 else ''}")
        if e["in_progress"]:
            bits.append("in progress")
        return " · ".join(bits) or "No artifacts yet"

    # ── evidence ──────────────────────────────────────────────────────────────

    def node_evidence(self, ref: str, max_points: int = 400) -> dict[str, Any] | None:
        n = self.resolve(ref)
        if n is None:
            return None
        res = self.result(n) or {}
        parent = self.parent_of(n)
        pres = (self.result(parent) or {}) if parent else {}
        pd = _dict(res.get("per_domain"))
        ppd = _dict(pres.get("per_domain"))
        fm = self.floor_metric(pd) if pd else "S"
        floor = self.floor_domain(pd, fm) if pd else None
        pfloor = self.floor_domain(ppd, fm) if ppd else None
        cols = [c for c in ("S", "fmeasure", "recall", "precision", "stroke_width_ratio") if any(isinstance(v, dict) and c in v for v in pd.values())]
        if not cols and pd:
            sample = next((v for v in pd.values() if isinstance(v, dict)), {})
            cols = [k for k, v in sample.items() if _num(v) is not None and k != "n"][:6]
        rows = []
        for d, v in pd.items():
            if not isinstance(v, dict):
                continue
            pv = ppd.get(d) if isinstance(ppd.get(d), dict) else {}
            rows.append({
                "domain": d,
                "values": {c: _num(v.get(c)) for c in cols},
                "parent": {c: _num(pv.get(c)) for c in cols} if pv else None,
                "n": v.get("n"),
                "is_floor": d == floor,
                "is_parent_floor": d == pfloor,
                "all": {k: _num(x) for k, x in v.items() if _num(x) is not None},
            })
        rows.sort(key=lambda r: (r["values"].get(fm) if r["values"].get(fm) is not None else math.inf))
        rid = self.recipe_of().get(n["id"])
        recipe = next((r for r in self.recipes() if r["id"] == rid), None)
        verdict = self.node_verdicts().get(n["id"]) or {}
        integ = self.integrity(n) or {}
        gaming = [g for g in self.gaming_checks() if g["node_id"] == n["id"]]
        metric_keys = [k for k in ("recall", "precision", "fmeasure", "stroke_width_ratio", "mean_domain_S", "min_domain_fmeasure") if k in _dict(res.get("metrics"))]
        return clean_json({
            "node": {k: n.get(k) for k in ("id", "name", "approach_family", "mutation_tier", "status", "integrity_status", "created_at", "hypothesis_id", "config", "eval_version")},
            "fitness": self.fitness(n),
            "metrics": _dict(res.get("metrics")),
            "headline_metrics": metric_keys,
            "parent": ({"id": parent["id"], "name": parent.get("name"), "fitness": self.fitness(parent), "metrics": _dict(pres.get("metrics"))} if parent else None),
            "floor_metric": fm,
            "floor_domain": floor,
            "parent_floor_domain": pfloor,
            "columns": cols,
            "per_domain": rows,
            "recipe": {k: recipe[k] for k in ("id", "label", "verdict", "median", "min", "max", "n_valid", "badges")} if recipe else None,
            "badges": next((m["badges"] for m in (recipe or {}).get("members", []) if m["id"] == n["id"]), []),
            "probe": verdict or None,
            "integrity": {"verdict": integ.get("verdict"), "failure_reason": integ.get("failure_reason"),
                          "failed_checks": [k for k, v in (integ.get("checks") or {}).items() if v is False and k in _PASS_IS_TRUE_CHECKS]} if integ else None,
            "makeup": self.node_makeup(n),
            "gaming": gaming,
            "telemetry": self.telemetry(n, max_points),
            "parent_telemetry": self.telemetry(parent, max_points // 2) if parent else None,
            "samples": self.samples(n),
            "tick": self.node_ticks().get(n["id"]),
        })

    def telemetry(self, node: dict[str, Any] | None, max_points: int = 400) -> dict[str, list[list[float]]]:
        if node is None:
            return {}
        recs: list[dict[str, Any]] = []
        for d in self._node_dirs(node):
            recs = _read_jsonl(d / "telemetry.jsonl")
            if recs:
                break
        series: dict[str, list[list[float]]] = {}
        for i, r in enumerate(recs):
            step = _num(r.get("step"))
            x = step if step is not None else float(i)
            for k in ("train_loss", "val_loss", "val_metric", "lr", "grad_norm"):
                v = _num(r.get(k))
                if v is not None:
                    series.setdefault(k, []).append([x, v])
        for k, pts in series.items():
            if len(pts) > max_points:
                stride = math.ceil(len(pts) / max_points)
                series[k] = pts[::stride] + ([pts[-1]] if (len(pts) - 1) % stride else [])
        return series

    def samples(self, node: dict[str, Any]) -> list[dict[str, Any]]:
        out = []
        for d in self._node_dirs(node):
            cands = [p for p in d.iterdir() if p.is_file() and p.suffix.lower() in _IMAGE_EXT]
            for sub in _SAMPLE_DIRS:
                sd = d / sub
                if sd.is_dir():
                    cands += [p for p in sorted(sd.iterdir()) if p.is_file() and p.suffix.lower() in _IMAGE_EXT]
            for p in cands[:12]:
                rel = p.relative_to(d).as_posix()
                try:
                    size = p.stat().st_size
                except OSError:
                    continue
                out.append({"name": rel, "bytes": size})
            if out:
                break
        return out

    def sample_path(self, ref: str, name: str) -> Path | None:
        n = self.resolve(ref)
        if n is None:
            return None
        allowed = {s["name"] for s in self.samples(n)}
        if name not in allowed:
            return None
        for d in self._node_dirs(n):
            p = (d / name).resolve()
            if p.is_file() and d.resolve() in p.parents:
                return p
        return None

    def sample_data_uri(self, ref: str, name: str, max_bytes: int = 600_000) -> str | None:
        p = self.sample_path(ref, name)
        if p is None or p.stat().st_size > max_bytes:
            return None
        mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}[p.suffix.lower()]
        return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()

    # ── steer ─────────────────────────────────────────────────────────────────

    def steer_notes(self) -> list[dict[str, Any]]:
        """Human steer notes: still queued in the inbox, or drained onto the bus."""
        def build():
            notes: dict[str, dict[str, Any]] = {}
            for s in self.signals():
                if s.get("kind") != STEER_KIND:
                    continue
                ev = s.get("evidence") if isinstance(s.get("evidence"), dict) else {}
                drained = parse_ts(s.get("first_seen"))
                created = parse_ts(ev.get("created_at")) or drained
                pick = self.tick_for_time(drained)
                notes[str(s.get("signature"))] = {
                    "id": str(s.get("signature")),
                    "note": ev.get("note") or ev.get("description") or "",
                    "author": ev.get("author"),
                    "axis": (s.get("axes") or [None])[0],
                    "created_at": _iso(created),
                    "status": "drained",
                    "drained_at": _iso(drained),
                    "picked_up_tick": pick,
                }
            for line in _read_jsonl(self.run_dir / INBOX_FILENAME):
                if line.get("kind") != STEER_KIND:
                    continue
                sig = str(line.get("signature"))
                if sig in notes:
                    continue
                ev = line.get("evidence") if isinstance(line.get("evidence"), dict) else {}
                notes[sig] = {
                    "id": sig, "note": ev.get("note") or "", "author": ev.get("author"),
                    "axis": (line.get("axes") or [None])[0],
                    "created_at": line.get("created_at"), "status": "queued",
                    "drained_at": None, "picked_up_tick": None,
                }
            return sorted(notes.values(), key=lambda n: n.get("created_at") or "", reverse=True)
        return self._m("steers", build)

    # ── figure: approved metrics + one point per evaluated node ──────────────

    def metric_specs(self) -> list[dict[str, Any]]:
        """Approved metrics from the contract, primary first."""
        gc = self.contract()
        specs = gc.get("metric_specs")
        if isinstance(specs, str):
            try:
                specs = json.loads(specs)
            except ValueError:
                specs = None
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for s in specs if isinstance(specs, list) else []:
            if not isinstance(s, dict) or not s.get("metric_name") or s["metric_name"] in seen:
                continue
            seen.add(s["metric_name"])
            out.append({"name": s["metric_name"], "direction": s.get("direction") or "higher",
                        "role": s.get("role") or "secondary", "primary": s.get("role") == "primary_fitness"})
        if not any(m["primary"] for m in out):
            pm = self.primary_metric()
            out.insert(0, {"name": pm["name"], "direction": pm["direction"], "role": "primary_fitness", "primary": True})
        out.sort(key=lambda m: not m["primary"])
        return out

    def points(self) -> list[dict[str, Any]]:
        """Every node as a figure point: tick, metric values, lineage, flags."""
        specs = self.metric_specs()
        primary = specs[0]["name"]
        recipe_of = self.recipe_of()
        recipes = {r["id"]: r for r in self.recipes()}
        node_tick = self.node_ticks()
        pidx = self.proposal_index()
        out = []
        for n in self.nodes():
            res = self.result(n)
            metrics = dict(_dict(n.get("metrics")))
            metrics.update(_dict((res or {}).get("metrics")))
            values: dict[str, float | None] = {}
            for m in specs:
                v = self.fitness(n) if m["name"] == primary else _num(metrics.get(m["name"]))
                if m["name"] == primary and v is None:
                    v = _num(metrics.get(primary))
                values[m["name"]] = v
            if all(v is None for v in values.values()):
                continue
            parents = []
            for ref in n.get("parent_ids") or []:
                p = self.resolve(ref)
                parents.append({"id": p["id"] if p else None, "name": (p or {}).get("name") or str(ref)})
            rid = recipe_of.get(n["id"])
            rec = recipes.get(rid) or {}
            mem = next((m for m in rec.get("members", []) if m["id"] == n["id"]), {})
            prop = pidx.get(str(n.get("hypothesis_id") or "")) or {}
            out.append({
                "id": n["id"],
                "name": n.get("name") or n["id"],
                "tick": node_tick.get(n["id"]),
                "values": values,
                "parents": parents,
                "crossover": bool(n.get("is_crossover")) or len(parents) > 1,
                "recipe": rid,
                "recipe_label": rec.get("label"),
                "seed": mem.get("seed"),
                "family": n.get("approach_family"),
                "idea": _first_sentence(_text(prop.get("idea"), 600), 200) or None,
                "integrity_failed": self.integrity_failed(n),
                "artefact": bool(mem.get("artefact")),
                "suspect": bool(rec.get("suspect")),
                "verdict": rec.get("verdict"),
                "badges": mem.get("badges", []),
            })
        return out

    # ── node: what it is made from ────────────────────────────────────────────

    def node_makeup(self, n: dict[str, Any]) -> dict[str, Any]:
        """Idea, parent diff, genome, Selector review and Forge report for a node."""
        hyp_id = str(n.get("hypothesis_id") or "")
        prop = self.proposal_index().get(hyp_id) or {}
        hyp = prop.get("hypothesis") if isinstance(prop.get("hypothesis"), dict) else {}
        tick = prop.get("_tick")
        review = None
        if tick is not None:
            for r in self.selector(tick).get("reviews") or []:
                if isinstance(r, dict) and str(r.get("proposal_id")) == str(prop.get("proposal_id")):
                    cr = r.get("critic_review") if isinstance(r.get("critic_review"), dict) else {}
                    review = {
                        "selected": bool(r.get("selected")),
                        "verdict": cr.get("verdict"),
                        "gates": {k: v for k, v in cr.items() if k not in ("verdict", "rejection_reason") and v is not None},
                        "rejection_reason": cr.get("rejection_reason"),
                        "note": _text(r.get("selection_note"), 900) or None,
                    }
        forge = None
        for t in self.tick_numbers():
            for dirname, rep in self.forge_reports(t).items():
                if self.resolve(dirname) is n or self.resolve(rep.get("node_id")) is n:
                    forge = {"tick": t, "fields": {k: (_text(v, 1200) if not isinstance(v, (int, float, bool)) else v)
                                                   for k, v in rep.items() if k not in ("node_id",)}}
        parent = self.parent_of(n)
        changes = []
        pcfg = _dict((parent or {}).get("config"))
        for k, v in _dict(n.get("config")).items():
            if pcfg.get(k) != v:
                changes.append({"key": k, "parent": pcfg.get(k), "node": v})
        return {
            "idea": _text(prop.get("idea"), 1500) or None,
            "hypothesis": _text(hyp.get("statement"), 1000) or None,
            "prediction": _text(hyp.get("prediction"), 800) or None,
            "proposal_id": prop.get("proposal_id"),
            "proposal_tick": tick,
            "angle": prop.get("angle"),
            "technique_tags": prop.get("technique_tags") or [],
            "parents": [{"id": (self.resolve(r) or {}).get("id"), "name": (self.resolve(r) or {}).get("name") or str(r)} for r in n.get("parent_ids") or []],
            "mutation_tier": n.get("mutation_tier"),
            "mutation_locus": n.get("mutation_locus"),
            "family": n.get("approach_family"),
            "data_version": n.get("data_version_ref"),
            "config": _dict(n.get("config")),
            "config_changes": changes,
            "genome": self.genome_text(n),
            "selector": review,
            "forge": forge,
        }

    def genome_text(self, n: dict[str, Any], limit: int = 20_000) -> str | None:
        """The node's genome: a content-addressed blob in the run store, or a
        genome file under the evor root. Read-only; nothing outside the root."""
        ref = str(n.get("genome_ref") or "")
        if not ref:
            return None
        cands = []
        if re.fullmatch(r"[0-9a-f]{64}", ref):
            cands.append(self.run_dir / "artifacts" / ref[:2] / ref[2:])
        else:
            p = Path(ref)
            if not p.is_absolute():
                p = self.run_dir / p
            cands.append(p)
        root = self.evor_root.resolve()
        for p in cands:
            try:
                rp = p.resolve()
                if root not in rp.parents or not rp.is_file():
                    continue
                return rp.read_text(errors="replace")[:limit]
            except OSError:
                continue
        return None

    # ── learnings ─────────────────────────────────────────────────────────────

    def learnings(self) -> dict[str, Any]:
        """What the run has learned, grouped for a researcher deciding to steer."""
        lessons = self.lessons()
        recipes = self.recipes()

        def lref(l: dict[str, Any]) -> dict[str, Any]:
            n = self.resolve(l.get("node")) if l.get("node") else None
            return {"lesson_id": l["lesson_id"], "tick": l.get("tick"), "node_id": n["id"] if n else None,
                    "node": l.get("node"), "verdict": l.get("verdict"), "observation": l.get("observation"),
                    "lesson": l.get("lesson"), "tags": l.get("tags"), "family": l.get("family")}

        worked = [lref(l) for l in lessons if normalize_verdict(l.get("verdict")) == "confirmed" and not l["artefact"]]
        failed = [lref(l) for l in lessons if normalize_verdict(l.get("verdict")) == "refuted" and not l["artefact"]]
        unclear = [lref(l) for l in lessons if normalize_verdict(l.get("verdict")) not in ("confirmed", "refuted") and not l["artefact"]]
        artefacts = [lref(l) for l in lessons if l["artefact"]]

        def rsum(r: dict[str, Any]) -> dict[str, Any]:
            return {"recipe": r["id"], "label": r["label"], "tick": r["tick"], "median": r["median"], "n": r["n_valid"],
                    "verdict": r["verdict"], "evidence": r["verdict_evidence"], "source": r["verdict_source"]}

        suspicious = []
        for g in self.gaming_checks():
            suspicious.append({"kind": "metric-gaming", "node_id": g["node_id"], "name": g["name"], "tick": self.node_ticks().get(g["node_id"]),
                               "text": f"Fitness {_fmt(g['parent_fitness'])}→{_fmt(g['fitness'])} vs {g['parent_name']}, but on {g['domain']} "
                                       + ", ".join(f"{d['metric']} fell {_fmt(d['parent'])}→{_fmt(d['node'])}" for d in g["drops"])})
        for r in recipes:
            for m in r["members"]:
                if "lucky-seed" in m["badges"]:
                    suspicious.append({"kind": "lucky-seed", "node_id": m["id"], "name": m["name"], "tick": m["tick"],
                                       "text": f"{_fmt(m['fitness'])} against a recipe median of {_fmt(r['median'])} over {r['n_valid']} seeds"})
                if m["artefact"]:
                    ev = (self.node_verdicts().get(m["id"]) or {}).get("evidence")
                    suspicious.append({"kind": "artefact", "node_id": m["id"], "name": m["name"], "tick": m["tick"],
                                       "text": (f"Tagged as an artefact: {ev}" if ev else "Tagged as an artefact by a wiki lesson") + " — excluded from the robust median."})
            if r["suspect"] and r["verdict"] != "artefact":
                suspicious.append({"kind": "artefact-suspect", "node_id": None, "name": r["label"], "recipe": r["id"], "tick": r["tick"],
                                   "text": f"Recipe still counts but is suspect: {r['suspect_evidence']}" if r["suspect_evidence"] else "Recipe still counts but is suspect."})
        decisions = [{"at": e["at"], "tick": e.get("tick"), "kind": e["kind"], "text": e["text"]}
                     for e in self.decision_log() if e["kind"] != "record"][-12:]
        records = [e for e in self.decision_log() if e["kind"] == "record"]
        decisions += [{"at": e["at"], "tick": e.get("tick"), "kind": e["kind"], "text": e["text"]} for e in records[-6:]]
        decisions.sort(key=lambda d: d["at"], reverse=True)
        return {
            "worked": worked,
            "failed": failed,
            "unclear": unclear,
            "artefacts": artefacts,
            "recipes_confirmed": [rsum(r) for r in recipes if r["verdict"] == "confirmed"],
            "recipes_refuted": [rsum(r) for r in recipes if r["verdict"] == "refuted"],
            "recipes_artefact": [rsum(r) for r in recipes if r["verdict"] == "artefact"],
            "recipes_suspect": [rsum(r) for r in recipes if r["suspect"] and r["verdict"] != "artefact"],
            "suspicious": suspicious,
            "gotchas": self.gotchas(),
            "decisions": decisions,
        }

    # ── bundle ────────────────────────────────────────────────────────────────

    def bundle(self) -> dict[str, Any]:
        gc = self.contract()
        return clean_json({
            "generated_at": _iso(self.now),
            "mission_id": gc.get("mission_id") or self.run_dir.parent.name,
            "run_id": self.run_dir.name,
            "task": _text(gc.get("task_description"), 1200),
            "metrics": self.metric_specs(),
            "points": self.points(),
            "learnings": self.learnings(),
            "overview": self.overview(),
            "progress": self.progress(),
            "alerts": self.alerts(),
            "recipes": self.recipes(),
            "timeline": self.timeline(),
            "steers": self.steer_notes(),
            "strategy": {k: self.strategy().get(k) for k in ("selection_policy", "wildness", "family_mix", "wins_by_family", "meta_iteration") if k in self.strategy()},
        })


# ── steer writer ──────────────────────────────────────────────────────────────


def build_steer_line(note: str, author: str, axis: str = "accuracy", now: datetime | None = None) -> dict[str, Any]:
    """One inbox line in the format the signal hooks write and drain_inbox reads."""
    created = _iso(now or datetime.now(timezone.utc))
    digest = hashlib.sha256(f"{author}\n{created}\n{note}".encode()).hexdigest()[:16]
    return {
        "kind": STEER_KIND,
        "signature": f"{STEER_KIND}:{digest}",
        "shapes": ["opportunity"],
        "axes": [axis],
        "severity": "high",
        "evidence": {"note": note, "author": author, "created_at": created, "description": f"Human steer from {author}: {note}"},
        "source": STEER_SOURCE,
        "created_at": created,
    }


def append_steer(run_dir: Path, note: str, author: str, axis: str = "accuracy") -> dict[str, Any]:
    """Append one human-steer line to ``<run_dir>/signals-inbox.jsonl``.

    This is the only write the dashboard performs. ``O_APPEND`` with a single
    ``write`` keeps the line whole when a hook appends at the same moment.
    """
    note = (note or "").strip()
    author = (author or "").strip() or "anonymous"
    if not note:
        raise ValueError("note is empty")
    if len(note) > 4000:
        raise ValueError("note is longer than 4000 characters")
    if len(author) > 80:
        raise ValueError("author is longer than 80 characters")
    if axis not in SIGNAL_AXES:
        raise ValueError(f"axis must be one of {', '.join(SIGNAL_AXES)}")
    run_dir = Path(run_dir)
    if not (run_dir / "tree.json").exists() and not (run_dir / "run-state.json").exists():
        raise ValueError("not a run directory")
    line = build_steer_line(note, author, axis)
    data = (json.dumps(line, ensure_ascii=False) + "\n").encode()
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(run_dir / INBOX_FILENAME, flags, 0o644)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    return line


# ── formatting ────────────────────────────────────────────────────────────────


def _fmt(v: Any) -> str:
    x = _num(v)
    if x is None:
        return "—"
    if x == 0:
        return "0"
    a = abs(x)
    if a >= 100:
        return f"{x:.1f}"
    if a >= 1:
        return f"{x:.3g}"
    if a >= 1e-3:
        return f"{x:.4f}".rstrip("0").rstrip(".")
    return f"{x:.2e}"


def _seed_label(n: dict[str, Any]) -> str | None:
    seed = _dict(n.get("config")).get("seed")
    if seed is None or seed == "":
        seed = seed_and_stem(str(n.get("name") or ""))[1]
    return None if seed is None else str(seed)


def _spread_txt(r: dict[str, Any]) -> str:
    return "∞× (a seed scored 0)" if r["spread_unbounded"] else f"{r['spread']:.0f}×"


def _dur(minutes: float) -> str:
    if minutes < 90:
        return f"{minutes:.0f} min"
    return f"{minutes / 60:.1f} h"


def _signal_summary(s: dict[str, Any]) -> str:
    ev = s.get("evidence") if isinstance(s.get("evidence"), dict) else {}
    for k in ("note", "description", "finding", "meaning", "verdict", "summary", "note_text", "defect", "asked_for", "query"):
        if ev.get(k):
            return _text(ev[k], 260)
    return _text(ev, 260)


def iter_export_evidence(ins: RunInsights) -> Iterable[tuple[str, dict[str, Any]]]:
    for n in ins.nodes():
        ev = ins.node_evidence(n["id"], max_points=300)
        if ev is not None:
            yield n["id"], ev
