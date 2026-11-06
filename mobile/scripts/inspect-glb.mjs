/**
 * Measures the *effective* bounding box of a `.glb` (node transforms included).
 *
 * Why this exists: the PnP pose is solved in the frame and units of
 * `3D_points.json`, and the twin is drawn with `OC4.glb` under that same pose.
 * If the two did not share a frame and a scale, the overlay would be exact at
 * the keypoints and wrong everywhere else (or the twin would be invisible,
 * because a 30× scale error puts it either around the camera or far away).
 *
 * Usage: node scripts/inspect-glb.mjs public/models/OC4.glb
 */
import { readFileSync } from 'node:fs';

/** Minimal column-major 4×4 maths (glTF order), enough to compose TRS nodes. */
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
            let sum = 0;
            for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
            out[column * 4 + row] = sum;
        }
    }
    return out;
}

function fromTRS(node) {
    if (node.matrix) return node.matrix.slice();
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        tx, ty, tz, 1,
    ];
}

function transformPoint(m, p) {
    const [x, y, z] = p;
    return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
}

function readGlb(path) {
    const buffer = readFileSync(path);
    if (buffer.toString('utf8', 0, 4) !== 'glTF') throw new Error('not a binary glTF');
    let offset = 12;
    while (offset < buffer.length) {
        const length = buffer.readUInt32LE(offset);
        const type = buffer.toString('utf8', offset + 4, offset + 8);
        if (type === 'JSON') {
            return JSON.parse(buffer.toString('utf8', offset + 8, offset + 8 + length));
        }
        offset += 8 + length;
    }
    throw new Error('no JSON chunk');
}

const target = process.argv[2] ?? 'public/models/OC4.glb';
const gltf = readGlb(target);

const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
let meshes = 0;

function visit(index, parent) {
    const node = gltf.nodes[index] ?? {};
    const world = multiply(parent, fromTRS(node));
    if (typeof node.mesh === 'number') {
        meshes += 1;
        for (const primitive of gltf.meshes[node.mesh].primitives ?? []) {
            const accessor = gltf.accessors[primitive.attributes?.POSITION];
            if (!accessor?.min || !accessor?.max) continue;
            // Corners of the local box, pushed through the accumulated transform.
            for (let corner = 0; corner < 8; corner += 1) {
                const local = [0, 1, 2].map((axis) =>
                    (corner >> axis) & 1 ? accessor.max[axis] : accessor.min[axis]
                );
                const point = transformPoint(world, local);
                for (let axis = 0; axis < 3; axis += 1) {
                    min[axis] = Math.min(min[axis], point[axis]);
                    max[axis] = Math.max(max[axis], point[axis]);
                }
            }
        }
    }
    for (const child of node.children ?? []) visit(child, world);
}

for (const root of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) visit(root, identity());

const size = [0, 1, 2].map((axis) => max[axis] - min[axis]);
const centre = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2);
const fmt = (values) => values.map((value) => value.toFixed(3)).join('  ');

console.log(`${target}: ${meshes} meshes in ${gltf.nodes?.length ?? 0} nodes`);
console.log(`  bbox min   ${fmt(min)}`);
console.log(`  bbox max   ${fmt(max)}`);
console.log(`  size       ${fmt(size)}   (x  y  z, three.js Y-up)`);
console.log(`  centre     ${fmt(centre)}`);
console.log(
    '  reference: the 11 keypoints span x[-0.278, 0.280] y[0.340, 1.145] z[-0.429, 0.003]'
);
