"""StrategyState has two owners: the MCP writer (zod) and the Python reader (pydantic,
extra fields forbidden). A field the writer accepts and the reader lacks makes every tree
load fail the first time an agent sets it. This test keeps the two field sets in step."""
import re
from pathlib import Path

from evor.contracts import StrategyState

ROOT = Path(__file__).resolve().parents[2]
# Fields the reader stamps itself; the writer never sends them.
READER_ONLY = {"updated_at"}


def _zod_fields() -> set[str]:
    src = (ROOT / "mcp" / "src" / "contracts.ts").read_text()
    start = src.index("export const StrategyStateSchema = z.object({")
    end = src.index("});", start)
    return set(re.findall(r"^\s{2}(\w+):\s*z\.", src[start:end], re.M))


def test_every_writer_field_is_readable():
    assert _zod_fields() - set(StrategyState.model_fields) == set()


def test_reader_has_no_unexplained_fields():
    assert set(StrategyState.model_fields) - _zod_fields() <= READER_ONLY


def test_dream_k_loads():
    s = StrategyState.model_validate({
        "meta_iteration": 0, "selection_policy": "ucb1", "ucb1_c": 1.41, "wildness": 0.5,
        "family_mix": {}, "winning_families": [], "wins_by_family": {}, "meta_loop_interval": 5,
        "post_upgrade_exploration_ticks": 0, "rescore_mode": "sync", "updated_at": "x", "dream_k": 6,
    })
    assert s.dream_k == 6
