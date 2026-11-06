/**
 * Blade geometry of `OC4.glb` for the rotor-angle fit.
 *
 * The base pose (11 keypoints on the pontoon/tower) is a single rigid transform,
 * so it fixes everything except how far the rotor has turned. The model's
 * `Rotor` class already emits blade keypoints, so that last degree of freedom
 * can be *measured*: project the three blade segments for a candidate angle and
 * keep the angle whose segments pass through the detected blade points.
 *
 * This script produces the three segments, in the frame the 3D keypoints live in
 * (the glTF frame, metres). The blade meshes are called `MeshBody1 (2)…` and
 * carry no colour that identifies the blade, so they are clustered by azimuth
 * around the hub instead of by material.
 *
 * Usage: node scripts/blade-axes.mjs public/models/OC4.glb
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'public/models/OC4.glb';
const buf = readFileSync(file);
const jsonLength = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
const bin = buf.subarray(20 + jsonLength + 8);

const nodes = gltf.nodes ?? [];
const parentOf = new Map();
nodes.forEach((node, index) => {
    for (const child of node.children ?? []) parentOf.set(child, index);
});

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

const worldMatrix = (index) => {
    let matrix = localMatrix(nodes[index]);
    let parent = parentOf.get(index);
    while (parent !== undefined) {
        matrix = mul(localMatrix(nodes[parent]), matrix);
        parent = parentOf.get(parent);
    }
    return matrix;
};

const apply = (m, [x, y, z]) => [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
];

const accessorFloats = (index) => {
    const accessor = gltf.accessors[index];
    const view = gltf.bufferViews[accessor.bufferView];
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = view.byteStride ?? 0;
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
    const values = [];
    for (let i = 0; i < accessor.count; i++) {
        const base = offset + i * (stride || components * 4);
        const out = [];
        for (let c = 0; c < components; c++) out.push(bin.readFloatLE(base + c * 4));
        values.push(components === 1 ? out[0] : out);
    }
    return values;
};

const rotorIndex = nodes.findIndex((node) => node.name === 'rotate');
if (rotorIndex < 0) {
    console.log('No hay nodo "rotate" en el GLB.');
    process.exit(1);
}
const hub = apply(worldMatrix(rotorIndex), [0, 0, 0]);

const meshes = [];
const walk = (index, parentMatrix) => {
    const node = nodes[index];
    const matrix = mul(parentMatrix, localMatrix(node));
    if (node.mesh !== undefined) meshes.push({ index, matrix });
    for (const child of node.children ?? []) walk(child, matrix);
};
walk(rotorIndex, localMatrix(nodes[rotorIndex]));

const perMesh = [];
for (const { index, matrix } of meshes) {
    const mesh = gltf.meshes[nodes[index].mesh];
    for (const primitive of mesh.primitives) {
        const points = accessorFloats(primitive.attributes.POSITION).map((p) =>
            apply(matrix, p)
        );
        if (points.length === 0) continue;
        const centroid = points.reduce(
            (acc, p) => [
                acc[0] + p[0] / points.length,
                acc[1] + p[1] / points.length,
                acc[2] + p[2] / points.length,
            ],
            [0, 0, 0]
        );
        const distances = points.map((p) =>
            Math.hypot(p[0] - hub[0], p[1] - hub[1], p[2] - hub[2])
        );
        perMesh.push({
            name: nodes[index].name,
            material: gltf.materials?.[primitive.material]?.name ?? '?',
            count: points.length,
            rel: centroid.map((v, i) => v - hub[i]),
            min: Math.min(...distances),
            max: Math.max(...distances),
        });
    }
}

console.log(`buje: ${hub.map((v) => v.toFixed(4)).join(', ')}`);
console.log(`${perMesh.length} primitivas bajo el rotor\n`);
for (const mesh of perMesh) {
    const radius = Math.hypot(mesh.rel[0], mesh.rel[1]);
    console.log(
        `${mesh.name.padEnd(26)} ${mesh.material.padEnd(30)} r=${radius.toFixed(3)} ` +
        `az=${((Math.atan2(mesh.rel[1], mesh.rel[0]) * 180) / Math.PI).toFixed(1)}° ` +
        `[${mesh.min.toFixed(3)}..${mesh.max.toFixed(3)}]`
    );
}
