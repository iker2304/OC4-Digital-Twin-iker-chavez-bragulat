/**
 * Operational Modal Analysis on the keypoints the detector already gives us.
 *
 * ## What is measured
 *
 * The identity of a rigid body is recovered every frame by the PnP solve, so the
 * *rigid* motion (camera and platform moving together) is already explained by
 * the pose. What it does **not** explain is the **reprojection residual** of each
 * keypoint: that is the part of the observation the rigid model cannot reproduce,
 * i.e. exactly the deformation (plus noise) an OMA is after.
 *
 * So each keypoint contributes two series, `u` and `v`, and those are what get
 * windowed (Hann), detrended and FFT'd. Averaging the normalised spectra of the
 * 22 series gives a single, much cleaner spectrum than any individual point.
 *
 * A rigid solid has no deformation, so on a perfectly rigid target the residual
 * spectrum is flat noise — that is the honest answer, and the panel says so by
 * showing how far each peak stands above the noise floor.
 */
import { magnitudeSpectrum } from './fft';

/** Samples kept per series: at 10 Hz this is ~9 s of history. */
const WINDOW = 96;
/** Fewer samples than this and the spectrum means nothing. */
const MIN_SAMPLES = 48;
/** Frequencies below this are drift, not modes. */
const MIN_HZ = 0.05;
/** Frequencies above this cannot be resolved by the detector's frame rate. */
const MAX_HZ = 3;

export interface SpectrumPeak {
    freqHz: number;
    /** Mean magnitude at the peak, in pixels. */
    magnitude: number;
    /** How many times the noise floor it stands above (1 = nothing there). */
    prominence: number;
}

export interface OmaSnapshot {
    frequencies: number[];
    magnitudes: number[];
    peaks: SpectrumPeak[];
    sampleRate: number;
    samples: number;
}

function ringPush(series: Float64Array, value: number) {
    series.copyWithin(0, 1);
    series[series.length - 1] = value;
}

export class ModalTracker {
    private readonly series: Float64Array[];
    private readonly timestamps: Float64Array;

    constructor(points: number, window = WINDOW) {
        this.series = Array.from({ length: points * 2 }, () => new Float64Array(window));
        this.timestamps = new Float64Array(window);
        this.filled = 0;
    }

    private filled: number;

    get samples(): number {
        return this.filled;
    }

    /** Median interval between samples, in milliseconds. */
    get sampleIntervalMs(): number {
        if (this.filled < 2) return 0;
        const count = Math.min(this.filled, this.timestamps.length);
        const first = this.timestamps[this.timestamps.length - count];
        const last = this.timestamps[this.timestamps.length - 1];
        return (last - first) / (count - 1);
    }

    /**
     * @param residuals per-keypoint reprojection error, in pixels. `null` on a
     * frame without a usable pose: the gap is skipped instead of being filled
     * with zeros, which would fake a spike at DC.
     */
    push(residuals: Array<{ u: number; v: number }> | null, timestampMs: number): void {
        if (!residuals) return;
        const points = this.series.length / 2;
        for (let i = 0; i < points; i += 1) {
            const residual = residuals[i];
            ringPush(this.series[i * 2], Number.isFinite(residual.u) ? residual.u : 0);
            ringPush(this.series[i * 2 + 1], Number.isFinite(residual.v) ? residual.v : 0);
        }
        ringPush(this.timestamps, timestampMs);
        this.filled = Math.min(this.filled + 1, this.timestamps.length);
    }

    reset(): void {
        for (const series of this.series) series.fill(0);
        this.timestamps.fill(0);
        this.filled = 0;
    }

    /**
     * Oscillating part of the mean residual, in pixels: the current value minus
     * its slow average. This is what makes the twin visibly breathe without
     * needing the FFT — the spectrum explains *what* is oscillating, this gives
     * the instantaneous motion to render.
     */
    deviation(slowSamples = 24): { u: number; v: number } | null {
        if (this.filled < 8) return null;
        const count = Math.min(this.filled, this.timestamps.length);
        const points = this.series.length / 2;
        const meansU = new Float64Array(count);
        const meansV = new Float64Array(count);
        for (let k = 0; k < count; k += 1) {
            const index = this.timestamps.length - count + k;
            let sumU = 0;
            let sumV = 0;
            for (let p = 0; p < points; p += 1) {
                sumU += this.series[p * 2][index];
                sumV += this.series[p * 2 + 1][index];
            }
            meansU[k] = sumU / points;
            meansV[k] = sumV / points;
        }
        const window = Math.min(slowSamples, count);
        let slowU = 0;
        let slowV = 0;
        for (let k = count - window; k < count; k += 1) {
            slowU += meansU[k] / window;
            slowV += meansV[k] / window;
        }
        return { u: meansU[count - 1] - slowU, v: meansV[count - 1] - slowV };
    }

    /** Averaged normalised spectrum, or `null` while there is not enough data. */
    spectrum(): OmaSnapshot | null {
        if (this.filled < MIN_SAMPLES) return null;
        const intervalMs = this.sampleIntervalMs;
        if (!(intervalMs > 0)) return null;
        const sampleRate = 1000 / intervalMs;

        const count = Math.min(this.filled, this.timestamps.length);
        let frequencies: Float64Array | null = null;
        let accumulated: Float64Array | null = null;

        for (const series of this.series) {
            const slice = series.slice(series.length - count);
            const result = magnitudeSpectrum(slice, sampleRate);
            if (!accumulated) {
                accumulated = new Float64Array(result.magnitudes.length);
                frequencies = result.frequencies;
            }
            for (let i = 0; i < accumulated.length; i += 1) {
                accumulated[i] += result.magnitudes[i];
            }
        }
        if (!accumulated || !frequencies) return null;

        const values = Float64Array.from(accumulated, (value) => value / this.series.length);
        const usable: number[] = [];
        for (let i = 0; i < values.length; i += 1) {
            const hz = frequencies[i];
            if (hz >= MIN_HZ && hz <= MAX_HZ) usable.push(values[i]);
        }
        // Noise floor = median of the usable band: robust against the peaks.
        const sorted = [...usable].sort((left, right) => left - right);
        const floor = sorted[Math.floor(sorted.length / 2)] || 1e-6;

        const peaks: SpectrumPeak[] = [];
        for (let i = 1; i < values.length - 1; i += 1) {
            const hz = frequencies[i];
            if (hz < MIN_HZ || hz > MAX_HZ) continue;
            const value = values[i];
            if (value <= values[i - 1] || value <= values[i + 1]) continue;
            // Parabolic interpolation: the peak is rarely exactly on a bin.
            const left = values[i - 1];
            const right = values[i + 1];
            const denominator = left - 2 * value + right;
            const offset = denominator !== 0 ? (0.5 * (left - right)) / denominator : 0;
            const refinedHz = hz + (offset * sampleRate) / values.length;
            peaks.push({
                freqHz: refinedHz,
                magnitude: value,
                prominence: value / floor,
            });
        }
        peaks.sort((left, right) => right.prominence - left.prominence);

        return {
            frequencies: Array.from(frequencies.slice(0, Math.floor(frequencies.length / 2))),
            magnitudes: Array.from(values.slice(0, Math.floor(values.length / 2))),
            peaks: peaks.slice(0, 4),
            sampleRate,
            samples: count,
        };
    }
}

/** Shared instance: the loop writes, the panel and the scene read. */
export const modalTracker = new ModalTracker(11);
