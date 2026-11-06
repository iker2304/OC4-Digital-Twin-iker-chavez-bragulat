/**
 * `/bench` — measure this machine, stage by stage, and keep a record.
 *
 * ## Why a page and not a script
 *
 * The numbers that matter here (WASM thread count, WebGPU availability, thermal
 * throttling after ten seconds of inference, the cost of one `drawImage`) only
 * exist inside the browser that will actually run the app. A Node benchmark
 * measures a different runtime and lies. So this page loads the real engine, the
 * real model and the real pose solve, and drives them from a synthetic camera
 * (`scenarios.ts`) that moves the same way a hand does.
 *
 * ## Sections, in the order they are useful
 *
 *   1. **Equipos** — the machines we know, plus registering a new one (nickname,
 *      category, and whatever the browser confesses about the hardware).
 *   2. **Comparativa** — the ones ticked in that list, side by side.
 *   3. **Preview** — the synthetic camera, with the detections drawn on top.
 *   4. **Benchmarks** — run one or all.
 *   5. **Test** — the results of this session.
 *   6. **Promedio histórico** of the active device.
 *   7. **Ejecuciones guardadas** of the active device, with dates and CSV.
 *
 * ## What is measured, per sample
 *
 *   capture    `drawImage` of the frame that is about to be read
 *   preprocess letterbox + tensor build (inside `engine.run`)
 *   inference  the session run itself
 *   postprocess decode + NMS
 *   pose       PnP on the decoded keypoints
 *   ready      capture → pose solved ("hasta que acaba de predecir")
 *   paint      capture → the first animation frame after the pose was stored
 *
 * The preview overlay is drawn **after** the sample is recorded, so watching the
 * boxes while the test runs costs nothing in the numbers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { API_BASE, withBase } from '../lib/env';
import { useAppStore } from '../store/appStore';
import { useDetectionEngine } from '../lib/inference/useDetectionEngine';
import { updatePose } from '../lib/pose/poseTracker';
import { computeCover, sourceToDisplay } from '../lib/geometry';
import type { Detection } from '../types';
import { SCENARIOS, SceneSource } from './scenarios';
import type { ScenarioId } from './scenarios';
import { ScatterPlot } from './Plot';
import type { PlotLine, PlotPoint } from './Plot';
import { ModelSpecPicker } from '../components/ModelSpecPicker';
import { buildRunPayload, postRun } from './payload';
import { CATEGORY_LABELS, describeHardware, guessCategory, probeHardware, slugify } from './hardware';
import type { Category, Hardware } from './hardware';
import { filterBenchmarkModels, isBenchmarkModelFile, parseModelFile } from '../lib/modelNames';
import { round, stats } from './stats';

const DEVICE_KEY = 'oc4.bench-device';
const CHECKED_KEY = 'oc4.bench-compare';
const SCOPE_KEY = 'oc4.bench-scope';

/**
 * Which measurements the page looks at.
 *
 * `public` is what strangers produced from the QR wizard, `private` is ours. The
 * split matters when the campaign starts: the averages of a random phone should
 * not move the baseline of the machines we are tracking.
 */
type DataScope = 'all' | 'private' | 'public';
/** Samples kept per scenario, after two discarded warm-up runs. */
const SAMPLES = 8;
/**
 * Inference rate of the preview between tests.
 *
 * Two per second is enough to see the boxes follow a pan (the slowest scenario is
 * 1 Hz) and cheap enough not to heat the machine before a run.
 */
const PREVIEW_FPS = 2;

interface DeviceProfile {
    id: string;
    name: string;
    category: Category;
    hardware: Hardware | null;
    runs?: number;
    samples?: number;
    lastRun?: string | null;
    /** Sample-weighted mean of every test, in ms (null when nothing measured). */
    averageReadyMs?: number | null;
    averagePaintMs?: number | null;
    averageInferenceMs?: number | null;
    legacy?: boolean;
}

interface Sample {
    captureMs: number;
    preprocessMs: number;
    inferenceMs: number;
    postprocessMs: number;
    poseMs: number;
    readyMs: number;
    paintMs: number;
    detected: number;
    solved: boolean;
    /** Mean confidence of this frame's detections (0..1). */
    score: number;
    /**
     * RMS reprojection error of the solved pose, in source pixels.
     *
     * `null` when no pose was solved: averaging it as 0 would hide exactly the
     * frames that failed, which are the interesting ones.
     */
    rmsPx: number | null;
}

interface ScenarioResult {
    scenario: ScenarioId;
    samples: Sample[];
    /** Averages per stage; `rmsPx` is `null` when no pose was solved. */
    mean: Record<string, number | null>;
}

/** One `.onnx` the deployment serves (comes from `/api/models`). */
interface ModelFile {
    file: string;
    url: string;
    bytes: number;
    labels: boolean;
}

/** One model that already has runs (comes from `/api/bench/models`). */
interface ModelStat {
    modelId: string;
    name: string;
    legacy: boolean;
    runs: number;
    bytes?: number | null;
    inputSize?: number | null;
    task?: string | null;
    keypoints?: number | null;
    firstAt: string;
    lastAt: string;
    devices: Array<{ deviceId: string; name: string; runs: number }>;
}

function formatMb(bytes: number | null | undefined): string {
    if (!bytes) return '—';
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Resolves on the next painted frame, i.e. once a result would be visible. */
function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function readStored<T>(key: string, fallback: T): T {
    try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
}

function store(key: string, value: unknown) {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Private mode: the page still works, it just forgets.
    }
}

export function BenchPage() {
    const { engine, loadFromUrl, loadFromFile, bundledModelUrl } = useDetectionEngine();
    const modelStatus = useAppStore((state) => state.modelStatus);
    const modelError = useAppStore((state) => state.modelError);
    const modelProgress = useAppStore((state) => state.modelProgress);
    const provider = useAppStore((state) => state.model?.provider ?? null);
    const wasmNote = useAppStore((state) => state.wasmNote);

    /* ------------------------------------------------------------- machines */
    const [devices, setDevices] = useState<DeviceProfile[]>([]);
    const [activeId, setActiveId] = useState<string>(() => readStored(DEVICE_KEY, ''));
    const [checked, setChecked] = useState<string[]>(() => readStored<string[]>(CHECKED_KEY, []));
    const [scope, setScope] = useState<DataScope>(() => readStored<DataScope>(SCOPE_KEY, 'all'));
    /** Appended to every server call, so all sections agree on the filter. */
    const scopeQuery = scope === 'all' ? '' : `scope=${scope}`;
    const [hardware, setHardware] = useState<Hardware | null>(null);
    const [newName, setNewName] = useState('');
    const [newCategory, setNewCategory] = useState<Category>('sobremesa');
    /** Manual specs, for what the browser refuses to reveal (RAM in Firefox/Safari, GPU name in Chrome). */
    const [manualRam, setManualRam] = useState('');
    const [manualGpu, setManualGpu] = useState('');
    const [savingProfile, setSavingProfile] = useState(false);

    /* ---------------------------------------------------------------- bench */
    const [ready, setReady] = useState(false);
    const [running, setRunning] = useState<ScenarioId | 'todo' | null>(null);
    const [progress, setProgress] = useState('');
    const [results, setResults] = useState<ScenarioResult[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [videoSource, setVideoSource] = useState<'incluido' | 'propio' | 'ninguno'>('ninguno');
    const videoUrl = useRef<string | null>(null);

    /* --------------------------------------------------------------- server */
    const [summary, setSummary] = useState<SummaryPayload | null>(null);
    const [runs, setRuns] = useState<RunRecord[]>([]);
    const [compare, setCompare] = useState<CompareDevice[]>([]);
    const [modelFiles, setModelFiles] = useState<ModelFile[]>([]);
    const [modelStats, setModelStats] = useState<ModelStat[]>([]);
    /** File being loaded right now, so the modal can name it. */
    const [pendingModel, setPendingModel] = useState<string | null>(null);
    /** Progress of "run every model", or `null` when no batch is running. */
    const [batch, setBatch] = useState<{ index: number; total: number; name: string } | null>(null);
    /** Set by the stop button; the loop checks it between models and scenarios. */
    const stopBatch = useRef(false);

    const sourceRef = useRef<SceneSource | null>(null);
    const hostRef = useRef<HTMLDivElement | null>(null);
    const overlayRef = useRef<HTMLCanvasElement | null>(null);
    const autoLoaded = useRef(false);
    /**
     * True while a test owns the engine.
     *
     * A ref, not the `running` state: the preview loop has to see it in the same
     * tick the test starts, and a React state update lands later.
     */
    const busy = useRef(false);
    /**
     * Latest engine, for the long-running loops.
     *
     * `runAllModels` captures its callbacks when the button is pressed; after
     * `loadFromUrl` the hook hands out a new engine for the new session. Reading
     * it through a ref is what keeps the batch measuring the model it just loaded
     * instead of the previous one.
     */
    const engineRef = useRef(engine);
    useEffect(() => {
        engineRef.current = engine;
    }, [engine]);
    /** True while one preview inference is in flight (the engine is serial). */
    const previewInFlight = useRef(false);

    const active = useMemo(
        () => devices.find((device) => device.id === activeId) ?? devices[0] ?? null,
        [devices, activeId]
    );

    /* ------------------------------------------------------------ the canvas */

    /** One canvas, mounted once: the bench drives it, the page shows it. */
    useEffect(() => {
        const source = new SceneSource();
        sourceRef.current = source;
        void source
            .load(withBase('/test/'))
            .then(() => {
                hostRef.current?.appendChild(source.canvas);
                source.start();
                setVideoSource(source.video ? 'incluido' : 'ninguno');
                setReady(true);
            })
            .catch((cause: unknown) => setError(String(cause)));
        return () => {
            source.stop();
            source.canvas.remove();
            sourceRef.current = null;
        };
    }, []);

    /** Failures get their say; the bundled model needs no user action. */
    useEffect(() => {
        if (autoLoaded.current || !bundledModelUrl || modelStatus !== 'idle') return;
        autoLoaded.current = true;
        void loadFromUrl(bundledModelUrl, { silent: true });
    }, [bundledModelUrl, loadFromUrl, modelStatus]);

    /* ---------------------------------------------------------------- models */

    /**
     * Which `.onnx` this page is benchmarking.
     *
     * The same machine is much faster with one model than with another, so a
     * benchmark row is really (model, device). The id is derived exactly like the
     * server does — `slug(file)` plus the fingerprint of the bytes — so the page
     * can filter by a model it has not run yet.
     */
    const loadedModel = useAppStore((state) => state.model);
    const modelName = useAppStore((state) => state.modelName);
    const currentModelId = useMemo(() => {
        if (!modelName) return null;
        const base = slugify(modelName.replace(/\.onnx$/i, ''));
        return loadedModel?.fingerprint ? `${base}-${loadedModel.fingerprint}` : base;
    }, [loadedModel?.fingerprint, modelName]);

    /**
     * Which model the tables below are *showing*.
     *
     * Usually the one loaded in the engine, but the history may contain runs of a
     * model whose file is no longer deployed: those must stay reachable, so the
     * view can be pointed at any id (and at all of them) without loading anything.
     */
    const [viewModelId, setViewModelId] = useState<string>('auto');
    const filterModelId =
        viewModelId === 'auto' ? currentModelId : viewModelId === 'all' ? null : viewModelId;

    const loadModels = useCallback(async () => {
        try {
            const response = await fetch(`${API_BASE}/models`);
            if (response.ok) {
                const payload = (await response.json()) as { models?: ModelFile[] };
                setModelFiles(filterBenchmarkModels(payload.models ?? []));
            }
        } catch {
            // Offline.
        }
        try {
            const response = await fetch(`${API_BASE}/bench/models${scopeQuery ? `?${scopeQuery}` : ''}`);
            if (response.ok) {
                const payload = (await response.json()) as { models?: ModelStat[] };
                setModelStats((payload.models ?? []).filter((entry) => isBenchmarkModelFile(entry.name)));
            }
        } catch {
            // Offline.
        }
    }, [scopeQuery]);

    /** Loads a model from the server into the engine, which is what the runs use. */
    const chooseModel = useCallback(
        async (file: ModelFile) => {
            if (running !== null) return;
            setError(null);
            setRunning('todo');
            setPendingModel(file.file);
            try {
                await loadFromUrl(withBase(file.url));
            } catch (cause) {
                setError(`No pude cargar ${file.file}: ${String(cause)}`);
            } finally {
                setRunning(null);
                setPendingModel(null);
                setProgress('');
                await loadModels();
            }
        },
        [loadFromUrl, loadModels, running]
    );

    /* --------------------------------------------------------------- devices */

    const loadDevices = useCallback(async (modelId: string | null) => {
        try {
            const query = [
                modelId ? `modelId=${encodeURIComponent(modelId)}` : null,
                scopeQuery || null,
            ]
                .filter(Boolean)
                .join('&');
            const response = await fetch(`${API_BASE}/bench/devices${query ? `?${query}` : ''}`);
            if (!response.ok) return;
            const payload = (await response.json()) as { devices?: DeviceProfile[] };
            setDevices(payload.devices ?? []);
        } catch {
            // Offline: the rest of the page still works.
        }
    }, [scopeQuery]);

    useEffect(() => {
        void probeHardware().then((probed) => {
            setHardware(probed);
            setNewCategory(guessCategory(probed));
        });
        void loadModels();
    }, [loadModels]);

    /** Devices are listed (and averaged) within the selected model. */
    useEffect(() => {
        void loadDevices(filterModelId);
    }, [filterModelId, loadDevices]);

    /** Keeps the active id valid once the list arrives, and the ticks sensible. */
    useEffect(() => {
        if (devices.length === 0) return;
        setActiveId((current) => {
            if (current && devices.some((device) => device.id === current)) return current;
            const first = devices[0].id;
            store(DEVICE_KEY, first);
            return first;
        });
        setChecked((current) => {
            const valid = current.filter((id) => devices.some((device) => device.id === id));
            if (valid.length > 0) return valid;
            // First visit: compare everything we have.
            const all = devices.map((device) => device.id).slice(0, 3);
            store(CHECKED_KEY, all);
            return all;
        });
    }, [devices]);

    const chooseActive = useCallback((id: string) => {
        setActiveId(id);
        store(DEVICE_KEY, id);
    }, []);

    const toggleChecked = useCallback((id: string) => {
        setChecked((current) => {
            const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
            store(CHECKED_KEY, next);
            return next;
        });
    }, []);

    const addDevice = useCallback(async () => {
        const name = newName.trim() || `Equipo ${devices.length + 1}`;
        const id = slugify(name) || `equipo-${Date.now().toString(36)}`;
        /**
         * Merge the manual RAM into the probed specs.
         *
         * `navigator.deviceMemory` only exists in Chromium, so on Firefox and
         * Safari the value is `null` and any chart using RAM would have nothing to
         * plot. What the user types wins: they know the machine.
         */
        const typedRam = Number(manualRam.replace(',', '.'));
        const typedGpu = manualGpu.trim();
        const specs =
            hardware === null
                ? null
                : {
                    ...hardware,
                    ...(Number.isFinite(typedRam) && typedRam > 0
                        ? { memoryGb: typedRam, memoryManual: true }
                        : {}),
                    ...(typedGpu
                        ? { gpu: typedGpu, gpuMasked: false, gpuManual: true }
                        : {}),
                };
        setSavingProfile(true);
        try {
            const response = await fetch(`${API_BASE}/bench/devices`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, name, category: newCategory, hardware: specs }),
            });
            if (!response.ok) {
                setError('No pude guardar el equipo en el servidor.');
                return;
            }
            await loadDevices(filterModelId);
            chooseActive(id);
            setChecked((current) => {
                const next = current.includes(id) ? current : [...current, id];
                store(CHECKED_KEY, next);
                return next;
            });
            setNewName('');
            setManualRam('');
            setManualGpu('');
        } finally {
            setSavingProfile(false);
        }
    }, [chooseActive, devices.length, filterModelId, hardware, loadDevices, manualGpu, manualRam, newCategory, newName]);

    /**
     * Deletes a device **and every run stored for it**.
     *
     * A confirmation first: there is no undo, and the runs are the only copy (the
     * CSV export exists precisely so a mistake like this one is recoverable).
     */
    const deleteDevice = useCallback(
        async (device: DeviceProfile) => {
            const runs = device.runs ?? 0;
            const confirmed = window.confirm(
                `¿Borrar «${device.name}» y sus ${runs} ejecuciones?\n\nNo se puede deshacer. Descarga antes el CSV si quieres conservarlas.`
            );
            if (!confirmed) return;
            try {
                const response = await fetch(`${API_BASE}/bench/devices/${device.id}`, { method: 'DELETE' });
                if (!response.ok) {
                    setError('No pude borrar el equipo en el servidor.');
                    return;
                }
                const payload = (await response.json()) as { removedRuns?: number };
                setError(null);
                await loadDevices(filterModelId);
                setChecked((current) => {
                    const next = current.filter((id) => id !== device.id);
                    store(CHECKED_KEY, next);
                    return next;
                });
                if (device.id === activeId) {
                    setActiveId('');
                    store(DEVICE_KEY, '');
                }
                if (payload.removedRuns === undefined || payload.removedRuns > 0) {
                    setResults((current) => current.filter(() => false));
                }
                // No explicit refetch: removing it from `devices` and `checked`
                // changes those states, and the effect above reloads summary, runs
                // and comparison.
            } catch {
                setError('No pude borrar el equipo (sin conexión con el servidor).');
            }
        },
        [activeId, filterModelId, loadDevices]
    );

    /**
     * Wipes every run and every profile inside the current scope.
     *
     * Two confirmations, because there is no undo and the scope can be `all`: the
     * first asks what is about to go, the second is the one that actually stops
     * people. Refusing while a batch runs keeps the two from fighting over the
     * same files.
     */
    const purgeScope = useCallback(async () => {
        if (running !== null || batch !== null) {
            setError('Para los tests antes de borrar datos.');
            return;
        }
        const label =
            scope === 'all' ? 'TODOS los datos (públicos y privados)' : scope === 'public' ? 'los datos PÚBLICOS' : 'los datos PRIVADOS';
        if (!window.confirm(`Se van a borrar ${label}: ejecuciones y equipos del servidor. ¿Continuar?`)) return;
        if (!window.confirm(`Segunda confirmación: esto no se puede deshacer. ¿Borrar ${label}?`)) return;
        setError(null);
        try {
            const response = await fetch(`${API_BASE}/bench/data?scope=${scope}&confirm=delete`, {
                method: 'DELETE',
            });
            const payload = (await response.json().catch(() => ({}))) as { error?: string };
            if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
            setResults([]);
            setActiveId('');
            setChecked([]);
            store(DEVICE_KEY, '');
            store(CHECKED_KEY, []);
            await loadModels();
            await loadDevices(null);
        } catch (cause) {
            setError(`No pude borrar los datos: ${String(cause)}`);
        }
    }, [batch, loadDevices, loadModels, running, scope]);

    /* ---------------------------------------------------------------- server */
    const loadServerData = useCallback(async (deviceId: string, ids: string[], modelId: string | null) => {
        const model = modelId ? `modelId=${encodeURIComponent(modelId)}` : '';
        const device = deviceId ? `deviceId=${encodeURIComponent(deviceId)}` : '';
        const filter = [device, model, scopeQuery].filter(Boolean).join('&');
        const query = filter ? `?${filter}` : '';
        try {
            const response = await fetch(`${API_BASE}/bench/summary${query}`);
            if (response.ok) setSummary((await response.json()) as SummaryPayload);
        } catch {
            // Bonus data.
        }
        try {
            const response = await fetch(`${API_BASE}/bench/runs${query}${filter ? '&' : '?'}limit=20`);
            if (response.ok) {
                const payload = (await response.json()) as { runs?: RunRecord[] };
                setRuns(payload.runs ?? []);
            }
        } catch {
            // Bonus data.
        }
        try {
            const params = [
                ids.length > 0 ? `ids=${ids.join(',')}` : '',
                model,
                scopeQuery,
            ]
                .filter(Boolean)
                .join('&');
            const response = await fetch(`${API_BASE}/bench/compare${params ? `?${params}` : ''}`);
            if (response.ok) {
                const payload = (await response.json()) as { devices?: CompareDevice[] };
                setCompare(payload.devices ?? []);
            }
        } catch {
            // Bonus data.
        }
        /**
         * `scopeQuery` **tiene** que estar aquí.
         *
         * Con la lista de dependencias vacía la función se quedaba con el ámbito
         * de la primera pintada para siempre: `/compare` seguía pidiendo `public`
         * aunque se pulsara «Privados», y como los ids marcados ya eran privados
         * la intersección salía vacía y la gráfica desaparecía.
         */
    }, [scopeQuery]);

    useEffect(() => {
        /**
         * No "nothing to do yet" guard here.
         *
         * The previous one (`if (!active && checked.length === 0) return`) also
         * fired when a device was deleted and it was the last one ticked, so the
         * comparison kept showing the deleted machine until a reload. Fetching
         * with empty selections simply means "all devices" for `/compare` and "the
         * whole history" for `/summary`, which is correct on a fresh page too.
         */
        void loadServerData(active?.id ?? '', checked, filterModelId);
    }, [active, checked, filterModelId, loadServerData]);

    /* ----------------------------------------------------------- the preview */

    /**
     * Boxes and keypoints over the synthetic frame.
     *
     * Called once per sample, **after** the timings are recorded: drawing costs a
     * fraction of a millisecond on a canvas this size, but the point of a
     * benchmark is that watching it cannot change the answer.
     */
    const drawOverlay = useCallback((detections: Detection[]) => {
        const canvas = overlayRef.current;
        const source = sourceRef.current?.canvas;
        if (!canvas || !source) return;
        const width = source.clientWidth;
        const height = source.clientHeight;
        if (width <= 0 || height <= 0) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const cover = computeCover(source.width, source.height, width, height, false);
        for (const detection of detections) {
            const [x1, y1] = sourceToDisplay(detection.bbox[0], detection.bbox[1], cover, false);
            const [x2, y2] = sourceToDisplay(detection.bbox[2], detection.bbox[3], cover, false);
            ctx.strokeStyle = detection.score > 0.6 ? '#22d3ee' : '#fbbf24';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
            ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
            const label = `${detection.label} ${(detection.score * 100).toFixed(0)}%`;
            const chipY = Math.max(0, y1 - 13);
            ctx.fillStyle = 'rgba(2,6,23,0.75)';
            ctx.fillRect(x1, chipY, ctx.measureText(label).width + 6, 12);
            ctx.fillStyle = '#e2e8f0';
            ctx.fillText(label, x1 + 3, chipY + 9);

            for (const keypoint of detection.keypoints ?? []) {
                if (keypoint.score < 0.4) continue;
                const [kx, ky] = sourceToDisplay(keypoint.x, keypoint.y, cover, false);
                ctx.beginPath();
                ctx.fillStyle = '#f0abfc';
                ctx.arc(kx, ky, 2.2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }, []);

    /**
     * Live preview: keeps the boxes moving when no test is running.
     *
     * Without this the overlay only changed while a test was in flight — the
     * canvas kept animating and the detections stayed where the last sample left
     * them, so panning looked like "it detected once at the beginning and then
     * stopped". It runs at `PREVIEW_FPS` and stops the instant a test takes the
     * engine (the `busy` ref, not the state, so there is no window where both are
     * running), which is what keeps it out of the numbers.
     */
    useEffect(() => {
        if (!engine || !ready) return;
        let cancelled = false;
        let timer = 0;

        const step = async () => {
            if (cancelled) return;
            const source = sourceRef.current;
            /**
             * `?pdebug=1` counts what the loop is doing, and — for automated checks
             * in a tab the browser reports as hidden — lets it run anyway. One
             * predicate, no effect in normal use.
             */
            const pdebug = new URLSearchParams(window.location.search).has('pdebug');
            const counters = pdebug
                ? ((window as unknown as { __preview?: Record<string, number> }).__preview ??= {
                    ticks: 0,
                    ran: 0,
                    skippedBusy: 0,
                    skippedHidden: 0,
                    skippedSource: 0,
                    skippedInFlight: 0,
                })
                : null;
            const mayRun = !document.hidden || pdebug;
            if (counters) {
                counters.ticks += 1;
                if (!source) counters.skippedSource += 1;
                else if (!mayRun) counters.skippedHidden += 1;
                else if (busy.current) counters.skippedBusy += 1;
                else if (previewInFlight.current) counters.skippedInFlight += 1;
            }
            if (source && mayRun && !busy.current && !previewInFlight.current) {
                previewInFlight.current = true;
                if (counters) counters.ran += 1;
                try {
                    const app = useAppStore.getState();
                    const result = await engine.run(
                        source.canvas,
                        source.canvas.width,
                        source.canvas.height,
                        {
                            confidence: app.confidence,
                            iou: app.iou,
                            maxDetections: app.maxDetections,
                        }
                    );
                    drawOverlay(result.detections);
                } catch {
                    // A preview that throws is not worth a banner: the next tick
                    // simply tries again.
                } finally {
                    previewInFlight.current = false;
                }
            }
            if (!cancelled) timer = window.setTimeout(() => void step(), 1000 / PREVIEW_FPS);
        };

        void step();
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [drawOverlay, engine, ready]);

    /* --------------------------------------------------------------- running */

    const runScenario = useCallback(
        async (scenario: ScenarioId): Promise<ScenarioResult | null> => {
            const source = sourceRef.current;
            const app = useAppStore.getState();
            const current = engineRef.current;
            if (!source) return null;
            if (!current) {
                setError('El modelo aún no está listo.');
                return null;
            }
            if (!active) {
                setError('Primero añade un equipo: los resultados se guardan a su nombre.');
                return null;
            }
            if (scenario === 'video') {
                // Called straight from the tap: mobile browsers only start media
                // playback inside a gesture.
                const playing = await source.ensurePlaying();
                if (!playing) {
                    setError(`Vídeo de prueba: ${source.videoProblem() ?? 'no arranca'}.`);
                    return null;
                }
            }

            source.scenario = scenario;
            const { width, height } = source.canvas;
            const samples: Sample[] = [];
            let previous = app.pose;
            /**
             * Wait for any preview inference that is already running.
             *
             * The engine is serial, so starting now would make the test's first
             * samples pay for the preview's frame. Bounded: a stuck preview must
             * not block the button for ever.
             */
            const deadline = performance.now() + 5000;
            while (previewInFlight.current && performance.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            // From here on the engine belongs to this test: the preview loop reads
            // this ref synchronously and steps aside.
            busy.current = true;
            try {
                for (let index = 0; index < SAMPLES + 2; index += 1) {
                    setProgress(`${index + 1}/${SAMPLES + 2}`);
                    const started = performance.now();
                    const captureMs = source.frame();
                    const result = await current.run(source.canvas, width, height, {
                        confidence: app.confidence,
                        iou: app.iou,
                        maxDetections: app.maxDetections,
                    });

                    const poseStart = performance.now();
                    const tracked = updatePose({
                        detections: result.detections,
                        sourceWidth: width,
                        sourceHeight: height,
                        previous,
                        options: {
                            minScore: app.keypointMinScore,
                            horizontalFovDeg: app.poseHfovDeg,
                            poseAgeMs: Number.POSITIVE_INFINITY,
                            frameMs: 100,
                        },
                    });
                    const poseMs = performance.now() - poseStart;
                    previous = tracked.pose ?? previous;

                    useAppStore.setState({
                        detections: result.detections,
                        pose: tracked.pose,
                        poseUpdatedAt: tracked.accepted ? Date.now() : 0,
                    });

                    const readyMs = performance.now() - started;
                    await nextFrame();
                    await nextFrame();
                    const paintMs = performance.now() - started;

                    const sample: Sample = {
                        captureMs: round(captureMs),
                        preprocessMs: round(result.preprocessMs),
                        inferenceMs: round(result.inferenceMs),
                        postprocessMs: round(result.postprocessMs),
                        poseMs: round(poseMs),
                        readyMs: round(readyMs),
                        paintMs: round(paintMs),
                        detected: result.detections.length,
                        // `accepted`, not `solved`: a solve the jump guard throws away
                        // leaves the overlay where it was, which is the failure this
                        // column is supposed to expose.
                        solved: tracked.accepted,
                        score:
                            result.detections.length > 0
                                ? round(
                                    result.detections.reduce((sum, d) => sum + d.score, 0) /
                                    result.detections.length
                                )
                                : 0,
                        rmsPx:
                            tracked.solved && Number.isFinite(tracked.pose?.rmsError)
                                ? round(tracked.pose?.rmsError ?? 0)
                                : null,
                    };
                    // Warm-up runs pay for kernel setup and shader compilation.
                    if (index >= 2) samples.push(sample);
                    drawOverlay(result.detections);
                }
            } finally {
                // Hand the engine back even if a sample threw: the preview resumes
                // and the buttons stop being disabled forever.
                busy.current = false;
            }

            const mean = {
                captureMs: stats(samples.map((s) => s.captureMs)).mean,
                preprocessMs: stats(samples.map((s) => s.preprocessMs)).mean,
                inferenceMs: stats(samples.map((s) => s.inferenceMs)).mean,
                postprocessMs: stats(samples.map((s) => s.postprocessMs)).mean,
                poseMs: stats(samples.map((s) => s.poseMs)).mean,
                readyMs: stats(samples.map((s) => s.readyMs)).mean,
                paintMs: stats(samples.map((s) => s.paintMs)).mean,
                detected: stats(samples.map((s) => s.detected)).mean,
                solvedRate: round(
                    (samples.filter((s) => s.solved).length / Math.max(1, samples.length)) * 100
                ),
                score: stats(samples.map((s) => s.score)).mean,
                rmsPx:
                    stats(samples.map((s) => s.rmsPx).filter((v): v is number => v !== null)).mean ||
                    null,
            };

            try {
                await postRun(
                    API_BASE,
                    buildRunPayload({
                        device: {
                            id: active.id,
                            name: active.name,
                            category: active.category,
                            hardware: active.hardware ?? null,
                        },
                        scenario,
                        samples,
                        mean,
                        hardware,
                        runtime: { provider, note: wasmNote },
                        model: useAppStore.getState().model,
                    })
                );
            } catch {
                setError('No pude guardar el resultado en el servidor (el test sigue siendo válido).');
            }

            return { scenario, samples, mean };
        },
        [active, drawOverlay, hardware, provider, wasmNote]
    );

    const runAll = useCallback(async () => {
        setError(null);
        setRunning('todo');
        /**
         * Kick the clip off **inside the tap**: iOS rejects `play()` once the
         * gesture has expired, and the video test is the sixth of the list.
         */
        void sourceRef.current?.ensurePlaying(1500);
        const collected: ScenarioResult[] = [];
        for (const scenario of SCENARIOS) {
            const result = await runScenario(scenario.id);
            if (result) {
                collected.push(result);
                setResults([...collected]);
            }
        }
        setRunning(null);
        setProgress('');
        await loadDevices(filterModelId);
        await loadServerData(active?.id ?? '', checked, filterModelId);
    }, [active, checked, filterModelId, loadDevices, loadServerData, runScenario]);

    /**
     * Runs the whole suite against **every** deployed model.
     *
     * Same scenarios, same samples, same posting as the single-model buttons —
     * the only difference is the outer loop, which loads a model, runs the seven
     * tests, and moves to the next. This is what fills the model axis of the plot
     * in one go instead of by hand, one chip at a time.
     *
     * A model that fails to load is reported and skipped: losing the whole batch
     * because one file is missing would be worse than a gap in the data.
     */
    const runAllModels = useCallback(async () => {
        if (!active || !engine || running !== null || batch !== null) return;
        setError(null);
        stopBatch.current = false;
        const models = modelFiles;
        for (let index = 0; index < models.length; index += 1) {
            if (stopBatch.current) break;
            const file = models[index];
            setBatch({ index: index + 1, total: models.length, name: file.file });
            setPendingModel(file.file);
            try {
                await loadFromUrl(withBase(file.url));
                /**
                 * Wait for the store to name the new model.
                 *
                 * `runScenario` reads the engine through a ref, but the input size
                 * comes from the store: running in the gap between "session
                 * created" and "store updated" feeds the new model the old
                 * resolution and ONNX Runtime throws.
                 */
                const deadline = performance.now() + 8000;
                while (useAppStore.getState().modelName !== file.file && performance.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
            } catch (cause) {
                setError(`No pude cargar ${file.file}: ${String(cause)}`);
                setPendingModel(null);
                continue;
            }
            setPendingModel(null);
            setViewModelId('auto');
            for (const scenario of SCENARIOS) {
                if (stopBatch.current) break;
                setRunning(scenario.id);
                const result = await runScenario(scenario.id);
                setRunning(null);
                if (result) {
                    setResults((current) => [
                        ...current.filter((entry) => entry.scenario !== result.scenario),
                        result,
                    ]);
                }
            }
            await loadModels();
        }
        setBatch(null);
        setProgress('');
        await loadModels();
    }, [active, batch, engine, loadFromUrl, loadModels, modelFiles, runScenario, running]);

    const pickVideo = useCallback((file: File | null) => {
        if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
        videoUrl.current = null;
        if (!file) {
            setVideoSource('ninguno');
            if (sourceRef.current) sourceRef.current.video = null;
            return;
        }
        const url = URL.createObjectURL(file);
        videoUrl.current = url;
        const video = document.createElement('video');
        video.src = url;
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        void video.play().catch(() => undefined);
        if (sourceRef.current) {
            sourceRef.current.video = video;
            sourceRef.current.videoLoop = { start: 0, end: 5 };
        }
        setVideoSource('propio');
    }, []);

    /* ------------------------------------------------------------------- ui */

    return (
        <div className="min-h-dvh bg-slate-950 px-4 py-6 pb-16 text-slate-100">
            {/* While the engine loads, nothing on this page is usable: say so and wait. */}
            {modelStatus === 'loading' ? (
                <LoadingOverlay name={pendingModel ?? modelName} progress={modelProgress} />
            ) : null}
            <div className="mx-auto max-w-5xl space-y-6">
                <header className="space-y-1">
                    <h1 className="text-lg font-semibold">Benchmark de dispositivo</h1>
                    <p className="text-xs text-slate-400">
                        Elige el equipo, ejecuta los tests y los resultados se guardan en el servidor a su
                        nombre. {provider ?? 'sin runtime'} · {wasmNote ?? 'sin notas'}
                    </p>
                </header>

                <section className="space-y-3">
                    <SectionTitle>Modelo</SectionTitle>
                    <ModelPickerSection
                        files={modelFiles}
                        stats={modelStats}
                        currentName={modelName}
                        currentId={currentModelId}
                        viewId={viewModelId}
                        onView={setViewModelId}
                        model={loadedModel}
                        busy={running !== null}
                        onChoose={(file) => {
                            setViewModelId('auto');
                            void chooseModel(file);
                        }}
                        onLocal={async (file) => {
                            if (!file) return;
                            setError(null);
                            setRunning('todo');
                            setPendingModel(file.name);
                            try {
                                await loadFromFile(file);
                                await loadModels();
                            } catch (cause) {
                                setError(`No pude cargar ${file.name}: ${String(cause)}`);
                            } finally {
                                setRunning(null);
                                setPendingModel(null);
                                await loadModels();
                            }
                        }}
                    />
                    <p className="px-1 text-[10px] text-slate-500">
                        Los tests se guardan como (modelo, equipo): cambiar de <code>.onnx</code> abre una
                        clasificación distinta, no mezcla promedios.
                    </p>
                </section>

                <section className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <SectionTitle>Equipos</SectionTitle>
                        <div className="flex flex-wrap items-center gap-1 text-[11px]">
                            {(
                                [
                                    ['all', 'Todos'],
                                    ['private', 'Privados'],
                                    ['public', 'Públicos'],
                                ] as Array<[DataScope, string]>
                            ).map(([value, label]) => (
                                <button
                                    key={value}
                                    type="button"
                                    aria-pressed={scope === value}
                                    onClick={() => {
                                        setScope(value);
                                        store(SCOPE_KEY, value);
                                    }}
                                    className={`rounded-lg border px-2.5 py-1 ${scope === value
                                            ? 'border-sky-400 bg-sky-500/15 text-sky-100'
                                            : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                                        }`}
                                >
                                    {label}
                                </button>
                            ))}
                            <button
                                type="button"
                                disabled={running !== null || batch !== null}
                                onClick={() => void purgeScope()}
                                title="Borra todas las ejecuciones y equipos del ámbito seleccionado"
                                className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-2.5 py-1 text-rose-200 disabled:opacity-40"
                            >
                                Borrar {scope === 'all' ? 'todo' : scope === 'public' ? 'públicos' : 'privados'}
                            </button>
                        </div>
                    </div>
                    <DevicesTable
                        devices={devices}
                        activeId={active?.id ?? ''}
                        checked={checked}
                        onActive={chooseActive}
                        onToggle={toggleChecked}
                        onDelete={(device) => void deleteDevice(device)}
                    />
                    <div className="grid gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:grid-cols-[1fr_auto_auto]">
                        <label className="text-[11px] text-slate-400">
                            Apodo
                            <input
                                value={newName}
                                onChange={(event) => setNewName(event.target.value)}
                                placeholder={hardware?.mobile ? 'Mi móvil' : 'Mi portátil'}
                                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                            />
                        </label>
                        <label className="text-[11px] text-slate-400">
                            Categoría
                            <select
                                value={newCategory}
                                onChange={(event) => setNewCategory(event.target.value as Category)}
                                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                            >
                                {(Object.keys(CATEGORY_LABELS) as Category[]).map((category) => (
                                    <option key={category} value={category}>
                                        {CATEGORY_LABELS[category]}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="text-[11px] text-slate-400">
                            RAM (GB)
                            <input
                                value={manualRam}
                                onChange={(event) => setManualRam(event.target.value)}
                                inputMode="decimal"
                                placeholder={
                                    hardware?.memoryGb ? `${hardware.memoryGb} (detectada)` : 'a mano'
                                }
                                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                            />
                        </label>
                        <label className="text-[11px] text-slate-400">
                            GPU
                            <input
                                value={manualGpu}
                                onChange={(event) => setManualGpu(event.target.value)}
                                placeholder={
                                    hardware && !hardware.gpuMasked && hardware.gpu
                                        ? 'detectada'
                                        : 'RTX 3080…'
                                }
                                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 text-sm text-slate-100"
                            />
                        </label>
                        <button
                            type="button"
                            disabled={savingProfile}
                            onClick={() => void addDevice()}
                            className="self-end rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
                        >
                            {savingProfile ? 'Guardando…' : 'Añadir equipo'}
                        </button>
                    </div>
                    <p className="px-1 text-[10px] text-slate-500">
                        Detectado en esta máquina: {hardware ? describeHardware(hardware) : 'leyendo…'}
                        {hardware?.platform ? ` · ${hardware.platform}` : ''}
                        {hardware ? ` · pantalla ${hardware.screen} @${hardware.dpr.toFixed(2)}x` : ''}
                        {hardware && !hardware.memoryGb
                            ? ' · la RAM no la expone este navegador: escríbela a mano si la quieres en el plot.'
                            : ''}
                    </p>
                </section>

                <section className="space-y-2">
                    <SectionTitle>Comparativa</SectionTitle>
                    <CompareTable devices={compare} />
                    <ComparisonPlot devices={compare} scopeQuery={scopeQuery} ids={checked} />
                </section>

                <section className="space-y-2">
                    <SectionTitle>Preview</SectionTitle>
                    <div className="relative inline-block overflow-hidden rounded-xl border border-white/10">
                        <div ref={hostRef} />
                        <canvas
                            ref={overlayRef}
                            className="pointer-events-none absolute inset-0 h-full w-full"
                        />
                    </div>
                    <p className="text-[10px] text-slate-500">
                        Las cajas y los keypoints se dibujan <em>después</em> de cada medición: mirarlos no
                        cambia los números.
                    </p>
                </section>

                <section className="space-y-2">
                    <SectionTitle>Benchmarks a ejecutar</SectionTitle>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            disabled={!ready || !engine || running !== null || !active}
                            onClick={() => void runAll()}
                            className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
                        >
                            {running === 'todo' && batch === null ? `Ejecutando… ${progress}` : 'Ejecutar todos los tests'}
                        </button>
                        <button
                            type="button"
                            disabled={!ready || !engine || running !== null || batch !== null || !active}
                            onClick={() => void runAllModels()}
                            title="Recorre todos los .onnx desplegados: carga uno, corre los siete tests, guarda y pasa al siguiente"
                            className="rounded-lg border border-sky-400/40 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-200 disabled:opacity-40"
                        >
                            {batch
                                ? `Modelo ${batch.index}/${batch.total} · ${progress}`
                                : `Todos los modelos (${modelFiles.length})`}
                        </button>
                        {batch ? (
                            <button
                                type="button"
                                onClick={() => {
                                    stopBatch.current = true;
                                    setBatch(null);
                                }}
                                className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-200"
                            >
                                Parar
                            </button>
                        ) : null}
                        {SCENARIOS.map((scenario) => (
                            <button
                                key={scenario.id}
                                type="button"
                                title={scenario.hint}
                                disabled={!ready || !engine || running !== null || !active}
                                onClick={async () => {
                                    setError(null);
                                    setRunning(scenario.id);
                                    const result = await runScenario(scenario.id);
                                    if (result) {
                                        setResults((current) => [
                                            ...current.filter((r) => r.scenario !== result.scenario),
                                            result,
                                        ]);
                                    }
                                    setRunning(null);
                                    setProgress('');
                                    await loadDevices(filterModelId);
                                    await loadServerData(active?.id ?? '', checked, currentModelId);
                                }}
                                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-white/10 disabled:opacity-40"
                            >
                                {scenario.label}
                            </button>
                        ))}
                        <label className="ml-auto cursor-pointer rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10">
                            Usar otro vídeo
                            <input
                                type="file"
                                accept="video/*"
                                className="hidden"
                                onChange={(event) => pickVideo(event.target.files?.[0] ?? null)}
                            />
                        </label>
                    </div>
                    <p className="text-[11px] text-slate-500">
                        {active
                            ? `Resultados a nombre de ${active.name}.`
                            : 'Añade un equipo para poder correr los tests.'}{' '}
                        Vídeo:{' '}
                        {videoSource === 'incluido'
                            ? 'incluido (0-5 s en bucle)'
                            : videoSource === 'propio'
                                ? 'propio (0-5 s)'
                                : 'no disponible'}
                        .
                    </p>
                    {modelStatus === 'loading' ? (
                        <p className="text-[11px] text-sky-300">Cargando el modelo…</p>
                    ) : null}
                    {modelError ? <p className="text-[11px] text-rose-300">{modelError}</p> : null}
                    {error ? <p className="text-[11px] text-amber-300">{error}</p> : null}
                </section>

                <section className="space-y-2">
                    <SectionTitle>Test (esta sesión)</SectionTitle>
                    <SessionTable results={results} />
                </section>

                <section className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <SectionTitle>
                            Promedio histórico{active ? ` · ${active.name}` : ''}
                        </SectionTitle>
                        {active ? (
                            <a
                                href={`${API_BASE}/bench/export.csv?deviceId=${active.id}${filterModelId ? `&modelId=${encodeURIComponent(filterModelId)}` : ''
                                    }`}
                                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/10"
                            >
                                Descargar CSV
                            </a>
                        ) : null}
                    </div>
                    <SummaryTable summary={summary} />
                </section>

                <section className="space-y-2">
                    <SectionTitle>Ejecuciones guardadas</SectionTitle>
                    <RunsTable runs={runs} />
                </section>
            </div>
        </div>
    );
}

function SectionTitle({ children }: { children: ReactNode }) {
    return (
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">{children}</h2>
    );
}

/**
 * Blocking overlay while a model loads.
 *
 * Switching model is not instant — 10 MB over mobile data plus session creation
 * and thread warm-up — and until it finishes the engine still holds the previous
 * one. Letting somebody press "Ejecutar todos los tests" in that window would
 * save runs under the old model, so the page waits instead of guessing.
 */
function LoadingOverlay({
    name,
    progress,
}: {
    name: string | null;
    progress: { loaded: number; total: number | null } | null;
}) {
    const percent =
        progress && progress.total && progress.total > 0
            ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
            : null;
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-6 backdrop-blur-sm"
            role="alertdialog"
            aria-busy="true"
            aria-live="polite"
            aria-label="Cargando modelo"
        >
            <div className="w-full max-w-sm space-y-3 rounded-2xl border border-white/10 bg-slate-900 p-5 text-center shadow-2xl">
                <span className="mx-auto block h-8 w-8 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
                <p className="text-sm font-semibold text-slate-100">Cargando modelo…</p>
                {name ? <p className="break-all text-[11px] text-sky-300">{name}</p> : null}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                        className={`h-full rounded-full bg-sky-400 transition-[width] duration-200 ${percent === null ? 'animate-pulse' : ''
                            }`}
                        style={{ width: `${percent ?? 100}%` }}
                    />
                </div>
                <p className="font-mono text-[10px] text-slate-500">
                    {progress ? `${formatMb(progress.loaded)}${progress.total ? ` / ${formatMb(progress.total)}` : ''}` : 'iniciando…'}
                </p>
                <p className="text-[10px] text-slate-500">
                    Los tests esperan: hasta que termine, lo que se ejecute sería con el modelo anterior.
                </p>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ modelos */

/**
 * Which `.onnx` the tests are run against.
 *
 * Kept above the machines on purpose: the model sets the baseline, and comparing
 * a laptop on one model with a desktop on another is comparing nothing. Files
 * come from `/api/models` (whatever is in `public/models`), and the run counts
 * from `/api/bench/models`.
 */
function ModelPickerSection({
    files,
    stats,
    currentName,
    currentId,
    viewId,
    onView,
    model,
    busy,
    onChoose,
    onLocal,
}: {
    files: ModelFile[];
    stats: ModelStat[];
    currentName: string | null;
    currentId: string | null;
    viewId: string;
    onView: (id: string) => void;
    model: { inputSize?: number; kind?: string; numKeypoints?: number; bytes?: number; fingerprint?: string } | null;
    busy: boolean;
    onChoose: (file: ModelFile) => void;
    onLocal: (file: File | null) => void | Promise<void>;
}) {
    /** Runs per file name, summing every fingerprint that shares it. */
    const runsByName = new Map<string, number>();
    for (const entry of stats) {
        runsByName.set(entry.name, (runsByName.get(entry.name) ?? 0) + entry.runs);
    }
    const fileNames = new Set(files.map((file) => file.file));
    /**
     * Models that have history but no file on the server.
     *
     * They cannot be loaded, but hiding them is worse: the runs would look lost.
     * Clicking one only points the tables at it.
     */
    const orphanModels = stats.filter(
        (entry) => isBenchmarkModelFile(entry.name) && !fileNames.has(entry.name)
    );
    const activeView = viewId === 'auto' ? currentId : viewId === 'all' ? 'all' : viewId;

    return (
        <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-[11px] text-slate-300">
                En uso:{' '}
                <span className="font-medium text-sky-300">{currentName ?? 'cargando…'}</span>
                {model ? (
                    <span className="text-slate-500">
                        {' '}
                        · {formatMb(model.bytes)} · {model.inputSize ?? '?'}×{model.inputSize ?? '?'} ·{' '}
                        {model.kind ?? '?'} · {model.numKeypoints ?? 0} kpts
                        {model.fingerprint ? ` · huella ${model.fingerprint}` : ''}
                    </span>
                ) : null}
            </p>
            <AdvancedModelPicker
                files={files}
                currentName={currentName}
                runsByName={runsByName}
                busy={busy}
                onChoose={onChoose}
            />
            <div className="flex flex-wrap items-center gap-2">
                {files.length === 0 ? (
                    <span className="text-[11px] text-slate-500">No hay ningún .onnx en /models.</span>
                ) : null}
                {/* History of a model whose file is not deployed any more. */}
                {orphanModels.map((entry) => (
                    <button
                        key={entry.modelId}
                        type="button"
                        onClick={() => onView(entry.modelId)}
                        title="Modelo sin fichero en el servidor: solo se pueden ver sus datos"
                        className={`rounded-lg border px-2.5 py-1.5 text-left text-[11px] ${activeView === entry.modelId
                            ? 'border-amber-400/60 bg-amber-400/10 text-amber-100'
                            : 'border-white/10 bg-white/5 text-slate-400 hover:bg-white/10'
                            }`}
                    >
                        <span className="block font-medium">{entry.name}</span>
                        <span className="block text-[10px] text-slate-500">
                            {entry.runs} runs · sin fichero
                        </span>
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => onView('all')}
                    className={`self-center rounded-lg border px-2.5 py-1.5 text-[11px] ${activeView === 'all'
                        ? 'border-sky-400 bg-sky-500/15 text-sky-100'
                        : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                        }`}
                >
                    Ver todos los modelos
                </button>
                <label className="cursor-pointer self-center rounded-lg border border-dashed border-white/20 px-2.5 py-1.5 text-[11px] text-slate-400 hover:bg-white/5">
                    Cargar .onnx local
                    <input
                        type="file"
                        accept=".onnx"
                        className="hidden"
                        onChange={(event) => void onLocal(event.target.files?.[0] ?? null)}
                    />
                </label>
            </div>
            {/* Which model the numbers below belong to. */}
            <p className="text-[10px] text-slate-500">
                {currentId
                    ? `id: ${currentId}`
                    : 'Sin modelo cargado: los tests guardarán el modelo que esté activo en ese momento.'}
            </p>
        </div>
    );
}

/**
 * The same three-row architecture × pixels × quantisation selector as the home page.
 *
 * Only combinations that have a file can be clicked: picking a size and then a
 * quantisation loads that exact `.onnx`, and a combination that was never
 * exported is shown disabled instead of doing nothing when pressed.
 */
function AdvancedModelPicker({
    files,
    currentName,
    runsByName,
    busy,
    onChoose,
}: {
    files: ModelFile[];
    currentName: string | null;
    runsByName: Map<string, number>;
    busy: boolean;
    onChoose: (file: ModelFile) => void;
}) {
    const choices = files.flatMap((file) => {
        const spec = parseModelFile(file.file);
        if (!spec) return [];
        const runs = runsByName.get(file.file) ?? 0;
        return [
            {
                file: file.file,
                spec,
                value: file,
                detail: `${formatMb(file.bytes)} · ${runs > 0 ? `${runs} runs` : 'sin runs'}`,
            },
        ];
    });

    return (
        <ModelSpecPicker
            choices={choices}
            currentFile={currentName}
            busy={busy}
            onPick={onChoose}
            hint="Elige nano o small, resolución y fp32/int8. Cada variante selecciona su propio benchmark."
        />
    );
}

/* ------------------------------------------------------------------ equipos */
function DevicesTable({
    devices,
    activeId,
    checked,
    onActive,
    onToggle,
    onDelete,
}: {
    devices: DeviceProfile[];
    activeId: string;
    checked: string[];
    onActive: (id: string) => void;
    onToggle: (id: string) => void;
    onDelete: (device: DeviceProfile) => void;
}) {
    if (devices.length === 0) {
        return (
            <p className="text-[11px] text-slate-500">
                Todavía no hay equipos. Añade el primero abajo: se rellena solo con lo que el navegador
                cuente de esta máquina.
            </p>
        );
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
                <thead className="text-slate-400">
                    <tr>
                        <th className="px-2 py-1 text-left">Comp.</th>
                        <th className="px-2 py-1 text-left">Equipo</th>
                        <th className="px-2 py-1 text-left">Categoría</th>
                        <th className="hidden px-2 py-1 text-left sm:table-cell">Hardware</th>
                        <th className="px-2 py-1 text-right">promedio</th>
                        <th className="px-2 py-1 text-right">runs</th>
                        <th className="hidden px-2 py-1 text-left sm:table-cell">Última</th>
                        <th className="px-2 py-1 text-right">Ejecutar</th>
                        <th className="px-2 py-1" />
                    </tr>
                </thead>
                <tbody>
                    {devices.map((device) => (
                        <tr
                            key={device.id}
                            className={`border-t border-white/5 ${device.id === activeId ? 'bg-sky-500/10' : ''}`}
                        >
                            <td className="px-2 py-1">
                                <input
                                    type="checkbox"
                                    checked={checked.includes(device.id)}
                                    onChange={() => onToggle(device.id)}
                                    aria-label={`Comparar ${device.name}`}
                                />
                            </td>
                            <td className="px-2 py-1 font-medium text-slate-100">{device.name}</td>
                            <td className="px-2 py-1 text-slate-300">
                                {CATEGORY_LABELS[device.category] ?? device.category}
                            </td>
                            <td
                                className="hidden max-w-[240px] truncate px-2 py-1 text-[10px] text-slate-400 sm:table-cell"
                                title={device.hardware?.userAgent ?? undefined}
                            >
                                {describeHardware(device.hardware)}
                            </td>
                            <td className="whitespace-nowrap px-2 py-1 text-right text-sky-300">
                                {typeof device.averageReadyMs === 'number'
                                    ? `${device.averageReadyMs} ms`
                                    : '—'}
                            </td>
                            <td className="px-2 py-1 text-right">{device.runs ?? 0}</td>
                            <td className="hidden whitespace-nowrap px-2 py-1 text-slate-400 sm:table-cell">
                                {device.lastRun ? formatDate(device.lastRun) : '—'}
                            </td>
                            <td className="px-2 py-1 text-right">
                                <button
                                    type="button"
                                    onClick={() => onActive(device.id)}
                                    className={`rounded-md border px-2 py-0.5 text-[10px] ${device.id === activeId
                                        ? 'border-sky-400 text-sky-200'
                                        : 'border-white/10 text-slate-300 hover:bg-white/10'
                                        }`}
                                >
                                    {device.id === activeId ? 'activo' : 'usar'}
                                </button>
                            </td>
                            <td className="px-1 py-1 text-right">
                                <button
                                    type="button"
                                    onClick={() => onDelete(device)}
                                    title={`Borrar ${device.name} y sus ${device.runs ?? 0} ejecuciones`}
                                    aria-label={`Borrar ${device.name}`}
                                    className="rounded-md border border-rose-400/30 px-1.5 py-0.5 text-[10px] text-rose-300 hover:bg-rose-500/15"
                                >
                                    ✕
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="mt-2 text-[10px] text-slate-500">
                Ordenados de más rápido a más lento por el <em>promedio</em> de todos sus tests (media
                ponderada por número de muestras, en ms hasta predecir). La casilla marca qué equipos salen
                en la comparativa; «usar» decide a nombre de quién se guardan los tests. La ✕ borra el equipo
                <em> y todas sus ejecuciones</em> del servidor.
            </p>
        </div>
    );
}

/* -------------------------------------------------------------- comparativa */

interface SummaryScenario {
    scenario: string;
    runs: number;
    samples: number;
    captureMs: number;
    preprocessMs: number;
    inferenceMs: number;
    postprocessMs: number;
    poseMs: number;
    readyMs: number;
    paintMs: number;
    solvedRate: number;
}

interface CompareDevice {
    deviceId: string;
    name: string;
    category: Category;
    hardware: Hardware | null;
    runs: number;
    samples?: number;
    averageReadyMs?: number | null;
    averagePaintMs?: number | null;
    averageInferenceMs?: number | null;
    /** Media de la confianza de las detecciones, 0..1. */
    averageScore?: number | null;
    /** Error de reproyección medio de las poses resueltas, en píxeles. */
    averageRmsPx?: number | null;
    /** % de muestras en las que la pose llegó a la pantalla. */
    solvedRate?: number | null;
    runtimes: string[];
    scenarios: SummaryScenario[];
}

/** One cell of the device × model grid: what a machine measured on one `.onnx`. */
interface MatrixCell {
    modelId: string;
    runs: number;
    samples: number;
    averageReadyMs: number | null;
    averagePaintMs: number | null;
    averageInferenceMs: number | null;
    averageScore: number | null;
    averageRmsPx: number | null;
    solvedRate: number | null;
}

/** `/api/bench/matrix`: every cell that has samples, plus the per-model totals. */
interface MatrixPayload {
    models: Array<{
        modelId: string;
        name: string;
        legacy: boolean;
        runs: number;
        samples: number;
        averageReadyMs: number | null;
        averagePaintMs: number | null;
        averageInferenceMs: number | null;
        averageScore: number | null;
        averageRmsPx: number | null;
        solvedRate: number | null;
    }>;
    devices: Array<{
        deviceId: string;
        name: string;
        category: Category;
        points: MatrixCell[];
    }>;
}

function CompareTable({ devices }: { devices: CompareDevice[] }) {
    const rows = [...new Set(devices.flatMap((entry) => entry.scenarios.map((row) => row.scenario)))].sort();
    const bestOf = (scenario: string): number | null => {
        const values = devices
            .map((entry) => entry.scenarios.find((row) => row.scenario === scenario)?.readyMs)
            .filter((value): value is number => typeof value === 'number' && value > 0);
        return values.length >= 2 ? Math.min(...values) : null;
    };

    if (rows.length === 0) {
        return (
            <p className="text-[11px] text-slate-500">
                Marca al menos dos equipos con datos (casilla «Comp.») para compararlos.
            </p>
        );
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
                <thead className="text-slate-400">
                    <tr>
                        <th className="px-2 py-1 text-left">Test</th>
                        {devices.map((entry) => (
                            <th key={entry.deviceId} className="px-2 py-1 text-right">
                                {entry.name}
                                <span className="block text-[9px] font-normal text-slate-500">
                                    {CATEGORY_LABELS[entry.category] ?? entry.category} · {entry.runs} runs
                                </span>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((scenario) => {
                        const best = bestOf(scenario);
                        return (
                            <tr key={scenario} className="border-t border-white/5">
                                <td className="px-2 py-1">{scenario}</td>
                                {devices.map((entry) => {
                                    const row = entry.scenarios.find((candidate) => candidate.scenario === scenario);
                                    if (!row) {
                                        return (
                                            <td key={entry.deviceId} className="px-2 py-1 text-right text-slate-600">
                                                —
                                            </td>
                                        );
                                    }
                                    const isBest = best !== null && row.readyMs === best;
                                    return (
                                        <td
                                            key={entry.deviceId}
                                            className={`px-2 py-1 text-right ${isBest ? 'font-semibold text-emerald-300' : 'text-slate-200'}`}
                                            title={`predecir ${row.readyMs} ms · pintar ${row.paintMs} ms · yolo ${row.inferenceMs} ms · pnp ${row.poseMs} ms · pose ok ${row.solvedRate} % · ${row.samples} muestras`}
                                        >
                                            {row.readyMs} / {row.paintMs}
                                        </td>
                                    );
                                })}
                            </tr>
                        );
                    })}
                </tbody>
                {/* Averages: the number the device list is sorted by. */}
                <tfoot>
                    <tr className="border-t border-white/20 text-[11px] font-semibold">
                        <td className="px-2 py-1 text-slate-300">promedio</td>
                        {devices.map((entry) => (
                            <td
                                key={entry.deviceId}
                                className="px-2 py-1 text-right text-slate-300"
                                title={`media ponderada de ${entry.samples ?? 0} muestras`}
                            >
                                {typeof entry.averageReadyMs === 'number'
                                    ? `${entry.averageReadyMs} / ${entry.averagePaintMs}`
                                    : '—'}
                            </td>
                        ))}
                    </tr>
                </tfoot>
            </table>
            <p className="mt-2 text-[10px] text-slate-500">
                Valores en ms: <span className="text-sky-300">hasta predecir</span> /{' '}
                <span className="text-emerald-300">hasta pintar</span>. En verde, el mejor de la fila;
                mantén pulsado para ver yolo, pnp y el % de poses resueltas.
            </p>
        </div>
    );
}

/**
 * Scatter of the comparison: does the hardware explain the time?
 *
 * Each axis is a selector because the honest answer changes per machine: cores
 * correlate on a desktop, but a phone with 8 cores beats a laptop with 8 cores,
 * and then the interesting axis is the category (or the measured runtime, which
 * is why `yolo` is also offered). A device missing the chosen spec is left out
 * instead of being plotted at zero.
 */
function ComparisonPlot({
    devices,
    scopeQuery,
    ids,
}: {
    devices: CompareDevice[];
    scopeQuery: string;
    /** Casillas «Comp.» marcadas: la gráfica es de esos equipos, no de todos. */
    ids: string[];
}) {
    const [axisX, setAxisX] = useState<PlotAxisX>('cores');
    const [axisY, setAxisY] = useState<PlotAxisY>('ready');
    const [matrix, setMatrix] = useState<MatrixPayload | null>(null);
    /** Ámbito con el que se pidió la matriz: otro distinto = todavía sin cargar. */
    const [matrixScope, setMatrixScope] = useState<string | null>(null);

    /**
     * The model axis needs every (device, model) cell at once.
     *
     * Its own endpoint instead of the per-model comparison: here the models are
     * the X axis, so filtering by one of them would be exactly backwards. It is
     * refetched when the ámbito changes — a cached matrix from «Públicos» has no
     * business being drawn while «Privados» is selected.
     */
    useEffect(() => {
        if (axisX !== 'model') return;
        if (matrix && matrixScope === scopeQuery) return;
        let cancelled = false;
        fetch(`${API_BASE}/bench/matrix${scopeQuery ? `?${scopeQuery}` : ''}`)
            .then((response) => (response.ok ? response.json() : null))
            .then((payload: MatrixPayload | null) => {
                if (cancelled || !payload) return;
                setMatrix(payload);
                setMatrixScope(scopeQuery);
            })
            .catch(() => {
                // No matrix, no line plot: the other axes still work.
            });
        return () => {
            cancelled = true;
        };
    }, [axisX, matrix, matrixScope, scopeQuery]);

    /** Only the matrix of the current ámbito counts; the old one is not shown. */
    const gridSource = matrixScope === scopeQuery ? matrix : null;

    /** Equipos que la gráfica puede dibujar: los marcados, o todos si no hay marcas. */
    const visibleDevices = useMemo(() => {
        const all = gridSource?.devices ?? [];
        if (ids.length === 0) return all;
        const ticked = new Set(ids);
        return all.filter((device) => ticked.has(device.deviceId));
    }, [gridSource, ids]);

    const pointOf = (device: CompareDevice): PlotPoint | null => {
        if (axisX === 'model') return null;
        const y = Y_VALUE[axisY].value(device);
        if (y === null) return null;
        const x = X_VALUE[axisX].value(device);
        if (x === null) return null;
        return { id: device.deviceId, label: device.name, x, y, group: device.category };
    };

    const points = devices.map(pointOf).filter((point): point is PlotPoint => point !== null);
    const missing = devices.length - points.length;

    /**
     * Every point sits exactly on its category.
     *
     * Two machines of the same kind must be on the same vertical line — that is
     * what a category axis means. (They are told apart by their time and their
     * label, which is the whole point of the plot.)
     */
    const plotted = points;

    /**
     * Cells of the device × model grid, one line per machine.
     *
     * Models are ordered slowest-first on X, so the axis reads left → right as
     * "less work" and a line that goes down is a device that got faster. Each
     * machine gets its own colour here: the category palette would paint two
     * laptops the same and the lines would be impossible to follow.
     */
    const orderedModels = useMemo(() => {
        if (!gridSource) return [];
        return [...gridSource.models].sort(
            (left, right) => (metricOfAxis(right, axisY) ?? 0) - (metricOfAxis(left, axisY) ?? 0)
        );
    }, [gridSource, axisY]);

    const grid = useMemo(() => {
        const nextPoints: PlotPoint[] = [];
        const nextLines: PlotLine[] = [];
        const legend: Array<{ id: string; name: string; color: string }> = [];
        if (!gridSource) return { points: nextPoints, lines: nextLines, legend };
        visibleDevices.forEach((device, index) => {
            const color = DEVICE_COLORS[index % DEVICE_COLORS.length];
            const series: Array<{ x: number; y: number }> = [];
            for (const cell of device.points) {
                const column = orderedModels.findIndex((model) => model.modelId === cell.modelId);
                const y = metricOfAxis(cell, axisY);
                if (column < 0 || y === null) continue;
                series.push({ x: column, y });
                nextPoints.push({
                    id: `${device.deviceId}-${cell.modelId}`,
                    label: '',
                    x: column,
                    y,
                    color,
                    title: `${device.name} · ${shortModelName(orderedModels[column].name)}: ${Math.round(y)} ms`,
                });
            }
            if (series.length === 0) return;
            legend.push({ id: device.deviceId, name: device.name, color });
            if (series.length > 1) nextLines.push({ id: device.deviceId, color, points: series });
        });
        return { points: nextPoints, lines: nextLines, legend };
    }, [gridSource, visibleDevices, orderedModels, axisY]);

    /** Why an axis has nothing to plot, when that is knowable. */
    const emptyReason =
        axisX === 'memory' && points.length === 0
            ? `RAM: solo Chrome y Edge exponen navigator.deviceMemory; Firefox y Safari no la dan. Puedes escribirla a mano al añadir el equipo.`
            : null;

    /**
     * Everything behind the plot, as CSV.
     *
     * A paper needs the numbers, not a screenshot: one row per plotted point,
     * with all six metrics (not only the one on the Y axis) and the identity of
     * what it belongs to. Missing values are left empty, never as 0 — an average
     * that does not exist and a measured zero are different claims.
     */
    const exportCsv = () => {
        const cell = (value: number | null | undefined) =>
            typeof value === 'number' ? String(value) : '';
        const rows: string[][] = [];
        if (modelAxis) {
            rows.push([
                'equipo', 'categoria', 'modelo', 'fichero', 'familia', 'pixeles', 'cuantizacion',
                'runs', 'muestras', 'hasta_predecir_ms', 'hasta_pintar_ms', 'yolo_ms',
                'confianza_0_1', 'error_reproyeccion_px', 'poses_resueltas_pct',
            ]);
            for (const device of visibleDevices) {
                for (const point of device.points) {
                    const model = orderedModels.find((entry) => entry.modelId === point.modelId);
                    if (!model) continue;
                    const spec = parseModelFile(model.name);
                    rows.push([
                        device.name,
                        CATEGORY_LABELS[device.category] ?? device.category,
                        shortModelName(model.name),
                        model.name,
                        spec?.family ?? '',
                        spec ? String(spec.size) : '',
                        spec?.quant ?? '',
                        String(point.runs),
                        String(point.samples),
                        cell(point.averageReadyMs),
                        cell(point.averagePaintMs),
                        cell(point.averageInferenceMs),
                        cell(point.averageScore),
                        cell(point.averageRmsPx),
                        cell(point.solvedRate),
                    ]);
                }
            }
        } else {
            rows.push([
                'equipo', 'categoria', 'nucleos', 'ram_gb', 'pantalla', 'gpu',
                'runs', 'muestras', 'hasta_predecir_ms', 'hasta_pintar_ms', 'yolo_ms',
                'confianza_0_1', 'error_reproyeccion_px', 'poses_resueltas_pct',
            ]);
            for (const device of devices) {
                rows.push([
                    device.name,
                    CATEGORY_LABELS[device.category] ?? device.category,
                    cell(device.hardware?.cores),
                    cell(device.hardware?.memoryGb),
                    device.hardware?.screen ?? '',
                    device.hardware?.gpu ?? '',
                    String(device.runs),
                    cell(device.samples),
                    cell(device.averageReadyMs),
                    cell(device.averagePaintMs),
                    cell(device.averageInferenceMs),
                    cell(device.averageScore),
                    cell(device.averageRmsPx),
                    cell(device.solvedRate),
                ]);
            }
        }

        const csv = rows
            .map((row) =>
                row.map((value) => (/[",;\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(',')
            )
            .join('\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `bench-${modelAxis ? 'modelos' : axisX}-${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const xSpec = axisX === 'model' ? null : X_VALUE[axisX];
    const modelAxis = axisX === 'model';
    const gridEmpty = modelAxis && gridSource !== null && grid.points.length === 0;

    return (
        <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                <label>
                    eje X
                    <select
                        value={axisX}
                        onChange={(event) => setAxisX(event.target.value as PlotAxisX)}
                        className="ml-1 rounded-md border border-white/10 bg-slate-900 px-1.5 py-1 text-slate-200"
                    >
                        {(Object.keys(AXIS_X_LABELS) as PlotAxisX[]).map((key) => (
                            <option key={key} value={key}>
                                {AXIS_X_LABELS[key]}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    eje Y
                    <select
                        value={axisY}
                        onChange={(event) => setAxisY(event.target.value as PlotAxisY)}
                        className="ml-1 rounded-md border border-white/10 bg-slate-900 px-1.5 py-1 text-slate-200"
                    >
                        {(Object.keys(Y_VALUE) as PlotAxisY[]).map((key) => (
                            <option key={key} value={key}>
                                {Y_VALUE[key].label}
                            </option>
                        ))}
                    </select>
                </label>
                <span className="text-slate-500">
                    {modelAxis
                        ? `${grid.points.length} celdas · ${grid.legend.length} equipos · ${orderedModels.length} modelos`
                        : `${points.length} equipos${missing > 0 ? ` · ${missing} sin ese dato` : ''}`}
                </span>
                <button
                    type="button"
                    onClick={exportCsv}
                    title="Descargar en CSV todas las métricas de los puntos que salen en la gráfica"
                    className="ml-auto rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/10"
                >
                    Exportar datos
                </button>
            </div>
            <ScatterPlot
                points={modelAxis ? grid.points : plotted}
                xLabel={
                    modelAxis
                        ? `modelo · ordenado por ${Y_VALUE[axisY].label}`
                        : (xSpec?.label ?? '')
                }
                yLabel={Y_VALUE[axisY].label}
                formatX={
                    modelAxis
                        ? (value) => shortModelName(orderedModels[Math.round(value)]?.name ?? '')
                        : (xSpec?.format ?? ((value: number) => `${value}`))
                }
                formatY={(value) => `${Math.round(value)}`}
                xTicks={modelAxis ? orderedModels.map((_, index) => index) : xSpec?.ticks}
                xTickLines={
                    modelAxis
                        ? (value) => {
                            const model = orderedModels[Math.round(value)];
                            const spec = model ? parseModelFile(model.name) : null;
                            // `640n` + `int8`: dos líneas en vez de
                            // `yolo-pose-n-640-int8` pisando al vecino.
                            return spec ? [`${spec.size}${spec.family}`, spec.quant] : [model?.name ?? ''];
                        }
                        : undefined
                }
                colors={CATEGORY_COLORS}
                lines={modelAxis ? grid.lines : undefined}
                showPointLabels={!modelAxis}
                emptyHint={
                    modelAxis
                        ? 'Cada equipo necesita tests en al menos dos modelos para que la línea signifique algo.'
                        : 'Marca varios equipos con datos y especificaciones para ver la relación.'
                }
                emptyReason={gridEmpty ? 'Todavía no hay ninguna ejecución agrupada por modelo.' : emptyReason}
            />
            {modelAxis ? (
                <p className="text-[10px] text-slate-500">
                    Una línea por equipo, puntos en cada modelo que haya ejecutado. Eje Y:{' '}
                    {Y_VALUE[axisY].label}
                    {axisY === 'rms' ? ' (solo poses resueltas)' : ''}. El eje X va de mayor a menor
                    según esa media.
                    <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
                        {grid.legend.map((entry) => (
                            <span key={entry.id} className="inline-flex items-center gap-1">
                                <span className="inline-block h-2 w-2 rounded-full" style={{ background: entry.color }} />
                                {entry.name}
                            </span>
                        ))}
                    </span>
                </p>
            ) : (
                <p className="text-[10px] text-slate-500">
                    {Y_VALUE[axisY].label}
                    {axisY === 'rms' ? ' (solo poses resueltas)' : ''} — media de todos los tests del
                    equipo. Color por categoría:{' '}
                    {Object.entries(CATEGORY_COLORS).map(([key, color]) => (
                        <span key={key} className="mr-2 inline-flex items-center gap-1">
                            <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
                            {CATEGORY_LABELS[key as Category] ?? key}
                        </span>
                    ))}
                </p>
            )}
        </div>
    );
}

type PlotAxisX = 'cores' | 'memory' | 'screen' | 'category' | 'model';
type PlotAxisY = 'ready' | 'paint' | 'yolo' | 'score' | 'rms' | 'solved';

/** Category as a number, only so it can be placed on an axis. */
const CATEGORY_ORDER: Record<Category, number> = { movil: 1, portatil: 2, sobremesa: 3 };
const CATEGORY_LABEL_BY_ORDER: Record<number, string> = { 1: 'móvil', 2: 'portátil', 3: 'sobremesa' };
const CATEGORY_COLORS: Record<string, string> = {
    movil: '#f472b6',
    portatil: '#38bdf8',
    sobremesa: '#34d399',
};
/**
 * One colour per machine, for the model axis.
 *
 * Deliberately not the category palette: with two laptops on screen the two lines
 * would be the same colour and the whole point of the plot — following one machine
 * across models — would be lost.
 */
const DEVICE_COLORS = [
    '#38bdf8',
    '#34d399',
    '#f472b6',
    '#fbbf24',
    '#a78bfa',
    '#fb7185',
    '#4ade80',
    '#60a5fa',
    '#f97316',
    '#22d3ee',
    '#c084fc',
    '#facc15',
];

/** The chosen Y metric out of any entry that carries the averages. */
function metricOfAxis(entry: QualityEntry, axis: PlotAxisY): number | null {
    return Y_VALUE[axis].value(entry);
}

/** `yolo-pose-s-480-int8.onnx` → `480 int8`, short enough for a tick. */
function shortModelName(name: string): string {
    return name
        .replace(/\.onnx$/i, '')
        .replace(/^yolo-pose-[a-z]?-?/i, '')
        .replace(/-/g, ' ')
        .trim();
}

const AXIS_X_LABELS: Record<PlotAxisX, string> = {
    cores: 'núcleos lógicos',
    memory: 'RAM (GB)',
    screen: 'ancho de pantalla',
    category: 'categoría',
    model: 'modelo (una línea por equipo)',
};

const X_VALUE: Record<
    Exclude<PlotAxisX, 'model'>,
    {
        label: string;
        value: (device: CompareDevice) => number | null;
        format: (value: number) => string;
        /** Set for categorical axes: one tick per category, no interpolation. */
        ticks?: number[];
    }
> = {
    cores: {
        label: 'núcleos lógicos',
        value: (device) => device.hardware?.cores ?? null,
        format: (value) => `${Math.round(value)}`,
    },
    memory: {
        label: 'RAM (GB)',
        value: (device) => device.hardware?.memoryGb ?? null,
        format: (value) => `${Math.round(value)}`,
    },
    screen: {
        label: 'ancho de pantalla',
        value: (device) => Number(device.hardware?.screen?.split('x')[0] ?? 0) || null,
        format: (value) => `${Math.round(value)}`,
    },
    category: {
        label: 'categoría',
        value: (device) => CATEGORY_ORDER[device.category] ?? null,
        ticks: [1, 2, 3],
        // The tick values are exact category orders, so the label is a lookup and
        // never a rounded guess (that is what produced "móvil, móvil, portátil…").
        format: (value) => CATEGORY_LABEL_BY_ORDER[Math.round(value)] ?? '',
    },
};

/**
 * Every Y axis the plot offers.
 *
 * The first three are speed (depend on the machine); the last three are quality
 * (confianza, error de reproyección y poses resueltas). Mixing both in one plot
 * is the point: a slow phone that still solves 95 % of the poses is fine, and a
 * fast one that solves 40 % is not.
 */
const Y_VALUE: Record<PlotAxisY, { label: string; value: (device: QualityEntry) => number | null }> = {
    ready: {
        label: 'hasta predecir (ms)',
        value: (device) => device.averageReadyMs ?? null,
    },
    paint: {
        label: 'hasta pintar (ms)',
        value: (device) => device.averagePaintMs ?? null,
    },
    yolo: {
        label: 'yolo (ms)',
        value: (device) => device.averageInferenceMs ?? null,
    },
    score: {
        label: 'confianza media (%)',
        value: (device) => (typeof device.averageScore === 'number' ? device.averageScore * 100 : null),
    },
    rms: {
        label: 'error de reproyección (px)',
        value: (device) => device.averageRmsPx ?? null,
    },
    solved: {
        label: 'poses resueltas (%)',
        value: (device) => device.solvedRate ?? null,
    },
};

/** What every Y axis needs: the three timings and the three quality numbers. */
interface QualityEntry {
    averageReadyMs?: number | null;
    averagePaintMs?: number | null;
    averageInferenceMs?: number | null;
    averageScore?: number | null;
    averageRmsPx?: number | null;
    solvedRate?: number | null;
}

/* ------------------------------------------------------------------- tablas */

function SessionTable({ results }: { results: ScenarioResult[] }) {
    if (results.length === 0) {
        return <p className="text-[11px] text-slate-500">Nada todavía: ejecuta un test.</p>;
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
                <thead className="text-slate-400">
                    <tr>
                        <th className="px-2 py-1 text-left">Test</th>
                        <th className="hidden px-2 py-1 text-right sm:table-cell">captura</th>
                        <th className="hidden px-2 py-1 text-right sm:table-cell">pre</th>
                        <th className="px-2 py-1 text-right">yolo</th>
                        <th className="hidden px-2 py-1 text-right sm:table-cell">post</th>
                        <th className="px-2 py-1 text-right">pnp</th>
                        <th className="px-2 py-1 text-right">hasta predecir</th>
                        <th className="px-2 py-1 text-right">hasta pintar</th>
                        <th className="px-2 py-1 text-right">obj</th>
                    </tr>
                </thead>
                <tbody>
                    {results.map((result) => (
                        <tr key={result.scenario} className="border-t border-white/5">
                            <td className="px-2 py-1">{result.scenario}</td>
                            <td className="hidden px-2 py-1 text-right sm:table-cell">{result.mean.captureMs}</td>
                            <td className="hidden px-2 py-1 text-right sm:table-cell">{result.mean.preprocessMs}</td>
                            <td className="px-2 py-1 text-right">{result.mean.inferenceMs}</td>
                            <td className="hidden px-2 py-1 text-right sm:table-cell">{result.mean.postprocessMs}</td>
                            <td className="px-2 py-1 text-right">{result.mean.poseMs}</td>
                            <td className="px-2 py-1 text-right text-sky-300">{result.mean.readyMs}</td>
                            <td className="px-2 py-1 text-right text-emerald-300">{result.mean.paintMs}</td>
                            <td className="px-2 py-1 text-right">{result.mean.detected}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="mt-2 text-[10px] text-slate-500">
                Medias en ms sobre {SAMPLES} muestras (2 de calentamiento descartadas). «captura» es el{' '}
                <code>drawImage</code> del frame: el navegador lo difiere a la GPU, así que sale ~0 en
                escritorio — el número que manda es «hasta predecir».
            </p>
        </div>
    );
}

interface SummaryPayload {
    deviceId: string;
    runs: number;
    devices: Array<{ deviceId: string; name: string; runs: number }>;
    scenarios: SummaryScenario[];
}

function SummaryTable({ summary }: { summary: SummaryPayload | null }) {
    if (!summary || summary.scenarios.length === 0) {
        return (
            <p className="text-[11px] text-slate-500">
                Todavía no hay ejecuciones guardadas para este equipo.
            </p>
        );
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
                <thead className="text-slate-400">
                    <tr>
                        <th className="px-2 py-1 text-left">Test</th>
                        <th className="hidden px-2 py-1 text-right sm:table-cell">runs</th>
                        <th className="hidden px-2 py-1 text-right sm:table-cell">muestras</th>
                        <th className="hidden px-2 py-1 text-right sm:table-cell">pre</th>
                        <th className="px-2 py-1 text-right">yolo</th>
                        <th className="px-2 py-1 text-right">pnp</th>
                        <th className="px-2 py-1 text-right">hasta predecir</th>
                        <th className="px-2 py-1 text-right">hasta pintar</th>
                        <th className="px-2 py-1 text-right">pose ok</th>
                    </tr>
                </thead>
                <tbody>
                    {summary.scenarios.map((row) => (
                        <tr key={row.scenario} className="border-t border-white/5">
                            <td className="px-2 py-1">{row.scenario}</td>
                            <td className="hidden px-2 py-1 text-right sm:table-cell">{row.runs}</td>
                            <td className="hidden px-2 py-1 text-right sm:table-cell">{row.samples}</td>
                            <td className="hidden px-2 py-1 text-right sm:table-cell">{row.preprocessMs}</td>
                            <td className="px-2 py-1 text-right">{row.inferenceMs}</td>
                            <td className="px-2 py-1 text-right">{row.poseMs}</td>
                            <td className="px-2 py-1 text-right text-sky-300">{row.readyMs}</td>
                            <td className="px-2 py-1 text-right text-emerald-300">{row.paintMs}</td>
                            <td className="px-2 py-1 text-right">{row.solvedRate} %</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="mt-2 text-[10px] text-slate-500">
                {summary.runs} ejecuciones guardadas. Media ponderada por número de muestras.
            </p>
        </div>
    );
}

/** One stored run, as the server keeps it. */
interface RunRecord {
    id: string;
    receivedAt: string;
    deviceId?: string;
    device?: string;
    deviceName?: string;
    category?: string | null;
    scenario: string;
    runtime?: { provider?: string; note?: string | null } | null;
    samples?: Array<{ readyMs: number; paintMs: number; inferenceMs: number; poseMs: number }>;
}

function runMean(run: RunRecord, key: 'readyMs' | 'paintMs' | 'inferenceMs' | 'poseMs'): number {
    const samples = run.samples ?? [];
    if (samples.length === 0) return 0;
    return round(samples.reduce((sum, sample) => sum + (Number(sample[key]) || 0), 0) / samples.length);
}

function formatDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function RunsTable({ runs }: { runs: RunRecord[] }) {
    if (runs.length === 0) {
        return (
            <p className="text-[11px] text-slate-500">
                Nada guardado todavía: ejecuta un test y aparecerá aquí con su fecha.
            </p>
        );
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
                <thead className="text-slate-400">
                    <tr>
                        <th className="px-2 py-1 text-left">Fecha</th>
                        <th className="px-2 py-1 text-left">Test</th>
                        <th className="hidden px-2 py-1 text-right sm:table-cell">yolo</th>
                        <th className="hidden px-2 py-1 text-right sm:table-cell">pnp</th>
                        <th className="px-2 py-1 text-right">hasta predecir</th>
                        <th className="px-2 py-1 text-right">hasta pintar</th>
                        <th className="hidden px-2 py-1 text-left sm:table-cell">runtime</th>
                    </tr>
                </thead>
                <tbody>
                    {runs.map((run) => (
                        <tr key={run.id} className="border-t border-white/5">
                            <td className="whitespace-nowrap px-2 py-1 text-slate-300">
                                {formatDate(run.receivedAt)}
                            </td>
                            <td className="px-2 py-1">{run.scenario}</td>
                            <td className="hidden px-2 py-1 text-right sm:table-cell">{runMean(run, 'inferenceMs')}</td>
                            <td className="hidden px-2 py-1 text-right sm:table-cell">{runMean(run, 'poseMs')}</td>
                            <td className="px-2 py-1 text-right text-sky-300">{runMean(run, 'readyMs')}</td>
                            <td className="px-2 py-1 text-right text-emerald-300">{runMean(run, 'paintMs')}</td>
                            <td className="truncate px-2 py-1 text-[10px] text-slate-500">
                                {(run.runtime?.note ?? run.runtime?.provider ?? '—').replace('runtime local · ', '')}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="mt-2 text-[10px] text-slate-500">
                Las {runs.length} últimas ejecuciones de este equipo, guardadas en el servidor.
            </p>
        </div>
    );
}
