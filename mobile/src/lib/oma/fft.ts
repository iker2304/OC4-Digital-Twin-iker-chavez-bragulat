/**
 * Minimal real-input FFT for the modal analysis.
 *
 * Iterative radix-2, in place, no dependencies: the input is zero-padded to the
 * next power of two, detrended (mean and slope removed) and windowed with a Hann
 * taper, because a keypoint series drifts with the camera and an abrupt window
 * edge smears the spectrum into every bin.
 */

/** Detrend + Hann + zero pad to a power of two. */
function prepare(samples: Float64Array): { real: Float64Array; imag: Float64Array } {
    const count = samples.length;
    const mean = samples.reduce((sum, value) => sum + value, 0) / count;
    // Least-squares slope: a slow drift is not a mode.
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < count; i += 1) {
        const t = i - (count - 1) / 2;
        numerator += t * (samples[i] - mean);
        denominator += t * t;
    }
    const slope = denominator > 0 ? numerator / denominator : 0;

    let size = 1;
    while (size < count) size *= 2;

    const real = new Float64Array(size);
    const imag = new Float64Array(size);
    for (let i = 0; i < count; i += 1) {
        const t = i - (count - 1) / 2;
        const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1));
        real[i] = (samples[i] - mean - slope * t) * window;
    }
    return { real, imag };
}

/** In-place iterative radix-2 Cooley-Tukey. */
function transform(real: Float64Array, imag: Float64Array) {
    const size = real.length;
    for (let i = 1, j = 0; i < size; i += 1) {
        let bit = size >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
    }
    for (let length = 2; length <= size; length <<= 1) {
        const angle = (-2 * Math.PI) / length;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let i = 0; i < size; i += length) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < length / 2; k += 1) {
                const ar = real[i + k];
                const ai = imag[i + k];
                const br = real[i + k + length / 2];
                const bi = imag[i + k + length / 2];
                const tr = br * cr - bi * ci;
                const ti = br * ci + bi * cr;
                real[i + k] = ar + tr;
                imag[i + k] = ai + ti;
                real[i + k + length / 2] = ar - tr;
                imag[i + k + length / 2] = ai - ti;
                const nextCr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nextCr;
            }
        }
    }
}

/**
 * Magnitude spectrum of one signal, normalised so the values do not depend on
 * the number of samples (they can be averaged across keypoints).
 *
 * Returns the positive half of the spectrum: `magnitudes[i]` corresponds to
 * `i * sampleRate / size` hertz.
 */
export function magnitudeSpectrum(
    samples: Float64Array,
    sampleRate: number
): { frequencies: Float64Array; magnitudes: Float64Array } {
    const { real, imag } = prepare(samples);
    transform(real, imag);
    const size = real.length;
    const half = size / 2;
    const frequencies = new Float64Array(half);
    const magnitudes = new Float64Array(half);
    for (let i = 0; i < half; i += 1) {
        frequencies[i] = (i * sampleRate) / size;
        magnitudes[i] = Math.hypot(real[i], imag[i]) / samples.length;
    }
    return { frequencies, magnitudes };
}
