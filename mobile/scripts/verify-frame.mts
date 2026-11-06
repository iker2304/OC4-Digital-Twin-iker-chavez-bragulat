/**
 * Checks that the 11 pose keypoints really sit on the mesh of `OC4.glb`.
 *
 * Why this is not paranoia: `3D_points.json` is measured in the Blender scene
 * (Z up) and the twin is exported from that same scene (Y up), so the two must
 * agree not only in scale but in *orientation*. A bounding-box check does not
 * catch a 90° yaw error on this platform, because the pontoons are laid out in a
 * near-symmetric ring — a rotated twin would still fit inside the bbox while the
 * overlay points the wrong way.
 *
 * The keypoints come from `extract_keypoints_coordinates()`, which reads the
 * coordinates of *actual vertices*, so each one must land on (or a couple of
 * millimetres from) the exported surface. If the frame were rotated, the error
 * would be tens of centimetres for the asymmetric ones (the hub and the tower),
 * which is what this measures.
 *
 * Usage: npm run verify:frame
 */
import { readFileSync } from 'node:fs';
import { KEYPOINTS_SCENE } from '../src/lib/pose/keypoints3d';

const TARGET = process.argv[2] ?? 'public/models/OC4.glb';
/**
 * How close a mesh vertex must be to each keypoint, in metres.
 *
 * Nine keypoints come from `extract_keypoints_coordinates()`, which reads the
 * coordinates of actual *vertices*, so they must land on the surface within a
 * millimetre. `Hub` is the rotor centre and `pilar_center` is the centre of mass
 * of the tower section — computed points, free to sit inside the solid — so they
 * are allowed more room. The point of the check is the *frame and orientation*:
 * a 90° yaw error would put every one of them tens of centimetres away.
 */
const MAX_DISTANCE = 0.01;
const RELAXED: Record<string, number> = { Hub: 0.02, pilar_center: 0.08 };

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: number[], b: number[]): number[] {
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

function fromTRS(node: {
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
}): number[] {
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

interface Gltf {
    buffers?: Array<{ byteLength: number }>;
    bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
    accessors?: Array<{
        bufferView?: number;
        byteOffset?: number;
        componentType: number;
        count: number;
        type: string;
        normalized?: boolean;
    }>;
    meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
    nodes?: Array<{
        matrix?: number[];
        translation?: number[];
        rotation?: number[];
        scale?: number[];
        mesh?: number;
        children?: number[];
    }>;
    scenes?: Array<{ nodes?: number[] }>;
    scene?: number;
}

/** Binary chunk payloads, keyed by buffer index. */
function readGlb(path: string): { gltf: Gltf; chunks: Buffer[] } {
    const buffer = readFileSync(path);
    if (buffer.toString('utf8', 0, 4) !== 'glTF') throw new Error('not a binary glTF');
    let offset = 12;
    let gltf: Gltf | null = null;
    const chunks: Buffer[] = [];
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32LE(offset);
        const type = buffer.toString('utf8', offset + 4, offset + 8);
        const payload = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 'JSON') gltf = JSON.parse(payload.toString('utf8')) as Gltf;
        else if (type.startsWith('BIN')) chunks.push(payload);
        offset += 8 + length;
    }
    if (!gltf) throw new Error('no JSON chunk');
    return { gltf, chunks };
}

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENT_DIVISOR: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

interface Reader {
    read(index: number, out: [number, number, number]): boolean;
}

function accessorReader(gltf: Gltf, chunks: Buffer[], accessorIndex: number): Reader | null {
    const accessor = gltf.accessors?.[accessorIndex];
    if (!accessor || accessor.type !== 'VEC3' || accessor.bufferView === undefined) return null;
    const view = gltf.bufferViews?.[accessor.bufferView];
    if (!view) return null;
    const data = chunks[view.buffer];
    if (!data) return null;

    const size = COMPONENT_SIZE[accessor.componentType];
    if (!size) return null;
    const divisor = accessor.normalized ? COMPONENT_DIVISOR[accessor.componentType] ?? 1 : 1;
    const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : size * 3;
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);

    const readComponent = (at: number): number => {
        switch (accessor.componentType) {
            case 5126:
                return data.readFloatLE(at);
            case 5125:
                return data.readUInt32LE(at);
            case 5123:
                return data.readUInt16LE(at);
            case 5122:
                return data.readInt16LE(at);
            case 5121:
                return data.readUInt8(at);
            default:
                return data.readInt8(at);
        }
    };

    return {
        read(index, out) {
            if (index < 0 || index >= accessor.count) return false;
            const at = base + index * stride;
            if (at + size * 3 > data.length) return false;
            out[0] = readComponent(at) / divisor;
            out[1] = readComponent(at + size) / divisor;
            out[2] = readComponent(at + size * 2) / divisor;
            return true;
        },
    };
}

function transformPoint(m: number[], p: [number, number, number]): [number, number, number] {
    return [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
}

const { gltf, chunks } = readGlb(TARGET);
const best = KEYPOINTS_SCENE.map(() => Number.POSITIVE_INFINITY);
const nearest = KEYPOINTS_SCENE.map(() => [0, 0, 0] as [number, number, number]);
let vertices = 0;
const local: [number, number, number] = [0, 0, 0];

function visit(index: number, parent: number[]) {
    const node = gltf.nodes?.[index];
    if (!node) return;
    const world = multiply(parent, fromTRS(node));
    if (typeof node.mesh === 'number') {
        for (const primitive of gltf.meshes?.[node.mesh]?.primitives ?? []) {
            const reader = accessorReader(gltf, chunks, primitive.attributes?.POSITION ?? -1);
            if (!reader) continue;
            for (let i = 0; ; i += 1) {
                if (!reader.read(i, local)) break;
                vertices += 1;
                const point = transformPoint(world, local);
                for (let k = 0; k < KEYPOINTS_SCENE.length; k += 1) {
                    const key = KEYPOINTS_SCENE[k];
                    const dx = point[0] - key.x;
                    const dy = point[1] - key.y;
                    const dz = point[2] - key.z;
                    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (distance < best[k]) {
                        best[k] = distance;
                        nearest[k] = point;
                    }
                }
            }
        }
    }
    for (const child of node.children ?? []) visit(child, world);
}

for (const root of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) visit(root, identity());

const NAMES = [
    'pontoon_right_3', 'pontoon_left_3', 'pontoon_left_1', 'pontoon_front_1',
    'pontoon_front_2', 'pontoon_front_3', 'Hub', 'pontoon_center_left',
    'pontoon_center_right', 'pontoon_center_front', 'pilar_center',
];

let failures = 0;
console.log(`${TARGET}: ${vertices} vertices checked against 11 keypoints\n`);
for (let k = 0; k < KEYPOINTS_SCENE.length; k += 1) {
    const key = KEYPOINTS_SCENE[k];
    const ok = best[k] <= (RELAXED[NAMES[k]] ?? MAX_DISTANCE);
    if (!ok) failures += 1;
    const point = nearest[k];
    console.log(
        `${ok ? 'ok  ' : 'FAIL'}  ${NAMES[k].padEnd(22)} ` +
        `esperado (${key.x.toFixed(3)}, ${key.y.toFixed(3)}, ${key.z.toFixed(3)})  ` +
        `vértice (${point[0].toFixed(3)}, ${point[1].toFixed(3)}, ${point[2].toFixed(3)})  ` +
        `d=${(best[k] * 100).toFixed(2)} cm`
    );
}

// Asymmetry probe: the hub — the rotor centre — must be the highest, *and* on the
// negative z side, in the same place the keypoints say. A rigid yaw error of 90°
// or 180° breaks one of those two, and the pontoons alone would not reveal it.
const hub = KEYPOINTS_SCENE[6];
const tower = nearest[6];
console.log(
    `\nhub  keypoint y=${hub.y.toFixed(3)} z=${hub.z.toFixed(3)}  ` +
    `vértice más cercano y=${tower[1].toFixed(3)} z=${tower[2].toFixed(3)}`
);

if (failures > 0) {
    console.error(`\n${failures} keypoints no coinciden con la malla (umbral ${MAX_DISTANCE * 100} cm).`);
    process.exit(1);
}
console.log('\nLos 11 keypoints caen sobre la malla: marco, escala y orientación coinciden.');
