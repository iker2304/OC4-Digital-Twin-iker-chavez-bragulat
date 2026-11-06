/**
 * Runs the whole pipeline on a still photo, outside the browser.
 *
 * Why it exists: the integrated browser tab is permanently hidden, so
 * `requestAnimationFrame` never fires and the inference loop cannot be
 * exercised there — every browser check so far only proved that the model
 * *loads*. Debugging "the twin does not move" needs detections, keypoints and a
 * pose, and this produces all three for a real photograph, using the app's own
 * `prepareInput`, `decodeOutput` and `solvePnP` rather than copies of them.
 *
 * Usage: npm run verify:photo [ruta.png]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as ort from 'onnxruntime-web';

import { prepareInput } from '../src/lib/inference/tensor';
import { analyseOutput, decodeOutput } from '../src/lib/inference/decode';
import { resolveLabels } from '../src/lib/labels';
import { intrinsicsFromFov } from '../src/lib/pose/solvePnP';
import { updatePose } from '../src/lib/pose/poseTracker';
import { fitRotorAngle, pickRotorDetection, rotorRmsAt } from '../src/lib/pose/rotorAngle';
import { estimateSunDirection } from '../src/lib/light/sunDirection';
import { lightVectorModelSpace } from '../src/lib/light/lightDirection';
import { projectToSource as project } from '../src/lib/pose/cameraRig';
import { KEYPOINTS_SCENE, KEYPOINT_NAMES } from '../src/lib/pose/keypoints3d';
import { computeLetterbox, unletterboxBox, unletterboxPoint } from '../src/lib/geometry';

const PHOTO = process.argv[2] ?? '../image.png';
const MODEL = process.argv[3] ?? 'public/models/yolo-pose-s-640.onnx';
const HFOV = Number(process.argv[4] ?? 68);
const CONFIDENCE = 0.35;
const KEYPOINT_MIN_SCORE = 0.4;

/** `prepareInput` draws into a canvas; give it one outside the browser. */
function installCanvasShim() {
    const target = globalThis as unknown as { document?: unknown };
    target.document = {
        createElement: (tag: string) => {
            if (tag !== 'canvas') return {};
            const canvas = createCanvas(1, 1);
            return canvas as unknown as HTMLCanvasElement;
        },
    };
}

/** ORT loads its `.mjs` glue through a dynamic import: it needs a file URL in Node. */
function ortAssetBase(): string {
    return pathToFileURL(join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist') + '/').href;
}

installCanvasShim();
ort.env.logLevel = 'error';
ort.env.wasm.wasmPaths = ortAssetBase();
ort.env.wasm.numThreads = 1;

const image = await loadImage(readFileSync(PHOTO));
const srcWidth = image.width;
const srcHeight = image.height;
console.log(`foto ${PHOTO}: ${srcWidth}×${srcHeight}\n`);

const session = await ort.InferenceSession.create(readFileSync(MODEL), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
});

interface Meta {
    name: string;
    shape?: readonly (number | string)[];
}
const holder = session as unknown as { inputMetadata?: Meta[]; outputMetadata?: Meta[] };
const inputMeta = holder.inputMetadata?.[0];
const shape = (inputMeta?.shape ?? []).map((dim) => (typeof dim === 'number' ? dim : Number(dim)));
const inputSize = shape[2] > 0 ? shape[2] : 640;
const layout = shape[1] === 3 ? 'nchw' : 'nhwc';
const outputShape = (holder.outputMetadata?.[0]?.shape ?? []).map((dim) =>
    typeof dim === 'number' ? dim : Number(dim)
);
console.log(`modelo: entrada ${shape.join('×')} (${layout}), salida ${outputShape.join('×')}`);

const analysis = analyseOutput(outputShape);
console.log(
    `tarea: ${analysis?.kind ?? '?'} · clases ${analysis?.numClasses ?? '?'} · keypoints ${analysis?.numKeypoints ?? '?'}\n`
);

const prepared = prepareInput(image, srcWidth, srcHeight, inputSize, layout, 'zero-one');
const outputs = await session.run({ [inputMeta?.name ?? 'images']: prepared.tensor });
const primary = outputs[session.outputNames[0]] ?? Object.values(outputs)[0];
const raw = primary.data as Float32Array;

if (!analysis) throw new Error('no se pudo analizar la salida del modelo');

const labels = resolveLabels(analysis.numClasses, null);
const { detections } = decodeOutput(raw, analysis, labels, {
    confidence: CONFIDENCE,
    iou: 0.45,
    maxDetections: 30,
});

const box = computeLetterbox(srcWidth, srcHeight, inputSize);
const mapped = detections.map((detection) => ({
    ...detection,
    bbox: unletterboxBox(detection.bbox, box),
    keypoints: detection.keypoints?.map((keypoint) => {
        const [x, y] = unletterboxPoint(keypoint.x, keypoint.y, box);
        return { ...keypoint, x, y };
    }),
}));

console.log(`detecciones: ${mapped.length}`);
for (const detection of mapped) {
    const [x1, y1, x2, y2] = detection.bbox.map((value) => Math.round(value));
    console.log(
        `  ${detection.label} ${detection.score.toFixed(3)}  bbox [${x1}, ${y1}, ${x2}, ${y2}]  ` +
        `keypoints ${detection.keypoints?.length ?? 0}`
    );
    if (detection.keypoints) {
        detection.keypoints.forEach((keypoint, index) => {
            const name = KEYPOINT_NAMES[index] ?? `#${index}`;
            console.log(
                `      ${String(index).padStart(2)} ${name.padEnd(22)} ` +
                `(${keypoint.x.toFixed(0)}, ${keypoint.y.toFixed(0)})  score ${keypoint.score.toFixed(2)}`
            );
        });
    }
}

const used = mapped[0];
if (!used) {
    console.log('\nNo hay detección con la que resolver la pose.');
    process.exit(1);
}

const tracked = updatePose({
    detections: mapped,
    sourceWidth: srcWidth,
    sourceHeight: srcHeight,
    previous: null,
    options: { minScore: KEYPOINT_MIN_SCORE, horizontalFovDeg: HFOV },
});

console.log(`\npose: ${tracked.solved ? 'RESUELTA' : 'no resuelta'}`);
if (!tracked.pose) {
    const strong = (used.keypoints ?? []).filter((keypoint) => keypoint.score >= KEYPOINT_MIN_SCORE).length;
    console.log(
        `  keypoints con score ≥ ${KEYPOINT_MIN_SCORE}: ${strong}/${used.keypoints?.length ?? 0} ` +
        `(se necesitan 4 coplanares, 6 en total para una pose estable)`
    );
    process.exit(2);
}

const { pose } = tracked;
console.log(`  inliers ${pose.inliers}/${pose.pairs}  rms ${pose.rmsError.toFixed(2)} px`);
console.log(`  tvec (${pose.tvec.map((value) => value.toFixed(3)).join(', ')})`);
console.log(`  cámara a ${Math.hypot(...pose.tvec).toFixed(2)} m del origen del gemelo`);

// Where the pose says the keypoints are, versus where the model detected them.
const intrinsics = intrinsicsFromFov(srcWidth, srcHeight, HFOV);
const projected = project(KEYPOINTS_SCENE as unknown as { x: number; y: number; z: number }[], pose, intrinsics);
let worst = 0;
console.log('\nreproyección (pose → píxel detectado):');
KEYPOINTS_SCENE.forEach((_point, index) => {
    const [px, py] = projected[index];
    const detected = used.keypoints?.[index];
    if (!detected || !Number.isFinite(px)) return;
    const error = Math.hypot(px - detected.x, py - detected.y);
    worst = Math.max(worst, error);
    const flag = detected.score >= KEYPOINT_MIN_SCORE ? ' ' : '·';
    console.log(
        `${flag} ${KEYPOINT_NAMES[index].padEnd(22)} detectado (${detected.x.toFixed(0)}, ${detected.y.toFixed(0)})  ` +
        `proyectado (${px.toFixed(0)}, ${py.toFixed(0)})  error ${error.toFixed(1)} px`
    );
});
console.log(`\nerror máximo: ${worst.toFixed(1)} px`);

/**
 * The rotor angle is the one number the base pose cannot see: it is fitted
 * against the blade keypoints of the `Rotor` class (2 per blade).
 */
const rotorDetection = pickRotorDetection(mapped, KEYPOINT_MIN_SCORE, used.classId); if (!rotorDetection) {
    console.log('\nrotor: no hay detección de la clase Rotor con puntos de pala.');
} else {
    const solution = fitRotorAngle(
        pose,
        intrinsics,
        rotorDetection.detection.keypoints ?? [],
        KEYPOINT_MIN_SCORE
    );
    if (!solution) {
        console.log(`\nrotor: ajuste descartado (${rotorDetection.points} puntos de pala, rms fuera de rango)`);
    } else {
        console.log(
            `\nrotor: ${solution.angleDeg.toFixed(1)}°  rms ${solution.rmsPx.toFixed(1)} px  ` +
            `(${solution.points} puntos, clase ${rotorDetection.detection.classId})`
        );
        // A minimum is only believable if moving away from it costs more.
        for (const offset of [-30, -15, 15, 30]) {
            const probe = rotorRmsAt(
                solution.angleDeg + offset,
                pose,
                intrinsics,
                rotorDetection.detection.keypoints ?? [],
                KEYPOINT_MIN_SCORE
            );
            console.log(`  ${offset > 0 ? '+' : ''}${offset}° → rms ${probe === null ? '—' : probe.toFixed(1)} px`);
        }
    }
}

/**
 * Sun direction: no model, just the brightest blob of the sky.
 *
 * The numbers to look at are the azimuth relative to the camera's forward axis
 * and the elevation. What makes it believable is `confidence`: a compact, bright
 * blob scores high; a flat overcast veil barely scores at all.
 */
const photoCanvas = createCanvas(srcWidth, srcHeight);
const photoContext = photoCanvas.getContext('2d');
photoContext.drawImage(image, 0, 0);
const sun = estimateSunDirection(
    photoContext.getImageData(0, 0, srcWidth, srcHeight).data,
    srcWidth,
    srcHeight,
    intrinsics,
    pose
);
if (!sun) {
    console.log('\nluz: sin estimación (frame sin zonas claras utilizables)');
} else {
    console.log(
        `\nluz: azimut ${sun.azimuthDeg.toFixed(0)}°  elevación ${sun.elevationDeg.toFixed(0)}°  ` +
        `confianza ${(sun.confidence * 100).toFixed(0)} %  (${sun.source}, cielo ${(sun.skyFraction * 100).toFixed(0)} % del frame)`
    );
    console.log(`  píxel más brillante en (${sun.pixel.x.toFixed(0)}, ${sun.pixel.y.toFixed(0)})`);
    const vector = lightVectorModelSpace(sun.azimuthDeg, sun.elevationDeg, pose);
    console.log(
        `  dirección en el marco del modelo: (${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)})`
    );
}
