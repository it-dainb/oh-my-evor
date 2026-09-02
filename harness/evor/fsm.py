"""Reader over ``contracts/state-machines.json`` — plan item 3.1, Python half.

The table is the authority; this is one of three small readers over it (see also
``mcp/src/fsm.ts`` and ``hooks/lib/fsm.mjs``). AF3 §4.3, following RC3: an FSM
implemented in one language is invisible to the others, and ``stop.mjs`` — the
component whose wrong predicate caused C-02 — is in a third. Implementing the
machine in Python and letting the rest re-derive it would be the ``.tree.lock``
mistake verbatim.

Deliberately NOT ``python-statemachine``: class syntax that ``stop.mjs`` and
``state.ts`` cannot read structurally recreates RC3.

Enforcement is the MCP write path only. This module answers questions; it does
not police anyone. AF3 risk 2: a guard evaluated in a hook is a suggestion,
because the hook must fail open.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

TABLE_PATH = Path(__file__).resolve().parents[2] / "contracts" / "state-machines.json"


class IllegalTransition(ValueError):
    """An edge the table does not contain."""


@lru_cache(maxsize=1)
def load_table(path: str | None = None) -> dict[str, Any]:
    return json.loads(Path(path or TABLE_PATH).read_text())


def _machine(entity: str) -> dict[str, Any]:
    machines = load_table()["machines"]
    if entity not in machines:
        raise KeyError(f"no state machine for {entity!r}; known: {sorted(machines)}")
    return machines[entity]


def initial_state(entity: str) -> str:
    return _machine(entity)["initial"]


def is_terminal(entity: str, state: str) -> bool:
    return state in _machine(entity)["terminal"]


def legal_events(entity: str, state: str) -> list[str]:
    return sorted(_machine(entity)["states"].get(state, {}).get("on", {}))


def next_state(entity: str, state: str, event: str) -> Optional[str]:
    """The state ``event`` leads to from ``state``, or None if illegal."""
    edge = _machine(entity)["states"].get(state, {}).get("on", {}).get(event)
    return edge["to"] if edge else None


def guard_for(entity: str, state: str, event: str) -> Optional[str]:
    """Name of the guard this edge requires, if any. Evaluating it is the caller's job."""
    edge = _machine(entity)["states"].get(state, {}).get("on", {}).get(event)
    return (edge or {}).get("guard")


def assert_transition(entity: str, state: str, event: str) -> str:
    """Return the destination state, or raise :class:`IllegalTransition`.

    The error names what WAS legal, because the failure this replaces was silent:
    a writer set a field to whatever it liked and no reader could tell whether
    the value was reachable.
    """
    to = next_state(entity, state, event)
    if to is None:
        raise IllegalTransition(
            f"{entity}: {state!r} --{event}--> is not a legal transition. "
            f"Legal from {state!r}: {legal_events(entity, state) or '(terminal)'}"
        )
    return to


def max_dwell_s(entity: str, state: str) -> Optional[float]:
    return _machine(entity)["states"].get(state, {}).get("max_dwell_s")


def is_stale(entity: str, state: str, entered_at: str | None, now: datetime | None = None) -> bool:
    """Has this entity sat in ``state`` past its ``max_dwell_s``? (Item 3.3.)

    The predicate the system never had. C-01, K-09 and C-03 were unobservable
    because "is this still alive?" required an event nobody emitted; here it is
    arithmetic over two fields, computable by any reader in any language from the
    file alone.

    Absent ``entered_at`` is NOT stale: an unknown age is not evidence of death,
    and reading it as one would be A6's mistake with the sign flipped.
    """
    limit = max_dwell_s(entity, state)
    if limit is None or not entered_at:
        return False
    try:
        started = datetime.fromisoformat(str(entered_at).replace("Z", "+00:00"))
    except ValueError:
        return False
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return ((now or datetime.now(timezone.utc)) - started).total_seconds() > limit


def append_transition(run_dir: Path | str, record: dict[str, Any]) -> None:
    """Append to ``<run_dir>/transitions.jsonl`` — the audit half of 3.1.

    Append-only, and every entry carries a CONTEMPORANEOUS reason. K-08's
    supersession reason had to be reconstructed afterwards by a human editing
    JSON in vim, because nothing recorded why a transition happened at the moment
    it happened.
    """
    path = Path(run_dir) / "transitions.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {"at": datetime.now(timezone.utc).isoformat(), **record}
    with open(path, "a") as fh:
        fh.write(json.dumps(entry) + "\n")
