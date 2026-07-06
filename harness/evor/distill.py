"""
evor-distill — workspace classifier and deep scanner.

Produces a StartingPointReport for brownfield ML repos so evor-setup can
pre-fill its interview from existing artifacts rather than asking the user
to type everything from scratch.

INVARIANT: every ScrapedMetric and the BaselineCandidate have verified=False.
Distill never trusts a repo's claimed numbers — EVOR must re-measure on a
frozen split.

CLI:
  python -m evor.distill scan --root <dir> [--evor-root <dir>] [--json]
  python -m evor.distill classify --root <dir>

Both commands are crash-safe (permission errors skipped, symlinks skipped)
and bounded (IGNORE dirs enforced; depth ≤ 6; file count ≤ 2000).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from evor.contracts import (
    BaselineCandidate,
    DetectedConfig,
    DetectedDataset,
    DetectedModel,
    ScrapedMetric,
    StartingPointReport,
    WorkspaceClass,
)


# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

# Directories to never descend into (matches the hook's JS list exactly)
_IGNORE_DIRS: frozenset[str] = frozenset(
    ".git .evor node_modules .venv venv __pycache__ refs dist build .omc site-packages".split()
)

_MAX_DEPTH: int = 6
_MAX_FILES: int = 2000

_CHECKPOINT_EXTS: frozenset[str] = frozenset(
    ".pt .pth .ckpt .safetensors .onnx .h5 .pkl".split()
)
_DATASET_DIRS: frozenset[str] = frozenset("data datasets dataset".split())
_DATASET_EXTS: frozenset[str] = frozenset(".csv .parquet .tfrecord".split())
_CONFIG_DIRS: frozenset[str] = frozenset("conf config configs".split())
_LOG_DIRS: frozenset[str] = frozenset(
    "wandb mlruns lightning_logs runs tb_logs outputs".split()
)
_TRAIN_FILENAMES: frozenset[str] = frozenset("train.py trainer.py main.py".split())

# Tokens that indicate a file actually contains training code (content check)
_TRAINING_TOKENS: tuple[str, ...] = (
    "optimizer",
    "criterion",
    "loss.backward",
    "train_loader",
    "DataLoader",
    "model.train(",
    ".fit(",
    "compile(",
)

# Time window for "possibly-training" detection
_RECENT_SECS: int = 600

# Hyperparameter key names to extract from config files
_HYPERPARAM_KEYS: frozenset[str] = frozenset(
    "lr learning_rate batch_size epochs model optimizer num_epochs".split()
)

# Metric scraping: matches patterns like "val acc 0.82", "accuracy: 0.92", "f1 = 0.75"
_METRIC_RE = re.compile(
    r"(?P<metric>"
    r"(?:val(?:_| |id(?:ation)?(?:_| ))?)?"
    r"(?:acc(?:uracy)?|f1(?:[_\-]score)?|auc|roc[_\-]auc|"
    r"precision|recall|mse|mae|rmse|r2|bleu|rouge|map|mrr|ndcg|loss)"
    r")"
    r"[\s:=@]+(?P<value>[0-9]+(?:\.[0-9]+)?(?:e[-+]?[0-9]+)?)",
    re.IGNORECASE,
)

# Split-hint markers to look for in the text preceding a metric value
_SPLIT_HINTS: tuple[tuple[str, str], ...] = (
    ("val ", "val"),
    ("valid", "val"),
    ("test ", "test"),
    ("train ", "train"),
)

# Architecture name patterns for arch_guess
_ARCH_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"resnet", re.I), "resnet"),
    (re.compile(r"vgg\d", re.I), "vgg"),
    (re.compile(r"efficientnet", re.I), "efficientnet"),
    (re.compile(r"mobilenet", re.I), "mobilenet"),
    (re.compile(r"bert", re.I), "bert"),
    (re.compile(r"gpt", re.I), "gpt"),
    (re.compile(r"\bt5\b", re.I), "t5"),
    (re.compile(r"\bvit\b", re.I), "vit"),
    (re.compile(r"yolo", re.I), "yolo"),
    (re.compile(r"unet", re.I), "unet"),
    (re.compile(r"lstm", re.I), "lstm"),
    (re.compile(r"transformer", re.I), "transformer"),
]

_FORMAT_MAP: dict[str, str] = {
    ".pt": "torch",
    ".pth": "torch",
    ".ckpt": "checkpoint",
    ".safetensors": "safetensors",
    ".onnx": "onnx",
    ".h5": "h5",
    ".pkl": "pickle",
}


# ─────────────────────────────────────────────────────────────────────────────
# Low-level helpers
# ─────────────────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _file_mtime(path: Path) -> float:
    """Return mtime as seconds-since-epoch; 0.0 on any error."""
    try:
        return path.stat().st_mtime
    except (PermissionError, OSError):
        return 0.0


def _mtime_iso(path: Path) -> str:
    """Return file mtime as ISO 8601 string; falls back to now on error."""
    t = _file_mtime(path)
    if t == 0.0:
        return _now_iso()
    return datetime.fromtimestamp(t, tz=timezone.utc).isoformat()


def _dir_size_bytes(path: Path, _cap: int = 500) -> Optional[int]:
    """Best-effort recursive directory size in bytes.

    Capped at _cap files to avoid hanging on enormous dataset directories.
    Returns None when the directory is too large or on permission error.
    """
    total = 0
    count = 0
    try:
        for entry in path.rglob("*"):
            if count >= _cap:
                return None
            count += 1
            try:
                if entry.is_file() and not entry.is_symlink():
                    total += entry.stat().st_size
            except (PermissionError, OSError):
                pass
    except (PermissionError, OSError):
        return None
    return total


# ─────────────────────────────────────────────────────────────────────────────
# Bounded filesystem traversal
# ─────────────────────────────────────────────────────────────────────────────

def _walk_bounded(root: Path) -> list[Path]:
    """Walk root depth-first up to _MAX_DEPTH, skipping _IGNORE_DIRS.

    Returns at most _MAX_FILES entries (files + dirs).
    Never raises — permission errors and symlinks are silently skipped.
    """
    results: list[Path] = []

    def _recurse(path: Path, depth: int) -> None:
        if depth > _MAX_DEPTH or len(results) >= _MAX_FILES:
            return
        try:
            entries = list(path.iterdir())
        except (PermissionError, OSError):
            return
        for entry in entries:
            if len(results) >= _MAX_FILES:
                return
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir():
                    if entry.name in _IGNORE_DIRS:
                        continue
                    results.append(entry)
                    _recurse(entry, depth + 1)
                elif entry.is_file():
                    results.append(entry)
            except (PermissionError, OSError):
                continue

    _recurse(root, 0)
    return results


# ─────────────────────────────────────────────────────────────────────────────
# Workspace classifier (fast — globs only, no content reads)
# ─────────────────────────────────────────────────────────────────────────────

def classify_workspace(root: Path) -> tuple[WorkspaceClass, dict[str, int]]:
    """Classify root → (WorkspaceClass, counts).

    Fast: globs only, no file content reads, bounded depth and file count.
    Crash-safe: all permission errors are silently skipped.

    Precedence: evor-active > possibly-training > brownfield > greenfield.

    Returns:
        Tuple of (workspace_class, {"models": N, "datasets": N, "configs": N, "logs": N}).
    """
    counts: dict[str, int] = {"models": 0, "datasets": 0, "configs": 0, "logs": 0}

    # evor-active: active-run.json is present
    try:
        if (root / ".evor" / "active-run.json").exists():
            return "evor-active", counts
    except (PermissionError, OSError):
        pass

    all_entries = _walk_bounded(root)

    checkpoint_mtimes: list[float] = []
    log_mtimes: list[float] = []
    has_ml_code = False
    pkl_entries: list[Path] = []

    for entry in all_entries:
        try:
            if entry.is_file():
                ext = entry.suffix.lower()
                name_lower = entry.name.lower()
                parent_lower = entry.parent.name.lower()

                if ext in _CHECKPOINT_EXTS:
                    if ext == ".pkl":
                        pkl_entries.append(entry)
                    else:
                        counts["models"] += 1
                        checkpoint_mtimes.append(_file_mtime(entry))
                elif ext in _DATASET_EXTS:
                    counts["datasets"] += 1
                elif ext in (".yaml", ".yml"):
                    if (parent_lower in _CONFIG_DIRS
                            or name_lower == "params.yaml"
                            or name_lower.startswith("config")):
                        counts["configs"] += 1
                elif name_lower in _TRAIN_FILENAMES or ext == ".ipynb":
                    has_ml_code = True

            elif entry.is_dir():
                name_lower = entry.name.lower()
                if name_lower in _DATASET_DIRS:
                    counts["datasets"] += 1
                elif name_lower in _LOG_DIRS:
                    counts["logs"] += 1
                    log_mtimes.append(_file_mtime(entry))

        except (PermissionError, OSError):
            continue

    # .pkl counts only when a sibling train/model file exists in the same dir
    for pkl_path in pkl_entries:
        try:
            siblings = {e.name.lower() for e in pkl_path.parent.iterdir() if e.is_file()}
            if any(
                s in _TRAIN_FILENAMES
                or s.endswith((".pt", ".pth"))
                or "model" in s
                or "train" in s
                for s in siblings
            ):
                counts["models"] += 1
                checkpoint_mtimes.append(_file_mtime(pkl_path))
        except (PermissionError, OSError):
            pass

    # HF cache directory
    try:
        if (root / ".cache" / "huggingface").exists():
            counts["datasets"] += 1
    except (PermissionError, OSError):
        pass

    has_ml_artifacts = (
        counts["models"] > 0
        or counts["datasets"] > 0
        or counts["configs"] > 0
        or counts["logs"] > 0
        or has_ml_code
    )

    if not has_ml_artifacts:
        return "greenfield", counts

    # Check for recent activity (possibly-training)
    now = time.time()
    recent_mtimes = checkpoint_mtimes + log_mtimes
    if recent_mtimes and (now - max(recent_mtimes)) <= _RECENT_SECS:
        return "possibly-training", counts

    return "brownfield", counts


# ─────────────────────────────────────────────────────────────────────────────
# Framework / task guessers (content-read; called by scan only)
# ─────────────────────────────────────────────────────────────────────────────

def _guess_framework(files: list[Path]) -> str:
    """Infer ML framework from import statements in Python source files.

    Reads up to the first 4 KB of up to 20 .py files.
    Returns one of: "pytorch", "tensorflow", "jax", "sklearn", "unknown".
    """
    py_files = [f for f in files if f.suffix == ".py" and f.is_file()][:20]
    for py_file in py_files:
        try:
            text = py_file.read_text(errors="replace")[:4096]
        except (PermissionError, OSError):
            continue
        if "import torch" in text or "from torch" in text:
            return "pytorch"
        if "import tensorflow" in text or "from tensorflow" in text:
            return "tensorflow"
        if "import jax" in text or "from jax" in text:
            return "jax"
        if "import sklearn" in text or "from sklearn" in text:
            return "sklearn"

    # Fallback: infer from checkpoint file extensions
    names = {f.name.lower() for f in files if f.is_file()}
    if any(n.endswith((".pt", ".pth")) for n in names):
        return "pytorch"
    if any(n.endswith(".h5") for n in names):
        return "tensorflow"
    if any(n.endswith(".safetensors") for n in names):
        return "pytorch"

    return "unknown"


def _guess_task(config_texts: list[str], readme_text: str) -> Optional[str]:
    """Guess the ML task from config content and README text."""
    all_lower = (" ".join(config_texts) + " " + readme_text).lower()

    task_keywords = [
        ("detection", ["object_detect", "bbox", "anchor", "yolo", "faster_rcnn", "ssd"]),
        ("segmentation", ["segment", "mask", "pixel_", "fcn", "unet", "deeplabv"]),
        ("generation", ["generat", "diffusion", "vae", "lm_head", "language_model", "decoder"]),
        ("regression", ["regression", "mse_loss", "l1_loss", "mean_absolute_error"]),
        ("nlp", ["tokenizer", "vocab_size", "bert", "gpt", "transformer", "text_class"]),
        ("time-series", ["time_series", "timeseries", "forecast", "temporal"]),
        ("classification", ["classif", "num_classes", "class_names", "cross_entropy"]),
    ]
    for task, keywords in task_keywords:
        if any(kw in all_lower for kw in keywords):
            return task
    return None


def _guess_arch(path: Path) -> Optional[str]:
    """Infer model architecture family from file and parent directory names."""
    probe = (path.parent.name + "/" + path.stem).lower()
    for pattern, arch in _ARCH_PATTERNS:
        if pattern.search(probe):
            return arch
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Config hyperparam extractor
# ─────────────────────────────────────────────────────────────────────────────

def _extract_hyperparams(path: Path) -> dict[str, Any]:
    """Best-effort extraction of lr/batch_size/epochs/model/optimizer.

    Reads the file and attempts to parse it as YAML, JSON, or TOML.
    Flattens one level of nesting before extracting known keys.
    Returns {} on any parse error or permission failure.
    """
    result: dict[str, Any] = {}
    try:
        text = path.read_text(errors="replace")
        ext = path.suffix.lower()
        data: Any = None

        if ext in (".yaml", ".yml"):
            try:
                import yaml  # type: ignore[import-untyped]
                data = yaml.safe_load(text)
            except Exception:
                pass
        elif ext == ".json":
            try:
                data = json.loads(text)
            except Exception:
                pass
        elif ext == ".toml":
            try:
                import tomllib  # Python 3.11+
                data = tomllib.loads(text)
            except ImportError:
                try:
                    import tomli  # type: ignore[import-untyped]
                    data = tomli.loads(text)
                except Exception:
                    pass
            except Exception:
                pass

        if not isinstance(data, dict):
            return result

        # Flatten one level of nesting so nested configs are covered too
        flat: dict[str, Any] = {}
        for k, v in data.items():
            flat[k] = v
            if isinstance(v, dict):
                for k2, v2 in v.items():
                    if k2 not in flat:
                        flat[k2] = v2

        _aliases: dict[str, str] = {
            "learning_rate": "lr",
            "num_epochs": "epochs",
        }
        for key in _HYPERPARAM_KEYS:
            if key in flat and flat[key] is not None:
                canonical = _aliases.get(key, key)
                result[canonical] = flat[key]

    except (PermissionError, OSError):
        pass

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Metric scrapers
# ─────────────────────────────────────────────────────────────────────────────

def _scrape_readme_metrics(readme_path: Path) -> list[ScrapedMetric]:
    """Scrape metric/value pairs from a README file using regex.

    Handles patterns like "val acc 0.82", "accuracy: 0.92", "f1 = 0.75".
    Converts percent values (>1 and ≤100) to fractions; skips values >100.
    All results have verified=False.
    """
    results: list[ScrapedMetric] = []
    try:
        text = readme_path.read_text(errors="replace")
    except (PermissionError, OSError):
        return results

    for match in _METRIC_RE.finditer(text):
        raw_metric = match.group("metric").strip().lower()
        try:
            value = float(match.group("value"))
        except ValueError:
            continue

        # Normalise percent → fraction
        if 1.0 < value <= 100.0:
            value = value / 100.0
        elif value > 100.0:
            continue

        # Split hint: look at the 40 chars before the match
        pre = text[max(0, match.start() - 40): match.start()].lower()
        split_hint: Optional[str] = None
        for prefix, hint in _SPLIT_HINTS:
            if prefix in pre:
                split_hint = hint
                break
        # If the metric name itself starts with val/test/train, use that
        if split_hint is None:
            m_lower = raw_metric
            if m_lower.startswith("val"):
                split_hint = "val"
            elif m_lower.startswith("test"):
                split_hint = "test"
            elif m_lower.startswith("train"):
                split_hint = "train"

        metric_name = re.sub(r"\s+", "_", raw_metric)

        results.append(ScrapedMetric(
            source="readme",
            source_path=str(readme_path),
            metric=metric_name,
            value=value,
            split_hint=split_hint,
            verified=False,
        ))

    return results


def _scrape_json_metrics(json_path: Path) -> list[ScrapedMetric]:
    """Scrape float metric values from a small JSON file (≤ 512 KB).

    Looks for keys containing acc/f1/auc/loss/precision/recall/mse/mae.
    All results have verified=False.
    """
    results: list[ScrapedMetric] = []
    try:
        if json_path.stat().st_size > 512 * 1024:
            return results
        data = json.loads(json_path.read_text(errors="replace"))
    except (PermissionError, OSError, json.JSONDecodeError, ValueError):
        return results

    if not isinstance(data, dict):
        return results

    _metric_tokens = ("acc", "f1", "auc", "loss", "precision", "recall", "mse", "mae", "rmse")
    for k, v in data.items():
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            continue
        k_lower = k.lower()
        if not any(tok in k_lower for tok in _metric_tokens):
            continue
        try:
            value = float(v)
        except (TypeError, ValueError):
            continue
        if value > 100.0:
            continue
        if 1.0 < value <= 100.0:
            value = value / 100.0

        split_hint: Optional[str] = None
        for prefix, hint in _SPLIT_HINTS:
            if prefix in k_lower:
                split_hint = hint
                break

        results.append(ScrapedMetric(
            source="json",
            source_path=str(json_path),
            metric=k_lower,
            value=value,
            split_hint=split_hint,
            verified=False,
        ))

    return results


# ─────────────────────────────────────────────────────────────────────────────
# Deep workspace scanner
# ─────────────────────────────────────────────────────────────────────────────

def scan_workspace(root: Path) -> StartingPointReport:
    """Deep-scan root and return a StartingPointReport.

    Crash-safe: all errors are caught and surface in warnings[].
    Bounded: uses _walk_bounded() — IGNORE dirs skipped, depth ≤ 6,
    file count ≤ 2000.

    INVARIANT: all scraped_metrics and baseline_candidate have verified=False.
    """
    warnings: list[str] = []
    datasets: list[DetectedDataset] = []
    models: list[DetectedModel] = []
    configs: list[DetectedConfig] = []
    scraped_metrics: list[ScrapedMetric] = []
    entry_points: list[str] = []

    workspace_class, _counts = classify_workspace(root)

    if workspace_class == "possibly-training":
        warnings.append(
            "A checkpoint or experiment-log was modified within the last 10 min "
            "— a training run may be active. EVOR will not touch any artifacts."
        )

    all_entries = _walk_bounded(root)
    all_files = [e for e in all_entries if e.is_file()]
    all_dirs = [e for e in all_entries if e.is_dir()]

    # ── Datasets ──────────────────────────────────────────────────────────────
    for d in all_dirs:
        if d.name.lower() in _DATASET_DIRS:
            size = _dir_size_bytes(d)
            kind = "unknown"
            try:
                children = list(d.iterdir())[:50]
                child_exts = {c.suffix.lower() for c in children if c.is_file()}
                child_names = [c.name.lower() for c in children if c.is_file()]
                if ".csv" in child_exts:
                    kind = "csv"
                elif ".parquet" in child_exts:
                    kind = "parquet"
                elif ".tfrecord" in child_exts:
                    kind = "tfrecord"
                elif any(
                    n.endswith((".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"))
                    for n in child_names
                ):
                    kind = "images-dir"
            except (PermissionError, OSError):
                pass
            datasets.append(DetectedDataset(
                path=str(d),
                kind=kind,  # type: ignore[arg-type]
                approx_size_bytes=size,
            ))

    # HF cache
    try:
        hf_dir = root / ".cache" / "huggingface"
        if hf_dir.exists():
            datasets.append(DetectedDataset(
                path=str(hf_dir),
                kind="hf-cache",
                approx_size_bytes=_dir_size_bytes(hf_dir),
            ))
    except (PermissionError, OSError):
        pass

    # Flat dataset files (.csv / .parquet / .tfrecord)
    _ext_to_kind = {".csv": "csv", ".parquet": "parquet", ".tfrecord": "tfrecord"}
    for f in all_files:
        ext = f.suffix.lower()
        if ext in _DATASET_EXTS:
            try:
                size: Optional[int] = f.stat().st_size
            except (PermissionError, OSError):
                size = None
            datasets.append(DetectedDataset(
                path=str(f),
                kind=_ext_to_kind[ext],  # type: ignore[arg-type]
                approx_size_bytes=size,
            ))

    # ── Models ────────────────────────────────────────────────────────────────
    for f in all_files:
        ext = f.suffix.lower()
        if ext not in _CHECKPOINT_EXTS:
            continue
        if ext == ".pkl":
            # Count only when a sibling train/model file confirms this is ML
            try:
                siblings = {e.name.lower() for e in f.parent.iterdir() if e.is_file()}
                if not any(
                    s in _TRAIN_FILENAMES
                    or s.endswith((".pt", ".pth"))
                    or "model" in s
                    or "train" in s
                    for s in siblings
                ):
                    continue
            except (PermissionError, OSError):
                continue

        models.append(DetectedModel(
            path=str(f),
            format=_FORMAT_MAP.get(ext, "unknown"),  # type: ignore[arg-type]
            arch_guess=_guess_arch(f),
            mtime=_mtime_iso(f),
        ))

    # ── Configs ───────────────────────────────────────────────────────────────
    for f in all_files:
        ext = f.suffix.lower()
        parent_lower = f.parent.name.lower()
        name_lower = f.name.lower()

        fmt: Optional[str] = None
        if ext in (".yaml", ".yml"):
            if (parent_lower in _CONFIG_DIRS
                    or name_lower == "params.yaml"
                    or name_lower.startswith("config")):
                # Check for Hydra indicators in the first 512 bytes
                is_hydra = False
                try:
                    snippet = f.read_text(errors="replace")[:512]
                    if "@hydra.main" in snippet or "_target_:" in snippet:
                        is_hydra = True
                except (PermissionError, OSError):
                    pass
                fmt = "hydra" if is_hydra else "yaml"
        elif ext == ".json" and parent_lower in _CONFIG_DIRS:
            fmt = "json"
        elif ext == ".toml" and parent_lower in _CONFIG_DIRS:
            fmt = "toml"

        if fmt is not None:
            configs.append(DetectedConfig(
                path=str(f),
                format=fmt,  # type: ignore[arg-type]
                key_hyperparams=_extract_hyperparams(f),
            ))

    # ── Entry points ──────────────────────────────────────────────────────────
    for f in all_files:
        if f.name.lower() not in _TRAIN_FILENAMES:
            continue
        try:
            text = f.read_text(errors="replace")[:8192]
            if any(tok in text for tok in _TRAINING_TOKENS):
                entry_points.append(str(f))
        except (PermissionError, OSError):
            continue

    # ── Metric scraping ───────────────────────────────────────────────────────
    readme_candidates = [
        f for f in all_files
        if f.name.lower() in ("readme.md", "readme.txt", "readme.rst", "readme")
    ]
    for readme in readme_candidates:
        try:
            scraped_metrics.extend(_scrape_readme_metrics(readme))
        except Exception as exc:
            warnings.append(f"README metric scrape failed ({readme.name}): {exc}")

    # Small JSON result/metric files
    json_result_files = [
        f for f in all_files
        if f.suffix.lower() == ".json"
        and any(
            tok in f.name.lower()
            for tok in ("result", "metric", "eval", "score", "perf")
        )
    ]
    for jf in json_result_files[:10]:
        try:
            scraped_metrics.extend(_scrape_json_metrics(jf))
        except Exception as exc:
            warnings.append(f"JSON metric scrape failed ({jf.name}): {exc}")

    # wandb summary files
    for d in all_dirs:
        if d.name.lower() == "wandb":
            try:
                for sf in d.rglob("wandb-summary.json"):
                    try:
                        scraped_metrics.extend(_scrape_json_metrics(sf))
                    except Exception:
                        pass
            except (PermissionError, OSError):
                pass

    # ── Framework + task ──────────────────────────────────────────────────────
    framework = _guess_framework(all_files)

    config_texts: list[str] = []
    for cfg in configs[:5]:
        try:
            config_texts.append(Path(cfg.path).read_text(errors="replace")[:2048])
        except (PermissionError, OSError):
            pass

    readme_text = ""
    if readme_candidates:
        try:
            readme_text = readme_candidates[0].read_text(errors="replace")[:4096]
        except (PermissionError, OSError):
            pass

    task_guess = _guess_task(config_texts, readme_text)

    # ── Baseline candidate ────────────────────────────────────────────────────
    baseline_candidate: Optional[BaselineCandidate] = None
    if scraped_metrics:
        # Priority: prefer val/test split hints; prefer acc/f1/auc metrics
        def _priority(m: ScrapedMetric) -> tuple[int, int, float]:
            split_score = 2 if m.split_hint in ("val", "test") else (1 if m.split_hint else 0)
            metric_score = 1 if any(t in m.metric for t in ("acc", "f1", "auc")) else 0
            return (split_score, metric_score, m.value)

        best = max(scraped_metrics, key=_priority)
        baseline_candidate = BaselineCandidate(
            model_path=models[0].path if models else None,
            metric_name=best.metric,
            claimed_value=best.value,
            source=best.source,
            verified=False,
        )

    return StartingPointReport(
        workspace_class=workspace_class,
        root=str(root.resolve()),
        framework=framework,  # type: ignore[arg-type]
        task_guess=task_guess,
        datasets=datasets,
        models=models,
        configs=configs,
        scraped_metrics=scraped_metrics,
        entry_points=entry_points,
        baseline_candidate=baseline_candidate,
        warnings=warnings,
        generated_at=_now_iso(),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Human-readable summary
# ─────────────────────────────────────────────────────────────────────────────

def _format_summary(report: StartingPointReport) -> str:
    """Format a concise human-readable summary of a StartingPointReport."""
    lines = [
        f"[evor-distill] workspace: {report.workspace_class}  root: {report.root}",
        f"  framework: {report.framework or 'unknown'}  task: {report.task_guess or 'unknown'}",
        (
            f"  models: {len(report.models)}"
            f"  datasets: {len(report.datasets)}"
            f"  configs: {len(report.configs)}"
            f"  entry_points: {len(report.entry_points)}"
            f"  scraped_metrics: {len(report.scraped_metrics)}"
        ),
    ]
    if report.baseline_candidate and report.baseline_candidate.claimed_value is not None:
        bc = report.baseline_candidate
        lines.append(
            f"  baseline (UNVERIFIED): {bc.metric_name}={bc.claimed_value:.4f}"
            f"  source={bc.source}"
            f"  model={bc.model_path}"
        )
    for w in report.warnings:
        lines.append(f"  WARNING: {w}")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def _cli(argv: list[str] | None = None) -> int:
    """Entry point: python -m evor.distill <subcommand> [options].

    Subcommands:
      scan     -- deep scan → StartingPointReport written to <evorRoot>/starting-point.json
      classify -- fast workspace classification (globs only, one-line JSON)
    """
    parser = argparse.ArgumentParser(
        prog="python -m evor.distill",
        description="evor-distill — workspace classifier and deep scanner",
    )
    sub = parser.add_subparsers(dest="action", required=True)

    # scan
    scan_p = sub.add_parser("scan", help="Deep-scan workspace → StartingPointReport")
    scan_p.add_argument(
        "--root", required=True, type=Path,
        help="Workspace root directory to scan",
    )
    scan_p.add_argument(
        "--evor-root", type=Path, default=None,
        help="EVOR root (.evor/ dir). Defaults to <root>/.evor/",
    )
    scan_p.add_argument(
        "--json", action="store_true",
        help="Print JSON report to stdout (default: human summary)",
    )

    # classify
    cls_p = sub.add_parser("classify", help="Fast workspace classification (globs only)")
    cls_p.add_argument(
        "--root", required=True, type=Path,
        help="Workspace root directory",
    )

    args = parser.parse_args(argv)

    if args.action == "classify":
        root = args.root.resolve()
        wclass, counts = classify_workspace(root)
        print(json.dumps({"workspace_class": wclass, "counts": counts}))
        return 0

    if args.action == "scan":
        root = args.root.resolve()
        evor_root: Path = (
            args.evor_root.resolve() if args.evor_root else root / ".evor"
        )
        report = scan_workspace(root)

        # Write starting-point.json
        try:
            evor_root.mkdir(parents=True, exist_ok=True)
            out_path = evor_root / "starting-point.json"
            out_path.write_text(report.model_dump_json(indent=2))
            print(f"[evor-distill] wrote {out_path}", file=sys.stderr)
        except (PermissionError, OSError) as exc:
            print(
                f"[evor-distill] WARNING: could not write starting-point.json: {exc}",
                file=sys.stderr,
            )

        if args.json:
            print(report.model_dump_json(indent=2))
        else:
            print(_format_summary(report))

        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(_cli())
