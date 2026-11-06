/**
 * Self-test for the decoder that runs in plain Node (no browser, no ORT).
 *
 * The post-processing is the part most likely to break silently — a wrong
 * stride or a transposed tensor still "works", it just returns garbage boxes —
 * so it is verified against synthetic tensors with a known expected answer.
 *
 *   npm run verify:inference
 */
import assert from 'node:assert/strict';
import { analyseOutput, decodeOutput, nonMaxSuppression } from '../src/lib/inference/decode';
import { computeCover, computeLetterbox, sourceToDisplay, unletterboxPoint } from '../src/lib/geometry';
import { resolveLabels } from '../src/lib/labels';

let checks = 0;
function check(name: string, fn: () => void) {
    fn();
    checks += 1;
    console.log(`  ok  ${name}`);
}

/** Tensors store float32, so decoded values are only exact to ~7 digits. */
function closePoint(
    actual: { x: number; y: number; score: number } | undefined,
    expected: { x: number; y: number; score: number }
) {
    assert.ok(actual, 'expected a keypoint');
    assert.ok(Math.abs(actual.x - expected.x) < 1e-3, `x: ${actual.x} != ${expected.x}`);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-3, `y: ${actual.y} != ${expected.y}`);
    assert.ok(Math.abs(actual.score - expected.score) < 1e-3, `score: ${actual.score}`);
}

/* ------------------------------------------------------------ task analysis */

console.log('analyseOutput');

check('COCO detection [1, 84, 8400]', () => {
    const a = analyseOutput([1, 84, 8400]);
    assert.ok(a);
    assert.equal(a.kind, 'detect');
    assert.equal(a.numClasses, 80);
    assert.equal(a.anchors, 8400);
    assert.equal(a.anchorsFirst, false);
});

check('transposed detection [1, 8400, 84]', () => {
    const a = analyseOutput([1, 8400, 84]);
    assert.ok(a);
    assert.equal(a.anchorsFirst, true);
    assert.equal(a.numClasses, 80);
});

check('single-class detection [1, 5, 8400]', () => {
    const a = analyseOutput([1, 5, 8400]);
    assert.ok(a);
    assert.equal(a.numClasses, 1);
    assert.equal(a.kind, 'detect');
});

check('pose [1, 56, 8400] → 17 keypoints', () => {
    const a = analyseOutput([1, 56, 8400]);
    assert.ok(a);
    assert.equal(a.kind, 'pose');
    assert.equal(a.numKeypoints, 17);
});

check('raw pose with 11 keypoints [1, 38, 8400] (OC4 best.onnx shape)', () => {
    const a = analyseOutput([1, 38, 8400]);
    assert.ok(a);
    assert.equal(a.kind, 'pose');
    assert.equal(a.numKeypoints, 11);
});

check('end2end pose [1, 300, 39] → NMS inside the graph, 11 keypoints', () => {
    // 6 (xyxy + conf + cls) + 11 * 3 = 39 — this is what ../best.onnx emits.
    const a = analyseOutput([1, 300, 39]);
    assert.ok(a);
    assert.equal(a.kind, 'pose');
    assert.equal(a.numKeypoints, 11);
    assert.equal(a.alreadyNms, true);
    assert.equal(a.anchorsFirst, true);
});

check('end2end pose, transposed [1, 39, 300]', () => {
    const a = analyseOutput([1, 39, 300]);
    assert.ok(a);
    assert.equal(a.kind, 'pose');
    assert.equal(a.numKeypoints, 11);
    assert.equal(a.alreadyNms, true);
    assert.equal(a.anchorsFirst, false);
});

check('a 13-class raw detector is NOT mistaken for a 4-keypoint pose model', () => {
    const a = analyseOutput([1, 17, 8400]);
    assert.ok(a);
    assert.equal(a.kind, 'detect');
    assert.equal(a.numClasses, 13);
});

check('baked-in NMS [1, 300, 6]', () => {
    const a = analyseOutput([1, 300, 6]);
    assert.ok(a);
    assert.equal(a.alreadyNms, true);
});

check('a 2-D / bogus output is rejected instead of guessed', () => {
    assert.equal(analyseOutput([1, 1000]), null);
    assert.equal(analyseOutput([1, 4, 8400]), null);
});

/* ----------------------------------------------------------------- decoding */

console.log('decodeOutput');

const labels = resolveLabels(80);

function detectTensor(entries: Array<{ cx: number; cy: number; w: number; h: number; cls: number; score: number }>) {
    const anchors = 8400;
    const attrs = 84;
    const data = new Float32Array(attrs * anchors);
    entries.forEach((entry, index) => {
        data[0 * anchors + index] = entry.cx;
        data[1 * anchors + index] = entry.cy;
        data[2 * anchors + index] = entry.w;
        data[3 * anchors + index] = entry.h;
        data[(4 + entry.cls) * anchors + index] = entry.score;
    });
    return { data, shape: [1, attrs, anchors] as const };
}

check('one confident box survives, x/y/w/h converted to corners', () => {
    const { data, shape } = detectTensor([
        { cx: 320, cy: 240, w: 100, h: 50, cls: 0, score: 0.9 },
    ]);
    const analysis = analyseOutput(shape);
    assert.ok(analysis);
    const { detections } = decodeOutput(data, analysis, labels, {
        confidence: 0.3,
        iou: 0.45,
        maxDetections: 10,
    });
    assert.equal(detections.length, 1);
    assert.deepEqual(detections[0].bbox, [270, 215, 370, 265]);
    assert.equal(detections[0].label, 'person');
});

check('below-threshold boxes are dropped', () => {
    const { data, shape } = detectTensor([
        { cx: 100, cy: 100, w: 20, h: 20, cls: 0, score: 0.12 },
    ]);
    const analysis = analyseOutput(shape);
    assert.ok(analysis);
    const { detections } = decodeOutput(data, analysis, labels, {
        confidence: 0.3,
        iou: 0.45,
        maxDetections: 10,
    });
    assert.equal(detections.length, 0);
});

check('overlapping duplicates are suppressed (per class)', () => {
    const { data, shape } = detectTensor([
        { cx: 320, cy: 240, w: 100, h: 100, cls: 0, score: 0.9 },
        { cx: 322, cy: 241, w: 100, h: 100, cls: 0, score: 0.8 },
        { cx: 320, cy: 240, w: 100, h: 100, cls: 2, score: 0.7 },
    ]);
    const analysis = analyseOutput(shape);
    assert.ok(analysis);
    const { detections } = decodeOutput(data, analysis, labels, {
        confidence: 0.3,
        iou: 0.45,
        maxDetections: 10,
    });
    // The two persons collapse into one; the car (different class) is kept.
    assert.equal(detections.length, 2);
    assert.deepEqual(
        detections.map((d) => d.label).sort(),
        ['car', 'person']
    );
});

check('end2end pose rows decode bbox, class and keypoints', () => {
    // [1, 300, 39]: 4 bbox + conf + cls + 11 * (x, y, score)
    const rows = 300;
    const attrs = 39;
    const data = new Float32Array(rows * attrs);
    const row = 7;
    data[row * attrs + 0] = 100;
    data[row * attrs + 1] = 200;
    data[row * attrs + 2] = 300;
    data[row * attrs + 3] = 400;
    data[row * attrs + 4] = 0.88;
    data[row * attrs + 5] = 1; // clase 1 = Rotor
    for (let k = 0; k < 11; k += 1) {
        data[row * attrs + 6 + k * 3] = 100 + k;
        data[row * attrs + 6 + k * 3 + 1] = 200 + k;
        data[row * attrs + 6 + k * 3 + 2] = 0.75;
    }

    const analysis = analyseOutput([1, rows, attrs]);
    assert.ok(analysis);
    const { detections } = decodeOutput(data, analysis, resolveLabels(2), {
        confidence: 0.3,
        iou: 0.45,
        maxDetections: 10,
    });
    assert.equal(detections.length, 1);
    assert.deepEqual(detections[0].bbox, [100, 200, 300, 400]);
    assert.equal(detections[0].classId, 1);
    assert.equal(detections[0].keypoints?.length, 11);
    closePoint(detections[0].keypoints?.[0], { x: 100, y: 200, score: 0.75 });
    closePoint(detections[0].keypoints?.[10], { x: 110, y: 210, score: 0.75 });
});

check('pose keypoints are decoded as (x, y, score) triplets', () => {
    const anchors = 8400;
    const attrs = 56;
    const data = new Float32Array(attrs * anchors);
    data[0 * anchors] = 320;
    data[1 * anchors] = 240;
    data[2 * anchors] = 60;
    data[3 * anchors] = 120;
    data[4 * anchors] = 0.95;
    // Keypoint 0 at (310, 200) with score 0.9
    data[5 * anchors] = 310;
    data[6 * anchors] = 200;
    data[7 * anchors] = 0.9;
    // Keypoint 16 at (330, 400) with score 0.4
    data[(5 + 16 * 3) * anchors] = 330;
    data[(6 + 16 * 3) * anchors] = 400;
    data[(7 + 16 * 3) * anchors] = 0.4;

    const analysis = analyseOutput([1, attrs, anchors]);
    assert.ok(analysis);
    const { detections } = decodeOutput(data, analysis, labels, {
        confidence: 0.3,
        iou: 0.45,
        maxDetections: 10,
    });
    assert.equal(detections.length, 1);
    assert.equal(detections[0].keypoints?.length, 17);
    // Float32 storage means exact equality would be a lie; compare with tolerance.
    closePoint(detections[0].keypoints?.[0], { x: 310, y: 200, score: 0.9 });
    closePoint(detections[0].keypoints?.[16], { x: 330, y: 400, score: 0.4 });
});

/* ---------------------------------------------------------------------- NMS */

console.log('nonMaxSuppression');

check('keeps the highest score and respects the cap', () => {
    const make = (id: number, x: number, score: number) => ({
        id,
        classId: 0,
        label: 'x',
        score,
        bbox: [x, 0, x + 10, 10] as [number, number, number, number],
    });
    const detections = [make(1, 0, 0.5), make(2, 2, 0.9), make(3, 500, 0.7)];
    const kept = nonMaxSuppression(detections, 0.45, 2);
    assert.equal(kept.length, 2);
    assert.equal(kept[0].score, 0.9);
});

/* ----------------------------------------------------------------- geometry */

console.log('geometry');

check('letterbox keeps the aspect ratio and pads symmetrically', () => {
    const info = computeLetterbox(1280, 720, 640);
    assert.equal(info.scale, 0.5);
    assert.equal(info.padY, 140);
    assert.equal(info.padX, 0);
    // A point at the centre of the frame maps back to the centre of the source.
    assert.deepEqual(unletterboxPoint(320, 320, info), [640, 360]);
    // A point on the left edge of the letterboxed content maps to x = 0.
    assert.deepEqual(unletterboxPoint(0, 140, info), [0, 0]);
});

check('cover crop maps source pixels onto the visible area', () => {
    // 16:9 source into a 1:1 container: the sides get cropped, nothing else.
    const cover = computeCover(1280, 720, 400, 400);
    assert.equal(cover.scale, 400 / 720);
    assert.equal(cover.visibleWidth, 720);
    assert.equal(cover.visibleHeight, 720);
    // Horizontal centre of the source lands on the horizontal centre of the box.
    assert.deepEqual(sourceToDisplay(640, 360, cover), [200, 200]);
});

check('cover crop honours the mirrored (front camera) transform', () => {
    const cover = computeCover(1280, 720, 400, 400, true);
    const [x] = sourceToDisplay(640, 360, cover, true);
    assert.equal(x, 200);
});

check('degenerate sizes do not produce NaN', () => {
    const info = computeLetterbox(0, 0, 640);
    assert.ok(Number.isFinite(info.scale) && info.scale > 0);
    const cover = computeCover(0, 0, 0, 0);
    assert.deepEqual(sourceToDisplay(0, 0, cover), [0, 0]);
});

console.log(`\n${checks} checks passed.`);
