"""Where run state may not live — plan item 1.3 / finding P-02, Python half.

The field run wrote `active-run.json` and a whole
`runs/frontier-1ms/run-live-01/` tree into BOTH the plugin cache and the
marketplace clone. A run recorded there is destroyed by the next
`claude plugin update`, and it leaks into every future project that installs the
plugin — which is how the decoy `.evor/` that Q-01's hooks read for 19 hours came
to exist in the first place.

Three sides had to be closed, because each could recreate what the others avoid:
the hooks stopped RESOLVING there (`hooks/lib/active-run.mjs`), the MCP server
stopped WRITING there (`mcp/src/tools/state.ts`), and this is the harness.

Recognition is STRUCTURAL — the `.../plugins/{cache,marketplaces}/...` path
shape, wherever it is rooted. Keying on the home directory would miss a plugin
tree anywhere else, and the shape is what makes it a plugin tree.
"""

from __future__ import annotations

from pathlib import Path


class PluginRootWriteRefused(RuntimeError):
    """A writer was asked to put run state inside an installed plugin tree."""


def assert_outside_plugin_root(path: Path | str, what: str = "run state") -> None:
    """Raise :class:`PluginRootWriteRefused` if ``path`` is inside a plugin install."""
    resolved = Path(path).resolve()
    parts = resolved.parts

    for i, part in enumerate(parts):
        if part != "plugins":
            continue
        if i + 1 < len(parts) and parts[i + 1] in ("cache", "marketplaces"):
            root = Path(*parts[: i + 2])
            raise PluginRootWriteRefused(
                f"refusing to write {what} inside the installed plugin at {root}. "
                f"A run recorded there is destroyed by the next plugin update and leaks "
                f"into every project that installs the plugin. Point EVOR_ROOT at a "
                f"directory in the PROJECT instead."
            )


def is_inside_plugin_root(path: Path | str) -> bool:
    """Non-raising form, for callers that report by return value."""
    try:
        assert_outside_plugin_root(path)
    except PluginRootWriteRefused:
        return True
    return False
