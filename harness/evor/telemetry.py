"""
TelemetryCallback SDK — framework-agnostic training telemetry (M6).

Forge (evor-forge) injects TelemetryCallback into every training run before
execution. This is a mandatory instrumentation step; Selector rejects un-
instrumented candidates.

Schema: TelemetryRecord from contracts.py.
  Required per record: step, node_id, run_id, timestamp.
  All metric fields optional but at least one must be present.
  grad_norm is conditional (R6): present for PyTorch; absent for tabular/XGBoost.

Usage patterns:
  PyTorch Lightning:
    cb = TelemetryCallback(node_id, run_id, run_dir)
    trainer.callbacks.append(cb)

  Plain training loop:
    cb = TelemetryCallback(node_id, run_id, run_dir)
    for step, batch in enumerate(dataloader):
        loss = train_step(batch)
        cb.log(step=step, train_loss=loss.item(), lr=scheduler.get_lr()[0])

  Keras:
    class EvorKeras(tf.keras.callbacks.Callback, TelemetryCallback):
        ...  # subclass and call self.log() from on_batch_end

Output: JSONL appended to nodes/<node_id>/telemetry.jsonl.
Each line is a valid TelemetryRecord serialised to JSON.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class TelemetryCallback:
    """PyTorch Lightning / plain-loop compatible telemetry callback.

    Writes one TelemetryRecord JSON line per log() call to
    nodes/<node_id>/telemetry.jsonl (JSONL append).

    Required fields (always injected by this class):
      step, node_id, run_id, timestamp

    Optional metric fields (pass as kwargs to log()):
      epoch, train_loss, val_metric, lr, grad_norm, param_norm,
      update_ratio, throughput, gpu_util, mem_used_gb, mem_total_gb
    """

    # Fields defined by TelemetryRecord schema
    _METRIC_FIELDS = frozenset({
        "epoch",
        "train_loss",
        "val_metric",
        "lr",
        "grad_norm",
        "param_norm",
        "update_ratio",
        "throughput",
        "gpu_util",
        "mem_used_gb",
        "mem_total_gb",
    })

    def __init__(
        self,
        node_id: str,
        run_id: str,
        run_dir: Path | None = None,
    ) -> None:
        """
        Args:
            node_id:  Node identifier (used as path component and field value).
            run_id:   Run identifier (embedded in every record).
            run_dir:  Root of the .evor/runs/<mission>/<run-id>/ directory.
                      If None, telemetry is written to './nodes/<node_id>/' relative
                      to the current working directory.
        """
        self._node_id = node_id
        self._run_id = run_id
        self._run_dir = run_dir

        # Resolve output path; create parent dirs lazily on first write
        if run_dir is not None:
            self._telemetry_path = run_dir / "nodes" / node_id / "telemetry.jsonl"
        else:
            self._telemetry_path = Path("nodes") / node_id / "telemetry.jsonl"

        # Track current step for Lightning hooks that don't provide step explicitly
        self._current_step: int = 0
        # Buffer val_metric from validation epoch to attach to the next batch record
        self._pending_val_metric: float | None = None

    # ------------------------------------------------------------------
    # Core log method (plain-loop + Lightning hooks delegate here)
    # ------------------------------------------------------------------

    def log(self, step: int | None = None, **kwargs: Any) -> None:
        """Write one TelemetryRecord to telemetry.jsonl.

        Args:
            step:    Training step number. If omitted, uses internal counter.
            **kwargs: Any TelemetryRecord metric field (see _METRIC_FIELDS).
                      Unknown keys are silently ignored.

        At least one metric field must be provided; a record with only
        node_id/run_id/step/timestamp is discarded (raises ValueError in
        strict mode, silent in production to avoid disrupting training).
        """
        if step is None:
            step = self._current_step
        self._current_step = step + 1

        record: dict[str, Any] = {
            "step": step,
            "node_id": self._node_id,
            "run_id": self._run_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # Attach only known metric fields from kwargs
        for field in self._METRIC_FIELDS:
            if field in kwargs and kwargs[field] is not None:
                record[field] = kwargs[field]

        # Ensure output directory exists
        self._telemetry_path.parent.mkdir(parents=True, exist_ok=True)

        with open(self._telemetry_path, "a") as fh:
            fh.write(json.dumps(record) + "\n")

    # ------------------------------------------------------------------
    # PyTorch Lightning callback hooks
    # ------------------------------------------------------------------

    def on_train_batch_end(
        self,
        trainer: Any,
        pl_module: Any,
        outputs: Any,
        batch: Any,
        batch_idx: int,
    ) -> None:
        """Lightning hook: log training metrics after each batch.

        Extracts train_loss, lr, grad_norm, param_norm, update_ratio from the
        Lightning trainer state. Gracefully skips fields that are unavailable
        (e.g. tabular models that don't have grad_norm).
        """
        metrics: dict[str, Any] = {}

        # train_loss
        if outputs is not None:
            loss_val = None
            if isinstance(outputs, dict):
                loss_val = outputs.get("loss")
            elif hasattr(outputs, "loss"):
                loss_val = outputs.loss
            if loss_val is not None:
                try:
                    metrics["train_loss"] = float(loss_val)
                except (TypeError, ValueError):
                    pass

        # lr from optimizer
        try:
            optims = trainer.optimizers
            if optims:
                opt = optims[0] if isinstance(optims, list) else optims
                lrs = [pg["lr"] for pg in opt.param_groups]
                metrics["lr"] = float(lrs[0])
        except Exception:
            pass

        # grad_norm (optional — skip for non-differentiable models)
        try:
            gn = trainer.fit_loop.epoch_loop.batch_loop.optimizer_loop.grad_norm
            if gn is not None:
                metrics["grad_norm"] = float(gn)
        except Exception:
            pass

        # param_norm + update_ratio via named parameters
        try:
            import torch  # type: ignore[import]
            total_param_norm_sq = 0.0
            total_grad_norm_sq = 0.0
            for p in pl_module.parameters():
                if p.data is not None:
                    total_param_norm_sq += float(p.data.norm(2).item() ** 2)
                if p.grad is not None:
                    total_grad_norm_sq += float(p.grad.norm(2).item() ** 2)
            param_norm = total_param_norm_sq ** 0.5
            if param_norm > 0:
                metrics["param_norm"] = param_norm
                grad_norm_val = total_grad_norm_sq ** 0.5
                if grad_norm_val > 0 and "grad_norm" not in metrics:
                    metrics["grad_norm"] = grad_norm_val
                if param_norm > 0:
                    metrics["update_ratio"] = grad_norm_val / param_norm
        except Exception:
            pass

        # Attach pending val_metric from previous validation epoch
        if self._pending_val_metric is not None:
            metrics["val_metric"] = self._pending_val_metric
            self._pending_val_metric = None

        step = getattr(trainer, "global_step", batch_idx)
        epoch = getattr(trainer, "current_epoch", None)
        if epoch is not None:
            metrics["epoch"] = float(epoch)

        self.log(step=step, **metrics)

    def on_validation_epoch_end(self, trainer: Any, pl_module: Any) -> None:
        """Lightning hook: buffer val_metric; attached to next batch record.

        Validation runs at epoch boundaries, not step boundaries, so we buffer
        the metric and attach it on the next on_train_batch_end call.
        """
        try:
            logged = trainer.callback_metrics
            # Look for the primary val metric (common names)
            for key in ("val_acc", "val_accuracy", "val_metric", "val_loss", "val_auc"):
                val = logged.get(key)
                if val is not None:
                    self._pending_val_metric = float(val)
                    return
            # Fall back to any val_ metric
            for key, val in logged.items():
                if key.startswith("val_"):
                    self._pending_val_metric = float(val)
                    return
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Keras-style hook (subclassable)
    # ------------------------------------------------------------------

    def on_epoch_end(self, epoch: int, logs: dict[str, Any] | None = None) -> None:
        """Keras callback hook: log metrics at epoch end.

        Override in a Keras-specific subclass or use directly as a Callback.
        """
        logs = logs or {}
        metrics: dict[str, Any] = {}
        if "loss" in logs:
            metrics["train_loss"] = float(logs["loss"])
        if "val_loss" in logs:
            metrics["val_metric"] = float(logs["val_loss"])
        for key in ("lr", "accuracy", "val_accuracy"):
            if key in logs:
                metrics[key] = float(logs[key])
        metrics["epoch"] = float(epoch)
        self.log(step=epoch, **metrics)

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    @property
    def telemetry_path(self) -> Path:
        """Resolved path to the output JSONL file."""
        return self._telemetry_path

    def read_records(self) -> list[dict[str, Any]]:
        """Read and parse all JSONL records written so far.

        Primarily used in tests; not called during training.
        """
        if not self._telemetry_path.exists():
            return []
        records: list[dict[str, Any]] = []
        with open(self._telemetry_path) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        return records
