/** Shared domain types for the standalone mobile client. */

export type Stage = 'onboarding' | 'live';

export type LayoutMode = 'portrait' | 'landscape';

/** Task family resolved automatically from the model's output tensor shape. */
export type ModelKind = 'detect' | 'pose' | 'unknown';

export type LoadStatus = 'idle' | 'requesting' | 'loading' | 'ready' | 'error';

export interface Keypoint {
    /** Source-video pixel space, same space as `bbox`. */
    x: number;
    y: number;
    score: number;
}

export interface Detection {
    id: number;
    classId: number;
    label: string;
    score: number;
    /** [x1, y1, x2, y2] in source-video pixel space (intrinsic video size). */
    bbox: [number, number, number, number];
    keypoints?: Keypoint[];
}

export interface ModelInfo {
    name: string;
    kind: ModelKind;
    inputName: string;
    inputShape: number[];
    outputNames: string[];
    outputShapes: number[][];
    inputSize: number;
    numClasses: number;
    numKeypoints: number;
    provider: string;
    /**
     * `nchw` for the canonical YOLO export, `nhwc` for TFLite-derived models.
     * Inferred from the input tensor shape.
     */
    layout: 'nchw' | 'nhwc';
    /**
     * Short hash of the bytes, so two exports of the same name are still two
     * different models (weights, quantization, input size).
     */
    fingerprint?: string;
    /** Size of the file the session was created from, in bytes. */
    bytes?: number;
}

export interface FrameMetrics {
    fps: number;
    inferenceMs: number;
    preprocessMs: number;
    postprocessMs: number;
    detected: number;
    /**
     * Wall-clock time from grabbing the frame to having the pose ready to draw,
     * averaged over the last few inferences. The single number that says whether
     * the overlay is where the world is *now*.
     */
    latencyMs: number;
    /** Pose solve only, in milliseconds. */
    poseMs: number;
}

export type TelemetryStatus = 'off' | 'connecting' | 'online' | 'offline' | 'error';

/** Optional payload relayed to the standalone Node server. */
export interface TelemetryFrame {
    ts: number;
    fps: number;
    inferenceMs: number;
    provider: string | null;
    model: string | null;
    detections: Array<{
        label: string;
        score: number;
        bbox: [number, number, number, number];
        keypoints?: Keypoint[];
    }>;
}
