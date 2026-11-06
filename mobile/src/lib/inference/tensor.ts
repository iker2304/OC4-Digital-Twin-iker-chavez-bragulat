/**
 * Frame → input tensor conversion (letterbox + normalize).
 *
 * Mirrors the preprocessing used by the Python pipeline in
 * `backend/app/flow_executor.py` (ONNXModel._preprocess) but always
 * letterboxes, so overlays can be mapped back exactly instead of relying on a
 * naive resize.
 */
import * as ort from 'onnxruntime-web';
import { computeLetterbox, type LetterboxInfo } from '../geometry';

export type Normalization = 'zero-one' | 'imagenet';

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

/**
 * Reused input buffer (640·640·3 floats ≈ 4.9 MB).
 *
 * Allocating that per frame is pure waste and shows up as GC pauses — jitter in
 * a loop that already has one second of latency. It is safe to reuse because the
 * inference loop is strictly serial: the previous `run()` has finished before the
 * next `prepareInput` starts.
 *
 * Not reused when the runtime runs in a worker (`proxy`): there the tensor is
 * handed to the worker and may be transferred, which would leave this buffer
 * detached and poison every later frame.
 */
let floatScratch: Float32Array | null = null;

function floatBuffer(length: number): Float32Array {
    if (ort.env.wasm.proxy) return new Float32Array(length);
    if (!floatScratch || floatScratch.length !== length) floatScratch = new Float32Array(length);
    return floatScratch;
}

function getScratch(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    if (!scratch) {
        scratch = document.createElement('canvas');
        scratchCtx = scratch.getContext('2d', { willReadFrequently: true, alpha: false });
    }
    if (!scratchCtx) throw new Error('No se pudo crear el canvas 2D para el preprocesado');
    if (scratch.width !== size || scratch.height !== size) {
        scratch.width = size;
        scratch.height = size;
    }
    return [scratch, scratchCtx];
}

export interface PreparedInput {
    tensor: ort.Tensor;
    info: LetterboxInfo;
}

export function prepareInput(
    source: CanvasImageSource,
    srcWidth: number,
    srcHeight: number,
    inputSize: number,
    layout: 'nchw' | 'nhwc',
    normalization: Normalization = 'zero-one'
): PreparedInput {
    const [, ctx] = getScratch(inputSize);
    const info = computeLetterbox(srcWidth, srcHeight, inputSize);

    // Neutral grey padding keeps the border from producing phantom activations.
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, inputSize, inputSize);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(
        source,
        0,
        0,
        srcWidth,
        srcHeight,
        info.padX,
        info.padY,
        srcWidth * info.scale,
        srcHeight * info.scale
    );

    const { data } = ctx.getImageData(0, 0, inputSize, inputSize);
    const pixels = inputSize * inputSize;
    const float = floatBuffer(pixels * 3);

    if (normalization === 'imagenet') {
        for (let i = 0, p = 0; i < pixels; i += 1, p += 4) {
            const r = data[p] / 255;
            const g = data[p + 1] / 255;
            const b = data[p + 2] / 255;
            float[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
            float[pixels + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
            float[pixels * 2 + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
        }
    } else {
        for (let i = 0, p = 0; i < pixels; i += 1, p += 4) {
            float[i] = data[p] / 255;
            float[pixels + i] = data[p + 1] / 255;
            float[pixels * 2 + i] = data[p + 2] / 255;
        }
    }

    const dims = layout === 'nchw' ? [1, 3, inputSize, inputSize] : [1, inputSize, inputSize, 3];
    const tensor = new ort.Tensor(
        'float32',
        layout === 'nchw' ? float : interleaveToNhwc(float, pixels),
        dims
    );

    return { tensor, info };
}

/** NCHW planar buffer → NHWC interleaved buffer. */
function interleaveToNhwc(planar: Float32Array, pixels: number): Float32Array {
    const out = new Float32Array(pixels * 3);
    for (let i = 0; i < pixels; i += 1) {
        out[i * 3] = planar[i];
        out[i * 3 + 1] = planar[pixels + i];
        out[i * 3 + 2] = planar[pixels * 2 + i];
    }
    return out;
}

export function configurePreprocessing() {
    // Force canvas allocation up-front so the first inference does not stutter.
    getScratch(64);
}
