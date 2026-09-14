# hooks/ is copied in at sandbox-build time

`hooks/` under this fixture is intentionally empty in the repository. The runner
copies the live `hooks/` tree from the repo root into it when it materialises the
sandbox, exactly as `ci/guard-probe.mjs::buildSandbox` does, and appends a
sentinel line to `hooks/stop.mjs` so any rewrite of the enforcing hook is visible
in that file's sha256.

Committing a frozen copy of `hooks/` here would measure a stale governor. The
scenario asserts on the sha256 recorded at sandbox build, not on a value stored
in this repository.


## Overlay directories are created by the runner

`setup.overlay` writes files at paths that may not exist in either fixture tree
(`.evor/runs/m1/r1/splits/frozen_index.json`,
`.evor/runs/m1/r1/ticks/1/mutagen/proposals.json`, `train/probe_width.py`, …).
The runner must `mkdir -p` each parent before writing. Empty placeholder
directories are deliberately NOT committed: a seeded-but-empty `splits/` would
change what `T4-refreeze-ask-gate`'s negative half means, since that pair's whole
delta is whether the anchor exists.
