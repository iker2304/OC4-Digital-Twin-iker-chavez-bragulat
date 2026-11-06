/**
 * Scene illumination, estimated on demand from the current camera frame.
 *
 * ## Why it is lazy
 *
 * A lighting model is only useful when the user asks for it (a manual button in
 * the settings), and it is the last thing the app needs to run out of memory on
 * a phone. So nothing is downloaded or instantiated until that button is
 * pressed, and the progress bar is real: the weights are fetched with the same
 * streaming helper the ONNX detector uses.
 *
 * ## The contract the ONNX file must satisfy
 *
 * `public/models/light.onnx` — a `sun_model_513`-style regressor, exported at
 * whatever input size it wants (read from the session, 513 is the fallback):
 *
 *   input : 1×3×H×W, RGB, values in [0, 1]
 *   output: [azimuth, elevation] or [azimuth, elevation, intensity]
 *           angles in **radians**, intensity in [0, 1] (relative, not lux).
 *
 * Nothing else is assumed: the size, the number of outputs and even the missing
 * file are handled, which is why the button can be shipped before the weights.
 */
import type { InferenceSession } from 'onnxruntime-web';
import { fetchWithProgress, formatBytes } from '../async';
import type { DownloadProgress } from '../async';
import { withBase } from '../env';
import { createSession } from '../inference/ortAssets';

/** Where the optional light model lives. */
export const LIGHT_MODEL_URL = withBase('/models/light.onnx');
/** Input size of the reference network (`sun_model_513`). */
const FALLBACK_INPUT = 513;

export interface LightEstimate {
    /** Sun/light azimuth, degrees, in the camera's frame. */
    azimuthDeg: number;
    /** Elevation above the horizon, degrees (null when the model omits it). */
    elevationDeg: number | null;
    /** Relative intensity 0..1 — the camera's auto-exposure makes lux unmeasurable. */
    intensity: number | null;
    /** Inference time, milliseconds. */
    ms: number;
    provider: string;
}

let session: InferenceSession | null = null;
let provider = '';

/**
 * Whether this build ships a light model at all.
 *
 * Cheap on purpose: a HEAD (with a one-byte range fallback for proxies that
 * refuse it) and nothing else — the file is never downloaded to find out.
 */
export async function hasLightModel(): Promise<boolean> {
    const timeout = AbortSignal.timeout(4000);
    try {
        const head = await fetch(LIGHT_MODEL_URL, { method: 'HEAD', signal: timeout });
        if (head.ok) return true;
    } catch {
        // Fall through to the range request.
    }
    try {
        const response = await fetch(LIGHT_MODEL_URL, {
            headers: { Range: 'bytes=0-0' },
            signal: AbortSignal.timeout(4000),
        });
        await response.body?.cancel().catch(() => undefined);
        return response.ok || response.status === 206;
    } catch {
        return false;
    }
}

/** Downloads and instantiates the model. Only called from the button. */
export async function loadLightSession(
    onProgress: (progress: DownloadProgress) => void
): Promise<InferenceSession> {
    if (session) return session;
    const bytes = await fetchWithProgress(LIGHT_MODEL_URL, {
        onProgress,
        stallTimeoutMs: 20000,
    });
    // Bytes (not a URL): the worker proxy is not worth it for a one-shot run,
    // and a detached buffer would break a second attempt.
    const created = await createSession(bytes, { preferWebGpu: true });
    session = created.session;
    provider = created.provider;
    return session;
}

export function disposeLightSession() {
    const current = session;
    session = null;
    provider = '';
    void current?.release?.();
}

function inputSizeOf(target: InferenceSession): { width: number; height: number } {
    const name = target.inputNames?.[0];
    const dims = (target as unknown as { inputMetadata?: Record<string, { dims?: number[] }> })
        .inputMetadata?.[name ?? '']?.dims;
    const height = Number(dims?.[2]) || FALLBACK_INPUT;
    const width = Number(dims?.[3]) || FALLBACK_INPUT;
    return { width, height };
}

/**
 * Runs the model on one frame of the video and returns the light direction.
 *
 * The frame is squashed to the input size (no letterbox): a lighting estimator
 * only needs the coarse layout — sky above, ground below — not metric geometry.
 */
export async function estimateLight(video: HTMLVideoElement): Promise<LightEstimate> {
    const target = await (session ? Promise.resolve(session) : Promise.reject(new Error('modelo no cargado')));
    const { width, height } = inputSizeOf(target);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('no se pudo crear el canvas para la estimación de luz');
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;

    const plane = width * height;
    const input = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i += 1) {
        input[i] = pixels[i * 4] / 255;
        input[plane + i] = pixels[i * 4 + 1] / 255;
        input[plane * 2 + i] = pixels[i * 4 + 2] / 255;
    }

    const ort = await import('onnxruntime-web');
    const tensor = new ort.Tensor('float32', input, [1, 3, height, width]);
    const started = performance.now();
    const outputs = await target.run({ [target.inputNames[0]]: tensor });
    const ms = performance.now() - started;

    const first = outputs[target.outputNames[0]];
    const data = first.data as Float32Array;
    if (data.length < 2) throw new Error(`salida inesperada del modelo de luz (${data.length} valores)`);

    const toDegrees = (value: number) => (Math.abs(value) <= Math.PI * 2 ? (value * 180) / Math.PI : value);
    return {
        azimuthDeg: toDegrees(data[0]),
        elevationDeg: data.length >= 3 ? toDegrees(data[1]) : null,
        intensity: data.length >= 3 ? Math.min(1, Math.max(0, data[data.length - 1])) : null,
        ms,
        provider,
    };
}

/** Human-readable size, for the button hint ("modelo de 12 MB aún sin cargar"). */
export { formatBytes };
