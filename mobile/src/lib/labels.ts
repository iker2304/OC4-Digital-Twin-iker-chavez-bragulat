/** Label sets. COCO is the default for YOLOv8/v11 exports. */

export const COCO_LABELS = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog',
    'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
    'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
    'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
    'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich',
    'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
    'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote',
    'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book',
    'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
] as const;

/** 17 COCO keypoints used by YOLOv8-pose. */
export const COCO_KEYPOINTS = [
    'nose', 'left eye', 'right eye', 'left ear', 'right ear', 'left shoulder', 'right shoulder',
    'left elbow', 'right elbow', 'left wrist', 'right wrist', 'left hip', 'right hip',
    'left knee', 'right knee', 'left ankle', 'right ankle',
] as const;

/** Skeleton edges for drawing pose overlays. */
export const POSE_SKELETON: Array<[number, number]> = [
    [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12],
    [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6], [0, 1], [0, 2],
    [1, 3], [2, 4],
];

export interface LabelSet {
    names: string[];
    source: 'coco' | 'custom' | 'generic';
}

export function labelsFromText(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        // Markup is never a class name: a sidecar request that landed on the SPA
        // index.html must fall through to the built-in labels.
        .filter((line) => !/^</.test(line))
        .map((line) => {
            // Accept both `0 car`/`car` and `car: 0` styles.
            const indexed = line.match(/^(\d+)\s+(.*)$/);
            if (indexed) return indexed[2].trim();
            const trailing = line.match(/^(.*?)[\s:]+(\d+)$/);
            if (trailing) return trailing[1].trim();
            return line;
        });
}

export function resolveLabels(numClasses: number, custom?: string[] | null): LabelSet {
    if (custom && custom.length > 0) {
        return { names: custom, source: 'custom' };
    }
    if (numClasses === COCO_LABELS.length) {
        return { names: [...COCO_LABELS], source: 'coco' };
    }
    return {
        names: Array.from({ length: Math.max(numClasses, 1) }, (_, i) => `class ${i}`),
        source: 'generic',
    };
}

export function labelFor(set: LabelSet, classId: number): string {
    return set.names[classId] ?? `class ${classId}`;
}
