"""
Local Web Dashboard Monitor for YOLO Pose Training (OC4 Digital Twin).

Can be used in two modes:
1. Automatically attached to `YOLO` via callbacks during `train_yolo_pose.py`.
2. Standalone mode (`python utils/scripts/train/train_monitor_web.py`) to inspect
   live or historical training runs in `data/models/CV/pose` and optionally launch/stop
   training directly from the browser.
"""

import csv
import json
import os
import platform
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from datetime import datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import yaml
except ImportError:
    yaml = None

try:
    import torch
except ImportError:
    torch = None


# ---------------------------------------------------------------------------
# Global Monitor State
# ---------------------------------------------------------------------------

class TrainingMonitorState:
    def __init__(self, project_root: str):
        self.lock = threading.RLock()
        self.project_root = Path(project_root).resolve()
        self.models_dir = self.project_root / "data" / "models" / "CV" / "pose"

        # Live callback state
        self.status: str = "idle"  # idle | initializing | training | validating | completed | stopped | error
        self.mode: str = "standalone"  # callback | subprocess | standalone
        self.active_run_name: str = "train"
        self.save_dir: Optional[Path] = None

        self.start_time: Optional[float] = None
        self.end_time: Optional[float] = None
        self.epoch_start_time: Optional[float] = None

        self.current_epoch: int = 0
        self.total_epochs: int = 0
        self.current_batch: int = 0
        self.total_batches: int = 0

        # Live batch losses (updated every batch during an epoch)
        self.live_losses: Dict[str, float] = {
            "box_loss": 0.0,
            "pose_loss": 0.0,
            "kobj_loss": 0.0,
            "cls_loss": 0.0,
            "dfl_loss": 0.0,
            "rle_loss": 0.0,
        }

        # Timing tracking
        self.epoch_durations: List[float] = []
        self.batch_ema_sec: Optional[float] = None
        self.last_batch_ts: Optional[float] = None

        # Early stopping / Patience
        self.patience: int = 50
        self.best_epoch: int = 0
        self.best_fitness: float = 0.0
        self.best_map50_p: float = 0.0
        self.best_map50_95_p: float = 0.0

        # Hardware / System info
        self.device_name: str = self._detect_device()
        self.gpu_mem_gb: float = 0.0
        self.gpu_reserved_gb: float = 0.0

        # Config summary
        self.config_info: Dict[str, Any] = {}
        self.logs: List[str] = []
        self.max_logs: int = 400

        # Subprocess handle (when started from standalone UI)
        self.subprocess_proc: Optional[subprocess.Popen] = None
        self.stop_requested: bool = False

        # Cache for CSV reading
        self._csv_cache: Dict[str, Any] = {"path": None, "mtime": 0.0, "rows": []}

        # Discover default run directory if available
        self._discover_default_run()

    def _detect_device(self) -> str:
        if torch is not None:
            try:
                if torch.cuda.is_available():
                    return f"CUDA ({torch.cuda.get_device_name(0)})"
                if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                    return f"Apple Silicon MPS ({platform.processor() or 'M-Series'})"
            except Exception:
                pass
        return f"CPU ({platform.machine()})"

    def _discover_default_run(self) -> None:
        if not self.models_dir.exists():
            return
        runs = self.list_runs()
        if runs:
            # Prefer 'train' if it exists, otherwise the most recently modified run
            best = max(runs, key=lambda r: r["mtime"])
            self.active_run_name = best["name"]
            self.save_dir = self.models_dir / best["name"]

    def list_runs(self) -> List[Dict[str, Any]]:
        if not self.models_dir.exists():
            return []
        runs = []
        for d in sorted(self.models_dir.iterdir()):
            if d.is_dir():
                csv_file = d / "results.csv"
                args_file = d / "args.yaml"
                mtime = csv_file.stat().st_mtime if csv_file.exists() else d.stat().st_mtime
                runs.append({
                    "name": d.name,
                    "path": str(d),
                    "has_csv": csv_file.exists(),
                    "has_args": args_file.exists(),
                    "mtime": mtime,
                    "updated_at": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S"),
                })
        return runs

    def add_log(self, msg: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        with self.lock:
            self.logs.append(f"[{ts}] {msg}")
            if len(self.logs) > self.max_logs:
                self.logs = self.logs[-self.max_logs:]

    def select_run(self, run_name: str) -> bool:
        target = (self.models_dir / run_name).resolve()
        if not str(target).startswith(str(self.models_dir.resolve())) or not target.is_dir():
            return False
        with self.lock:
            self.active_run_name = run_name
            self.save_dir = target
            self._csv_cache = {"path": None, "mtime": 0.0, "rows": []}
        return True

    def _read_csv_rows(self, run_dir: Optional[Path]) -> List[Dict[str, float]]:
        if not run_dir:
            return []
        csv_path = run_dir / "results.csv"
        if not csv_path.exists():
            return []
        try:
            mtime = csv_path.stat().st_mtime
            if self._csv_cache["path"] == str(csv_path) and self._csv_cache["mtime"] == mtime:
                return self._csv_cache["rows"]

            rows: List[Dict[str, float]] = []
            with open(csv_path, "r", encoding="utf-8", errors="replace") as f:
                reader = csv.DictReader(f)
                for raw_row in reader:
                    clean_row: Dict[str, float] = {}
                    for k, v in raw_row.items():
                        if k is None or v is None:
                            continue
                        k_clean = k.strip()
                        v_clean = v.strip()
                        try:
                            clean_row[k_clean] = float(v_clean)
                        except ValueError:
                            pass
                    if "epoch" in clean_row:
                        rows.append(clean_row)

            self._csv_cache = {"path": str(csv_path), "mtime": mtime, "rows": rows}
            return rows
        except Exception:
            return self._csv_cache.get("rows", [])

    def _read_args_yaml(self, run_dir: Optional[Path]) -> Dict[str, Any]:
        if not run_dir or yaml is None:
            return {}
        args_path = run_dir / "args.yaml"
        if not args_path.exists():
            return {}
        try:
            with open(args_path, "r", encoding="utf-8", errors="replace") as f:
                data = yaml.safe_load(f) or {}
                return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _read_train_config(self) -> Dict[str, Any]:
        if yaml is None:
            return {}
        cfg_path = self.project_root / "utils" / "scripts" / "train" / "config" / "train.yaml"
        if not cfg_path.exists():
            return {}
        try:
            with open(cfg_path, "r", encoding="utf-8", errors="replace") as f:
                return yaml.safe_load(f) or {}
        except Exception:
            return {}

    def get_artifacts(self, run_dir: Optional[Path]) -> List[Dict[str, Any]]:
        if not run_dir or not run_dir.exists():
            return []
        priority_order = [
            "val_batch0_pred.jpg", "val_batch0_labels.jpg",
            "val_batch1_pred.jpg", "val_batch1_labels.jpg",
            "val_batch2_pred.jpg", "val_batch2_labels.jpg",
            "PosePR_curve.png", "PoseF1_curve.png", "PoseP_curve.png", "PoseR_curve.png",
            "BoxPR_curve.png", "BoxF1_curve.png",
            "confusion_matrix_normalized.png", "confusion_matrix.png",
            "results.png", "labels.jpg",
            "train_batch0.jpg", "train_batch1.jpg", "train_batch2.jpg",
        ]
        found = {}
        for p in run_dir.iterdir():
            if p.is_file() and p.suffix.lower() in (".png", ".jpg", ".jpeg"):
                found[p.name] = {
                    "name": p.name,
                    "url": f"/api/artifact?run={urllib.parse.quote(run_dir.name)}&file={urllib.parse.quote(p.name)}&t={int(p.stat().st_mtime)}",
                    "mtime": p.stat().st_mtime,
                }
        ordered = []
        for name in priority_order:
            if name in found:
                ordered.append(found.pop(name))
        for name in sorted(found.keys()):
            ordered.append(found[name])
        return ordered

    def build_snapshot(self) -> Dict[str, Any]:
        with self.lock:
            run_dir = self.save_dir or (self.models_dir / self.active_run_name)
            csv_rows = self._read_csv_rows(run_dir)
            args_data = self._read_args_yaml(run_dir)
            train_yaml = self._read_train_config()
            cfg_block = train_yaml.get("config", {}) if isinstance(train_yaml, dict) else {}

            total_epochs = (
                self.total_epochs
                or int(args_data.get("epochs", 0) or 0)
                or int(cfg_block.get("epochs", 100) or 100)
            )
            patience = (
                self.patience
                or int(args_data.get("patience", 0) or 0)
                or int(cfg_block.get("patience", 50) or 50)
            )

            completed_epochs = len(csv_rows)
            last_csv_epoch = int(csv_rows[-1]["epoch"]) if csv_rows else 0

            is_active = self.status in ("initializing", "training", "validating")
            if is_active:
                display_epoch = max(self.current_epoch, last_csv_epoch)
            else:
                display_epoch = last_csv_epoch or self.current_epoch
                if csv_rows and total_epochs == 0:
                    total_epochs = max(last_csv_epoch, 100)

            # Calculate best metrics & early stopping patience from CSV
            best_epoch = 0
            best_map50_p = 0.0
            best_map50_95_p = 0.0
            best_map50_b = 0.0
            best_map50_95_b = 0.0
            best_fitness = -1.0

            for r in csv_rows:
                ep = int(r.get("epoch", 0))
                mp50 = r.get("metrics/mAP50(P)", 0.0)
                mp95 = r.get("metrics/mAP50-95(P)", 0.0)
                mb50 = r.get("metrics/mAP50(B)", 0.0)
                mb95 = r.get("metrics/mAP50-95(B)", 0.0)
                # Standard Ultralytics Pose fitness: 0.1 * mAP50 + 0.9 * mAP50-95 (Pose + Box)
                fitness = 0.1 * mp50 + 0.9 * mp95
                if fitness >= best_fitness:
                    best_fitness = fitness
                    best_epoch = ep
                    best_map50_p = mp50
                    best_map50_95_p = mp95
                    best_map50_b = mb50
                    best_map50_95_b = mb95

            epochs_since_best = max(0, last_csv_epoch - best_epoch) if last_csv_epoch > 0 else 0

            # Progress calculation (combines epoch + intra-epoch batch progress)
            batch_frac = (self.current_batch / self.total_batches) if self.total_batches > 0 else 0.0
            if is_active and self.current_epoch > 0:
                effective_done = (self.current_epoch - 1) + batch_frac
            else:
                effective_done = float(display_epoch)

            overall_pct = min(100.0, max(0.0, (effective_done / total_epochs) * 100.0)) if total_epochs > 0 else 0.0
            batch_pct = min(100.0, max(0.0, batch_frac * 100.0))

            # Timing & ETA calculation
            now = time.time()
            if is_active and self.start_time:
                elapsed_sec = now - self.start_time
            elif self.start_time and self.end_time:
                elapsed_sec = self.end_time - self.start_time
            elif csv_rows and "time" in csv_rows[-1]:
                elapsed_sec = float(csv_rows[-1]["time"])
            else:
                elapsed_sec = 0.0

            # Epoch duration estimation
            avg_epoch_sec = 0.0
            if len(self.epoch_durations) > 0:
                recent = self.epoch_durations[-10:]
                avg_epoch_sec = sum(recent) / len(recent)
            elif len(csv_rows) >= 2 and "time" in csv_rows[-1]:
                diffs = []
                for i in range(1, len(csv_rows)):
                    dt = csv_rows[i].get("time", 0.0) - csv_rows[i - 1].get("time", 0.0)
                    if dt > 0:
                        diffs.append(dt)
                if diffs:
                    recent = diffs[-10:]
                    avg_epoch_sec = sum(recent) / len(recent)
            elif len(csv_rows) == 1 and "time" in csv_rows[0]:
                avg_epoch_sec = float(csv_rows[0]["time"])
            elif self.batch_ema_sec and self.total_batches > 0:
                avg_epoch_sec = self.batch_ema_sec * self.total_batches

            eta_sec: Optional[float] = None
            eta_finish_str: str = "--:--:--"
            if is_active and total_epochs > 0:
                remaining_epochs = max(0.0, total_epochs - effective_done)
                if avg_epoch_sec > 0:
                    eta_sec = remaining_epochs * avg_epoch_sec
                    finish_dt = datetime.now() + timedelta(seconds=eta_sec)
                    eta_finish_str = finish_dt.strftime("%H:%M:%S")

            # Latest metrics snapshot
            latest_row = csv_rows[-1] if csv_rows else {}

            # Config summary
            config_summary = {
                "model": self.config_info.get("model") or args_data.get("model") or cfg_block.get("model", "YOLO-Pose"),
                "imgsz": self.config_info.get("imgsz") or args_data.get("imgsz") or cfg_block.get("imgsz", 640),
                "batch": self.config_info.get("batch") or args_data.get("batch") or cfg_block.get("batch_size", 16),
                "lr0": self.config_info.get("lr0") or args_data.get("lr0") or cfg_block.get("lr0", 0.01),
                "pose_weight": self.config_info.get("pose") or args_data.get("pose") or cfg_block.get("pose", 20.0),
                "kobj_weight": self.config_info.get("kobj") or args_data.get("kobj") or cfg_block.get("kobj", 2.0),
                "kpt_shape": cfg_block.get("kpt_shape", [14, 3]),
                "optimizer": args_data.get("optimizer", "auto"),
                "cos_lr": args_data.get("cos_lr", cfg_block.get("cos_lr", True)),
                "device": self.device_name,
                "save_dir": str(run_dir) if run_dir else "",
            }

            return {
                "status": self.status,
                "mode": self.mode,
                "active_run": self.active_run_name,
                "runs": self.list_runs(),
                "progress": {
                    "current_epoch": display_epoch,
                    "total_epochs": total_epochs,
                    "current_batch": self.current_batch,
                    "total_batches": self.total_batches,
                    "overall_pct": round(overall_pct, 2),
                    "batch_pct": round(batch_pct, 1),
                },
                "timing": {
                    "elapsed_sec": round(elapsed_sec, 1),
                    "elapsed_str": _fmt_duration(elapsed_sec),
                    "eta_sec": round(eta_sec, 1) if eta_sec is not None else None,
                    "eta_str": _fmt_duration(eta_sec) if eta_sec is not None else ("Calculando..." if is_active else "Finalizado" if csv_rows else "--:--:--"),
                    "eta_finish_clock": eta_finish_str,
                    "avg_epoch_sec": round(avg_epoch_sec, 2),
                    "batch_ms": round(self.batch_ema_sec * 1000.0, 1) if self.batch_ema_sec else None,
                    "batches_per_sec": round(1.0 / self.batch_ema_sec, 2) if self.batch_ema_sec and self.batch_ema_sec > 0 else None,
                },
                "patience": {
                    "limit": patience,
                    "epochs_since_best": epochs_since_best,
                    "best_epoch": best_epoch,
                    "best_map50_p": round(best_map50_p, 4),
                    "best_map50_95_p": round(best_map50_95_p, 4),
                    "best_map50_b": round(best_map50_b, 4),
                    "best_map50_95_b": round(best_map50_95_b, 4),
                },
                "hardware": {
                    "device": self.device_name,
                    "gpu_mem_gb": round(self.gpu_mem_gb, 2),
                    "gpu_reserved_gb": round(self.gpu_reserved_gb, 2),
                },
                "live_losses": self.live_losses,
                "latest": latest_row,
                "history": csv_rows,
                "config": config_summary,
                "artifacts": self.get_artifacts(run_dir),
                "logs": self.logs[-120:],
            }


def _fmt_duration(seconds: Optional[float]) -> str:
    if seconds is None or seconds < 0:
        return "--:--:--"
    total_sec = int(round(seconds))
    hrs, rem = divmod(total_sec, 3600)
    mins, secs = divmod(rem, 60)
    if hrs > 0:
        return f"{hrs:02d}h {mins:02d}m {secs:02d}s"
    return f"{mins:02d}m {secs:02d}s"


# ---------------------------------------------------------------------------
# Ultralytics YOLO Callback Integration
# ---------------------------------------------------------------------------

def attach_yolo_callbacks(model: Any, state: TrainingMonitorState) -> None:
    """Registers real-time Ultralytics YOLO callbacks onto a YOLO model instance."""

    def on_pretrain_routine_start(trainer: Any) -> None:
        with state.lock:
            state.status = "initializing"
            state.mode = "callback"
            state.start_time = time.time()
            state.end_time = None
            state.stop_requested = False
            state.epoch_durations.clear()
            state.batch_ema_sec = None
            if hasattr(trainer, "save_dir") and trainer.save_dir:
                state.save_dir = Path(trainer.save_dir)
                state.active_run_name = state.save_dir.name
            if hasattr(trainer, "epochs"):
                state.total_epochs = int(trainer.epochs)
            if hasattr(trainer, "args"):
                state.patience = int(getattr(trainer.args, "patience", 50) or 50)
                state.config_info = {
                    "model": str(getattr(trainer.args, "model", "")),
                    "imgsz": getattr(trainer.args, "imgsz", 640),
                    "batch": getattr(trainer.args, "batch", 16),
                    "lr0": getattr(trainer.args, "lr0", 0.01),
                    "pose": getattr(trainer.args, "pose", 20.0),
                    "kobj": getattr(trainer.args, "kobj", 1.0),
                }
        state.add_log(f"Inicializando entrenamiento YOLO Pose ({state.total_epochs} épocas)...")

    def on_train_start(trainer: Any) -> None:
        with state.lock:
            state.status = "training"
            state.start_time = state.start_time or time.time()
            if hasattr(trainer, "save_dir") and trainer.save_dir:
                state.save_dir = Path(trainer.save_dir)
                state.active_run_name = state.save_dir.name
        state.add_log(f"Entrenamiento iniciado. Guardando en: {state.save_dir}")

    def on_train_epoch_start(trainer: Any) -> None:
        with state.lock:
            state.status = "training"
            state.epoch_start_time = time.time()
            state.last_batch_ts = time.time()
            state.current_epoch = int(getattr(trainer, "epoch", 0)) + 1
            state.total_epochs = int(getattr(trainer, "epochs", state.total_epochs))
            state.current_batch = 0
            try:
                state.total_batches = len(trainer.train_loader)
            except Exception:
                pass
        state.add_log(f"Época {state.current_epoch}/{state.total_epochs} iniciada ({state.total_batches} batches).")

    def on_train_batch_end(trainer: Any) -> None:
        now = time.time()
        with state.lock:
            state.current_batch += 1
            if state.last_batch_ts is not None:
                dt = max(1e-4, now - state.last_batch_ts)
                if state.batch_ema_sec is None:
                    state.batch_ema_sec = dt
                else:
                    state.batch_ema_sec = 0.85 * state.batch_ema_sec + 0.15 * dt
            state.last_batch_ts = now

            # Extract live loss items (tloss) from trainer
            try:
                tloss = getattr(trainer, "tloss", None)
                loss_names = getattr(trainer, "loss_names", ["box_loss", "pose_loss", "kobj_loss", "cls_loss", "dfl_loss", "rle_loss"])
                if tloss is not None:
                    vals = tloss.detach().cpu().tolist() if hasattr(tloss, "detach") else list(tloss)
                    if isinstance(vals, (int, float)):
                        vals = [vals]
                    for name, val in zip(loss_names, vals):
                        state.live_losses[str(name)] = round(float(val), 5)
            except Exception:
                pass

            # Update GPU memory usage if available
            if torch is not None and torch.cuda.is_available():
                try:
                    state.gpu_mem_gb = torch.cuda.memory_allocated(0) / (1024 ** 3)
                    state.gpu_reserved_gb = torch.cuda.memory_reserved(0) / (1024 ** 3)
                except Exception:
                    pass

            if state.stop_requested:
                trainer.stop = True

    def on_train_epoch_end(trainer: Any) -> None:
        now = time.time()
        with state.lock:
            state.status = "validating"
            if state.epoch_start_time:
                dur = now - state.epoch_start_time
                if dur > 0:
                    state.epoch_durations.append(dur)

    def on_fit_epoch_end(trainer: Any) -> None:
        with state.lock:
            ep = int(getattr(trainer, "epoch", 0)) + 1
            metrics = getattr(trainer, "metrics", {}) or {}
            mp50 = metrics.get("metrics/mAP50(P)", 0.0)
            mp95 = metrics.get("metrics/mAP50-95(P)", 0.0)
            box_l = state.live_losses.get("box_loss", 0.0)
            pose_l = state.live_losses.get("pose_loss", 0.0)
        state.add_log(
            f"Época {ep}/{state.total_epochs} completada | "
            f"pose_loss: {pose_l:.4f} | box_loss: {box_l:.4f} | "
            f"mAP50(Pose): {mp50:.4f} | mAP50-95(Pose): {mp95:.4f}"
        )

    def on_train_end(trainer: Any) -> None:
        with state.lock:
            state.status = "stopped" if state.stop_requested else "completed"
            state.end_time = time.time()
            state.current_batch = state.total_batches
        state.add_log("Entrenamiento finalizado con éxito.")

    model.add_callback("on_pretrain_routine_start", on_pretrain_routine_start)
    model.add_callback("on_train_start", on_train_start)
    model.add_callback("on_train_epoch_start", on_train_epoch_start)
    model.add_callback("on_train_batch_end", on_train_batch_end)
    model.add_callback("on_train_epoch_end", on_train_epoch_end)
    model.add_callback("on_fit_epoch_end", on_fit_epoch_end)
    model.add_callback("on_train_end", on_train_end)


# ---------------------------------------------------------------------------
# Subprocess Launcher (when started from Standalone Web UI)
# ---------------------------------------------------------------------------

def start_training_subprocess(state: TrainingMonitorState) -> Dict[str, Any]:
    with state.lock:
        if state.status in ("initializing", "training", "validating"):
            return {"ok": False, "error": "Ya hay un entrenamiento en curso."}

        script_path = state.project_root / "utils" / "scripts" / "train" / "train_yolo_pose.py"
        if not script_path.exists():
            return {"ok": False, "error": f"No se encontró el script en {script_path}"}

        state.status = "initializing"
        state.mode = "subprocess"
        state.start_time = time.time()
        state.end_time = None
        state.current_epoch = 0
        state.current_batch = 0
        state.stop_requested = False
        state.epoch_durations.clear()
        state.logs.clear()

    state.add_log(f"Lanzando subproceso: {sys.executable} {script_path}")

    def _reader() -> None:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["YOLO_MONITOR_EXTERNAL"] = "1"  # Tell child script not to spin up a duplicate server
        try:
            proc = subprocess.Popen(
                [sys.executable, str(script_path)],
                cwd=str(state.project_root),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                encoding="utf-8",
                errors="replace",
                env=env,
            )
            with state.lock:
                state.subprocess_proc = proc
                state.status = "training"

            buffer = ""
            while True:
                ch = proc.stdout.read(1) if proc.stdout else ""
                if not ch:
                    break
                if ch in ("\r", "\n"):
                    line = buffer.strip()
                    buffer = ""
                    if line:
                        _parse_console_line(state, line)
                else:
                    buffer += ch

            proc.wait()
            with state.lock:
                if state.stop_requested:
                    state.status = "stopped"
                    state.add_log("Entrenamiento detenido por el usuario.")
                elif proc.returncode == 0:
                    state.status = "completed"
                    state.add_log("Entrenamiento finalizado correctamente.")
                else:
                    state.status = "error"
                    state.add_log(f"El proceso terminó con código de salida {proc.returncode}.")
                state.end_time = time.time()
        except Exception as exc:
            with state.lock:
                state.status = "error"
                state.end_time = time.time()
            state.add_log(f"Error al ejecutar el entrenamiento: {exc}")

    threading.Thread(target=_reader, daemon=True).start()
    return {"ok": True}


def stop_training(state: TrainingMonitorState) -> Dict[str, Any]:
    with state.lock:
        state.stop_requested = True
        proc = state.subprocess_proc
    state.add_log("Solicitud de parada enviada (se detendrá al finalizar el batch/proceso)...")
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
    return {"ok": True}


def _parse_console_line(state: TrainingMonitorState, line: str) -> None:
    import re
    # Clean ANSI escape codes
    clean = re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", line).strip()
    if not clean:
        return

    # Match YOLO progress bar: e.g. "     15/100      4.21G      1.052      2.891      0.088 ... 45% ━━━ 18/40"
    m_ep = re.match(r"^(\d+)/(\d+)\s+([0-9.]+)G\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)", clean)
    if m_ep:
        with state.lock:
            state.current_epoch = int(m_ep.group(1))
            state.total_epochs = int(m_ep.group(2))
            state.gpu_reserved_gb = float(m_ep.group(3))
            state.live_losses["box_loss"] = float(m_ep.group(4))
            state.live_losses["pose_loss"] = float(m_ep.group(5))
            state.live_losses["kobj_loss"] = float(m_ep.group(6))
            state.live_losses["cls_loss"] = float(m_ep.group(7))
            state.live_losses["dfl_loss"] = float(m_ep.group(8))
            m_batch = re.search(r"(\d+)/(\d+)\s+\[", clean) or re.search(r"\s(\d+)/(\d+)\s+[0-9.]+it/s", clean)
            if m_batch:
                state.current_batch = int(m_batch.group(1))
                state.total_batches = int(m_batch.group(2))
        return

    state.add_log(clean)


# ---------------------------------------------------------------------------
# Embedded HTML/CSS/JS Frontend (Single-Page Local Dashboard)
# ---------------------------------------------------------------------------

DASHBOARD_HTML = r"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>OC4 Digital Twin — YOLO Pose Training Monitor</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg-main: #0b0f19;
    --bg-card: #111827;
    --bg-card-alt: #1e293b;
    --border: #1f2937;
    --text-main: #f3f4f6;
    --text-muted: #9ca3af;
    --accent: #38bdf8;
    --accent-indigo: #818cf8;
    --success: #10b981;
    --warning: #f59e0b;
    --danger: #ef4444;
    --purple: #c084fc;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    background: var(--bg-main);
    color: var(--text-main);
    line-height: 1.5;
    padding: 18px 24px 40px;
  }

  /* Header */
  .topbar {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 18px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brand-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: linear-gradient(135deg, #0284c7, #6366f1);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    font-size: 16px;
    letter-spacing: 0.5px;
    box-shadow: 0 4px 14px rgba(56, 189, 248, 0.25);
  }
  .brand h1 {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }
  .brand p {
    font-size: 12px;
    color: var(--text-muted);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 13px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 600;
    background: var(--bg-card-alt);
    border: 1px solid var(--border);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .dot.active {
    background: var(--success);
    box-shadow: 0 0 8px var(--success);
    animation: pulse 1.5s infinite;
  }
  .dot.completed { background: var(--accent); }
  .dot.error { background: var(--danger); }

  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.3); opacity: 0.65; }
  }

  select, button {
    background: var(--bg-card-alt);
    color: var(--text-main);
    border: 1px solid #334155;
    padding: 7px 12px;
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  select:hover, button:hover { border-color: var(--accent); }
  .btn-start {
    background: linear-gradient(135deg, #059669, #10b981);
    border: none;
    font-weight: 600;
  }
  .btn-start:hover { opacity: 0.92; }
  .btn-stop {
    background: rgba(239, 68, 68, 0.15);
    color: #fca5a5;
    border-color: rgba(239, 68, 68, 0.4);
    font-weight: 600;
  }
  .btn-stop:hover { background: rgba(239, 68, 68, 0.28); }

  /* Progress Banner */
  .progress-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 18px;
  }
  .progress-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 8px;
  }
  .progress-title {
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .progress-stats {
    font-size: 13px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .bar-track {
    width: 100%;
    height: 11px;
    background: #1e293b;
    border-radius: 999px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .bar-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #0284c7, #38bdf8, #818cf8);
    border-radius: 999px;
    transition: width 0.35s ease;
  }
  .subbar-track {
    width: 100%;
    height: 5px;
    background: #1e293b;
    border-radius: 999px;
    overflow: hidden;
  }
  .subbar-fill {
    height: 100%;
    width: 0%;
    background: var(--success);
    transition: width 0.25s ease;
  }

  /* KPI Grid */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(205px, 1fr));
    gap: 14px;
    margin-bottom: 18px;
  }
  .kpi-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
    position: relative;
    overflow: hidden;
  }
  .kpi-label {
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .kpi-value {
    font-size: 24px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.5px;
  }
  .kpi-sub {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    font-variant-numeric: tabular-nums;
  }
  .text-cyan { color: var(--accent); }
  .text-green { color: var(--success); }
  .text-amber { color: var(--warning); }
  .text-purple { color: var(--purple); }
  .text-indigo { color: var(--accent-indigo); }

  /* Charts Grid */
  .charts-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
    margin-bottom: 18px;
  }
  @media (max-width: 1024px) {
    .charts-grid { grid-template-columns: 1fr; }
  }
  .chart-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
  }
  .chart-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .chart-title {
    font-size: 14px;
    font-weight: 600;
  }
  .chart-subtitle {
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .chart-container {
    position: relative;
    height: 255px;
    width: 100%;
  }

  /* Bottom Section: Config, Artifacts & Console */
  .bottom-grid {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 16px;
    margin-bottom: 18px;
  }
  @media (max-width: 1024px) {
    .bottom-grid { grid-template-columns: 1fr; }
  }
  .panel-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
  }
  .panel-title {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .kv-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12.5px;
  }
  .kv-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px dashed rgba(255,255,255,0.05);
    padding-bottom: 5px;
  }
  .kv-key { color: var(--text-muted); }
  .kv-val { font-weight: 600; text-align: right; word-break: break-all; }

  /* Artifacts Gallery */
  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 12px;
    max-height: 410px;
    overflow-y: auto;
    padding-right: 4px;
  }
  .artifact-item {
    background: var(--bg-card-alt);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    transition: transform 0.15s ease, border-color 0.15s ease;
  }
  .artifact-item:hover {
    transform: translateY(-2px);
    border-color: var(--accent);
  }
  .artifact-item img {
    width: 100%;
    height: 140px;
    object-fit: cover;
    display: block;
    background: #000;
  }
  .artifact-caption {
    padding: 6px 10px;
    font-size: 11.5px;
    font-weight: 500;
    color: var(--text-main);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Console Log */
  .console-box {
    background: #070a12;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    height: 190px;
    overflow-y: auto;
    font-family: "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace;
    font-size: 11.5px;
    color: #cbd5e1;
    white-space: pre-wrap;
  }

  /* Lightbox Modal */
  .modal {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 1000;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .modal.open { display: flex; }
  .modal img {
    max-width: 92vw;
    max-height: 88vh;
    border-radius: 8px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.8);
  }
</style>
</head>
<body>

  <!-- Top Bar -->
  <header class="topbar">
    <div class="brand">
      <div class="brand-icon">OC4</div>
      <div>
        <h1>YOLO Pose Training Monitor</h1>
        <p>OC4 Floating Wind Turbine Digital Twin &bull; 14 Keypoints PnP Pose Estimation</p>
      </div>
    </div>

    <div class="controls">
      <div class="status-pill">
        <span id="statusDot" class="dot"></span>
        <span id="statusText">Conectando...</span>
      </div>

      <label style="font-size:12px;color:var(--text-muted);">Run:</label>
      <select id="runSelector" onchange="changeRun(this.value)"></select>

      <button id="btnStart" class="btn-start" onclick="startTraining()">&#9654; Iniciar Entreno</button>
      <button id="btnStop" class="btn-stop" onclick="stopTraining()" style="display:none;">&#9632; Detener</button>
    </div>
  </header>

  <!-- Progress Card -->
  <section class="progress-card">
    <div class="progress-row">
      <div class="progress-title">
        <span>Progreso Global del Entrenamiento</span>
        <span id="epochBadge" style="color:var(--accent);">Época 0 / 0</span>
      </div>
      <div class="progress-stats">
        <span id="overallPct">0.0%</span> &bull;
        Transcurrido: <strong id="elapsedStr" style="color:var(--text-main);">00m 00s</strong> &bull;
        Restante (ETA): <strong id="etaStr" style="color:var(--accent);">--:--:--</strong>
        (<span id="etaClock">--:--:--</span>)
      </div>
    </div>
    <div class="bar-track">
      <div id="overallBar" class="bar-fill"></div>
    </div>
    <div class="progress-row" style="margin-bottom:4px;font-size:12px;color:var(--text-muted);">
      <span id="batchText">Batch en época actual: 0 / 0</span>
      <span id="speedText">Velocidad: -- s/época</span>
    </div>
    <div class="subbar-track">
      <div id="batchBar" class="subbar-fill"></div>
    </div>
  </section>

  <!-- KPI Cards -->
  <section class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">Tiempo Restante (ETA)</div>
      <div id="kpiEta" class="kpi-value text-cyan">--:--:--</div>
      <div id="kpiEtaSub" class="kpi-sub">Fin estimado: --:--:--</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">mAP50 / mAP50-95 (Pose OKS)</div>
      <div id="kpiMapPose" class="kpi-value text-green">0.000 / 0.000</div>
      <div id="kpiMapPoseBest" class="kpi-sub">Mejor mAP50-95(P): 0.0000 (Época 0)</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">mAP50 / mAP50-95 (BBox)</div>
      <div id="kpiMapBox" class="kpi-value text-indigo">0.000 / 0.000</div>
      <div id="kpiPRPose" class="kpi-sub">Pose P: 0.000 | R: 0.000</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">Pose &amp; Keypoint Loss</div>
      <div id="kpiPoseLoss" class="kpi-value text-amber">0.0000</div>
      <div id="kpiSubLoss" class="kpi-sub">Box: 0.0000 | KObj: 0.0000</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">Paciencia (Early Stopping)</div>
      <div id="kpiPatience" class="kpi-value text-purple">0 / 50</div>
      <div id="kpiPatienceSub" class="kpi-sub">Épocas sin mejorar desde época 0</div>
    </div>

    <div class="kpi-card">
      <div class="kpi-label">Learning Rate &amp; Hardware</div>
      <div id="kpiLr" class="kpi-value" style="font-size:20px;">0.00000</div>
      <div id="kpiHw" class="kpi-sub">Dispositivo: --</div>
    </div>
  </section>

  <!-- Interactive Charts -->
  <section class="charts-grid">
    <div class="chart-card">
      <div class="chart-header">
        <div>
          <div class="chart-title">Precisión de Pose (Keypoints OKS mAP)</div>
          <div class="chart-subtitle">Crítico para localización de los 14 puntos estructurales y PnP 6DoF</div>
        </div>
      </div>
      <div class="chart-container"><canvas id="chartPoseMap"></canvas></div>
    </div>

    <div class="chart-card">
      <div class="chart-header">
        <div>
          <div class="chart-title">Pérdidas de Entrenamiento vs Validación (Pose &amp; Box)</div>
          <div class="chart-subtitle">Monitorización de convergencia y detección de overfitting</div>
        </div>
      </div>
      <div class="chart-container"><canvas id="chartLosses"></canvas></div>
    </div>

    <div class="chart-card">
      <div class="chart-header">
        <div>
          <div class="chart-title">Desglose de Pérdidas (KObj, Cls, DFL, RLE)</div>
          <div class="chart-subtitle">Visibilidad de keypoints, clasificación y regresión residual</div>
        </div>
      </div>
      <div class="chart-container"><canvas id="chartDetailedLoss"></canvas></div>
    </div>

    <div class="chart-card">
      <div class="chart-header">
        <div>
          <div class="chart-title">Learning Rate (Cosine Annealing) &amp; Tiempo por Época</div>
          <div class="chart-subtitle">Evolución del scheduler lr/pg0 y segundos por época</div>
        </div>
      </div>
      <div class="chart-container"><canvas id="chartLrTime"></canvas></div>
    </div>
  </section>

  <!-- Bottom Grid: Config + Visual Artifacts -->
  <section class="bottom-grid">
    <div class="panel-card">
      <div class="panel-title">Configuración del Entrenamiento</div>
      <div id="configList" class="kv-list"></div>
    </div>

    <div class="panel-card">
      <div class="panel-title">Inspección Visual de Batches y Curvas (Click para ampliar)</div>
      <div id="galleryGrid" class="gallery-grid"></div>
    </div>
  </section>

  <!-- Console Logs -->
  <section class="panel-card">
    <div class="panel-title">Registro de Actividad en Tiempo Real</div>
    <div id="consoleBox" class="console-box">Esperando registros...</div>
  </section>

  <!-- Image Lightbox Modal -->
  <div id="imgModal" class="modal" onclick="this.classList.remove('open')">
    <img id="modalImg" src="" alt="Preview" />
  </div>

<script>
  Chart.defaults.color = '#9ca3af';
  Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.06)';
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  let chartPoseMap, chartLosses, chartDetailedLoss, chartLrTime;
  let lastGalleryKey = "";

  function makeChart(ctxId, datasets, yOptions = {}) {
    const ctx = document.getElementById(ctxId).getContext('2d');
    return new Chart(ctx, {
      type: 'line',
      data: { labels: [], datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, usePointStyle: true, font: { size: 11.5 } } }
        },
        scales: {
          x: { title: { display: true, text: 'Época', font: { size: 11 } } },
          ...yOptions
        }
      }
    });
  }

  function initCharts() {
    chartPoseMap = makeChart('chartPoseMap', [
      { label: 'mAP50-95 (Pose)', borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.12)', fill: true, tension: 0.25, pointRadius: 2, borderWidth: 2.2 },
      { label: 'mAP50 (Pose)', borderColor: '#38bdf8', tension: 0.25, pointRadius: 1.5, borderWidth: 2 },
      { label: 'Precision (Pose)', borderColor: '#a855f7', borderDash: [4,4], tension: 0.25, pointRadius: 0, borderWidth: 1.5 },
      { label: 'Recall (Pose)', borderColor: '#f59e0b', borderDash: [4,4], tension: 0.25, pointRadius: 0, borderWidth: 1.5 }
    ], {
      y: { min: 0, max: 1.0, title: { display: true, text: 'Score (0 - 1)' } }
    });

    chartLosses = makeChart('chartLosses', [
      { label: 'Train Pose Loss', borderColor: '#f59e0b', tension: 0.25, pointRadius: 1.5, borderWidth: 2 },
      { label: 'Val Pose Loss', borderColor: '#ef4444', borderDash: [5,3], tension: 0.25, pointRadius: 1.5, borderWidth: 2 },
      { label: 'Train Box Loss', borderColor: '#38bdf8', tension: 0.25, pointRadius: 1.5, borderWidth: 2 },
      { label: 'Val Box Loss', borderColor: '#818cf8', borderDash: [5,3], tension: 0.25, pointRadius: 1.5, borderWidth: 2 }
    ], {
      y: { title: { display: true, text: 'Loss' } }
    });

    chartDetailedLoss = makeChart('chartDetailedLoss', [
      { label: 'Train KObj Loss', borderColor: '#10b981', tension: 0.25, pointRadius: 1.5, borderWidth: 2 },
      { label: 'Val KObj Loss', borderColor: '#34d399', borderDash: [4,4], tension: 0.25, pointRadius: 0, borderWidth: 1.5 },
      { label: 'Train Cls Loss', borderColor: '#c084fc', tension: 0.25, pointRadius: 1.5, borderWidth: 2 },
      { label: 'Train RLE Loss', borderColor: '#fb7185', tension: 0.25, pointRadius: 1.5, borderWidth: 1.8 }
    ], {
      y: { title: { display: true, text: 'Loss' } }
    });

    chartLrTime = makeChart('chartLrTime', [
      { label: 'Learning Rate (pg0)', borderColor: '#38bdf8', yAxisID: 'y', tension: 0.25, pointRadius: 1.5, borderWidth: 2 },
      { label: 'Segundos / Época', borderColor: '#f59e0b', yAxisID: 'y1', tension: 0.25, pointRadius: 1.5, borderWidth: 1.8 }
    ], {
      y: { type: 'linear', position: 'left', title: { display: true, text: 'LR' } },
      y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Segundos / Época' } }
    });
  }

  function statusLabel(status) {
    const map = {
      'idle': ['Inactivo (Histórico)', ''],
      'initializing': ['Inicializando modelo...', 'active'],
      'training': ['Entrenando en vivo', 'active'],
      'validating': ['Validando época...', 'active'],
      'completed': ['Entrenamiento Completado', 'completed'],
      'stopped': ['Detenido por el usuario', 'error'],
      'error': ['Error en proceso', 'error']
    };
    return map[status] || [status, ''];
  }

  async function pollState() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      renderDashboard(data);
    } catch (e) {
      document.getElementById('statusText').textContent = 'Servidor desconectado';
      document.getElementById('statusDot').className = 'dot error';
    }
  }

  function renderDashboard(d) {
    // Status & Buttons
    const [stText, dotCls] = statusLabel(d.status);
    document.getElementById('statusText').textContent = stText;
    document.getElementById('statusDot').className = 'dot ' + dotCls;

    const isRunning = ['initializing', 'training', 'validating'].includes(d.status);
    document.getElementById('btnStart').style.display = isRunning ? 'none' : 'inline-block';
    document.getElementById('btnStop').style.display = isRunning ? 'inline-block' : 'none';

    // Run Selector
    const sel = document.getElementById('runSelector');
    const runsKey = (d.runs || []).map(r => r.name).join(',') + '|' + d.active_run;
    if (sel.dataset.key !== runsKey) {
      sel.dataset.key = runsKey;
      sel.innerHTML = '';
      (d.runs || []).forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.name;
        opt.textContent = `${r.name} (${r.updated_at})`;
        if (r.name === d.active_run) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    // Progress & Timing
    const p = d.progress || {};
    const t = d.timing || {};
    document.getElementById('epochBadge').textContent = `Época ${p.current_epoch} / ${p.total_epochs}`;
    document.getElementById('overallPct').textContent = `${(p.overall_pct || 0).toFixed(1)}%`;
    document.getElementById('overallBar').style.width = `${p.overall_pct || 0}%`;
    document.getElementById('elapsedStr').textContent = t.elapsed_str || '--:--:--';
    document.getElementById('etaStr').textContent = t.eta_str || '--:--:--';
    document.getElementById('etaClock').textContent = t.eta_finish_clock ? `Fin est.: ${t.eta_finish_clock}` : '';

    if (p.total_batches > 0) {
      document.getElementById('batchText').textContent = `Batch en época actual: ${p.current_batch} / ${p.total_batches} (${p.batch_pct}%)`;
      document.getElementById('batchBar').style.width = `${p.batch_pct || 0}%`;
    } else {
      document.getElementById('batchText').textContent = isRunning ? 'Preparando batches...' : `Épocas registradas en CSV: ${(d.history || []).length}`;
      document.getElementById('batchBar').style.width = isRunning ? '0%' : '100%';
    }

    const speedParts = [];
    if (t.avg_epoch_sec > 0) speedParts.push(`${t.avg_epoch_sec.toFixed(1)} s/época`);
    if (t.batches_per_sec) speedParts.push(`${t.batches_per_sec} it/s`);
    document.getElementById('speedText').textContent = speedParts.length ? `Velocidad: ${speedParts.join(' • ')}` : 'Velocidad: --';

    // KPI Cards
    document.getElementById('kpiEta').textContent = t.eta_str || '--:--:--';
    document.getElementById('kpiEtaSub').textContent = t.avg_epoch_sec > 0
      ? `Media: ${t.avg_epoch_sec.toFixed(1)}s/época • Fin: ${t.eta_finish_clock}`
      : `Tiempo total: ${t.elapsed_str}`;

    const lat = d.latest || {};
    const pat = d.patience || {};
    const live = d.live_losses || {};

    const mp50 = lat['metrics/mAP50(P)'] ?? 0;
    const mp95 = lat['metrics/mAP50-95(P)'] ?? 0;
    document.getElementById('kpiMapPose').textContent = `${mp50.toFixed(3)} / ${mp95.toFixed(3)}`;
    document.getElementById('kpiMapPoseBest').textContent = `Mejor mAP50-95(P): ${(pat.best_map50_95_p || 0).toFixed(4)} (Época ${pat.best_epoch || 0})`;

    const mb50 = lat['metrics/mAP50(B)'] ?? 0;
    const mb95 = lat['metrics/mAP50-95(B)'] ?? 0;
    const pp = lat['metrics/precision(P)'] ?? 0;
    const rp = lat['metrics/recall(P)'] ?? 0;
    document.getElementById('kpiMapBox').textContent = `${mb50.toFixed(3)} / ${mb95.toFixed(3)}`;
    document.getElementById('kpiPRPose').textContent = `Pose Precision: ${pp.toFixed(3)} | Recall: ${rp.toFixed(3)}`;

    const poseLoss = (isRunning && live.pose_loss > 0) ? live.pose_loss : (lat['train/pose_loss'] ?? 0);
    const boxLoss = (isRunning && live.box_loss > 0) ? live.box_loss : (lat['train/box_loss'] ?? 0);
    const kobjLoss = (isRunning && live.kobj_loss > 0) ? live.kobj_loss : (lat['train/kobj_loss'] ?? 0);
    document.getElementById('kpiPoseLoss').textContent = poseLoss.toFixed(4);
    document.getElementById('kpiSubLoss').textContent = `Box: ${boxLoss.toFixed(4)} | KObj: ${kobjLoss.toFixed(4)}`;

    document.getElementById('kpiPatience').textContent = `${pat.epochs_since_best || 0} / ${pat.limit || 50}`;
    document.getElementById('kpiPatienceSub').textContent = `Mejor época: ${pat.best_epoch || 0} (mAP50(P): ${(pat.best_map50_p || 0).toFixed(4)})`;

    const lr0 = lat['lr/pg0'] ?? (d.config ? d.config.lr0 : 0) ?? 0;
    document.getElementById('kpiLr').textContent = Number(lr0).toFixed(6);
    const hw = d.hardware || {};
    const vramStr = hw.gpu_reserved_gb > 0 ? ` (${hw.gpu_reserved_gb.toFixed(2)} GB VRAM)` : '';
    document.getElementById('kpiHw').textContent = `${hw.device || '--'}${vramStr}`;

    // Update Charts
    const hist = d.history || [];
    if (hist.length > 0) {
      const labels = hist.map(r => r.epoch);

      chartPoseMap.data.labels = labels;
      chartPoseMap.data.datasets[0].data = hist.map(r => r['metrics/mAP50-95(P)'] ?? null);
      chartPoseMap.data.datasets[1].data = hist.map(r => r['metrics/mAP50(P)'] ?? null);
      chartPoseMap.data.datasets[2].data = hist.map(r => r['metrics/precision(P)'] ?? null);
      chartPoseMap.data.datasets[3].data = hist.map(r => r['metrics/recall(P)'] ?? null);
      chartPoseMap.update('none');

      chartLosses.data.labels = labels;
      chartLosses.data.datasets[0].data = hist.map(r => r['train/pose_loss'] ?? null);
      chartLosses.data.datasets[1].data = hist.map(r => r['val/pose_loss'] ?? null);
      chartLosses.data.datasets[2].data = hist.map(r => r['train/box_loss'] ?? null);
      chartLosses.data.datasets[3].data = hist.map(r => r['val/box_loss'] ?? null);
      chartLosses.update('none');

      chartDetailedLoss.data.labels = labels;
      chartDetailedLoss.data.datasets[0].data = hist.map(r => r['train/kobj_loss'] ?? null);
      chartDetailedLoss.data.datasets[1].data = hist.map(r => r['val/kobj_loss'] ?? null);
      chartDetailedLoss.data.datasets[2].data = hist.map(r => r['train/cls_loss'] ?? null);
      chartDetailedLoss.data.datasets[3].data = hist.map(r => r['train/rle_loss'] ?? null);
      chartDetailedLoss.update('none');

      const epTimes = hist.map((r, i) => {
        if (i === 0) return r.time || 0;
        const dt = (r.time || 0) - (hist[i - 1].time || 0);
        return dt > 0 ? dt : null;
      });
      chartLrTime.data.labels = labels;
      chartLrTime.data.datasets[0].data = hist.map(r => r['lr/pg0'] ?? null);
      chartLrTime.data.datasets[1].data = epTimes;
      chartLrTime.update('none');
    }

    // Config Panel
    const cfg = d.config || {};
    const cfgRows = [
      ['Modelo Base', String(cfg.model || '').split(/[\\/]/).pop()],
      ['Resolución (imgsz)', `${cfg.imgsz} px`],
      ['Batch Size', cfg.batch],
      ['Learning Rate Inicial', cfg.lr0],
      ['Cosine LR Schedule', cfg.cos_lr ? 'Activado' : 'Desactivado'],
      ['Peso Pose / Keypoints', `pose=${cfg.pose_weight} | kobj=${cfg.kobj_weight}`],
      ['Keypoints (kpt_shape)', Array.isArray(cfg.kpt_shape) ? cfg.kpt_shape.join(' × ') : '14 × 3'],
      ['Optimizador', cfg.optimizer],
      ['Dispositivo', cfg.device],
      ['Carpeta de Salida', d.active_run]
    ];
    document.getElementById('configList').innerHTML = cfgRows
      .map(([k, v]) => `<div class="kv-row"><span class="kv-key">${k}</span><span class="kv-val">${v ?? '--'}</span></div>`)
      .join('');

    // Artifacts Gallery
    const arts = d.artifacts || [];
    const galleryKey = arts.map(a => a.url).join('|');
    if (galleryKey !== lastGalleryKey) {
      lastGalleryKey = galleryKey;
      const g = document.getElementById('galleryGrid');
      if (arts.length === 0) {
        g.innerHTML = '<div style="color:var(--text-muted);font-size:12.5px;">Aún no hay imágenes generadas en este run.</div>';
      } else {
        g.innerHTML = arts.map(a => `
          <div class="artifact-item" onclick="openModal('${a.url}')">
            <img src="${a.url}" loading="lazy" alt="${a.name}" />
            <div class="artifact-caption" title="${a.name}">${a.name}</div>
          </div>
        `).join('');
      }
    }

    // Logs
    const logs = d.logs || [];
    const cbox = document.getElementById('consoleBox');
    if (logs.length > 0) {
      const wasAtBottom = (cbox.scrollHeight - cbox.scrollTop - cbox.clientHeight) < 40;
      cbox.textContent = logs.join('\n');
      if (wasAtBottom) cbox.scrollTop = cbox.scrollHeight;
    }
  }

  function openModal(url) {
    document.getElementById('modalImg').src = url;
    document.getElementById('imgModal').classList.add('open');
  }

  async function changeRun(runName) {
    await fetch('/api/select_run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run: runName })
    });
    pollState();
  }

  async function startTraining() {
    const res = await fetch('/api/start', { method: 'POST' });
    const data = await res.json();
    if (!data.ok && data.error) alert(data.error);
    pollState();
  }

  async function stopTraining() {
    if (!confirm('¿Seguro que deseas detener el entrenamiento en curso?')) return;
    await fetch('/api/stop', { method: 'POST' });
    pollState();
  }

  initCharts();
  pollState();
  setInterval(pollState, 1200);
</script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# HTTP Request Handler & Background Server
# ---------------------------------------------------------------------------

class MonitorRequestHandler(BaseHTTPRequestHandler):
    state: TrainingMonitorState = None  # Bound dynamically

    def log_message(self, format: str, *args: Any) -> None:
        # Suppress noisy HTTP access logs in the training console
        pass

    def _send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            raw = DASHBOARD_HTML.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        if parsed.path == "/api/status":
            self._send_json(self.state.build_snapshot())
            return

        if parsed.path == "/api/artifact":
            qs = urllib.parse.parse_qs(parsed.query)
            run_name = (qs.get("run") or [self.state.active_run_name])[0]
            file_name = (qs.get("file") or [""])[0]
            target_dir = (self.state.models_dir / run_name).resolve()
            target_file = (target_dir / file_name).resolve()

            if (
                not str(target_file).startswith(str(self.state.models_dir.resolve()))
                or not target_file.is_file()
            ):
                self.send_error(HTTPStatus.NOT_FOUND, "Artifact not found")
                return

            ctype = "image/png" if target_file.suffix.lower() == ".png" else "image/jpeg"
            data = target_file.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0) or 0)
        body_raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            body = json.loads(body_raw) if body_raw else {}
        except Exception:
            body = {}

        if parsed.path == "/api/select_run":
            ok = self.state.select_run(str(body.get("run", "")))
            self._send_json({"ok": ok})
            return

        if parsed.path == "/api/start":
            self._send_json(start_training_subprocess(self.state))
            return

        if parsed.path == "/api/stop":
            self._send_json(stop_training(self.state))
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")


def _find_available_port(preferred: int = 8765) -> int:
    for port in range(preferred, preferred + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return preferred


def start_monitor_server(
    project_root: str,
    port: int = 8765,
    open_browser: bool = True,
    daemon: bool = True,
) -> tuple[TrainingMonitorState, Optional[ThreadingHTTPServer], str]:
    """
    Starts the local web monitor server and returns (state, server, url).
    If YOLO_MONITOR_EXTERNAL=1 is set in env (launched from standalone UI),
    skips creating a duplicate server.
    """
    state = TrainingMonitorState(project_root=project_root)

    if os.environ.get("YOLO_MONITOR_EXTERNAL") == "1":
        return state, None, ""

    actual_port = _find_available_port(port)
    url = f"http://127.0.0.1:{actual_port}"

    class BoundHandler(MonitorRequestHandler):
        pass

    BoundHandler.state = state

    server = ThreadingHTTPServer(("127.0.0.1", actual_port), BoundHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=daemon)
    thread.start()

    banner = (
        "\n" + "=" * 72 + "\n"
        f"  [OC4 YOLO Pose Monitor] Interfaz web local activa en:\n"
        f"  👉  {url}\n"
        + "=" * 72 + "\n"
    )
    print(banner, flush=True)
    state.add_log(f"Servidor de monitorización iniciado en {url}")

    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    return state, server, url


# ---------------------------------------------------------------------------
# Standalone Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="OC4 Digital Twin — YOLO Pose Training Web Monitor")
    parser.add_argument("--port", type=int, default=8765, help="Puerto local para el servidor web (por defecto: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="No abrir el navegador automáticamente")
    parser.add_argument("--auto-start", action="store_true", help="Iniciar el entrenamiento automáticamente al abrir")
    args = parser.parse_args()

    # Resolve project root (3 levels up from utils/scripts/train/)
    default_root = Path(__file__).resolve().parents[3]
    state, srv, url = start_monitor_server(
        project_root=str(default_root),
        port=args.port,
        open_browser=not args.no_browser,
        daemon=False,
    )

    if args.auto_start:
        start_training_subprocess(state)

    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\nCerrando monitor de entrenamiento...")
        if srv:
            srv.shutdown()
