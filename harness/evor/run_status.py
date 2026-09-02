"""The one place that says what a run's liveness means — Python half of 1.3a.

``run-state.status`` has readers in three languages and writers in two. Three
consecutive plan revisions enumerated those readers and three times the list came
back incomplete under a new grep shape: an accessor-routed reader in
``dashboard/server.py`` invisible to a path-literal grep, then two Python sites,
then two prose readers in ``skills/``. Each grep was correct for the shape it
assumed. An enumeration maintained by diligence is an invariant with no writer.

Routing every read through a named function makes the retirement at 1.9b an
import error rather than a grep — the only form of that fix whose correctness
does not depend on the enumeration being right.

1.3a is a PURE REFACTOR. The default that ``read_run_status`` returns for an
absent field is deliberately unchanged here; changing it is 1.4.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

#: Fields a well-formed run-state must carry. ``status`` is listed separately
#: from the rest because it is the one being retired; keeping it in a named
#: constant means ``validate.py`` stops hard-coding the tuple and 1.9b edits one
#: place instead of hunting for the literal.
REQUIRED_RUN_STATE_FIELDS: tuple[str, ...] = ("tick_count", "frontier_ids")
#: ``status`` was here until 1.9b. AF3 §4.1: a new FSM must REPLACE a field,
#: never accompany it — ``run-state.status`` duplicated the mission's and "was
#: wrong in all three field runs", so mission state is now the single lifecycle
#: state. Requiring the retired key would have failed every migrated tree at
#: exactly the moment 1.10 rewrote them.


def read_run_status(run_state: Optional[Mapping[str, Any]]) -> Optional[str]:
    """Return the run's declared lifecycle status, or ``None`` if it declares none."""
    if not run_state:
        return None
    raw = run_state.get("status")
    return None if raw is None else str(raw)


def is_run_live(run_state: Optional[Mapping[str, Any]]) -> bool:
    """Is this run live — may a check still hold on its behalf?

    Named rather than inlined because absence and liveness are different
    questions, and the whole A6 failure is a reader that answered the second by
    guessing at the first.
    """
    return read_run_status(run_state) == "running"
