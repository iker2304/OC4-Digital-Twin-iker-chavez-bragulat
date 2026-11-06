/**
 * Counts the rotor blades in a GLB and prints their azimuths.
 *
 * It exists because `OC4.glb` turned out to have a **single** blade in its
 * geometry: the three `Blade_*` nodes are empty placeholders, and every rotor
 * vertex sits between 60° and 120° around the hub. That matters for the twin —
 * it is not a pose problem, the asset is missing two blades.
 *
 * Usage: node scripts/count-blades.mjs public/models/OC4.glb [hubY]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'public/models/OC4.glb';
const buf = readFileSync(file);
const jsonLength = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
const bin = buf.subarray(20 + jsonLength + 8);

const nodes = gltf.nodes ?? [];
const parents = new Set();
nodes.forEach((node) => (node.children ?? []).forEach((child) => parents.add(child)));
const roots = nodes.map((_, index) => index).filter((index) => !parents.has(index));

const mul = (a, b) => {
    const out = new Array(16).fill(0);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
            out[col * 4 + row] = sum;
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

const points = [];
const walk = (index, parentMatrix) => {
    const node = nodes[index];
    const matrix = mul(parentMatrix, localMatrix(node));
    if (node.mesh !== undefined) {
        for (const primitive of gltf.meshes[node.mesh].primitives) {
            const accessor = gltf.accessors[primitive.attributes.POSITION];
            const view = gltf.bufferViews[accessor.bufferView];
            const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
            const stride = view.byteStride ?? 12;
            for (let i = 0; i < accessor.count; i++) {
                const base = offset + i * stride;
                points.push(
                    apply(
                        matrix,
                        bin.readFloatLE(base),
                        bin.readFloatLE(base + 4),
                        bin.readFloatLE(base + 8)
                    )
                );
            }
        }
    }
    for (const child of node.children ?? []) walk(child, matrix);
};

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
for (const root of roots) walk(root, identity);

const maxY = points.reduce((best, p) => (p[1] > best ? p[1] : best), -Infinity);
const minY = points.reduce((best, p) => (p[1] < best ? p[1] : best), Infinity);
const maxX = points.reduce((best, p) => (p[0] > best ? p[0] : best), -Infinity);
const minX = points.reduce((best, p) => (p[0] < best ? p[0] : best), Infinity);
console.log(`${file}: ${points.length} vértices`);
console.log(`  bbox x [${minX.toFixed(3)}, ${maxX.toFixed(3)}]  y [${minY.toFixed(3)}, ${maxY.toFixed(3)}]`);

// The hub is the topmost rotor part; the blade crown is measured from there.
const hubY = Number(process.argv[3] ?? maxY - 0.63);
const hubZ = Number(process.argv[4] ?? -0.2576);
const bins = new Map();
let counted = 0;
for (const [x, y, z] of points) {
    const radius = Math.hypot(x, y - hubY, z - hubZ);
    if (radius < 0.30 || radius > 0.75) continue;
    counted += 1;
    const azimuth = ((Math.atan2(y - hubY, x) * 180) / Math.PI + 360) % 360;
    const bucket = Math.round(azimuth / 15) * 15 % 360;
    bins.set(bucket, (bins.get(bucket) ?? 0) + 1);
}
console.log(`  corona del rotor (0.30-0.75 m del buje en y=${hubY.toFixed(3)}): ${counted} vértices`);
for (const bucket of [...bins.keys()].sort((a, b) => a - b)) {
    console.log(`    ${String(bucket).padStart(3)}° ${bins.get(bucket)}`);
}

// Radius range per blade sector: the fit projects the whole segment, so the
// root and the tip matter, not only the direction.
const ranges = new Map();
for (const [x, y, z] of points) {
    const radius = Math.hypot(x, y - hubY, z - hubZ);
    if (radius < 0.05 || radius > 0.8) continue;
    const azimuth = ((Math.atan2(y - hubY, x) * 180) / Math.PI + 360) % 360;
    const bucket = Math.round(azimuth / 15) * 15 % 360;
    const entry = ranges.get(bucket) ?? { min: Infinity, max: 0 };
    entry.min = Math.min(entry.min, radius);
    entry.max = Math.max(entry.max, radius);
    ranges.set(bucket, entry);
}
console.log('  radios por sector:');
for (const bucket of [...ranges.keys()].sort((a, b) => a - b)) {
    const { min, max } = ranges.get(bucket);
    console.log(`    ${String(bucket).padStart(3)}°  r ${min.toFixed(3)} .. ${max.toFixed(3)}`);
}
