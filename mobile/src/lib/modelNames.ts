/**
 * What our `.onnx` file names mean.
 *
 * The bench page and the app's own model loader both offer the same three knobs
 * (architecture, input size, quantisation), and both have to agree on which
 * combinations exist. The naming convention is the single source of truth:
 *
 *     yolo-pose-<family>[-coco]-<px>[-int8].onnx
 *
 * so `yolo-pose-s-480-int8.onnx` is the *small* network at 480 px, quantised.
 * Anything that does not follow it (a user's own export, a stray `best.onnx`)
 * parses to `null` and keeps being listed by name only.
 */
export interface ModelSpec {
    /** `n`, `s`, `m`, `l`, `x` — the size of the network, not of the image. */
    family: string;
    /** Square input side in pixels. */
    size: number;
    quant: 'fp32' | 'int8';
}

export const FAMILY_LABELS: Record<string, string> = {
    n: 'nano',
    s: 'small',
    m: 'medium',
    l: 'large',
    x: 'xlarge',
};

export function parseModelFile(file: string): ModelSpec | null {
    const match = /^yolo-pose-([a-z])(?:-coco)?-(\d{3,4})(-int8)?\.onnx$/i.exec(file);
    if (!match) return null;
    return {
        family: match[1].toLowerCase(),
        size: Number(match[2]),
        quant: match[3] ? 'int8' : 'fp32',
    };
}

/**
 * Keep only the best validated nano/small export for each input size.
 *
 * Nano-200 is the latest fine-tune; nano-640 is the full-data run. Small uses
 * the COCO runs through 400px, then the better validated s-480/512/640 models.
 */
export function isBenchmarkModelFile(file: string): boolean {
    const match = /^yolo-pose-([ns])(?:-(coco))?-(\d{3,4})(-int8)?\.onnx$/i.exec(file);
    if (!match) return false;

    const [, family, coco, rawSize] = match;
    const size = Number(rawSize);
    if (family.toLowerCase() === 'n') {
        return !coco && [200, 256, 360, 400, 480, 640].includes(size);
    }

    if (coco) return [200, 256, 360, 400].includes(size);
    return [480, 512, 640].includes(size);
}

export function filterBenchmarkModels<T extends { file: string }>(models: T[]): T[] {
    return models.filter(({ file }) => isBenchmarkModelFile(file));
}

/** `small · 480 px · int8`, for summaries and tooltips. */
export function describeSpec(spec: ModelSpec): string {
    const family = FAMILY_LABELS[spec.family] ?? spec.family;
    return `${family} · ${spec.size} px · ${spec.quant}`;
}
