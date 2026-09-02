"""
ForgeStructureGate + ProbeEDAGate — deterministic code-quality checks (CPU-only).

ForgeStructureGate.check(candidate_dir) -> QualityReport
  ARCHITECTURE-AGNOSTIC validation of a Forge-materialized candidate worktree.

  UNIVERSAL sub-checks (all model families):
    1. genome_yaml   — genome.yaml present, parses, required GenomeConfig fields present
    2. model_seams   — model/ has build_model()/build() + family-specific seam files
                       (seam files skipped when model_family absent or "other")
    3. train_ops     — train/ has torch.optim + loss + any DataLoader (AST scan, no import)
    4. forward_pass  — forward/encode pass on representative dummy tensor(s) succeeds
                       (subprocess; tries spatial/text/flat inputs until one works)
    5. eval_locked   — evaluate.py sha256 matches locked reference hash (if provided)
    6. telemetry     — EVOR_TELEMETRY_PATH + open() write in train/ or candidate root

  FAMILY-PLUGGABLE seam registry (genome.yaml ``model_family``):
    cnn:       backbone.py + head.py required; neck.py optional
    embedding: encoder.py + pooling.py required
    graph:     message_passing.py + readout.py required
    vlm:       vision_encoder.py + connector.py + decoder.py required
    other / absent: no seam file requirement (universal invariants only)

  DataLoader detection covers torch.utils.data, torch_geometric, dgl, and datasets.
  Loss detection covers nn.*Loss, contrastive/triplet names, criterion/loss_fn variables.
  Forward-pass tries 5 input shapes (spatial float, text LongTensor, flat float).

ProbeEDAGate.check(node_eda_dir) -> QualityReport
  Validates a Probe-generated EDA directory (nodes/<id>/eda/).
  Sub-checks:
    1. analysis_script_exists  — analysis_*.py present in node_eda_dir
    2. evor_eda_import         — at least one script imports from evor.eda
    3. runtime_telemetry_ref   — domain_id/node_id reference is dynamic, not hardcoded
    4. resource_guard          — safe_exec / resource.setrlimit / timeout guard present
    5. finding_artifact        — >= 1 non-.py file present (finding output)
"""

from __future__ import annotations

import ast
import hashlib
import subprocess
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path


# ─────────────────────────────────────────────────────────────────────────────
# Result types
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class SubCheck:
    """Single sub-check result."""

    name: str
    passed: bool
    reason: str


@dataclass
class QualityReport:
    """Aggregate result of all sub-checks for one candidate or EDA directory."""

    candidate_dir: Path
    checks: list[SubCheck] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return bool(self.checks) and all(c.passed for c in self.checks)

    @property
    def failure_reasons(self) -> list[str]:
        return [f"{c.name}: {c.reason}" for c in self.checks if not c.passed]

    def check_by_name(self, name: str) -> SubCheck | None:
        for c in self.checks:
            if c.name == name:
                return c
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Family spec registry
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class _FamilySpec:
    required_seams: list[str]
    description: str


_FAMILY_SPECS: dict[str, _FamilySpec] = {
    "cnn": _FamilySpec(
        required_seams=["backbone.py", "head.py"],
        description="CNN: backbone.py + head.py required; neck.py optional",
    ),
    "embedding": _FamilySpec(
        required_seams=["encoder.py", "pooling.py"],
        description="Embedding/retrieval: encoder.py + pooling.py required",
    ),
    "graph": _FamilySpec(
        required_seams=["message_passing.py", "readout.py"],
        description="Graph NN: message_passing.py + readout.py required",
    ),
    "vlm": _FamilySpec(
        required_seams=["vision_encoder.py", "connector.py", "decoder.py"],
        description="VLM: vision_encoder.py + connector.py + decoder.py required",
    ),
}


# ─────────────────────────────────────────────────────────────────────────────
# ForgeStructureGate
# ─────────────────────────────────────────────────────────────────────────────


class ForgeStructureGate:
    """Validate modular genome seam structure of a candidate worktree.

    Architecture-agnostic: universal invariants apply to all model families.
    Family-specific seam files are checked based on genome.yaml ``model_family``
    via the ``_FAMILY_SPECS`` registry.  Unknown or absent ``model_family``
    (including ``"other"``) skips family-seam validation — only universal
    invariants are enforced.

    Instantiate with an optional ``locked_eval_hash`` (sha256 hex of the
    reference evaluate.py).  Pass ``None`` to skip the eval_locked sub-check.

    Usage::

        gate = ForgeStructureGate(locked_eval_hash="abc123...")
        report = gate.check(Path(".evor/worktrees/node-001"))
        if not report.passed:
            print(report.failure_reasons)
    """

    def __init__(self, locked_eval_hash: str | None = None) -> None:
        self._locked_eval_hash = locked_eval_hash

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def check(self, candidate_dir: Path) -> QualityReport:
        """Run all 6 sub-checks; return QualityReport."""
        checks: list[SubCheck] = [
            self._check_genome_yaml(candidate_dir),
            self._check_model_seams(candidate_dir),
            self._check_train_ops(candidate_dir),
            self._check_forward_pass(candidate_dir),
            self._check_eval_locked(candidate_dir),
            self._check_telemetry(candidate_dir),
            self._check_path_anchoring(candidate_dir),
        ]
        return QualityReport(candidate_dir=candidate_dir, checks=checks)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _check_path_anchoring(self, candidate_dir: Path) -> SubCheck:
        """Candidate imports must anchor to ``__file__``, never to the cwd (R-15).

        `sys.path.insert(0, os.getcwd())` in a candidate trainer resolved against
        whatever directory the launcher happened to be in and raised
        `ModuleNotFoundError: 'model'`. The code was correct; the assumption
        about where it would run was not, and nothing checked that assumption
        until launch — after the merge, after the review, at the point where the
        run simply dies.

        `__file__` is a property of the module. The cwd is a property of whoever
        started the process, and a candidate does not get to choose that.
        """
        offenders: list[str] = []
        checked = 0
        for py in sorted(candidate_dir.rglob("*.py")):
            try:
                source = py.read_text(errors="replace")
            except OSError:
                continue
            checked += 1
            for lineno, line in enumerate(source.splitlines(), 1):
                stripped = line.strip()
                if not stripped.startswith(("sys.path.insert", "sys.path.append")):
                    continue
                # `os.getcwd()`, `Path.cwd()`, `"."` and `os.curdir` all resolve
                # against the launcher rather than the file.
                if any(marker in stripped for marker in ("getcwd()", "Path.cwd()", "os.curdir")) or \
                        stripped.endswith(('"."\')', "'.')", '".")')):
                    offenders.append(f"{py.relative_to(candidate_dir)}:{lineno}: {stripped}")

        if not checked:
            return SubCheck(
                name="path_anchoring",
                passed=True,
                reason="no Python sources to check",
            )
        if offenders:
            return SubCheck(
                name="path_anchoring",
                passed=False,
                reason=(
                    "sys.path is anchored to the process cwd, which the candidate does "
                    "not control — imports will resolve against whatever directory the "
                    "launcher happened to be in, and fail at launch rather than here. "
                    "Anchor to __file__ instead, e.g. "
                    "sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))). "
                    + "; ".join(offenders[:3])
                ),
            )
        return SubCheck(
            name="path_anchoring",
            passed=True,
            reason=f"{checked} source file(s) anchor imports to __file__ or do not touch sys.path",
        )

    def _read_genome_data(self, candidate_dir: Path) -> dict | None:
        """Parse genome.yaml and return the raw dict, or None on any failure."""
        genome_path = candidate_dir / "genome.yaml"
        if not genome_path.exists():
            return None
        try:
            import yaml  # pyyaml

            with open(genome_path) as fh:
                data = yaml.safe_load(fh)
        except ImportError:
            import json

            try:
                with open(genome_path) as fh:
                    data = json.load(fh)
            except Exception:
                return None
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    # ------------------------------------------------------------------
    # Sub-checks
    # ------------------------------------------------------------------

    def _check_genome_yaml(self, candidate_dir: Path) -> SubCheck:
        genome_path = candidate_dir / "genome.yaml"
        if not genome_path.exists():
            return SubCheck("genome_yaml", False, "genome.yaml not found")

        try:
            import yaml

            with open(genome_path) as fh:
                data = yaml.safe_load(fh)
        except ImportError:
            import json

            try:
                with open(genome_path) as fh:
                    data = json.load(fh)
            except Exception as exc:
                return SubCheck("genome_yaml", False, f"genome.yaml parse error (no yaml): {exc}")
        except Exception as exc:
            return SubCheck("genome_yaml", False, f"genome.yaml parse error: {exc}")

        if not isinstance(data, dict):
            return SubCheck("genome_yaml", False, "genome.yaml is not a YAML mapping")

        required = {
            "genome_version",
            "optimizer",
            "lr",
            "lr_schedule",
            "batch_size",
            "epochs",
            "loss",
        }
        missing = sorted(required - data.keys())
        if missing:
            return SubCheck(
                "genome_yaml", False, f"Missing required GenomeConfig fields: {missing}"
            )

        return SubCheck("genome_yaml", True, "genome.yaml present and all required fields present")

    def _check_model_seams(self, candidate_dir: Path) -> SubCheck:
        """Check model/ has build_model()/build() plus family-specific seam files.

        Reads ``model_family`` from genome.yaml and consults ``_FAMILY_SPECS``.
        If model_family is absent or ``"other"``, only the universal invariant
        (build_model/build present) is enforced — any architecture passes.
        """
        model_dir = candidate_dir / "model"
        if not model_dir.is_dir():
            return SubCheck("model_seams", False, "model/ directory not found")

        py_files = list(model_dir.glob("*.py"))
        if not py_files:
            return SubCheck("model_seams", False, "No .py files in model/")

        # Universal invariant: build_model() or build() must exist
        build_found = False
        for py_file in py_files:
            try:
                tree = ast.parse(py_file.read_text())
                for node in ast.walk(tree):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        if node.name in ("build_model", "build"):
                            build_found = True
            except SyntaxError:
                pass

        if not build_found:
            return SubCheck(
                "model_seams",
                False,
                "build_model()/build() not found in any .py file in model/",
            )

        # Family-pluggable seam check
        gdata = self._read_genome_data(candidate_dir)
        model_family: str | None = gdata.get("model_family") if gdata else None

        if not model_family or model_family == "other":
            return SubCheck(
                "model_seams",
                True,
                "model/ has build_model()/build() — no family-specific seams required "
                "(model_family absent or 'other')",
            )

        spec = _FAMILY_SPECS.get(model_family)
        if spec is None:
            return SubCheck(
                "model_seams",
                True,
                f"model/ has build_model()/build(); unknown family '{model_family}' "
                "— family seams not enforced",
            )

        present_names = {f.name for f in py_files}
        missing_seams = sorted(set(spec.required_seams) - present_names)
        if missing_seams:
            return SubCheck(
                "model_seams",
                False,
                f"Required seam files for family '{model_family}' missing: "
                f"{missing_seams} — {spec.description}",
            )

        found = [s for s in spec.required_seams if s in present_names]
        return SubCheck(
            "model_seams",
            True,
            f"model/ has build_model()/build() + {found} ({model_family} family)",
        )

    def _check_train_ops(self, candidate_dir: Path) -> SubCheck:
        """AST-scan train/ for torch.optim, a loss, and any DataLoader.

        No torch import required in the gate itself — pure AST analysis.

        DataLoader detection:
          - torch.utils.data.DataLoader / Dataset / TensorDataset
          - torch_geometric.data.DataLoader (PyG)
          - dgl.dataloading.DataLoader (DGL)
          - datasets / load_dataset (HuggingFace)

        Loss detection:
          - nn.*Loss attribute names (CrossEntropyLoss, CosineEmbeddingLoss, etc.)
          - contrastive / triplet in attribute or function names
          - criterion / loss_fn / loss variable assignments
        """
        train_dir = candidate_dir / "train"
        if not train_dir.is_dir():
            return SubCheck("train_ops", False, "train/ directory not found")

        py_files = list(train_dir.glob("*.py"))
        if not py_files:
            return SubCheck("train_ops", False, "No .py files in train/")

        has_optimizer = False
        has_loss = False
        has_dataloader = False

        for py_file in py_files:
            try:
                source = py_file.read_text()
                tree = ast.parse(source)
            except (OSError, SyntaxError):
                continue

            for node in ast.walk(tree):
                # ── Optimizer detection ──────────────────────────────────────
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if "torch.optim" in alias.name:
                            has_optimizer = True
                        if alias.name == "datasets":
                            has_dataloader = True

                if isinstance(node, ast.ImportFrom):
                    if node.module and "torch.optim" in node.module:
                        has_optimizer = True
                    # Standard torch DataLoader / Dataset
                    if node.module and "torch.utils.data" in node.module:
                        for alias in node.names:
                            if alias.name in ("DataLoader", "Dataset", "TensorDataset"):
                                has_dataloader = True
                    # PyG DataLoader
                    if node.module and "torch_geometric" in node.module:
                        for alias in node.names:
                            if alias.name in ("DataLoader", "Dataset"):
                                has_dataloader = True
                    # DGL DataLoader
                    if node.module and "dgl" in node.module:
                        for alias in node.names:
                            if alias.name == "DataLoader":
                                has_dataloader = True
                    # HuggingFace datasets
                    if node.module and "datasets" in node.module:
                        has_dataloader = True

                if isinstance(node, ast.Attribute):
                    if node.attr in ("Adam", "AdamW", "SGD", "RMSprop", "Adagrad", "Adadelta"):
                        has_optimizer = True
                    if node.attr == "DataLoader":
                        has_dataloader = True
                    # Loss classes: any attr name containing "Loss"
                    if "Loss" in node.attr:
                        has_loss = True
                    # Contrastive / triplet in attribute name
                    if any(kw in node.attr.lower() for kw in ("contrastive", "triplet")):
                        has_loss = True

                # ── Loss via assignment targets ───────────────────────────────
                if isinstance(node, ast.Assign):
                    for target in node.targets:
                        if isinstance(target, ast.Name) and target.id in (
                            "loss", "criterion", "loss_fn",
                        ):
                            has_loss = True

                if isinstance(node, ast.Name):
                    if any(kw in node.id for kw in ("Loss", "criterion", "loss_fn")):
                        has_loss = True

                # Loss function definitions (contrastive_loss, triplet_loss, etc.)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    nm = node.name.lower()
                    if any(kw in nm for kw in ("loss", "contrastive", "triplet")):
                        has_loss = True

        missing: list[str] = []
        if not has_optimizer:
            missing.append("torch.optim (optimizer)")
        if not has_loss:
            missing.append("loss (nn.*Loss / contrastive / triplet / criterion / loss_fn)")
        if not has_dataloader:
            missing.append("DataLoader (torch.utils.data / torch_geometric / dgl / datasets)")

        if missing:
            return SubCheck(
                "train_ops",
                False,
                f"Missing in train/: {', '.join(missing)}",
            )

        return SubCheck("train_ops", True, "train/ contains optimizer + loss + DataLoader")

    def _check_forward_pass(self, candidate_dir: Path) -> SubCheck:
        """Run a forward/encode pass on representative dummy tensors in a subprocess.

        Architecture-agnostic: tries multiple input shapes until one works.
          - (1, 3, 32, 32) float  — CNN / spatial models
          - (1, 3, 16, 16) float  — CNN small
          - (1, 16) long          — text token IDs for embedding / LM models
          - (1, 32) float         — flat features (tabular / graph readout)
          - (1, 128) float        — flat features large

        Also tries model.encode(dummy) when model(dummy) fails — useful for
        sentence-embedding and retrieval models that expose an encode() entry point.

        Uses subprocess to isolate the import so a broken candidate cannot crash
        the gate process itself.
        """
        script = textwrap.dedent(
            f"""\
            import sys
            sys.path.insert(0, {str(candidate_dir)!r})
            import torch

            # Locate entry point: build_model() or build()
            build_fn = None
            for fn_name in ("build_model", "build"):
                try:
                    mod = __import__("model", fromlist=[fn_name])
                    fn = getattr(mod, fn_name, None)
                    if callable(fn):
                        build_fn = fn
                        break
                except Exception:
                    pass

            if build_fn is None:
                print("ERROR: no build_model() or build() found in model/", file=sys.stderr)
                sys.exit(1)

            try:
                model = build_fn()
            except Exception as e:
                print(f"ERROR: build_fn() raised: {{e!r}}", file=sys.stderr)
                sys.exit(1)

            model.eval()

            # Representative dummy tensors (architecture-agnostic)
            dummy_inputs = [
                torch.zeros(1, 3, 32, 32),          # CNN spatial
                torch.zeros(1, 3, 16, 16),          # CNN spatial small
                torch.randint(0, 100, (1, 16)),     # text token IDs (LongTensor)
                torch.randn(1, 32),                 # flat features
                torch.randn(1, 128),                # flat features large
            ]

            errors = []
            for dummy in dummy_inputs:
                # Try model(dummy)
                try:
                    with torch.no_grad():
                        out = model(dummy)
                    assert out is not None, "forward() returned None"
                    print(f"OK: model(input={{list(dummy.shape)}})")
                    sys.exit(0)
                except Exception as e1:
                    errors.append(f"forward({{list(dummy.shape)}}): {{e1!r}}")

                # Try model.encode(dummy)
                if hasattr(model, "encode"):
                    try:
                        with torch.no_grad():
                            out = model.encode(dummy)
                        assert out is not None, "encode() returned None"
                        print(f"OK: model.encode(input={{list(dummy.shape)}})")
                        sys.exit(0)
                    except Exception as e2:
                        errors.append(f"encode({{list(dummy.shape)}}): {{e2!r}}")

            print("\\n".join(errors[:6]), file=sys.stderr)
            sys.exit(1)
            """
        )
        try:
            result = subprocess.run(
                [sys.executable, "-c", script],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode != 0:
                stderr = (result.stderr or "").strip()[:500]
                stdout = (result.stdout or "").strip()[:200]
                detail = stderr or stdout or "(no output)"
                return SubCheck(
                    "forward_pass",
                    False,
                    f"Forward pass failed (rc={result.returncode}): {detail}",
                )
            return SubCheck(
                "forward_pass",
                True,
                f"Forward pass succeeded: {(result.stdout or '').strip()[:120]}",
            )
        except subprocess.TimeoutExpired:
            return SubCheck("forward_pass", False, "Forward pass timed out after 60s")
        except Exception as exc:
            return SubCheck("forward_pass", False, f"Subprocess error: {exc}")

    def _check_eval_locked(self, candidate_dir: Path) -> SubCheck:
        eval_path = candidate_dir / "evaluate.py"
        if not eval_path.exists():
            return SubCheck("eval_locked", False, "evaluate.py not found in candidate_dir")

        if self._locked_eval_hash is None:
            return SubCheck(
                "eval_locked", True, "eval_locked: no reference hash provided (check skipped)"
            )

        actual_hash = hashlib.sha256(eval_path.read_bytes()).hexdigest()
        if actual_hash != self._locked_eval_hash:
            return SubCheck(
                "eval_locked",
                False,
                f"evaluate.py sha256 mismatch: "
                f"expected {self._locked_eval_hash[:16]}... got {actual_hash[:16]}...",
            )
        return SubCheck("eval_locked", True, "evaluate.py sha256 matches locked reference")

    def _check_telemetry(self, candidate_dir: Path) -> SubCheck:
        """Check for telemetry instrumentation in train/ and candidate root.

        Required pattern (§19 clean): candidate appends JSON-lines to
        $EVOR_TELEMETRY_PATH using stdlib open + write — detected by the
        co-presence of the string ``EVOR_TELEMETRY_PATH`` and ``open(`` in
        the same source file.
        """
        search_dirs = [candidate_dir / "train", candidate_dir]
        for search_dir in search_dirs:
            if not search_dir.is_dir():
                continue
            for py_file in search_dir.glob("*.py"):
                try:
                    source = py_file.read_text()
                    rel = py_file.relative_to(candidate_dir)
                    if "EVOR_TELEMETRY_PATH" in source and "open(" in source:
                        return SubCheck(
                            "telemetry",
                            True,
                            f"EVOR_TELEMETRY_PATH append found in {rel}",
                        )
                except OSError:
                    pass

        return SubCheck(
            "telemetry",
            False,
            "telemetry instrumentation not found in train/ or candidate root "
            "(expected EVOR_TELEMETRY_PATH + open() write)",
        )


# ─────────────────────────────────────────────────────────────────────────────
# ProbeEDAGate
# ─────────────────────────────────────────────────────────────────────────────


class ProbeEDAGate:
    """Validate a Probe-generated EDA directory (nodes/<id>/eda/).

    Usage::

        gate = ProbeEDAGate(node_id="node-abc")
        report = gate.check(Path("runs/mission/run/nodes/node-abc/eda"))
        if not report.passed:
            print(report.failure_reasons)
    """

    def __init__(self, node_id: str | None = None) -> None:
        self._node_id = node_id

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def check(self, node_eda_dir: Path) -> QualityReport:
        """Run all 5 sub-checks; return QualityReport."""
        checks: list[SubCheck] = [
            self._check_analysis_script(node_eda_dir),
            self._check_evor_eda_import(node_eda_dir),
            self._check_runtime_telemetry_ref(node_eda_dir),
            self._check_resource_guard(node_eda_dir),
            self._check_finding_artifact(node_eda_dir),
        ]
        return QualityReport(candidate_dir=node_eda_dir, checks=checks)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _find_analysis_scripts(self, node_eda_dir: Path) -> list[Path]:
        if not node_eda_dir.is_dir():
            return []
        return sorted(node_eda_dir.glob("analysis_*.py"))

    # ------------------------------------------------------------------
    # Sub-checks
    # ------------------------------------------------------------------

    def _check_analysis_script(self, node_eda_dir: Path) -> SubCheck:
        scripts = self._find_analysis_scripts(node_eda_dir)
        if not scripts:
            return SubCheck(
                "analysis_script_exists",
                False,
                f"No analysis_*.py found in {node_eda_dir}",
            )
        return SubCheck(
            "analysis_script_exists",
            True,
            f"Found {len(scripts)} analysis script(s): {[s.name for s in scripts]}",
        )

    def _check_evor_eda_import(self, node_eda_dir: Path) -> SubCheck:
        scripts = self._find_analysis_scripts(node_eda_dir)
        if not scripts:
            return SubCheck("evor_eda_import", False, "No analysis scripts found to inspect")

        for script in scripts:
            try:
                source = script.read_text()
                if "from evor.eda" in source or "import evor.eda" in source:
                    return SubCheck(
                        "evor_eda_import",
                        True,
                        f"evor.eda import found in {script.name}",
                    )
            except OSError:
                pass

        return SubCheck(
            "evor_eda_import",
            False,
            "No analysis script imports from evor.eda",
        )

    def _check_runtime_telemetry_ref(self, node_eda_dir: Path) -> SubCheck:
        """Check that node_id/domain_id comes from runtime params, not hardcoded strings.

        A script is considered runtime-parameterised if it:
          - defines a function with params named node_id/domain_id/run_dir/run_id, OR
          - imports argparse (and presumably calls parse_args()), OR
          - accesses os.environ or sys.argv.
        """
        scripts = self._find_analysis_scripts(node_eda_dir)
        if not scripts:
            return SubCheck("runtime_telemetry_ref", False, "No analysis scripts found")

        for script in scripts:
            try:
                source = script.read_text()
                tree = ast.parse(source)
            except (OSError, SyntaxError):
                continue

            for node in ast.walk(tree):
                # Function parameters named node_id, domain_id, run_dir, run_id
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    for arg in node.args.args:
                        if arg.arg in ("node_id", "domain_id", "run_dir", "run_id"):
                            return SubCheck(
                                "runtime_telemetry_ref",
                                True,
                                f"Runtime parameter '{arg.arg}' found in {script.name}",
                            )

                # argparse import
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name == "argparse":
                            return SubCheck(
                                "runtime_telemetry_ref",
                                True,
                                f"argparse import found in {script.name}",
                            )
                if isinstance(node, ast.ImportFrom):
                    if node.module == "argparse":
                        return SubCheck(
                            "runtime_telemetry_ref",
                            True,
                            f"argparse import found in {script.name}",
                        )

                # os.environ or sys.argv access
                if isinstance(node, ast.Attribute):
                    if isinstance(node.value, ast.Name) and node.value.id == "os":
                        if node.attr == "environ":
                            return SubCheck(
                                "runtime_telemetry_ref",
                                True,
                                f"os.environ access found in {script.name}",
                            )
                    if isinstance(node.value, ast.Name) and node.value.id == "sys":
                        if node.attr == "argv":
                            return SubCheck(
                                "runtime_telemetry_ref",
                                True,
                                f"sys.argv access found in {script.name}",
                            )

        return SubCheck(
            "runtime_telemetry_ref",
            False,
            "No runtime domain_id/node_id reference found (all appear hardcoded); "
            "use function parameters, argparse, or os.environ",
        )

    def _check_resource_guard(self, node_eda_dir: Path) -> SubCheck:
        scripts = self._find_analysis_scripts(node_eda_dir)
        if not scripts:
            return SubCheck("resource_guard", False, "No analysis scripts found")

        for script in scripts:
            try:
                source = script.read_text()
                if (
                    "safe_exec" in source
                    or "resource.setrlimit" in source
                    or "RLIMIT_AS" in source
                    or "RLIMIT_" in source
                ):
                    return SubCheck(
                        "resource_guard",
                        True,
                        f"Resource guard found in {script.name}",
                    )
                # Also accept explicit timeout patterns
                if "subprocess.run" in source and "timeout" in source:
                    return SubCheck(
                        "resource_guard",
                        True,
                        f"Subprocess timeout guard found in {script.name}",
                    )
            except OSError:
                pass

        return SubCheck(
            "resource_guard",
            False,
            "No resource/timeout guard found (safe_exec / resource.setrlimit / RLIMIT_AS); "
            "use evor.eda.safe_exec() to run generated sub-scripts under limits",
        )

    def _check_finding_artifact(self, node_eda_dir: Path) -> SubCheck:
        if not node_eda_dir.is_dir():
            return SubCheck(
                "finding_artifact",
                False,
                f"EDA directory does not exist: {node_eda_dir}",
            )

        artifacts = [
            f
            for f in node_eda_dir.iterdir()
            if f.is_file() and f.suffix not in (".py", ".pyc")
        ]
        if not artifacts:
            return SubCheck(
                "finding_artifact",
                False,
                "No finding artifacts (non-.py files) found in EDA directory; "
                "Probe must write at least one finding via save_finding()",
            )
        names = [a.name for a in artifacts[:5]]
        return SubCheck(
            "finding_artifact",
            True,
            f"Found {len(artifacts)} finding artifact(s): {names}",
        )
