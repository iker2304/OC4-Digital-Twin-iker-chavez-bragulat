/**
 * On-device inference engine.
 *
 * Owns an `onnxruntime-web` session and translates between the browser world
 * (a `<video>` element) and the model world (a letterboxed NCHW/NHWC tensor),
 * including mapping detections back to source-video pixels so overlays line up
 * exactly.
 */
import * as ort from 'onnxruntime-web';
import type { Detection, ModelInfo } from '../../types';
import {
    fetchWithProgress,
    formatBytes,
    readModelCache,
    withTimeout,
    writeModelCache,
    type DownloadProgress,
} from '../async';
import { unletterboxPoint, type LetterboxInfo } from '../geometry';
import { resolveLabels, type LabelSet } from '../labels';
import { analyseOutput, decodeOutput, type TaskAnalysis } from './decode';
import { createSession, type SessionSource } from './ortAssets';
import { prepareInput, type Normalization } from './tensor';

interface ValueMeta {
    name: string;
    shape?: readonly (number | string)[];
    type?: string;
    isTensor?: boolean;
}

/**
 * A short, stable identity for a model file.
 *
 * The file name is not enough: `yolo-pose-s-640.onnx` gets re-exported, re-quantized and
 * re-trained, and the benchmarks of two different weight files would end up in the
 * same row. Hashing the whole 11-40 MB on every load would cost real time on a
 * phone, so this hashes the first and last 192 KB plus the length: any
 * re-export changes the header metadata and the quantization tables at the end,
 * which is exactly where these files differ.
 *
 * `crypto.subtle` needs a secure context; without it the length is still a
 * (weaker) discriminator.
 */
async function fingerprintOf(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const size = view.byteLength;
    try {
        const window = 192 * 1024;
        const head = view.subarray(0, Math.min(window, size));
        const tail = view.subarray(Math.max(0, size - window));
        const length = new TextEncoder().encode(String(size));
        const joined = new Uint8Array(head.byteLength + tail.byteLength + length.byteLength);
        joined.set(head, 0);
        joined.set(tail, head.byteLength);
        joined.set(length, head.byteLength + tail.byteLength);
        const digest = await crypto.subtle.digest('SHA-256', joined);
        return [...new Uint8Array(digest).slice(0, 6)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    } catch {
        return `len${size.toString(36)}`;
    }
}

/**
 * `inputMetadata`/`outputMetadata` are declared as a union of tensor and
 * non-tensor metadata, which hides `shape`. Reading them through a narrow local
 * shape keeps the rest of the file honest instead of sprinkling casts.
 */
function readMetadata(
    session: ort.InferenceSession,
    which: 'input' | 'output'
): readonly ValueMeta[] {
    const holder = session as unknown as {
        inputMetadata?: readonly ValueMeta[];
        outputMetadata?: readonly ValueMeta[];
    };
    return (which === 'input' ? holder.inputMetadata : holder.outputMetadata) ?? [];
}

export interface EngineConfig {
    /** Display name, e.g. the file name. */
    name: string;
    taskOverride?: 'auto' | 'detect' | 'pose';
    customLabels?: string[] | null;
    preferWebGpu?: boolean;
    normalization?: Normalization;
    /** Used when the model declares a dynamic input dimension. */
    inputSizeFallback?: number;
}

export interface RunOptions {
    confidence: number;
    iou: number;
    maxDetections: number;
}

export interface RunResult {
    detections: Detection[];
    inferenceMs: number;
    preprocessMs: number;
    postprocessMs: number;
}

function numericShape(shape: readonly (number | string)[] | undefined): number[] {
    if (!shape) return [];
    return shape.map((dim) => {
        const value = typeof dim === 'number' ? dim : Number(dim);
        return Number.isFinite(value) && value > 0 ? value : -1;
    });
}

export class DetectionEngine {
    readonly info: ModelInfo;

    private readonly session: ort.InferenceSession;
    private readonly analysis: TaskAnalysis | null;
    private labels: LabelSet;
    private readonly normalization: Normalization;
    private readonly taskOverride: 'auto' | 'detect' | 'pose';
    private readonly customLabels: string[] | null;
    private readonly inputSizeFallback: number;

    private constructor(params: {
        session: ort.InferenceSession;
        provider: string;
        config: EngineConfig;
        meta: readonly ValueMeta[];
    }) {
        const { session, provider, config, meta } = params;
        this.session = session;
        this.taskOverride = config.taskOverride ?? 'auto';
        this.customLabels = config.customLabels ?? null;
        this.normalization = config.normalization ?? 'zero-one';
        this.inputSizeFallback = config.inputSizeFallback ?? 640;

        const input = meta[0];
        const inputShape = numericShape(input?.shape);
        const layout = inferLayout(inputShape);
        const inputSize = resolveInputSize(inputShape, layout, this.inputSizeFallback);

        const outputMetas = readMetadata(session, 'output');
        const outputShapes = outputMetas.map((m) => numericShape(m.shape));
        const outputNames = session.outputNames ?? outputMetas.map((m) => m.name);

        const rawAnalysis = firstAnalysis(outputShapes);
        const analysis = applyOverride(rawAnalysis, this.taskOverride);

        this.analysis = analysis;
        this.labels = resolveLabels(
            analysis?.classCountUnknown ? 0 : analysis?.numClasses ?? 0,
            this.customLabels
        );

        this.info = {
            name: config.name,
            kind: analysis?.kind ?? 'unknown',
            inputName: input?.name ?? session.inputNames?.[0] ?? 'images',
            inputShape,
            outputNames: [...outputNames],
            outputShapes,
            inputSize,
            numClasses: analysis?.numClasses ?? 0,
            numKeypoints: analysis?.numKeypoints ?? 0,
            provider,
            layout,
        };
    }

    static async fromBuffer(
        buffer: ArrayBuffer | Uint8Array,
        config: EngineConfig,
        timeoutMs?: number,
        modelUrl?: string
    ): Promise<DetectionEngine> {
        const preferWebGpu = config.preferWebGpu ?? true;
        const fingerprint = await fingerprintOf(buffer);
        const byteLength = buffer.byteLength;
        /** Both identity fields travel with `info`, so the store and the bench see them. */
        const stamped = (engine: DetectionEngine) => {
            engine.info.fingerprint = fingerprint;
            engine.info.bytes = byteLength;
            return engine;
        };
        const create = async (webGpu: boolean) => {
            const { session, provider } = await createSession(buffer as SessionSource, {
                preferWebGpu: webGpu,
                modelUrl,
            });
            return stamped(
                new DetectionEngine({
                    session,
                    provider,
                    config,
                    meta: readMetadata(session, 'input'),
                })
            );
        };

        if (!timeoutMs) return create(preferWebGpu);

        try {
            return await withTimeout(
                create(preferWebGpu),
                timeoutMs,
                `La inicialización del modelo superó ${Math.round(timeoutMs / 1000)} s`
            );
        } catch (error) {
            // One retry on the CPU path: a hung WebGPU init is the common case on
            // phones, and WASM usually succeeds on the very same device.
            if (!preferWebGpu) throw error;
            console.warn('[ort] primer intento agotado o fallido, reintentando solo con WASM:', error);
            return create(false);
        }
    }

    static async fromUrl(
        url: string,
        config: EngineConfig,
        options: {
            onProgress?: (progress: DownloadProgress) => void;
            /** Bounds the wait between two chunks of the transfer. */
            downloadTimeoutMs?: number;
            /** Bounds session creation, once the bytes are already in memory. */
            timeoutMs?: number;
        } = {}
    ): Promise<DetectionEngine> {
        const cached = await readModelCache(url);
        if (cached) {
            console.info(`[model] ${formatBytes(cached.byteLength)} desde la caché del dispositivo`);
        }

        const bytes =
            cached ??
            (await fetchWithProgress(url, {
                onProgress: options.onProgress,
                stallTimeoutMs: options.downloadTimeoutMs,
            }));

        const engine = await DetectionEngine.fromBuffer(bytes, config, options.timeoutMs, url);

        // Stored *after* the session exists: writing 38 MB while the WASM heap is
        // growing is the peak a phone cannot afford.
        if (!cached) void writeModelCache(url, bytes);
        return engine;
    }

    static async fromFile(file: File, config: EngineConfig): Promise<DetectionEngine> {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return DetectionEngine.fromBuffer(bytes, config);
    }

    /**
     * Runs inference on a frame. `srcWidth`/`srcHeight` must be the intrinsic
     * size of the source, not the display size.
     */
    async run(
        source: CanvasImageSource,
        srcWidth: number,
        srcHeight: number,
        options: RunOptions
    ): Promise<RunResult> {
        const preprocessStart = performance.now();
        const { tensor, info } = prepareInput(
            source,
            srcWidth,
            srcHeight,
            this.info.inputSize,
            this.info.layout,
            this.normalization
        );
        const preprocessMs = performance.now() - preprocessStart;

        const feeds: Record<string, ort.Tensor> = { [this.info.inputName]: tensor };
        const inferenceStart = performance.now();
        const outputs = await this.session.run(feeds);
        const inferenceMs = performance.now() - inferenceStart;

        const postprocessStart = performance.now();
        const outputName = this.info.outputNames[0];
        const primary = outputs[outputName] ?? Object.values(outputs)[0];
        let detections: Detection[] = [];

        if (primary) {
            const analysis = this.analysis ?? applyOverride(analyseOutput(primary.dims), this.taskOverride);
            if (analysis) {
                if (!this.analysis) {
                    // Dynamic input: learn the layout from the first real execution.
                    this.labels = resolveLabels(analysis.numClasses, this.customLabels);
                    this.info.kind = analysis.kind;
                    this.info.numClasses = analysis.numClasses;
                    this.info.numKeypoints = analysis.numKeypoints;
                }
                const raw = primary.data as Float32Array;
                const { detections: decoded, maxClassId } = decodeOutput(raw, analysis, this.labels, {
                    confidence: options.confidence,
                    iou: options.iou,
                    maxDetections: options.maxDetections,
                });
                if (this.labels.source === 'generic' && maxClassId + 1 > this.labels.names.length) {
                    // Re-size generic labels once we know how many classes the model emits.
                    this.labels = resolveLabels(maxClassId + 1, this.customLabels);
                }
                detections = decoded.map((detection) => ({
                    ...detection,
                    label: this.labels.names[detection.classId] ?? detection.label,
                    bbox: mapBoxToSource(detection.bbox, info),
                    keypoints: detection.keypoints?.map((keypoint) => {
                        const [x, y] = unletterboxPoint(keypoint.x, keypoint.y, info);
                        return { ...keypoint, x, y };
                    }),
                }));
            }
        }

        const postprocessMs = performance.now() - postprocessStart;
        return { detections, inferenceMs, preprocessMs, postprocessMs };
    }

    /**
     * Frees the session's WASM memory. Returns a promise because the release is
     * asynchronous: whoever is about to create another session has to wait for
     * it, or the new `initWasm()` runs out of heap.
     */
    dispose(): Promise<void> {
        const session = this.session as ort.InferenceSession & { release?: () => Promise<void> };
        return Promise.resolve(session.release?.())
            .then(() => undefined)
            .catch(() => undefined);
    }
}

function inferLayout(shape: number[]): 'nchw' | 'nhwc' {
    // [1, 3, H, W] → NCHW; [1, H, W, 3] → NHWC.
    if (shape.length === 4 && shape[1] === 3) return 'nchw';
    if (shape.length === 4 && shape[3] === 3) return 'nhwc';
    return 'nchw';
}

function resolveInputSize(shape: number[], layout: 'nchw' | 'nhwc', fallback: number): number {
    if (shape.length !== 4) return fallback;
    const height = layout === 'nchw' ? shape[2] : shape[1];
    const width = layout === 'nchw' ? shape[3] : shape[2];
    // Dynamic dims arrive as -1; YOLO exports are square, so either axis works.
    if (height > 0) return height;
    if (width > 0) return width;
    return fallback;
}

function firstAnalysis(shapes: number[][]): TaskAnalysis | null {
    for (const shape of shapes) {
        const analysis = analyseOutput(shape);
        if (analysis) return analysis;
    }
    return null;
}

function applyOverride(
    analysis: TaskAnalysis | null,
    override: 'auto' | 'detect' | 'pose'
): TaskAnalysis | null {
    if (!analysis || override === 'auto' || analysis.kind === override) return analysis;
    if (override === 'pose') {
        const keypoints = (analysis.attrs - 5) / 3;
        if (!Number.isInteger(keypoints) || keypoints < 1) return analysis;
        return { ...analysis, kind: 'pose', numClasses: 1, numKeypoints: keypoints };
    }
    // Force detection semantics: every attribute after the box is a class score.
    return {
        ...analysis,
        kind: 'detect',
        numClasses: analysis.attrs - 4,
        numKeypoints: 0,
    };
}

function mapBoxToSource(
    box: [number, number, number, number],
    info: LetterboxInfo
): [number, number, number, number] {
    const [x1, y1] = unletterboxPoint(box[0], box[1], info);
    const [x2, y2] = unletterboxPoint(box[2], box[3], info);
    return [x1, y1, x2, y2];
}
