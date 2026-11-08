import { create } from 'zustand';
import { DEFAULTS } from '../lib/env';
import type { Pose } from '../lib/pose/solvePnP';
import { loadLanguage, type Lang } from '../i18n/language';
import type {
    Detection,
    FrameMetrics,
    LoadStatus,
    ModelInfo,
    Stage,
    TelemetryStatus,
} from '../types';

const EMPTY_METRICS: FrameMetrics = {
    fps: 0,
    inferenceMs: 0,
    preprocessMs: 0,
    postprocessMs: 0,
    detected: 0,
    latencyMs: 0,
    poseMs: 0,
};

/**
 * WebGPU preference, remembered across visits.
 *
 * Without this the toggle was a no-op: the bundled model is auto-loaded on the
 * very first paint, *before* anyone can touch the switch, and the store default
 * is `false`. A desktop with a real GPU therefore stayed on the WASM path
 * (~100 ms per frame here) even after turning the switch on and reloading.
 */
const PREFER_WEBGPU_KEY = 'oc4.prefer-webgpu';

function readPreferWebGpu(): boolean {
    try {
        return window.localStorage.getItem(PREFER_WEBGPU_KEY) === '1';
    } catch {
        return false;
    }
}

/** Stores the preference, so the next model load (or reload) honours it. */
export function persistPreferWebGpu(value: boolean) {
    try {
        window.localStorage.setItem(PREFER_WEBGPU_KEY, value ? '1' : '0');
    } catch {
        // Private mode, quota… the switch still works for this session.
    }
}

export interface AppState {
    /* ------------------------------------------------------------ navigation */
    stage: Stage;

    /* ----------------------------------------------------------------- model */
    model: ModelInfo | null;
    modelStatus: LoadStatus;
    modelError: string | null;
    /**
     * Try the WebGPU execution provider first.
     *
     * **Off by default.** On desktop Chrome the session created at startup with
     * WebGPU came back alive but produced *no detections at all* until the model
     * was reloaded — a silent failure, which is the worst kind here: the overlay
     * simply never appeared. WASM (multi-threaded, in a worker) is the path that
     * works everywhere, so it is the default and WebGPU is opt-in.
     */
    preferWebGpu: boolean;
    /** Thread benchmark state (see `benchmarkThreads`). */
    benchRunning: boolean;
    benchProgress: string | null;
    benchResult: string | null;
    /** Download progress while the model is being fetched, `null` otherwise. */
    modelProgress: { loaded: number; total: number | null } | null;
    /** Human readable origin of the loaded model ("OC4-pose.onnx", "URL", ...). */
    modelName: string | null;
    /** `auto` infers the task from the output tensor; the other two force it. */
    taskOverride: 'auto' | 'detect' | 'pose';
    customLabels: string[] | null;

    /* --------------------------------------------------------------- tunables */
    confidence: number;
    iou: number;
    maxDetections: number;
    maxFps: number;

    /* ---------------------------------------------------------------- camera */
    cameraStatus: LoadStatus;
    cameraError: string | null;
    deviceId: string | null;
    facing: 'environment' | 'user';
    /** Front camera previews are mirrored; overlays must mirror with it. */
    mirrored: boolean;
    videoSize: { width: number; height: number };

    /* --------------------------------------------------------------- overlay */
    /** 0 = camera only, 1 = digital twin only. Drives the z-stack opacity. */
    blend: number;
    /** Draw the detected bounding boxes and their labels. On by default. */
    showBoxes: boolean;
    /** Draw the keypoints the model itself emits. Off by default. */
    showKeypoints: boolean;
    showTwin: boolean;
    twinOpacity: number;
    /** True when `OC4.glb` could not be loaded and the procedural stand-in is used. */
    twinModelFallback: boolean;
    /** The 3D asset has finished downloading and parsing. */
    twinModelReady: boolean;
    /* ------------------------------------------------------------------ pose */
    /**
     * Align the twin with the real camera through PnP (the original pipeline's
     * logic) instead of driving the view with the gyroscope.
     */
    poseEnabled: boolean;
    /** Latest solved camera pose, in the frame of `OC4.glb`. */
    pose: Pose | null;
    /** Horizontal field of view of this camera, in degrees (calibration knob). */
    poseHfovDeg: number;
    /**
     * Blade azimuth of the rotor, in degrees.
     *
     * One rigid PnP pose over the 11 keypoints cannot recover it: the only rotor
     * landmark is `Hub`, and a single point says where the hub is, not how far
     * the blades have turned. Without this knob the twin always shows the rotor
     * at its exported angle, which reads as "the blades are 20° off".
     */
    rotorAngleDeg: number;
    /** Fit the blade azimuth from the `Rotor` class keypoints on every frame. */
    rotorAuto: boolean;
    /** Last fitted angle (null = nothing fitted yet). Written by the loop. */
    rotorAngleAuto: number | null;
    /** True when the modal (OMA) sheet is open over the live stage. */
    omaOpen: boolean;
    /** Amplification applied to the measured residual when moving the twin. */
    omaGain: number;
    /** Index into `omaModeMap` being painted on the twin, or null when off. */
    omaColorMode: number | null;
    /** Modal contour data, loaded on demand from `oc4-mode-map.json`. */
    omaModeMap: import('../lib/oma/modeMap').ModeMap | null;
    /** Modes currently being blended into the animated contour. */
    omaBlend: Array<{ label: string; freqHz: number }> | null;
    /** Last error loading or applying the contour map. */
    omaError: string | null;

    /* --- campo FEM de las palas (misma cuenta que /rotor-fem/) --- */
    /** Pinta los cinco casos FEM sobre las mallas del gemelo. */
    bladeFemEnabled: boolean;
    /** Mueve los vértices con el desplazamiento, no solo cambia el color. */
    bladeFemDeform: boolean;
    /** El desplazamiento máximo ocupa `bladeFemGain` % de la pala. */
    bladeFemNonDimensional: boolean;
    /** Con signo (α, gravedad) o solo módulo. */
    bladeFemField: 'magnitude' | 'signed';
    /** Multiplicador en metros, o % de la pala si es no dimensional. */
    bladeFemGain: number;
    /** Constante de tiempo de la derivada de ω, en segundos. */
    bladeFemInertia: number;
    /** Opacidad del contour sobre el gemelo (0.2 = se ve la geometría debajo). */
    bladeFemOpacity: number;
    /** Último resultado aplicado, para enseñarlo en el modal. */
    bladeFemStatus: { painted: number; min: number; max: number; omega: number; error: string | null } | null;
    /** Minimum keypoint confidence used for pose estimation. */
    keypointMinScore: number;
    /**
     * Scene lighting, estimated on demand (manual button).
     *
     * `null` until the user asks for it: the model is never downloaded or
     * instantiated on startup, because it is the last thing a phone can afford.
     */
    lightAvailable: boolean | null;
    lightProgress: number;
    lightResult: {
        azimuthDeg: number;
        elevationDeg: number | null;
        intensity: number | null;
        ms: number;
        provider: string;
    } | null;
    /** Direction of the light in the model frame, ready for three.js. */
    lightVector: { x: number; y: number; z: number } | null;
    /** 0..1 from the fast estimator (null when a model produced the answer). */
    lightConfidence: number | null;
    lightError: string | null;
    /** Draw the reprojected keypoints, as an alignment self-check. */
    showReprojection: boolean;
    /** `Date.now()` of the last successful solve (0 = never). */
    poseUpdatedAt: number;
    /** True on the frames where the tracker deliberately forgot its history. */
    poseReacquired: boolean;
    /** Depth (metres) at which detections are anchored inside the 3D scene. */
    anchorDepth: number;
    /** Preview the inferred frame (synced with the detections) instead of the live feed. */
    syncFrame: boolean;
    /**
     * Master switch for the temporal filters.
     *
     * Off: every measurement is shown as it comes out of the solver, with no
     * memory of the previous frame. The overlay stops "catching up" after a
     * pause, at the cost of a visibly twitchy twin when the detection is noisy.
     */
    postprocess: boolean;
    /** Reject a pose that implies a jump no real camera could make. */
    ppJumpGuard: boolean;
    /** Exponential smoothing of the blade azimuth (alpha 0.4). */
    ppRotorSmoothing: boolean;
    /** Slerp of the 3D camera towards the gyro / orbit target. */
    ppCameraSmoothing: boolean;
    /** Idioma de la interfaz (`es` | `en` | `ca`), persistido en localStorage. */
    language: Lang;
    /** Use the device gyroscope to drive the 3D camera (AR-style). */
    useGyro: boolean;
    /** iOS 13+ requires an explicit permission prompt for device orientation. */
    gyroStatus: 'idle' | 'granted' | 'denied' | 'unsupported';

    /* --------------------------------------------------------------- results */
    detections: Detection[];
    metrics: FrameMetrics;
    provider: string | null;
    /** Reason multi-threaded WASM is off, if it is. */
    wasmNote: string | null;

    /* ------------------------------------------------------------- telemetry */
    telemetryEnabled: boolean;
    telemetryStatus: TelemetryStatus;

    /* --------------------------------------------------------------- actions */
    update: (patch: Partial<AppState>) => void;
    resetDetections: () => void;
}

export const useAppStore = create<AppState>()((set) => ({
    stage: 'onboarding',

    model: null,
    modelStatus: 'idle',
    modelError: null,
    preferWebGpu: readPreferWebGpu(),
    benchRunning: false,
    benchProgress: null,
    benchResult: null,
    modelProgress: null,
    modelName: null,
    taskOverride: 'auto',
    customLabels: null,

    confidence: DEFAULTS.confidence,
    iou: DEFAULTS.iou,
    maxDetections: DEFAULTS.maxDetections,
    maxFps: DEFAULTS.maxFps,

    cameraStatus: 'idle',
    cameraError: null,
    deviceId: null,
    facing: 'environment',
    mirrored: false,
    videoSize: { width: 0, height: 0 },

    /**
     * Show the frame that was inferred instead of the live camera.
     *
     * On by default: the preview and the detections then belong to the same
     * instant, so the overlay cannot slide away from the platform while the
     * camera moves. Turning it off brings back the raw, zero-delay feed — useful
     * to see with your own eyes how much the inference lags behind.
     */
    syncFrame: true,

    postprocess: true,
    ppJumpGuard: true,
    ppRotorSmoothing: true,
    ppCameraSmoothing: true,
    language: loadLanguage(),

    blend: 0.55,
    showBoxes: true,
    showKeypoints: false,
    showTwin: true,
    twinOpacity: 1,
    twinModelFallback: false,
    twinModelReady: false,
    anchorDepth: 6,
    useGyro: true,
    gyroStatus: 'idle',

    poseEnabled: true,
    pose: null,
    poseHfovDeg: 68,
    rotorAngleDeg: 350,
    rotorAuto: true,
    rotorAngleAuto: null,
    lightAvailable: null,
    lightProgress: -1,
    lightResult: null,
    lightVector: null,
    lightConfidence: null,
    lightError: null,
    keypointMinScore: 0.4,
    omaOpen: false,
    omaGain: 5,
    omaColorMode: null,
    omaModeMap: null,
    omaBlend: null,
    omaError: null,
    bladeFemEnabled: false,
    bladeFemDeform: true,
    bladeFemNonDimensional: true,
    bladeFemField: 'signed',
    bladeFemGain: 5,
    bladeFemInertia: 1,
    bladeFemOpacity: 0.85,
    bladeFemStatus: null,
    showReprojection: true,
    poseUpdatedAt: 0,
    poseReacquired: false,

    detections: [],
    metrics: EMPTY_METRICS,
    provider: null,
    wasmNote: null,

    telemetryEnabled: false,
    telemetryStatus: 'off',

    update: (patch) => set(patch),
    resetDetections: () => set({ detections: [], metrics: EMPTY_METRICS }),
}));
