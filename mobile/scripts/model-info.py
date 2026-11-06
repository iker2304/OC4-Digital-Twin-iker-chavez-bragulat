#!/usr/bin/env python3
"""Genera el resumen de cada modelo entrenado para `/model-info/`.

Por cada run de `data/models/CV/pose/<run>/weights/best.pt`:

- valida sobre el split `val` del dataset **original** (a la resolución de cada
  modelo) y saca las métricas **por clase**, que es donde se veía el problema del
  rotor: la media global mezclaba un 0,99 con un 0,00 y parecía que todo iba bien;
- copia su `results.csv` para poder graficar la evolución;
- escribe `public/model-info/<run>.json` y un `index.json` con la lista.

Uso
---
    python scripts/model-info.py                    # todos
    python scripts/model-info.py --only nano640_full
    python scripts/model-info.py --split test        # validar sobre test
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
REPO = MOBILE.parent
RUNS = REPO / "data" / "models" / "CV" / "pose"
DATASET = REPO / "data" / "yolo_ready"
OUT = MOBILE / "public" / "model-info"
EXCLUDED_RUNS = frozenset(
    {"nano256", "nano256_full", "nano360_full", "nano"}
)

SERIES_KEYS = {
    "box_map50": "metrics/mAP50(B)",
    "box_map50_95": "metrics/mAP50-95(B)",
    "pose_map50": "metrics/mAP50(P)",
    "pose_map50_95": "metrics/mAP50-95(P)",
}


def read_series(csv_path: Path) -> list[dict]:
    """Una fila por época, solo las métricas que se van a graficar."""
    if not csv_path.exists():
        return []
    series = []
    with open(csv_path, encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            clean = {key.strip(): value for key, value in row.items()}
            item = {}
            for name, column in SERIES_KEYS.items():
                value = clean.get(column)
                item[name] = round(float(value), 5) if value not in (None, "") else None
            item["epoch"] = int(float(clean.get("epoch", 0)))
            item["seconds"] = round(float(clean.get("time", 0) or 0), 1)
            series.append(item)
    return series


def build_dataset_yaml(imgsz: int, split: str) -> Path:
    """Ultralytics necesita la ruta absoluta; el `data.yaml` del zip trae la de Iker."""
    import yaml

    with open(DATASET / "data.yaml", encoding="utf-8") as handle:
        config = yaml.safe_load(handle)
    config["path"] = str(DATASET)
    temp = DATASET / ".val_tmp.yaml"
    with open(temp, "w", encoding="utf-8") as handle:
        yaml.safe_dump(config, handle)
    return temp


def class_metrics(result) -> list[dict]:
    """Precisión, recall y mAP por clase, de caja y de pose."""
    classes = {}
    for index, class_id in enumerate(result.box.ap_class_index):
        class_id = int(class_id)
        classes[class_id] = {
            "id": class_id,
            "name": result.names[class_id],
            "box": {
                "precision": round(float(result.box.p[index]), 4),
                "recall": round(float(result.box.r[index]), 4),
                "map50": round(float(result.box.ap50[index]), 4),
                "map50_95": round(float(result.box.ap[index]), 4),
            },
            "pose": {
                "precision": round(float(result.pose.p[index]), 4),
                "recall": round(float(result.pose.r[index]), 4),
                "map50": round(float(result.pose.ap50[index]), 4),
                "map50_95": round(float(result.pose.ap[index]), 4),
            },
        }
    return [classes[key] for key in sorted(classes)]


def overall_metrics(result) -> dict:
    values = result.results_dict
    return {
        "box": {
            "precision": round(float(values["metrics/precision(B)"]), 4),
            "recall": round(float(values["metrics/recall(B)"]), 4),
            "map50": round(float(values["metrics/mAP50(B)"]), 4),
            "map50_95": round(float(values["metrics/mAP50-95(B)"]), 4),
        },
        "pose": {
            "precision": round(float(values["metrics/precision(P)"]), 4),
            "recall": round(float(values["metrics/recall(P)"]), 4),
            "map50": round(float(values["metrics/mAP50(P)"]), 4),
            "map50_95": round(float(values["metrics/mAP50-95(P)"]), 4),
        },
    }


def training_meta(run_dir: Path) -> dict:
    import yaml

    args_path = run_dir / "args.yaml"
    meta = {}
    if args_path.exists():
        with open(args_path, encoding="utf-8") as handle:
            args = yaml.safe_load(handle) or {}
        for key in (
            "model",
            "data",
            "imgsz",
            "epochs",
            "batch",
            "workers",
            "optimizer",
            "lr0",
            "patience",
            "device",
        ):
            if key in args:
                meta[key] = args[key]
    weights = run_dir / "weights" / "best.pt"
    if weights.exists():
        from datetime import datetime

        meta["weightsAt"] = datetime.fromtimestamp(weights.stat().st_mtime).isoformat(
            timespec="seconds"
        )
    return meta


def onnx_summaries(split: str, batch: int, only: str | None) -> list[dict]:
    """Métricas de los modelos que solo existen como `.onnx` desplegado.

    De los `small` no hay ni `.pt` ni `results.csv` (se entrenaron fuera de este
    repo), así que se valida el propio ONNX. Sin serie de épocas: no hay histórico
    que graficar, y la página lo dice en vez de dibujar una línea vacía.
    """
    import onnxruntime as ort
    from ultralytics import YOLO

    models_dir = MOBILE / "public" / "models"
    summaries = []
    files = sorted(
        path for path in models_dir.glob("*.onnx") if "-int8" not in path.name
    )
    for path in files:
        run = path.stem.removeprefix("yolo-pose-")
        if only and run != only:
            continue
        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        shape = session.get_inputs()[0].shape
        imgsz = int(shape[2])
        print(
            f"[{run}] validando el .onnx a {imgsz}px sobre el split {split}…",
            flush=True,
        )
        temp = build_dataset_yaml(imgsz, split)
        try:
            model = YOLO(str(path), task="pose")
            result = model.val(
                data=str(temp),
                split=split,
                imgsz=imgsz,
                batch=batch,
                plots=False,
                verbose=False,
                # `cpu` obligatorio: la sesión de onnxruntime corre en CPU y si el
                # dataloader entrega tensores de CUDA, `bind_input` falla con
                # "There's no data transfer registered…".
                device="cpu",
            )
        finally:
            temp.unlink(missing_ok=True)
        summary = {
            "run": run,
            "imgsz": imgsz,
            "split": split,
            "training": {"model": path.name, "source": "onnx desplegado"},
            "overall": overall_metrics(result),
            "classes": class_metrics(result),
            "series": [],
            "csv": None,
            "bestEpoch": None,
            "epochsDone": 0,
        }
        (OUT / f"{run}.json").write_text(
            json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8"
        )
        rotor = next(
            (
                entry
                for entry in summary["classes"]
                if entry["name"].lower().startswith("rotor")
            ),
            None,
        )
        summaries.append(
            {
                "run": run,
                "imgsz": imgsz,
                "epochs": 0,
                "poseMap50": summary["overall"]["pose"]["map50"],
                "rotorPoseMap50": rotor["pose"]["map50"] if rotor else None,
                "weightsAt": None,
                "csv": None,
            }
        )
        print(
            f"  -> {run}.json · pose mAP50 {summary['overall']['pose']['map50']}"
            f" · rotor {rotor['pose']['map50'] if rotor else '—'}"
        )
    return summaries


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, default=RUNS)
    parser.add_argument("--only", help="genera solo ese run")
    parser.add_argument("--split", default="val", choices=["val", "test"])
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument(
        "--no-val", action="store_true", help="no valida, solo copia CSV y series"
    )
    parser.add_argument(
        "--onnx",
        action="store_true",
        help="además, valida los .onnx desplegados que no tienen .pt (los small)",
    )
    args = parser.parse_args()

    from ultralytics import YOLO

    OUT.mkdir(parents=True, exist_ok=True)
    for name in EXCLUDED_RUNS:
        (OUT / f"{name}.json").unlink(missing_ok=True)
        (OUT / f"{name}.csv").unlink(missing_ok=True)
    summaries = []

    run_dirs = sorted(
        path
        for path in args.runs.iterdir()
        if path.name not in EXCLUDED_RUNS and (path / "weights" / "best.pt").exists()
    )
    if args.only:
        run_dirs = [path for path in run_dirs if path.name == args.only]
    # Con `--onnx` puede no haber ningún `.pt` que procesar (los small solo
    # existen como `.onnx` desplegado), así que no es un error quedarse sin runs.
    if not run_dirs and not args.onnx:
        sys.exit(f"no hay runs con best.pt en {args.runs}")

    for run_dir in run_dirs:
        name = run_dir.name
        meta = training_meta(run_dir)
        imgsz = int(meta.get("imgsz") or 640)
        series = read_series(run_dir / "results.csv")

        csv_dest = OUT / f"{name}.csv"
        if (run_dir / "results.csv").exists():
            shutil.copy2(run_dir / "results.csv", csv_dest)

        summary_path = OUT / f"{name}.json"
        if args.no_val and summary_path.exists():
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            summary["series"] = series
        else:
            print(
                f"[{name}] validando a {imgsz}px sobre el split {args.split}…",
                flush=True,
            )
            temp = build_dataset_yaml(imgsz, args.split)
            try:
                model = YOLO(str(run_dir / "weights" / "best.pt"))
                result = model.val(
                    data=str(temp),
                    split=args.split,
                    imgsz=imgsz,
                    batch=args.batch,
                    plots=False,
                    verbose=False,
                )
            finally:
                temp.unlink(missing_ok=True)
            summary = {
                "run": name,
                "imgsz": imgsz,
                "split": args.split,
                "training": meta,
                "overall": overall_metrics(result),
                "classes": class_metrics(result),
                "series": series,
                "csv": f"{name}.csv",
            }

        best = max(
            (point for point in series if point.get("pose_map50") is not None),
            key=lambda point: point["pose_map50"],
            default=None,
        )
        summary["bestEpoch"] = best
        summary["epochsDone"] = len(series)
        summary_path.write_text(
            json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8"
        )

        rotor = next(
            (
                entry
                for entry in summary["classes"]
                if entry["name"].lower().startswith("rotor")
            ),
            None,
        )
        summaries.append(
            {
                "run": name,
                "imgsz": imgsz,
                "epochs": summary["epochsDone"],
                "poseMap50": summary["overall"]["pose"]["map50"],
                "rotorPoseMap50": rotor["pose"]["map50"] if rotor else None,
                "weightsAt": meta.get("weightsAt"),
            }
        )
        print(
            f"  -> {summary_path.relative_to(MOBILE)} · pose mAP50 {summary['overall']['pose']['map50']}"
            f" · rotor {rotor['pose']['map50'] if rotor else '—'}"
        )

    if args.onnx:
        summaries.extend(onnx_summaries(args.split, args.batch, args.only))

    # Build from every summary on disk so --only updates the selected run without
    # dropping the other epochs, while also keeping the index in sync.
    entries = []
    for path in sorted(OUT.glob("*.json")):
        if path.name == "index.json" or path.stem in EXCLUDED_RUNS:
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        rotor = next(
            (
                item
                for item in data.get("classes", [])
                if item["name"].lower().startswith("rotor")
            ),
            None,
        )
        entries.append(
            {
                "run": data["run"],
                "imgsz": data["imgsz"],
                "epochs": data.get("epochsDone", 0),
                "poseMap50": data["overall"]["pose"]["map50"],
                "rotorPoseMap50": rotor["pose"]["map50"] if rotor else None,
                "weightsAt": (data.get("training") or {}).get("weightsAt"),
                "csv": data.get("csv"),
            }
        )
    ordered = sorted(entries, key=lambda item: (item["imgsz"], item["run"]))
    (OUT / "index.json").write_text(
        json.dumps({"models": ordered}, indent=1, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"\nindex.json: {len(ordered)} modelos")


if __name__ == "__main__":
    main()
