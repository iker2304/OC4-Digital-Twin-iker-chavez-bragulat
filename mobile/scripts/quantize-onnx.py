#!/usr/bin/env python3
"""Quantise a fp32 YOLO-pose `.onnx` to int8 using this app's own frames.

Why not `yolo export int8=True`: that path needs the training dataset to
calibrate, and the dataset is not in this repo. This script calibrates with
frames taken from the assets the app actually sees (the bench video and the
rendered test scenes), so the activation ranges match the real domain.

The preprocessing is a byte-for-byte copy of `prepareInput`
(`src/lib/inference/tensor.ts`): letterbox to a square with neutral-grey padding
and scale to 0..1. If that ever changes, this must change with it, or the
quantised model will be calibrated off-distribution.

Usage
-----
    python scripts/quantize-onnx.py public/models/yolo-pose-s-480.onnx --size 480
    python scripts/quantize-onnx.py public/models/yolo-pose-s-512.onnx --size 512 --frames 96
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.quantization import (
    CalibrationDataReader,
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_static,
)

ROOT = Path(__file__).resolve().parent.parent
VIDEO = ROOT / "public" / "test" / "video.mp4"
SCENES = sorted((ROOT / "public" / "test").glob("escena-*.png"))
PAD_VALUE = 114
# Ops worth quantising: they are the ones carrying weights, i.e. the only real
# compute. An end-to-end pose model keeps its NMS/decode tail in fp32.
WEIGHTED_OPS = {"Conv", "Gemm", "MatMul"}


def letterbox(image: np.ndarray, size: int) -> np.ndarray:
    """BGR uint8 / any size -> RGB float32 [1,3,size,size] in 0..1."""
    height, width = image.shape[:2]
    scale = min(size / width, size / height)
    new_w, new_h = round(width * scale), round(height * scale)
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), PAD_VALUE, dtype=np.uint8)
    top, left = (size - new_h) // 2, (size - new_w) // 2
    canvas[top : top + new_h, left : left + new_w] = resized
    rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
    tensor = rgb.astype(np.float32) / 255.0
    return np.ascontiguousarray(tensor.transpose(2, 0, 1)[None, ...])


def calibration_images(count: int) -> list[np.ndarray]:
    """Evenly spaced video frames plus the still scenes, as raw BGR arrays."""
    frames: list[np.ndarray] = []
    if VIDEO.exists():
        capture = cv2.VideoCapture(str(VIDEO))
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        if total > 0:
            step = max(total // count, 1)
            for index in range(0, total, step):
                capture.set(cv2.CAP_PROP_POS_FRAMES, index)
                ok, frame = capture.read()
                if ok:
                    frames.append(frame)
                if len(frames) >= count:
                    break
        capture.release()
    else:
        print(f"aviso: no está {VIDEO.relative_to(ROOT)}")
    for scene in SCENES:
        image = cv2.imread(str(scene))
        if image is not None:
            frames.append(image)
    if not frames:
        sys.exit("sin imágenes de calibración: revisa public/test/")
    return frames


class FramesReader(CalibrationDataReader):
    def __init__(self, frames: list[np.ndarray], size: int, input_name: str) -> None:
        self._items = [{"images": letterbox(frame, size)} for frame in frames]
        self._input_name = input_name
        self._index = 0

    def get_next(self) -> dict[str, np.ndarray] | None:
        if self._index >= len(self._items):
            return None
        batch = self._items[self._index]
        self._index += 1
        return batch

    def rewind(self) -> None:
        self._index = 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path, help="ONNX fp32 de entrada")
    parser.add_argument(
        "--size", type=int, required=True, help="lado de entrada del modelo"
    )
    parser.add_argument(
        "--frames", type=int, default=64, help="frames del vídeo a usar"
    )
    parser.add_argument("--out", type=Path, help="salida (por defecto, sufijo -int8)")
    parser.add_argument(
        "--activation",
        choices=["qint8", "quint8"],
        default="quint8",
        help="tipo de activación: quint8 es lo que las CPU x86 ejecutan con vpmaddubsw",
    )
    parser.add_argument(
        "--reduce-range",
        action="store_true",
        help="7 bits en vez de 8: más rápido en algunos backends, menos preciso",
    )
    parser.add_argument(
        "--per-channel",
        action="store_true",
        help="una escala por canal de peso: más preciso, a veces más lento",
    )
    args = parser.parse_args()

    model = onnx.load(str(args.model))
    input_name = model.graph.input[0].name
    shape = [d.dim_value for d in model.graph.input[0].type.tensor_type.shape.dim]
    if shape[2:] != [args.size, args.size]:
        sys.exit(f"{args.model.name} espera {shape[2:]} y se pidió {args.size}")

    out = args.out or args.model.with_name(f"{args.model.stem}-int8.onnx")
    frames = calibration_images(args.frames)
    print(f"calibrando con {len(frames)} imágenes a {args.size}px -> {out.name}")

    # Only the weighted ops are quantised: everything else (the decode head with
    # its Sigmoid/Mul/Concat and the end-to-end NMS) stays float. Quantising the
    # head makes a single scale span box pixels (~0..640) and class probabilities
    # (0..1), which rounds every score to 0 — the model then returns no
    # detections at all. Excluding by node, not by op type, still calibrates the
    # tensors, which avoids ONNX Runtime crashing on uncalibrated nodes.
    exclude = [n.name for n in model.graph.node if n.op_type not in WEIGHTED_OPS]

    quantize_static(
        str(args.model),
        str(out),
        FramesReader(frames, args.size, input_name),
        quant_format=QuantFormat.QDQ,
        activation_type=(
            QuantType.QUInt8 if args.activation == "quint8" else QuantType.QInt8
        ),
        weight_type=QuantType.QInt8,
        per_channel=args.per_channel,
        reduce_range=args.reduce_range,
        calibrate_method=CalibrationMethod.MinMax,
        nodes_to_exclude=exclude,
    )
    size_mb = out.stat().st_size / 1e6
    shown = out.resolve().relative_to(ROOT) if out.is_absolute() else out
    print(f"  -> {shown}  ({size_mb:.1f} MB)")

    # A quantised model that does not load is worse than no model: prove it runs.
    session = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    probe = np.zeros((1, 3, args.size, args.size), dtype=np.float32)
    result = session.run(None, {input_name: probe})
    print(f"  ok: salida {[tuple(r.shape) for r in result]}")


if __name__ == "__main__":
    main()
