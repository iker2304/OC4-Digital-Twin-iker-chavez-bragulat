/**
 * onnxruntime-web environment and session creation.
 *
 * ## WASM resolution (the part that bites)
 *
 * ORT loads a `.wasm` binary that must come from the **same release** as its JS
 * glue, or `initWasm()` fails with a useless "no available backend found".
 * Three ways to get it wrong, all of them hit while building this:
 *
 *  1. Pinning a version by hand (CDN 1.20 with glue 1.30) → compile failure.
 *  2. Letting the bundler resolve it: Vite pre-bundles the package and its
 *     internal `new URL('....wasm', import.meta.url)` does not survive, so the
 *     request hits a non-existent path and the dev server answers with the SPA
 *     fallback — **HTML** where a binary is expected
 *     (`expected magic word 00 61 73 6d, found 3c 21 64 6f`, i.e. "<!do").
 *  3. Serving `.wasm` with the wrong MIME type, which kills
 *     `WebAssembly.instantiateStreaming`.
 *
 * So resolution is explicit and ordered:
 *   1. `VITE_ORT_ASSET_BASE` when set — for a CDN, or for `/ort/` when the app is
 *      served by `server/index.mjs` (see the caveat below).
 *   2. **Default: nothing.** Vite resolves the runtime itself, so the glue and
 *      the binary always come from the same installed release. This is the only
 *      path that works in dev and in the bundle alike.
 *
 * A local `/ort/` directory must NOT be selected automatically in dev: Vite
 * rewrites ORT's dynamic import of `<base>ort-wasm-simd-threaded.jsep.mjs` into
 * `...jsep.mjs?import` and the fetch fails. Outside Vite (the Node server, which
 * serves the raw files with `application/wasm`) it works fine.
 *
 * `optimizeDeps.exclude: ['onnxruntime-web']` keeps the package out of Vite's
 * pre-bundler, which is what makes the bundler resolution actually work.
 */
import * as ort from 'onnxruntime-web';
import { ORT_ASSET_BASE, ORT_VERSION, isCrossOriginIsolated, withBase } from '../env';

let configured = false;
let assetBase: string | null = null;
let note: string | null = null;

/**
 * `VITE_ORT_ASSET_BASE=cdn` means "serve the runtime from jsDelivr, using the
 * version actually installed". Useful when the app is published through a
 * tunnel: the wasm is ~28 MB and `application/wasm` is not compressible
 * (mime-db marks it as such), so serving it from a global CDN keeps it off your
 * own uplink. The sentinel avoids hardcoding the version, which is exactly how
 * glue/binary mismatches happen.
 */
const CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

/** Reported to the UI so the user knows why inference is slower than expected. */
export function wasmNote(): string | null {
    return note;
}

/**
 * Runs the runtime in a Web Worker.
 *
 * This is the single most important setting for *felt* performance. Without it,
 * a 640×640 pose inference runs on the page's main thread, and on a phone that is
 * 1.5 s during which nothing repaints: sliders stutter, taps are late, the whole
 * UI looks broken. In a worker the main thread stays free and only the result
 * crosses over.
 *
 * It also forces the runtime assets to be **same-origin**, because a Worker
 * cannot be created from a cross-origin URL. `?noproxy=1` is the escape hatch in
 * case a browser dislikes the worker: everything still works, just with a blocked
 * main thread.
 */
function proxyWanted(): boolean {
    if (typeof window === 'undefined') return false;
    // On by default: it is what keeps the page responsive while a 1.5 s
    // inference runs. Verified that the worker can only load the model from a
    // real URL — a `Uint8Array` gets detached by the transfer and a blob URL is
    // not readable from the worker — so sessions created from bytes fall back to
    // running on the main thread. `?noproxy=1` disables it.
    return !new URLSearchParams(window.location.search).has('noproxy');
}

function configureEnvironment(base: string | null, proxy: boolean) {
    ort.env.logLevel = 'error';
    ort.env.wasm.numThreads = threadBudget();
    ort.env.wasm.simd = true;
    ort.env.wasm.proxy = proxy;
    const threads = ort.env.wasm.numThreads;
    note = `WASM ${threads > 1 ? `${threads} hilos` : 'mono-hilo'}${proxy ? ' · worker' : ''}`;

    // Undefined → let the bundler/CDN-relative resolution of the package stand.
    if (base) ort.env.wasm.wasmPaths = base;
    assetBase = base;
    configured = true;
}

/**
 * How many threads the runtime may use.
 *
 * Threads need `SharedArrayBuffer`, i.e. cross-origin isolation, and a shared
 * `WebAssembly.Memory` whose reserved maximum grows with the worker count. That
 * reservation — not the model — is what a phone browser most often refuses with
 * `RangeError: out of memory`, so without isolation this is 1, full stop.
 *
 * Chrome has accepted `COEP: credentialless` for a while; Safari only understands
 * `require-corp`, which is why the server sends that one. With it, iOS 15.2+ does
 * report itself isolated and the four threads are real.
 */
const THREADS_KEY = 'oc4.ort-threads';

/** Thread count measured on this device, if the benchmark has been run. */
function savedThreadCount(): number | null {
    try {
        const raw = window.localStorage.getItem(THREADS_KEY);
        const value = raw ? Number(raw) : Number.NaN;
        return Number.isFinite(value) && value >= 1 && value <= 16 ? Math.round(value) : null;
    } catch {
        return null;
    }
}

export function saveThreadCount(threads: number) {
    try {
        window.localStorage.setItem(THREADS_KEY, String(Math.round(threads)));
    } catch {
        // Nothing to save.
    }
}

export function clearSavedThreadCount() {
    try {
        window.localStorage.removeItem(THREADS_KEY);
    } catch {
        // Nothing to clear.
    }
}

/**
 * How many threads this machine is worth asking for.
 *
 * The old flat cap of 4 was leaving a whole desktop on the table: measured on
 * this laptop (32 logical cores), one 640x640 int8 pose frame took 487 ms with 1
 * thread, 170 ms with 4, 102 ms with 8, 87 ms with 12 and 82 ms with 16. A phone
 * is a different story — there the reservation of the shared memory is what
 * makes it fail — so the conservative cap stays only for constrained devices.
 *
 * Half the logical cores is the sane heuristic behind it: SMT siblings do not
 * help a SIMD kernel much, and the thread pool does not need to fight the render
 * loop for the rest.
 */
function threadCeiling(): number {
    const cores = navigator.hardwareConcurrency || 2;
    if (constrainedDevice()) return Math.max(1, Math.min(4, cores));
    return Math.max(1, Math.min(16, Math.max(4, Math.floor(cores / 2))));
}

function threadBudget(): number {
    if (!isCrossOriginIsolated()) return 1;
    // A measured value beats any heuristic: `hardwareConcurrency` says nothing
    // about big/little cores, thermal headroom or the SIMD path in use.
    return savedThreadCount() ?? threadCeiling();
}

export interface ThreadBenchResult {
    threads: number;
    ms: number | null;
    note?: string;
}

/**
 * Measures how long one inference takes with different thread counts.
 *
 * `numThreads` is read **when the WASM module is instantiated**, so comparing
 * configurations in the same module is impossible — each one needs its own copy
 * of the runtime. Rather than bundling five builds, the API is loaded from our
 * own origin by URL with a query string, which the module loader treats as a
 * distinct module (and therefore a distinct instance).
 *
 * Each instance runs in a worker (`proxy`), so the camera, the twin and this
 * very panel keep working while the test runs.
 */
export async function benchmarkThreads(options: {
    modelUrl: string;
    counts?: number[];
    runs?: number;
    onProgress?: (message: string) => void;
}): Promise<ThreadBenchResult[]> {
    const counts =
        options.counts ??
        // Threads keep paying off well past 8 on a desktop (measured: 4 -> 170 ms,
        // 8 -> 102 ms, 16 -> 82 ms), so the benchmark walks up to the ceiling of
        // this machine. A phone keeps the list it had: 6 and 8 are worth measuring
        // there (a measured value wins over the conservative default), but going
        // further only costs memory.
        (constrainedDevice()
            ? [1, 2, 4, 6, 8]
            : [1, 2, 4, 6, 8, 12, 16].filter((n) => n <= threadCeiling()));
    const runs = Math.max(1, options.runs ?? 3);
    const base = await resolveMinimalBase();
    const api = `${base}ort.wasm.min.mjs`;
    const results: ThreadBenchResult[] = [];

    for (const threads of counts) {
        options.onProgress?.(`${threads} hilo${threads === 1 ? '' : 's'}…`);
        let session: ort.InferenceSession | null = null;
        try {
            const runtime = (await import(/* @vite-ignore */ `${api}?threads=${threads}`)) as typeof ort;
            runtime.env.logLevel = 'error';
            runtime.env.wasm.simd = true;
            runtime.env.wasm.numThreads = threads;
            runtime.env.wasm.wasmPaths = base;
            runtime.env.wasm.proxy = true;

            session = await runtime.InferenceSession.create(options.modelUrl, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all',
            });

            const meta = (
                session as unknown as {
                    inputMetadata?: Array<{ name: string; shape?: readonly (number | string)[] }>;
                }
            ).inputMetadata?.[0];
            const shape = (meta?.shape ?? []).map((dim) =>
                typeof dim === 'number' ? dim : Number(dim)
            );
            const known = shape.length > 0 && shape.every((dim) => dim > 0);
            const size = known ? shape.reduce((a, b) => a * b, 1) : 3 * 640 * 640;
            const dims = (known ? shape : [1, 3, 640, 640]) as number[];
            const inputName = meta?.name ?? session.inputNames[0];

            const times: number[] = [];
            for (let run = 0; run <= runs; run += 1) {
                // A fresh tensor per run: with the worker proxy ORT *transfers*
                // the input buffer, so reusing one would leave it detached and
                // every run after the first would fail with `DataCloneError`.
                const input = new runtime.Tensor(
                    'float32',
                    new Float32Array(size).fill(0.4),
                    dims
                );
                const started = performance.now();
                await session.run({ [inputName]: input });
                // The first run pays for kernel setup; it is not representative.
                if (run > 0) times.push(performance.now() - started);
            }
            times.sort((a, b) => a - b);
            results.push({ threads, ms: times[Math.floor(times.length / 2)] ?? null });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ threads, ms: null, note: message.slice(0, 140) });
            console.warn(`[ort] benchmark con ${threads} hilos falló:`, error);
        } finally {
            const releasable = session as unknown as { release?: () => Promise<void> } | null;
            await releasable?.release?.().catch(() => undefined);
        }
    }

    return results;
}

/** Our own copy of the runtime, which is what makes the worker legal. */
const LOCAL_BASE = withBase('/ort/');

/**
 * Whether `/ort/` can be used.
 *
 * Only outside Vite's dev server — and this is verified, not assumed: in dev the
 * dynamic import comes back as `/ort/ort-wasm-simd-threaded.mjs?import`, Vite
 * refuses it ("Failed to fetch dynamically imported module"), and the whole
 * ladder dies. Express serves those files as plain statics, so the built app is
 * fine.
 *
 * Consequence worth knowing: **a dev server exposed by the tunnel runs the model
 * on the main thread** (CDN runtime → no worker), which is what makes the phone
 * stutter. For the phone, always use `npm run build && npm run serve`.
 */
const LOCAL_RUNTIME_ALLOWED = !import.meta.env.DEV;

async function resolveOrtAssetsPromise(): Promise<string | null> {
    if (configured) return assetBase;

    const requested = ORT_ASSET_BASE.trim();
    const proxy = proxyWanted();

    if (requested !== '' && requested.toLowerCase() !== 'cdn') {
        const sameOrigin = requested.startsWith('/');
        configureEnvironment(requested, proxy && sameOrigin);
        return assetBase;
    }

    /**
     * Same origin first in the built app: it enables the worker and works
     * offline, and the files are already in `public/ort/` (`npm run sync:ort`).
     *
     * The CDN stays as the fallback — and is the only option in dev — but then
     * the worker has to be off, because a Worker cannot be created from a
     * cross-origin URL. That is the slower, main-thread-blocking path.
     */
    if (LOCAL_RUNTIME_ALLOWED && (await probeFile(`${LOCAL_BASE}ort-wasm-simd-threaded.wasm`))) {
        configureEnvironment(LOCAL_BASE, proxy);
        return assetBase;
    }

    if (await probeReachable(CDN_BASE)) {
        configureEnvironment(CDN_BASE, false);
        note = `Runtime desde el CDN (sin worker) · ${note}`;
        return assetBase;
    }

    configureEnvironment(null, false);
    note = 'Runtime del propio bundle (sin worker)';
    return assetBase;
}

export function resolveOrtAssets(): Promise<string | null> {
    return resolveOrtAssetsPromise();
}

async function probeFile(url: string, timeoutMs = 4000): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        if (response.ok) return true;
    } catch {
        // Some proxies (and the tunnel agent) refuse HEAD. Fall through to a
        // one-byte range GET, which every static server and proxy understands.
    } finally {
        clearTimeout(timer);
    }

    const rangeController = new AbortController();
    const rangeTimer = setTimeout(() => rangeController.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: { Range: 'bytes=0-0' },
            signal: rangeController.signal,
        });
        // 206 for a honoured range, 200 if the proxy stripped it — both mean the
        // file is there, and both leave the body to be discarded.
        if (response.ok || response.status === 206) {
            await response.body?.cancel().catch(() => undefined);
            return true;
        }
        return false;
    } catch {
        return false;
    } finally {
        clearTimeout(rangeTimer);
    }
}

async function probeReachable(base: string): Promise<boolean> {
    return probeFile(`${base}ort-wasm-simd-threaded.jsep.mjs`);
}

/**
 * Base path for the second runtime (see `createSession`).
 *
 * A dynamically imported ORT build resolves its own `.wasm` through
 * `new URL('...wasm', import.meta.url)`, which the bundler cannot follow — the
 * dev server would answer with `index.html`. So that attempt always needs an
 * explicit `wasmPaths`, and it has to be one that really serves the *plain*
 * (non-jsep) binary.
 */
async function resolveMinimalBase(): Promise<string> {
    if (assetBase) return assetBase;
    const local = LOCAL_BASE;
    if (LOCAL_RUNTIME_ALLOWED && (await probeFile(`${local}ort-wasm-simd-threaded.mjs`))) return local;
    const cdn = `${CDN_BASE}ort-wasm-simd-threaded.mjs`;
    return (await probeFile(cdn)) ? CDN_BASE : assetBase ?? cdn;
}

/**
 * Whether WebGPU is actually usable, not merely exposed.
 *
 * `navigator.gpu` exists on a lot of Android builds whose `requestAdapter()`
 * returns `null` (no usable adapter, blocklisted driver, software renderer
 * disabled). Attempting the EP anyway costs a failed session creation — the
 * expensive step, and the one that leaves memory behind.
 */
export async function isWebGpuAvailable(): Promise<boolean> {
    const nav = navigator as Navigator & {
        gpu?: { requestAdapter(): Promise<unknown | null> };
    };
    if (typeof nav.gpu?.requestAdapter !== 'function') return false;
    try {
        return (await nav.gpu.requestAdapter()) != null;
    } catch {
        return false;
    }
}

export type SessionSource = ArrayBuffer | Uint8Array | string;

export interface CreatedSession {
    session: ort.InferenceSession;
    provider: string;
}

function toBytes(source: ArrayBuffer | Uint8Array): Uint8Array {
    return source instanceof Uint8Array ? source : new Uint8Array(source);
}

/**
 * Creates an inference session by walking a ladder of runtimes, cheapest and
 * most-likely-to-start first on devices that struggle.
 *
 * ## Why the ladder, and why the order matters
 *
 * `RangeError: out of memory` during initialisation is the usual failure on
 * phones, and it is almost never about the size of the model: 38 MB is nothing.
 * It is about what the runtime asks for *before* the model is even read:
 *
 *  1. The build that carries the WebGPU EP ships a 28 MB WASM module, and that
 *     same module is used when the execution provider ends up being plain WASM.
 *     The CPU-only build is half the size.
 *  2. `env.wasm.numThreads` is read **when ORT instantiates its WASM module**,
 *     and the module is born on the first attempt. Lowering the thread count
 *     afterwards and retrying changes nothing — by then the multithreaded shared
 *     `WebAssembly.Memory` (a huge reserved maximum, plus one stack per worker)
 *     is already in place, and that reservation is what a mobile browser refuses
 *     to honour.
 *
 * A fresh `import('onnxruntime-web/wasm')` is an independent module instance, so
 * there the thread count really applies. It is a separate chunk, so a device
 * that never needs it never downloads it.
 *
 * The order is not fixed: a phone goes straight to the small CPU runtime so that
 * the first try is the one that works, and whatever did work is remembered for
 * the next visit.
 *
 * Every failure is reported with its real message: ORT hides the first error
 * behind "previous call to initWasm() failed" on the next attempt, which on its
 * own explains nothing, and a generic "no memory" summary would hide the one line
 * that says which part failed.
 */

type Runtime = 'full' | 'light';

interface Step {
    runtime: Runtime;
    providers: string[];
    /** `auto` → whatever `configureEnvironment` decided; a number pins it. */
    threads: 'auto' | number;
    optimization: 'all' | 'basic';
    label: string;
}

/**
 * Mode that worked, remembered so the next visit starts there.
 *
 * The version suffix matters: a saved mode outranks the ladder order, so after
 * changing the ladder an old `-v1` entry would keep a phone on the slow path
 * forever. Bumping this retires every stale decision.
 */
const MODE_KEY = 'oc4.ort-mode-v2';

type Mode = 'webgpu' | 'wasm-threads' | 'wasm-single' | 'light-threads' | 'light-single';

function readSavedMode(): Mode | null {
    try {
        const value = window.localStorage.getItem(MODE_KEY);
        return value === null ? null : (value as Mode);
    } catch {
        return null;
    }
}

function saveMode(mode: Mode) {
    try {
        window.localStorage.setItem(MODE_KEY, mode);
    } catch {
        // Private mode, quota… never a reason to fail a working load.
    }
}

/**
 * Forgets the runtime that worked, so the next load walks the ladder again.
 *
 * Useful after changing the device, the browser, or the ladder itself: a saved
 * "one thread is the only thing that works here" can otherwise hide a faster
 * path that would work perfectly now.
 */
export function clearSavedOrtMode() {
    try {
        window.localStorage.removeItem(MODE_KEY);
        window.localStorage.removeItem(THREADS_KEY);
        // A full reset is also the way back to WebGPU: the user is asking to try
        // everything again from scratch.
        window.localStorage.removeItem(WEBGPU_BLOCKED_KEY);
    } catch {
        // Nothing to clear.
    }
}

function mobileAgent(): boolean {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * Devices where a WebGPU attempt already ended in `RangeError: out of memory`.
 *
 * WebGPU needs the *full* jsep runtime (28 MB of WebAssembly) and that is what
 * blew up the heap on Rafael's phone. Remembering the failure keeps the first
 * load fast from then on: retrying a 28 MB module on every visit to end in the
 * same error is the worst of both worlds.
 */
const WEBGPU_BLOCKED_KEY = 'oc4.ort-webgpu-blocked';

function webGpuBlocked(): boolean {
    try {
        return window.localStorage.getItem(WEBGPU_BLOCKED_KEY) === '1';
    } catch {
        return false;
    }
}

function blockWebGpu() {
    try {
        window.localStorage.setItem(WEBGPU_BLOCKED_KEY, '1');
    } catch {
        // Private mode: nothing to remember.
    }
}

/** Explicit user intent (toggling “Preferir WebGPU” on) deserves a fresh try. */
export function clearWebGpuBlock() {
    try {
        window.localStorage.removeItem(WEBGPU_BLOCKED_KEY);
    } catch {
        // Nothing to clear.
    }
}

/**
 * Phone browsers report little and lie comfortably, so "constrained" is decided
 * by the most pessimistic signal available: a mobile user agent, or a small
 * `deviceMemory` where it is implemented.
 */
function constrainedDevice(): boolean {
    if (mobileAgent()) return true;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    return typeof memory === 'number' && memory > 0 && memory <= 4;
}

function buildLadder(preferWebGpu: boolean, saved: Mode | null): Step[] {
    const webgpu: Step = {
        runtime: 'full',
        providers: ['webgpu', 'wasm'],
        threads: 'auto',
        optimization: 'all',
        label: 'WebGPU',
    };
    const fullThreads: Step = {
        runtime: 'full',
        providers: ['wasm'],
        threads: 'auto',
        optimization: 'all',
        label: 'WASM multihilo',
    };
    const lightThreads: Step = {
        runtime: 'light',
        providers: ['wasm'],
        threads: 'auto',
        optimization: 'all',
        label: 'WASM reducido multihilo',
    };
    const lightSingle: Step = {
        runtime: 'light',
        providers: ['wasm'],
        threads: 1,
        optimization: 'basic',
        label: 'WASM reducido 1 hilo',
    };

    /**
     * Speed first, memory second — but the safe paths stay behind.
     *
     * A single thread on a phone means ~1.5-2.5 s per 640×640 pose inference,
     * which is unusable as a live overlay: the keypoints land two seconds after
     * the frame they belong to. The many-threaded *small* runtime is the first
     * thing to try because the module that made the phone run out of memory was
     * the 28 MB one, not the threads themselves.
     */

    const savedStep: Record<Mode, Step> = {
        webgpu,
        'wasm-threads': fullThreads,
        'light-threads': lightThreads,
        'wasm-single': { ...fullThreads, threads: 1, optimization: 'basic', label: 'WASM 1 hilo' },
        'light-single': lightSingle,
    };

    /**
     * On a phone WebGPU is several times faster than WASM, so it is worth the
     * first shot — it just has to be a shot that is **not repeated** once it has
     * failed, because the jsep runtime behind it is 28 MB of WebAssembly and the
     * memory it reserves is what blew up the heap in the first place. Every
     * failure is remembered in `WEBGPU_BLOCKED_KEY`.
     *
     * Before this, the phone ladder was `[light, light-single, full, webgpu]` and
     * WebGPU sat last: the toggle said "Preferir WebGPU" and it was never tried.
     */
    const gpuFirst = preferWebGpu && !webGpuBlocked();
    // The "known good" order for the device class, WebGPU excluded.
    const wasmOrder = constrainedDevice()
        ? [lightThreads, lightSingle, fullThreads]
        : [fullThreads, lightThreads, lightSingle];
    const savedPreferred = saved ? savedStep[saved] : null;
    const wasmRest = savedPreferred
        ? [savedPreferred, ...wasmOrder].filter(
            (step, index, all) =>
                step.label !== 'WebGPU' && all.findIndex((s) => s.label === step.label) === index
        )
        : wasmOrder;

    if (gpuFirst) return [webgpu, ...wasmRest];
    // A saved WebGPU is honoured only while it is still wanted.
    if (saved === 'webgpu' && preferWebGpu && !webGpuBlocked()) return [webgpu, ...wasmRest];
    // Without WebGPU in the picture, whatever worked last time goes first.
    return wasmRest;
}

const MODE_OF: Record<string, Mode> = {
    WebGPU: 'webgpu',
    'WASM multihilo': 'wasm-threads',
    'WASM 1 hilo': 'wasm-single',
    'WASM reducido multihilo': 'light-threads',
    'WASM reducido 1 hilo': 'light-single',
};

export async function createSession(
    source: SessionSource,
    options: { preferWebGpu?: boolean; modelUrl?: string } = {}
): Promise<CreatedSession> {
    await resolveOrtAssets();
    const { preferWebGpu = true } = options;
    const failures: string[] = [];
    const steps = buildLadder(preferWebGpu, readSavedMode());

    let light: typeof ort | null = null;
    let lightReady = false;

    for (const step of steps) {
        // The WebGPU attempt is pointless without an adapter, and asking costs a
        // failed, expensive session creation.
        if (step.providers.includes('webgpu')) {
            if (webGpuBlocked()) {
                failures.push(`${step.label}: desactivado en este dispositivo tras un fallo previo`);
                continue;
            }
            if (!(await isWebGpuAvailable())) {
                failures.push(`${step.label}: el navegador no expone ningún adaptador WebGPU`);
                continue;
            }
        }

        let runtime = ort;
        if (step.runtime === 'light') {
            try {
                light ??= (await import('onnxruntime-web/wasm')) as typeof ort;
                runtime = light;
                if (!lightReady) {
                    light.env.logLevel = 'error';
                    light.env.wasm.simd = true;
                    const base = await resolveMinimalBase();
                    light.env.wasm.wasmPaths = base;
                    // A Worker cannot be created from a cross-origin URL, so the
                    // proxy only makes sense when the runtime is ours.
                    // Only usable with a URL source: see `proxyWanted`.
                    light.env.wasm.proxy = proxyWanted() && base.startsWith('/') && Boolean(options.modelUrl);
                    // Same rule as the full build, but applied to *this* module,
                    // which has not instantiated anything yet.
                    light.env.wasm.numThreads =
                        step.threads === 'auto' ? threadBudget() : step.threads;
                    lightReady = true;
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                failures.push(`${step.label}: no se pudo cargar el runtime reducido (${message})`);
                continue;
            }
        } else if (step.threads !== 'auto') {
            runtime.env.wasm.numThreads = step.threads;
        }

        // A proxied session would transfer the bytes and leave them unusable for
        // the next attempt (and give the worker an empty graph): with no URL to
        // hand over, stay on the main thread.
        if (runtime.env.wasm.proxy && !options.modelUrl) {
            runtime.env.wasm.proxy = false;
        }

        const session = await tryCreate(
            runtime,
            step.providers,
            step.label,
            // With the worker proxy, hand over the URL and let the worker fetch
            // it: transferring a 38 MB buffer detaches it.
            runtime.env.wasm.proxy && options.modelUrl ? options.modelUrl : source,
            failures,
            step.optimization
        );
        if (!session) {
            if (step.providers.includes('webgpu')) blockWebGpu();
            continue;
        }

        const mode = MODE_OF[step.label];
        if (mode) saveMode(mode);
        // Say exactly what is running: the provider, the threads and whether the
        // inference is off the UI thread. That is the whole performance story.
        const threads = runtime.env.wasm.numThreads ?? 1;
        note = [
            // Without this pair, "1 hilo · hilo principal" is a symptom with no
            // cause: the runtime may be coming from the CDN (no worker possible)
            // and the page may not be cross-origin isolated (no SharedArrayBuffer,
            // so no threads even if the worker is there).
            (assetBase ?? '').startsWith('/') ? 'runtime local' : 'runtime CDN',
            isCrossOriginIsolated() ? 'aislado' : 'sin aislamiento',
            step.label,
            threads > 1 ? `${threads} hilos` : '1 hilo',
            runtime.env.wasm.proxy ? 'worker' : 'hilo principal',
        ].join(' · ');
        return { session, provider: step.providers[0] === 'webgpu' ? 'webgpu' : 'wasm' };
    }

    throw new Error(failures.join(' | '));
}

async function tryCreate(
    runtime: typeof ort,
    providers: string[],
    label: string,
    source: SessionSource,
    failures: string[],
    optimization: 'all' | 'basic' = 'all'
): Promise<ort.InferenceSession | null> {
    /**
     * A proxied session posts the bytes to its worker and **detaches** them, so
     * the caller's buffer is dead afterwards and every following attempt fails
     * with `DataCloneError: An ArrayBuffer is detached` — when it does not fail
     * with an empty graph first. Handing the worker a blob URL instead keeps the
     * buffer intact, makes each attempt independent, and needs no copy.
     */
    let revoke: (() => void) | null = null;
    let payload = source;
    if (runtime.env.wasm.proxy && typeof source !== 'string') {
        const blob = new Blob([toBytes(source) as unknown as BlobPart], {
            type: 'application/octet-stream',
        });
        payload = URL.createObjectURL(blob);
        const url = payload;
        revoke = () => URL.revokeObjectURL(url);
    }

    try {
        const sessionOptions = {
            executionProviders: providers,
            graphOptimizationLevel: optimization,
        } as Parameters<typeof ort.InferenceSession.create>[1];

        // Two separate calls: the overloads take either a path/URL or a buffer,
        // not a union of both.
        return typeof payload === 'string'
            ? await runtime.InferenceSession.create(payload, sessionOptions)
            : await runtime.InferenceSession.create(toBytes(payload), sessionOptions);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${label}: ${message}`);
        console.warn(`[ort] el proveedor "${label}" falló:`, error);
        return null;
    } finally {
        // The worker has fetched it by now; the URL must not be leaked.
        revoke?.();
    }
}

export type { ort };
