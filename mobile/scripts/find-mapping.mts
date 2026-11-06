/**
 * Finds the true detection-index → 3D-point correspondence.
 *
 * Why: with the keypoint order taken from `keypoint_mapping.json` the solver
 * refuses the pose even when the model returns eleven keypoints at 0.95
 * confidence. Two naming schemes exist in the repository (the annotation YAML
 * that trained the model, and `3D_points.json` that has the coordinates) and the
 * bridge file between them mixes both, so its order cannot be trusted.
 *
 * The photo settles it mechanically. The structure is decisive:
 *
 *  - Four of the nine pontoon points are collinear in 3D (all with y = −0.003)
 *    and four image points are collinear too, so the group is identified and the
 *    order along the line is forced.
 *  - Two of the eleven 3D points are well above the pontoon plane (the hub and
 *    the base of the tower) and two image points sit far above the rest, so that
 *    pair is identified up to a swap.
 *  - What is left is a handful of orderings, and the correct one is simply the
 *    one the real solver accepts with the smallest reprojection error.
 *
 * Usage: npm run find:mapping [ruta.png]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as ort from 'onnxruntime-web';

import { prepareInput } from '../src/lib/inference/tensor';
import { analyseOutput, decodeOutput } from '../src/lib/inference/decode';
import { resolveLabels } from '../src/lib/labels';
import { KEYPOINTS_SCENE, KEYPOINT_NAMES } from '../src/lib/pose/keypoints3d';
import { computeLetterbox, unletterboxBox, unletterboxPoint } from '../src/lib/geometry';
import { intrinsicsFromFov, solvePnP } from '../src/lib/pose/solvePnP';
import { solveLinearSystem } from '../src/lib/pose/linalg';

const PHOTO = process.argv[2] ?? '../image.png';
const MODEL = process.argv[3] ?? 'public/models/yolo-pose-s-640.onnx';
const HFOV = Number(process.argv[4] ?? 68);

const target = globalThis as unknown as { document?: unknown };
target.document = { createElement: (tag: string) => (tag === 'canvas' ? createCanvas(1, 1) : {}) };
ort.env.logLevel = 'error';
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = pathToFileURL(
    join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist') + '/'
).href;

const image = await loadImage(readFileSync(PHOTO));
const session = await ort.InferenceSession.create(readFileSync(MODEL), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
});
const holder = session as unknown as { inputMetadata?: { name: string; shape?: unknown[] }[]; outputMetadata?: { shape?: unknown[] }[] };
const inputShape = (holder.inputMetadata?.[0]?.shape ?? []).map(Number);
const inputSize = inputShape[2] > 0 ? inputShape[2] : 640;
const layout = inputShape[1] === 3 ? 'nchw' : 'nhwc';
const analysis = analyseOutput((holder.outputMetadata?.[0]?.shape ?? []).map(Number));
if (!analysis) throw new Error('salida no analizable');

const prepared = prepareInput(image, image.width, image.height, inputSize, layout, 'zero-one');
const outputs = await session.run({ [holder.inputMetadata?.[0]?.name ?? 'images']: prepared.tensor });
const raw = (outputs[session.outputNames[0]] ?? Object.values(outputs)[0]).data as Float32Array;

const box = computeLetterbox(image.width, image.height, inputSize);
const detections = decodeOutput(raw, analysis, resolveLabels(analysis.numClasses, null), {
    confidence: 0.3,
    iou: 0.45,
    maxDetections: 30,
}).detections.map((detection) => ({
    ...detection,
    bbox: unletterboxBox(detection.bbox, box),
    keypoints: detection.keypoints?.map((keypoint) => {
        const [x, y] = unletterboxPoint(keypoint.x, keypoint.y, box);
        return { ...keypoint, x, y };
    }),
}));

// The best detection is the one with the most confident keypoints.
const best = detections
    .filter((detection) => detection.keypoints?.length)
    .sort((a, b) => (b.keypoints?.length ?? 0) - (a.keypoints?.length ?? 0))[0];
if (!best?.keypoints) throw new Error('ninguna detección trae keypoints');

const points2d = best.keypoints.map((keypoint) => [keypoint.x, keypoint.y] as [number, number]);
console.log(`detección "${best.label}" score ${best.score.toFixed(3)} · ${points2d.length} keypoints\n`);
points2d.forEach(([x, y], index) => {
    console.log(`  imagen ${String(index).padStart(2)}  (${x.toFixed(0)}, ${y.toFixed(0)})`);
});

/** Euclidean distance between two points, in whatever units. */
function distance(a: readonly number[], b: readonly number[]): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * The assignment is anchored on the extremes of the distance matrix.
 *
 * Collinearity was tried first and is useless here: at this resolution the whole
 * platform spans ~150 px, so the keypoints' own 2–3 px of noise makes two
 * different four-point lines fit equally well. Distances are far more robust,
 * because perspective preserves their *order*: the pair that is closest in the
 * model is the pair that is closest in the image, and the same for the farthest.
 */
const planePoints3d = KEYPOINTS_SCENE.map((point, index) => ({ point, index })).filter(
    (entry) => entry.point.y < 0.5
);
const elevated3d = KEYPOINTS_SCENE.map((point, index) => ({ point, index })).filter(
    (entry) => entry.point.y >= 0.5
);

// Two image points far above the pontoon band are the hub and the tower base.
const imageY = points2d.map(([, y]) => y);
const bandTop = Math.min(...imageY);
const elevated2d = points2d
    .map((_, index) => index)
    .sort((a, b) => imageY[a] - imageY[b])
    .slice(0, elevated3d.length);
const plane2d = points2d.map((_, index) => index).filter((index) => !elevated2d.includes(index));

console.log(
    `plano: imagen ${plane2d.length} puntos · 3D ${planePoints3d.length} puntos  |  ` +
    `elevados: imagen ${elevated2d.join(', ')} · 3D ${elevated3d.map((e) => KEYPOINT_NAMES[e.index]).join(', ')}`
);

const pairs3d: { a: number; b: number; d: number }[] = [];
for (let i = 0; i < planePoints3d.length; i += 1) {
    for (let j = i + 1; j < planePoints3d.length; j += 1) {
        const pa = planePoints3d[i].point;
        const pb = planePoints3d[j].point;
        pairs3d.push({ a: i, b: j, d: distance([pa.x, pa.y, pa.z], [pb.x, pb.y, pb.z]) });
    }
}
pairs3d.sort((a, b) => a.d - b.d);
const closest3d = pairs3d[0];
const farthest3d = pairs3d[pairs3d.length - 1];

const pairs2d: { a: number; b: number; d: number }[] = [];
for (let i = 0; i < plane2d.length; i += 1) {
    for (let j = i + 1; j < plane2d.length; j += 1) {
        const [ax, ay] = points2d[plane2d[i]];
        const [bx, by] = points2d[plane2d[j]];
        pairs2d.push({ a: i, b: j, d: Math.hypot(ax - bx, ay - by) });
    }
}
pairs2d.sort((a, b) => a.d - b.d);
const closest2d = pairs2d[0];
const farthest2d = pairs2d[pairs2d.length - 1];

console.log(
    `par más cercano 3D: ${KEYPOINT_NAMES[planePoints3d[closest3d.a].index]}/` +
    `${KEYPOINT_NAMES[planePoints3d[closest3d.b].index]} (${(closest3d.d * 100).toFixed(1)} cm)  ·  ` +
    `en la imagen: ${plane2d[closest2d.a]}/${plane2d[closest2d.b]} (${closest2d.d.toFixed(1)} px)`
);
console.log(
    `par más lejano 3D: ${KEYPOINT_NAMES[planePoints3d[farthest3d.a].index]}/` +
    `${KEYPOINT_NAMES[planePoints3d[farthest3d.b].index]} (${(farthest3d.d * 100).toFixed(1)} cm)  ·  ` +
    `en la imagen: ${plane2d[farthest2d.a]}/${plane2d[farthest2d.b]} (${farthest2d.d.toFixed(1)} px)`
);

/**
 * Plane→image homography from 3D (x, z) to pixels, least squares over all nine
 * coplanar points. With 8 degrees of freedom and 9 points a *wrong*
 * correspondence cannot hide: its residual explodes, which is what makes an
 * exhaustive search affordable — the homography costs microseconds and rejects
 * 99.9% of the candidates before the real solver is ever called.
 */
/**
 * The nine planar keypoints are not a shapeless cloud: they are three tight
 * triangles, one at the end of each pontoon. In the model each triple spans
 * ~6 cm; in the photo the same three groups are visibly separate. Matching
 * triples to triples collapses the search from 9! to a few thousand candidates,
 * which the real solver can score exhaustively.
 */
function* permutations<T>(items: T[]): Generator<T[]> {
    if (items.length <= 1) {
        yield items;
        return;
    }
    for (let index = 0; index < items.length; index += 1) {
        const rest = [...items.slice(0, index), ...items.slice(index + 1)];
        for (const tail of permutations(rest)) yield [items[index], ...tail];
    }
}

/** Sum of the pairwise distances inside a group: small means "tight cluster". */
function spread(indexes: number[], get: (index: number) => [number, number, number]): number {
    let total = 0;
    for (let i = 0; i < indexes.length; i += 1) {
        for (let j = i + 1; j < indexes.length; j += 1) {
            const a = get(indexes[i]);
            const b = get(indexes[j]);
            total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        }
    }
    return total;
}

// The three tight triangles of the model.
const triples3d: number[][] = [];
const remaining = planePoints3d.map((entry) => entry.index);
const used = new Set<number>();
for (const anchor of planePoints3d) {
    if (used.has(anchor.index)) continue;
    const near = planePoints3d
        .map((entry) => ({
            index: entry.index,
            d: Math.hypot(
                entry.point.x - anchor.point.x,
                entry.point.y - anchor.point.y,
                entry.point.z - anchor.point.z
            ),
        }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((entry) => entry.index);
    if (near.every((index) => !used.has(index))) {
        near.forEach((index) => used.add(index));
        triples3d.push(near);
    }
}
void remaining;
console.log(
    `triángulos en 3D: ${triples3d.map((triple) => triples3d.indexOf(triple)).join(', ')} → ` +
    triples3d.map((triple) => `[${triple.map((i) => KEYPOINT_NAMES[i]).join(' ')}]`).join(' ')
);

// The tightest partition of the image points into three triangles of three.
const planeImage = plane2d;
let imageTriples: number[][] = [];
let bestSpread = Number.POSITIVE_INFINITY;
for (const order of permutations(planeImage)) {
    const candidate = [order.slice(0, 3), order.slice(3, 6), order.slice(6, 9)];
    const total = candidate.reduce((sum, triple) => sum + spread(triple, (index) => [points2d[index][0], points2d[index][1], 0]), 0);
    if (total < bestSpread - 1e-9) {
        bestSpread = total;
        imageTriples = candidate;
    }
}
// The enumeration above revisits the same partitions many times: keep the one
// canonical form instead of the last seen.
const keyed = new Map<string, number[][]>();
const remember = (triples: number[][]) => {
    const key = triples
        .map((triple) => [...triple].sort((a, b) => a - b).join('-'))
        .sort()
        .join('|');
    const total = triples.reduce((sum, triple) => sum + spread(triple, (index) => [points2d[index][0], points2d[index][1], 0]), 0);
    const previous = keyed.get(key);
    if (!previous) keyed.set(key, triples);
    void previous;
    return total;
};
let bestPartition: number[][] = imageTriples;
let bestPartitionSpread = remember(imageTriples);
for (const order of permutations(planeImage)) {
    const candidate = [order.slice(0, 3), order.slice(3, 6), order.slice(6, 9)];
    const total = remember(candidate);
    if (total < bestPartitionSpread) {
        bestPartitionSpread = total;
        bestPartition = candidate;
    }
}
imageTriples = [...keyed.values()].reduce((best, triples) => {
    const total = triples.reduce((sum, triple) => sum + spread(triple, (index) => [points2d[index][0], points2d[index][1], 0]), 0);
    return total < best.total ? { triples, total } : best;
}, { triples: bestPartition, total: Number.POSITIVE_INFINITY }).triples;
console.log(
    `triángulos en la imagen: ${imageTriples.map((triple) => `[${triple.join(' ')}]`).join(' ')} ` +
    `(dispersión ${bestPartitionSpread.toFixed(1)})`
);

/** Focal derived from the longest image side: how phone cameras are quoted. */
const ortho = (width: number, height: number, fovDeg: number) => {
    const f = Math.max(width, height) / 2 / Math.tan((fovDeg * Math.PI) / 360);
    return { fx: f, fy: f, cx: width / 2, cy: height / 2 };
};
const intrinsicsApp = intrinsicsFromFov(image.width, image.height, HFOV);
const intrinsicsLong = ortho(image.width, image.height, HFOV);

interface Scored {
    rms: number;
    inliers: number;
    order: number[];
    tvec: [number, number, number];
    fovLabel: string;
}
let winner: Scored | null = null;
let tried = 0;

for (const tripleOrder of permutations([0, 1, 2])) {
    for (const innerOrders of [
        [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ]) {
        // All six internal orders per triangle, in parallel: 6³ = 216 combinations.
        for (const a of permutations(triples3d[tripleOrder[0]])) {
            for (const b of permutations(triples3d[tripleOrder[1]])) {
                for (const c of permutations(triples3d[tripleOrder[2]])) {
                    const perTriple = [a, b, c];
                    const mapping = new Map<number, number>();
                    imageTriples.forEach((imageTriple, position) => {
                        const threeDTriple = perTriple[position];
                        imageTriple.forEach((imageIndex, slot) => mapping.set(imageIndex, threeDTriple[slot]));
                    });

                    for (const elevated of [elevated3d, [...elevated3d].reverse()]) {
                        elevated2d.forEach((imageIndex, position) => mapping.set(imageIndex, elevated[position].index));
                        const order3d = points2d.map((_, imageIndex) => mapping.get(imageIndex) ?? 0);

                        for (const [label, K] of [['app', intrinsicsApp], ['eje-largo', intrinsicsLong]] as const) {
                            for (const fov of [41, 45, 55, 68]) {
                                const withFov = label === 'app'
                                    ? intrinsicsApp
                                    : ortho(image.width, image.height, fov);
                                if (label === 'app' && fov !== 41) continue;
                                tried += 1;
                                const pose = solvePnP(
                                    order3d.map((threeDIndex) => KEYPOINTS_SCENE[threeDIndex]),
                                    points2d,
                                    withFov,
                                    { maxReprojectionError: 4, maxIterations: 150 }
                                );
                                void K;
                                if (!pose) continue;
                                if (
                                    !winner ||
                                    pose.inliers > winner.inliers ||
                                    (pose.inliers === winner.inliers && pose.rmsError < winner.rms)
                                ) {
                                    winner = {
                                        rms: pose.rmsError,
                                        inliers: pose.inliers,
                                        order: order3d,
                                        tvec: pose.tvec,
                                        fovLabel: label === 'app' ? `hfov ${fov}º (app)` : `eje largo ${fov}º`,
                                    };
                                }
                            }
                        }
                    }
                    void innerOrders;
                }
            }
        }
    }
}
console.log(`candidatos probados: ${tried}`);

if (!winner) {
    console.log('Ninguna asignación produce una pose: revisar la geometría de los puntos.');
    process.exit(1);
}

console.log(
    `mejor asignación: inliers ${winner.inliers}/11, rms ${winner.rms.toFixed(3)} px, ` +
    `cámara a ${Math.hypot(...winner.tvec).toFixed(2)} m\n`
);
console.log('índice del modelo → punto de KEYPOINTS_SCENE');
winner.order.forEach((threeDIndex, imageIndex) => {
    const point = KEYPOINTS_SCENE[threeDIndex];
    console.log(
        `  ${String(imageIndex).padStart(2)}  →  ${KEYPOINT_NAMES[threeDIndex].padEnd(22)} ` +
        `(${point.x.toFixed(3)}, ${point.y.toFixed(3)}, ${point.z.toFixed(3)})`
    );
});
console.log(`\norden para KEYPOINTS_SCENE (por índice del modelo): [${winner.order.join(', ')}]`);
