/**
 * YOLOv8/v11/v26 output decoding (detection and pose) + NMS.
 *
 * Supported layouts (auto-detected from the tensor shape):
 *   - [1, 4+nc, N]     canonical export (detection)
 *   - [1, N, 4+nc]     transposed export (some OpenVINO/TFLite conversions)
 *   - [1, 5+3k, N]     pose export (k = keypoints: 11 for this project, 17 for COCO)
 *   - [1, N, 6+3k]     end-to-end export (`end2end=True`): NMS is inside the graph,
 *                      rows are [x1, y1, x2, y2, conf, cls, kpts...]
 *
 * Coordinates are returned in *letterboxed input space*; `engine.ts` maps them
 * back to source-video pixels.
 */
import type { Detection, Keypoint } from '../../types';
import { labelFor, type LabelSet } from '../labels';

export interface TaskAnalysis {
    kind: 'detect' | 'pose';
    numClasses: number;
    numKeypoints: number;
    attrs: number;
    anchors: number;
    anchorsFirst: boolean;
    alreadyNms: boolean;
    /** True when the class count could not be derived (NMS output with no class dim). */
    classCountUnknown: boolean;
}

/**
 * Keypoint counts seen in the wild, used to tell pose from detection layouts in
 * *raw* exports. Deliberately curated: with a raw layout, `attrs = 4 + nc`, so a
 * 13-class detector would look like a 4-keypoint pose model. Known counts
 * (OC4 = 11, COCO = 17, body-25 = 26...) are unambiguous, guesswork is not.
 */
const KNOWN_POSE_KEYPOINTS = [11, 14, 17, 19, 21, 23, 26];

/** Minimum keypoints accepted for an end-to-end pose export. */
const MIN_END_TO_END_KEYPOINTS = 4;

/**
 * An end-to-end graph emits at most `max_det` rows (300 by default), while a raw
 * export emits one row per anchor (8400 at 640px, 2100 at 320px...).
 */
const MAX_END_TO_END_ROWS = 1000;

/** Number of leading attributes of an end-to-end row before the keypoints. */
const END_TO_END_PREFIX = 6;

export function analyseOutput(shape: readonly number[]): TaskAnalysis | null {
    if (shape.length !== 3) return null;
    const d1 = shape[1];
    const d2 = shape[2];
    if (!Number.isFinite(d1) || !Number.isFinite(d2)) return null;

    const anchorsFirst = d1 > d2;
    const attrs = anchorsFirst ? d2 : d1;
    const anchors = anchorsFirst ? d1 : d2;
    if (attrs < 5) return null;

    // ---------------------------------------------------------------- end2end
    // NMS already applied inside the graph: rows are [x1,y1,x2,y2,conf,cls,...].
    if (anchors <= MAX_END_TO_END_ROWS) {
        const keypointCandidate = (attrs - END_TO_END_PREFIX) / 3;
        if (
            Number.isInteger(keypointCandidate) &&
            keypointCandidate >= MIN_END_TO_END_KEYPOINTS
        ) {
            return {
                kind: 'pose',
                numClasses: 0,
                numKeypoints: keypointCandidate,
                attrs,
                anchors,
                anchorsFirst,
                alreadyNms: true,
                classCountUnknown: true,
            };
        }
        if (attrs === 6 || attrs === 7) {
            return {
                kind: 'detect',
                numClasses: 0,
                numKeypoints: 0,
                attrs,
                anchors,
                anchorsFirst,
                alreadyNms: true,
                classCountUnknown: true,
            };
        }
    }

    // ------------------------------------------------------------- raw layouts
    const keypointCandidate = (attrs - 5) / 3;
    if (
        Number.isInteger(keypointCandidate) &&
        KNOWN_POSE_KEYPOINTS.includes(keypointCandidate)
    ) {
        return {
            kind: 'pose',
            numClasses: 1,
            numKeypoints: keypointCandidate,
            attrs,
            anchors,
            anchorsFirst,
            alreadyNms: false,
            classCountUnknown: false,
        };
    }

    const numClasses = attrs - 4;
    if (numClasses < 1 || numClasses > 1000) return null;
    return {
        kind: 'detect',
        numClasses,
        numKeypoints: 0,
        attrs,
        anchors,
        anchorsFirst,
        alreadyNms: false,
        classCountUnknown: false,
    };
}

export interface DecodeOptions {
    confidence: number;
    iou: number;
    maxDetections: number;
}

export interface DecodeResult {
    detections: Detection[];
    /** Class ids present after decoding, so labels can be sized from the model. */
    maxClassId: number;
}

let nextDetectionId = 1;

export function decodeOutput(
    raw: Float32Array,
    analysis: TaskAnalysis,
    labels: LabelSet,
    options: DecodeOptions
): DecodeResult {
    const { confidence, iou, maxDetections } = options;
    const candidates: Detection[] = [];
    let maxClassId = 0;

    const emit = (
        cx: number,
        cy: number,
        w: number,
        h: number,
        score: number,
        classId: number,
        keypoints?: Keypoint[]
    ) => {
        if (!(score >= confidence)) return;
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(w) || !Number.isFinite(h)) return;
        if (classId > maxClassId) maxClassId = classId;
        candidates.push({
            id: nextDetectionId++,
            classId,
            label: labelFor(labels, classId),
            score,
            bbox: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
            keypoints,
        });
    };

    if (analysis.alreadyNms) {
        // Rows are self-contained: [x1, y1, x2, y2, conf, cls, kpts...] in either
        // orientation, so index by attribute instead of by raw array offset.
        const read = analysis.anchorsFirst
            ? (row: number, attr: number) => raw[row * analysis.attrs + attr]
            : (row: number, attr: number) => raw[attr * analysis.anchors + row];

        for (let i = 0; i < analysis.anchors; i += 1) {
            const score = read(i, 4);
            if (!(score >= confidence)) continue;
            const x1 = read(i, 0);
            const y1 = read(i, 1);
            const x2 = read(i, 2);
            const y2 = read(i, 3);
            if (!Number.isFinite(x1) || !Number.isFinite(y1)) continue;

            const classId = Math.max(0, Math.round(read(i, 5) || 0));
            let keypoints: Keypoint[] | undefined;
            if (analysis.numKeypoints > 0) {
                keypoints = [];
                for (let k = 0; k < analysis.numKeypoints; k += 1) {
                    const base = END_TO_END_PREFIX + k * 3;
                    keypoints.push({ x: read(i, base), y: read(i, base + 1), score: read(i, base + 2) });
                }
            }

            if (classId > maxClassId) maxClassId = classId;
            candidates.push({
                id: nextDetectionId++,
                classId,
                label: labelFor(labels, classId),
                score,
                bbox: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
                keypoints,
            });
        }
        return {
            detections: candidates.sort((a, b) => b.score - a.score).slice(0, maxDetections),
            maxClassId,
        };
    }

    const at = analysis.anchorsFirst
        ? (anchor: number, attr: number) => raw[anchor * analysis.attrs + attr]
        : (anchor: number, attr: number) => raw[attr * analysis.anchors + anchor];

    for (let i = 0; i < analysis.anchors; i += 1) {
        const cx = at(i, 0);
        const cy = at(i, 1);
        const w = at(i, 2);
        const h = at(i, 3);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;

        let score: number;
        let classId: number;
        let keypoints: Keypoint[] | undefined;

        if (analysis.kind === 'pose') {
            score = at(i, 4);
            classId = 0;
            if (score >= confidence) {
                keypoints = [];
                for (let k = 0; k < analysis.numKeypoints; k += 1) {
                    keypoints.push({
                        x: at(i, 5 + k * 3),
                        y: at(i, 6 + k * 3),
                        score: at(i, 7 + k * 3),
                    });
                }
            }
        } else if (analysis.numClasses === 1) {
            score = at(i, 4);
            classId = 0;
        } else {
            // Multi-class detection: argmax over the class columns.
            score = -Infinity;
            classId = 0;
            for (let c = 0; c < analysis.numClasses; c += 1) {
                const value = at(i, 4 + c);
                if (value > score) {
                    score = value;
                    classId = c;
                }
            }
        }

        emit(cx, cy, w, h, score, classId, keypoints);
    }

    return { detections: nonMaxSuppression(candidates, iou, maxDetections), maxClassId };
}

/** Greedy per-class NMS. `iou` is the suppression threshold (0..1). */
export function nonMaxSuppression(
    detections: Detection[],
    iou: number,
    maxDetections: number
): Detection[] {
    if (detections.length <= 1) return detections.slice(0, maxDetections);

    const byClass = new Map<number, Detection[]>();
    for (const detection of detections) {
        const bucket = byClass.get(detection.classId);
        if (bucket) bucket.push(detection);
        else byClass.set(detection.classId, [detection]);
    }

    const kept: Detection[] = [];
    for (const bucket of byClass.values()) {
        bucket.sort((a, b) => b.score - a.score);
        const local: Detection[] = [];
        for (const candidate of bucket) {
            let suppressed = false;
            for (const accepted of local) {
                if (intersectionOverUnion(candidate.bbox, accepted.bbox) > iou) {
                    suppressed = true;
                    break;
                }
            }
            if (!suppressed) local.push(candidate);
            if (kept.length + local.length >= maxDetections * 2) break;
        }
        kept.push(...local);
    }

    kept.sort((a, b) => b.score - a.score);
    return kept.slice(0, maxDetections);
}

export function intersectionOverUnion(
    a: [number, number, number, number],
    b: [number, number, number, number]
): number {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[2], b[2]);
    const y2 = Math.min(a[3], b[3]);
    const interW = x2 - x1;
    const interH = y2 - y1;
    if (interW <= 0 || interH <= 0) return 0;
    const inter = interW * interH;
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
}
