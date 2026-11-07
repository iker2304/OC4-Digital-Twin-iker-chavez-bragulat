#!/usr/bin/env python3
"""Interpola los desplazamientos FEM sobre las mallas de pala del propio `.glb`.

El problema: la malla que se malló para el solver no es la del gemelo (se
regeneró para simular y en algunos sitios se mete dentro del `OC4.glb`), así que
pintar los resultados sobre ella deja una nube que no coincide con las palas
reales.

La solución: **no mover la FEM**. Se registra (ICP rígido) sobre cada pala del
gemelo y se interpolan los `|u|` a los vértices **de la malla del gemelo**. El
mapa de color se pinta entonces sobre la geometría real y coincide al 100 % por
construcción.

Cadena:

  1. Lee el GLB a pelo (JSON + BIN) y localiza los nodos `MeshBody…`: son 12,
     cuatro por pala, y las tres palas se distinguen por el sufijo del nombre
     (`''`, `.001`, `.002`).
  2. Aplica la transformación de cada nodo (T·R·S) y junta los cuatro trozos.
  3. Registra la malla FEM sobre cada pala: giro inicial por el eje de la pala
     (de la cuaternia del nodo) y refinamiento con ICP (Kabsch sobre vecinos más
     cercanos, recortando el 10 % peor).
  4. Interpola `|u|` a cada vértice del gemelo con IDW de 4 vecinos.
  5. Escribe `public/rotor-fem/blade-glb.json`: nombres de nodo + un `uint8` por
     vértice y caso (normalizado, con el pico aparte) en base64.

Uso:
    python mobile/scripts/fem-bake-blade.py            # todos los casos
    python mobile/scripts/fem-bake-blade.py --cases blade-x blade-z

Necesita `public/rotor-fem/mesh.json` y los `<caso>.json` de `fem-to-json.py`.
"""

from __future__ import annotations

import argparse
import base64
import re
import json
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
GLB = ROOT / "public" / "models" / "OC4.glb"  # se puede cambiar con --glb
FEM_DIR = ROOT / "public" / "rotor-fem"
OUT = FEM_DIR / "blade-glb.json"

# Componentes de acceso glTF que puede traer un POSITION.
COMPONENT_DTYPE = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
COMPONENT_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
# Un nodo de pala en el `.glb` se llama así; el sufijo indica de qué pala es.
BODY_PATTERN = "MeshBody"
ICP_ITERATIONS = 12
ICP_TRIM = 0.9  # se descarta el 10 % de pares peores en cada iteración
IDW_NEIGHBOURS = 4


def read_glb(path: Path) -> tuple[dict, bytes]:
    buffer = path.read_bytes()
    if buffer[:4] != b"glTF":
        raise SystemExit(f"{path.name}: no es un GLB")
    offset = 12
    json_chunk = b""
    bin_chunk = b""
    while offset < len(buffer):
        length = int.from_bytes(buffer[offset : offset + 4], "little")
        kind = buffer[offset + 4 : offset + 8]
        payload = buffer[offset + 8 : offset + 8 + length]
        if kind == b"JSON":
            json_chunk = payload
        elif kind.startswith(b"BIN"):
            bin_chunk = payload
        offset += 8 + length
    return json.loads(json_chunk.decode("utf-8")), bin_chunk


def accessor_array(gltf: dict, binary: bytes, index: int) -> np.ndarray:
    accessor = gltf["accessors"][index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    dtype = np.dtype(COMPONENT_DTYPE[accessor["componentType"]])
    size = COMPONENT_SIZE[accessor["componentType"]]
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride") or size * components
    count = accessor["count"]
    if stride == size * components:
        flat = np.frombuffer(binary, dtype=dtype, count=count * components, offset=start)
        return flat.reshape(count, components).copy()
    rows = [np.frombuffer(binary, dtype=dtype, count=components, offset=start + i * stride) for i in range(count)]
    return np.array(rows)


def node_matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    matrix = np.eye(4)
    if "scale" in node:
        matrix[:3, :3] = np.diag(node["scale"])
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        rotation = np.array(
            [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
            ]
        )
        matrix[:3, :3] = rotation @ matrix[:3, :3]
    if "translation" in node:
        matrix[:3, 3] = node["translation"]
    return matrix


def world_matrices(gltf: dict) -> list[np.ndarray]:
    """Matriz de cada nodo relativa a la raíz de la escena."""
    nodes = gltf["nodes"]
    children = {child for node in nodes for child in node.get("children", [])}
    roots = [index for index in range(len(nodes)) if index not in children]
    matrices = [np.eye(4)] * len(nodes)

    def walk(index: int, parent: np.ndarray) -> None:
        world = parent @ node_matrix(nodes[index])
        matrices[index] = world
        for child in nodes[index].get("children", []):
            walk(child, world)

    for root in roots:
        walk(root, np.eye(4))
    return matrices


def descendant_meshes(gltf: dict, root_index: int) -> list[int]:
    """Nodos con malla que cuelgan de `root_index` (él incluido)."""
    out: list[int] = []
    stack = [root_index]
    while stack:
        index = stack.pop()
        node = gltf["nodes"][index]
        if node.get("mesh") is not None:
            out.append(index)
        stack.extend(node.get("children", []))
    return out


def rotor_root(gltf: dict) -> int:
    """Nodo del grupo que gira: `rotate` en OC4.glb, `rotation` en OC4-modal.glb."""
    for index, node in enumerate(gltf["nodes"]):
        if re.match(r"^rotat(e|ion)$", (node.get("name") or "").strip(), re.IGNORECASE):
            return index
    raise SystemExit("no encuentro el grupo del rotor (`rotate` / `rotation`)")


def blade_groups_by_azimuth(
    gltf: dict, binary: bytes, matrices: list[np.ndarray]
) -> tuple[dict[str, list[int]], np.ndarray, dict[str, tuple[np.ndarray, np.ndarray]]]:
    """Agrupa las mallas de pala **por el acimut** de su centroide.

    En `OC4-modal.glb` cada pala son cuatro mallas con nombres distintos
    (`bottom_blade`, `mid_blade`, `red_1`, `red_2`) y solo las coloreadas llevan
    la pala en el nombre. Así que: primero se sacan las tres direcciones de las
    mallas `red…`, `blue…` y `yellow…`, y después cada malla restante se asigna a
    la dirección con la que más se alinea. Simple y sin cortes por huecos, que es
    donde se colaba un grupo de tres y otro de cinco.
    """
    indices = descendant_meshes(gltf, rotor_root(gltf))

    def vertices(index: int) -> np.ndarray:
        node = gltf["nodes"][index]
        position = accessor_array(
            gltf, binary, gltf["meshes"][node["mesh"]]["primitives"][0]["attributes"]["POSITION"]
        )
        homogeneous = np.hstack([position.astype(np.float64), np.ones((position.shape[0], 1))])
        return (matrices[index] @ homogeneous.T).T[:, :3]

    centroides = {index: vertices(index).mean(axis=0) for index in indices}

    # Centro del buje: el nodo `Hub…` con malla; si no hay, la media de todo.
    hub = None
    for index in indices:
        if (gltf["nodes"][index].get("name") or "").lower().startswith("hub"):
            hub = centroides[index]
            break
    if hub is None:
        hub = np.mean(list(centroides.values()), axis=0)

    # Eje de giro: la dirección de menor varianza de los centroides.
    puntos = np.array([centroides[index] - hub for index in indices])
    _, _, vt = np.linalg.svd(puntos - puntos.mean(axis=0), full_matrices=False)
    axis = vt[2] / np.linalg.norm(vt[2])

    def radial(index: int) -> np.ndarray:
        vector = centroides[index] - hub
        vector = vector - axis * float(np.dot(vector, axis))
        return vector / max(np.linalg.norm(vector), 1e-9)

    colores = {}
    for color in ("red", "blue", "yellow"):
        miembros = [
            index
            for index in indices
            if color in (gltf["nodes"][index].get("name") or "").lower()
        ]
        if not miembros:
            raise SystemExit(f"--group azimuth necesita mallas con «{color}» en el nombre")
        colores[color] = np.mean([radial(index) for index in miembros], axis=0)

    grupos: dict[str, list[int]] = {color: [] for color in colores}
    for index in indices:
        direccion = radial(index)
        color = max(colores, key=lambda name: float(np.dot(direccion, colores[name])))
        grupos[color].append(index)

    # Para cada grupo: dirección radial (eje de la pala) y dónde empieza la raíz.
    geometria: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for color, miembros in grupos.items():
        direccion = np.mean([radial(index) for index in miembros], axis=0)
        direccion /= np.linalg.norm(direccion)
        minimo = min(float(np.min((vertices(index) - hub) @ direccion)) for index in miembros)
        geometria[color] = (direccion, hub + direccion * minimo)

    return grupos, axis, geometria


def blade_groups(gltf: dict) -> dict[str, list[int]]:
    """Nodos `MeshBody…` agrupados por pala, según el sufijo del nombre."""
    groups: dict[str, list[int]] = {}
    for index, node in enumerate(gltf["nodes"]):
        name = node.get("name", "")
        if BODY_PATTERN not in name or node.get("mesh") is None:
            continue
        suffix = name.split(".")[-1] if "." in name else "base"
        groups.setdefault(suffix, []).append(index)
    return dict(sorted(groups.items()))


def blade_vertices(gltf: dict, binary: bytes, matrices: list[np.ndarray], nodes: list[int]) -> tuple[np.ndarray, list[dict]]:
    """Vértices de una pala en coordenadas de modelo y la lista de primitivas."""
    chunks: list[np.ndarray] = []
    primitives: list[dict] = []
    for index in nodes:
        node = gltf["nodes"][index]
        mesh = gltf["meshes"][node["mesh"]]
        for primitive_index, primitive in enumerate(mesh["primitives"]):
            position = accessor_array(gltf, binary, primitive["attributes"]["POSITION"]).astype(np.float64)
            homogeneous = np.hstack([position, np.ones((position.shape[0], 1))])
            world = (matrices[index] @ homogeneous.T).T[:, :3]
            chunks.append(world)
            primitives.append(
                {
                    "node": index,
                    "name": node.get("name"),
                    "primitive": primitive_index,
                    "count": int(position.shape[0]),
                    # Huella de la POSITION local: la página la usa para comprobar
                    # que el orden de vértices del `.glb` es el que se horneó.
                    "checksum": geometric_checksum(position),
                }
            )
    return np.vstack(chunks), primitives


def geometric_checksum(position: np.ndarray) -> str:
    """Suma redondeada de las coordenadas: cambia si cambia la malla."""
    total = np.round(position, 4).sum(axis=0)
    return "|".join(f"{value:.4f}" for value in total)


def rotvec_between(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Rotación mínima que lleva el vector `source` sobre `target`."""
    a = source / np.linalg.norm(source)
    b = target / np.linalg.norm(target)
    axis = np.cross(a, b)
    sin = np.linalg.norm(axis)
    cos = float(np.dot(a, b))
    if sin < 1e-12:
        return np.eye(3)
    axis /= sin
    angle = np.arctan2(sin, cos)
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * k + (1 - np.cos(angle)) * (k @ k)


def axis_angle(axis: np.ndarray, angle: float) -> np.ndarray:
    """Matriz de rotación de `angle` radianes alrededor de `axis` (unitario)."""
    k = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * k + (1 - np.cos(angle)) * (k @ k)


def kabsch(source: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    centroid_s = source.mean(axis=0)
    centroid_t = target.mean(axis=0)
    u, _, vt = np.linalg.svd((source - centroid_s).T @ (target - centroid_t))
    rotation = vt.T @ u.T
    if np.linalg.det(rotation) < 0:
        vt[-1] *= -1
        rotation = vt.T @ u.T
    return rotation, centroid_t - rotation @ centroid_s


def register(fem: np.ndarray, blade: np.ndarray, blade_axis: np.ndarray, root: np.ndarray) -> dict:
    """Alinea la malla FEM (eje −Z, raíz en z≈0) con la pala del `.glb`."""
    tree = cKDTree(blade)

    # Estimación inicial: el eje largo de la FEM (−Z) sobre el eje de la pala, con
    # la raíz apoyada en la raíz del `.glb`. Eso deja **libre el giro alrededor del
    # eje**, que es la ambigüedad que se come el ICP: se prueban 24 giros a 15° y
    # se sigue el mejor (sin esto, la misma pala daba 2,9 mm o 81 mm según con qué
    # copia se empezara). La traslación se recalcula en cada giro para no mover la
    # pala de sitio: si no, los candidatos se van a decenas de centímetros.
    base_rotation = rotvec_between(np.array([0.0, 0.0, -1.0]), blade_axis)
    fem_root = fem[int(np.argmax(fem[:, 2]))]

    best_rotation = base_rotation
    best_translation = root - base_rotation @ fem_root
    best_distance = np.inf
    for step in range(24):
        rotation = axis_angle(blade_axis, step * np.pi / 12) @ base_rotation
        translation = root - rotation @ fem_root
        points = fem @ rotation.T + translation
        distance = float(np.median(tree.query(points, k=1)[0]))
        if distance < best_distance:
            best_distance = distance
            best_rotation = rotation
            best_translation = translation

    rotation = best_rotation
    translation = best_translation
    points = fem @ rotation.T + translation

    for _ in range(ICP_ITERATIONS):
        distances, indices = tree.query(points, k=1)
        keep = distances <= np.quantile(distances, ICP_TRIM)
        rotation_step, translation_step = kabsch(points[keep], blade[indices[keep]])
        points = points @ rotation_step.T + translation_step
        rotation = rotation_step @ rotation
        translation = rotation_step @ translation + translation_step

    distances, _ = tree.query(points, k=1)
    return {
        "rotation": rotation.tolist(),
        "translation": translation.tolist(),
        "median": float(np.median(distances)),
        "p95": float(np.quantile(distances, 0.95)),
        "max": float(distances.max()),
        "points": points,
    }


def interpolate(tree: cKDTree, magnitudes: np.ndarray, targets: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """IDW de k vecinos. Devuelve los valores y la distancia al vecino más lejano."""
    distances, indices = tree.query(targets, k=IDW_NEIGHBOURS)
    distances = np.maximum(distances, 1e-12)
    weights = 1.0 / (distances**2)
    values = (weights * magnitudes[indices]).sum(axis=1) / weights.sum(axis=1)
    return values, distances[:, -1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cases", nargs="*", help="casos a interpolar (por defecto, todos)")
    parser.add_argument("--glb", type=Path, default=GLB)
    parser.add_argument(
        "--group",
        choices=["suffix", "azimuth"],
        default="suffix",
        help="cómo agrupar las mallas de una pala: por sufijo del nombre (.001/.002) o por acimut",
    )
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    mesh_path = FEM_DIR / "mesh.json"
    if not mesh_path.exists():
        raise SystemExit("falta public/rotor-fem/mesh.json: ejecuta antes fem-to-json.py")
    fem_mesh = json.loads(mesh_path.read_text(encoding="utf-8"))
    fem_nodes = np.array(fem_mesh["positions"], dtype=np.float64).reshape(-1, 3)

    case_files = sorted(
        path for path in FEM_DIR.glob("blade-*.json") if not path.stem.startswith("blade-glb")
    )
    if args.cases:
        wanted = set(args.cases)
        case_files = [path for path in case_files if path.stem in wanted]
    if not case_files:
        raise SystemExit("no hay casos que interpolar")

    gltf, binary = read_glb(args.glb)
    matrices = world_matrices(gltf)

    geometria: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    if args.group == "azimuth":
        # `OC4-modal.glb`: cada pala son cuatro mallas con nombres distintos, sin
        # sufijo común, así que se agrupan por la dirección en la que están.
        groups, _, geometria = blade_groups_by_azimuth(gltf, binary, matrices)
        etiquetas = {}
        for clave, nodos in groups.items():
            nombres = " ".join((gltf["nodes"][i].get("name") or "") for i in nodos).lower()
            color = next((c for c in ("red", "blue", "yellow") if c in nombres), None)
            etiquetas[clave] = color or f"pala{clave}"
        groups = {etiquetas[clave]: nodos for clave, nodos in groups.items()}
        geometria = {etiquetas[clave]: valor for clave, valor in geometria.items()}
    else:
        groups = blade_groups(gltf)
    if not groups:
        raise SystemExit(f"no encuentro mallas de pala en {args.glb.name} (prueba --group azimuth)")

    print(f"{args.glb.name}: {sum(len(v) for v in groups.values())} primitivas en {len(groups)} pala(s)")
    print(f"FEM: {fem_nodes.shape[0]} nodos\n")

    payload: dict = {
        "glb": args.glb.name,
        "mesh": "mesh.json",
        "grouping": args.group,
        "blades": {},
        "cases": {},
    }

    # Las tres palas son la **misma** geometría con otra transformación, así que el
    # ICP se hace una sola vez (en la primera) y se propaga a las demás con la
    # transformación relativa entre sus nodos. Correrlo por separado en cada una
    # engancha mal dos de cada tres: el giro alrededor del eje largo es ambiguo y
    # el ICP se queda en un mínimo local (medido: p95 de 81 mm frente a 11).
    names = list(groups)
    # De referencia, la que no tiene sufijo: es la que estaba en la escena original.
    reference = "base" if "base" in groups else names[0]
    if args.group == "azimuth":
        reference = names[0]
    # La referencia **primero**: las demás heredan su registro.
    names = [reference] + [name for name in names if name != reference]
    reference_matrix = matrices[groups[reference][0]]
    aligned: dict[str, np.ndarray] = {}
    alignments: dict[str, dict] = {}

    for suffix in names:
        nodes = groups[suffix]
        blade, primitives = blade_vertices(gltf, binary, matrices, nodes)
        name = "base" if suffix == "base" else suffix

        world = matrices[nodes[0]]
        if name in geometria:
            axis, root = geometria[name]
        else:
            axis = world[:3, :3] @ np.array([0.0, 1.0, 0.0])
            axis /= np.linalg.norm(axis)
            root = world[:3, 3] + axis * (
                blade_vertices_origin(gltf, binary, nodes[0]) * np.linalg.norm(world[:3, :3] @ np.array([0.0, 1.0, 0.0]))
            )

        # En `--group azimuth` las tres palas **no** son la misma malla (distinto
        # teselado: 59.944 / 57.853 / 55.914 vértices), así que heredar el
        # registro de otra no vale y cada una se registra por su cuenta.
        if suffix == reference or args.group == "azimuth":
            alignment = register(fem_nodes, blade, axis, root)
            points = alignment_out = alignment["points"]
            stats = alignment
        else:
            # Puntos FEM ya registrados, llevados a esta pala por la transformación
            # entre sus nodos: M_esta · M_referencia⁻¹.
            relative = world @ np.linalg.inv(reference_matrix)
            points = (relative @ np.hstack([aligned[reference], np.ones((aligned[reference].shape[0], 1))]).T).T[:, :3]
            distances, _ = cKDTree(blade).query(points, k=1)
            alignment_out = None
            stats = {
                "median": float(np.median(distances)),
                "p95": float(np.quantile(distances, 0.95)),
                "max": float(distances.max()),
                "rotation": relative[:3, :3].tolist(),
                "translation": relative[:3, 3].tolist(),
            }

        aligned[name] = points
        alignments[name] = stats

        payload["blades"][name] = {
            "nodes": [gltf["nodes"][index].get("name") for index in nodes],
            "vertexCount": int(blade.shape[0]),
            "primitives": primitives,
            "axis": axis.tolist(),
            "root": root.tolist(),
            "icp": {
                "median": stats["median"],
                "p95": stats["p95"],
                "max": stats["max"],
                "rotation": stats["rotation"],
                "translation": stats["translation"],
                "fromReference": None if (suffix == reference or args.group == "azimuth") else reference,
            },
        }
        print(
            f"pala «{name}»: {blade.shape[0]} verts · ICP mediana {stats['median'] * 1e3:.2f} mm · "
            f"p95 {stats['p95'] * 1e3:.2f} mm · max {stats['max'] * 1e3:.2f} mm"
        )
        if alignment_out is None:
            print(f"  (registro heredado de «{'base' if reference == 'base' else reference}»)")

        tree = cKDTree(points)
        for case_path in case_files:
            case = json.loads(case_path.read_text(encoding="utf-8"))
            magnitudes = np.array(case["magnitudes"], dtype=np.float64)
            values, far = interpolate(tree, magnitudes, blade)
            peak = max(float(values.max()), 1e-30)
            quantised = np.clip(np.round(values / peak * 255), 0, 255).astype(np.uint8)

            entry = payload["cases"].setdefault(case["case"], {"peaks": {}, "values": {}, "farNeighbour": {}})
            entry["peaks"][name] = peak
            entry["values"][name] = base64.b64encode(quantised.tobytes()).decode("ascii")
            entry["farNeighbour"][name] = float(np.quantile(far, 0.95))

    args.out.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    size = args.out.stat().st_size / 1024
    print(f"\n{args.out}  ({size:.0f} KB) · {len(case_files)} caso(s)")


def blade_vertices_origin(gltf: dict, binary: bytes, node_index: int) -> float:
    """`y` mínimo de la POSITION local del primer trozo: dónde empieza la raíz."""
    node = gltf["nodes"][node_index]
    primitive = gltf["meshes"][node["mesh"]]["primitives"][0]
    position = accessor_array(gltf, binary, primitive["attributes"]["POSITION"])
    return float(position[:, 1].min())


if __name__ == "__main__":
    main()
