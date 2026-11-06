import { useEffect } from 'react';
import type { RefObject } from 'react';
import { useAppStore } from '../../store/appStore';
import { pickPoseDetection, updatePose } from '../pose/poseTracker';
import { KeypointKalman } from '../pose/keypointKalman';
import { captureFrame } from '../camera/syncedFrame';
import { fitRotorAngle, pickRotorDetection, smoothAngleDeg } from '../pose/rotorAngle';
import { intrinsicsFromFov, solvePnP, projectAll } from '../pose/solvePnP';
import type { Pose } from '../pose/solvePnP';
import { modalTracker } from '../oma/modalTracker';
import { KEYPOINTS_SCENE } from '../pose/keypoints3d';
import type { FrameMetrics } from '../../types';
import type { DetectionEngine, RunResult } from './engine';

interface LoopParams {
    videoRef: RefObject<HTMLVideoElement | null>;
    engine: DetectionEngine | null;
    enabled: boolean;
}

/** Exponential moving average, enough to keep the FPS readout stable. */
const FPS_SMOOTHING = 0.8;
const MAX_CONSECUTIVE_ERRORS = 8;
/** How long to wait after that many failures before trying again. */
const BACKOFF_MS = 2000;

/**
 * Between detections the keypoints are extrapolated, so the twin can move at
 * frame rate instead of waiting ~1 s for the next inference. These bound that
 * guess: refresh at ~30 Hz, and stop guessing once the last real measurement is
 * older than `PREDICT_LIMIT_MS`.
 */
const PREDICT_INTERVAL_MS = 33;
const PREDICT_LIMIT_MS = 1200;
/** How much of each new rotor fit is applied: enough to be smooth, fast enough to follow. */
const ROTOR_SMOOTHING = 0.4;

/**
 * Drives the inference loop.
 *
 * Runs on `requestAnimationFrame` but self-throttles: it never schedules a new
 * inference while one is still in flight, and never exceeds `maxFps`. That
 * keeps the phone from thermal-throttling within seconds.
 */
export function useInferenceLoop({ videoRef, engine, enabled }: LoopParams) {
    useEffect(() => {
        if (!engine || !enabled) return;

        let cancelled = false;
        let busy = false;
        let errors = 0;
        let rafId = 0;
        let lastRunAt = 0;
        let lastFrameAt = 0;
        let fps = 0;
        /** After too many failures the loop waits instead of stopping for good. */
        let pausedUntil = 0;
        /** Extrapolates the keypoints between inferences (see `predict`). */
        const kalman = new KeypointKalman(KEYPOINTS_SCENE.length);
        let lastPredictAt = 0;
        /**
         * Last *measured* pose and when it arrived.
         *
         * The extrapolation is only allowed to run for a short while after a real
         * measurement: with a slow detector the Kalman velocity keeps pushing the
         * pose in the same direction long after the platform stopped, and that is
         * exactly the "sliding / inertia" the overlay showed. Past the horizon the
         * measured pose is restored, so the twin freezes where it was last seen.
         */
        let lastMeasuredPose: Pose | null = null;
        let lastMeasuredAt = 0;
        let measuredInterval = 0;
        /**
         * When a measurement was last *accepted* (not merely solved).
         *
         * This is the clock the tracker ages against. Using "solved" instead is
         * what kept the overlay frozen: a pose that the jump guard keeps rejecting
         * still counts as solved, so the age never reached `REACQUIRE_AFTER_MS`
         * and every following frame was rejected for the same reason.
         */
        let lastAcceptedAt = 0;
        /** Exponential averages for the on-screen instrumentation. */
        let latencyAvg = 0;
        let poseAvg = 0;

        /**
         * Extrapolates the last measurement and re-solves the pose for the current
         * instant. Result: the twin keeps moving at frame rate while the model
         * only anchors it about once per second.
         */
        const predict = (timestamp: number) => {
            if (timestamp - lastPredictAt < PREDICT_INTERVAL_MS) return;
            const app = useAppStore.getState();
            if (!app.poseEnabled) return;
            /**
             * `syncFrame` shows the frame the model read, and that frame does not
             * move until the next inference replaces it. Extrapolating the pose on
             * top of a still image would do exactly the opposite of what the mode
             * is for: the twin would slide across a frozen platform. The measured
             * pose is already the right one for those pixels.
             */
            if (app.syncFrame) return;
            // Con el postprocesado apagado no se extrapola nada: se muestra lo
            // último medido, aunque en pantalla parezca que el gemelo va a saltos.
            if (!app.postprocess) return;
            if (!app.pose) {
                // "Reiniciar la pose" (or a dropped pose) means starting over,
                // not extrapolating from stale keypoints.
                kalman.reset();
                return;
            }
            const { width, height } = app.videoSize;
            if (width <= 0 || height <= 0) return;
            if (kalman.ageMs(performance.now()) > PREDICT_LIMIT_MS) return;
            if (!kalman.ready) return;

            const now = performance.now();
            // Never guess further than one detector interval (bounded both ways).
            const horizon = Math.min(250, Math.max(80, measuredInterval * 1.4));
            if (lastMeasuredPose && now - lastMeasuredAt > horizon) {
                // Too long without data: hold the last measured pose instead of
                // letting the velocity run away.
                if (app.pose !== lastMeasuredPose) {
                    useAppStore.setState({ pose: lastMeasuredPose });
                }
                return;
            }

            const predicted = kalman.predict(now);
            const indexes: number[] = [];
            const uvs: Array<[number, number]> = [];
            predicted.forEach((point, index) => {
                if (point.score < app.keypointMinScore) return;
                if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
                indexes.push(index);
                uvs.push([point.x, point.y]);
            });
            if (indexes.length < 4) return;

            const solved = solvePnP(
                indexes.map((index) => KEYPOINTS_SCENE[index]),
                uvs,
                intrinsicsFromFov(width, height, app.poseHfovDeg),
                { previousPose: app.pose, maxIterations: 8 }
            );
            lastPredictAt = timestamp;
            // The measurement timestamp is deliberately left alone: `poseUpdatedAt`
            // tracks real detections, and the tracker's re-acquisition and the
            // visibility rule both depend on that.
            if (solved) useAppStore.setState({ pose: solved });
        };

        const tick = (timestamp: number) => {
            if (cancelled) return;
            rafId = requestAnimationFrame(tick);

            const video = videoRef.current;
            if (!video || video.readyState < 2 || document.hidden) return;

            /**
             * Fill the gap between detections. This runs on every animation frame
             * — while an inference is still in flight, before the throttle, it
             * does not matter — and it is cheap: 11 straight-line extrapolations
             * plus one PnP, well under a millisecond.
             */
            predict(timestamp);

            if (timestamp < pausedUntil) return;

            const state = useAppStore.getState();
            const minInterval = 1000 / Math.max(1, state.maxFps);
            if (busy || timestamp - lastRunAt < minInterval) return;

            const width = video.videoWidth;
            const height = video.videoHeight;
            if (!width || !height) return;

            lastRunAt = timestamp;
            busy = true;
            // Everything measured from here on belongs to this frame.
            const frameStart = performance.now();

            /**
             * In `syncFrame` mode the model reads a copy of the frame it is about
             * to show, instead of the live element. Same object on both sides, so
             * the detections can never belong to a *different* image than the one
             * on screen — which is what made the overlay look like it slid.
             *
             * The synchronous part is wrapped: `drawImage` can throw (a camera
             * that changed format, a frame that cannot be decoded) and an exception
             * escaping here would leave `busy` set to `true` forever. The loop
             * would then stop running — a frozen frame and a twin that never moves
             * again — while the code that recovers is only the effect cleanup, i.e.
             * leaving and re-entering the live view. Which is exactly the freeze
             * that was reported.
             */
            let pending: Promise<RunResult>;
            try {
                const source = state.syncFrame ? (captureFrame(video) ?? video) : video;
                pending = engine.run(source, width, height, {
                    confidence: state.confidence,
                    iou: state.iou,
                    maxDetections: state.maxDetections,
                });
            } catch (error) {
                busy = false;
                const message = error instanceof Error ? error.message : String(error);
                useAppStore.setState({ modelError: `No pude leer el frame: ${message}` });
                console.warn('[loop] fallo al capturar el frame:', error);
                return;
            }

            pending
                .then((result) => {
                    if (cancelled) return;
                    errors = 0;
                    const delta = lastFrameAt ? timestamp - lastFrameAt : 0;
                    lastFrameAt = timestamp;
                    if (delta > 0) {
                        const instant = 1000 / delta;
                        fps = fps ? fps * FPS_SMOOTHING + instant * (1 - FPS_SMOOTHING) : instant;
                    }

                    // The camera pose is solved here, on the same frame the
                    // detections belong to, so the twin is placed for what the
                    // user is looking at right now — no extra render in between.
                    // Average over the last few inferences: a single number jumps
                    // around far too much to read.
                    const latency = performance.now() - frameStart;
                    latencyAvg = latencyAvg ? latencyAvg * 0.8 + latency * 0.2 : latency;

                    useAppStore.setState((current) => {
                        const metrics: FrameMetrics = {
                            fps: Math.round(fps * 10) / 10,
                            inferenceMs: Math.round(result.inferenceMs * 10) / 10,
                            preprocessMs: Math.round(result.preprocessMs * 10) / 10,
                            postprocessMs: Math.round(result.postprocessMs * 10) / 10,
                            detected: result.detections.length,
                            latencyMs: Math.round(latencyAvg * 10) / 10,
                            poseMs: Math.round(poseAvg * 10) / 10,
                        };

                        if (!current.poseEnabled) {
                            kalman.reset();
                            return { detections: result.detections, metrics };
                        }

                        // Feed the filter with whatever the model actually saw:
                        // the measurement is what anchors the extrapolation.
                        const picked = pickPoseDetection(result.detections, current.keypointMinScore);
                        if (picked?.detection.keypoints && current.postprocess) {
                            kalman.correct(picked.detection.keypoints, performance.now(), current.keypointMinScore);
                        }

                        const poseStart = performance.now();
                        const tracked = updatePose({
                            detections: result.detections,
                            sourceWidth: width,
                            sourceHeight: height,
                            previous: current.pose,
                            options: {
                                minScore: current.keypointMinScore,
                                horizontalFovDeg: current.poseHfovDeg,
                                // Ageing is measured, not counted in frames: at 5 fps a
                                // handful of misses is already a second of blindness.
                                poseAgeMs: lastAcceptedAt
                                    ? Date.now() - lastAcceptedAt
                                    : Number.POSITIVE_INFINITY,
                                frameMs: timestamp - (lastRunAt || timestamp) || 66,
                                jumpGuard: current.postprocess && current.ppJumpGuard,
                            },
                        });
                        const poseMs = performance.now() - poseStart;
                        poseAvg = poseAvg ? poseAvg * 0.8 + poseMs * 0.2 : poseMs;

                        if (tracked.accepted && tracked.pose) {
                            const now = performance.now();
                            if (lastMeasuredAt > 0) {
                                const interval = now - lastMeasuredAt;
                                measuredInterval = measuredInterval
                                    ? measuredInterval * 0.7 + interval * 0.3
                                    : interval;
                            }
                            lastMeasuredPose = tracked.pose;
                            lastMeasuredAt = now;
                            lastAcceptedAt = Date.now();
                        }

                        /**
                         * Blade azimuth: the one number the base pose cannot see.
                         * Fitted against the blade keypoints of the `Rotor` class
                         * (the platform class is excluded on purpose: its own 11
                         * keypoints occupy the same slots).
                         */
                        let rotorAngleAuto = current.rotorAngleAuto;
                        if (current.rotorAuto) {
                            const poseForRotor = tracked.pose ?? current.pose;
                            const rotor = pickRotorDetection(
                                result.detections,
                                current.keypointMinScore,
                                picked?.detection.classId ?? null
                            );
                            if (poseForRotor && rotor?.detection.keypoints) {
                                const fit = fitRotorAngle(
                                    poseForRotor,
                                    intrinsicsFromFov(width, height, current.poseHfovDeg),
                                    rotor.detection.keypoints,
                                    current.keypointMinScore
                                );
                                if (fit) {
                                    rotorAngleAuto = smoothAngleDeg(
                                        current.rotorAngleAuto,
                                        fit.angleDeg,
                                        // alpha 1 = sin suavizado: el ángulo medido se aplica tal cual.
                                        current.postprocess && current.ppRotorSmoothing ? ROTOR_SMOOTHING : 1
                                    );
                                }
                            }
                        }

                        /**
                         * Modal analysis input: what the rigid pose cannot explain.
                         * The reprojection residual per keypoint is the only part of
                         * the observation that can carry deformation, so it is what
                         * the OMA tracker analyses.
                         */
                        if (tracked.pose && picked?.detection.keypoints) {
                            const intrinsics = intrinsicsFromFov(width, height, current.poseHfovDeg);
                            const projected = projectAll(KEYPOINTS_SCENE, tracked.pose, intrinsics);
                            const residuals = picked.detection.keypoints.map((point, index) => ({
                                u: point.x - (projected[index]?.[0] ?? point.x),
                                v: point.y - (projected[index]?.[1] ?? point.y),
                            }));
                            modalTracker.push(residuals, performance.now());
                        } else {
                            modalTracker.push(null, performance.now());
                        }

                        return {
                            detections: result.detections,
                            metrics,
                            pose: tracked.pose,
                            // Only an accepted measurement refreshes this: a rejected
                            // one would keep claiming the twin is up to date.
                            poseUpdatedAt: tracked.accepted ? Date.now() : current.poseUpdatedAt,
                            poseReacquired: tracked.reacquired,
                            rotorAngleAuto,
                        };
                    });
                })
                .catch((error: unknown) => {
                    if (cancelled) return;
                    errors += 1;
                    if (errors === 1) {
                        const message = error instanceof Error ? error.message : String(error);
                        useAppStore.setState({ modelError: `Fallo en la inferencia: ${message}` });
                    }
                    if (errors >= MAX_CONSECUTIVE_ERRORS) {
                        /**
                         * Back off instead of dying.
                         *
                         * A permanent `cancelAnimationFrame` here used to freeze
                         * the overlay for good after eight bad frames — and the
                         * effect only re-runs when the engine or the stage
                         * changes, so nothing brought it back. Pausing keeps the
                         * app recoverable: the next frames after the pause decide
                         * whether the problem was transient.
                         */
                        errors = 0;
                        pausedUntil = performance.now() + BACKOFF_MS;
                        console.warn(`[loop] ${MAX_CONSECUTIVE_ERRORS} fallos seguidos: pausa de ${BACKOFF_MS} ms`);
                    }
                })
                .finally(() => {
                    busy = false;
                });
        };

        rafId = requestAnimationFrame(tick);
        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
        };
    }, [engine, enabled, videoRef]);
}
