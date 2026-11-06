/**
 * Sun direction from a single frame, without any model.
 *
 * ## Why this works
 *
 * An LDR frame already contains the answer, coarsely: the sky is brightest
 * towards the sun, because scattering concentrates the luminance around it. So
 * the direction can be read off as "the brightest blob of the sky", which is a
 * weighted centroid over a few tens of thousands of pixels — about a millisecond
 * of work and not a byte of model.
 *
 * The result is expressed **in the camera frame** (the pixel's ray through the
 * intrinsics), which is exactly what `lightVectorModelSpace` expects: the PnP
 * pose turns it into the model frame so the twin is lit from the same side as
 * the real machine.
 *
 * What it cannot do: tell you the absolute lux (the camera auto-exposes), or
 * separate the sun from a very bright lamp. The confidence value says how much
 * to trust the direction — overcast skies give a diffuse blob and therefore a
 * low score.
 */
import { cameraPosition } from '../pose/cameraRig';
import { projectPoint } from '../pose/solvePnP';
import type { Intrinsics, Pose } from '../pose/solvePnP';

export interface SunEstimate {
    /** Azimuth in the camera frame, degrees, positive to the right. */
    azimuthDeg: number;
    /** Elevation above the horizon, degrees, positive upwards. */
    elevationDeg: number;
    /** 0..1 — how concentrated and how bright the winning blob was. */
    confidence: number;
    /** Fraction of the sampled frame that was sky. */
    skyFraction: number;
    /** Where the direction came from. */
    source: 'sky' | 'brightest';
    /** Pixel of the blob that won (for debugging and for drawing it). */
    pixel: { x: number; y: number };
}

/** Keep the sampling under this many pixels: ~1 ms even on a phone. */
const SAMPLE_BUDGET = 60000;
/** Below this fraction of sky the estimate falls back to the whole frame. */
const MIN_SKY_FRACTION = 0.04;
/** The brightest core is this percentile of the region. */
const CORE_PERCENTILE = 0.97;
/** The frame must contain something genuinely bright… */
const MIN_PEAK_LUMINANCE = 0.35;
/** …and it must stand out from the rest, or there is no direction to read. */
const MIN_CONTRAST = 0.12;

function luminanceAt(data: Uint8ClampedArray, index: number): number {
    // Rec. 709 luma: what the eye (and a lighting estimate) cares about.
    return (0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]) / 255;
}

/**
 * Line of the horizon in image space, as `a·x + b·y + c = 0`, plus the sign that
 * points to the sky.
 *
 * The horizon is the vanishing line of the world's horizontal plane: two
 * directions with zero vertical component, projected at a huge distance, give
 * two points on it. It needs the pose — which pose mode already solves — and
 * without one the middle of the frame is used instead.
 */
function horizonLine(
    K: Intrinsics,
    pose: Pose | null,
    width: number,
    height: number
): { a: number; b: number; c: number; skySign: number } {
    const middle = { a: 0, b: 1, c: -height * 0.45, skySign: -1 };
    if (!pose) return middle;

    const origin = cameraPosition(pose);
    const far = 100000;
    const point = (dx: number, dz: number) => {
        const projected = projectPoint(
            { x: origin.x + dx * far, y: origin.y, z: origin.z + dz * far },
            pose,
            K
        );
        return Number.isFinite(projected[0]) && Number.isFinite(projected[1]) ? projected : null;
    };
    const first = point(1, 0);
    const second = point(0, 1);
    if (!first || !second) return middle;

    const a = second[1] - first[1];
    const b = first[0] - second[0];
    const c = -(a * first[0] + b * first[1]);
    if (Math.abs(a) + Math.abs(b) < 1e-9) return middle;
    // Which side is up: evaluate at the top centre of the frame.
    const topSign = Math.sign(a * (width / 2) + b * 0 + c) || -1;
    return { a, b, c, skySign: topSign };
}

export function estimateSunDirection(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    K: Intrinsics,
    pose: Pose | null = null
): SunEstimate | null {
    if (width < 8 || height < 8) return null;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / SAMPLE_BUDGET)));
    const horizon = horizonLine(K, pose, width, height);

    const candidates: Array<{ x: number; y: number; luminance: number }> = [];
    const all: Array<{ x: number; y: number; luminance: number }> = [];
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const luminance = luminanceAt(rgba, (y * width + x) * 4);
            const sample = { x, y, luminance };
            all.push(sample);
            const side = Math.sign(horizon.a * x + horizon.b * y + horizon.c);
            if (side === horizon.skySign) candidates.push(sample);
        }
    }
    if (all.length === 0) return null;

    const skyFraction = candidates.length / all.length;
    const source: 'sky' | 'brightest' = skyFraction >= MIN_SKY_FRACTION ? 'sky' : 'brightest';
    const region = source === 'sky' ? candidates : all;

    const sorted = [...region].sort((left, right) => left.luminance - right.luminance);
    const threshold = sorted[Math.max(0, Math.floor(sorted.length * CORE_PERCENTILE) - 1)].luminance;
    if (threshold <= 0.02) return null;

    // A frame with no contrast is not a light source: a uniform grey wall would
    // otherwise "have" a brightest pixel and produce a confident-looking number.
    const median = sorted[Math.floor(sorted.length / 2)].luminance;
    const peakLuminance = sorted[sorted.length - 1].luminance;
    if (peakLuminance < MIN_PEAK_LUMINANCE || peakLuminance - median < MIN_CONTRAST) return null;

    let weight = 0;
    let sumX = 0;
    let sumY = 0;
    let peak = 0;
    for (const sample of region) {
        if (sample.luminance < threshold) continue;
        const w = (sample.luminance - threshold) ** 2 + 1e-6;
        weight += w;
        sumX += sample.x * w;
        sumY += sample.y * w;
        peak = Math.max(peak, sample.luminance);
    }
    if (weight <= 0) return null;

    const cx = sumX / weight;
    const cy = sumY / weight;

    // Spread of the blob: a compact highlight is a sun, a wide veil is an
    // overcast sky. Normalised by the diagonal so it does not depend on size.
    let variance = 0;
    for (const sample of region) {
        if (sample.luminance < threshold) continue;
        const w = (sample.luminance - threshold) ** 2 + 1e-6;
        variance += w * ((sample.x - cx) ** 2 + (sample.y - cy) ** 2);
    }
    const spread = Math.sqrt(variance / weight) / Math.hypot(width, height);
    const concentration = Math.max(0, 1 - spread / 0.18);
    const brightness = Math.min(1, Math.max(0, (peak - 0.6) / 0.4));
    const confidence = Math.max(0, Math.min(1, concentration * 0.7 + brightness * 0.3));

    // Pixel → ray (OpenCV camera axes: x right, y down, z forward).
    const dx = (cx - K.cx) / K.fx;
    const dy = (cy - K.cy) / K.fy;
    const length = Math.hypot(dx, dy, 1);
    const ray = { x: dx / length, y: dy / length, z: 1 / length };

    return {
        azimuthDeg: (Math.atan2(ray.x, ray.z) * 180) / Math.PI,
        elevationDeg: (-Math.asin(ray.y) * 180) / Math.PI,
        confidence,
        skyFraction,
        source,
        pixel: { x: cx, y: cy },
    };
}
