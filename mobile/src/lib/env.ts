/** Build-time configuration. Everything here must stay dependency-free. */

function num(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Version of onnxruntime-web the bundle was built against, injected by
 * vite.config.ts. Only used for the CDN fallback: the JS glue and the WASM must
 * match or `initWasm()` fails, so this value can never be hardcoded by hand.
 * `npm run sync:ort` avoids the CDN entirely.
 */
declare const __OC4_ORT_VERSION__: string;

export const ORT_VERSION = typeof __OC4_ORT_VERSION__ === 'string' ? __OC4_ORT_VERSION__ : 'latest';

export const APP_NAME = 'OC4 Digital Twin';
export const APP_VERSION = '0.1.0';

/**
 * Prefixes a root-absolute path with the deployment base.
 *
 * The same build is served from `/` in development and from a subpath in
 * production (`/oc4-dt-mobile/`), and every URL the browser requests has to
 * carry that prefix: assets, the ONNX runtime, the models and the API. Vite
 * rewrites the URLs it can see in the bundle, but the ones built by hand at
 * runtime (`fetch('/models/…')`) are ours to prefix.
 *
 * Anything that is not root-absolute (an `https://` URL, a relative path) is
 * left alone, so pointing VITE_DEFAULT_MODEL_URL at another host still works.
 */
export function withBase(pathOrUrl: string): string {
    if (!pathOrUrl.startsWith('/')) return pathOrUrl;
    const base = import.meta.env.BASE_URL || '/';
    if (base === '/') return pathOrUrl;
    return `${base.replace(/\/+$/, '')}${pathOrUrl}`;
}

/** Optional telemetry backend (mobile/server). Relative → works behind any tunnel. */
export const API_BASE = withBase(
    (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'
);

/** 3D model of the digital twin. Synced by `npm run sync:models`. */
export const TWIN_MODEL_URL = withBase(
    (import.meta.env.VITE_TWIN_MODEL_URL as string | undefined) ?? '/models/OC4-modal.glb'
);

/**
 * ONNX Runtime assets. Empty → `ortAssets.ts` probes `/ort/` (local, offline)
 * and falls back to the jsDelivr CDN.
 */
export const ORT_ASSET_BASE = (import.meta.env.VITE_ORT_ASSET_BASE as string | undefined) ?? '';
/**
 * Model loaded automatically on startup so the first run needs no file picker.
 * Synced from the repo root by `npm run sync:models`.
 *
 * Por defecto, el nano 200 más reciente (`nano200_coco_ft4`) en fp32.
 */
export const BUNDLED_MODEL_URL = withBase(
    (import.meta.env.VITE_DEFAULT_MODEL_URL as string | undefined) ?? '/models/yolo-pose-n-200.onnx'
);

/**
 * Load the bundled model on startup. Turn it off with `VITE_AUTOLOAD_MODEL=0`
 * when the first visit is over a slow link (the model is ~38 MB) and it is
 * better to let the user trigger it from the UI.
 */
export const AUTOLOAD_MODEL =
    ((import.meta.env.VITE_AUTOLOAD_MODEL as string | undefined) ?? '1') !== '0';

export const DEFAULTS = {
    inputSize: num(import.meta.env.VITE_INPUT_SIZE as string | undefined, 640),
    confidence: num(import.meta.env.VITE_CONFIDENCE as string | undefined, 0.35),
    iou: num(import.meta.env.VITE_IOU as string | undefined, 0.45),
    maxDetections: num(import.meta.env.VITE_MAX_DETECTIONS as string | undefined, 30),
    /**
     * Inference loop cap. Phones throttle hard, and the pose is the slow part:
     * at 10 fps the keypoints of consecutive frames are close enough for the
     * solver to track them, and the phone stays cool. 5 fps is a valid choice
     * when battery matters more than smoothness.
     */
    maxFps: num(import.meta.env.VITE_MAX_FPS as string | undefined, 10),
} as const;

export type CameraIssue = 'embedded-browser' | 'insecure-origin' | 'unsupported-browser';

export interface CameraAccess {
    available: boolean;
    issue: CameraIssue | null;
    /** One-line explanation, safe to render in a banner. */
    message: string;
    /** Concrete fixes, most likely to help first. */
    hints: string[];
}

const FIX_WITH_TUNNEL =
    'Túnel HTTPS con dominio real (certificado fiable): es la única opción que funciona en iPhone.';
const FIX_ANDROID_FLAG =
    'Android, sin certificados: abre chrome://flags/#unsafely-treat-insecure-origin-as-secure, añade este origen y reinicia Chrome.';
const FIX_LOCAL_HTTPS = 'En este equipo: `npm run dev:https` y abre https://localhost:5273';

/**
 * Explains why `getUserMedia` is missing.
 *
 * The API is simply *absent* on origins the browser does not consider secure, so
 * a naive `if (!navigator.mediaDevices)` conflates three very different
 * situations (insecure origin, embedded browser, ancient browser) that need
 * different fixes. Distinguishing them is the difference between a dead end and
 * a two-minute fix.
 */
function looksLikeEmbeddedBrowser(): boolean {
    if (typeof window === 'undefined') return false;
    const userAgent = navigator.userAgent;
    if (/Electron\//.test(userAgent) || /\bCode\/\d/.test(userAgent)) return true;
    try {
        return window.self !== window.top;
    } catch {
        return true;
    }
}

export function cameraAccess(): CameraAccess {
    if (typeof navigator === 'undefined' || typeof window === 'undefined') {
        return { available: true, issue: null, message: '', hints: [] };
    }

    const hasApi = Boolean(navigator.mediaDevices?.getUserMedia);
    if (hasApi) return { available: true, issue: null, message: '', hints: [] };

    if (looksLikeEmbeddedBrowser()) {
        return {
            available: false,
            issue: 'embedded-browser',
            message:
                'El navegador integrado de VS Code no implementa getUserMedia, así que aquí nunca habrá cámara.',
            hints: [
                'Abre esta misma URL en Chrome / Edge / Safari del móvil, en la misma red WiFi.',
                'En este equipo, ábrela en una ventana normal de Chrome o Edge.',
                FIX_WITH_TUNNEL,
            ],
        };
    }

    if (window.isSecureContext === false) {
        return {
            available: false,
            issue: 'insecure-origin',
            message: `Origen no seguro (${window.location.origin}). El navegador sólo concede la cámara en https:// o en http://localhost.`,
            hints: [FIX_WITH_TUNNEL, FIX_ANDROID_FLAG, FIX_LOCAL_HTTPS],
        };
    }

    return {
        available: false,
        issue: 'unsupported-browser',
        message: 'Este navegador no expone getUserMedia.',
        hints: [
            'Prueba con Chrome, Edge o Safari actualizados.',
            FIX_WITH_TUNNEL,
        ],
    };
}

/** Convenience wrapper for callers that only need the explanation. */
export function cameraBlockedReason(): string | null {
    const access = cameraAccess();
    return access.available ? null : access.message;
}

export function isCrossOriginIsolated(): boolean {
    return typeof globalThis !== 'undefined' && globalThis.crossOriginIsolated === true;
}
