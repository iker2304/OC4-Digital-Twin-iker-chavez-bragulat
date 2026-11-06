/**
 * Geometry helpers shared by the inference layer (letterbox math) and the
 * overlay layers (mapping model coordinates onto what the user actually sees).
 */

export interface LetterboxInfo {
    scale: number;
    padX: number;
    padY: number;
    srcWidth: number;
    srcHeight: number;
    inputSize: number;
}

/** Aspect-preserving fit inside a square `inputSize` box, padding centered. */
export function computeLetterbox(srcWidth: number, srcHeight: number, inputSize: number): LetterboxInfo {
    const safeW = srcWidth > 0 ? srcWidth : inputSize;
    const safeH = srcHeight > 0 ? srcHeight : inputSize;
    const scale = Math.min(inputSize / safeW, inputSize / safeH);
    const newW = safeW * scale;
    const newH = safeH * scale;
    return {
        scale,
        padX: (inputSize - newW) / 2,
        padY: (inputSize - newH) / 2,
        srcWidth: safeW,
        srcHeight: safeH,
        inputSize,
    };
}

/** Letterboxed input space → original source pixels. */
export function unletterboxPoint(x: number, y: number, info: LetterboxInfo): [number, number] {
    const scale = info.scale > 0 ? info.scale : 1;
    return [(x - info.padX) / scale, (y - info.padY) / scale];
}

export function unletterboxBox(
    box: [number, number, number, number],
    info: LetterboxInfo
): [number, number, number, number] {
    const [x1, y1] = unletterboxPoint(box[0], box[1], info);
    const [x2, y2] = unletterboxPoint(box[2], box[3], info);
    return [x1, y1, x2, y2];
}

/**
 * Vertical/horizontal offset produced by CSS `object-fit: cover`.
 * The stream is almost never the same aspect ratio as its container, so the
 * browser crops it; overlay coordinates must apply the same crop or the boxes
 * drift away from the objects.
 */
export interface CoverTransform {
    scale: number;
    offsetX: number;
    offsetY: number;
    /** Displayed (visible) region of the source, in source pixels. */
    visibleWidth: number;
    visibleHeight: number;
}

export function computeCover(
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
    mirrored = false
): CoverTransform {
    if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) {
        return { scale: 1, offsetX: 0, offsetY: 0, visibleWidth: srcWidth, visibleHeight: srcHeight };
    }
    const scale = Math.max(dstWidth / srcWidth, dstHeight / srcHeight);
    const visibleWidth = dstWidth / scale;
    const visibleHeight = dstHeight / scale;
    const offsetX = mirrored
        ? (srcWidth - visibleWidth) / 2 + visibleWidth
        : (srcWidth - visibleWidth) / 2;
    return { scale, offsetX, offsetY: (srcHeight - visibleHeight) / 2, visibleWidth, visibleHeight };
}

/** Source pixels → CSS pixels in the container, honouring the cover crop. */
export function sourceToDisplay(
    x: number,
    y: number,
    cover: CoverTransform,
    mirrored = false
): [number, number] {
    const dx = mirrored ? cover.offsetX - x : x - cover.offsetX;
    return [dx * cover.scale, (y - cover.offsetY) * cover.scale];
}

/** CSS pixels in the container → Normalized Device Coordinates (y up). */
export function displayToNdc(x: number, y: number, width: number, height: number): [number, number] {
    return [(x / width) * 2 - 1, -((y / height) * 2 - 1)];
}

export function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}
