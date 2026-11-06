/**
 * Constant-velocity Kalman filter over the 11 keypoints.
 *
 * Why this exists: a 640×640 pose model on a phone CPU takes ~0.5-2 s per frame,
 * so the *measurements* arrive about once a second while the camera runs at 30
 * fps. Without help, the twin can only move when a detection lands: it sits still
 * for a second and then jumps. With a filter it moves at frame rate — the model
 * anchors the real position once per second, the filter fills in between — which
 * is exactly what the original pipeline did (`kalman_utils.py`).
 *
 * The state is two scalars per keypoint and axis: position and velocity, in
 * source pixels. Between corrections the prediction is a straight line
 * (`p + v·dt`), which is what makes the overlay feel continuous; the covariance
 * keeps growing while the prediction is unattended, so the next measurement is
 * trusted more the longer it has been since the previous one.
 *
 * Everything is pure and deterministic: no timers, no globals. `predict` is
 * read-only, so asking for the same instant twice gives the same answer.
 */
import type { Keypoint } from '../../types';

export interface KalmanOptions {
    /** Measurement variance, in px². Keypoint jitter is about 1-2 px. */
    measurementNoise?: number;
    /** Process noise: higher follows motion faster, lower is smoother. */
    processNoise?: number;
    /** Hard ceiling on the estimated speed, in px/s. Avoids wild extrapolation. */
    maxSpeed?: number;
    /** How far ahead the prediction is allowed to run, in seconds. */
    maxHorizon?: number;
}

const DEFAULTS: Required<KalmanOptions> = {
    measurementNoise: 9,
    processNoise: 4000,
    maxSpeed: 4000,
    maxHorizon: 1.5,
};

/** One axis of one keypoint: position and velocity, with the 2×2 covariance. */
class Axis {
    position = 0;
    velocity = 0;
    private p00 = 100;
    private p01 = 0;
    private p11 = 1e4;

    /** Starts from a measurement, with no idea about the velocity yet. */
    reset(value: number) {
        this.position = value;
        this.velocity = 0;
        this.p00 = 100;
        this.p01 = 0;
        this.p11 = 1e4;
    }

    /** Advances the state by `dt` seconds and grows the covariance. */
    advance(dt: number, processNoise: number) {
        this.position += this.velocity * dt;
        const { p00, p01, p11 } = this;
        this.p00 = p00 + 2 * dt * p01 + dt * dt * p11 + (processNoise * dt ** 4) / 4;
        this.p01 = p01 + dt * p11 + (processNoise * dt ** 3) / 2;
        this.p11 = p11 + processNoise * dt * dt;
    }

    /** Fuses a measurement into the state. */
    update(measurement: number, measurementNoise: number, maxSpeed: number) {
        const innovationVariance = this.p00 + measurementNoise;
        const k0 = this.p00 / innovationVariance;
        const k1 = this.p01 / innovationVariance;
        const innovation = measurement - this.position;

        this.position += k0 * innovation;
        this.velocity = Math.max(
            -maxSpeed,
            Math.min(maxSpeed, this.velocity + k1 * innovation)
        );

        const p01 = this.p01;
        this.p00 = (1 - k0) * this.p00;
        this.p01 = (1 - k0) * p01;
        this.p11 = this.p11 - k1 * p01;
    }

    /** Where this axis is `dt` seconds ahead, without touching the state. */
    ahead(dt: number): number {
        return this.position + this.velocity * dt;
    }
}

export class KeypointKalman {
    private readonly axes: Axis[][];
    private readonly seen: boolean[];
    private readonly scores: number[];
    private readonly options: Required<KalmanOptions>;
    /** Timestamp of the last correction, in milliseconds. `NaN` = never. */
    private last = Number.NaN;

    constructor(count: number, options: KalmanOptions = {}) {
        this.options = { ...DEFAULTS, ...options };
        this.axes = Array.from({ length: count }, () => [new Axis(), new Axis()]);
        this.seen = new Array(count).fill(false);
        this.scores = new Array(count).fill(0);
    }

    /** Four points are the minimum the solver accepts. */
    get ready(): boolean {
        return this.seen.filter(Boolean).length >= 4;
    }

    /** Milliseconds since the last accepted measurement. */
    ageMs(now: number): number {
        return Number.isNaN(this.last) ? Number.POSITIVE_INFINITY : now - this.last;
    }

    reset() {
        this.axes.forEach((pair) => pair.forEach((axis) => axis.reset(0)));
        this.seen.fill(false);
        this.scores.fill(0);
        this.last = Number.NaN;
    }

    /**
     * Fuses one detection.
     *
     * Points below the confidence threshold are ignored rather than fused as
     * zeros — a keypoint that was not really seen must not drag the estimate.
     */
    correct(keypoints: readonly Keypoint[], timestampMs: number, minScore = 0.4) {
        const dt = Number.isNaN(this.last) ? 0 : Math.max(0, (timestampMs - this.last) / 1000);

        keypoints.forEach((keypoint, index) => {
            if (index >= this.axes.length) return;
            if (keypoint.score < minScore) return;
            if (!Number.isFinite(keypoint.x) || !Number.isFinite(keypoint.y)) return;

            const pair = this.axes[index];
            if (!this.seen[index]) {
                pair[0].reset(keypoint.x);
                pair[1].reset(keypoint.y);
                this.seen[index] = true;
            } else {
                pair[0].advance(dt, this.options.processNoise);
                pair[1].advance(dt, this.options.processNoise);
                pair[0].update(keypoint.x, this.options.measurementNoise, this.options.maxSpeed);
                pair[1].update(keypoint.y, this.options.measurementNoise, this.options.maxSpeed);
            }
            this.scores[index] = keypoint.score;
        });

        if (Number.isNaN(this.last) || timestampMs > this.last) this.last = timestampMs;
    }

    /**
     * The 11 keypoints `timestampMs` ahead of the last correction.
     *
     * Unseen points come back with score 0, so the solver's threshold skips them
     * instead of being fed a fabricated position.
     */
    predict(timestampMs: number): Keypoint[] {
        if (Number.isNaN(this.last)) return [];
        const horizon = Math.min(
            this.options.maxHorizon,
            Math.max(0, (timestampMs - this.last) / 1000)
        );

        return this.axes.map((pair, index) => ({
            x: this.seen[index] ? pair[0].ahead(horizon) : Number.NaN,
            y: this.seen[index] ? pair[1].ahead(horizon) : Number.NaN,
            score: this.seen[index] ? this.scores[index] : 0,
        }));
    }
}
