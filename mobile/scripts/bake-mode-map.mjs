/**
 * Bakes the modal color map for the twin.
 *
 * The modal analysis in the repo (`web/public/OC4-modal/`) is stored per *solver
 * node*, in Blender coordinates and millimetres. The twin is a glTF, Y-up, in
 * metres, with a completely different vertex order — and `OC4-modal_res.json` is
 * 41 MB, which no phone should download to tint a model.
 *
 * So this script does the join once, offline: for every vertex of `OC4.glb` it
 * finds the nearest solver node and stores that node's displacement magnitude,
 * quantised to one byte and normalised per mode. The result is a few hundred KB
 * that the app can apply directly as vertex colours.
 *
 * Usage: node scripts/bake-mode-map.mjs [--out public/models/oc4-mode-map.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
};

const GLB = value('glb', 'public/models/OC4.glb');
const MODAL_DIR = value('modal', '../web/public/OC4-modal');
const OUT = value('out', 'public/models/oc4-mode-map.json');

/* ------------------------------------------------------------------ glTF */

const buffer = readFileSync(GLB);
const jsonLength = buffer.readUInt32LE(12);
const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
const binary = buffer.subarray(20 + jsonLength + 8);

const nodes = gltf.nodes ?? [];
const parents = new Set();
nodes.forEach((node) => (node.children ?? []).forEach((child) => parents.add(child)));
const roots = nodes.map((_, index) => index).filter((index) => !parents.has(index));

const multiply = (a, b) => {
    const out = new Array(16).fill(0);
    for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 4; column += 1) {
            let sum = 0;
            for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
            out[column * 4 + row] = sum;
        }
    }
    return out;
};

const localMatrix = (node) => {
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        tx, ty, tz, 1,
    ];
};

const apply = (m, x, y, z) => [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
];

const positions = [];
const walk = (index, parentMatrix) => {
    const node = nodes[index];
    const matrix = multiply(parentMatrix, localMatrix(node));
    if (node.mesh !== undefined) {
        for (const primitive of gltf.meshes[node.mesh].primitives) {
            const accessor = gltf.accessors[primitive.attributes.POSITION];
            const view = gltf.bufferViews[accessor.bufferView];
            const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
            const stride = view.byteStride ?? 12;
            for (let i = 0; i < accessor.count; i += 1) {
                const base = offset + i * stride;
                positions.push(
                    apply(
                        matrix,
                        binary.readFloatLE(base),
                        binary.readFloatLE(base + 4),
                        binary.readFloatLE(base + 8)
                    )
                );
            }
        }
    }
    for (const child of node.children ?? []) walk(child, matrix);
};

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
for (const root of roots) walk(root, identity);
console.log(`vértices del gemelo: ${positions.length}`);

/* ------------------------------------------------------- modal solver data */

const meshNodes = JSON.parse(readFileSync(path.join(MODAL_DIR, 'OC4-modal_mesh.json'), 'utf8')).nodes;
const results = JSON.parse(readFileSync(path.join(MODAL_DIR, 'OC4-modal_res.json'), 'utf8')).modes;

/** Solver node positions in metres, glTF frame: (x, z, −y) and mm → m. */
const nodePositions = new Map();
for (const [id, [x, y, z]] of Object.entries(meshNodes)) {
    nodePositions.set(id, [x / 1000, z / 1000, -y / 1000]);
}
console.log(`nodos del solver: ${nodePositions.size}`);

/** Spatial hash so the nearest-node lookup is not 400k × 56k. */
const CELL = 0.08;
const grid = new Map();
const cellKey = (x, y, z) =>
    `${Math.floor(x / CELL)}|${Math.floor(y / CELL)}|${Math.floor(z / CELL)}`;
for (const [id, [x, y, z]] of nodePositions) {
    const key = cellKey(x, y, z);
    const bucket = grid.get(key);
    if (bucket) bucket.push(id);
    else grid.set(key, [id]);
}

const nearestNode = (x, y, z) => {
    let best = null;
    let bestDistance = Infinity;
    for (let radius = 0; radius <= 16; radius += 1) {
        const cx = Math.floor(x / CELL);
        const cy = Math.floor(y / CELL);
        const cz = Math.floor(z / CELL);
        for (let dx = -radius; dx <= radius; dx += 1) {
            for (let dy = -radius; dy <= radius; dy += 1) {
                for (let dz = -radius; dz <= radius; dz += 1) {
                    const bucket = grid.get(`${cx + dx}|${cy + dy}|${cz + dz}`);
                    if (!bucket) continue;
                    for (const id of bucket) {
                        const [nx, ny, nz] = nodePositions.get(id);
                        const distance = (nx - x) ** 2 + (ny - y) ** 2 + (nz - z) ** 2;
                        if (distance < bestDistance) {
                            bestDistance = distance;
                            best = id;
                        }
                    }
                }
            }
        }
        // El gemelo y el modelo del solver no son la misma malla: si a 16 celdas
        // no hay nodo, se para (el más cercano ya está encontrado de todas formas).
        if (best) break;
    }
    return best;
};

/** One entry per vertex: the solver node it belongs to. */
const vertexNode = new Array(positions.length);
for (let i = 0; i < positions.length; i += 1) {
    const [x, y, z] = positions[i];
    vertexNode[i] = nearestNode(x, y, z);
}

const unmatched = vertexNode.filter((id) => id === null).length;
console.log(`vértices sin nodo cercano: ${unmatched} (${((100 * unmatched) / positions.length).toFixed(1)} %)`);

const MODES = [
    ['Mode_1_(Freq.:_0.7196)', 'Surge', 0.51, 'x'],
    ['Mode_2_(Freq.:_0.7197)', 'Sway', 0.57, 'y'],
    ['Mode_3_(Freq.:_4.224)', 'Heave', 2.05, 'z'],
];
const available = Object.keys(results);
const chosen = MODES.filter(([key]) => available.includes(key));

/**
 * Se emite en formato compacto: por vértice solo el **índice de nodo** (uint16)
 * y por nodo el **vector de forma** en int8 normalizado. Con magnitudes sueltas
 * no se puede deformar la malla ni ver un gradiente direccional, y guardar el
 * vector por vértice costaría el triple.
 */
const nodeList = [...nodePositions.keys()];
const nodeIds = new Map(nodeList.map((id, index) => [id, index]));
const nodeIndex = new Uint16Array(positions.length);
for (let i = 0; i < positions.length; i += 1) {
    nodeIndex[i] = nodeIds.get(vertexNode[i]) ?? 0;
}

const encodedModes = chosen.map(([key, label, freqHz, axis]) => {
    const shapes = results[key]?.Modes ?? {};
    let peak = 0;
    for (const id of nodeList) {
        const phi = shapes[id];
        if (!phi) continue;
        peak = Math.max(peak, Math.abs(phi[0]), Math.abs(phi[1]), Math.abs(phi[2]));
    }
    const scale = peak > 0 ? 127 / peak : 0;
    const data = new Int8Array(nodeList.length * 3);
    nodeList.forEach((id, position) => {
        const phi = shapes[id];
        if (!phi) return;
        data[position * 3] = Math.round(phi[0] * scale);
        data[position * 3 + 1] = Math.round(phi[1] * scale);
        data[position * 3 + 2] = Math.round(phi[2] * scale);
    });
    const nonzero = data.reduce((count, value) => count + (value !== 0 ? 1 : 0), 0);
    console.log(
        `  ${label}: pico ${peak.toFixed(1)} · ${nonzero} componentes no nulas de ${data.length}`
    );
    return {
        label,
        freqHz,
        axis,
        peak,
        bytes: data,
    };
});

/**
 * Se emiten **binarios**, no base64: `atob` sobre cadenas de un mega es frágil
 * (y en algunos navegadores revienta con "String contains an invalid character"),
 * y en binario el asset pesa un 25 % menos.
 */
writeFileSync(path.join(path.dirname(OUT), 'oc4-mode-nodeindex.bin'), Buffer.from(nodeIndex.buffer));

const metadata = {
    vertexCount: positions.length,
    nodeCount: nodeList.length,
    nodeIndex: 'oc4-mode-nodeindex.bin',
    modes: chosen.map(([key, label, freqHz, axis], index) => {
        const entry = encodedModes[index];
        const fileName = `oc4-mode-${index}.bin`;
        writeFileSync(path.join(path.dirname(OUT), fileName), Buffer.from(entry.bytes));
        return { label, freqHz, axis, peak: entry.peak, file: fileName };
    }),
};
writeFileSync(OUT, JSON.stringify(metadata, null, 2));
console.log(`\nescrito ${OUT} + ${1 + metadata.modes.length} binarios`);
