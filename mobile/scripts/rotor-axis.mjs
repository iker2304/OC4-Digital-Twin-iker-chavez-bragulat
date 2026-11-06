/**
 * Finds the rotor's spin axis in the GLB.
 *
 * The twin is driven by one rigid PnP pose over 11 keypoints, none of which
 * encode the blade azimuth, so the model always shows the rotor at whatever
 * angle it was exported with. To let the user line the blades up with the real
 * machine we need the node that rotates and the local axis it rotates about.
 *
 * Usage: node scripts/rotor-axis.mjs public/models/OC4.glb
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'public/models/OC4.glb';
const buf = readFileSync(file);
const jsonLength = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));

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
    // Column-major, like glTF and three.js.
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

const position = (matrix) => [matrix[12], matrix[13], matrix[14]];

const rotateIndex = nodes.findIndex((node) => node.name === 'rotate');
if (rotateIndex < 0) {
    console.log('No hay nodo "rotate" en el GLB.');
    process.exit(1);
}

const rotateWorld = worldMatrix(rotateIndex);
const origin = position(rotateWorld);

// Blades: either named Blade_* or the mesh nodes under the "rotate" group.
const blades = [];
const collect = (index, depth = 0) => {
    const node = nodes[index];
    if (/blade|pala/i.test(node.name ?? '')) blades.push(index);
    for (const child of node.children ?? []) collect(child, depth + 1);
};
collect(rotateIndex);

console.log(`nodo "rotate": ${rotateIndex} (${nodes[rotateIndex].name})`);
console.log(`origen en mundo: ${origin.map((v) => v.toFixed(4)).join(', ')}`);
console.log(`hijos directos: ${(nodes[rotateIndex].children ?? []).length}`);

for (const index of blades) {
    const world = worldMatrix(index);
    const p = position(world);
    const rel = p.map((v, i) => v - origin[i]);
    console.log(
        `  ${nodes[index].name}  rel [${rel.map((v) => v.toFixed(4)).join(', ')}]` +
        `  dist ${Math.hypot(...rel).toFixed(4)}`
    );
}
