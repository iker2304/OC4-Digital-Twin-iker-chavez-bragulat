#!/usr/bin/env python3
"""Convierte los casos GiD de `mobile/fem/*.gid` al JSON que lee `/rotor-fem/`.

Cada caso `.gid` trae dos ficheros que nos interesan:

  - `<caso>.dat`         la malla: `coordinates` (id x y z, en metros) y
                         `elements` (id n1 n2 n3 material — triángulos de 3 nodos)
  - `<caso>.flavia.res`  los resultados, en bloques `Result "..." "Static" 1 ...

De los 28 bloques de resultados solo se usa el primero,
`Result "Displacements (m)" ... Vector OnNodes`, que da **tres componentes** por
nodo. El módulo (`|u|`) **no viene calculado** —la cuarta entrada de
`ComponentNames` es solo la cabecera— así que se calcula aquí:

    |u| = sqrt(ux² + uy² + uz²)

## Cada caso viene en su propio sistema de ejes

El solver gira el modelo para alinear la carga con un eje, así que `blade-x` no
está en el mismo sistema que `blade-centripetal`. Los nodos son los mismos (mismos
ids), así que la rotación se recupera con Kabsch (SVD de `Pᵀ·Q`) y resulta ser una
permutación de ejes exacta, con residuo de 0,4 µm. El script la aplica y escribe
**una sola malla** en el sistema del primer caso; cada caso guarda la rotación que
se le aplicó, por si hay que deshacerla.

Uso:
    python mobile/scripts/fem-to-json.py                 # todos los casos
    python mobile/scripts/fem-to-json.py blade-x         # solo ese
    python mobile/scripts/fem-to-json.py --out otra/carpeta

Salida en `mobile/public/rotor-fem/`:

    mesh.json    malla compartida: posiciones (float) + índices de triángulo
    <caso>.json  desplazamientos por nodo + estadísticos + rotación aplicada
    index.json   lista de casos, para que la página no tenga que adivinarlos
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
FEM_DIR = ROOT / "fem"
OUT_DIR = ROOT / "public" / "rotor-fem"

# Decimales de las coordenadas: 1e-6 m = 1 µm. El `.dat` trae 8, así que esto no
# pierde nada visible y recorta el JSON casi a la mitad.
POSITION_DECIMALS = 6
# Los desplazamientos son del orden de 1e-9 m; se guardan con 6 cifras
# significativas, de sobra para pintar un mapa de color.
SIGNIFICANT_DIGITS = 6
# Si al rotar un caso al frame de referencia queda más error que esto, no se
# comparte la malla: ese caso se guarda con la suya.
ALIGN_TOLERANCE_M = 1e-5


def read_dat(path: Path) -> tuple[list[int], np.ndarray, list[tuple[int, int, int]]]:
    """Ids de nodo, coordenadas (N×3) y triángulos del `.dat`."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()

    def bounds(keyword: str, end_keyword: str) -> tuple[int, int]:
        try:
            start = next(
                index for index, line in enumerate(lines) if line.strip().lower() == keyword
            )
            end = next(
                index
                for index, line in enumerate(lines)
                if index > start and line.strip().lower() == end_keyword
            )
        except StopIteration:
            raise SystemExit(f"{path.name}: no encuentro el bloque «{keyword} … {end_keyword}»")
        return start, end

    coords_start, coords_end = bounds("coordinates", "end coordinates")
    ids: list[int] = []
    xyz: list[list[float]] = []
    for line in lines[coords_start + 1 : coords_end]:
        parts = line.split()
        if len(parts) < 4:
            continue
        ids.append(int(parts[0]))
        xyz.append([float(parts[1]), float(parts[2]), float(parts[3])])

    elements_start, elements_end = bounds("elements", "end elements")
    triangles: list[tuple[int, int, int]] = []
    for line in lines[elements_start + 1 : elements_end]:
        parts = line.split()
        if len(parts) < 4:
            continue
        # id n1 n2 n3 [material] — solo triángulos de 3 nodos.
        triangles.append((int(parts[1]), int(parts[2]), int(parts[3])))

    if not ids or not triangles:
        raise SystemExit(f"{path.name}: malla vacía ({len(ids)} nodos, {len(triangles)} elementos)")
    return ids, np.array(xyz, dtype=np.float64), triangles


def read_displacements(path: Path) -> dict[int, tuple[float, float, float]]:
    """Primer bloque `Result "Displacements (m)" … OnNodes` del `.flavia.res`."""
    found: dict[int, tuple[float, float, float]] | None = None
    inside = False

    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            stripped = line.strip()
            if found is None:
                if stripped.startswith('Result "Displacements') and "OnNodes" in stripped:
                    found = {}
                    inside = False
                continue
            if not inside:
                if stripped.lower() == "values":
                    inside = True
                elif stripped.startswith("Result "):
                    found = None  # bloque sin `Values`: se abandona y se sigue buscando
                continue
            if stripped.lower() == "end values":
                break
            parts = stripped.split()
            if len(parts) < 4:
                continue
            found[int(parts[0])] = (float(parts[1]), float(parts[2]), float(parts[3]))

    if not found:
        raise SystemExit(f"{path.name}: no encuentro ningún bloque `Displacements … OnNodes`")
    return found


def rotation_to_reference(source: np.ndarray, reference: np.ndarray) -> tuple[np.ndarray, float]:
    """Rotación (3×3) que lleva `source` sobre `reference`. Kabsch sin traslación."""
    u, _, vt = np.linalg.svd(source.T @ reference)
    rotation = vt.T @ u.T
    if np.linalg.det(rotation) < 0:
        # Reflejo: se corrige el último vector singular.
        vt[-1] *= -1
        rotation = vt.T @ u.T
    residual = float(np.abs(source @ rotation.T - reference).max())
    return rotation, residual


def stats(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    count = len(ordered)

    def percentile(fraction: float) -> float:
        index = min(count - 1, max(0, round(fraction * (count - 1))))
        return ordered[index]

    return {
        "min": ordered[0],
        "max": ordered[-1],
        "mean": sum(ordered) / count,
        "p50": percentile(0.50),
        "p95": percentile(0.95),
        "p99": percentile(0.99),
    }


def round_sig(value: float, digits: int = SIGNIFICANT_DIGITS) -> float:
    if value == 0 or not math.isfinite(value):
        return value
    return round(value, digits - int(math.floor(math.log10(abs(value)))) - 1)


def mesh_signature(ids: list[int], xyz: np.ndarray, triangles: list[tuple[int, int, int]]) -> str:
    digest = hashlib.sha1()
    for node_id, (x, y, z) in zip(ids, xyz):
        digest.update(f"{node_id}:{x:.6f},{y:.6f},{z:.6f};".encode())
    for triangle in triangles:
        digest.update(f"{triangle[0]},{triangle[1]},{triangle[2]};".encode())
    return digest.hexdigest()[:16]


def load_case(case_dir: Path) -> dict:
    dat = case_dir / f"{case_dir.stem}.dat"
    res = case_dir / f"{case_dir.stem}.flavia.res"
    if not dat.exists():
        raise SystemExit(f"falta {dat}")
    if not res.exists():
        raise SystemExit(f"falta {res}")

    ids, xyz, triangles = read_dat(dat)
    displacements = read_displacements(res)

    magnitudes: list[float] = []
    missing = 0
    for node_id in ids:
        vector = displacements.get(node_id)
        if vector is None:
            missing += 1
            magnitudes.append(0.0)
            continue
        magnitudes.append(math.sqrt(sum(component * component for component in vector)))

    return {
        "case": case_dir.stem,
        "ids": ids,
        "xyz": xyz,
        "triangles": triangles,
        "magnitudes": magnitudes,
        "missingNodes": missing,
    }


def flat_indices(ids: list[int], triangles: list[tuple[int, int, int]]) -> list[int]:
    position_of = {node_id: index for index, node_id in enumerate(ids)}
    return [position_of[node] for triangle in triangles for node in triangle]


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("cases", nargs="*", help="nombres de caso (por defecto, todos los de fem/)")
    parser.add_argument("--out", type=Path, default=OUT_DIR, help="carpeta de salida")
    args = parser.parse_args()

    case_dirs = sorted(path for path in FEM_DIR.glob("*.gid") if path.is_dir())
    if args.cases:
        wanted = set(args.cases)
        case_dirs = [path for path in case_dirs if path.stem in wanted]
        missing = wanted - {path.stem for path in case_dirs}
        if missing:
            raise SystemExit(f"no encuentro el caso: {', '.join(sorted(missing))}")
    if not case_dirs:
        raise SystemExit(f"no hay casos *.gid en {FEM_DIR}")

    args.out.mkdir(parents=True, exist_ok=True)
    cases = [load_case(path) for path in case_dirs]

    reference = cases[0]
    reference_ids = reference["ids"]
    reference_xyz = reference["xyz"]
    reference_triangles = reference["triangles"]

    shared = True
    alignments: list[dict] = []
    for case in cases:
        if case["ids"] != reference_ids or case["triangles"] != reference_triangles:
            shared = False
            alignments.append(
                {
                    "rotation": None,
                    "residual": None,
                    "reason": "la topología no coincide con la referencia",
                }
            )
            continue
        rotation, residual = rotation_to_reference(case["xyz"], reference_xyz)
        if residual > ALIGN_TOLERANCE_M:
            shared = False
            alignments.append(
                {
                    "rotation": rotation.round(6).tolist(),
                    "residual": residual,
                    "reason": f"residuo {residual:.2e} m por encima de {ALIGN_TOLERANCE_M:.0e} m",
                }
            )
            continue
        alignments.append(
            {"rotation": rotation.round(6).tolist(), "residual": residual, "reason": None}
        )

    if shared:
        mesh = {
            "nodeCount": len(reference_ids),
            "triangleCount": len(reference_triangles),
            "positions": [
                round(float(value), POSITION_DECIMALS) for value in reference_xyz.ravel()
            ],
            "indices": flat_indices(reference_ids, reference_triangles),
            "signature": mesh_signature(reference_ids, reference_xyz, reference_triangles),
            "frame": reference["case"],
        }
        (args.out / "mesh.json").write_text(
            json.dumps(mesh, separators=(",", ":")), encoding="utf-8"
        )
        print(
            f"mesh.json    {mesh['nodeCount']} nodos · {mesh['triangleCount']} triángulos · "
            f"frame de «{mesh['frame']}»"
        )
    else:
        print("AVISO: los casos no se pueden llevar a una malla común; cada uno lleva la suya")

    index: list[dict] = []
    for case, alignment in zip(cases, alignments):
        payload: dict = {
            "case": case["case"],
            "nodeCount": len(case["ids"]),
            "stats": stats(case["magnitudes"]),
            "magnitudes": [round_sig(value) for value in case["magnitudes"]],
            "alignedTo": reference["case"] if alignment["reason"] is None else None,
            "frameRotation": alignment["rotation"],
            "frameResidual": alignment["residual"],
            "frameNote": alignment["reason"],
            "source": {"dat": f"{case['case']}.dat", "res": f"{case['case']}.flavia.res"},
            "warnings": {"nodesWithoutResult": case["missingNodes"]},
        }
        if shared:
            payload["mesh"] = "mesh.json"
        else:
            payload["triangleCount"] = len(case["triangles"])
            payload["positions"] = [
                round(float(value), POSITION_DECIMALS) for value in case["xyz"].ravel()
            ]
            payload["indices"] = flat_indices(case["ids"], case["triangles"])

        target = args.out / f"{case['case']}.json"
        target.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        print(
            f"{target.name:26s} {target.stat().st_size / 1024:7.0f} KB · "
            f"máx {payload['stats']['max']:.3e} m · p95 {payload['stats']['p95']:.3e} m"
        )
        if alignment["residual"] is not None:
            print(f"  frame: rotado a «{reference['case']}», residuo {alignment['residual']:.2e} m")
        if alignment["reason"]:
            print(f"  AVISO: {alignment['reason']}")
        if case["missingNodes"]:
            print(f"  aviso: {case['missingNodes']} nodos sin resultado")

        index.append(
            {
                "case": case["case"],
                "nodeCount": len(case["ids"]),
                "max": payload["stats"]["max"],
                "p95": payload["stats"]["p95"],
            }
        )

    (args.out / "index.json").write_text(
        json.dumps(
            {"reference": reference["case"], "mesh": "mesh.json" if shared else None, "cases": index},
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"\n{len(cases)} caso(s) en {args.out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
