/**
 * Device calibration: what machine is this, really?
 *
 * The public wizard is opened from a QR code by unknown hardware, and the
 * benchmark numbers are only interpretable next to the hardware they came from.
 * The browser discloses little and lies politely (`deviceMemory` is capped at 8,
 * the GPU string is masked), so the only honest source is *measurement*.
 *
 * ## Around thirty seconds, on purpose
 *
 * A one-second probe measures the JIT warm-up, not the machine. Each stage gets a
 * real budget — seconds of arithmetic, a sustained run, four thread counts, a
 * couple of hundred megabytes of memory traffic, four seconds of GPU fill — and the
 * caller gets a progress callback so the user watches it move instead of a spinner.
 *
 *   cpu single      arithmetic throughput on one thread (median of several runs)
 *   cpu sustained   six seconds of the same work: the last window against the best
 *                   one is the throttling ratio, which is what a phone does
 *   scaling         the loop at 1, 2, 4 and 8 workers: how many cores it can really
 *                   use, and with what efficiency
 *   memory          reported RAM, largest allocatable block, write bandwidth on a
 *                   buffer too big to live in cache
 *   gpu             sustained WebGL fill rate plus the unmasked renderer name
 *   platform        WebAssembly SIMD and threads, timer resolution, JS heap limit
 *
 * The single `score` is an index for sorting, nothing more: the useful information
 * is in the components. It leans on the GPU because that is what decides whether
 * this app runs on WebGPU or falls back to WASM.
 */

export interface Calibration {
    /** Arithmetic operations per millisecond on one thread (median of the runs). */
    cpuSingle: number;
    /** Spread between the fastest and slowest single-thread run, in percent. */
    cpuSpread: number;
    /** Throughput in the last window of the sustained run. */
    cpuSustained: number;
    /** `cpuSustained / cpuSingle`: 1 means it did not throttle at all. */
    throttle: number;
    /** Best throughput across every core the browser will give us. */
    cpuMulti: number;
    /** Thread count that produced `cpuMulti`. */
    workers: number;
    cores: number;
    /** `cpuMulti / cpuSingle`. */
    scaling: number;
    /** `scaling / cores`: 1 is perfect, 0.5 means half the cores are wasted. */
    scalingEfficiency: number;
    /** What the browser admits (`navigator.deviceMemory`), often capped at 8. */
    memoryGb: number | null;
    /** Largest block we managed to allocate, or the probe ceiling. */
    maxBufferMb: number;
    /** `true` when `maxBufferMb` is the probe ceiling, not a failure. */
    maxBufferIsFloor: boolean;
    /** Write bandwidth on a buffer too big for cache, MB/s. */
    fillMbS: number;
    /**
     * Memory it can hold **without slowing down**, in MB.
     *
     * This is the number that matters for the app (a model plus its tensors while
     * keeping the frame rate), and it is measured by degradation, not by failure:
     * the probe stops when frames get 50 % slower, so it never walks the device
     * into an out-of-memory kill.
     */
    sustainableMb: number;
    /** Baseline frame time used for that comparison, ms. */
    frameBaseMs: number;
    /** `true` when the search stopped at the ceiling without degrading. */
    sustainableIsCap: boolean;
    /** `false` when the tab was throttled and the frame times are meaningless. */
    sustainableReliable: boolean;
    /** `performance.memory` limit, where Chrome exposes it. */
    heapLimitMb: number | null;
    gpuRenderer: string | null;
    /** Sustained WebGL fill rate, megapixels per second. */
    gpuMegapixelsS: number | null;
    webgpu: boolean;
    webgpuInfo: string | null;
    webgpuFeatures: number;
    wasmSimd: boolean;
    wasmThreads: boolean;
    /** Smallest step `performance.now()` will report, in ms. */
    timerMs: number;
    /** 0..~150, where the development desktop scores 100. */
    score: number;
    tier: 'alta' | 'media' | 'baja';
    /** Checksum of the CPU workload: proves the loop was not optimised away. */
    checksum: number;
    measuredAt: string;
    /** Total wall time of the calibration, ms. */
    durationMs: number;
}

/**
 * Reference device for the score: the desktop this was developed on.
 * 638.978 op/ms on one thread, 2.607.279 across workers, 13.176 MP/s of fill.
 */
const REFERENCE = {
    cpuSingle: 633_714,
    cpuMulti: 2_558_635,
    gpu: 6_722,
};

/**
 * Score weights.
 *
 * The GPU carries the most weight because it decides how this app runs: with WebGPU
 * a phone can beat a laptop on WASM, and without it no amount of CPU saves you.
 * Single-thread CPU next (it dominates the WASM fallback), multi-core last (it only
 * matters when threads are actually enabled).
 */
const WEIGHTS = { gpu: 0.45, cpuSingle: 0.3, cpuMulti: 0.25 };

/** Budgets in milliseconds; the sum is roughly the half minute the user sees. */
const PLAN = {
    single: 5_000,
    sustained: 8_000,
    scaling: 5_000,
    memory: 4_500,
    gpu: 6_000,
    platform: 500,
} as const;

const TOTAL_BUDGET = Object.values(PLAN).reduce((sum, value) => sum + value, 0);

/**
 * Iterations per run, fixed because "iterations per second" is not portable.
 *
 * Sized so one run lasts tens of milliseconds: at 1.5 M (a couple of milliseconds)
 * a single scheduler hiccup doubled the time and the run-to-run spread came out at
 * 82 %, which is a measurement of the operating system rather than of the CPU.
 */
const SINGLE_ITERATIONS = 20_000_000;
const SUSTAINED_CHUNK = 5_000_000;

/**
 * Sink for the workload results.
 *
 * Without it the JIT deletes the whole loop: the value is never observed, so the
 * optimiser proves the work is dead — and the first version of this file measured
 * 60 million ops/ms, a machine that does not exist.
 */
let cpuSink = 0;

function cpuWorkload(iterations: number): number {
    let acc = 0;
    for (let index = 0; index < iterations; index += 1) {
        acc += Math.sqrt(index % 997) * 0.5 + (index % 13);
        if ((index & 4095) === 0) acc %= 1_000_003;
    }
    cpuSink = (cpuSink + acc) % 1e9;
    return acc;
}

/**
 * Hands the thread back to the browser.
 *
 * The CPU stages used to block for five and eight seconds straight: the tab froze,
 * the progress bar could not repaint, and the whole thing looked hung. Yielding
 * between runs costs nothing measurable (each run is ~30 ms of pure arithmetic) and
 * lets the page draw.
 */
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const median = (values: number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

function isMobile(): boolean {
    return /android|iphone|ipad|ipod|mobile|silk/i.test(navigator.userAgent);
}

/* ---------------------------------------------------------------- stage one */

/** Repeated timed runs until the budget is spent; the median is the answer. */
async function measureSingleCore(
    onProgress?: (fraction: number) => void
): Promise<{ value: number; spread: number; checksum: number }> {
    cpuWorkload(SINGLE_ITERATIONS / 4); // warm-up: JIT, inline caches
    const rates: number[] = [];
    const startedAt = performance.now();
    const deadline = startedAt + PLAN.single;
    while (performance.now() < deadline || rates.length < 3) {
        const started = performance.now();
        cpuWorkload(SINGLE_ITERATIONS);
        const ms = performance.now() - started;
        rates.push(SINGLE_ITERATIONS / Math.max(ms, 0.05));
        onProgress?.(Math.min(1, (performance.now() - startedAt) / PLAN.single));
        await nextTick();
    }
    /**
     * Spread as the interquartile range over the median, not min-to-max.
     *
     * A desktop running a browser, an IDE and a Docker daemon has outliers by
     * definition; reporting the worst run made every machine look like it varied
     * by 80 %. The IQR answers "how repeatable is the typical run".
     */
    const sorted = [...rates].sort((left, right) => left - right);
    const at = (fraction: number) => sorted[Math.floor(fraction * (sorted.length - 1))];
    const centre = median(rates);
    return {
        value: Math.round(centre),
        spread: Math.round(((at(0.75) - at(0.25)) / Math.max(centre, 1)) * 100),
        checksum: cpuSink,
    };
}

/**
 * Six seconds of the same work, reported as "last window / best window".
 *
 * This is what makes a phone comparable to a laptop: the first second runs on a
 * cold chip with the governor at full speed, the sixth on a hot one. A ratio near 1
 * means it sustains the load; 0.6 means it throttles to 60 % after a few seconds,
 * which is exactly what happens when the AR overlay heats up.
 */
async function measureSustained(onProgress?: (fraction: number) => void): Promise<number> {
    const rates: number[] = [];
    const startedAt = performance.now();
    const deadline = startedAt + PLAN.sustained;
    while (performance.now() < deadline) {
        const started = performance.now();
        let executed = 0;
        while (performance.now() - started < 500) {
            cpuWorkload(SUSTAINED_CHUNK);
            executed += SUSTAINED_CHUNK;
            // Yield inside the window too: half a second of solid arithmetic is
            // already noticeable on a phone.
            await nextTick();
        }
        rates.push((executed * 1000) / Math.max(performance.now() - started, 0.05));
        onProgress?.(Math.min(1, (performance.now() - startedAt) / PLAN.sustained));
    }
    const best = Math.max(...rates);
    const last = rates[Math.max(0, rates.length - 2)];
    return Math.round((last / Math.max(best, 1)) * 100) / 100;
}

/* ---------------------------------------------------------------- stage two */

/**
 * The same loop at 1, 2, 4 and 8 workers.
 *
 * The interesting output is not the peak but the *efficiency*: eight workers that
 * give 3x the throughput mean the browser hands us fewer real cores than
 * `hardwareConcurrency` claims — precisely what breaks ONNX Runtime's thread pool
 * on iOS.
 */
async function measureScaling(maxWorkers: number): Promise<{ best: number; workers: number }> {
    const source = `
        self.onmessage = (event) => {
            const iterations = event.data;
            const run = (count) => {
                let acc = 0;
                for (let index = 0; index < count; index += 1) {
                    acc += Math.sqrt(index % 997) * 0.5 + (index % 13);
                    if ((index & 4095) === 0) acc %= 1000003;
                }
                return acc;
            };
            run(Math.max(1, iterations >> 2));      // JIT warm-up
            const started = performance.now();
            const acc = run(iterations);
            self.postMessage({ ms: performance.now() - started, acc });
        };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const perWorker = 1_500_000;
    const counts = [1, 2, 4, 8].filter((count) => count <= Math.max(1, maxWorkers));
    let best = { best: 0, workers: 1 };
    try {
        for (const count of counts) {
            const workers = Array.from({ length: count }, () => new Worker(url));
            const durations = await Promise.all(
                workers.map(
                    (worker) =>
                        new Promise<number>((resolve) => {
                            worker.onmessage = (event: MessageEvent<{ ms: number }>) =>
                                resolve(Number(event.data?.ms) || 0);
                            worker.onerror = () => resolve(0);
                            worker.postMessage(perWorker);
                        })
                )
            );
            for (const worker of workers) worker.terminate();
            const answered = durations.filter((ms) => ms > 0).length || 1;
            const slowest = Math.max(...durations, 0.1);
            const throughput = Math.round((perWorker * answered) / slowest);
            if (throughput > best.best) best = { best: throughput, workers: count };
        }
    } catch {
        // No workers (some embedded browsers): single-core stands in for this.
        best = { best: 0, workers: 1 };
    } finally {
        URL.revokeObjectURL(url);
    }
    return best;
}

/* -------------------------------------------------------------- stage three */

/**
 * How much memory can this device hold *without slowing down*?
 *
 * The old probe allocated until it failed, which is the one thing a public page
 * must not do: browsers overcommit, so "fails" usually means swap-thrash and then
 * an out-of-memory kill that cannot be caught — on iOS it takes the tab with it.
 *
 * So the stop condition is degradation instead of death: reserve a block, measure
 * the frame time for a moment, keep it if the machine is still keeping up, and stop
 * as soon as frames are 50 % slower. That answers the question the app actually
 * asks ("can it hold a 40 MB model plus tensors at a usable rate?") and stays far
 * away from the cliff.
 */
async function measureSustainable(
    ceiling: number,
    step: number,
    onProgress?: (fraction: number) => void
): Promise<{ sustainableMb: number; frameBaseMs: number; isCap: boolean; reliable: boolean; fillMbS: number }> {
    /** Median frame time over `durationMs`, using the real compositor clock. */
    const frameSample = async (durationMs: number): Promise<number> => {
        const times: number[] = [];
        let previous = performance.now();
        const deadline = previous + durationMs;
        while (performance.now() < deadline) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const now = performance.now();
            times.push(now - previous);
            previous = now;
        }
        return times.length > 0 ? median(times) : 0;
    };

    // Bandwidth first, on a warm buffer (32 MB so the fill is measurable).
    const megabytes = isMobile() ? 64 : 128;
    const buffer = new Float32Array((megabytes * 1024 * 1024) / 4);
    buffer.fill(1);
    const rates: number[] = [];
    for (let index = 0; index < 3; index += 1) {
        const started = performance.now();
        buffer.fill(1.5);
        rates.push((megabytes * 1000) / Math.max(performance.now() - started, 0.05));
    }
    const fillMbS = Math.round(median(rates));
    buffer.fill(0);

    const frameBase = await frameSample(400);
    /**
     * A hidden or background tab throttles `requestAnimationFrame` to ~1 Hz, which
     * makes the ratio meaningless. Better to say "not reliable" than to publish a
     * number measured on a sleeping tab.
     */
    const reliable = frameBase > 0 && frameBase < 100;

    let sustainable = 0;
    let isCap = false;
    const blocks: Float64Array[] = [];
    try {
        for (let held = 0; held + step <= ceiling; held += step) {
            const block = new Float64Array((step * 1024 * 1024) / 8);
            block.fill(1); // commit the pages, not just the address space
            blocks.push(block);
            if (!reliable) {
                sustainable = held + step;
                onProgress?.((held + step) / ceiling);
                continue;
            }
            const frame = await frameSample(300);
            if (frame > frameBase * 1.5) {
                // This block is what broke it: release it and stop.
                blocks.pop();
                break;
            }
            sustainable = held + step;
            onProgress?.((held + step) / ceiling);
        }
        isCap = sustainable >= ceiling;
    } catch {
        // Allocation refused outright: what we already hold is the answer.
    } finally {
        blocks.length = 0;
    }

    return { sustainableMb: sustainable, frameBaseMs: Math.round(frameBase * 10) / 10, isCap, reliable, fillMbS };
}

/* --------------------------------------------------------------- stage four */

/** WebGL fill rate over a sustained window, plus the unmasked renderer. */
function measureGpu(): { renderer: string | null; megapixelsS: number | null } {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return { renderer: null, megapixelsS: null };

    let renderer: string | null = null;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    if (debug) renderer = String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? '') || null;

    const compile = (type: number, source: string) => {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
    };
    const vertex = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }';
    const fragment = `
        precision mediump float;
        uniform float u;
        void main() {
            vec2 c = gl_FragCoord.xy * 0.01 + u;
            float acc = 0.0;
            for (int i = 0; i < 8; i++) {
                acc += sin(c.x + float(i)) * cos(c.y - float(i));
            }
            gl_FragColor = vec4(acc * 0.03, c.x * 0.5, c.y * 0.5, 1.0);
        }
    `;
    const vs = compile(gl.VERTEX_SHADER, vertex);
    const fs = compile(gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return { renderer, megapixelsS: null };
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    const uniform = gl.getUniformLocation(program, 'u');
    /**
     * Full-canvas readback buffer.
     *
     * A one-pixel `readPixels` does not force the queue to drain: the driver answers
     * from the first tile and we ended up timing command submission (203.000 MP/s on
     * a card that sustains ~13.000). Reading the whole frame blocks until those
     * draws have actually been rasterised.
     */
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    const megapixelsPerDraw = (canvas.width * canvas.height) / 1e6;

    // Warm-up: shader compile, program link, first-draw pipeline setup.
    for (let index = 0; index < 4; index += 1) gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    /**
     * Sustained, in windows: the first pays for state changes, the later ones are
     * what a throttled phone can keep up. `readPixels` at the end of each window
     * forces the pipeline to actually finish the work.
     */
    const rates: number[] = [];
    const deadline = performance.now() + PLAN.gpu;
    // Small batches so the driver cannot absorb a whole window in its queue.
    const batch = 10;
    while (performance.now() < deadline) {
        const started = performance.now();
        for (let index = 0; index < batch; index += 1) {
            gl.uniform1f(uniform, index * 0.01);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const ms = performance.now() - started;
        rates.push((batch * megapixelsPerDraw * 1000) / Math.max(ms, 0.05));
    }

    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { renderer, megapixelsS: Math.round(median(rates)) };
}

/* --------------------------------------------------------------- stage five */

/** WebGPU adapter, WebAssembly features and timer resolution. */
async function probePlatform(): Promise<{
    webgpu: boolean;
    webgpuInfo: string | null;
    webgpuFeatures: number;
    wasmSimd: boolean;
    wasmThreads: boolean;
    timerMs: number;
}> {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    let webgpu = false;
    let webgpuInfo: string | null = null;
    let webgpuFeatures = 0;
    if (gpu) {
        try {
            const adapter = (await gpu.requestAdapter()) as
                | {
                      info?: { vendor?: string; architecture?: string; description?: string };
                      features?: { size: number };
                  }
                | null;
            if (adapter) {
                webgpu = true;
                const info = adapter.info;
                const parts = [info?.vendor, info?.architecture, info?.description].filter(Boolean);
                webgpuInfo = parts.length > 0 ? parts.join(' · ') : null;
                webgpuFeatures = adapter.features?.size ?? 0;
            }
        } catch {
            // No adapter: WebGPU stays false.
        }
    }

    // A 16-byte module using v128: validates only where the engine supports SIMD.
    let wasmSimd = false;
    try {
        wasmSimd = WebAssembly.validate(
            new Uint8Array([
                0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
                65, 0, 253, 15, 253, 98, 11,
            ])
        );
    } catch {
        wasmSimd = false;
    }
    const wasmThreads =
        typeof SharedArrayBuffer === 'function' &&
        (window.crossOriginIsolated || typeof (globalThis as { Atomics?: unknown }).Atomics === 'object');

    // Smallest step the clock reports: 0.005 on hardened browsers, 0.1-1 on phones.
    const samples: number[] = [];
    let previous = performance.now();
    for (let index = 0; index < 200; index += 1) {
        let now = performance.now();
        while (now === previous) now = performance.now();
        samples.push(Math.round((now - previous) * 1000) / 1000);
        previous = now;
    }

    return { webgpu, webgpuInfo, webgpuFeatures, wasmSimd, wasmThreads, timerMs: Math.min(...samples) };
}

/* ------------------------------------------------------------------- driver */

export type CalibrationProgress = (percent: number, stage: string) => void;

export async function calibrateDevice(onProgress?: CalibrationProgress): Promise<Calibration> {
    const startedAll = performance.now();
    let spent = 0;
    const advance = (stage: string, ms: number) => {
        spent += ms;
        onProgress?.(Math.min(99, Math.round((spent / TOTAL_BUDGET) * 100)), stage);
    };

    /**
     * Percent for a stage, so the bar creeps forward inside a stage instead of
     * jumping only when one ends.
     */
    const stageReporter = (stage: string, offset: number, budget: number) => (fraction: number) =>
        onProgress?.(
            Math.min(99, Math.round(((offset + fraction * budget) / TOTAL_BUDGET) * 100)),
            stage
        );

    onProgress?.(0, 'single');
    const single = await measureSingleCore(stageReporter('single', 0, PLAN.single));
    advance('sustained', PLAN.single);

    const throttle = await measureSustained(stageReporter('sustained', spent, PLAN.sustained));
    // Both numbers describe the same machine: the sustained rate is the single-core
    // median scaled by how much of it survives six seconds of load.
    const cpuSustained = Math.round(single.value * throttle);
    advance('scaling', PLAN.sustained);

    const cores = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2));
    const scalingResult = await measureScaling(cores);
    const cpuMulti = scalingResult.best || single.value;
    advance('memory', PLAN.scaling);

    const memory = await measureSustainable(
        isMobile() ? 512 : 2_048,
        isMobile() ? 64 : 128,
        (fraction) => stageReporter('memory', spent, PLAN.memory)(fraction)
    );
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const heap = (performance as Performance & { memory?: { jsHeapSizeLimit?: number } }).memory;
    advance('gpu', PLAN.memory);

    const gpu = measureGpu();
    advance('platform', PLAN.gpu);

    const platform = await probePlatform();
    advance('done', PLAN.platform);

    const scaling = Math.round((cpuMulti / Math.max(single.value, 1)) * 10) / 10;
    const scalingEfficiency = Math.round((scaling / Math.max(cores, 1)) * 100) / 100;
    const score = Math.round(
        100 *
            (WEIGHTS.cpuSingle * (single.value / REFERENCE.cpuSingle) +
                WEIGHTS.cpuMulti * (cpuMulti / REFERENCE.cpuMulti) +
                WEIGHTS.gpu * ((gpu.megapixelsS ?? 0) / REFERENCE.gpu))
    );
    /**
     * Bands, relative to the reference desktop = 100.
     *
     * 60 is "this machine runs the suite comfortably", 25 is "it runs it slowly",
     * below that it is a low-end phone. The cutoff used to be 70, which filed a
     * 8-core desktop with a GTX 980 as "mid" when it is perfectly capable.
     */
    const tier: Calibration['tier'] = score >= 60 ? 'alta' : score >= 25 ? 'media' : 'baja';
    onProgress?.(100, 'done');

    return {
        cpuSingle: single.value,
        cpuSpread: single.spread,
        cpuSustained,
        throttle,
        cpuMulti,
        workers: scalingResult.workers,
        cores,
        scaling,
        scalingEfficiency,
        memoryGb: typeof deviceMemory === 'number' ? deviceMemory : null,
        maxBufferMb: memory.sustainableMb,
        maxBufferIsFloor: memory.isCap,
        fillMbS: memory.fillMbS,
        sustainableMb: memory.sustainableMb,
        frameBaseMs: memory.frameBaseMs,
        sustainableIsCap: memory.isCap,
        sustainableReliable: memory.reliable,
        heapLimitMb: heap?.jsHeapSizeLimit ? Math.round(heap.jsHeapSizeLimit / (1024 * 1024)) : null,
        gpuRenderer: gpu.renderer,
        gpuMegapixelsS: gpu.megapixelsS,
        webgpu: platform.webgpu,
        webgpuInfo: platform.webgpuInfo,
        webgpuFeatures: platform.webgpuFeatures,
        wasmSimd: platform.wasmSimd,
        wasmThreads: platform.wasmThreads,
        timerMs: platform.timerMs,
        score,
        tier,
        checksum: single.checksum,
        measuredAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - startedAll),
    };
}
