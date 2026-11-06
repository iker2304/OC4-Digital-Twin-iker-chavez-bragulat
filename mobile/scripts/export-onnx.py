#!/usr/bin/env python3
"""Export a trained YOLO-pose `.pt` to the ONNX variants this app benchmarks.

Every export used by `/bench` must live in `public/models/` (or be copied there
by `npm run sync:models`). The bench identifies a model by *fingerprint*, so a
new file never mixes its runs with the old one: it shows up as its own chip.

Examples
--------
    python scripts/export-onnx.py models/best.pt                      # 640 fp32
    python scripts/export-onnx.py models/best.pt --sizes 512 480      # two sizes
    python scripts/export-onnx.py models/best.pt --sizes 480 --int8 --data <yaml>
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "models"
# Labels are identical for every size of the same network: reuse the current one
# so a fresh export is immediately usable by the client.
REFERENCE_LABELS = ROOT / "public" / "models" / "yolo-pose-s-640.labels.txt"


def export_one(
    weights: Path,
    size: int,
    name: str,
    int8: bool,
    data: str | None,
    opset: int,
    device: str,
    nms: bool,
) -> Path:
    from ultralytics import YOLO

    model = YOLO(str(weights))
    kwargs: dict[str, object] = {
        "format": "onnx",
        "imgsz": size,
        "dynamic": False,
        "simplify": True,
        # cpu by default: exporting while a training run owns the GPU ends in
        # `CUDA error: out of memory` for both of them.
        "device": device,
        # 20, not 12: per-channel QDQ quantisation needs `axis` on
        # QuantizeLinear/DequantizeLinear, which opset 12 does not have, and the
        # int8 export below is per-channel.
        "opset": opset,
    }
    if nms:
        # NMS dentro del grafo: la salida queda en `(1, 300, 4+clases+kpts)`.
        # Sin esto, un `.pt` que no venía de un export previo sale en crudo
        # `(1, 4+clases+kpts, 8400)` y la app no lo sabe decodificar.
        kwargs["nms"] = True
    if int8:
        if not data:
            sys.exit("--int8 necesita --data <dataset.yaml> para la calibración")
        kwargs.update(int8=True, data=data)
    exported = Path(model.export(**kwargs))
    suffix = f"-{size}-int8" if int8 else f"-{size}"
    dest = OUT_DIR / f"{name}{suffix}.onnx"
    shutil.move(str(exported), dest)
    print(f"  -> {dest.relative_to(ROOT)}  ({dest.stat().st_size / 1e6:.1f} MB)")

    labels = dest.parent / f"{dest.stem}.labels.txt"
    if REFERENCE_LABELS.exists() and not labels.exists():
        shutil.copy2(REFERENCE_LABELS, labels)
        print(f"     + {labels.name}")
    return dest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("weights", type=Path, help="ruta al .pt entrenado")
    parser.add_argument(
        "--sizes",
        type=int,
        nargs="+",
        default=[640],
        help="lado de entrada; varios valores exportan un fichero por tamaño",
    )
    parser.add_argument(
        "--name",
        default="yolo-pose-s",
        help="prefijo del fichero (cambia la 's' si el modelo es n/m/l)",
    )
    parser.add_argument("--int8", action="store_true", help="exportación cuantizada")
    parser.add_argument("--data", help="dataset.yaml para calibrar el int8")
    parser.add_argument(
        "--opset", type=int, default=20, help="opset ONNX (20 = QDQ por canal)"
    )
    parser.add_argument(
        "--device",
        default="cpu",
        help="cpu | 0 … N. cpu por defecto: exportar en la GPU mientras entrena la deja sin memoria",
    )
    parser.add_argument(
        "--nms",
        action="store_true",
        help="integrar el NMS en el grafo (salida 1x300xN, la que espera la app)",
    )
    args = parser.parse_args()

    if not args.weights.exists():
        sys.exit(f"no existe {args.weights}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Exportando {args.weights.name} -> {OUT_DIR.relative_to(ROOT)}")
    for size in args.sizes:
        export_one(
            args.weights,
            size,
            args.name,
            args.int8,
            args.data,
            args.opset,
            args.device,
            args.nms,
        )
    print("\nRecarga /bench: cada fichero aparece como un modelo aparte.")


if __name__ == "__main__":
    main()
