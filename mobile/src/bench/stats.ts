/**
 * Small statistics helpers for the benchmark page.
 *
 * Median and p95 next to the mean on purpose: a phone that throttles after two
 * seconds shows a mean that looks fine and a p95 that does not. Both numbers
 * together are what tells you whether the device is stable.
 */
export interface Stats {
    count: number;
    mean: number;
    median: number;
    p95: number;
    min: number;
    max: number;
}

export function stats(values: number[]): Stats {
    const clean = values.filter((value) => Number.isFinite(value));
    if (clean.length === 0) {
        return { count: 0, mean: 0, median: 0, p95: 0, min: 0, max: 0 };
    }
    const sorted = [...clean].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const at = (fraction: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
    return {
        count: sorted.length,
        mean: round(sum / sorted.length),
        median: round(at(0.5)),
        p95: round(at(0.95)),
        min: round(sorted[0]),
        max: round(sorted[sorted.length - 1]),
    };
}

/** One decimal is plenty and keeps the JSON readable. */
export function round(value: number): number {
    return Math.round(value * 10) / 10;
}
